// Sync engine: two devices against an in-memory /api/workspace with the auth Worker's CAS semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSync, applyOps, legacyOps, CACHE_PREFIX } from '../sync.js';

const K = (n) => `nhl:${n}|sports_winner|nhl:${n}|team:17`;
const TAGS = { a: 'aaaaaaaaaaaaaaaa', b: 'bbbbbbbbbbbbbbbb' };

// server: accounts keyed by the cookie the "browser" carries
function server() {
  const rows = new Map();
  const S = { rows, down: false, calls: [], account: 'a', hold: null };
  S.fetch = async (url, init = {}) => {
    S.calls.push(init.method || 'GET');
    if (S.hold) await S.hold;
    if (S.down) throw new TypeError('Failed to fetch');
    const acct = S.account;
    if (acct === 'guest') return new Response('{"error":"anonymous"}', { status: 401 });
    if (acct === 'lapsed') return new Response('{"error":"upgrade_required"}', { status: 403 });
    const cur = rows.get(acct) || { revision: 0, watch: [], pins: [], updated_at: null };
    const ok = (row) => new Response(JSON.stringify({ contract: 'terminal-workspace/1', account_tag: TAGS[acct], ...row }), { status: 200 });
    if ((init.method || 'GET') === 'GET') return ok(cur);
    const b = JSON.parse(init.body);
    if (b.base_revision !== cur.revision) return new Response(JSON.stringify({ error: 'revision_conflict', account_tag: TAGS[acct], current: cur }), { status: 409 });
    const next = { revision: cur.revision + 1, watch: b.watch, pins: b.pins, updated_at: new Date().toISOString() };
    rows.set(acct, next); return ok(next);
  };
  return S;
}
function mem() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, m }; }
// timers: run manually
function clock() { const q = []; return { set: (fn) => { const t = { fn }; q.push(t); return t; }, clear: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); }, async run() { while (q.length) { const t = q.shift(); await t.fn(); } }, q }; }
function device(srv, storage = mem()) {
  const c = clock();
  const sync = createSync({ fetchImpl: (u, i) => srv.fetch(u, i), storage, setTimer: c.set, clearTimer: c.clear });
  return { sync, storage, c };
}

test('applyOps: deterministic adds/removes; pins keep the newest four; watch capped at 200', () => {
  assert.deepEqual(applyOps({ watch: [K(1)], pins: [] }, [{ t: 'w+', k: K(2) }, { t: 'w+', k: K(1) }, { t: 'w-', k: K(1) }]).watch, [K(2)]);
  const p = applyOps({ watch: [], pins: [K(1), K(2), K(3), K(4)] }, [{ t: 'p+', k: K(5) }, { t: 'p+', k: K(3) }]).pins;
  assert.deepEqual(p, [K(2), K(3), K(4), K(5)]);
  const many = applyOps({ watch: Array.from({ length: 200 }, (_, i) => K(i)), pins: [] }, [{ t: 'w+', k: K(999) }]).watch;
  assert.equal(many.length, 200); assert.ok(!many.includes(K(999)));
});

test('new account: empty server row loads as revision 0; a tap is saved and acknowledged', async () => {
  const srv = server(); const d = device(srv);
  let st = await d.sync.load();
  assert.equal(st.phase, 'synced'); assert.equal(st.revision, 0); assert.deepEqual(st.watch, []);
  d.sync.watch(K(1), true); d.sync.pin(K(1), true);
  assert.equal(d.sync.state().phase, 'saving'); assert.deepEqual(d.sync.state().watch, [K(1)], 'optimistic view');
  await d.c.run();
  st = d.sync.state();
  assert.equal(st.phase, 'synced'); assert.equal(st.revision, 1); assert.equal(st.pending, 0);
  assert.deepEqual(srv.rows.get('a'), { ...srv.rows.get('a'), watch: [K(1)], pins: [K(1)] });
  assert.equal(srv.calls.filter((m) => m === 'PUT').length, 1, 'two taps coalesced into one write');
});

test('desktop -> phone -> desktop: adds sync, a removal on the phone disappears on the desktop after refresh', async () => {
  const srv = server(); const desk = device(srv), phone = device(srv);
  await desk.sync.load();
  desk.sync.watch(K(1), true); desk.sync.watch(K(2), true); desk.sync.pin(K(2), true); await desk.c.run();
  let st = await phone.sync.load();
  assert.deepEqual(st.watch, [K(1), K(2)]); assert.deepEqual(st.pins, [K(2)]);
  phone.sync.watch(K(1), false); phone.sync.pin(K(2), false); await phone.c.run();
  st = await desk.sync.load();
  assert.deepEqual(st.watch, [K(2)]); assert.deepEqual(st.pins, []);
});

test('concurrent edits from two devices are merged, never overwritten (409 replay)', async () => {
  const srv = server(); const desk = device(srv), phone = device(srv);
  await desk.sync.load(); desk.sync.watch(K(1), true); await desk.c.run();
  await phone.sync.load();                                   // both at revision 1
  desk.sync.watch(K(2), true);                               // desk adds 2
  phone.sync.watch(K(3), true); phone.sync.watch(K(1), false); // phone adds 3, removes 1
  await desk.c.run();                                        // rev 2: [1,2]
  await phone.c.run();                                       // 409 -> replay on [1,2] -> [2,3] rev 3
  assert.deepEqual(srv.rows.get('a').watch, [K(2), K(3)]);
  assert.equal(srv.rows.get('a').revision, 3);
  assert.deepEqual(phone.sync.state().watch, [K(2), K(3)]);
  assert.deepEqual((await desk.sync.load()).watch, [K(2), K(3)]);
});

test('a tap made while a save is in flight is sent next (serialized), never lost', async () => {
  const srv = server(); const d = device(srv);
  await d.sync.load(); d.sync.watch(K(1), true);
  let release; srv.hold = new Promise((r) => { release = r; });
  const flushing = d.c.run();
  await new Promise((r) => setTimeout(r, 5));
  d.sync.watch(K(2), true);                                  // during the in-flight PUT
  srv.hold = null; release(); await flushing; await d.c.run();
  assert.deepEqual(srv.rows.get('a').watch, [K(1), K(2)]); assert.equal(d.sync.state().pending, 0);
});

test('offline: taps stay on this device (sync pending), survive a reload, and land when the network returns', async () => {
  const srv = server(); const storage = mem(); let d = device(srv, storage);
  await d.sync.load();
  srv.down = true;
  d.sync.watch(K(5), true); await d.c.q.shift().fn();       // debounced flush fails
  let st = d.sync.state();
  assert.equal(st.phase, 'pending'); assert.equal(st.pending, 1); assert.deepEqual(st.watch, [K(5)]);
  d = device(srv, storage);                                  // reload while still offline
  st = await d.sync.load();
  assert.equal(st.phase, 'unavailable'); assert.equal(st.ready, false);
  srv.down = false;
  st = await d.sync.load();                                  // back online: cached unsynced tap for this account is applied
  await d.c.run();
  assert.deepEqual(srv.rows.get('a').watch, [K(5)]); assert.equal(d.sync.state().pending, 0); assert.equal(d.sync.state().phase, 'synced');
});

test('one-time migration of pre-sync device saves: union with the server, then never resurrected', async () => {
  const srv = server(); srv.rows.set('a', { revision: 3, watch: [K(9)], pins: [], updated_at: 'T' });
  const storage = mem();
  storage.setItem('pbe_terminal_watch_v2', JSON.stringify([K(1), K(2), 'junk']));
  storage.setItem('pbe_terminal_watchlist_v1', JSON.stringify(['nhl:7:sports_winner|nhl:7|team:17']));
  storage.setItem('pbe_terminal_pins_v1', JSON.stringify([K(2)]));
  const d = device(srv, storage);
  const st0 = await d.sync.load(); await d.c.run();
  assert.equal(st0.migrated, 3);
  assert.deepEqual(srv.rows.get('a').watch, [K(9), K(1), K(2), K(7)]); assert.deepEqual(srv.rows.get('a').pins, [K(2)]);
  for (const k of ['pbe_terminal_watch_v2', 'pbe_terminal_watchlist_v1', 'pbe_terminal_pins_v1']) assert.equal(storage.getItem(k), null, `${k} cleared after the acknowledged write`);
  // removed on another device later: a reload here must not bring it back
  srv.rows.set('a', { ...srv.rows.get('a'), revision: 5, watch: [K(9)] });
  const again = device(srv, storage); const st = await again.sync.load(); await again.c.run();
  assert.deepEqual(st.watch, [K(9)]); assert.equal(srv.rows.get('a').revision, 5, 'no write on a clean reload');
});

test('legacy saves are not migrated until the account row is read (an outage never assigns them)', async () => {
  const srv = server(); srv.down = true; const storage = mem();
  storage.setItem('pbe_terminal_watch_v2', JSON.stringify([K(1)]));
  const d = device(srv, storage); await d.sync.load();
  assert.notEqual(storage.getItem('pbe_terminal_watch_v2'), null);
  assert.equal(srv.rows.size, 0);
});

test('same device, member A signs out, member B signs in: B never sees or writes A', async () => {
  const srv = server(); const storage = mem();
  const a = device(srv, storage); await a.sync.load(); a.sync.watch(K(1), true); a.sync.pin(K(1), true); await a.c.run();
  srv.account = 'guest';
  let st = await a.sync.load(); assert.equal(st.phase, 'signedout'); assert.deepEqual(st.watch, []);
  srv.account = 'b';
  const b = device(srv, storage); st = await b.sync.load(); await b.c.run();
  assert.deepEqual(st.watch, []); assert.deepEqual(st.pins, []);
  assert.equal(srv.rows.has('b'), false, 'B wrote nothing (no carried ops)');
  assert.equal(storage.getItem(CACHE_PREFIX + TAGS.a), null, "A's synced cache was removed from the device");
  b.sync.watch(K(2), true); await b.c.run();
  assert.deepEqual(srv.rows.get('a').watch, [K(1)]); assert.deepEqual(srv.rows.get('b').watch, [K(2)]);
  // an in-session account switch (same sync instance) drops the other account's ops
  srv.account = 'a'; st = await b.sync.load();
  assert.deepEqual(st.watch, [K(1)]);
});

test('lapsed membership: signed out, taps refused, nothing written', async () => {
  const srv = server(); srv.account = 'lapsed'; const d = device(srv);
  assert.equal((await d.sync.load()).phase, 'signedout');
  assert.equal(d.sync.watch(K(1), true), false); await d.c.run();
  assert.equal(srv.calls.filter((m) => m === 'PUT').length, 0);
});

test('invalid ids are refused locally; a closed event id stays saved (no data-driven deletion)', async () => {
  const srv = server(); const d = device(srv); await d.sync.load();
  assert.equal(d.sync.watch('<script>', true), false);
  d.sync.watch(K(1), true); await d.c.run();
  const st = await d.sync.load();                            // the market closing upstream does not touch saved ids
  assert.deepEqual(st.watch, [K(1)]);
});

test('refreshIfStale reads only when idle and stale (no minute-by-minute polling)', async () => {
  const srv = server(); let t = 0;
  const d = createSync({ fetchImpl: srv.fetch, storage: mem(), now: () => t, setTimer: () => 0, clearTimer: () => {} });
  await d.load(); const n = srv.calls.length;
  t = 10e3; assert.equal(d.refreshIfStale(30e3), null); assert.equal(srv.calls.length, n);
  t = 40e3; await d.refreshIfStale(30e3); assert.equal(srv.calls.length, n + 1);
});

test('legacyOps ignores junk and maps V1 keys', () => {
  const s = mem();
  s.setItem('pbe_terminal_watchlist_v1', '{"not":"array"}'); s.setItem('pbe_terminal_watch_v2', 'garbage');
  assert.deepEqual(legacyOps(s), []);
});
