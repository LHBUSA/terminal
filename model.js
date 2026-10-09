// Terminal model: pure functions over Compare payloads (browser + node tests). No DOM, no fetch, no timers.
// Rules: every number keeps its source timestamp; nothing is interpolated or synthesized; absence is labelled.
// Compare decides comparability (core.js); Terminal only arranges, tracks real successive observations and alerts.
import { normalizeEvent, scoreIndex, rankEvents, SOON_MS, MARKET_STALE_MS, fmtCents } from './core.js';

export const MAX_PINS = 4;
export const MAX_WATCH = 200;
export const MOVE_ALERT_BP = 200;          // 2.0¢ between two distinct venue observations
export const PBE_ALERT_PTS = 2;            // PBE-vs-market distance change, points
export const CLOSING_MS = 30 * 60e3;       // watched event starts / closes within 30 min
export const FEED_LIVE_MS = 90e3;          // last good desk read younger than this = LIVE
export const MAX_ALERTS = 60;
export const SCOPES = ['sports', 'nonsports', 'nfl', 'nba', 'nhl', 'mlb', 'wnba', 'tennis', 'soccer', 'ufc', 'golf', 'f1'];
const SPORT_SET = new Set(SCOPES.slice(2));

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export const contractKey = (eventKey, contractId) => `${eventKey}|${contractId}`;
export const eventKeyOf = (key) => String(key).split('|')[0];
export const scopeOfEventKey = (ek) => { const s = String(ek).split(':')[0]; return SPORT_SET.has(s) ? s : 'nonsports'; };

// Polymarket "since first observed" movement on the raw desk contract (Kalshi desk entries carry none).
export function movementOf(raw) {
  if (!raw) return null;
  const pm = (raw.venues || []).find((v) => v.venue === 'polymarket') || (raw.related || []).find((v) => v.venue === 'polymarket') || null;
  const m = pm?.movement;
  const first = num(m?.first_mid_bp), delta = num(m?.delta_mid_bp);
  if (!m || first === null || delta === null || !m.first_observed_at) return null;
  return { venue: 'polymarket', first_observed_at: m.first_observed_at, first_mid_bp: first, delta_bp: delta };
}

// One desk body (+ optional score board) -> Terminal events, each contract carrying its key, event key and movement.
export function buildEvents(desk, live = null) {
  const idx = scoreIndex(live?.items || []);
  const out = [];
  for (const raw of desk?.events || []) {
    if (!raw || typeof raw !== 'object' || raw.canonical_event_id == null) continue;
    const e = normalizeEvent(raw, idx);
    const byId = new Map((raw.contracts || []).map((c) => [c.canonical_contract_id || c.label, c]));
    e.category = raw.category || null;
    e.scope = e.sport || 'nonsports';
    e.contracts = e.contracts.filter((c) => c.id).map((c) => ({ ...c, key: contractKey(e.key, c.id), ev: e.key, move: movementOf(byId.get(c.id)) }));
    out.push(e);
  }
  return out;
}

export function statusOf(e, now = Date.now()) {
  if (e.status === 'final') return 'FINAL';
  if (e.live) return 'LIVE';
  const t = Date.parse(e.start_at || '');
  if (Number.isFinite(t) && t > now && t - now <= SOON_MS) return 'SOON';
  if (Number.isFinite(t) && t <= now && e.sport) return 'STARTED';
  return e.sport ? 'UPCOMING' : 'OPEN';
}

const maxMove = (e) => Math.max(-1, ...e.contracts.map((c) => (c.move ? Math.abs(c.move.delta_bp) : -1)));
const STATUS_RANK = { LIVE: 0, SOON: 1, STARTED: 2, UPCOMING: 3, OPEN: 3, FINAL: 9 };
export function sortEvents(events, mode = 'priority', now = Date.now()) {
  const list = [...events];
  if (mode === 'gap') return list.sort((a, b) => (b.best_gap ?? -1) - (a.best_gap ?? -1) || String(a.start_at || '9').localeCompare(String(b.start_at || '9')));
  if (mode === 'move') return list.sort((a, b) => maxMove(b) - maxMove(a));
  if (mode === 'start') return list.sort((a, b) => String(a.start_at || '9').localeCompare(String(b.start_at || '9')));
  const ranked = rankEvents(list);
  const pos = new Map(ranked.map((e, i) => [e.key, i]));
  return list.sort((a, b) => (STATUS_RANK[statusOf(a, now)] - STATUS_RANK[statusOf(b, now)]) || pos.get(a.key) - pos.get(b.key));
}

export const FILTERS = {
  all: { label: 'All markets', test: () => true },
  live: { label: 'Live now', test: (e) => e.live },
  verified: { label: 'Has verified pair', test: (e) => e.contracts.some((c) => c.comparison) },
  rules: { label: 'Rules differ', test: (e) => e.contracts.some((c) => c.badge === 'RULE_MISMATCH' || c.badge === 'WITHDRAWN' || c.comparison?.disclosure) },
  pbe: { label: 'PBE model', test: (e) => e.has_pbe }
};
export function filterEvents(events, { q = '', filter = 'all', watch = null, pins = null } = {}) {
  const term = String(q).trim().toLowerCase();
  const f = FILTERS[filter] || FILTERS.all;
  return events.filter((e) => f.test(e)
    && (!term || [e.title, e.sport, e.category, ...e.contracts.map((c) => c.label)].filter(Boolean).join(' ').toLowerCase().includes(term))
    && (!watch || e.contracts.some((c) => watch.has(c.key)))
    && (!pins || e.contracts.some((c) => pins.has(c.key))));
}

// Plain-language comparability state per contract, from Compare's badge only.
export function contractState(c) {
  if (c.comparison) {
    if (c.note === 'EXACT') return { code: 'EXACT', label: 'Exact match', short: 'Exact match', tone: 'ok' };
    if (c.comparison.disclosure) return { code: 'EXCEPTIONS', label: 'Comparable · settlement exceptions differ', short: 'Comparable · exceptions differ', tone: 'warn' };
    return { code: 'COMPARABLE', label: 'Comparable', short: 'Comparable', tone: 'ok' };
  }
  if (c.note === 'NOT_ALIGNED') return { code: 'NOT_ALIGNED', label: 'Quotes not aligned · no gap', short: 'Not aligned · no gap', tone: 'dim' };
  if (c.badge === 'WITHDRAWN') return { code: 'WITHDRAWN', label: 'Comparison withdrawn', short: 'Withdrawn', tone: 'risk' };
  if (c.badge === 'RULE_MISMATCH') return { code: 'RULES_DIFFER', label: 'Rules differ · not compared', short: 'Rules differ', tone: 'risk' };
  return { code: 'SINGLE', label: 'Single venue', short: 'Single venue', tone: 'dim' };
}
export const modelState = (c) => (c.pbe ? { code: 'MODEL', label: `PBE model ${(c.pbe.probability * 100).toFixed(1)}%` } : { code: 'NO_MODEL', label: 'Model not available' });

// Feed health from the desk read clock. OFFLINE is the browser's own signal.
export function feedHealth({ lastOkAt = null, lastStatus = null, lanes = [], online = true, now = Date.now() } = {}) {
  if (!online) return { state: 'OFFLINE', text: 'Device offline · showing last observations' };
  if (!lastOkAt) return lastStatus && lastStatus !== 200 ? { state: 'STALLED', text: `Market desk unavailable (${lastStatus || 'network'})` } : { state: 'CONNECTING', text: 'Reading market desk' };
  const age = now - lastOkAt;
  const down = (lanes || []).filter((l) => l.state === 'unavailable');
  if (age > MARKET_STALE_MS) return { state: 'STALLED', text: `No fresh desk read for ${Math.round(age / 60e3) || 1} min · showing last observations` };
  if (age > FEED_LIVE_MS || down.length) return { state: 'DELAYED', text: down.length ? `${down.length} lane${down.length > 1 ? 's' : ''} delayed: ${down.map((l) => String(l.lane).toUpperCase()).join(', ')}` : 'Desk read delayed' };
  return { state: 'LIVE', text: 'Market desk live' };
}

// ------------------------------------------------------------------ session observations + alerts
// A snapshot keeps, per contract, the latest venue quote WITH its observed_at. A "move" needs two distinct
// observations (different observed_at); the same observation read twice is never a move.
export function snapshot(events) {
  const m = new Map();
  for (const e of events) for (const c of e.contracts) {
    m.set(c.key, {
      key: c.key, ev: e.key, title: e.title, label: c.label, start_at: e.start_at, sport: e.sport,
      k: c.kalshi?.mid_bp != null ? { mid: c.kalshi.mid_bp, at: c.kalshi.observed_at } : null,
      p: c.polymarket?.mid_bp != null ? { mid: c.polymarket.mid_bp, at: c.polymarket.observed_at } : null,
      cmp: !!c.comparison, gap: c.gap_pts, pbe: c.pbe?.probability ?? null, pbeVs: Array.isArray(c.pbe_vs_venues) ? c.pbe_vs_venues.map(num) : null, pbeAt: c.pbe?.issued_at || null
    });
  }
  return m;
}

const VENUE = { k: 'Kalshi', p: 'Polymarket' };
const clock = (iso) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(11, 19) + 'Z' : 'time unknown');
// prev/next: snapshot maps. watch: Set of contract keys. fired: Set of alert ids already raised (dedupe, mutated).
export function diffAlerts(prev, next, { watch = new Set(), fired = new Set(), now = Date.now() } = {}) {
  if (!prev || !next) return [];
  const out = [];
  const raise = (a) => { if (fired.has(a.id)) return; fired.add(a.id); out.push(a); };
  const watchedEvents = new Set([...watch].map(eventKeyOf));
  let matched = 0;
  for (const [key, n] of next) {
    const o = prev.get(key);
    const watched = watch.has(key);
    const base = { key, ev: n.ev, title: n.title, label: n.label, sport: n.sport };
    if (o && !o.cmp && n.cmp && matched < 5) {
      matched++;
      raise({ ...base, id: `matched|${key}`, type: 'MATCHED', at: [n.k?.at, n.p?.at].filter(Boolean).sort().at(-1) || null,
        text: `${n.label}: newly comparable on both venues${n.gap != null ? ` · gap ${n.gap.toFixed(1)} pts` : ''}` });
    }
    if (watched && o) {
      for (const v of ['k', 'p']) {
        const a = o[v], b = n[v];
        if (!a || !b || !a.at || !b.at || a.at === b.at) continue;
        const d = b.mid - a.mid;
        if (Math.abs(d) >= MOVE_ALERT_BP) raise({ ...base, id: `move|${key}|${v}|${b.at}`, type: 'MOVE', venue: VENUE[v], at: b.at, delta_bp: d,
          text: `${n.label} ${VENUE[v]} ${fmtCents(a.mid)} → ${fmtCents(b.mid)} (${d > 0 ? '+' : '−'}${(Math.abs(d) / 100).toFixed(1)}¢) · observed ${clock(a.at)} → ${clock(b.at)}` });
      }
      if (o.pbe == null && n.pbe != null) raise({ ...base, id: `pbe-new|${key}`, type: 'MODEL', at: n.pbeAt, text: `${n.label}: PBE model published at ${(n.pbe * 100).toFixed(1)}%` });
      else if (o.pbeVs && n.pbeVs) {
        // per venue (Compare's comparison.venues order): the model is frozen at lock, so a change here is the market moving
        const i = n.pbeVs.findIndex((v, j) => v != null && o.pbeVs[j] != null && Math.abs(v - o.pbeVs[j]) >= PBE_ALERT_PTS);
        if (i >= 0) raise({ ...base, id: `pbe|${key}|${n.k?.at || ''}|${n.p?.at || ''}`, type: 'MODEL', at: [n.k?.at, n.p?.at].filter(Boolean).sort().at(-1) || null,
          text: `${n.label}: market vs PBE model moved ${o.pbeVs[i] > 0 ? '+' : ''}${o.pbeVs[i].toFixed(1)} → ${n.pbeVs[i] > 0 ? '+' : ''}${n.pbeVs[i].toFixed(1)} pts` });
      }
    }
    if (watched || watchedEvents.has(n.ev)) {
      const t = Date.parse(n.start_at || '');
      if (Number.isFinite(t) && t > now && t - now <= CLOSING_MS)
        raise({ ...base, id: `closing|${n.ev}`, type: 'CLOSING', label: null, at: n.start_at, text: `${n.title}: ${n.sport ? 'starts' : 'closes'} in ${Math.max(1, Math.round((t - now) / 60e3))} min (${clock(n.start_at)})` });
    }
  }
  return out;
}
export const feedAlert = (from, to, at) => ({ id: `feed|${to}|${at}`, type: to === 'STALLED' || to === 'OFFLINE' ? 'STALE' : 'RECOVERED', at, title: 'Market desk',
  text: to === 'STALLED' ? 'Market data stalled: prices shown are the last observations' : to === 'OFFLINE' ? 'Device offline: prices frozen at the last observation' : `Market data recovered (${from} → LIVE)` });
export function pushAlerts(list, add) { return [...add.reverse(), ...list].slice(0, MAX_ALERTS); }

// ------------------------------------------------------------------ stored history -> chart series
// Sports: Compare /api/event (compare-event/1). Non-sports: Compare /api/series (market-desk-series/1).
// Returns { kalshi: [[{t,v}]], polymarket: [[{t,v}]] } as stored segments; nothing interpolated across gaps.
export function historyFor(body, contractId) {
  const empty = { kalshi: [], polymarket: [] };
  if (!body || typeof body !== 'object') return empty;
  const clean = (pts) => (Array.isArray(pts) ? pts : []).map((p) => ({ t: Date.parse(p?.t), v: num(p?.v) })).filter((p) => Number.isFinite(p.t) && p.v !== null && p.v >= 0 && p.v <= 10000).sort((a, b) => a.t - b.t);
  if (body.contract === 'compare-event/1') {
    const c = (body.contracts || []).find((x) => x.canonical_contract_id === contractId);
    if (!c) return empty;
    const k = clean(c.kalshi?.points), p = clean(c.polymarket?.points);
    return { kalshi: k.length ? [k] : [], polymarket: p.length ? [p] : [] };
  }
  if (Array.isArray(body.series)) {
    const out = { kalshi: [], polymarket: [] };
    for (const s of body.series) if (out[s?.source]) out[s.source] = (s.segments || []).map(clean).filter((x) => x.length);
    return out;
  }
  return empty;
}

// Step path (a stored value holds until the next stored row; the last value holds to `until`). Domain in bp and ms.
export function stepPath(segment, { t0, t1, v0, v1, w, h, until = null }) {
  if (!segment?.length || t1 <= t0 || v1 <= v0) return '';
  const x = (t) => ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * w;
  const y = (v) => h - ((v - v0) / (v1 - v0)) * h;
  let d = `M${x(segment[0].t).toFixed(1)},${y(segment[0].v).toFixed(1)}`;
  for (let i = 1; i < segment.length; i++) d += `H${x(segment[i].t).toFixed(1)}V${y(segment[i].v).toFixed(1)}`;
  if (until != null) d += `H${x(until).toFixed(1)}`;
  return d;
}
export function chartDomain(hist, now = Date.now(), extra = []) {
  const all = [...hist.kalshi.flat(), ...hist.polymarket.flat()];
  if (all.length < 1) return null;
  const vs = [...all.map((p) => p.v), ...extra.filter((v) => v != null)];
  let v0 = Math.min(...vs), v1 = Math.max(...vs);
  const pad = Math.max(100, (v1 - v0) * 0.15);
  v0 = Math.max(0, v0 - pad); v1 = Math.min(10000, v1 + pad);
  return { t0: Math.min(...all.map((p) => p.t)), t1: Math.max(now, ...all.map((p) => p.t)), v0, v1 };
}

// ------------------------------------------------------------------ fetch ordering + local ids
// latest(): tag a request; only the newest tag for a channel may apply its result (late responses are dropped).
export function sequencer() {
  const last = new Map();
  return { next: (ch) => { const n = (last.get(ch) || 0) + 1; last.set(ch, n); return n; }, isLatest: (ch, n) => last.get(ch) === n };
}

// Only ids are persisted (no prices, no membership data). v1 (production V1) keys were `${sport}:${event}:${contract}`.
export function parseIds(raw, max) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x.length < 400))].slice(0, max) : []; } catch { return []; }
}
export function migrateV1(ids) {
  return ids.map((id) => { const m = String(id).match(/^([a-z0-9]*):([^:]+):(.+)$/); return m ? contractKey(`${m[1] || 'nonsports'}:${m[2]}`, m[3]) : null; }).filter(Boolean);
}
// The desk scopes that cover a set of saved keys: one lane each, or the whole sports desk when more than two sports.
export function scopesFor(keys) {
  const s = new Set([...keys].map((k) => scopeOfEventKey(eventKeyOf(k))));
  const sports = [...s].filter((x) => x !== 'nonsports');
  return [...(sports.length > 2 ? ['sports'] : sports), ...(s.has('nonsports') ? ['nonsports'] : [])];
}
export const covers = (scope, eventScope) => scope === eventScope || (scope === 'sports' && eventScope !== 'nonsports');
