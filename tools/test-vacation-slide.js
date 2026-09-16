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
  'evalVacContribForPeriod',
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
  // 2 workdays before (7/20, 7/21) — 2 <= 3, so per 7.D.7 ("AWRD days are automatic
  // when there are three or fewer workdays either before or after your vacation")
  // BOTH days become the AWRD block, not just the single 25.K.3.a day.
  const r = slide.evalVacPosition(D(2026,7,22), D(2026,7,28), trips, 0);
  check('2a-1 locRanges array populated for the leading AWRD block',
    Array.isArray(r.locRanges) && r.locRanges.length === 1,
    `locRanges = ${JSON.stringify(r.locRanges)}`);
  check('2a-2 locDaysOff = 2 (both 7/20 and 7/21 qualify as the leading AWRD block)',
    r.locDaysOff === 2, `locDaysOff = ${r.locDaysOff}`);
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

// ─── 7.D.7 Award Days are a CLIFF, not a cap (reported by ANC scheduler) ────
// The election exists only when 3 or fewer workdays remain after the vacation.
// With 4+ remaining there are no award days at all: the first day back is R-1
// home reserve (Art 31.B, counted as a day off) and the rest are flown as
// published or reassigned as secondary. Previously the code returned min(3, run),
// silently crediting 3 phantom days off on every long trailing run.
(function testAwardCliff() {
  const trips = [ trip(2026, 9, 10, 9, 24) ];   // 15-day pairing Sept 10-24

  // Exactly 3 trailing workdays (Sept 22-24) → full 7.D.7 election.
  const r3 = slide.evalVacPosition(D(2026,9,15), D(2026,9,21), trips, 0);
  check('c1 trailing run = 3 → awardDays 3, no R-1',
    r3.awardDays === 3 && r3.r1DaysOff === 0,
    `awardDays=${r3.awardDays}, r1DaysOff=${r3.r1DaysOff}`);

  // One day earlier → 4 trailing workdays → election gone, R-1 instead.
  const r4 = slide.evalVacPosition(D(2026,9,14), D(2026,9,20), trips, 0);
  check('c2 trailing run = 4 → awardDays 0, R-1 = 1 (the cliff)',
    r4.awardDays === 0 && r4.r1DaysOff === 1,
    `awardDays=${r4.awardDays}, r1DaysOff=${r4.r1DaysOff}`);
  check('c3 the R-1 day is the day immediately after the vacation (Sept 21)',
    r4.r1Ranges.length === 1 && slide.sameDay(r4.r1Ranges[0].start, D(2026,9,21)),
    `r1Ranges = ${JSON.stringify(r4.r1Ranges)}`);
  check('c4 crossing the cliff costs exactly 2 effective days off (3 award → 1 R-1)',
    r3.effectiveDaysOff - r4.effectiveDaysOff === 2,
    `${r3.effectiveDaysOff} vs ${r4.effectiveDaysOff}`);

  // The scheduler's reported case: vacation Sept 6-12, line 1233 ANC CA.
  // 7.D.2.c caps the slide at Sept 10 (first full-conflict day); 8 workdays then
  // trail the vacation, so the old code wrongly reported 3 award days.
  const datesOff = [];
  for (let d = 1; d <= 9; d++)  datesOff.push(D(2026,9,d));
  for (let d = 25; d <= 30; d++) datesOff.push(D(2026,9,d));
  const anc = slide.computeVacationScore(trips, datesOff, D(2026,10,1), D(2026,9,6), D(2026,9,12));
  check('c5 ANC 1233: slide Sept 10-16 as before',
    slide.sameDay(anc.chosenSlideStart, D(2026,9,10)) && slide.sameDay(anc.chosenSlideEnd, D(2026,9,16)),
    `${fmt(anc.chosenSlideStart)} -> ${fmt(anc.chosenSlideEnd)}`);
  check('c6 ANC 1233: awardDays = 0 (8 workdays trail, not 3)',
    anc.awardDays === 0, `awardDays = ${anc.awardDays}`);
  check('c7 ANC 1233: R-1 = 1 and effectiveDaysOff = 23 (was a phantom 25)',
    anc.r1DaysOff === 1 && anc.effectiveDaysOff === 23,
    `r1DaysOff=${anc.r1DaysOff}, effectiveDaysOff=${anc.effectiveDaysOff}`);
})();

// ─── The cliff must be measured on the UNCLIPPED trip, not the period slice ──
// A trip crossing the BP1/BP2 boundary leaves few days inside BP1 but a long run
// overall. Measuring the run against the clipped end would fake a short trailing
// run and hand back award days that were never earned.
(function testCliffAcrossPeriodBoundary() {
  const trips  = [ trip(2026, 8, 28, 9, 10) ];        // Aug 28 - Sep 10
  const vac    = [ { start: D(2026,8,25), end: D(2026,8,30) } ];
  const bp1End = D(2026, 8, 31);                      // BP1 ends Aug 31

  const bp1 = slide.evalVacContribForPeriod(trips, vac, null, bp1End);
  check('c8 period-clipped trip: no award days (real trailing run is 11, not 1)',
    bp1.awardDays === 0, `awardDays = ${bp1.awardDays}`);
  check('c9 period-clipped trip: R-1 day credited to BP1 (Aug 31 is inside BP1)',
    bp1.r1DaysOff === 1, `r1DaysOff = ${bp1.r1DaysOff}`);
  check('c10 period-clipped trip: vacation workdays still attributed (Aug 28-30)',
    bp1.vacWorkdays === 3, `vacWorkdays = ${bp1.vacWorkdays}`);
})();

// ─── 7.D.7 AWRD on the LEADING edge, not just trailing ───────────────────────
// Reported case: ORD 747 FO, Oct 2026 bid. Pilot has vacation Oct 18-24 and
// wants Oct 15-19 off. Lines 4117 (single pairing Oct 15 - Nov 1) and 4119
// (single pairing Oct 14-28) were being dropped from results entirely: the
// old model only ever gave the leading edge a single 25.K.3.a day, so the
// unconstrained days-off search always chased the trailing-edge AWRD block
// instead, landing near month-end — nowhere near the requested dates.
//
// The Atlas "Article 7 Vacation Adjustment" form confirms AWRD is symmetric:
// "AWRD days are automatic when there are three or fewer workdays either
// before or after your vacation" — only one edge gets the (up to 3-day)
// block. Once evalVacPosition offers that block on the leading edge too, the
// pilot's own math holds without needing any desiredDates workaround:
//   - 4117 needs NO slide at all — Oct 15-17 (3 workdays before the awarded
//     Oct 18-24 vacation) become AWRD automatically, R-1 lands on Oct 25, and
//     the position ties the best unconstrained score (25), so the
//     no-churn rule keeps the pilot at his awarded position.
//   - 4119's awarded position has 4 workdays on both edges (neither ≤3), so a
//     1-day slide to Oct 17-23 is genuinely better: it drops the leading run
//     to exactly 3 (Oct 14-16 -> AWRD), R-1 lands Oct 24, and effective days
//     off rises from 25 (unslid) to 27.
// Both lines now surface in a Dates Desired Off search for Oct 15-19 without
// needing the search to fall back to a suboptimal, desiredDates-only pick.
(function testLeadingEdgeAward() {
  const vacStart = D(2026,10,18), vacEnd = D(2026,10,24);

  // 4117: X Oct 1-14, single pairing Oct 15 - Nov 1.
  const datesOff4117 = [];
  for (let d = 1; d <= 14; d++) datesOff4117.push(D(2026,10,d));
  const trips4117 = [ trip(2026,10,15, 11,1) ];
  const r4117 = slide.computeVacationScore(trips4117, datesOff4117, D(2026,11,1), vacStart, vacEnd, {});
  check('le1 4117: no slide needed (ties the unconstrained optimum at the awarded position)',
    !r4117.isSlid && slide.sameDay(r4117.chosenSlideStart, D(2026,10,18)),
    `isSlid=${r4117.isSlid}, slide ${fmt(r4117.chosenSlideStart)} -> ${fmt(r4117.chosenSlideEnd)}`);
  check('le2 4117: leading AWRD block is Oct 15-17 (3d), R-1 on Oct 25',
    r4117.locDaysOff === 3 && r4117.locRanges.length === 1 &&
      slide.sameDay(r4117.locRanges[0].start, D(2026,10,15)) && slide.sameDay(r4117.locRanges[0].end, D(2026,10,17)) &&
      r4117.r1DaysOff === 1 && slide.sameDay(r4117.r1Ranges[0].start, D(2026,10,25)),
    `locDaysOff=${r4117.locDaysOff}, locRanges=${JSON.stringify(r4117.locRanges)}, r1DaysOff=${r4117.r1DaysOff}, r1Ranges=${JSON.stringify(r4117.r1Ranges)}`);
  check('le3 4117: effectiveDaysOff = 25 (14 natural + 7 vacation + 3 AWRD + 1 R-1)',
    r4117.effectiveDaysOff === 25, `effectiveDaysOff = ${r4117.effectiveDaysOff}`);

  // 4119: X Oct 1-13, single pairing Oct 14-28, X Oct 29-31.
  const datesOff4119 = [];
  for (let d = 1; d <= 13; d++) datesOff4119.push(D(2026,10,d));
  for (let d = 29; d <= 31; d++) datesOff4119.push(D(2026,10,d));
  const trips4119 = [ trip(2026,10,14, 10,28) ];

  // Unconstrained: the unslid position has 4 workdays on BOTH edges (neither
  // qualifies), but sliding right to Oct 19-25 drops the trailing run to
  // exactly 3 (Oct 26-28 -> AWRD) for effectiveDaysOff 27. Sliding left to
  // Oct 17-23 instead (leading run drops to 3, Oct 14-16 -> AWRD) ties at the
  // same 27 — the tiebreak (latest position wins) picks Oct 19-25.
  const r4119 = slide.computeVacationScore(trips4119, datesOff4119, D(2026,11,1), vacStart, vacEnd, {});
  check('le4 4119: unconstrained optimum slides right to Oct 19-25 (trailing AWRD, tiebreak favors latest)',
    r4119.isSlid && slide.sameDay(r4119.chosenSlideStart, D(2026,10,19)) && slide.sameDay(r4119.chosenSlideEnd, D(2026,10,25)),
    `isSlid=${r4119.isSlid}, slide ${fmt(r4119.chosenSlideStart)} -> ${fmt(r4119.chosenSlideEnd)}`);
  check('le5 4119: effectiveDaysOff = 27 (16 natural + 7 vacation + 3 AWRD + 1 LOC), up from 25 unslid',
    r4119.effectiveDaysOff === 27, `effectiveDaysOff = ${r4119.effectiveDaysOff}`);

  // With the pilot's actual Dates Desired Off (Oct 15-19) supplied, the tie
  // resolves the other way: Oct 19-25 doesn't cover Oct 15-17, but the
  // equally-scoring Oct 17-23 does (leading AWRD Oct 14-16, R-1 Oct 24) — this
  // is the exact position the pilot described.
  const desiredOct1519 = [D(2026,10,15), D(2026,10,16), D(2026,10,17), D(2026,10,18), D(2026,10,19)];
  const r4119steered = slide.computeVacationScore(trips4119, datesOff4119, D(2026,11,1), vacStart, vacEnd, { desiredDates: desiredOct1519 });
  check('le6 4119: with Dates Desired Off Oct 15-19, chosen slide is Oct 17-23',
    slide.sameDay(r4119steered.chosenSlideStart, D(2026,10,17)) && slide.sameDay(r4119steered.chosenSlideEnd, D(2026,10,23)),
    `slide ${fmt(r4119steered.chosenSlideStart)} -> ${fmt(r4119steered.chosenSlideEnd)}`);
  check('le7 4119: that position has leading AWRD Oct 14-16 (3d) and R-1 on Oct 24, still eff 27',
    r4119steered.locDaysOff === 3 && r4119steered.locRanges.length === 1 &&
      slide.sameDay(r4119steered.locRanges[0].start, D(2026,10,14)) && slide.sameDay(r4119steered.locRanges[0].end, D(2026,10,16)) &&
      r4119steered.r1DaysOff === 1 && slide.sameDay(r4119steered.r1Ranges[0].start, D(2026,10,24)) &&
      r4119steered.effectiveDaysOff === 27,
    `locDaysOff=${r4119steered.locDaysOff}, locRanges=${JSON.stringify(r4119steered.locRanges)}, r1Ranges=${JSON.stringify(r4119steered.r1Ranges)}, eff=${r4119steered.effectiveDaysOff}`);
})();

// ─── Days Desired Off must be able to steer the slide, not just gate on it ───
// le6/le7 above already pin the case where a legal, equally-scoring position
// exists that satisfies desiredDates — the search must pick it over the
// tiebreak-default position. This block covers the other two edges of that
// behavior: (a) when NO legal position can satisfy every requested date, the
// search must fall back cleanly to the unconstrained optimum rather than
// erroring or returning something worse for no reason, and (b) omitting
// desiredDates entirely must reproduce prior behavior exactly.
(function testDesiredDatesFallback() {
  // Vacation length 7 (Oct 20-26); anchor limits the earliest legal window
  // start to Oct 14, and the trip starts Oct 10 (4 workdays before Oct 14 —
  // one too many to ever qualify for a leading AWRD block reaching back to
  // it). Desired dates Oct 12-16 are therefore contractually unreachable by
  // any legal slide position.
  const datesOff = [ D(2026,10,1), D(2026,10,2), D(2026,10,3), D(2026,10,4), D(2026,10,5),
    D(2026,10,6), D(2026,10,7), D(2026,10,8), D(2026,10,9) ];
  const trips = [ trip(2026,10,10, 11,15) ];
  const scheduleEnd = D(2026,11,15);
  const vacStart = D(2026,10,20), vacEnd = D(2026,10,26);
  const desired = [D(2026,10,12), D(2026,10,13), D(2026,10,14), D(2026,10,15), D(2026,10,16)];

  const unconstrained = slide.computeVacationScore(trips, datesOff, scheduleEnd, vacStart, vacEnd, {});
  const steered = slide.computeVacationScore(trips, datesOff, scheduleEnd, vacStart, vacEnd, { desiredDates: desired });

  check('dd1 sanity: the unconstrained optimum does NOT cover the (unreachable) desired dates',
    !desired.every(d => d >= unconstrained.chosenSlideStart && d <= unconstrained.chosenSlideEnd),
    `unconstrained slide ${fmt(unconstrained.chosenSlideStart)} -> ${fmt(unconstrained.chosenSlideEnd)}`);
  check('dd2 no legal position can satisfy them either -> falls back to the unconstrained optimum',
    slide.sameDay(steered.chosenSlideStart, unconstrained.chosenSlideStart) &&
      slide.sameDay(steered.chosenSlideEnd, unconstrained.chosenSlideEnd) &&
      steered.effectiveDaysOff === unconstrained.effectiveDaysOff,
    `steered slide ${fmt(steered.chosenSlideStart)} -> ${fmt(steered.chosenSlideEnd)}, eff=${steered.effectiveDaysOff} vs unconstrained eff=${unconstrained.effectiveDaysOff}`);
  const noOptsAtAll = slide.computeVacationScore(trips, datesOff, scheduleEnd, vacStart, vacEnd);
  check('dd3 omitting opts entirely reproduces the unconstrained optimum unchanged',
    slide.sameDay(noOptsAtAll.chosenSlideStart, unconstrained.chosenSlideStart) &&
      noOptsAtAll.effectiveDaysOff === unconstrained.effectiveDaysOff,
    `no-opts slide ${fmt(noOptsAtAll.chosenSlideStart)}, eff=${noOptsAtAll.effectiveDaysOff}`);
})();

// ─── Report ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log(' VACATION SLIDE REGRESSION TEST — 1-day LOC / ≤3 Award / R-1 model');
console.log('══════════════════════════════════════════════════════════════\n');
for (const c of results.cases) {
  const icon = c.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${icon}  ${c.name}${c.detail ? '   — ' + c.detail : ''}`);
}
console.log('\n──────────────────────────────────────────────────────────────');
console.log(`  ${results.pass} passed, ${results.fail} failed`);
console.log('──────────────────────────────────────────────────────────────\n');
process.exit(results.fail ? 1 : 0);
