// Terminal model over real Compare payloads (fixtures captured 2026-10-09 from the production upstreams).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as M from '../model.js';

const fx = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const NOW = Date.parse('2026-10-09T20:00:00Z');
const nhl = () => M.buildEvents(fx('desk-nhl.json'));

test('buildEvents: every contract keeps its key, event key and Compare badge; prices are the desk mids', () => {
  const ev = nhl();
  assert.equal(ev.length, 6);
  const sea = ev.find((e) => e.canonical_event_id === '2026020066');
  const det = sea.contracts.find((c) => c.label === 'DET');
  assert.equal(det.key, 'nhl:2026020066|sports_winner|nhl:2026020066|team:17');
  assert.equal(det.ev, 'nhl:2026020066');
  assert.equal(det.kalshi.mid_bp, 5750); assert.equal(det.polymarket.mid_bp, 5750);
  assert.equal(det.gap_pts, 0);
  assert.equal(M.contractState(det).code, 'EXCEPTIONS', 'COMPARABLE_EXCEPT_EXCEPTIONS is never labelled a plain/exact match');
  assert.deepEqual(det.move, { venue: 'polymarket', first_observed_at: '2026-10-03T21:54:05.911Z', first_mid_bp: 5350, delta_bp: 400 });
});

test('unmatched / single-venue contracts never get a gap; a missing model stays missing', () => {
  const ns = M.buildEvents(fx('desk-nonsports.json'));
  const c = ns[0].contracts[0];
  assert.equal(c.comparison, null); assert.equal(c.gap_pts, null);
  assert.equal(M.contractState(c).code, 'SINGLE');
  assert.equal(M.modelState(c).code, 'NO_MODEL');
  assert.equal(ns[0].scope, 'nonsports'); assert.equal(ns[0].key.startsWith('nonsports:'), true);
});

test('missing / malformed fields do not throw and do not invent prices', () => {
  const ev = M.buildEvents({ events: [null, 7, { title: 'no id' }, { canonical_event_id: 'X', sport: 'nhl', contracts: [{ canonical_contract_id: 'c1', venues: [{ venue: 'kalshi', mid_bp: 'abc' }, { venue: 'polymarket' }] }, { venues: [] }] }] });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].contracts.length, 1);
  const c = ev[0].contracts[0];
  assert.equal(c.kalshi.mid_bp, null); assert.equal(c.polymarket.mid_bp, null); assert.equal(c.gap_pts, null); assert.equal(c.move, null);
  assert.deepEqual(M.buildEvents(null), []); assert.deepEqual(M.buildEvents({}), []);
});

test('sorting: live first, finals last; gap / move / start modes', () => {
  const ev = nhl();
  ev[3].live = true; ev[0].status = 'final';
  const p = M.sortEvents(ev, 'priority', NOW);
  assert.equal(p[0], ev[3]); assert.equal(p.at(-1), ev[0]);
  const g = M.sortEvents(ev, 'gap');
  for (let i = 1; i < g.length; i++) assert.ok((g[i - 1].best_gap ?? -1) >= (g[i].best_gap ?? -1));
  const s = M.sortEvents(ev, 'start');
  for (let i = 1; i < s.length; i++) assert.ok(String(s[i - 1].start_at) <= String(s[i].start_at));
});

test('filters and search', () => {
  const ev = nhl();
  assert.ok(M.filterEvents(ev, { filter: 'verified' }).every((e) => e.contracts.some((c) => c.comparison)));
  assert.equal(M.filterEvents(ev, { filter: 'live' }).length, 0);
  assert.equal(M.filterEvents(ev, { q: 'det' }).length >= 1, true);
  const key = ev[1].contracts[0].key;
  assert.deepEqual(M.filterEvents(ev, { watch: new Set([key]) }).map((e) => e.key), [ev[1].key]);
});

test('feed health: LIVE / DELAYED / STALLED / OFFLINE / CONNECTING from the read clock only', () => {
  assert.equal(M.feedHealth({ lastOkAt: NOW - 10e3, now: NOW }).state, 'LIVE');
  assert.equal(M.feedHealth({ lastOkAt: NOW - 100e3, now: NOW }).state, 'DELAYED');
  assert.equal(M.feedHealth({ lastOkAt: NOW - 10e3, lanes: [{ lane: 'nba', state: 'unavailable' }], now: NOW }).state, 'DELAYED');
  assert.equal(M.feedHealth({ lastOkAt: NOW - 200e3, now: NOW }).state, 'STALLED');
  assert.equal(M.feedHealth({ lastOkAt: NOW, online: false, now: NOW }).state, 'OFFLINE');
  assert.equal(M.feedHealth({ now: NOW }).state, 'CONNECTING');
  assert.equal(M.feedHealth({ lastStatus: 502, now: NOW }).state, 'STALLED');
});

// helpers to mutate a desk body between two reads
const clone = (x) => JSON.parse(JSON.stringify(x));
function deskWith(fn) { const d = clone(fx('desk-nhl.json')); fn(d); return d; }
const DET = 'nhl:2026020066|sports_winner|nhl:2026020066|team:17';

test('alerts: a watched venue move needs two DISTINCT observations of >= 2.0¢', () => {
  const a = M.snapshot(M.buildEvents(fx('desk-nhl.json')));
  const sameObs = M.snapshot(M.buildEvents(deskWith((d) => { d.events[0].contracts[0].venues[0].mid_bp = 6000; })));
  const watch = new Set([DET]);
  assert.equal(M.diffAlerts(a, sameObs, { watch, now: NOW }).filter((x) => x.type === 'MOVE').length, 0, 'same observed_at re-read is not a move');
  const moved = M.snapshot(M.buildEvents(deskWith((d) => { const v = d.events[0].contracts[0].venues[0]; v.mid_bp = 6000; v.observed_at = '2026-10-09T19:31:00.000Z'; })));
  const fired = new Set();
  const al = M.diffAlerts(a, moved, { watch, fired, now: NOW }).filter((x) => x.type === 'MOVE');
  assert.equal(al.length, 1);
  assert.equal(al[0].venue, 'Kalshi'); assert.equal(al[0].delta_bp, 250); assert.equal(al[0].at, '2026-10-09T19:31:00.000Z');
  assert.match(al[0].text, /57\.5¢ → 60\.0¢ \(\+2\.5¢\) · observed 19:29:59Z → 19:31:00Z/);
  assert.equal(M.diffAlerts(a, moved, { watch, fired, now: NOW }).length, 0, 'deduplicated');
  const small = M.snapshot(M.buildEvents(deskWith((d) => { const v = d.events[0].contracts[0].venues[0]; v.mid_bp = 5800; v.observed_at = '2026-10-09T19:32:00.000Z'; })));
  assert.equal(M.diffAlerts(a, small, { watch, now: NOW }).filter((x) => x.type === 'MOVE').length, 0, '0.5¢ is below threshold');
  assert.equal(M.diffAlerts(a, moved, { watch: new Set(), now: NOW }).filter((x) => x.type === 'MOVE').length, 0, 'unwatched contracts never raise moves');
});

test('alerts: newly matched, closing soon, first load raises nothing', () => {
  const unmatched = deskWith((d) => { d.events[0].contracts[0].comparison = null; });
  const prev = M.snapshot(M.buildEvents(unmatched)), next = M.snapshot(M.buildEvents(fx('desk-nhl.json')));
  assert.deepEqual(M.diffAlerts(null, next, { now: NOW }), []);
  const m = M.diffAlerts(prev, next, { now: NOW }).filter((x) => x.type === 'MATCHED');
  assert.equal(m.length, 1); assert.equal(m[0].key, DET);
  const soon = Date.parse('2026-10-09T22:45:00Z'); // SEA @ DET starts 23:00Z
  const c = M.diffAlerts(next, next, { watch: new Set([DET]), now: soon }).filter((x) => x.type === 'CLOSING');
  assert.equal(c.length, 1); assert.match(c[0].text, /starts in 15 min \(23:00:00Z\)/);
});

test('alerts: PBE model published / market-vs-model change on a watched contract', () => {
  const prev = M.snapshot(M.buildEvents(fx('desk-nhl.json')));
  const withPbe = deskWith((d) => { const c = d.events[0].contracts[0]; c.pbe = { probability: 0.61, issued_at: '2026-10-09T18:00:00Z' }; c.comparison.pbe_vs_venues_pts = [3.5, 3.5]; });
  const mid = M.snapshot(M.buildEvents(withPbe));
  const a = M.diffAlerts(prev, mid, { watch: new Set([DET]), now: NOW }).filter((x) => x.type === 'MODEL');
  assert.equal(a.length, 1); assert.match(a[0].text, /published at 61\.0%/);
  const later = M.snapshot(M.buildEvents(deskWith((d) => { const c = d.events[0].contracts[0]; c.pbe = { probability: 0.61 }; c.comparison.pbe_vs_venues_pts = [6.0, 3.5]; c.venues[0].observed_at = '2026-10-09T19:40:00Z'; })));
  const b = M.diffAlerts(mid, later, { watch: new Set([DET]), now: NOW }).filter((x) => x.type === 'MODEL');
  assert.equal(b.length, 1); assert.match(b[0].text, /\+3\.5 → \+6\.0 pts/);
});

test('feed alerts + bounded alert list', () => {
  assert.equal(M.feedAlert('LIVE', 'STALLED', 'T').type, 'STALE');
  assert.equal(M.feedAlert('STALLED', 'LIVE', 'T').type, 'RECOVERED');
  let list = [];
  for (let i = 0; i < 100; i++) list = M.pushAlerts(list, [{ id: String(i) }]);
  assert.equal(list.length, M.MAX_ALERTS); assert.equal(list[0].id, '99');
});

test('history: sports event points per contract, non-sports series segments, garbage dropped', () => {
  const h = M.historyFor(fx('event-nhl.json'), 'sports_winner|nhl:2026020066|team:17');
  assert.equal(h.kalshi.length, 1); assert.ok(h.kalshi[0].length > 50);
  assert.ok(h.polymarket[0].length > 3);
  for (const s of [...h.kalshi, ...h.polymarket]) for (let i = 1; i < s.length; i++) assert.ok(s[i].t >= s[i - 1].t);
  const s = M.historyFor(fx('series.json'), 'x');
  assert.ok(s.kalshi.length >= 1);
  assert.deepEqual(M.historyFor({ contract: 'compare-event/1', contracts: [{ canonical_contract_id: 'a', kalshi: { points: [{ t: 'bad', v: 1 }, { t: '2026-10-09T00:00:00Z', v: 'x' }, { t: '2026-10-09T00:00:00Z', v: 20000 }] } }] }, 'a'), { kalshi: [], polymarket: [] });
  assert.deepEqual(M.historyFor(null, 'a'), { kalshi: [], polymarket: [] });
});

test('step path holds each stored value until the next row (no interpolation)', () => {
  const d = M.stepPath([{ t: 0, v: 5000 }, { t: 50, v: 6000 }], { t0: 0, t1: 100, v0: 5000, v1: 6000, w: 100, h: 10, until: 100 });
  assert.equal(d, 'M0.0,10.0H50.0V0.0H100.0');
  assert.equal(M.stepPath([], { t0: 0, t1: 1, v0: 0, v1: 1, w: 1, h: 1 }), '');
  assert.equal(M.chartDomain({ kalshi: [], polymarket: [] }), null);
});

test('sequencer drops out-of-order responses', () => {
  const s = M.sequencer();
  const a = s.next('desk'), b = s.next('desk');
  assert.equal(s.isLatest('desk', a), false); assert.equal(s.isLatest('desk', b), true);
  assert.equal(s.isLatest('live', s.next('live')), true);
});

test('saved ids: only strings, deduped, capped; V1 watchlist keys migrate', () => {
  assert.deepEqual(M.parseIds('not json', 5), []);
  assert.deepEqual(M.parseIds('[1,"a","a",{"x":1},"b"]', 1), ['a']);
  assert.deepEqual(M.migrateV1(['nhl:2026020066:sports_winner|nhl:2026020066|team:17', ':PBE-X:PBE-X|Y', 'junk']),
    ['nhl:2026020066|sports_winner|nhl:2026020066|team:17', 'nonsports:PBE-X|PBE-X|Y']);
});

test('scopesFor covers saved keys with at most one desk read per lane, whole sports desk past two sports', () => {
  assert.deepEqual(M.scopesFor(['nhl:1|a', 'nhl:2|b']), ['nhl']);
  assert.deepEqual(M.scopesFor(['nhl:1|a', 'nonsports:X|y']), ['nhl', 'nonsports']);
  assert.deepEqual(M.scopesFor(['nhl:1|a', 'nba:2|b', 'mlb:3|c']), ['sports']);
  assert.equal(M.covers('sports', 'nhl'), true); assert.equal(M.covers('sports', 'nonsports'), false);
});
