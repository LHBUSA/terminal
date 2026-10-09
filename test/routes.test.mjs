// Access + proxy contract for every Terminal API route. global fetch is stubbed: the membership authority and Compare.
import test from 'node:test';
import assert from 'node:assert/strict';
import desk from '../api/desk.js';
import event from '../api/event.js';
import live from '../api/live.js';
import series from '../api/series.js';
import membership from '../api/membership.js';
import { AUTHORITY, COMPARE } from '../api/_lib/access.js';

function res() {
  const r = { statusCode: 0, headers: {}, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.send = (b) => { r.body = JSON.parse(b); return r; };
  return r;
}
const req = (query = {}, cookie = 'pbe_session=abc; _ga=GA1.2', method = 'GET') => ({ method, query, headers: { cookie } });

// world: membership verdict + compare responses; records every upstream call
function world({ member = 'owner', authority = 200, compare = { status: 200, body: { ok: true } } } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), cookie: init.headers?.cookie || null });
    if (String(url) === AUTHORITY) {
      if (authority === 'throw') throw new Error('down');
      const body = member === 'anonymous' ? { authenticated: false, membership: { state: 'anonymous', entitled: false } }
        : member === 'free' ? { authenticated: true, membership: { state: 'free', entitled: false } }
        : member === 'unverified' ? { membership: { state: 'unverified', entitled: false } }
        : { authenticated: true, membership: { state: member, entitled: true } };
      return new Response(JSON.stringify(body), { status: authority });
    }
    if (String(url).startsWith(COMPARE)) {
      if (compare === 'throw') throw new Error('timeout');
      return new Response(compare.body === null ? 'not json' : JSON.stringify(compare.body), { status: compare.status });
    }
    throw new Error('unexpected upstream ' + url);
  };
  return calls;
}

const ROUTES = [
  ['desk', desk, { scope: 'nhl' }, '/api/desk?scope=nhl'],
  ['event', event, { sport: 'nhl', event: '2026020066' }, '/api/event?sport=nhl&event=2026020066'],
  ['live', live, { sports: 'nhl,nba' }, '/api/live?sports=nba,nhl'],
  ['series', series, { event: 'PBE-KXSPACEXCOUNT-26OCT', market: 'KXSPACEXCOUNT-26OCT-8', hours: '24' }, '/api/series?event=PBE-KXSPACEXCOUNT-26OCT&market=KXSPACEXCOUNT-26OCT-8&hours=24']
];

for (const [name, handler, query, route] of ROUTES) {
  test(`${name}: guest without a session -> 401, no upstream call, no payload`, async () => {
    const calls = world();
    const r = res(); await handler(req(query, ''), r);
    assert.equal(r.statusCode, 401); assert.equal(r.body.entitled, false); assert.equal(calls.length, 0);
    assert.equal(r.headers['cache-control'], 'private, no-store, max-age=0');
  });
  test(`${name}: anonymous session -> 401; signed-in free/lapsed -> 403; Compare never read`, async () => {
    for (const [member, code] of [['anonymous', 401], ['free', 403]]) {
      const calls = world({ member });
      const r = res(); await handler(req(query), r);
      assert.equal(r.statusCode, code, member); assert.equal(calls.filter((c) => c.url.startsWith(COMPARE)).length, 0);
    }
  });
  test(`${name}: authority down or unverified -> 503 + Retry-After (never "not a member")`, async () => {
    for (const w of [{ authority: 500 }, { authority: 'throw' }, { member: 'unverified' }]) {
      world(w); const r = res(); await handler(req(query), r);
      assert.equal(r.statusCode, 503, JSON.stringify(w)); assert.equal(r.headers['retry-after'], '30');
    }
  });
  test(`${name}: owner and all_access read Compare ${route} with only the session cookie`, async () => {
    for (const member of ['owner', 'all_access']) {
      const calls = world({ member, compare: { status: 200, body: { marker: name } } });
      const r = res(); await handler(req(query), r);
      assert.equal(r.statusCode, 200); assert.deepEqual(r.body, { marker: name });
      const up = calls.find((c) => c.url.startsWith(COMPARE));
      assert.equal(up.url, COMPARE + route); assert.equal(up.cookie, 'pbe_session=abc');
    }
  });
  test(`${name}: Compare 401/403 after Terminal granted -> 503; bad JSON / throw -> 502`, async () => {
    for (const [compare, code] of [[{ status: 401, body: {} }, 503], [{ status: 403, body: {} }, 503], [{ status: 200, body: null }, 502], ['throw', 502]]) {
      world({ compare }); const r = res(); await handler(req(query), r);
      assert.equal(r.statusCode, code);
    }
  });
  test(`${name}: non-GET -> 405 before any upstream read`, async () => {
    const calls = world(); const r = res(); await handler(req(query, 'pbe_session=abc', 'POST'), r);
    assert.equal(r.statusCode, 405); assert.equal(calls.length, 0);
  });
}

test('invalid parameters are rejected with 400 before the membership read', async () => {
  const bad = [[desk, { scope: 'crypto' }], [event, { sport: 'sports', event: '1' }], [event, { sport: 'nhl', event: 'a b' }],
    [live, { sports: '' }], [live, { sports: 'nhl,curling' }], [series, { event: 'x', market: '' }], [series, { event: '<x>', market: 'y' }]];
  for (const [h, q] of bad) {
    const calls = world(); const r = res(); await h(req(q), r);
    assert.equal(r.statusCode, 400, JSON.stringify(q)); assert.equal(calls.length, 0);
  }
});

test('series clamps hours to 1..168', async () => {
  const calls = world();
  await series(req({ event: 'E', market: 'M', hours: '9999' }), res());
  assert.match(calls.at(-1).url, /hours=168$/);
});

test('membership route: role only when entitled, never extra fields', async () => {
  world({ member: 'owner' }); let r = res(); await membership(req(), r);
  assert.deepEqual(r.body, { entitled: true, role: 'owner', state: 'owner', preview_mode: false });
  world({ member: 'free' }); r = res(); await membership(req(), r);
  assert.equal(r.statusCode, 403); assert.equal(r.body.role, null);
});
