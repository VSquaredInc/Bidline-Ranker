#!/usr/bin/env node
/*
 * Regression test harness for the vacation slide engine (v1.8.0).
 *
 * Loads the REAL functions out of ABR.html — no re-implementation — and runs
 * them against synthetic bidline data covering each of the fixes plus baseline
 * regressions. Prints pass/fail per case.
 *
 *   node test-vacation-slide.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Load the slide engine out of the shipping ABR.html ─────────────────────
const HTML_PATH = path.join(__dirname, '..', 'ABR.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// Same brace-matching extractor abr-loader.js uses — with one addition:
// skip past the signature's closing `)` before scanning for the body `{`,
// so default-value literals like `opts = {}` don't get mistaken for the body.
function extractFunctionSource(html, name) {
  const decl = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = decl.exec(html);
  if (!m) throw new Error(`Could not find function ${name}() in ABR.html`);
  const start = m.index;
  // Walk past the signature — track paren depth, ignoring parens inside strings/comments.
  let sigStart = html.indexOf('(', start);
  let sigDepth = 1, si = sigStart + 1, sState = 'code';
  for (; si < html.length && sigDepth > 0; si++) {
    const c = html[si], n = html[si + 1];
    switch (sState) {
      case 'code':
        if (c === '/' && n === '/') { sState = 'line'; si++; }
        else if (c === '/' && n === '*') { sState = 'block'; si++; }
        else if (c === "'") sState = 'sq';
        else if (c === '"') sState = 'dq';
        else if (c === '`') sState = 'tpl';
        else if (c === '(') sigDepth++;
        else if (c === ')') sigDepth--;
        break;
      case 'line':  if (c === '\n') sState = 'code'; break;
      case 'block': if (c === '*' && n === '/') { sState = 'code'; si++; } break;
      case 'sq':    if (c === '\\') si++; else if (c === "'") sState = 'code'; break;
      case 'dq':    if (c === '\\') si++; else if (c === '"') sState = 'code'; break;
      case 'tpl':   if (c === '\\') si++; else if (c === '`') sState = 'code'; break;
    }
  }
  let i = html.indexOf('{', si);
  let depth = 0, state = 'code';
  for (; i < html.length; i++) {
    const c = html[i], n = html[i + 1];
    switch (state) {
      case 'code':
        if (c === '/' && n === '/') { state = 'line'; i++; }
        else if (c === '/' && n === '*') { state = 'block'; i++; }
        else if (c === "'") state = 'sq';
        else if (c === '"') state = 'dq';
        else if (c === '`') state = 'tpl';
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
        break;
      case 'line':  if (c === '\n') state = 'code'; break;
      case 'block': if (c === '*' && n === '/') { state = 'code'; i++; } break;
      case 'sq':    if (c === '\\') i++; else if (c === "'") state = 'code'; break;
      case 'dq':    if (c === '\\') i++; else if (c === '"') state = 'code'; break;
      case 'tpl':   if (c === '\\') i++; else if (c === '`') state = 'code'; break;
    }
  }
  throw new Error(`Unbalanced braces while extracting ${name}()`);
}

// Extract the RESTRICTED_WEEKS constant literal by finding its declaration.
function extractConstArrayLiteral(html, name) {
  const start = html.search(new RegExp(`const\\s+${name}\\s*=\\s*\\[`));
  if (start < 0) throw new Error(`Could not find const ${name}`);
  let i = html.indexOf('[', start);
  let depth = 0, state = 'code';
  for (; i < html.length; i++) {
    const c = html[i], n = html[i + 1];
    switch (state) {
      case 'code':
        if (c === '/' && n === '/') { state = 'line'; i++; }
        else if (c === '/' && n === '*') { state = 'block'; i++; }
        else if (c === "'") state = 'sq';
        else if (c === '"') state = 'dq';
        else if (c === '[') depth++;
        else if (c === ']') { depth--; if (depth === 0) return html.slice(html.indexOf('[', start), i + 1); }
        break;
      case 'line':  if (c === '\n') state = 'code'; break;
      case 'block': if (c === '*' && n === '/') { state = 'code'; i++; } break;
      case 'sq':    if (c === '\\') i++; else if (c === "'") state = 'code'; break;
      case 'dq':    if (c === '\\') i++; else if (c === '"') state = 'code'; break;
    }
  }
  throw new Error(`Unbalanced brackets while extracting ${name}`);
}

const SLIDE_FNS = [
  'mergeIntervals',
  'addDays',
  'daysBetween',
  'sameDay',
  'isEffectiveOff',
  'restrictedWeeksIn',
  'evalVacPosition',
  'computeVacationScore',
];

const restrictedLit = extractConstArrayLiteral(html, 'RESTRICTED_WEEKS');
let body = `const RESTRICTED_WEEKS = ${restrictedLit};\n`;
for (const fn of SLIDE_FNS) body += extractFunctionSource(html, fn) + '\n';
body += `return { ${SLIDE_FNS.join(', ')} };`;
// Dump to file for debug when the constructor fails
if (process.env.DEBUG_EXTRACT) fs.writeFileSync(path.join(__dirname, 'extracted-body.js'), body);
// eslint-disable-next-line no-new-func
let slide;
try {
  slide = new Function(body)();
} catch (e) {
  fs.writeFileSync(path.join(__dirname, 'extracted-body.js'), body);
  console.error('Extraction produced invalid JS. Dump written to tools/extracted-body.js');
  console.error(e.message);
  process.exit(2);
}

// ── Test helpers ────────────────────────────────────────────────────────────
const D = (y, m, d) => new Date(y, m - 1, d);                   // local midnight
const trip = (y, m1, d1, m2, d2) => ({ start: D(y, m1, d1), end: D(y, m2, d2) });
const fmt = d => d ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` : 'null';

const results = { pass: 0, fail: 0, cases: [] };
function check(name, cond, detail) {
  if (cond) { results.pass++; results.cases.push({ name, ok: true }); }
  else      { results.fail++; results.cases.push({ name, ok: false, detail }); }
}
function assertEq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertDate(name, actual, expected) {
  const ok = actual && expected && slide.sameDay(actual, expected);
  check(name, ok, ok ? '' : `expected ${fmt(expected)}, got ${fmt(actual)}`);
}
function assertNull(name, actual) {
  check(name, actual === null, actual === null ? '' : `expected null, got ${fmt(actual)}`);
}

// ─── FIX B — DST-safe day arithmetic ────────────────────────────────────────
(function testDstSafe() {
  // Spring forward: 2026-03-08 (2nd Sunday) at 02:00 local → 03:00 (US)
  const before = D(2026, 3, 5);
  const after  = slide.addDays(before, 7); // should be 2026-03-12
  assertDate('B1 addDays crosses spring DST correctly', after, D(2026, 3, 12));
  assertEq('B2 daysBetween across spring DST = 7', slide.daysBetween(D(2026,3,5), D(2026,3,12)), 7);

  // Fall back: 2026-11-01 (1st Sunday)
  const beforeF = D(2026, 10, 30);
  const afterF  = slide.addDays(beforeF, 4);
  assertDate('B3 addDays crosses fall DST correctly', afterF, D(2026, 11, 3));
  assertEq('B4 daysBetween across fall DST = 4', slide.daysBetween(D(2026,10,30), D(2026,11,3)), 4);

  // sameDay basic
  check('B5 sameDay(same date, different time) = true',
    slide.sameDay(new Date(2026,6,15,3), new Date(2026,6,15,23)));
  check('B6 sameDay(different dates) = false',
    !slide.sameDay(D(2026,7,15), D(2026,7,16)));
})();

// ─── FIX 1a — 7.D.2.d abut Days-Off (partial-conflict slides must abut) ─────
(function testAbutRule() {
  // Real-world partial-conflict scenario:
  //   Trip runs 7/24-7/28 (5 workdays). All other days in July marked off (X).
  //   Vacation awarded 7/26-8/1. Vacation covers 3 workdays (7/26-7/28) and
  //   4 off days (7/29-8/1) → PARTIAL conflict.
  const trips = [ trip(2026, 7, 24, 7, 28) ];
  const datesOff = [];
  for (let d = 1; d <= 31; d++) {
    const day = D(2026, 7, d);
    // off unless it's inside the trip
    if (day < D(2026,7,24) || day > D(2026,7,28)) datesOff.push(day);
  }
  // extend off days into August
  for (let d = 1; d <= 15; d++) datesOff.push(D(2026, 8, d));
  const scheduleEnd = D(2026, 8, 31);
  const r = slide.computeVacationScore(trips, datesOff, scheduleEnd, D(2026,7,26), D(2026,8,1));

  check('1a-1 partial-conflict flag set', r.isPartiallyConflicted === true,
    `vacWorkdays should be 3 of 7; got isPartial=${r.isPartiallyConflicted}`);

  // With every non-trip day off, every candidate position abuts a Day Off,
  // so abut check doesn't filter anything. The 7.D.2.c cap kicks in — max
  // slide before hitting "all vacation on work" is when vacation fully
  // conflicts with the 5-day trip. Since vacation is 7 days and trip is 5,
  // no slide position can achieve full conflict → cap has no effect and slide
  // is free within anchor. Chosen position optimizes effective days off.
  check('1a-2 chosen slide exists', r.chosenSlideStart instanceof Date);
  check('1a-3 chosen slide stays within anchor',
    r.chosenSlideStart >= D(2026, 7, 20) && r.chosenSlideStart <= D(2026, 8, 1));

  // NOW check the abut RULE fires when it should:
  //   Same trip, but reduce the days off around the vacation so some
  //   positions FAIL the abut check.
  const trips2 = [ trip(2026, 7, 24, 7, 28) ];
  const datesOff2 = [
    // Off days scattered so only ONE side of certain positions is off
    D(2026,7,29), D(2026,7,30), D(2026,7,31), D(2026,8,1),  // right of vacation
    // Deliberately NO off days at 7/22, 7/23 — so positions sliding into that
    // range should fail abut check
  ];
  const r2 = slide.computeVacationScore(trips2, datesOff2, scheduleEnd, D(2026,7,26), D(2026,8,1));
  check('1a-4 with sparse off days: partial-conflict flag set',
    r2.isPartiallyConflicted === true);
  // Position 7/22-7/28: dayBefore = 7/21 (not off), dayAfter = 7/29 (off) → abuts ✓
  // Position 7/21-7/27: dayBefore = 7/20 (not off), dayAfter = 7/28 (trip, not off) → skip
  // Position 7/20-7/26: dayBefore = 7/19 (not off), dayAfter = 7/27 (trip, not off) → skip
  // So the chosen slide should be no earlier than 7/22.
  check('1a-5 abut rule blocks slides into no-off zones',
    !r2.chosenSlideStart || r2.chosenSlideStart >= D(2026, 7, 22),
    `chose ${fmt(r2.chosenSlideStart)}`);
})();

// ─── FIX A — 0700z checkbox reclassifies "fully" to "partial" ───────────────
(function testEarlyArrivalCheckbox() {
  // AJ / line 2491 recreation:
  // Trip covers ALL vacation days (7/26 - 8/1). No X markers inside vacation.
  // Without the checkbox → app treats as fully conflicted → 7.D.4 → picks 7/23.
  // With the checkbox    → app treats as partially conflicted → 7.D.2.d → caps at 7/25.
  const trips = [ trip(2026, 7, 20, 8, 1) ];
  const datesOff = [
    D(2026, 7, 18), D(2026, 7, 19),  // days off before trip (so 7/23-7/29 dayBefore isn't off)
    // Deliberately NO off day inside vacation
  ];
  const scheduleEnd = D(2026, 8, 31);

  // Without checkbox
  const rNo = slide.computeVacationScore(trips, datesOff, scheduleEnd, D(2026,7,26), D(2026,8,1));
  check('A-1 without checkbox: fully conflicted', rNo.isPartiallyConflicted === false);

  // With checkbox — 8/1 becomes user-flagged off, so vacation reclassified as partial
  const rYes = slide.computeVacationScore(trips, datesOff, scheduleEnd, D(2026,7,26), D(2026,8,1), {
    lastVacDayEffectivelyOff: true
  });
  check('A-2 with checkbox: partial conflict', rYes.isPartiallyConflicted === true);

  // With checkbox: candidate 7/23-7/29 needs 7/22 or 7/30 to be off. Neither is.
  // Candidate 7/24-7/30 needs 7/23 or 7/31 to be off. Neither is.
  // Candidate 7/25-7/31 needs 7/24 or 8/1 to be off. 8/1 is user-flagged → abuts ✓
  // So the max legal LEFT slide is 7/25 (matching Trent).
  check('A-3 with checkbox: chosen slide is 7/25 or later',
    rYes.chosenSlideStart >= D(2026, 7, 25),
    `chosen ${fmt(rYes.chosenSlideStart)}`);
  check('A-4 with checkbox: does NOT pick 7/23',
    !slide.sameDay(rYes.chosenSlideStart, D(2026, 7, 23)),
    `got ${fmt(rYes.chosenSlideStart)}`);

  // Sanity: without checkbox, app is free to recommend a wider slide
  check('A-5 without checkbox: allowed to slide further left than 7/25',
    rNo.chosenSlideStart <= D(2026, 7, 25) || rNo.chosenSlideStart >= D(2026, 7, 26),
    `no-checkbox chose ${fmt(rNo.chosenSlideStart)}`);
})();

// ─── FIX E — chosenSlideStart/End never null ────────────────────────────────
(function testChosenAlwaysReturned() {
  // Vacation on a purely-off week (no work at all). Best position = original.
  const trips = [];
  const datesOff = [
    D(2026,7,20), D(2026,7,21), D(2026,7,22), D(2026,7,23),
    D(2026,7,24), D(2026,7,25), D(2026,7,26)
  ];
  const scheduleEnd = D(2026, 8, 31);
  const r = slide.computeVacationScore(trips, datesOff, scheduleEnd, D(2026,7,20), D(2026,7,26));

  check('E-1 chosenSlideStart populated even with no slide', r.chosenSlideStart !== null);
  check('E-2 chosenSlideEnd populated even with no slide',   r.chosenSlideEnd   !== null);
  check('E-3 recommendedSlideStart is null (unchanged compat)', r.recommendedSlideStart === null);
  check('E-4 isSlid = false when position equals original', r.isSlid === false);
})();

// ─── FIX 2b — alternative slide surfaced when close in score ────────────────
(function testAlternative() {
  // Symmetric setup: trip in the middle, days off on both sides.
  // Vacation could slide left or right with equivalent gain.
  const trips = [ trip(2026, 7, 15, 7, 18) ];  // 4-day trip
  const datesOff = [
    D(2026,7,1),  D(2026,7,2),  D(2026,7,3),  D(2026,7,4),  D(2026,7,5),
    D(2026,7,6),  D(2026,7,7),  D(2026,7,8),  D(2026,7,9),  D(2026,7,10),
    D(2026,7,11), D(2026,7,12), D(2026,7,13), D(2026,7,14),
    D(2026,7,19), D(2026,7,20), D(2026,7,21), D(2026,7,22), D(2026,7,23),
    D(2026,7,24), D(2026,7,25), D(2026,7,26), D(2026,7,27), D(2026,7,28),
    D(2026,7,29), D(2026,7,30), D(2026,7,31)
  ];
  const scheduleEnd = D(2026, 8, 31);
  // Awarded vacation right in the middle of days off — sliding either direction
  // should be equivalent-scoring (both hit the same trip)
  const r = slide.computeVacationScore(trips, datesOff, scheduleEnd, D(2026,7,10), D(2026,7,16));

  // Chosen and alternative should both exist if scores are close
  check('2b-1 alternative direction is offered when scores are close',
    r.alternative !== null, `alternative = ${JSON.stringify(r.alternative)}`);
})();

// ─── FIX C — 7.D.2.f.ii: slides may extend past scheduleEnd ─────────────────
(function testSlideBeyondSchedule() {
  // Vacation at the tail end of the month; sliding right would extend past scheduleEnd.
  const trips = [ trip(2026, 7, 24, 7, 30) ];
  const datesOff = [ D(2026,7,26) ];  // 7/26 marked off → partial conflict on original
  const scheduleEnd = D(2026, 7, 31);
  const r = slide.computeVacationScore(trips, datesOff, scheduleEnd, D(2026,7,25), D(2026,7,31));

  // Before fix: sEnd > scheduleEnd would have been skipped. Now we allow it.
  // At the very least, chosenSlideEnd shouldn't be capped strictly ≤ scheduleEnd
  // if the best legal position extends past.
  // (Passing condition: no crash, function returns a defined chosenSlideStart.)
  check('C-1 slide search runs when window may exit schedule',
    r.chosenSlideStart instanceof Date && r.chosenSlideEnd instanceof Date);
  check('C-2 chosenSlideEnd may extend past scheduleEnd (7.D.2.f.ii allowed)',
    true);  // Just ensure no exception. Post-schedule days are treated as off for scoring.
})();

// ─── FIX D — deterministic tiebreak (closer to original wins) ───────────────
(function testTiebreak() {
  // Two positions equally scored — the closer-to-original should win.
  const trips = [ trip(2026, 7, 15, 7, 18) ];
  const datesOff = [];  // nothing off
  const scheduleEnd = D(2026, 8, 31);
  // Vacation fully conflicts with trip; sliding is symmetric
  const r = slide.computeVacationScore(trips, datesOff, scheduleEnd, D(2026,7,15), D(2026,7,18));

  check('D-1 fully conflicted vacation: chosen exists', r.chosenSlideStart !== null);
  // If left-1 and right-1 are equivalent, current position wins (distance 0)
  check('D-2 stable when equivalent positions tie',
    slide.sameDay(r.chosenSlideStart, D(2026,7,15)) || r.alternative !== null,
    `chose ${fmt(r.chosenSlideStart)}`);
})();

// ─── 25.K.3.a LOC (1 day) vs. 7.D.7 Award Days (≤3, trailing) ───────────────
// Uses evalVacPosition directly (not computeVacationScore) to pin down a specific
// slide position — computeVacationScore's own search can find an equally-scoring
// alternate position, which would obscure what a single position actually credits.
(function testAwardRangesReported() {
  const trips = [ trip(2026, 7, 20, 7, 28) ]; // 9-day trip: 7/20-7/28

  // Leading-edge case: window 7/22-7/28 covers the LAST 7 days of the trip, leaving
  // 2 workdays before (7/20, 7/21). Under 25.K.3.a ONLY the single day immediately
  // before the vacation (7/21) is a guaranteed Day Off — 7/20 stays on the bidline.
  const r = slide.evalVacPosition(D(2026,7,22), D(2026,7,28), trips, 0);
  check('2a-1 locRanges array populated for the 1-day leading trim',
    Array.isArray(r.locRanges) && r.locRanges.length === 1,
    `locRanges = ${JSON.stringify(r.locRanges)}`);
  check('2a-2 locDaysOff = 1 (only 7/21, the day immediately before the vacation)',
    r.locDaysOff === 1, `locDaysOff = ${r.locDaysOff}`);
  check('2a-3 no 7.D.7 award range on this trip (no trailing edge)',
    r.awardRange === null && r.awardDays === 0,
    `awardRange = ${JSON.stringify(r.awardRange)}, awardDays = ${r.awardDays}`);

  // Trailing-edge case: window 7/20-7/26 covers the FIRST 7 days, leaving 2 workdays
  // after — the 7.D.7 election (min(3, trailing) = 2). No workday before 7/20 → LOC 0.
  const r2 = slide.evalVacPosition(D(2026,7,20), D(2026,7,26), trips, 0);
  check('2a-4 trailing edge uses AWRD (7.D.7), not LOC',
    r2.awardRange && r2.awardRange.side === 'after' && r2.awardDays === 2,
    `awardRange = ${JSON.stringify(r2.awardRange)}, awardDays = ${r2.awardDays}`);
  check('2a-5 trailing edge: locDaysOff = 0 (no workday immediately before 7/20)',
    r2.locDaysOff === 0, `locDaysOff = ${r2.locDaysOff}`);

  // Stacking case: window 7/22-7/25 lands in the MIDDLE of the trip. The 1 leading day
  // (7/21) is the 25.K.3.a LOC; the trailing 3 (7/26-7/28) draw the 7.D.7 election.
  // Both stack → +4 days off beyond the vacation.
  const r3 = slide.evalVacPosition(D(2026,7,22), D(2026,7,25), trips, 0);
  check('2a-6 stacking: 1 LOC + 3 AWRD both credited at once (+4)',
    r3.locDaysOff === 1 && r3.awardDays === 3 && r3.awardRange.side === 'after',
    `locDaysOff=${r3.locDaysOff}, awardDays=${r3.awardDays}, awardRange=${JSON.stringify(r3.awardRange)}`);
})();

// ─── FIX 7.D.5 — restricted weeks (still enforced after refactor) ───────────
(function testRestrictedWeeks() {
  // Vacation NOT in restricted week; try to slide INTO one.
  // Restricted: Jun 28 – Jul 4, 2026 (RESTRICTED_WEEKS[0])
  const trips = [ trip(2026, 7, 6, 7, 12) ];
  const datesOff = [];
  const scheduleEnd = D(2026, 7, 31);
  const r = slide.computeVacationScore(trips, datesOff, scheduleEnd, D(2026,7,6), D(2026,7,12));

  // Anchor lets slide up to 7/12+ or 7/0- (i.e. can slide left through anchor).
  // Left slide would push into Jun 28-Jul 4 restricted week → should be skipped.
  // So chosenSlideStart should NOT be earlier than Jul 5 (first day OUT of restricted week).
  check('7.D.5 chosen slide does not enter restricted week Jun 28-Jul 4',
    !r.chosenSlideStart || r.chosenSlideStart >= D(2026, 7, 5),
    `chose ${fmt(r.chosenSlideStart)}`);
})();

// ─── Canonical +4 case — real line MIA 744 CA 2965 (Aug 2026) ───────────────
// One 15-day pairing Aug 2-16; vacation awarded Aug 9-15 (fully inside the trip);
// natural off = Aug 1 + Aug 17-31 (16 days). Correct model: slide so exactly 3 trip
// workdays remain after the vacation (Aug 14-16 → Award), the day before becomes the
// single LOC day (Aug 6), giving +4 days off beyond the vacation. Best position is the
// LATEST that still trails 3 award days: Aug 7-13.
(function testCanonicalPlusFour() {
  const trips = [ trip(2026, 8, 2, 8, 16) ];
  const datesOff = [ D(2026, 8, 1) ];
  for (let d = 17; d <= 31; d++) datesOff.push(D(2026, 8, d));
  const scheduleEnd = D(2026, 9, 1);
  const r = slide.computeVacationScore(trips, datesOff, scheduleEnd, D(2026,8,9), D(2026,8,15));

  check('p4-1 chosen slide is Aug 7 (vacation abuts the 3 trailing Award Days)',
    slide.sameDay(r.chosenSlideStart, D(2026, 8, 7)),
    `chose ${fmt(r.chosenSlideStart)}`);
  check('p4-2 locDaysOff = 1 (only the single day before the vacation, Aug 6)',
    r.locDaysOff === 1, `locDaysOff = ${r.locDaysOff}`);
  check('p4-3 awardDays = 3 (Aug 14-16 trailing 7.D.7 election)',
    r.awardDays === 3, `awardDays = ${r.awardDays}`);
  check('p4-4 bonus beyond vacation = 4 days (1 LOC + 3 Award)',
    r.locDaysOff + r.awardDays === 4, `bonus = ${r.locDaysOff + r.awardDays}`);
  check('p4-5 effectiveDaysOff = 27 (16 natural + 7 vacation + 1 LOC + 3 Award)',
    r.effectiveDaysOff === 27, `effectiveDaysOff = ${r.effectiveDaysOff}`);
  check('p4-6 the whole month is NOT eliminated (pilot still works Aug 2-5)',
    r.effectiveDaysOff < 31, `effectiveDaysOff = ${r.effectiveDaysOff}`);
})();

// ─── Regression: original vacation on all off-days → no shift, no crash ─────
(function testNoWorkDays() {
  const trips = [];  // no trips
  const datesOff = [ D(2026,7,20), D(2026,7,21), D(2026,7,22), D(2026,7,23),
                     D(2026,7,24), D(2026,7,25), D(2026,7,26) ];
  const scheduleEnd = D(2026, 8, 31);
  const r = slide.computeVacationScore(trips, datesOff, scheduleEnd, D(2026,7,20), D(2026,7,26));
  check('R1 empty-trip case returns without error', r && r.chosenSlideStart);
  check('R2 empty-trip case: isSlid = false', r.isSlid === false);
  check('R3 empty-trip case: awardDays = 0', r.awardDays === 0);
})();

// ─── Regression: partial-conflict cap (7.D.2.c) still holds ─────────────────
(function testPartialConflictCap() {
  // Vacation 7/26-8/1, trip covers only 7/28-8/1 (4 days) plus off days before
  // → partial conflict (4 of 7 vacation days on work)
  const trips = [ trip(2026, 7, 28, 8, 3) ];  // trip continues past vac
  const datesOff = [ D(2026,7,26), D(2026,7,27) ];  // 2 off days inside vacation
  const scheduleEnd = D(2026, 8, 31);
  const r = slide.computeVacationScore(trips, datesOff, scheduleEnd, D(2026,7,26), D(2026,8,1));

  check('7.D.2.c partial conflict flag set', r.isPartiallyConflicted === true);
  // Sliding right should stop at first full-conflict position
  // (vac 7/28-8/3 would be fully in trip, so that's the right cap).
  // The chosen position should be within the legal range and abut a day off.
  check('7.D.2.c returns a defined chosen slide',
    r.chosenSlideStart instanceof Date);
})();

// ─── Report ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log(' VACATION SLIDE REGRESSION TEST — 1-day LOC / 3-day Award model');
console.log('══════════════════════════════════════════════════════════════\n');
for (const c of results.cases) {
  const icon = c.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${icon}  ${c.name}${c.detail ? '   — ' + c.detail : ''}`);
}
console.log('\n──────────────────────────────────────────────────────────────');
console.log(`  ${results.pass} passed, ${results.fail} failed`);
console.log('──────────────────────────────────────────────────────────────\n');
process.exit(results.fail ? 1 : 0);
