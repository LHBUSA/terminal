// Terminal workspace sync (LHBUSA/terminal#3): watchlist + pins persisted per All Access account through
// /api/workspace (auth Worker -> identity Supabase, revision compare-and-swap). Pure module: fetch, storage, timers and
// clock are injected (browser + node tests).
//
// Model: the server row is the authority (`base`). Every tap is an intentional operation (watch/unwatch/pin/unpin)
// kept in `ops` until a write that included it is acknowledged. The view is always apply(base, ops). On 409 the newer
// server row becomes `base` and the same operations are replayed onto it, so two devices never erase each other's
// adds or removes. Nothing but contract-key ids is stored locally, namespaced by an opaque per-account tag.
export const MAX_WATCH = 200, MAX_PINS = 4;
export const CACHE_PREFIX = 'pbe_terminal_ws_v1:';
export const LEGACY_KEYS = ['pbe_terminal_watch_v2', 'pbe_terminal_watchlist_v1', 'pbe_terminal_pins_v1'];
export const ID_RE = /^(?:nfl|nba|nhl|mlb|wnba|tennis|ufc|soccer|golf|f1|nonsports):[A-Za-z0-9 _.:+&()\/-]{1,120}\|[A-Za-z0-9 _.:|+&()\/-]{1,180}$/;
const DEBOUNCE_MS = 400, MAX_CONFLICTS = 4;
const BACKOFF = [5e3, 15e3, 30e3, 60e3, 120e3, 300e3];

export const validId = (k) => typeof k === 'string' && k.length <= 300 && ID_RE.test(k);

// Deterministic replay. Pins: newest last; a fifth pin drops the oldest. Watch: capped at MAX_WATCH (extra adds ignored).
export function applyOps(base, ops) {
  const watch = [...(base?.watch || [])], pins = [...(base?.pins || [])];
  for (const o of ops) {
    if (o.t === 'w+') { if (!watch.includes(o.k) && watch.length < MAX_WATCH) watch.push(o.k); }
    else if (o.t === 'w-') { const i = watch.indexOf(o.k); if (i >= 0) watch.splice(i, 1); }
    else if (o.t === 'p+') { if (!pins.includes(o.k)) { pins.push(o.k); while (pins.length > MAX_PINS) pins.shift(); } }
    else if (o.t === 'p-') { const i = pins.indexOf(o.k); if (i >= 0) pins.splice(i, 1); }
  }
  return { watch, pins };
}

// V1/V2 device-only saves -> operations (V1 keys were `${sport}:${event}:${contract}`).
export function legacyOps(storage) {
  const read = (k) => { try { const v = JSON.parse(storage.getItem(k) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };
  const v1 = read('pbe_terminal_watchlist_v1').map((id) => { const m = String(id).match(/^([a-z0-9]*):([^:]+):(.+)$/); return m ? `${m[1] || 'nonsports'}:${m[2]}|${m[3]}` : null; });
  const watch = [...new Set([...read('pbe_terminal_watch_v2'), ...v1])].filter(validId).slice(0, MAX_WATCH);
  const pins = [...new Set(read('pbe_terminal_pins_v1'))].filter(validId).slice(-MAX_PINS);
  return [...watch.map((k) => ({ t: 'w+', k })), ...pins.map((k) => ({ t: 'p+', k }))];
}

export function createSync({ fetchImpl, storage, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now(), onChange = () => {} }) {
  const S = { phase: 'loading', tag: null, base: null, ops: [], inflight: false, again: false, conflicts: 0, fails: 0, timer: null, retry: null,
    lastSyncAt: 0, error: null, legacy: null, migrated: 0, seq: 0 };
  const store = {
    get(k) { try { return storage.getItem(k); } catch { return null; } },
    set(k, v) { try { storage.setItem(k, v); } catch {} },
    del(k) { try { storage.removeItem(k); } catch {} },
    keys() { try { return Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(Boolean); } catch { return []; } }
  };
  const view = () => applyOps(S.base, S.ops);
  const emit = () => onChange(api.state());
  const persist = () => { if (S.tag) store.set(CACHE_PREFIX + S.tag, JSON.stringify({ base: S.base, ops: S.ops })); };

  async function call(method, body) {
    try {
      const r = await fetchImpl('/api/workspace', { method, credentials: 'include', cache: 'no-store', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    } catch { return { status: 0, body: null }; }
  }
  const okRow = (b) => b && Number.isSafeInteger(b.revision) && Array.isArray(b.watch) && Array.isArray(b.pins);
  const row = (b) => ({ revision: b.revision, watch: b.watch.filter(validId), pins: b.pins.filter(validId), updated_at: b.updated_at || null });

  function adoptTag(tag) {
    if (!/^[0-9a-f]{16}$/.test(String(tag || ''))) return false;
    if (S.tag && S.tag !== tag) { S.ops = []; S.base = null; }   // a different account on this device: never carry ops across
    S.tag = tag;
    let cached = null;
    try { cached = JSON.parse(store.get(CACHE_PREFIX + tag) || 'null'); } catch {}
    if (cached && Array.isArray(cached.ops)) {
      const pending = cached.ops.filter((o) => o && ['w+', 'w-', 'p+', 'p-'].includes(o.t) && validId(o.k));
      if (pending.length && !S.ops.length) S.ops = pending;     // unsynced taps from an earlier visit by this same account
    }
    // other accounts' caches on this device: keep only ones holding unsynced taps (never displayed to this account)
    for (const k of store.keys()) if (k.startsWith(CACHE_PREFIX) && k !== CACHE_PREFIX + tag) {
      try { const c = JSON.parse(store.get(k) || 'null'); if (!c?.ops?.length) store.del(k); } catch { store.del(k); }
    }
    // one-time, no-loss migration of pre-sync device saves into this account (cleared only after an acknowledged write)
    if (S.legacy === null) {
      const lops = legacyOps(storage);
      S.legacy = lops.length ? lops : false;
      if (lops.length) { S.ops = [...lops, ...S.ops]; S.migrated = new Set(lops.map((o) => o.k)).size; }
    }
    return true;
  }

  function schedule(ms) { clearTimer(S.timer); S.timer = setTimer(() => { S.timer = null; return flush(); }, ms); }
  function backoff() { const ms = BACKOFF[Math.min(S.fails, BACKOFF.length - 1)]; S.fails++; clearTimer(S.retry); S.retry = setTimer(() => { S.retry = null; return S.base ? flush() : load(); }, ms); return ms; }

  async function load() {
    const my = ++S.seq;
    if (!S.base) S.phase = 'loading';
    emit();
    const r = await call('GET');
    if (my !== S.seq) return api.state();
    if (r.status === 200 && okRow(r.body) && adoptTag(r.body.account_tag)) {
      S.base = row(r.body); S.lastSyncAt = now(); S.fails = 0; S.error = null;
      persist();
      if (S.ops.length) { S.phase = 'saving'; emit(); await flush(); }
      else { S.phase = 'synced'; emit(); }
      return api.state();
    }
    if (r.status === 401 || r.status === 403) { S.phase = 'signedout'; S.error = r.status; S.ops = []; S.base = null; emit(); return api.state(); }
    S.phase = S.ops.length ? 'pending' : 'unavailable'; S.error = r.status || 'network';
    backoff(); emit();
    return api.state();
  }

  async function flush() {
    if (!S.base) { if (S.phase !== 'loading') load(); return; }   // never write without having read this account's row
    if (!S.ops.length) { S.phase = 'synced'; emit(); return; }
    if (S.inflight) { S.again = true; return; }
    S.inflight = true; S.phase = 'saving'; emit();
    const sent = S.ops.length;
    const target = view();
    const r = await call('PUT', { base_revision: S.base.revision, watch: target.watch, pins: target.pins });
    S.inflight = false;
    if (r.status === 200 && okRow(r.body) && r.body.account_tag === S.tag) {
      S.base = row(r.body); S.ops = S.ops.slice(sent); S.conflicts = 0; S.fails = 0; S.lastSyncAt = now(); S.error = null;
      if (S.legacy) { for (const k of LEGACY_KEYS) store.del(k); S.legacy = false; }
      persist();
      if (S.ops.length || S.again) { S.again = false; return flush(); }
      S.phase = 'synced'; emit(); return;
    }
    if (r.status === 409 && okRow(r.body?.current) && r.body.account_tag === S.tag) {
      S.base = row(r.body.current); S.conflicts++;           // replay the same intentional ops onto the newer row
      persist();
      if (S.conflicts <= MAX_CONFLICTS) return flush();
      S.conflicts = 0; S.phase = 'pending'; S.error = 'conflict'; backoff(); emit(); return;
    }
    if (r.status === 401 || r.status === 403) { S.phase = 'signedout'; S.error = r.status; emit(); return; }
    if (r.status === 400) { S.ops = S.ops.slice(sent); S.phase = 'synced'; S.error = 'rejected'; persist(); emit(); return; }  // cannot be fixed by retrying
    S.phase = 'pending'; S.error = r.status || 'network'; persist(); backoff(); emit();
  }

  function mutate(t, k) {
    if (!validId(k) || !['w+', 'w-', 'p+', 'p-'].includes(t)) return false;
    if (S.phase === 'signedout') return false;
    S.ops.push({ t, k });
    persist();
    if (S.phase !== 'loading') S.phase = S.base ? 'saving' : 'pending';
    emit();
    schedule(DEBOUNCE_MS);
    return true;
  }

  const api = {
    load, flush,
    watch: (k, on) => mutate(on ? 'w+' : 'w-', k),
    pin: (k, on) => mutate(on ? 'p+' : 'p-', k),
    // pick up the other device's changes when this one returns (no minute-by-minute polling)
    refreshIfStale(maxAgeMs = 30e3) { if (!S.inflight && !S.ops.length && now() - S.lastSyncAt > maxAgeMs) return load(); return null; },
    retryNow() { S.fails = 0; clearTimer(S.retry); return S.base ? flush() : load(); },
    reset() { S.seq++; clearTimer(S.timer); clearTimer(S.retry); Object.assign(S, { phase: 'signedout', tag: null, base: null, ops: [], inflight: false, again: false }); emit(); },
    state() { const v = view(); return { phase: S.phase, watch: v.watch, pins: v.pins, revision: S.base?.revision ?? null, updated_at: S.base?.updated_at || null, pending: S.ops.length, lastSyncAt: S.lastSyncAt, error: S.error, migrated: S.migrated, ready: !!S.base }; }
  };
  return api;
}
