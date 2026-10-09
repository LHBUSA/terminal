// /api/workspace proxy contract: access first, CSRF/size/shape gates, only pbe_session forwarded, strict response shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { WORKSPACE_URL } from '../api/workspace.js';
import { AUTHORITY } from '../api/_lib/access.js';

const K = (n) => `nhl:${n}|sports_winner|nhl:${n}|team:17`;
function res() {
  const r = { statusCode: 0, headers: {}, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.send = (b) => { r.body = JSON.parse(b); return r; };
  return r;
}
const T = 'https://terminal.propbetedge.ai';
const req = ({ method = 'GET', body, cookie = 'pbe_session=abc; other=1', origin = T, site = 'same-origin', ct = 'application/json', len } = {}) =>
  ({ method, body, headers: { cookie, origin, 'sec-fetch-site': site, 'content-type': ct, ...(len ? { 'content-length': String(len) } : {}) } });

let calls = [];
function world({ member = 'all_access', worker = { status: 200, body: { contract: 'terminal-workspace/1', account_tag: '0123456789abcdef', revision: 1, watch: [K(1)], pins: [], updated_at: 'T' } } } = {}) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', cookie: init.headers?.cookie || null, body: init.body || null, headers: init.headers || {} });
    if (String(url) === AUTHORITY) {
      const body = member === 'none' ? { authenticated: false, membership: { state: 'anonymous', entitled: false } } : member === 'free' ? { authenticated: true, membership: { state: 'free', entitled: false } } : { authenticated: true, membership: { state: member, entitled: true } };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (String(url) === WORKSPACE_URL) {
      if (worker === 'throw') throw new Error('down');
      return new Response(typeof worker.body === 'string' ? worker.body : JSON.stringify(worker.body), { status: worker.status });
    }
    throw new Error('unexpected ' + url);
  };
}
const toWorker = () => calls.filter((c) => c.url === WORKSPACE_URL);

test('GET: guest 401 / lapsed 403 never reach the workspace; owner + all_access get only the row fields', async () => {
  for (const [m, code] of [['none', 401], ['free', 403]]) { world({ member: m }); const r = res(); await handler(req({ cookie: m === 'none' ? '' : 'pbe_session=abc' }), r); assert.equal(r.statusCode, code); assert.equal(toWorker().length, 0); }
  for (const m of ['owner', 'all_access']) {
    world({ member: m, worker: { status: 200, body: { contract: 'terminal-workspace/1', account_tag: '0123456789abcdef', revision: 4, watch: [K(1)], pins: [K(1)], updated_at: 'T', email: 'leak@x.test', extra: 1 } } });
    const r = res(); await handler(req(), r);
    assert.equal(r.statusCode, 200); assert.deepEqual(r.body, { contract: 'terminal-workspace/1', account_tag: '0123456789abcdef', revision: 4, watch: [K(1)], pins: [K(1)], updated_at: 'T' });
    assert.equal(toWorker()[0].cookie, 'pbe_session=abc', 'only the session cookie travels');
    assert.equal(r.headers['cache-control'], 'private, no-store, max-age=0'); assert.equal(r.headers.vary, 'Cookie');
  }
});

test('PUT: CSRF, content type, size and shape are checked before any upstream call', async () => {
  const good = { base_revision: 1, watch: [K(1)], pins: [] };
  const cases = [
    [{ origin: 'https://evil.example' }, 403], [{ origin: 'https://members.propbetedge.ai' }, 403], [{ origin: '' }, 403], [{ site: 'same-site' }, 403], [{ site: 'cross-site' }, 403],
    [{ ct: 'text/plain' }, 415], [{ len: 40000 }, 413], [{ body: { ...good, pad: 'x'.repeat(40000) } }, 413],
    [{ body: '{bad' }, 400], [{ body: { ...good, base_revision: -1 } }, 400], [{ body: { ...good, base_revision: '1' } }, 400],
    [{ body: { ...good, watch: ['<x>'] } }, 400], [{ body: { ...good, pins: [K(1), K(2), K(3), K(4), K(5)] } }, 400], [{ body: { ...good, watch: Array.from({ length: 201 }, (_, i) => K(i)) } }, 400], [{ body: null }, 400]
  ];
  for (const [o, code] of cases) { world(); const r = res(); await handler(req({ method: 'PUT', body: good, ...o }), r); assert.equal(r.statusCode, code, JSON.stringify(o).slice(0, 80)); assert.equal(calls.length, 0, 'no membership or worker call'); }
  world(); const r = res(); await handler(req({ method: 'DELETE' }), r); assert.equal(r.statusCode, 405); assert.equal(calls.length, 0);
});

test('PUT forwards exactly { base_revision, watch, pins } with only pbe_session; 409 passes the current row', async () => {
  world();
  let r = res(); await handler(req({ method: 'PUT', body: { base_revision: 1, watch: [K(1)], pins: [K(1)], email: 'x@y', account_key: 'f'.repeat(64) } }), r);
  assert.equal(r.statusCode, 200);
  const w = toWorker()[0];
  assert.deepEqual(JSON.parse(w.body), { base_revision: 1, watch: [K(1)], pins: [K(1)] });
  assert.equal(w.cookie, 'pbe_session=abc'); assert.equal(w.headers.origin, undefined);
  world({ worker: { status: 409, body: { error: 'revision_conflict', account_tag: '0123456789abcdef', current: { revision: 7, watch: [K(2)], pins: [], updated_at: 'T2' } } } });
  r = res(); await handler(req({ method: 'PUT', body: { base_revision: 6, watch: [], pins: [] } }), r);
  assert.equal(r.statusCode, 409); assert.deepEqual(r.body, { error: 'revision_conflict', account_tag: '0123456789abcdef', current: { revision: 7, watch: [K(2)], pins: [], updated_at: 'T2' } });
});

test('worker outages and disagreements are 503 (Retry-After), never an empty workspace or a sign-out', async () => {
  for (const worker of ['throw', { status: 500, body: {} }, { status: 503, body: { error: 'workspace_unavailable' } }, { status: 200, body: 'not json' }, { status: 200, body: { revision: 'x' } }, { status: 401, body: {} }, { status: 403, body: {} }]) {
    world({ worker }); const r = res(); await handler(req(), r);
    assert.equal(r.statusCode, 503, JSON.stringify(worker)); assert.equal(r.headers['retry-after'], '30'); assert.equal(r.body.watch, undefined);
  }
});
