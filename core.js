// VENDORED from LHBUSA/predictions compare/core.js @ aac8ebb (2026-10-09). Compare owns this logic (contract badges,
// rule terms, ID-only score join, stored-point movement). Do not fork it here: re-vendor when Compare changes.
// Local edit: the kalshi-partner re-export (line 3 upstream) is removed; Terminal shows no partner offers.
// Compare core: pure functions shared by the browser (app.js) and node tests. No DOM, no fetch.
// Every number keeps its source timestamp; nothing is interpolated; absence is labelled, never zero.

export const SPORTS = [
  { key: 'nfl', label: 'NFL' }, { key: 'nba', label: 'NBA' }, { key: 'nhl', label: 'NHL' }, { key: 'mlb', label: 'MLB' },
  { key: 'wnba', label: 'WNBA' }, { key: 'soccer', label: 'Soccer' }, { key: 'tennis', label: 'Tennis' }, { key: 'ufc', label: 'UFC' },
  { key: 'golf', label: 'Golf' }, { key: 'f1', label: 'F1' }
];
export const SPORT_KEYS = SPORTS.map((s) => s.key);

// Score <-> market joins are ID-ONLY. These sports' market canonical_event_id is the same provider id the
// score feed publishes (ESPN event id for NFL/NBA, MLB gamePk, NHL gamePk), proven 2026-10-05.
// Soccer (2026-10-05): market canonical_event_id and the score feed's source_id are both the soccer-api match UUID.
// Tennis (2026-10-06): the market registry and tennis live feed both use our canonical match UUID; exact-id proof
// captured on live Muchova v Osaka. UFC remains UNMATCHED because the desk lists bouts while its live feed lists cards.
// Proven deterministic id joins (score feed id == market-desk canonical_event_id). WNBA: ESPN game id on both sides
// (2026-10-07, NY @ ATL 401918297). Golf: the score row's market_id = Golf edition UUID, which is the desk's
// canonical_event_id for the outright field (the Members _market-strip rule slug -> edition UUID); never by title.
export const ID_JOIN_SPORTS = new Set(['nfl', 'nba', 'wnba', 'mlb', 'nhl', 'soccer', 'tennis', 'golf']);
// The id a live score row joins the market desk on: market_id when the feed names one (golf), else source_id.
export const scoreMarketId = (x) => String(x?.market_id ?? x?.source_id ?? '');
export const scoreKey = (x) => `${x?.sport}:${scoreMarketId(x)}`;

export const BADGES = {
  COMPARABLE: 'Both venues list this outcome and their settlement rules were approved as comparable. The gap is a real price difference on the same question.',
  EXACT: 'Both venues settle this contract under identical rules (rule hashes re-checked at read time).',
  RULE_MISMATCH: 'Both venues list a market on this game, but their settlement rules differ, so the prices are shown side by side and never compared.',
  WITHDRAWN: 'The comparison was withdrawn because the game is no longer scheduled normally (final, postponed or start moved). Prices are not compared.',
  SINGLE_VENUE: 'Only one venue lists this contract right now. There is nothing to compare against.',
  UNMATCHED: 'No deterministic link between this market and a score-feed event, so no score is attached. We never guess by team name.',
  NOT_ALIGNED: 'Both venues are quoted, but the observations are stale or more than 120 seconds apart, so no spread is computed.'
};

export const REASON_TEXT = {
  exceptions_differs: 'Postponement / cancellation / tie settlement rules differ between venues.',
  window_tz_differs: 'The measurement window or time zone differs.',
  resolution_source_differs: 'The venues resolve from different official sources.',
  measurement_unknown: 'One venue does not state how the value is measured.',
  rounding_unknown: 'One venue does not state its rounding rule.',
  venue_start_disagrees: 'The venues list different start times for this event.',
  canonical_state_not_scheduled: 'The game is no longer scheduled or in progress.'
};
export const reasonText = (code) => REASON_TEXT[String(code).split(':')[0]] || null;

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export const cents = (bp) => (bp == null ? null : bp / 100);
// Always one decimal so the ¢ and decimal points stack in every price column.
export const fmtCents = (bp) => (bp == null ? '—' : `${(bp / 100).toFixed(1)}¢`);
export const fmtPct = (p) => (p == null ? '—' : `${(p * 100).toFixed(Math.abs(p * 100 - Math.round(p * 100)) > 0.05 ? 1 : 0)}%`);

export function ageText(iso, now = Date.now()) {
  const ms = now - Date.parse(iso || '');
  if (!Number.isFinite(ms)) return null;
  if (ms < 0) return 'just now';
  if (ms < 60e3) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3600e3) return `${Math.round(ms / 60e3)}m ago`;
  if (ms < 86400e3) return `${Math.round(ms / 3600e3)}h ago`;
  return `${Math.round(ms / 86400e3)}d ago`;
}

// ---------------------------------------------------------------------------------------------------------
// Venue quote -> display price. YES = mid of the stored best bid/ask; NO = 100¢ − YES (binary contract).
export function venuePrice(v) {
  if (!v) return null;
  const mid = num(v.mid_bp);
  return {
    venue: v.venue, match: v.match || null, mid_bp: mid, yes_bp: mid, no_bp: mid == null ? null : 10000 - mid,
    bid_bp: num(v.bid_bp), ask_bp: num(v.ask_bp), spread_bp: num(v.spread_bp), observed_at: v.observed_at || null,
    freshness: String(v.freshness || 'unknown').toLowerCase(), market_url: v.market_url || null, disclosure: v.disclosure || null,
    venue_market_id: v.venue_market_id || null
  };
}

// TOP-OF-BOOK EXECUTABLE CROSS (owner spec 2026-10-05). Only for a pair the approved rule gate made COMPARABLE and
// whose quotes are aligned (the desk's comparison object); never for RULE_MISMATCH / single venue / stale.
//   cross = max(Kalshi bid − Polymarket ask, Polymarket bid − Kalshi ask), in bp of $1, YES side.
// Best displayed prices only: before fees, available size not measured. Not arbitrage, not EV, not net edge.
export const CROSS_TOOLTIP = "Best displayed bid versus the other venue's best displayed ask. Before fees. Available size not measured.";
export function topOfBookCross(k, p) {
  if (!k || !p || [k.bid_bp, k.ask_bp, p.bid_bp, p.ask_bp].some((x) => x == null)) return { state: 'NO_BOOK', bp: null };
  const a = k.bid_bp - p.ask_bp, b = p.bid_bp - k.ask_bp;
  const best = Math.max(a, b);
  const legs = a >= b ? { bid_venue: 'kalshi', bid_bp: k.bid_bp, ask_venue: 'polymarket', ask_bp: p.ask_bp } : { bid_venue: 'polymarket', bid_bp: p.bid_bp, ask_venue: 'kalshi', ask_bp: k.ask_bp };
  return best > 0 ? { state: 'CROSS', bp: best, ...legs } : { state: 'NO_CROSS', bp: best, ...legs };
}

// rule-terms/1 -> display lines. Only parsed facts; unknown vocabulary -> 'Not confidently parsed'.
const TOPIC_LABEL = { postponement: 'Postponed', cancellation: 'Cancelled', tie: 'Tie', walkover: 'Walkover', retirement: 'Retirement / default', no_result: 'No result', no_contest: 'No contest', not_scored: 'Not scored', data_source: 'Result source',
  // golf field winner (owner 2026-10-05)
  dead_heat: 'Dead heat', withdrawal: 'Withdraws', dns: 'Does not tee off', eliminated: 'Eliminated (e.g. missed cut)', disqualification: 'Disqualified', shortened: 'Shortened event', unlisted_winner: 'Unlisted golfer wins', source: 'Result source' };
const COND_LABEL = { postponed: '', starts_within_48h: 'starts within 48h', not_started_within_48h: 'not started within 48h', resumes_within_2w: 'resumes within 2 weeks', beyond_2w: 'beyond 2 weeks', no_makeup: 'no make-up game', cancelled_or_not_started_within_48h: 'or not started within 48h', cancelled_or_beyond_48h: 'or moved beyond 48h', not_played: 'not played', cancelled_or_beyond_2w: 'or moved beyond 2 weeks', draw: 'draw', or_cancelled_before_start: 'or cancelled before the start', no_winner_within_14d: 'no winner within 14 days', no_data_within_24h: 'no official data within 24h', fallback: 'official data unavailable', rescheduled_beyond_48h: 'rescheduled more than 48h away', rescheduled_beyond_2w: 'rescheduled more than 2 weeks away',
  tie_after_regulation: 'tied after regulation', tie_on_points: 'level on points', cancelled_or_beyond_7d: 'or moved more than 7 days', rescheduled_beyond_7d: 'rescheduled more than 7 days away', season_cancelled_or_incomplete_by_deadline: 'season cancelled or not completed by the venue deadline', season_incomplete_by_deadline: 'season not completed by the venue deadline', multiple_winners: 'co-winners declared', withdraws: '', withdraws_or_does_not_tee_off: '', eliminated_from_contention: '', dq_before_expiry: 'before settlement', truncated_with_official_result: 'official result declared', no_winner_by_deadline: 'no winner by the venue deadline', cancelled_no_official_result: 'no official result', unlisted_player_wins: '', primary: '' };
const TREAT_LABEL = { open_until_completed: { kalshi: 'remains open, official final result', polymarket: 'remains open until completed' }, split_50_50: { kalshi: '$0.50 each', polymarket: 'resolves 50-50' }, fair_price: 'resolves at a fair price', last_fair_price: 'resolves at the last fair price', advancing_player: 'advancing player wins', settles_as_draw: 'settles as a draw (team markets No, draw Yes)', split_50_50_or_draw: 'resolves 50-50, or Draw', consensus_allowed: 'credible-reporting consensus may be used',
  no: 'resolves No', official_winner_per_tour_rules: 'official winner under PGA TOUR rules (playoff)', alphabetical_last_name_wins: 'alphabetically first last name wins; other co-winners No', split_1_over_n: '$1 split equally across co-winners', other_bucket: '"Other": every listed participant resolves No', official_tiebreak: 'official F1 tiebreak (countback)', f1_official: 'Formula 1', open_up_to_2_weeks: 'stays open up to 2 weeks', last_traded_price_or_fair: 'last traded price or a fair allocation', reported_result_stands: 'reported result stands', pga_tour: 'PGA TOUR website', league_ap_espn_wsj_fox: 'tour, AP, ESPN, WSJ, Fox Sports' };
export const TERM_TOPICS = Object.keys(TOPIC_LABEL);
export function termLine(t, venue) {
  const topic = TOPIC_LABEL[t?.topic], tr = TREAT_LABEL[t?.treatment];
  const cond = t?.condition == null ? '' : COND_LABEL[t.condition];
  if (!topic || !tr || cond === undefined) return null;
  return `${topic}${cond ? ` (${cond})` : ''} → ${typeof tr === 'string' ? tr : tr[venue]}`;
}
// Per venue: lines for every term; for a topic only the OTHER venue states (and this venue parsed completely), say so.
export function ruleTermsView(rt) {
  if (!rt) return null;
  const out = {};
  for (const venue of ['kalshi', 'polymarket']) {
    const me = rt[venue] || { complete: false, terms: [] }, other = rt[venue === 'kalshi' ? 'polymarket' : 'kalshi'] || { terms: [] };
    const lines = [];
    let unknown = !me.complete;
    for (const topic of TERM_TOPICS) {
      const mine = (me.terms || []).filter((t) => t.topic === topic);
      for (const t of mine) { const l = termLine(t, venue); if (l) lines.push({ topic, text: l, differs: (rt.differs || []).includes(topic) }); else unknown = true; }
      if (!mine.length && me.complete && (other.terms || []).some((t) => t.topic === topic)) lines.push({ topic, text: `${TOPIC_LABEL[topic]} → no clause stated`, differs: true });
    }
    out[venue] = { lines, unknown };
  }
  out.differs = rt.differs || null;
  return out;
}
// Soccer's material settlement difference, stated plainly (owner 2026-10-05): only from parsed terms, never inferred.
export function keyDifferences(rt) {
  if (!rt) return [];
  const t = (venue, topic) => (rt[venue]?.terms || []).filter((x) => x.topic === topic);
  const out = [];
  const pc = t('polymarket', 'cancellation'), kc = t('kalshi', 'cancellation');
  if (pc.some((x) => x.treatment === 'settles_as_draw') && kc.some((x) => x.treatment === 'fair_price')) out.push('Cancelled: Polymarket → Draw; Kalshi → fair price.');
  // F1 race (owner 2026-10-06): the comparable pair's cancellation difference
  if (kc.some((x) => x.treatment === 'fair_price') && pc.some((x) => x.treatment === 'other_bucket')) out.push('Cancelled: Kalshi → fair price; Polymarket → "Other" (every listed driver No).');
  // golf (owner 2026-10-05): the dead-heat rule changes the payout of the winning golfer itself
  if (t('kalshi', 'dead_heat').some((x) => x.treatment === 'split_1_over_n') && t('polymarket', 'dead_heat').some((x) => x.treatment === 'alphabetical_last_name_wins')) out.push('Dead heat: Kalshi → $1 split across co-winners; Polymarket → alphabetically first last name wins, other co-winners No.');
  return out;
}
export function ruleTermsSummary(rt) {
  const v = ruleTermsView(rt);
  if (!v || !v.differs?.length) return null;
  const pick = (venue, topic) => v[venue].lines.find((l) => l.topic === topic)?.text.split('→ ')[1] || (v[venue].unknown ? 'not confidently parsed' : 'no clause stated');
  const PRIORITY = ['dead_heat', 'postponement', 'cancellation', 'tie', 'no_result', 'data_source', 'walkover', 'retirement'];
  const rank = (t) => (PRIORITY.includes(t) ? PRIORITY.indexOf(t) : PRIORITY.length);
  return [...v.differs].sort((a, b) => rank(a) - rank(b)).slice(0, 3).map((topic) => `${TOPIC_LABEL[topic] || topic}: Kalshi ${pick('kalshi', topic)} · Polymarket ${pick('polymarket', topic)}`).join(' | ');
}

// One contract (one outcome of one event) -> normalized row with its comparability badge.
export function normalizeContract(c) {
  const venues = c.venues || [];
  const k = venuePrice(venues.find((v) => v.venue === 'kalshi'));
  const p = venuePrice(venues.find((v) => v.venue === 'polymarket'));
  const related = (c.related || []).map((r) => ({ ...venuePrice(r), match: r.match, reason: r.reason || null, reasons: (r.reasons || []).filter((x) => !String(x).startsWith('comparable_approval')), withdrawn: r.comparison_withdrawn || null, title: r.title || null, summary: r.summary || null }));
  const listed = (c.listed || []).map(venuePrice);
  const cmp = c.comparison || null;
  let badge, note = null;
  if (cmp) { badge = 'COMPARABLE'; note = cmp.match_class === 'EXACT_MATCH' ? 'EXACT' : null; }
  else if (k?.mid_bp != null && p?.mid_bp != null) { badge = 'COMPARABLE'; note = 'NOT_ALIGNED'; }
  else if (related.some((r) => r.withdrawn)) badge = 'WITHDRAWN';
  else if (related.some((r) => r.match === 'RULE_MISMATCH' || r.match === 'COMPARABLE_EXCEPT_EXCEPTIONS')) badge = 'RULE_MISMATCH';
  else badge = 'SINGLE_VENUE';
  const gap = cmp ? num(cmp.venue_gap_pts) : null;
  // rule-terms/1 (propsports-markets desk, additive): from the Polymarket quote or its related entry; absent = null.
  const pmRaw = venues.find((v) => v.venue === 'polymarket') || (c.related || []).find((r) => r.venue === 'polymarket') || null;
  const ruleTerms = pmRaw?.rule_terms && pmRaw.rule_terms.version === 'rule-terms/1' ? pmRaw.rule_terms : null;
  const priced = [k, p, ...related, ...listed].filter((x) => x && x.mid_bp != null);
  const pbe = c.pbe && num(c.pbe.probability) != null ? { probability: num(c.pbe.probability), state: c.pbe.state || null, issued_at: c.pbe.issued_at || null, model: c.pbe.model || null, selection: c.pbe.selection || null } : null;
  return {
    id: c.canonical_contract_id || c.label, label: c.label || null, role: c.role || null, media: c.media || null,
    kalshi: k, polymarket: p, related, listed, comparison: cmp, badge, note,
    gap_pts: gap, gap_rel_pct: gap != null && k?.mid_bp != null && p?.mid_bp != null ? (gap * 100) / ((k.mid_bp + p.mid_bp) / 200) : null,
    pbe, pbe_vs_venues: cmp?.pbe_vs_venues_pts || null, pbe_position: cmp?.pbe_position || null,
    cross: cmp ? topOfBookCross(k, p) : null, rule_terms: ruleTerms,
    priced: priced.length > 0, all_stale: priced.length > 0 && priced.every((x) => x.freshness === 'stale'),
    freshest_at: priced.map((x) => x.observed_at).filter(Boolean).sort().at(-1) || null
  };
}

// ---------------------------------------------------------------------------------------------------------
// Score feed index + deterministic join.
export function scoreIndex(items = []) {
  const m = new Map();
  for (const it of items) if (it?.sport && (it.market_id ?? it.source_id) != null) m.set(scoreKey(it), it);
  return m;
}
export function joinScore(event, index) {
  const sport = event.sport;
  if (!sport || sport === 'f1') return { state: 'NOT_APPLICABLE', score: null };
  if (!ID_JOIN_SPORTS.has(sport)) return { state: 'UNMATCHED', score: null, reason: sport === 'ufc' ? 'Market lists bouts; the score feed lists cards. No deterministic bout crosswalk yet.' : 'No proven id crosswalk between this sport\'s market and score feed.' };
  const hit = index.get(`${sport}:${String(event.canonical_event_id)}`);
  return hit ? { state: 'LINKED', score: hit } : { state: 'NO_SCORE', score: null };
}

// ---------------------------------------------------------------------------------------------------------
// Live score card -> market inventory state (2026-10-06). The join stays ID-ONLY; this decides what a live score
// card may CLAIM. "NO MARKETS" (NONE) needs a positive check: a targeted desk read (events=<id>) that answered
// without the id, or a complete (uncapped) ok lane, with no same-matchup candidate under another id. Desk still
// loading, lane down/capped, targeted read failed, or a same-matchup candidate = never NONE.
export const LIVE_MARKET = {
  MARKETS: 'markets', NONE: 'none', CHECKING: 'checking', UNAVAILABLE: 'market_source_unavailable',
  MATCH_FAILED: 'market_match_failed', NOT_LINKED: 'not_linked'
};
export const LIVE_MARKET_CHIP = {
  none: 'NO MARKETS', checking: 'CHECKING MARKETS', market_source_unavailable: 'MARKETS DELAYED',
  market_match_failed: 'MARKET CHECK PENDING', not_linked: 'MARKET LINK NOT AVAILABLE'
};
// Chip text for a live score card's market state. "BOUT MARKETS IN UFC HUB" is UFC's own topology (the score feed
// lists cards, the desk lists bouts) and is never shown for any other sport.
export const liveMarketChip = (st) => (st?.state === LIVE_MARKET.NOT_LINKED && st?.sport === 'ufc' ? 'BOUT MARKETS IN UFC HUB' : LIVE_MARKET_CHIP[st?.state] || 'CHECKING MARKETS');

// Team-code aliases across ESPN / NHL / MLB StatsAPI / desk titles -> one code per team (diagnostics only).
const TEAM_ALIAS = {
  nba: { BRK: 'BKN', NJN: 'BKN', GS: 'GSW', NO: 'NOP', NOR: 'NOP', NY: 'NYK', SA: 'SAS', UTAH: 'UTA', UTH: 'UTA', WSH: 'WAS', PHO: 'PHX', CHO: 'CHA', CHH: 'CHA' },
  wnba: { CONN: 'CON', GS: 'GSV', LV: 'LVA', LA: 'LAS', NY: 'NYL', PHO: 'PHX', WSH: 'WAS', WSN: 'WAS' },
  nhl: { NJ: 'NJD', TB: 'TBL', LA: 'LAK', SJ: 'SJS', UTAH: 'UTA', UTH: 'UTA', MON: 'MTL', WAS: 'WSH', CLB: 'CBJ', CLS: 'CBJ', VEG: 'VGK', VGS: 'VGK', NAS: 'NSH', CAL: 'CGY', WIN: 'WPG', WPJ: 'WPG' },
  mlb: { CHW: 'CWS', KCR: 'KC', SDP: 'SD', SFG: 'SF', TBR: 'TB', WSN: 'WSH', WAS: 'WSH', ARI: 'AZ', OAK: 'ATH' },
  nfl: { JAC: 'JAX', LA: 'LAR', WAS: 'WSH', ARZ: 'ARI', BLT: 'BAL', CLV: 'CLE', HST: 'HOU' }
};
export function teamCode(sport, raw) {
  const c = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c ? (TEAM_ALIAS[sport]?.[c] || c) : null;
}
// "AWAY @ HOME" / "AWAY at HOME" / "HOME vs AWAY" titles, or explicit sides. Returns canonical codes or null.
export function matchupSides(sport, { title = null, away = null, home = null } = {}) {
  let a = away, h = home;
  if ((!a || !h) && title) {
    const at = String(title).split(/\s+(?:@|at)\s+/i);
    if (at.length === 2) [a, h] = at;
    else { const vs = String(title).split(/\s+(?:vs\.?|v)\s+/i); if (vs.length === 2) [h, a] = vs; }
  }
  a = teamCode(sport, a); h = teamCode(sport, h);
  return a && h && a !== h ? { away: a, home: h } : null;
}
// Canonical matchup key: sport|away@home|US slate day. US slates are scheduled in ET: an 8:00 pm ET puck drop is
// 00:00Z the next day, so a UTC date would split one slate across two keys. Day boundary = 06:00Z (UTC-6 cut).
const etDay = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t - 6 * 3600e3).toISOString().slice(0, 10) : null; };
export function matchupKey(sport, sides, startAt) {
  return sides ? `${sport}|${sides.away}@${sides.home}|${etDay(startAt) || '?'}` : null;
}
const scoreSides = (sport, x) => matchupSides(sport, { title: x.title, away: x.score?.away?.abbr, home: x.score?.home?.abbr });
const deskSides = (sport, e) => matchupSides(sport, {
  title: e.title,
  away: e.contracts?.find((c) => c.role === 'away')?.label, home: e.contracts?.find((c) => c.role === 'home')?.label
});
// Same-matchup desk events under a DIFFERENT id (unordered team pair, so swapped home/away still counts; start
// within 18 h, or any start when either side has none). Never attaches a market: it only blocks a NONE verdict
// and names the candidate in the diagnostics.
export function matchupCandidates(item, deskEvents = []) {
  const s = scoreSides(item.sport, item);
  if (!s) return [];
  const pair = [s.away, s.home].sort().join('|');
  const t = Date.parse(item.starts_at || item.start_at || '');
  const out = [];
  for (const e of deskEvents) {
    if ((e.sport || null) !== item.sport || String(e.canonical_event_id) === String(item.source_id)) continue;
    const d = deskSides(item.sport, e);
    if (!d || [d.away, d.home].sort().join('|') !== pair) continue;
    const et = Date.parse(e.start_at || '');
    if (Number.isFinite(t) && Number.isFinite(et) && Math.abs(et - t) > 18 * 3600e3) continue;
    out.push({ canonical_event_id: String(e.canonical_event_id), title: e.title || null, start_at: e.start_at || null, key: matchupKey(item.sport, d, e.start_at), swapped: d.away !== s.away });
  }
  return out;
}

// items: live score rows; events: normalized events (desk + targeted reads); lanes: desk lane states;
// targeted: Map `${sport}:${id}` -> { state: 'found'|'missing'|'unavailable' }; rawEvents: raw desk events.
export function liveMarketStates(items = [], { events = [], lanes = null, targeted = new Map(), rawEvents = [] } = {}) {
  const byKey = new Map(events.map((e) => [e.key, e]));
  const laneOf = new Map((lanes || []).map((l) => [l.lane, l]));
  return items.map((x) => {
    const key = scoreKey(x);
    // source_id here is the id checked against the desk (golf: the edition UUID); score_source_id is the feed's own.
    const base = { key, sport: x.sport, source_id: scoreMarketId(x), score_source_id: String(x.source_id), title: x.title || null, matchup_key: matchupKey(x.sport, scoreSides(x.sport, x), x.starts_at || x.start_at) };
    const ev = byKey.get(key);
    if (ev && ev.contracts.length) {
      const venues = new Set();
      for (const c of ev.contracts) {
        if (c.kalshi) venues.add('kalshi');
        if (c.polymarket || c.related.some((r) => r.venue === 'polymarket') || c.listed.some((l) => l?.venue === 'polymarket')) venues.add('polymarket');
      }
      return { ...base, state: LIVE_MARKET.MARKETS, event: ev, market_count: ev.contracts.length, venues: [...venues], priced: ev.contracts.some((c) => c.priced) };
    }
    const lane = laneOf.get(x.sport);
    if (!ID_JOIN_SPORTS.has(x.sport)) {
      if (lane?.state === 'ok' && lane.events > 0) return { ...base, state: LIVE_MARKET.NOT_LINKED, reason: 'score_feed_lists_cards_desk_lists_bouts' };
      if (lane?.state === 'ok' && !lane.capped) return { ...base, state: LIVE_MARKET.NONE, market_count: 0, reason: 'complete_lane_empty' };
      if (lane?.state === 'not_connected') return { ...base, state: LIVE_MARKET.NONE, market_count: 0, reason: 'sport_not_connected' };
      return { ...base, state: lane?.state === 'unavailable' ? LIVE_MARKET.UNAVAILABLE : LIVE_MARKET.CHECKING, reason: lane ? `lane_${lane.state}` : 'desk_not_loaded' };
    }
    const candidates = matchupCandidates(x, rawEvents);
    if (candidates.length) return { ...base, state: LIVE_MARKET.MATCH_FAILED, candidates, reason: 'same_matchup_under_another_id' };
    if (lane?.state === 'not_connected') return { ...base, state: LIVE_MARKET.NONE, market_count: 0, reason: 'sport_not_connected' };
    const t = targeted.get(key);
    // NO MARKETS for an id-joined sport needs the targeted read by id: a whole-sport lane can omit a live game.
    if (t?.state === 'missing') return { ...base, state: LIVE_MARKET.NONE, market_count: 0, reason: 'targeted_read_empty' };
    if (t?.state === 'unavailable' || lane?.state === 'unavailable') return { ...base, state: LIVE_MARKET.UNAVAILABLE, reason: t?.state === 'unavailable' ? 'targeted_read_failed' : 'lane_unavailable' };
    return { ...base, state: LIVE_MARKET.CHECKING, reason: lane ? 'awaiting_targeted_read' : 'desk_not_loaded' };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Event normalization + ranking. Primary view = actionable price discrepancy:
//   tier 0  comparable, aligned, gap > 0 (sorted by gap)      tier 1  comparable aligned, gap 0
//   tier 2  both quoted but not aligned / rule mismatch / single venue (fresh)
//   tier 3  stale, withdrawn, final, nothing priced
// Field events (golf winner: one contract per golfer) list the field by each golfer's highest venue YES price.
const fieldPrice = (c) => Math.max(c.kalshi?.mid_bp ?? -1, (c.polymarket || c.related?.find((r) => r.venue === 'polymarket') || c.listed?.find((x) => x?.venue === 'polymarket'))?.mid_bp ?? -1);
export function normalizeEvent(e, index = new Map()) {
  let contracts = (e.contracts || []).map(normalizeContract);
  // field events: golf winner, F1 race winner / season champion (one contract per participant)
  const field = e.sport === 'golf' || e.sport === 'f1' ? { n: contracts.length, noun: e.sport === 'golf' ? 'golfers' : String(e.canonical_event_id).includes('constructors') ? 'teams' : 'drivers' } : null;
  if (field) contracts = contracts.sort((a, b) => fieldPrice(b) - fieldPrice(a));
  const join = joinScore(e, index);
  const status = join.score?.status || null;
  const best = contracts.filter((c) => c.gap_pts != null).sort((a, b) => b.gap_pts - a.gap_pts)[0] || null;
  const anyPriced = contracts.some((c) => c.priced);
  const allStale = anyPriced && contracts.filter((c) => c.priced).every((c) => c.all_stale);
  const withdrawn = contracts.length > 0 && contracts.every((c) => c.badge === 'WITHDRAWN' || !c.priced);
  let tier;
  if (status === 'final' || !anyPriced || allStale || withdrawn) tier = 3;
  else if (best && best.gap_pts > 0) tier = 0;
  else if (best) tier = 1;
  else tier = 2;
  const badges = [...new Set(contracts.map((c) => c.badge))];
  return {
    key: `${e.sport || 'nonsports'}:${e.canonical_event_id}`, sport: e.sport || null, lane: e.lane || e.sport || 'nonsports',
    canonical_event_id: String(e.canonical_event_id), title: (e.title && e.title !== 'Market' ? e.title : null) || e.question || (contracts.length === 2 && contracts.every((c) => c.label) ? `${contracts[0].label} v ${contracts[1].label}` : 'Market'), start_at: e.start_at || e.close_time || null,
    destination: e.destination?.url || null, contracts, join, status, tier, best_gap: best?.gap_pts ?? null, best,
    badge: badges.includes('COMPARABLE') ? 'COMPARABLE' : badges.includes('RULE_MISMATCH') ? 'RULE_MISMATCH' : badges.includes('WITHDRAWN') ? 'WITHDRAWN' : 'SINGLE_VENUE',
    badge_note: contracts.some((c) => c.comparison) ? null : contracts.some((c) => c.note === 'NOT_ALIGNED') ? 'NOT_ALIGNED' : null,
    three_way: e.sport === 'soccer' && contracts.some((c) => c.role === 'draw') ? { book: bookSums(contracts) } : null, field,
    has_pbe: contracts.some((c) => c.pbe), active: anyPriced && status !== 'final' && !withdrawn,
    live: status === 'live', freshest_at: contracts.map((c) => c.freshest_at).filter(Boolean).sort().at(-1) || null
  };
}

// 3-way book sum per venue: the three outcome YES mids added up (each venue's own price, incl. a rule-mismatch
// related quote). Only when all three outcomes are priced on that venue; otherwise null. Not a probability.
export function bookSums(contracts) {
  const pick = (c, venue) => (venue === 'kalshi' ? c.kalshi : c.polymarket || c.related.find((r) => r.venue === 'polymarket') || c.listed.find((x) => x?.venue === 'polymarket'));
  const out = {};
  for (const venue of ['kalshi', 'polymarket']) {
    const mids = ['home', 'draw', 'away'].map((role) => pick(contracts.find((c) => c.role === role) || {}, venue)?.mid_bp ?? null);
    out[venue] = mids.every((m) => m != null) ? { sum_bp: mids.reduce((a, b) => a + b, 0), mids_bp: mids } : null;
  }
  return out;
}
export function rankEvents(events) {
  return [...events].sort((a, b) => a.tier - b.tier
    || (b.best_gap ?? -1) - (a.best_gap ?? -1)
    || String(a.start_at || '9').localeCompare(String(b.start_at || '9')));
}

export const VIEWS = {
  top: { label: 'TOP MID GAPS', filter: (e) => e.active },
  live: { label: 'LIVE NOW', filter: (e) => e.live },
  pbe: { label: 'PBE CALLS', filter: (e) => e.has_pbe },
  cross: { label: 'TOP-OF-BOOK CROSS', filter: (e) => e.contracts.some((c) => c.cross?.state === 'CROSS') },
  rules: { label: 'RULE DIFFERENCES', filter: (e) => e.contracts.some((c) => c.badge === 'RULE_MISMATCH' || c.badge === 'WITHDRAWN' || c.comparison?.disclosure) },
  all: { label: 'ALL MARKETS', filter: () => true }
};

// ---------------------------------------------------------------------------------------------------------
// Movement over a window from STORED points (step semantics: a stored value holds until the next stored row).
// Requires an observation at or before (now − window); otherwise "not enough observations" (null), never 0.
export const WINDOWS = [{ key: '1m', ms: 60e3 }, { key: '5m', ms: 5 * 60e3 }, { key: '15m', ms: 15 * 60e3 }, { key: '60m', ms: 3600e3 }, { key: '24h', ms: 86400e3 }];
export function moveOver(points, windowMs, now = Date.now()) {
  const pts = (points || []).map((p) => ({ t: Date.parse(p.t), v: num(p.v) })).filter((p) => Number.isFinite(p.t) && p.v !== null).sort((a, b) => a.t - b.t);
  if (!pts.length) return null;
  const from = now - windowMs;
  let base = null;
  for (const p of pts) { if (p.t <= from) base = p; else break; }
  if (!base) return null;
  const last = pts[pts.length - 1];
  return { delta_bp: last.v - base.v, from_v: base.v, to_v: last.v, from_t: new Date(base.t).toISOString(), to_t: new Date(last.t).toISOString(), n: pts.filter((p) => p.t >= base.t).length };
}
export function moves(points, now = Date.now()) {
  return Object.fromEntries(WINDOWS.map((w) => [w.key, moveOver(points, w.ms, now)]));
}
export const fmtMove = (m) => (m == null ? 'Not enough observations' : `${m.delta_bp > 0 ? '▲ +' : m.delta_bp < 0 ? '▼ −' : '■ '}${(Math.abs(m.delta_bp) / 100).toFixed(1)}¢`);

// ---------------------------------------------------------------------------------------------------------
// Screen state. Every failure has its own state; "empty" only when every source answered and there is nothing.
export function membershipState(status, body) {
  if (status === 0) return 'network_error';
  if (status === 401) return 'anonymous';
  if (status === 403) return 'forbidden';
  if (status === 503 || status >= 500) return 'unverified';
  const mm = body?.membership || {};
  if (mm.entitled === true && (mm.state === 'all_access' || mm.state === 'owner')) return 'entitled';
  if (mm.state === 'anonymous') return 'anonymous';
  if (mm.state === 'unverified') return 'unverified';
  return 'forbidden';
}

export const SCORE_DELAY_MS = 120e3;
export function scoreSourceState(src, now = Date.now()) {
  if (!src) return 'not_requested';
  if (src.state !== 'ok') return 'unavailable';
  if (src.fetched_at && now - Date.parse(src.fetched_at) > SCORE_DELAY_MS) return 'delayed';
  return 'ok';
}

// ---------------------------------------------------------------------------------------------------------
// Alert relevance (2026-10-06). Backend health stays truthful (lane/source states, Source Health line,
// sourceDiagnostics); the notice stack only answers "is what I'm looking at usable?". A sport is RELEVANT when it
// has a live game, a game starting within SOON_MS, usable market cards on screen, or the user opened its hub.
// A failure for an irrelevant sport never reaches the customer. A failed refresh with last-known data on screen
// is a quiet status at most (and none until MARKET_STALE_MS), never an incident banner.
export const SOON_MS = 2 * 3600e3;
export const IN_PLAY_MS = 4 * 3600e3;
export const MARKET_STALE_MS = 150e3;
export const DESK_CARRY_MS = 15 * 60e3;
const laneName = (l) => (l === 'nonsports' ? 'Prediction markets' : String(l).toUpperCase());
const eventLane = (e) => e.lane || e.sport || 'nonsports';

// Stale-while-revalidate for the desk: a lane that fails this read keeps its last-known events (up to
// DESK_CARRY_MS from its last good read). Lane state stays 'unavailable' (truth); cached_at marks the carry.
export function carryDesk(prev, prevAt, next, now = Date.now()) {
  if (!next?.lanes || !prev?.lanes) return next;
  const before = new Map(prev.lanes.map((l) => [l.lane, l]));
  const carried = [];
  const lanes = next.lanes.map((l) => {
    if (l.state !== 'unavailable') return l;
    const p = before.get(l.lane);
    const at = p?.state === 'ok' ? (prevAt ? new Date(prevAt).toISOString() : null) : p?.cached_at || null;
    if (!at || now - Date.parse(at) > DESK_CARRY_MS) return l;
    const evs = (prev.events || []).filter((e) => eventLane(e) === l.lane);
    if (!evs.length) return l;
    carried.push(...evs);
    return { ...l, cached_at: at, cached_events: evs.length };
  });
  return carried.length ? { ...next, lanes, events: [...(next.events || []), ...carried] } : { ...next, lanes };
}

// Relevance per sport from score items, rendered events and the selected scope.
export function relevance({ scope, live, events = [], now = Date.now() }) {
  const inPlay = new Set(), usable = new Set();
  for (const x of live?.items || []) {
    const t = Date.parse(x.starts_at || x.start_at || '');
    if (x.status === 'live' || (x.status === 'scheduled' && Number.isFinite(t) && t - now <= SOON_MS && now - t <= IN_PLAY_MS)) inPlay.add(x.sport);
  }
  for (const e of events) {
    const lane = eventLane(e);
    if (e.contracts?.some((c) => c.priced)) usable.add(lane);
    const t = Date.parse(e.start_at || '');
    if (e.live || (e.active && e.sport && Number.isFinite(t) && t - now <= SOON_MS && now - t <= IN_PLAY_MS)) inPlay.add(lane);
  }
  const explicit = scope && scope !== 'sports' ? scope : null;
  return { inPlay, usable, explicit, relevant: (s) => s === explicit || inPlay.has(s) || usable.has(s) };
}

// Returns banners, most severe first. Levels: error (critical) > auth > warn (relevant) > quiet > info.
export function screenNotices({ desk, deskStatus, deskAt = null, live, liveStatus, scope, events = [], now = Date.now() }) {
  const n = [];
  const rel = relevance({ scope, live, events, now });
  const anyUsable = rel.usable.size > 0;
  const stale = [];
  if (deskStatus === 'loading') n.push({ level: 'info', code: 'loading', text: 'Loading market desk…' });
  else if (deskStatus === 401) n.push({ level: 'auth', code: 'auth_expired', text: 'Your session ended. Sign in again to load the comparison desk.' });
  else if (deskStatus === 403) n.push({ level: 'auth', code: 'forbidden', text: 'Compare is part of PropBetEdge All Access. This account does not include it.' });
  else if (deskStatus === 503) n.push({ level: 'error', code: 'access_check', text: 'We could not verify your membership right now. Nothing is shown until access is verified; retrying automatically.' });
  else if (deskStatus === 0 || deskStatus >= 500) {
    // The desk read itself failed. Last-known cards on screen = a refresh delay, not an outage.
    if (anyUsable && deskAt) stale.push(deskAt);
    else n.push({ level: 'error', code: 'network', text: 'Network error reaching Compare. Retrying automatically.' });
  }
  const lanes = desk?.lanes || [];
  const down = lanes.filter((l) => l.state === 'unavailable');
  if (deskStatus === 200 && lanes.length && down.length === lanes.length && !anyUsable) {
    n.push({ level: 'error', code: 'no_market_data', text: `${rel.explicit ? `${laneName(rel.explicit)} market data` : 'Market data'} is unavailable right now. Retrying automatically.` });
  } else {
    for (const l of down) {
      if (!rel.relevant(l.lane)) continue; // idle sport: Source Health / diagnostics only
      if (rel.usable.has(l.lane)) { if (l.cached_at) stale.push(Date.parse(l.cached_at)); continue; }
      n.push({ level: 'warn', code: 'lane_unavailable', lane: l.lane, text: `${laneName(l.lane)} markets can't be loaded right now. Retrying automatically.` });
    }
  }
  if (rel.explicit) for (const l of lanes) {
    if (l.state === 'not_connected') n.push({ level: 'info', code: 'lane_not_connected', lane: l.lane, text: `${laneName(l.lane)} comparison lane is not connected yet. No Kalshi ↔ Polymarket desk exists for this sport.` });
    else if (l.state === 'ok' && l.capped) n.push({ level: 'info', code: 'lane_capped', lane: l.lane, text: `${laneName(l.lane)}: showing the first ${desk.page_limit} events (upstream page limit; no further pages exist yet).` });
  }
  // lanes the server answered from its stale-while-revalidate cache (state ok, age_ms at response time)
  if (deskAt) for (const l of lanes) if (l.state === 'ok' && l.stale && Number.isFinite(l.age_ms) && rel.relevant(l.lane)) stale.push(deskAt - l.age_ms);
  const oldest = stale.filter(Number.isFinite).sort((a, b) => a - b)[0];
  if (oldest != null && now - oldest > MARKET_STALE_MS) {
    n.push({ level: 'quiet', code: 'market_refresh_delayed', text: `Market refresh delayed · showing prices from ${ageText(new Date(oldest).toISOString(), now)}` });
  }
  if (lanes.some((l) => l.state === 'ok') && events.length && !events.some((e) => e.badge === 'COMPARABLE')) {
    const liveN = (live?.items || []).filter((x) => x.status === 'live').length;
    n.push({ level: 'info', code: 'no_comparable', text: `${liveN ? `${liveN} game${liveN > 1 ? 's are' : ' is'} live, but no` : 'No'} market in this scope has an approved Kalshi ↔ Polymarket comparable contract right now. Single-venue and rule-mismatch markets are shown below with their own prices.` });
  }
  if (scope !== 'nonsports') {
    // Score state matters for in-play sports (warn) and, muted, for the hub the user opened. Never for idle sports.
    const scoreLevel = (s) => (rel.inPlay.has(s) ? 'warn' : s === rel.explicit ? 'quiet' : null);
    if (liveStatus === 0 || liveStatus >= 500) {
      const hit = rel.explicit ? [rel.explicit] : [...rel.inPlay].filter((s) => s !== 'nonsports');
      if (hit.length) n.push({ level: hit.some((s) => rel.inPlay.has(s)) ? 'warn' : 'quiet', code: 'score_feed_down', sports: hit, text: `${rel.explicit ? `${laneName(rel.explicit)} live` : 'Live'} game state unavailable right now. Markets are shown without it; retrying automatically.` });
    } else {
      const cached = new Set((live?.items || []).filter((x) => x.meta?.delayed_cached).map((x) => x.sport));
      for (const s of live?.sources || []) {
        const st = scoreSourceState(s, now), level = scoreLevel(s.key);
        if (st === 'ok' || !level) continue;
        const name = laneName(s.key);
        if (st === 'unavailable' && !cached.has(s.key)) n.push({ level, code: 'score_source_down', sport: s.key, text: `${name} game state unavailable right now. ${name} markets show without it; retrying automatically.` });
        else n.push({ level: 'quiet', code: 'score_delayed', sport: s.key, text: `${name} scores delayed · showing last known game state${s.fetched_at ? ` from ${ageText(s.fetched_at, now)}` : ''}` });
      }
    }
  }
  const rank = { error: 0, auth: 1, warn: 2, quiet: 3, info: 4 };
  return n.map((x, i) => [x, i]).sort((a, b) => rank[a[0].level] - rank[b[0].level] || a[1] - b[1]).map(([x]) => x);
}

// Full backend health for the Source Health line (tooltip) and internal QA. Never rendered as customer notices.
export function sourceDiagnostics({ desk, live, liveStatus, now = Date.now() }) {
  const out = [];
  for (const l of desk?.lanes || []) if (l.state === 'ok' && l.stale) out.push(`market:${l.lane}=stale ${Math.round((l.age_ms || 0) / 1000)}s (refreshing)`);
  for (const l of desk?.lanes || []) if (l.state !== 'ok') out.push(`market:${l.lane}=${l.state}${l.upstream_status ? ` ${l.upstream_status}` : ''}${l.error ? ` ${l.error}` : ''}${l.cached_at ? ` cached ${ageText(l.cached_at, now)}` : ''}`);
  if (liveStatus && liveStatus !== 200) out.push(`scores=HTTP ${liveStatus}`);
  for (const s of live?.sources || []) { const st = scoreSourceState(s, now); if (st !== 'ok') out.push(`score:${s.key}=${st}${s.error ? ` ${s.error}` : ''}`); }
  return out;
}

// Board-level empty state, only when every requested source answered.
export function boardEmpty({ desk, viewKey, events, scope, liveItems = [] }) {
  if (!desk) return null;
  const okLanes = (desk.lanes || []).filter((l) => l.state === 'ok' || l.cached_at); // cached = last-known cards
  if (!okLanes.length) {
    if ((desk.lanes || []).every((l) => l.state === 'not_connected')) return { code: 'not_connected', text: 'This comparison lane is not connected yet. No Kalshi ↔ Polymarket desk exists for this sport.' };
    return { code: 'upstream_error', failure: true, text: 'The market feed for this scope did not answer. This is a feed failure, not an empty market; retrying every 60 seconds.' };
  }
  if (events.length) return null;
  const live = liveItems.filter((x) => x.status === 'live').length;
  if (viewKey === 'live') return { code: 'no_live', text: live ? `${live} game${live > 1 ? 's are' : ' is'} live, but none has a deterministically linked market on this board.` : 'No games with linked markets are live right now.' };
  if (viewKey === 'pbe') return { code: 'no_pbe', text: 'No active PBE calls in this scope right now.' };
  if (viewKey === 'top') return { code: 'no_active', text: 'Every lane answered: no active markets in this scope right now.' };
  return { code: 'zero', text: 'Every lane answered with zero markets for this scope.' };
}

// ---------------------------------------------------------------------------------------------------------
// Participant media. Deterministic URLs from ids/abbreviations the desk already carries; the score feed's own
// logo wins when the game is linked. UFC photos arrive server-side (contract.media.photo). F1/soccer/golf have
// no comparison lane; F1 team marks are held as trademarks. Anything missing renders as initials, never a
// recreated logo.
const ESPN_ALIAS = {
  nba: { UTA: 'utah', GSW: 'gs', NYK: 'ny', SAS: 'sa', NOP: 'no', WAS: 'wsh', PHO: 'phx', BRK: 'bkn' },
  nfl: { WAS: 'wsh', JAC: 'jax', LA: 'lar' },
  wnba: { LVA: 'lv', NYL: 'ny', GSV: 'gs', CON: 'conn', WAS: 'wsh', PHO: 'phx' }
};
// Some venue-neutral contracts carry a team NAME instead of a code (Polymarket-only listings).
const NAME_CODE = {
  nhl: { DUCKS: 'ANA', BRUINS: 'BOS', SABRES: 'BUF', FLAMES: 'CGY', HURRICANES: 'CAR', BLACKHAWKS: 'CHI', AVALANCHE: 'COL', BLUEJACKETS: 'CBJ', STARS: 'DAL', REDWINGS: 'DET', OILERS: 'EDM', PANTHERS: 'FLA', KINGS: 'LAK', WILD: 'MIN', CANADIENS: 'MTL', PREDATORS: 'NSH', DEVILS: 'NJD', ISLANDERS: 'NYI', RANGERS: 'NYR', SENATORS: 'OTT', FLYERS: 'PHI', PENGUINS: 'PIT', SHARKS: 'SJS', KRAKEN: 'SEA', BLUES: 'STL', LIGHTNING: 'TBL', MAPLELEAFS: 'TOR', MAMMOTH: 'UTA', CANUCKS: 'VAN', GOLDENKNIGHTS: 'VGK', CAPITALS: 'WSH', JETS: 'WPG' },
  wnba: { ATLANTADREAM: 'ATL', CHICAGOSKY: 'CHI', CONNECTICUTSUN: 'CONN', DALLASWINGS: 'DAL', GOLDENSTATEVALKYRIES: 'GS', INDIANAFEVER: 'IND', LASVEGASACES: 'LV', LOSANGELESSPARKS: 'LA', MINNESOTALYNX: 'MIN', NEWYORKLIBERTY: 'NY', PHOENIXMERCURY: 'PHX', SEATTLESTORM: 'SEA', WASHINGTONMYSTICS: 'WSH', TORONTOTEMPO: 'TOR', PORTLANDFIRE: 'POR' }
};
export function participantMedia(sport, contract, linkedSide = null) {
  const label = String(contract?.label || '').trim();
  const id = (String(contract?.id || contract?.canonical_contract_id || '').match(/\|team:([^|]+)$/) || [])[1] || null;
  const initials = label.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 3).toUpperCase() || '?';
  const raw = label.replace(/[^A-Za-z]/g, '').toUpperCase();
  const abbr = NAME_CODE[sport]?.[raw] || raw;
  const espn = (lg) => `https://a.espncdn.com/i/teamlogos/${lg}/500/scoreboard/${(ESPN_ALIAS[lg]?.[abbr] || abbr).toLowerCase()}.png`;
  let src = null, kind = 'logo';
  if (sport === 'nfl' || sport === 'nba') src = linkedSide?.logo || (abbr ? espn(sport) : null);
  else if (sport === 'wnba') src = linkedSide?.logo || (abbr ? `https://a.espncdn.com/i/teamlogos/wnba/500/${(ESPN_ALIAS.wnba[abbr] || abbr).toLowerCase()}.png` : null);
  else if (sport === 'nhl') src = abbr ? `https://assets.nhle.com/logos/nhl/svg/${abbr}_dark.svg` : null;
  else if (sport === 'mlb') src = id && /^\d+$/.test(id) ? `https://www.mlbstatic.com/team-logos/team-cap-on-dark/${id}.svg` : linkedSide?.logo || null;
  else if (sport === 'tennis') { kind = 'photo'; src = id && /^[0-9a-f-]{36}$/.test(id) ? `https://tennis-api.propbetedge.ai/media/players/${id}/portrait.webp` : null; }
  else if (sport === 'ufc') { kind = 'photo'; src = contract?.media?.photo || null; }
  else if (sport === 'soccer') { if (contract?.role === 'draw') return { kind: 'draw', src: null, initials: '=', alt: 'Draw' }; src = contract?.media?.logo || linkedSide?.logo || null; }
  return { kind, src, initials, alt: label };
}

// Date buckets for hub tabs (viewer's local day). Live wins over any date.
export const WHEN = [
  { key: 'live', label: 'LIVE' }, { key: 'today', label: 'TODAY' }, { key: 'tomorrow', label: 'TOMORROW' },
  { key: 'week', label: 'THIS WEEK' }, { key: 'later', label: 'LATER' }, { key: 'all', label: 'ALL DATES' }
];
export function whenOf(e, now = Date.now()) {
  if (e.live) return 'live';
  const t = Date.parse(e.start_at || '');
  if (!Number.isFinite(t)) return 'later';
  const day = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const diff = Math.round((day(t) - day(now)) / 86400e3);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff <= 7) return 'week';
  return 'later';
}
export const inWhen = (e, key, now = Date.now()) => key === 'all' || whenOf(e, now) === key;

export function hubStats(events) {
  const active = events.filter((e) => e.active);
  return {
    events: events.length, active: active.length, live: events.filter((e) => e.live).length,
    comparable: active.filter((e) => e.badge === 'COMPARABLE' && e.best_gap != null).length,
    mismatch: active.filter((e) => e.badge === 'RULE_MISMATCH').length,
    pbe: events.filter((e) => e.has_pbe).length,
    crosses: active.filter((e) => e.contracts.some((c) => c.cross?.state === 'CROSS')).length,
    best: active.reduce((m, e) => (e.best_gap != null && e.best_gap > (m?.best_gap ?? -1) ? e : m), null)
  };
}

// ---------------------------------------------------------------------------------------------------------
export const golfToPar = (v) => (v == null ? '—' : v === 0 ? 'E' : v > 0 ? `+${v}` : String(v));
export function golfThru(r) {
  if (r.status && !['active', 'complete'].includes(String(r.status).toLowerCase())) return String(r.status).toUpperCase();
  if (r.thru == null) return '';
  return Number(r.thru) >= 18 ? 'F' : `THRU ${r.thru}`;
}
export function golfBoardRows(golf) {
  const rows = (golf?.leaderboard || []).filter((r) => r?.name);
  if (!rows.length) return [];
  const lead = rows[0].position;
  const tiedLead = lead != null ? rows.filter((r) => r.position === lead).length : 1;
  return rows.slice(0, Math.min(5, Math.max(3, tiedLead)));
}

// ---------------------------------------------------------------------------------------------------------
// LIVE COMMAND BOARD (presentation only, 2026-10-08). Orders the already-live market cards; never changes the
// comparison ranking or any model. 1 PBE call · 2 largest valid mid gap · 3 top-of-book cross · 4 closest live
// score · 5 the rest in their incoming order.
const crossCount = (e) => e.contracts.filter((c) => c.cross?.state === 'CROSS').length;
const scoreMargin = (e) => {
  const s = e.join?.score?.score;
  const a = Number(s?.away?.score), h = Number(s?.home?.score);
  return s && Number.isFinite(a) && Number.isFinite(h) && s.away.score != null && s.home.score != null ? Math.abs(a - h) : Infinity;
};
export function rankLiveMarkets(events = []) {
  return events.map((e, i) => ({ e, i })).sort((x, y) =>
    Number(Boolean(y.e.has_pbe)) - Number(Boolean(x.e.has_pbe))
    || (y.e.best_gap ?? -1) - (x.e.best_gap ?? -1)
    || crossCount(y.e) - crossCount(x.e)
    || scoreMargin(x.e) - scoreMargin(y.e)
    || x.i - y.i).map((x) => x.e);
}
// A card earns FEATURED LIVE only on a real signal (PBE call, a positive mid gap, or a cross).
export const featuredLive = (e) => Boolean(e && (e.has_pbe || (e.best_gap ?? 0) > 0 || crossCount(e) > 0));
// Header summary from the loaded live events only (no extra request).
export function liveSummary(events = []) {
  const gaps = events.map((e) => e.best_gap).filter((g) => g != null);
  return {
    markets: events.length,
    comparable: events.filter((e) => e.badge === 'COMPARABLE' && e.best_gap != null).length,
    rules_differ: events.filter((e) => e.badge === 'RULE_MISMATCH').length,
    largest_gap: gaps.length ? Math.max(...gaps) : null
  };
}
// Desktop command-grid columns for a viewport width; 1-5 live cards share one row when they fit (>= 260 px each).
export function boardColumns(width, n) {
  const base = width >= 2048 ? 5 : width >= 1440 ? 4 : width >= 1024 ? 3 : 2;
  if (n <= 5 && n > 0) { const fit = Math.max(1, Math.floor((Math.min(width, 1480) - 40) / 260)); return Math.min(n, Math.max(base, Math.min(fit, 5))); }
  return base;
}
