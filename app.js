// PBE Terminal V2 — All Access market intelligence workspace (read-only).
// Data: Terminal's own /api routes, which proxy Compare behind the fail-closed membership check. Nothing is
// fabricated: prices are stored venue observations with timestamps; gaps come only from Compare's comparison;
// PBE probabilities only from the desk's published `pbe`. Only ids (watchlist, pins) are kept in localStorage.
import { fmtCents, fmtPct, ageText, ruleTermsView, keyDifferences, BADGES, moves, WINDOWS, fmtMove, participantMedia, CROSS_TOOLTIP, hubStats } from './core.js';
import * as M from './model.js';
import { createSync } from './sync.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const utc = (iso) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '—');
const hhmm = (iso) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(11, 19) + 'Z' : '—');
const local = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '—'; };
const ago = (iso) => ageText(iso) || '—';
// upstream links are rendered only when they are plain https URLs
const safeUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };
const SCOPE_LABEL = { sports: 'All sports', nonsports: 'Prediction markets', nfl: 'NFL', nba: 'NBA', nhl: 'NHL', mlb: 'MLB', wnba: 'WNBA', soccer: 'Soccer', tennis: 'Tennis', ufc: 'UFC', golf: 'Golf', f1: 'Formula 1' };
const LIVE_SPORTS = ['nfl', 'nba', 'nhl', 'mlb', 'wnba', 'soccer', 'tennis', 'golf'];
const ROWS_COLLAPSED = 6;
const HIST_TTL = 60e3;
const POLL_MS = 60e3;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} }
};
const params = new URLSearchParams(location.search);
const S = {
  sync: { phase: 'loading', ready: false, pending: 0 },
  member: null, scope: M.SCOPES.includes(params.get('scope')) ? params.get('scope') : (M.SCOPES.includes(store.get('pbe_terminal_scope')) ? store.get('pbe_terminal_scope') : 'sports'),
  view: ['board', 'watch', 'pins', 'alerts'].includes(params.get('view')) ? params.get('view') : 'board',
  filter: 'all', sort: 'priority', q: '',
  desks: new Map(),            // scope -> { body, at, status, events }
  live: null, liveAt: 0, liveKey: '',
  watch: new Set(), pins: [],
  hist: new Map(),             // history key -> { body, at, status, loading }
  open: params.get('c') || null,
  expanded: new Set(),
  alerts: [], unread: 0, fired: new Set(), snap: new Map(),
  health: { state: 'CONNECTING', text: '' }, lastHealth: 'CONNECTING', lastOkAt: 0, lastStatus: null,
  online: navigator.onLine !== false, busy: false, seq: M.sequencer(), ctl: new Map(), lastHtml: ''
};
// Watchlist + pins are an All Access account workspace (sync.js -> /api/workspace -> auth Worker -> identity Supabase).
// S.watch / S.pins mirror the sync view; every tap is an operation the sync engine saves, merges and retries.
let synced = null;
function onSync(st) {
  S.sync = st;
  S.watch = new Set(st.watch); S.pins = [...st.pins];
  if (synced && S.member) paint();
}
const sync = createSync({ fetchImpl: (u, i) => fetch(u, i), storage: (() => { try { return localStorage; } catch { return { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 }; } })(), onChange: onSync });
synced = true;

// ------------------------------------------------------------------ network
async function getJson(url, ch) {
  S.ctl.get(ch)?.abort();
  const ac = new AbortController(); S.ctl.set(ch, ac);
  const n = S.seq.next(ch);
  try {
    const r = await fetch(url, { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' }, signal: ac.signal });
    const body = await r.json().catch(() => null);
    return { status: r.status, body, latest: S.seq.isLatest(ch, n) };
  } catch (e) {
    return { status: e?.name === 'AbortError' ? -1 : 0, body: null, latest: S.seq.isLatest(ch, n) };
  }
}

async function checkMembership() {
  const r = await getJson('/api/membership', 'membership');
  if (r.status === 200 && r.body?.entitled === true) { S.member = r.body; return 'entitled'; }
  S.member = null;
  return r.status === 401 ? 'anonymous' : r.status === 403 ? 'forbidden' : 'unverified';
}

function allEvents() {
  const m = new Map();
  for (const d of [...S.desks.values()].sort((a, b) => a.at - b.at)) for (const e of d.events) m.set(e.key, e);
  return m;
}
const findContract = (key) => { const e = allEvents().get(M.eventKeyOf(key)); return e ? { e, c: e.contracts.find((x) => x.key === key) || null } : { e: null, c: null }; };

async function readDesk(scope) {
  const r = await getJson('/api/desk?scope=' + encodeURIComponent(scope), 'desk:' + scope);
  if (r.status === -1 || !r.latest) return;
  if (r.status === 401 || r.status === 403) return lostAccess(r.status);
  if (scope === S.scope) S.lastStatus = r.status;
  if (r.body && Array.isArray(r.body.lanes) && Array.isArray(r.body.events)) {
    const prev = S.desks.get(scope);
    const body = prev ? carry(prev, r.body) : r.body;
    const events = M.buildEvents(body, S.live?.body);
    // alerts: compare this read's contracts with their previous observation (any scope that carried them)
    const next = M.snapshot(events);
    const add = M.diffAlerts(S.snap, next, { watch: S.watch, fired: S.fired });
    for (const [k, v] of next) S.snap.set(k, v);
    if (add.length) addAlerts(add);
    S.desks.set(scope, { body, at: Date.now(), status: r.status, events });
    if (scope === S.scope) S.lastOkAt = Date.now();
  } else if (scope === S.scope && !S.desks.get(scope)) {
    S.desks.set(scope, { body: null, at: 0, status: r.status, events: [] });
  }
}
// keep last-known events of a lane that failed this read (Compare's own carry rule, 15 min max)
function carry(prev, next) {
  const before = new Map((prev.body?.lanes || []).map((l) => [l.lane, l]));
  const keep = [];
  const lanes = next.lanes.map((l) => {
    if (l.state !== 'unavailable') return l;
    const p = before.get(l.lane);
    const at = p?.state === 'ok' ? new Date(prev.at).toISOString() : p?.cached_at || null;
    if (!at || Date.now() - Date.parse(at) > 15 * 60e3) return l;
    const evs = (prev.body?.events || []).filter((e) => (e.lane || e.sport || 'nonsports') === l.lane);
    keep.push(...evs);
    return evs.length ? { ...l, cached_at: at } : l;
  });
  return keep.length ? { ...next, lanes, events: [...next.events, ...keep] } : { ...next, lanes };
}

async function readLive() {
  const d = S.desks.get(S.scope);
  const sports = S.scope === 'nonsports' ? [] : S.scope !== 'sports' ? (LIVE_SPORTS.includes(S.scope) ? [S.scope] : []) : [...new Set((d?.events || []).map((e) => e.sport).filter((s) => LIVE_SPORTS.includes(s)))].sort();
  if (!sports.length) return;
  const r = await getJson('/api/live?sports=' + sports.join(','), 'live');
  if (r.status === -1 || !r.latest) return;
  if (r.status === 200 && Array.isArray(r.body?.items)) {
    S.live = { body: r.body, at: Date.now() };
    for (const [scope, dk] of S.desks) if (dk.body) S.desks.set(scope, { ...dk, events: M.buildEvents(dk.body, S.live.body) });
  }
}

function histKey(e, c) { return e.sport ? `event:${e.sport}:${e.canonical_event_id}` : `series:${e.canonical_event_id}:${c.kalshi?.venue_market_id || c.polymarket?.venue_market_id || c.id}`; }
async function readHistory(e, c, force = false) {
  const key = histKey(e, c);
  const h = S.hist.get(key);
  if (!force && h && (h.loading || Date.now() - h.at < HIST_TTL)) return;
  S.hist.set(key, { ...(h || {}), loading: true });
  const url = e.sport ? `/api/event?sport=${encodeURIComponent(e.sport)}&event=${encodeURIComponent(e.canonical_event_id)}`
    : `/api/series?event=${encodeURIComponent(e.canonical_event_id)}&market=${encodeURIComponent(c.kalshi?.venue_market_id || c.polymarket?.venue_market_id || c.id)}&hours=24`;
  const r = await getJson(url, 'hist:' + key);
  if (r.status === -1) { S.hist.set(key, { ...(h || {}), loading: false }); return; }
  if (r.status === 401 || r.status === 403) return lostAccess(r.status);
  S.hist.set(key, { body: r.status === 200 ? r.body : h?.body || null, status: r.status, at: Date.now(), loading: false });
}

async function tick(force = false) {
  if (!S.member || (!force && document.hidden)) return;
  if (S.busy) { if (force) S.again = true; return; } // a forced read (scope change, retry) runs right after the current one
  S.busy = true;
  try {
    await readDesk(S.scope);
    paint();
    for (const sc of M.scopesFor([...S.watch, ...S.pins]).filter((s) => !M.covers(S.scope, s))) await readDesk(sc);
    await readLive();
    if (S.open) { const { e, c } = findContract(S.open); if (e && c) await readHistory(e, c); }
    if (S.view === 'pins') for (const k of S.pins) { const { e, c } = findContract(k); if (e && c) await readHistory(e, c); }
  } finally { S.busy = false; }
  paint();
  if (S.again) { S.again = false; return tick(true); }
}

// ------------------------------------------------------------------ alerts + health
function addAlerts(list) {
  S.alerts = M.pushAlerts(S.alerts, list.map((a) => ({ ...a, raised_at: new Date().toISOString(), fresh: true })));
  S.unread = Math.min(99, S.unread + list.length);
}
function updateHealth() {
  const d = S.desks.get(S.scope);
  S.health = M.feedHealth({ lastOkAt: S.lastOkAt || null, lastStatus: S.lastStatus, lanes: d?.body?.lanes || [], online: S.online });
  const st = S.health.state;
  if (st !== S.lastHealth) {
    const bad = (x) => x === 'STALLED' || x === 'OFFLINE';
    if (bad(st) && !bad(S.lastHealth) && S.lastHealth !== 'CONNECTING') addAlerts([M.feedAlert(S.lastHealth, st, new Date().toISOString())]);
    if (st === 'LIVE' && bad(S.lastHealth)) addAlerts([M.feedAlert(S.lastHealth, 'LIVE', new Date().toISOString())]);
    S.lastHealth = st;
  }
  const feed = $('#feed');
  feed.dataset.state = st; feed.querySelector('b').textContent = st;
  const lanes = d?.body?.lanes || [];
  const ok = lanes.filter((l) => l.state === 'ok').length;
  $('#feedText').textContent = S.member ? `${S.health.text}${lanes.length ? ` · ${ok}/${lanes.length} lanes ok` : ''}${S.live ? ` · scores ${ago(new Date(S.live.at).toISOString())}` : ''}` : $('#feedText').textContent;
  $('#feedAge').textContent = S.lastOkAt ? `desk read ${ago(new Date(S.lastOkAt).toISOString())} · ${SCOPE_LABEL[S.scope]}` : '';
}

// ------------------------------------------------------------------ rendering helpers
function avatar(e, c) {
  if (!e.sport) return '';
  const linked = e.join?.score?.score;
  const side = linked ? (c.role === 'away' || c.role === 'home' ? linked[c.role] : null) : null;
  const m = participantMedia(e.sport, c, side);
  if (m.kind === 'draw') return '<span class="av" aria-hidden="true">=</span>';
  return `<span class="av${m.kind === 'photo' ? ' photo' : ''}" aria-hidden="true" data-init="${esc(m.initials)}">${m.src ? `<img src="${esc(m.src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : esc(m.initials)}</span>`;
}
function quote(v, letter, rel = false) {
  const cls = letter.toLowerCase() + (rel ? ' rel' : '');
  if (!v || v.mid_bp == null) return `<span class="q ${cls} na" title="${letter === 'K' ? 'Kalshi' : 'Polymarket'}: no quote"><i>${letter}</i>—</span>`;
  return `<span class="q ${cls}${v.freshness === 'stale' ? ' stale' : ''}" title="${letter === 'K' ? 'Kalshi' : 'Polymarket'}${rel ? ' (related market, different rules, not compared)' : ''} mid ${fmtCents(v.mid_bp)} · bid ${fmtCents(v.bid_bp)} / ask ${fmtCents(v.ask_bp)} · observed ${utc(v.observed_at)} · ${esc(v.freshness)}"><i>${letter}</i>${fmtCents(v.mid_bp)}</span>`;
}
function track(c) {
  const dot = (v, cls, l) => (v?.mid_bp != null ? `<span class="d ${cls}" style="left:${(v.mid_bp / 100).toFixed(2)}%">${l}</span>` : '');
  const m = c.pbe ? `<span class="m" style="left:${(c.pbe.probability * 100).toFixed(2)}%" title="PBE model ${fmtPct(c.pbe.probability)}"></span>` : '';
  if (!c.kalshi?.mid_bp && !c.polymarket?.mid_bp && !m) return '<span class="track" aria-hidden="true"></span>';
  return `<span class="track" aria-hidden="true">${m}${dot(c.kalshi, 'k', 'K')}${dot(c.polymarket, 'p', 'P')}</span>`;
}
function moveText(mv) {
  if (!mv) return '';
  const d = mv.delta_bp;
  return `<span>Poly since first seen <b class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '+' : d < 0 ? '−' : '±'}${(Math.abs(d) / 100).toFixed(1)}¢</b></span>`;
}
function row(e, c) {
  const st = M.contractState(c);
  const watched = S.watch.has(c.key), pinned = S.pins.includes(c.key);
  const related = !c.polymarket && c.related.find((r) => r.venue === 'polymarket' && r.mid_bp != null);
  return `<li class="row${watched ? ' is-watch' : ''}">
    <div class="who-c">${avatar(e, c)}<div class="lbl"><b>${esc(c.label || 'Outcome')}</b><small class="tone-${st.tone}" title="${esc(st.label)}">${esc(st.short)}</small></div></div>
    <div class="px">${quote(c.kalshi, 'K')}${c.polymarket ? quote(c.polymarket, 'P') : quote(related || null, 'P', !!related)}${track(c)}
      <div class="meta">${c.gap_pts != null ? `<span>Verified gap <b class="gap">${c.gap_pts.toFixed(1)} pts</b></span>` : ''}${c.cross?.state === 'CROSS' ? `<span title="${esc(CROSS_TOOLTIP)}">Top-of-book cross <b class="gap">${(c.cross.bp / 100).toFixed(1)}¢</b></span>` : ''}${moveText(c.move)}${c.pbe ? `<span>PBE <b>${fmtPct(c.pbe.probability)}</b></span>` : ''}${related ? '<span class="tone-risk">Poly price shown, rules differ</span>' : ''}<span data-at="${esc(c.freshest_at || '')}">${c.freshest_at ? esc(ago(c.freshest_at)) : 'no observation'}</span></div>
    </div>
    <div class="acts">
      <button class="ib${watched ? ' on' : ''}" data-act="watch" data-key="${esc(c.key)}" aria-pressed="${watched}" aria-label="${watched ? 'Remove from' : 'Add to'} watchlist: ${esc(c.label)}" title="Watchlist">${watched ? '★' : '☆'}</button>
      <button class="ib${pinned ? ' on' : ''}" data-act="pin" data-key="${esc(c.key)}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin side by side'}: ${esc(c.label)}" title="Side by side">⧉</button>
      <button class="ib" data-act="open" data-key="${esc(c.key)}" aria-label="Inspect evidence: ${esc(c.label)}" title="Inspect evidence">⤢</button>
    </div></li>`;
}
function statusChip(e) {
  const s = M.statusOf(e);
  const score = e.join?.score;
  if (s === 'LIVE') return `<span class="st live">LIVE${score?.detail ? ' · ' + esc(score.detail) : ''}</span>`;
  if (s === 'FINAL') return '<span class="st final">FINAL</span>';
  if (s === 'SOON') return `<span class="st soon">STARTS IN ${Math.max(1, Math.round((Date.parse(e.start_at) - Date.now()) / 60e3))} MIN</span>`;
  if (s === 'OPEN') return e.start_at ? `<span class="st">CLOSES ${esc(local(e.start_at).toUpperCase())}</span>` : '<span class="st">OPEN</span>';
  return `<span class="st">${s === 'STARTED' ? 'STARTED' : 'UPCOMING'}</span>`;
}
function scoreLine(e) {
  const s = e.join?.score;
  if (!s?.score || !(s.status === 'live' || s.status === 'final')) return '';
  const a = s.score.away, h = s.score.home;
  return a && h && a.score != null && h.score != null ? `<span class="ev-score">${esc(a.abbr)} ${esc(a.score)} – ${esc(h.score)} ${esc(h.abbr)}</span>` : '';
}
function compareUrl(e) { return `https://compare.propbetedge.ai/?scope=${encodeURIComponent(e.sport || 'nonsports')}&event=${encodeURIComponent(e.canonical_event_id)}`; }
function eventCard(e, only = null) {
  const list = only ? e.contracts.filter((c) => only.has(c.key)) : e.contracts;
  const exp = S.expanded.has(e.key);
  const shown = exp ? list : list.slice(0, ROWS_COLLAPSED);
  const disclosure = e.contracts.map((c) => c.comparison?.disclosure).find(Boolean);
  return `<article class="ev${e.live ? ' is-live' : ''}" data-ev="${esc(e.key)}">
    <div class="ev-h"><span class="tag">${esc((e.sport || e.category || 'MARKET').toUpperCase())}</span>${statusChip(e)}<time datetime="${esc(e.start_at || '')}" title="${esc(utc(e.start_at))}">${esc(local(e.start_at))}</time></div>
    <div class="ev-t"><h3>${esc(e.title)}</h3>${scoreLine(e)}</div>
    ${e.field ? `<div class="ev-sub">${e.field.n} ${esc(e.field.noun)} · sorted by price</div>` : ''}
    <ul class="rows">${shown.map((c) => row(e, c)).join('')}</ul>
    ${list.length > ROWS_COLLAPSED ? `<button class="more" data-act="expand" data-ev="${esc(e.key)}" aria-expanded="${exp}">${exp ? 'Show fewer' : `Show all ${list.length} outcomes`}</button>` : ''}
    <div class="ev-f">${disclosure ? `<span class="tone-warn">${esc(disclosure)}</span>` : e.badge === 'RULE_MISMATCH' ? '<span class="tone-risk">Both venues list this market, but settlement rules differ: prices shown side by side, never compared</span>' : ''}
      <a href="${esc(compareUrl(e))}">COMPARE ↗</a>${safeUrl(e.destination) ? `<a href="${esc(safeUrl(e.destination))}">${e.sport ? 'PBECAST / EVENT' : 'PREDICTIONS'} ↗</a>` : ''}</div>
  </article>`;
}

function kpis(events) {
  const h = hubStats(events);
  const pairs = events.reduce((n, e) => n + e.contracts.filter((c) => c.comparison).length, 0);
  const modeled = events.reduce((n, e) => n + e.contracts.filter((c) => c.pbe).length, 0);
  const best = h.best ? h.best.contracts.find((c) => c.gap_pts === h.best.best_gap) : null;
  const k = (label, value, sub, cls = '') => `<div class="kpi ${cls}"><small>${label}</small><b>${value}</b><span>${sub}</span></div>`;
  return k('Live now', h.live, `${h.events} events on desk`, h.live ? 'is-live' : '')
    + k('Verified pairs', pairs, `${h.comparable} events · aligned quotes`)
    + k('Largest gap', h.best ? `${h.best.best_gap.toFixed(1)} pts` : '—', h.best ? esc(`${best?.label || ''} · ${h.best.title}`) : 'no verified gap now')
    + k('PBE modeled', modeled, modeled ? 'published same-contract models' : 'no published model in scope')
    + k('Watching', S.sync.ready || S.sync.pending ? S.watch.size : '…', `${S.pins.length}/${M.MAX_PINS} pinned · ${S.alerts.length} alerts`);
}

function laneNotes(d) {
  if (!d) return '<div class="note">Reading the market desk…</div>';
  if (!d.body) return `<div class="note risk">The market desk did not answer (${d.status || 'network'}). Nothing is shown rather than invented prices. <button class="btn ghost" data-act="retry">Retry now</button></div>`;
  const lanes = d.body.lanes || [];
  const bad = lanes.filter((l) => l.state === 'unavailable');
  const nc = lanes.filter((l) => l.state === 'not_connected');
  const capped = lanes.filter((l) => l.capped);
  const out = [];
  if (bad.length) out.push(`<div class="note warn">${bad.map((l) => esc(String(l.lane).toUpperCase())).join(', ')}: lane read failed${bad.some((l) => l.cached_at) ? '; last-known markets kept and labelled with their observation age' : ''}. Retrying every minute.</div>`);
  if (nc.length) out.push(`<div class="note">No cross-venue comparison lane yet for ${nc.map((l) => esc(String(l.lane).toUpperCase())).join(', ')}.</div>`);
  if (capped.length) out.push(`<div class="note">${capped.map((l) => esc(String(l.lane).toUpperCase())).join(', ')}: the desk returns at most 50 events per lane; this is not every listed market.</div>`);
  return out.join('');
}

function boardView() {
  const d = S.desks.get(S.scope);
  const events = M.sortEvents(M.filterEvents(d?.events || [], { q: S.q, filter: S.filter }), S.sort);
  const body = events.length ? `<div class="board">${events.map((e) => eventCard(e)).join('')}</div>`
    : d?.body ? `<div class="empty"><b>No markets match</b>${S.q || S.filter !== 'all' ? 'Clear the search or filter to see every market on this desk.' : `The ${esc(SCOPE_LABEL[S.scope])} desk answered with no open markets right now.`}</div>` : '';
  return laneNotes(d) + body;
}
function watchView() {
  if (!S.sync.ready && !S.watch.size) return syncEmpty('watchlist');
  if (!S.watch.size) return '<div class="empty"><b>Your watchlist is empty</b>Tap ☆ on any outcome. Watched outcomes raise in-app alerts on real moves, model changes and start times.</div>';
  const all = allEvents();
  const groups = new Map();
  const missing = [];
  for (const k of S.watch) { const e = all.get(M.eventKeyOf(k)); if (e && e.contracts.some((c) => c.key === k)) groups.set(e.key, e); else missing.push(k); }
  const evs = M.sortEvents([...groups.values()], S.sort);
  return `${evs.length ? `<div class="board">${evs.map((e) => eventCard(e, S.watch)).join('')}</div>` : ''}
    ${missing.length ? `<div class="note" style="margin-top:12px">${missing.length} watched outcome${missing.length > 1 ? 's are' : ' is'} not on the latest desk read (market closed, settled or lane delayed). <button class="btn ghost" data-act="prune">Remove them</button></div>` : ''}`;
}
function pinsView() {
  if (!S.sync.ready && !S.pins.length) return syncEmpty('pinned outcomes');
  if (!S.pins.length) return '<div class="empty"><b>Nothing pinned yet</b>Tap ⧉ on up to four outcomes, from any sport or prediction market, to follow them side by side with their stored price history.</div>';
  return `<div class="pins">${S.pins.map((k) => {
    const { e, c } = findContract(k);
    if (!e || !c) return `<div class="pin"><div class="pin-top"><h3>Not on the latest desk read</h3><div class="acts"><button class="ib on" data-act="pin" data-key="${esc(k)}" aria-label="Unpin">⧉</button></div></div><p class="tone-dim">${esc(k.split('|')[0])} · the market may have closed or its lane is delayed.</p></div>`;
    const st = M.contractState(c), md = M.modelState(c);
    return `<div class="pin"><div class="pin-top"><div><span class="tag">${esc((e.sport || e.category || 'MARKET').toUpperCase())}</span> ${statusChip(e)}<h3>${esc(c.label)} <span class="tone-dim">· ${esc(e.title)}</span></h3></div>
      <div class="acts"><button class="ib" data-act="open" data-key="${esc(k)}" aria-label="Inspect ${esc(c.label)}">⤢</button><button class="ib on" data-act="pin" data-key="${esc(k)}" aria-label="Unpin ${esc(c.label)}">⧉</button></div></div>
      <div class="big"><div><small>KALSHI</small><b>${fmtCents(c.kalshi?.mid_bp ?? null)}</b><span class="tone-dim" data-at="${esc(c.kalshi?.observed_at || '')}">${c.kalshi ? esc(ago(c.kalshi.observed_at)) : 'not listed'}</span></div><div><small>POLYMARKET</small><b>${fmtCents(c.polymarket?.mid_bp ?? null)}</b><span class="tone-dim" data-at="${esc(c.polymarket?.observed_at || '')}">${c.polymarket ? esc(ago(c.polymarket.observed_at)) : 'not comparable / not listed'}</span></div></div>
      <div class="meta"><span class="tone-${st.tone}">${esc(st.label)}</span>${c.gap_pts != null ? `<span>Gap <b class="gap">${c.gap_pts.toFixed(1)} pts</b></span>` : ''}<span>${esc(md.label)}</span></div>
      ${chart(e, c, 150)}</div>`;
  }).join('')}</div>`;
}
function alertsView() {
  const list = S.alerts.length ? `<div class="alerts">${S.alerts.map((a) => `<div class="al${a.fresh ? ' new' : ''}"><span class="al-t ${esc(a.type)}">${esc(a.type)}</span><p>${esc(a.text)}${a.title && a.type !== 'STALE' && a.type !== 'RECOVERED' ? `<small>${esc(a.title)}</small>` : ''}</p><time title="Observation time (UTC); raised ${esc(utc(a.raised_at))}">${esc(utc(a.at || a.raised_at))}</time>${a.key ? `<button class="ib" data-act="open" data-key="${esc(a.key)}" aria-label="Inspect">⤢</button>` : ''}</div>`).join('')}</div>`
    : '<div class="empty"><b>No alerts this session</b>Alerts appear here as the desk is re-read each minute while Terminal is open.</div>';
  return `${list}<ul class="rules-help">
    <li><b>Move</b>: a watched outcome's venue price changed by ≥ ${(M.MOVE_ALERT_BP / 100).toFixed(1)}¢ between two distinct venue observations (both timestamps shown).</li>
    <li><b>Matched</b>: an outcome became comparable on both venues since the previous read.</li>
    <li><b>Closing</b>: a watched event starts or closes within ${M.CLOSING_MS / 60e3} minutes.</li>
    <li><b>Model</b>: a PBE model was published for a watched outcome, or the market moved ≥ ${M.PBE_ALERT_PTS} pts against it.</li>
    <li><b>Stale / Recovered</b>: the market desk stopped or resumed answering.</li>
    <li>In-app only, for this browser session. Email and push alerts are not enabled.</li></ul>`;
}

// ------------------------------------------------------------------ chart (stored observations, step lines)
function chart(e, c, height = 220) {
  const h = S.hist.get(histKey(e, c));
  if (!h || (h.loading && !h.body)) return `<div class="chart"><div class="chart-empty">Loading stored price history…</div></div>`;
  if (!h.body) return `<div class="chart"><div class="chart-empty">${h.status === 404 ? 'No stored price history for this market yet.' : `Price history unavailable (${esc(h.status || 'network')}). Current quotes above are unaffected.`}</div></div>`;
  const hist = M.historyFor(h.body, c.id);
  const now = Date.now();
  const dom = M.chartDomain(hist, now, [c.pbe ? c.pbe.probability * 10000 : null]);
  if (!dom) return `<div class="chart"><div class="chart-empty">No stored observations for this outcome in the window.</div></div>`;
  const W = 600, H = height, L = 34, B = 18, w = W - L - 26, hh = H - B - 8;
  const g = { ...dom, w, h: hh };
  const ticks = [dom.v0, (dom.v0 + dom.v1) / 2, dom.v1].map((v) => ({ v, y: hh - ((v - dom.v0) / (dom.v1 - dom.v0)) * hh }));
  const lines = ['kalshi', 'polymarket'].map((venue) => hist[venue].map((seg, i, all) => `<path class="ln ${venue[0]}" d="${M.stepPath(seg, { ...g, until: i === all.length - 1 ? now : null })}"/>`).join('')).join('');
  const endLabel = (venue, letter) => { const seg = hist[venue].at(-1); if (!seg) return ''; const v = seg.at(-1).v; const y = hh - ((v - dom.v0) / (dom.v1 - dom.v0)) * hh; return `<text class="end" x="${w + 4}" y="${(y + 3.5).toFixed(1)}" fill="var(--${letter.toLowerCase()}-ink)">${letter}</text>`; };
  const pbeY = c.pbe ? hh - ((c.pbe.probability * 10000 - dom.v0) / (dom.v1 - dom.v0)) * hh : null;
  const span = dom.t1 - dom.t0;
  const tlabel = (t) => (span > 36 * 3600e3 ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) + ' UTC' : new Date(t).toISOString().slice(11, 16) + 'Z');
  const n = hist.kalshi.flat().length + hist.polymarket.flat().length;
  return `<div class="chart" data-chart="${esc(c.key)}" data-t0="${dom.t0}" data-t1="${dom.t1}">
    <div class="legend">${hist.kalshi.length ? '<span class="k"><i></i>Kalshi (K)</span>' : ''}${hist.polymarket.length ? '<span class="p"><i></i>Polymarket (P)</span>' : ''}${c.pbe ? '<span class="m"><i></i>PBE model</span>' : ''}${!hist.kalshi.length && c.kalshi ? '<span class="tone-dim">Kalshi: no stored history for this market</span>' : ''}${!hist.polymarket.length && c.polymarket ? '<span class="tone-dim">Polymarket: no stored history for this market</span>' : ''}<span class="tone-dim">${n} stored observations · a value holds until the next stored row</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Stored price history for ${esc(c.label)}, ${n} observations">
      <g transform="translate(${L},6)">
        ${ticks.map((t) => `<line class="grid" x1="0" x2="${w}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}"/><text class="axis" x="-6" y="${(t.y + 3.5).toFixed(1)}" text-anchor="end">${(t.v / 100).toFixed(0)}¢</text>`).join('')}
        <text class="axis" x="0" y="${hh + 14}">${tlabel(dom.t0)}</text><text class="axis" x="${w}" y="${hh + 14}" text-anchor="end">${tlabel(dom.t1)}</text>
        ${pbeY != null ? `<line class="pbe" x1="0" x2="${w}" y1="${pbeY.toFixed(1)}" y2="${pbeY.toFixed(1)}"/>` : ''}
        ${lines}${endLabel('kalshi', 'K')}${endLabel('polymarket', 'P')}
        <line class="x" x1="0" x2="0" y1="0" y2="${hh}" visibility="hidden"/>
        <rect x="0" y="0" width="${w}" height="${hh}" fill="transparent" data-hover="1"/>
      </g></svg></div>`;
}
// crosshair + tooltip: value at t = last stored value at or before t (step), per venue
function onChartMove(ev) {
  const rect = ev.target.closest('rect[data-hover]');
  const box = ev.target.closest('.chart');
  if (!rect || !box) return;
  const { e, c } = findContract(box.dataset.chart);
  if (!e || !c) return;
  const hb = S.hist.get(histKey(e, c))?.body;
  const hist = M.historyFor(hb, c.id);
  const r = rect.getBoundingClientRect();
  const x = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1);
  const t = Number(box.dataset.t0) + x * (Number(box.dataset.t1) - Number(box.dataset.t0));
  const at = (segs) => { let best = null; for (const s of segs) for (const p of s) if (p.t <= t && (!best || p.t > best.t)) best = p; return best; };
  const k = at(hist.kalshi), p = at(hist.polymarket);
  const line = box.querySelector('line.x');
  const vbW = Number(rect.getAttribute('width'));
  line.setAttribute('x1', (x * vbW).toFixed(1)); line.setAttribute('x2', (x * vbW).toFixed(1)); line.setAttribute('visibility', 'visible');
  let tip = box.querySelector('.tip');
  if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; box.appendChild(tip); }
  tip.innerHTML = `<div>${esc(new Date(t).toISOString().replace('T', ' ').slice(0, 16))}Z</div>${k ? `<div>K <b>${fmtCents(k.v)}</b> <small>since ${hhmm(new Date(k.t).toISOString())}</small></div>` : ''}${p ? `<div>P <b>${fmtCents(p.v)}</b> <small>since ${hhmm(new Date(p.t).toISOString())}</small></div>` : ''}${!k && !p ? '<div>No stored observation yet</div>' : ''}`;
  const bx = box.getBoundingClientRect();
  const left = ev.clientX - bx.left;
  tip.style.left = Math.min(Math.max(8, left + 12), bx.width - 170) + 'px';
  tip.style.top = (box.querySelector('svg').offsetTop + 4) + 'px';
}
function onChartLeave(ev) {
  const box = ev.target.closest?.('.chart');
  if (!box) return;
  box.querySelector('.tip')?.remove();
  box.querySelector('line.x')?.setAttribute('visibility', 'hidden');
}

// ------------------------------------------------------------------ inspector
function inspector() {
  const { e, c } = findContract(S.open);
  if (!e || !c) return `<div class="d-h"><h2 id="dTitle">Market not on the latest read</h2><p>This outcome is not on the latest desk read. It may have closed, settled, or its lane is delayed.</p></div>`;
  const st = M.contractState(c), md = M.modelState(c);
  const rt = ruleTermsView(c.rule_terms);
  const kd = keyDifferences(c.rule_terms);
  const venues = [['Kalshi', c.kalshi], ['Polymarket', c.polymarket], ...c.related.filter((r) => r.venue && r.mid_bp != null).map((r) => [`${r.venue === 'polymarket' ? 'Polymarket' : 'Kalshi'} (related, not compared)`, r])];
  const mv = { kalshi: moves((M.historyFor(S.hist.get(histKey(e, c))?.body, c.id).kalshi.flat()).map((p) => ({ t: new Date(p.t).toISOString(), v: p.v }))), polymarket: moves((M.historyFor(S.hist.get(histKey(e, c))?.body, c.id).polymarket.flat()).map((p) => ({ t: new Date(p.t).toISOString(), v: p.v }))) };
  const watched = S.watch.has(c.key), pinned = S.pins.includes(c.key);
  return `<div class="d-h"><span class="tag">${esc((e.sport || e.category || 'MARKET').toUpperCase())}</span> ${statusChip(e)}
      <h2 id="dTitle">${esc(c.label)} <span class="tone-dim">· ${esc(e.title)}</span></h2>
      <p>${e.sport ? 'Starts' : 'Closes'} ${esc(utc(e.start_at))} (${esc(local(e.start_at))} local)${scoreLine(e) ? ' · ' + scoreLine(e) : ''}</p></div>
    <div class="d-chips"><span class="pill tone-${st.tone}" title="${esc(c.comparison ? BADGES.COMPARABLE : BADGES[c.badge] || '')}">${esc(st.label.toUpperCase())}</span><span class="pill ${c.pbe ? '' : 'tone-dim'}">${esc(md.label.toUpperCase())}</span>${watched ? '<span class="pill tone-warn">WATCHING</span>' : ''}</div>
    <div class="d-links"><button data-act="watch" data-key="${esc(c.key)}" class="${watched ? 'on' : ''}" aria-pressed="${watched}">${watched ? '★ Watching' : '☆ Watch'}</button><button data-act="pin" data-key="${esc(c.key)}" class="${pinned ? 'on' : ''}" aria-pressed="${pinned}">⧉ ${pinned ? 'Pinned' : 'Pin side by side'}</button><a href="${esc(compareUrl(e))}">Open in Compare ↗</a>${safeUrl(e.destination) ? `<a href="${esc(safeUrl(e.destination))}">${e.sport ? 'PBEcast / event' : 'Predictions'} ↗</a>` : ''}</div>

    <div class="d-sec"><h4>Stored price history</h4>${chart(e, c, 230)}</div>
    <div class="d-sec"><h4>Observed moves (stored rows)</h4><div class="moves">${WINDOWS.map((w) => `<div><small>${w.key}</small><b title="Kalshi">K ${esc(mv.kalshi[w.key] ? fmtMove(mv.kalshi[w.key]) : '—')}</b><b title="Polymarket">P ${esc(mv.polymarket[w.key] ? fmtMove(mv.polymarket[w.key]) : '—')}</b></div>`).join('')}</div>${c.move ? `<p class="tone-dim" style="font-size:12px;margin:8px 0 0">Polymarket since first observed ${esc(utc(c.move.first_observed_at))}: ${fmtCents(c.move.first_mid_bp)} → ${fmtCents(c.polymarket?.mid_bp ?? null)}.</p>` : ''}</div>

    <div class="d-sec"><h4>Quotes</h4><div class="qt-wrap"><table class="qt"><thead><tr><th>Venue</th><th>Bid</th><th>Ask</th><th>Mid</th><th>Spread</th><th>Observed (UTC)</th><th>State</th></tr></thead><tbody>
      ${venues.map(([name, v]) => v ? `<tr><td>${esc(name)}${safeUrl(v.market_url) ? ` <a href="${esc(safeUrl(v.market_url))}" rel="noopener noreferrer" target="_blank" aria-label="${esc(name)} market page">↗</a>` : ''}</td><td>${fmtCents(v.bid_bp)}</td><td>${fmtCents(v.ask_bp)}</td><td>${fmtCents(v.mid_bp)}</td><td>${fmtCents(v.spread_bp)}</td><td>${esc(hhmm(v.observed_at))}<br><small class="tone-dim" data-at="${esc(v.observed_at || '')}">${esc(ago(v.observed_at))}</small></td><td>${esc(v.freshness || '—')}</td></tr>` : `<tr><td>${esc(name)}</td><td colspan="6" class="tone-dim">Not listed / not matched to this outcome</td></tr>`).join('')}
    </tbody></table></div>
    ${c.comparison ? `<p class="tone-dim" style="font-size:12px">Gap ${c.gap_pts != null ? `<b class="gap">${c.gap_pts.toFixed(1)} pts</b>` : '—'} · quotes aligned within ${esc(c.comparison.aligned_within_s)} s (tolerance ${esc(c.comparison.tolerance_s)} s) · ${esc(c.comparison.match_class)}${c.cross ? ` · top-of-book ${c.cross.state === 'CROSS' ? `cross ${(c.cross.bp / 100).toFixed(1)}¢` : 'no cross'} (${esc(CROSS_TOOLTIP)})` : ''}</p>` : `<p class="tone-dim" style="font-size:12px">${esc(BADGES[c.note === 'NOT_ALIGNED' ? 'NOT_ALIGNED' : c.badge] || '')}</p>`}</div>

    <div class="d-sec"><h4>Settlement rules</h4>${c.comparison?.disclosure ? `<div class="note warn">${esc(c.comparison.disclosure)}</div>` : ''}${kd.map((x) => `<div class="note warn">${esc(x)}</div>`).join('')}
      ${rt ? `<div class="rules">${['kalshi', 'polymarket'].map((v) => `<div><h5 style="color:var(--${v[0]}-ink)">${v === 'kalshi' ? 'KALSHI' : 'POLYMARKET'}</h5><ul>${rt[v].lines.map((l) => `<li class="${l.differs ? 'diff' : ''}">${esc(l.text)}${l.differs ? ' · differs' : ''}</li>`).join('') || '<li>No parsed clauses</li>'}${rt[v].unknown ? '<li class="tone-dim">Some terms not confidently parsed</li>' : ''}</ul></div>`).join('')}</div>` : '<p class="tone-dim" style="font-size:12.5px">No parsed rule terms for this pair. Compare compares only contracts whose rules were approved as comparable.</p>'}</div>

    <div class="d-sec"><h4>PBE model</h4>${c.pbe ? `<dl class="kv"><dt>Probability</dt><dd>${fmtPct(c.pbe.probability)}</dd><dt>State</dt><dd>${esc(c.pbe.state || '—')}</dd><dt>Issued</dt><dd>${esc(utc(c.pbe.issued_at))}</dd><dt>Model</dt><dd>${esc(c.pbe.model || '—')}</dd>${c.pbe_vs_venues ? `<dt>Market vs model</dt><dd>${c.pbe_vs_venues.map((x) => (x > 0 ? '+' : '') + Number(x).toFixed(1)).join(' / ')} pts</dd>` : ''}</dl>` : '<p class="tone-dim" style="font-size:12.5px">Model not available: no validated, published same-contract PBE model for this outcome. Terminal never estimates one.</p>'}</div>

    <div class="d-sec"><h4>Market mapping</h4><dl class="kv"><dt>Contract</dt><dd>${esc(c.id)}</dd><dt>Event</dt><dd>${esc(e.canonical_event_id)}</dd>${c.kalshi?.venue_market_id ? `<dt>Kalshi market</dt><dd>${esc(c.kalshi.venue_market_id)}</dd>` : ''}${c.polymarket?.venue_market_id ? `<dt>Polymarket market</dt><dd>${esc(c.polymarket.venue_market_id)}</dd>` : ''}<dt>Score link</dt><dd>${esc(e.join?.state || '—')}</dd></dl></div>`;
}

let lastFocus = null;
function openDrawer(key) {
  S.open = key; lastFocus = document.activeElement;
  const { e, c } = findContract(key);
  $('#drawer').hidden = false; document.documentElement.classList.add('locked');
  syncUrl(); paintDrawer();
  $('#drawer .close').focus();
  if (e && c) readHistory(e, c).then(paintDrawer);
}
function closeDrawer() {
  if ($('#drawer').hidden) return;
  S.open = null; $('#drawer').hidden = true; document.documentElement.classList.remove('locked');
  syncUrl(); lastFocus?.focus?.();
}
function paintDrawer() { if (S.open && !$('#drawer').hidden) { const html = inspector(); const b = $('#dBody'); if (b.dataset.html !== html) { b.innerHTML = html; b.dataset.html = html; } } }

// ------------------------------------------------------------------ sync status
function syncEmpty(what) {
  return S.sync.phase === 'loading'
    ? `<div class="empty"><b>Loading your saved markets…</b>Your ${what} follow your All Access account across devices.</div>`
    : `<div class="empty"><b>Saved markets unavailable right now</b>Your ${what} are stored with your account and will appear when sync reconnects. <button class="btn ghost" data-act="sync-retry">Retry</button></div>`;
}
function syncText() {
  const st = S.sync;
  const when = st.updated_at ? ` · ${hhmm(st.updated_at)}` : '';
  if (st.phase === 'loading') return ['busy', 'Loading workspace…'];
  if (st.phase === 'saving') return ['busy', 'Saving…'];
  if (st.phase === 'synced') return ['ok', st.revision ? `Synced · rev ${st.revision}${when}` : 'Synced · nothing saved yet'];
  if (st.phase === 'pending') return ['warn', `Saved on this device · sync pending (${st.pending})`];
  if (st.phase === 'unavailable') return ['warn', 'Sync unavailable · retrying'];
  return ['', ''];
}
function paintSync() {
  const el = $('#sync');
  if (!el) return;
  const [tone, text] = syncText();
  el.hidden = !text;
  el.dataset.tone = tone;
  const retry = S.sync.phase === 'pending' || S.sync.phase === 'unavailable';
  const html = `<i aria-hidden="true"></i><span>${esc(text)}</span>${retry ? '<button class="sync-retry" data-act="sync-retry">Retry</button>' : ''}${S.sync.migrated && S.sync.phase === 'synced' && !S.migratedShown ? `<em>Added ${S.sync.migrated} saved market${S.sync.migrated > 1 ? 's' : ''} from this device</em>` : ''}`;
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  if (S.sync.migrated && S.sync.phase === 'synced' && !S.migratedShown && !S.migratedTimer) S.migratedTimer = setTimeout(() => { S.migratedShown = true; paintSync(); }, 20e3);
  el.title = S.sync.lastSyncAt ? `Workspace saved to your All Access account. Last confirmed ${new Date(S.sync.lastSyncAt).toISOString().slice(11, 19)}Z.` : 'Workspace saved to your All Access account.';
}

// ------------------------------------------------------------------ paint
function paint() {
  updateHealth();
  if (!S.member) return;
  const loaded = S.sync.ready || S.sync.pending > 0;
  $('#nWatch').textContent = loaded ? S.watch.size : '…';
  $('#nPins').textContent = loaded ? `${S.pins.length}/${M.MAX_PINS}` : '…';
  paintSync();
  const na = $('#nAlerts'); na.textContent = S.unread; na.classList.toggle('has', S.unread > 0);
  const d = S.desks.get(S.scope);
  const events = d?.events || [];
  const kp = kpis(events); if ($('#kpis').dataset.html !== kp) { $('#kpis').innerHTML = kp; $('#kpis').dataset.html = kp; }
  const chips = Object.entries(M.FILTERS).map(([k, f]) => `<button class="chip" data-filter="${k}" aria-pressed="${S.filter === k}">${esc(f.label)}<span class="n">${events.filter(f.test).length}</span></button>`).join('');
  if ($('#chips').dataset.html !== chips) { $('#chips').innerHTML = chips; $('#chips').dataset.html = chips; }
  $('#chips').hidden = S.view !== 'board';
  document.querySelectorAll('[role=tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === S.view)));
  $('#view').setAttribute('aria-labelledby', 'tab-' + S.view);
  const html = S.view === 'watch' ? watchView() : S.view === 'pins' ? pinsView() : S.view === 'alerts' ? alertsView() : boardView();
  if (html !== S.lastHtml) {
    const f = document.activeElement?.closest?.('#view') ? { act: document.activeElement.dataset.act, key: document.activeElement.dataset.key || document.activeElement.dataset.ev } : null;
    $('#view').innerHTML = html; S.lastHtml = html;
    if (f?.act) $(`#view [data-act="${CSS.escape(f.act)}"][data-${f.act === 'expand' ? 'ev' : 'key'}="${CSS.escape(f.key || '')}"]`)?.focus();
  }
  paintDrawer();
}
function refreshAges() {
  document.querySelectorAll('[data-at]').forEach((el) => { const a = el.dataset.at; if (a) { const t = ago(a); if (el.textContent !== t) el.textContent = t; } });
  updateHealth();
}
function syncUrl() {
  const p = new URLSearchParams();
  if (S.scope !== 'sports') p.set('scope', S.scope);
  if (S.view !== 'board') p.set('view', S.view);
  if (S.open) p.set('c', S.open);
  const q = p.toString();
  history.replaceState(null, '', location.pathname + (q ? '?' + q : ''));
}

// ------------------------------------------------------------------ gate
function gate(state) {
  $('#app').hidden = true;
  const g = $('#gate'); g.hidden = false;
  const who = $('#who');
  const feed = $('#feed'); feed.dataset.state = state === 'unverified' ? 'STALLED' : 'CONNECTING'; feed.querySelector('b').textContent = state === 'unverified' ? 'ACCESS CHECK' : 'LOCKED';
  if (state === 'unverified') {
    who.textContent = 'ACCESS CHECK';
    $('#feedText').textContent = 'Membership service unavailable · retrying in 30 s';
    g.innerHTML = `<p class="eyebrow">ALL ACCESS</p><h1>We couldn't verify your membership.</h1><p>The membership service did not answer. This is not a change to your subscription. No market data is shown until access is verified.</p><button class="btn" data-act="recheck">Try again</button>`;
    setTimeout(() => boot(), 30e3);
    return;
  }
  who.textContent = state === 'forbidden' ? 'SIGNED IN · NO ALL ACCESS' : 'SIGN IN';
  $('#feedText').textContent = state === 'forbidden' ? 'Signed in · All Access required' : 'Member sign-in required';
  g.innerHTML = `<p class="eyebrow">PROPBETEDGE ALL ACCESS</p><h1>${state === 'forbidden' ? 'Terminal is part of All Access.' : 'Sign in to open the Terminal.'}</h1>
    <p>The Terminal is the All Access research workspace across Kalshi and Polymarket:</p>
    <ul><li>Live board of comparable contracts, scores and verified gaps</li><li>Evidence for every pair: settlement rules, quote times, stored price history</li><li>Watchlist, side-by-side pins and in-app alerts on real moves</li><li>PBE model probabilities where a published same-contract model exists</li></ul>
    <p>${state === 'forbidden' ? 'Your account does not currently include All Access.' : 'Sign in once at the Command Center; your session carries across PropBetEdge.'}</p>
    <a class="btn" href="${state === 'forbidden' ? 'https://propbetedge.ai/pro' : 'https://members.propbetedge.ai/'}">${state === 'forbidden' ? 'See All Access' : 'Member sign in'} ↗</a>`;
}
function lostAccess(status) {
  sync.reset();
  S.member = null; S.desks.clear(); S.hist.clear(); S.live = null; S.snap.clear();
  closeDrawer(); gate(status === 401 ? 'anonymous' : 'forbidden');
}

// ------------------------------------------------------------------ events
function toggleWatch(key) { if (!S.watch.has(key) && S.watch.size >= M.MAX_WATCH) return; sync.watch(key, !S.watch.has(key)); }
function togglePin(key) {
  const on = !S.pins.includes(key);
  sync.pin(key, on);
  if (on) { const { e, c } = findContract(key); if (e && c) readHistory(e, c).then(paint); }
}
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-act],[data-view],[data-filter],[data-close]');
  if (!t) return;
  if (t.dataset.close !== undefined) return closeDrawer();
  if (t.dataset.view) { S.view = t.dataset.view; if (S.view === 'alerts') { S.unread = 0; } else S.alerts.forEach((a) => { a.fresh = false; }); syncUrl(); paint(); if (S.view === 'pins') tick(true); return; }
  if (t.dataset.filter) { S.filter = t.dataset.filter; paint(); return; }
  const a = t.dataset.act, key = t.dataset.key;
  if (a === 'watch') toggleWatch(key);
  else if (a === 'pin') togglePin(key);
  else if (a === 'open') openDrawer(key);
  else if (a === 'expand') { S.expanded.has(t.dataset.ev) ? S.expanded.delete(t.dataset.ev) : S.expanded.add(t.dataset.ev); paint(); }
  else if (a === 'retry') tick(true);
  else if (a === 'recheck') boot();
  else if (a === 'prune') { for (const k of [...S.watch]) if (!findContract(k).c) sync.watch(k, false); }
  else if (a === 'sync-retry') sync.retryNow();
});
document.addEventListener('pointermove', (ev) => { if (ev.target.closest?.('rect[data-hover]')) onChartMove(ev); }, { passive: true });
document.addEventListener('pointerout', (ev) => { if (ev.target.closest?.('rect[data-hover]')) onChartLeave(ev); }, { passive: true });
document.addEventListener('pointerdown', (ev) => { if (ev.target.closest?.('rect[data-hover]')) onChartMove(ev); }, { passive: true });
document.addEventListener('error', (ev) => {
  const img = ev.target;
  if (img?.tagName !== 'IMG') return;
  if (img.closest('.av')) { const av = img.closest('.av'); av.textContent = av.dataset.init || ''; } else if (img.closest('.brand')) img.remove();
}, true);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') return closeDrawer();
  if (ev.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) { ev.preventDefault(); $('#q')?.focus(); }
  if (ev.key === 'Tab' && !$('#drawer').hidden) {
    const f = [...$('#drawer').querySelectorAll('button,a[href],[tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    if (ev.shiftKey && document.activeElement === f[0]) { ev.preventDefault(); f.at(-1).focus(); }
    else if (!ev.shiftKey && document.activeElement === f.at(-1)) { ev.preventDefault(); f[0].focus(); }
  }
});
$('#scope').addEventListener('change', (ev) => { S.scope = ev.target.value; store.set('pbe_terminal_scope', S.scope); S.lastOkAt = S.desks.get(S.scope)?.at || 0; S.lastStatus = null; syncUrl(); paint(); tick(true); });
$('#sort').addEventListener('change', (ev) => { S.sort = ev.target.value; paint(); });
let qT = 0;
$('#q').addEventListener('input', (ev) => { clearTimeout(qT); qT = setTimeout(() => { S.q = ev.target.value; paint(); }, 120); });
$('#refresh').addEventListener('click', () => tick(true));
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !S.member) return;
  if (Date.now() - S.lastOkAt > POLL_MS) tick(true);
  sync.refreshIfStale(30e3);
});
addEventListener('online', () => { S.online = true; paint(); tick(true); sync.retryNow(); });
addEventListener('offline', () => { S.online = false; paint(); });

// ------------------------------------------------------------------ boot
setInterval(() => { $('#clock').textContent = new Date().toISOString().slice(11, 19) + ' UTC'; }, 1000);
setInterval(() => { if (S.member) refreshAges(); }, 10e3);
setInterval(() => tick(), POLL_MS);
async function boot() {
  const st = await checkMembership();
  if (st !== 'entitled') return gate(st);
  $('#gate').hidden = true; $('#app').hidden = false;
  $('#who').textContent = S.member.role === 'owner' ? '◆ VERIFIED OWNER' : '◆ ALL ACCESS';
  $('#scope').value = S.scope;
  paint();
  const ws = sync.load().then(() => { paint(); if (M.scopesFor([...S.watch, ...S.pins]).some((sc) => !M.covers(S.scope, sc) && !S.desks.get(sc))) tick(true); });
  await tick(true);
  await ws;
  if (S.open) openDrawer(S.open);
}
boot();
