import { requireAccess, send } from './_lib/access.js';

// Cross-device workspace (LHBUSA/terminal#3). Terminal's own fail-closed access check first, then the auth Worker
// (propbetedge-auth-magic v2.12) which re-verifies the session + All Access entitlement and owns storage
// (identity Supabase, revision compare-and-swap). Only pbe_session is forwarded; only ids travel; no email in or out.
export const WORKSPACE_URL = 'https://auth.propbetedge.ai/terminal/workspace';
export const MAX_BYTES = 32768;
const ORIGINS = new Set(['https://terminal.propbetedge.ai', ...(process.env.TERMINAL_DEV_ORIGIN ? [process.env.TERMINAL_DEV_ORIGIN] : [])]);
const ID_RE = /^(?:nfl|nba|nhl|mlb|wnba|tennis|ufc|soccer|golf|f1|nonsports):[A-Za-z0-9 _.:+&()\/-]{1,120}\|[A-Za-z0-9 _.:|+&()\/-]{1,180}$/;
const ids = (v, max) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length <= 300 && ID_RE.test(x));
const row = (b) => ({ revision: b.revision, watch: b.watch, pins: b.pins, updated_at: b.updated_at ?? null });
const isRow = (b) => b && Number.isSafeInteger(b.revision) && Array.isArray(b.watch) && Array.isArray(b.pins);

export default async function handler(req, res, fetchImpl = fetch) {
  if (req.method !== 'GET' && req.method !== 'PUT') { res.setHeader('Allow', 'GET, PUT'); return send(res, 405, { error: 'method_not_allowed' }); }
  let body = null;
  if (req.method === 'PUT') {
    // CSRF: a browser always sends Origin on PUT; only the Terminal itself may write (fetch metadata too, when sent)
    const site = req.headers['sec-fetch-site'];
    if (!ORIGINS.has(req.headers.origin) || (site && site !== 'same-origin')) return send(res, 403, { error: 'origin_not_allowed' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'json_required' });
    if (Number(req.headers['content-length'] || 0) > MAX_BYTES) return send(res, 413, { error: 'payload_too_large', max_bytes: MAX_BYTES });
    try { body = req.body; } catch { return send(res, 400, { error: 'invalid_json' }); }
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid_json' }); } }
    if (JSON.stringify(body ?? null).length > MAX_BYTES) return send(res, 413, { error: 'payload_too_large', max_bytes: MAX_BYTES });
    if (!body || !Number.isSafeInteger(body.base_revision) || body.base_revision < 0 || !ids(body.watch, 200) || !ids(body.pins, 4))
      return send(res, 400, { error: 'invalid_workspace' });
    body = { base_revision: body.base_revision, watch: body.watch, pins: body.pins };   // nothing else is forwarded
  }
  const auth = await requireAccess(req, res);
  if (!auth) return;
  let r;
  try {
    r = await fetchImpl(WORKSPACE_URL, {
      method: req.method,
      headers: { accept: 'application/json', cookie: auth.cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store', signal: AbortSignal.timeout(6000)
    });
  } catch { return send(res, 503, { error: 'workspace_unavailable' }); }
  const b = await r.json().catch(() => null);
  if (r.status === 200 && isRow(b) && typeof b.account_tag === 'string') return send(res, 200, { contract: 'terminal-workspace/1', account_tag: b.account_tag, ...row(b) });
  if (r.status === 409 && isRow(b?.current) && typeof b.account_tag === 'string') return send(res, 409, { error: 'revision_conflict', account_tag: b.account_tag, current: row(b.current) });
  if (r.status === 400 || r.status === 413 || r.status === 415) return send(res, r.status, { error: String(b?.error || 'invalid_workspace').slice(0, 60) });
  // Terminal's authority said entitled; the auth Worker disagreeing is an outage, never "not a member"
  if (r.status === 401 || r.status === 403) return send(res, 503, { error: 'shared_access_verification_failed' });
  return send(res, 503, { error: 'workspace_unavailable' });
}
