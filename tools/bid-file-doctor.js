#!/usr/bin/env node
//
// Bidline File Doctor
// ===================
// Reviews a month's Atlas Air bid PDFs and reports any format changes that may
// require updates to the Bidline Ranker. It runs the REAL parsers extracted
// from ABR.html (so it catches actual breakage, not a stale re-implementation),
// checks a battery of invariants, and diffs against last month's fingerprint.
//
// Usage:
//   cd tools
//   npm install            # once, to fetch pdfjs-dist
//   node bid-file-doctor.js "../LAX"
//
// Exit code 0 = clean / warnings only, 1 = errors found (CI-friendly).

const fs = require('fs');
const path = require('path');

// Silence pdfjs's harmless "Cannot polyfill DOMMatrix/Path2D" canvas warnings
// (we only extract text, never render). These fire during pdfjs's require via
// console.log, so the filter must be installed before that require runs.
for (const m of ['log', 'warn']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { if (/Cannot polyfill|module 'canvas'/i.test(String(a[0] || ''))) return; orig(...a); };
}

const REPO_ROOT = path.resolve(__dirname, '..');
const ABR_HTML = path.join(REPO_ROOT, 'ABR.html');

let pdfjsLib;
try {
  pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
} catch {
  console.error('pdfjs-dist is not installed. Run "npm install" inside the tools/ folder first.');
  process.exit(2);
}

const { loadAbrParsers, readAppVersion, fileFromPath } = require('./lib/abr-loader');
const fingerprint = require('./lib/fingerprint');

// Line types the app knows how to score (see CLAUDE.md "Line Types").
const KNOWN_TYPES = new Set([
  'Primary Int', 'Primary AdH', 'Primary 60-day Int', 'Primary 60-day AdH',
  'Secondary AdH', 'Secondary 60-day', 'Secondary 60-day AdH',
  'Reserve AdH', 'Reserve 60-day AdH',
]);

const CONTRACT_MIN = 64;        // hours; app floors guarantees below this
const GUARANTEE_HIGH = 100;     // hours; above this is worth a sanity check
const DAYSOFF_MIN = 8, DAYSOFF_MAX = 22;

// ── findings collector ───────────────────────────────────────────────────────
const findings = [];
function add(level, section, msg, hint) { findings.push({ level, section, msg, hint }); }
const ok = (s, m) => add('ok', s, m);
const warn = (s, m, h) => add('warn', s, m, h);
const err = (s, m, h) => add('err', s, m, h);

// ── helpers ──────────────────────────────────────────────────────────────────
function listPdfs(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .map(f => path.join(dir, f));
}

function bidlineFilenameOk(name, pos) {
  const U = name.toUpperCase();
  if (!U.includes('BIDLINE')) return false;
  return new RegExp(`[\\s\\-]+\\s*${pos}(\\s|\\.|$)`).test(U);
}
function creditFilenameOk(name) {
  const U = name.toUpperCase();
  return U.includes('LINES') && U.includes('PERIOD') && !U.includes('VTO') && !U.includes('PRIMARY');
}

function mergedGuarantee(ln, c1, c2) {
  const a = c1 && c1[ln], b = c2 && c2[ln];
  if (a && b) return (a.guarantee + b.guarantee) / 2;
  if (a) return a.guarantee;
  if (b) return b.guarantee;
  return null;
}

function range(nums) {
  if (!nums.length) return null;
  return [Math.min(...nums), Math.max(...nums)].map(n => Math.round(n * 100) / 100);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const folderArg = process.argv[2];
  if (!folderArg) {
    console.log('Usage: node bid-file-doctor.js <folder-with-month-PDFs>\n');
    const candidates = fs.readdirSync(REPO_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'tools' && d.name !== 'backups' && d.name !== 'node_modules')
      .filter(d => { try { return listPdfs(path.join(REPO_ROOT, d.name)).length > 0; } catch { return false; } })
      .map(d => d.name);
    if (candidates.length) console.log('Folders with PDFs you could check:\n  ' + candidates.join('\n  '));
    process.exit(2);
  }
  const folder = path.resolve(folderArg);
  if (!fs.existsSync(folder)) { console.error(`Folder not found: ${folder}`); process.exit(2); }

  const appVersion = readAppVersion(ABR_HTML);
  const parsers = loadAbrParsers(ABR_HTML, pdfjsLib);

  const pdfs = listPdfs(folder);
  if (!pdfs.length) { console.error(`No PDFs in ${folder}`); process.exit(2); }

  // ── classify every PDF using the app's own detector ──────────────────────
  const classified = [];
  for (const p of pdfs) {
    const file = fileFromPath(p);
    let text = '';
    try { text = await parsers.extractTextFromPDF(file); }
    catch (e) { err('Files', `Could not read ${path.basename(p)}: ${e.message}`); continue; }
    const type = parsers.detectFileType(text);
    classified.push({ path: p, name: path.basename(p), file, text, type });
  }

  const bidlineDocs = classified.filter(c => c.type === 'bidline');
  const creditDocs = classified.filter(c => c.type === 'credit');
  const unknownDocs = classified.filter(c => c.type === 'unknown');

  for (const u of unknownDocs) {
    err('Files', `"${u.name}" was not recognized as bidline or credit`,
      'detectFileType() did not match — the PDF title/header format may have changed. Review detectFileType() in ABR.html.');
  }
  if (!bidlineDocs.length) {
    err('Files', 'No bidline schedule PDF found in this folder',
      'The schedule PDF did not match detectFileType()==="bidline". Check the CREW SCHEDULE FROM header / "<AC> <POS>" header pattern.');
  }
  if (bidlineDocs.length > 1) warn('Files', `${bidlineDocs.length} bidline PDFs found; using the first ("${bidlineDocs[0].name}")`);

  const fp = {
    savedAt: new Date().toISOString(),
    appVersion,
    base: null, aircraft: null, position: null, period: null,
  };

  // ── bidline checks (real parseBidlineWithPositions) ──────────────────────
  let bidlineLines = {}, meta = {};
  if (bidlineDocs.length) {
    const doc = bidlineDocs[0];
    parsers.resetBidPeriodStart();
    let res;
    try { res = await parsers.parseBidlineWithPositions(doc.file); }
    catch (e) { err('Bidline', `Parser threw: ${e.message}`, 'parseBidlineWithPositions() failed outright — a structural assumption broke.'); }
    if (res) {
      bidlineLines = res.lines; meta = res.meta || {};
      const count = Object.keys(bidlineLines).length;
      fp.base = meta.baseAirport || null;
      fp.aircraft = meta.aircraftType || null;
      fp.position = meta.crewPosition || null;
      fp.bidlineLineCount = count;

      if (count === 0) err('Bidline', 'Parsed 0 lines from the schedule',
        'Row/column detection failed — the schedule table layout likely changed (parseBidlineWithPositions).');
      else ok('Bidline', `${count} lines parsed`);

      // header / meta
      const bps = parsers.getBidPeriodStart();
      fp.headerDateOk = !!bps;
      if (!bps) err('Bidline', 'CREW SCHEDULE FROM header date not parsed — date defaults will be used',
        'The header regex in parseBidlineWithPositions did not match. All date math (bid period, schedule end) falls back to today. See CLAUDE.md "Bid Cycle Rules".');
      else ok('Bidline', `Bid period start: ${bps.toISOString().slice(0, 10)}`);

      if (!meta.aircraftType || !meta.crewPosition)
        warn('Bidline', `Header fields incomplete (base=${meta.baseAirport || '?'}, ac=${meta.aircraftType || '?'}, pos=${meta.crewPosition || '?'})`,
          'The "<BASE> <AC> <POS>" header pattern did not fully match — check the header regex.');
      else ok('Bidline', `${meta.baseAirport} ${meta.aircraftType} ${meta.crewPosition}`);

      // line types
      const typeHist = {};
      const unknownTypes = {};
      let zeroTrips = 0;
      const daysOffVals = [];
      for (const ln of Object.values(bidlineLines)) {
        typeHist[ln.lineType] = (typeHist[ln.lineType] || 0) + 1;
        if (!KNOWN_TYPES.has(ln.lineType)) unknownTypes[ln.lineType] = (unknownTypes[ln.lineType] || 0) + 1;
        if (!ln.trips || ln.trips.length === 0) zeroTrips++;
        if (typeof ln.daysOffCount === 'number') daysOffVals.push(ln.daysOffCount);
      }
      fp.lineTypeHistogram = typeHist;
      fp.daysOffRange = range(daysOffVals);

      const unknownTotal = Object.values(unknownTypes).reduce((a, b) => a + b, 0);
      if (unknownTotal === 0) ok('Bidline', `Line types all known (${Object.keys(typeHist).length} distinct)`);
      else {
        const detail = Object.entries(unknownTypes).map(([t, c]) => `"${t}"×${c}`).join(', ');
        const lvl = unknownTotal > count * 0.3 ? err : warn;
        lvl('Bidline', `${unknownTotal} line(s) have unrecognized type: ${detail}`,
          'New/renamed line-type label. Add it to the type lists in ABR.html (parseBidline + parseCredit) and KNOWN_TYPES here, and to CLAUDE.md "Line Types".');
      }

      if (daysOffVals.length) {
        const outliers = daysOffVals.filter(d => d < DAYSOFF_MIN || d > DAYSOFF_MAX).length;
        if (outliers) warn('Bidline', `${outliers} line(s) have days-off outside ${DAYSOFF_MIN}-${DAYSOFF_MAX} (range ${fp.daysOffRange.join('-')})`,
          'Off-day (X marker) detection may be mis-counting. See CLAUDE.md "Off-Day Detection".');
        else ok('Bidline', `Days-off per line within ${fp.daysOffRange.join('-')}`);
      }
      if (zeroTrips) warn('Bidline', `${zeroTrips} line(s) parsed with 0 trips`,
        'Trip (working-block) detection may have failed for these lines.');

      // filename vs portal
      if (fp.position) {
        fp.filenameBidlineOk = bidlineFilenameOk(doc.name, fp.position);
        if (fp.filenameBidlineOk) ok('Portal', `Bidline filename matches portal pattern for ${fp.position}`);
        else err('Portal', `Bidline filename "${doc.name}" would NOT be found by the portal fetch`,
          'api/fetch-bid.js requires the name to contain BIDLINE and a separator before the position. Update that matcher (and CLAUDE.md "Portal Folder & File Detection"). Remember to redeploy Vercel.');
      }
    }
  }

  // ── credit checks (real parseCreditFile) ─────────────────────────────────
  const creditData = []; // { name, text, data, format }
  for (const doc of creditDocs) {
    let data = {};
    try { data = await parsers.parseCreditFile(doc.file, doc.text); }
    catch (e) { err('Credit', `Parser threw on "${doc.name}": ${e.message}`); continue; }
    const format = doc.text.includes('SUM OF CREDITS') ? 'geometry-2026' : 'legacy';
    creditData.push({ name: doc.name, text: doc.text, data, format });
  }
  // order by period end so [0]=single month (credit1), [1]=cumulative (credit2)
  creditData.sort((a, b) => periodScore(a.text, parsers) - periodScore(b.text, parsers));
  const c1 = creditData[0] && creditData[0].data;
  const c2 = creditData[1] && creditData[1].data;

  fp.creditFormat = creditData[0] ? creditData[0].format : 'none';
  fp.creditFiles = creditData.map(cd => {
    const vals = Object.values(cd.data);
    const nonZero = vals.filter(v => v.guarantee > 0).length;
    return { name: cd.name, lineCount: vals.length, guaranteeNonZero: nonZero };
  });

  if (!creditData.length) warn('Credit', 'No credit (LINES…PERIOD) PDFs found — guarantees will all fall back to the 64 hr minimum',
    'If credit files exist, their names may have changed (need LINES + PERIOD, not VTO/PRIMARY). See creditFilenameOk / api/fetch-bid.js.');

  let creditLandmarkOk = true;
  for (const cd of creditData) {
    const vals = Object.values(cd.data);
    const nonZero = vals.filter(v => v.guarantee > 0).length;
    if (vals.length === 0) {
      err('Credit', `"${cd.name}" parsed 0 lines (${cd.format})`,
        'Line-number row detection failed. For 2026 format this is the X/Y column layout in parseCreditByGeometry.');
      creditLandmarkOk = false;
    } else if (nonZero === 0) {
      err('Credit', `"${cd.name}" parsed ${vals.length} lines but EVERY guarantee is 0 (${cd.format})`,
        'Guarantee row not found — the credit table format changed. This is the exact failure fixed in v1.7.1; review the ART33 guarantee-row detection in parseCreditByGeometry.');
      creditLandmarkOk = false;
    } else {
      ok('Credit', `"${cd.name}": ${vals.length} lines, ${nonZero} real guarantees (${cd.format})`);
    }
    if (!creditFilenameOk(cd.name))
      warn('Portal', `Credit filename "${cd.name}" would NOT be matched by the portal fetch`,
        'Needs LINES + PERIOD and must not contain VTO/PRIMARY. Update api/fetch-bid.js if Atlas renamed these.');
  }
  fp.creditLandmarkOk = creditLandmarkOk;
  fp.filenameCreditOk = creditData.every(cd => creditFilenameOk(cd.name));

  // ── the headline metric: would the user just see a wall of 64s? ──────────
  const bidlineList = Object.values(bidlineLines);
  if (bidlineList.length && creditData.length) {
    const primaries = bidlineList.filter(l => /^Primary/.test(l.lineType));
    const mergedVals = [];
    let primaryFloored = 0, noCreditMatch = 0;
    for (const l of bidlineList) {
      const g = mergedGuarantee(l.lineNum, c1, c2);
      if (g == null) noCreditMatch++;
      else mergedVals.push(g);
    }
    for (const l of primaries) {
      const g = mergedGuarantee(l.lineNum, c1, c2);
      if (g == null || g <= CONTRACT_MIN + 0.01) primaryFloored++;
    }
    fp.guaranteeRange = range(mergedVals.filter(v => v > 0));
    fp.primaryCount = primaries.length;
    fp.primaryFlooredCount = primaryFloored;
    fp.primaryFlooredPct = primaries.length ? Math.round((primaryFloored / primaries.length) * 100) : 0;

    if (noCreditMatch) {
      const pct = Math.round((noCreditMatch / bidlineList.length) * 100);
      (pct > 25 ? err : warn)('Scoring', `${noCreditMatch} of ${bidlineList.length} bidline lines (${pct}%) have no matching credit entry — they floor to 64`,
        'Lines present in the schedule but missing from the credit parse. Either a line-number dropped in parseCreditByGeometry, or the credit file does not cover this position/base.');
    }
    if (primaries.length >= 5) {
      if (fp.primaryFlooredPct >= 60)
        err('Scoring', `${fp.primaryFlooredPct}% of Primary lines floored to ${CONTRACT_MIN} hrs — guarantees are not being read`,
          'This is the "everything is 64" symptom. Primary lines should almost always have a real guarantee. Review credit guarantee extraction.');
      else if (fp.primaryFlooredPct >= 20)
        warn('Scoring', `${fp.primaryFlooredPct}% of Primary lines floored to ${CONTRACT_MIN} hrs`,
          'Higher than usual; spot-check a few primary lines against the credit PDF.');
      else
        ok('Scoring', `Primary guarantees look healthy (${fp.primaryFlooredPct}% floored; range ${fp.guaranteeRange ? fp.guaranteeRange.join('-') : 'n/a'})`);
    }
    if (fp.guaranteeRange) {
      const high = mergedVals.filter(v => v > GUARANTEE_HIGH).length;
      const below = mergedVals.filter(v => v > 0 && v < CONTRACT_MIN).length;
      if (high) warn('Scoring', `${high} line(s) have guarantee > ${GUARANTEE_HIGH} hrs (max ${fp.guaranteeRange[1]})`, 'Verify these are not column mis-mappings.');
      if (below) warn('Scoring', `${below} line(s) have a raw guarantee below the ${CONTRACT_MIN} hr minimum`, 'Unusual — check the guarantee row alignment.');
    }

    // credit vs bidline line-type agreement (drift detector)
    if (c1) {
      let mismatch = 0;
      for (const l of bidlineList) {
        const cr = c1[l.lineNum];
        if (cr && cr.lineType !== 'Unknown' && cr.lineType !== l.lineType) mismatch++;
      }
      if (mismatch) warn('Credit', `${mismatch} line(s) have a credit line-type that differs from the schedule`,
        'Minor drift, but can affect 60-day averaging. Spot-check if scores look off.');
    }
  }

  // period for fingerprint key
  fp.period = derivePeriod(parsers, bidlineDocs, creditData);

  // ── month-over-month diff ────────────────────────────────────────────────
  let changeNotes = [];
  if (fp.base && fp.aircraft && fp.position) {
    const history = fingerprint.loadHistory(fp);
    const prior = fingerprint.priorSnapshot(history, fp.period);
    changeNotes = fingerprint.diff(prior, fp);
    fp._priorPeriod = prior ? prior.period : null;
  }

  printReport(folder, fp, changeNotes);

  // save fingerprint last (so the diff above compared against the prior month)
  if (fp.base && fp.aircraft && fp.position) {
    const saved = fingerprint.save(fp);
    console.log(`\nFingerprint saved: ${path.relative(REPO_ROOT, saved)}`);
  } else {
    console.log('\n(Fingerprint not saved — base/aircraft/position could not be determined.)');
  }

  const hasErr = findings.some(f => f.level === 'err');
  process.exit(hasErr ? 1 : 0);
}

function periodScore(text, parsers) {
  const m = text.match(/([A-Za-z]{3})(\d{2})-([A-Za-z]{3})(\d{2})/);
  if (!m) return 0;
  const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const endMon = MONTHS[m[3].toUpperCase()] || 0;
  const endYr = parseInt(m[4]) + 2000;
  return endYr * 12 + endMon;
}

function derivePeriod(parsers, bidlineDocs, creditData) {
  const bps = parsers.getBidPeriodStart();
  if (bps) return `${bps.getFullYear()}-${String(bps.getMonth() + 1).padStart(2, '0')}`;
  for (const cd of creditData) {
    const p = parsers.extractCreditPeriod(cd.text);
    if (p) return p;
  }
  return 'unknown';
}

// ── report ───────────────────────────────────────────────────────────────────
function printReport(folder, fp, changeNotes) {
  const ICON = { ok: '[OK]  ', warn: '[WARN]', err: '[ERR] ' };
  const line = '─'.repeat(64);
  console.log('\n' + line);
  console.log(`Bidline File Doctor — ${[fp.base, fp.aircraft, fp.position].filter(Boolean).join(' ') || path.basename(folder)}  (period ${fp.period})`);
  console.log(`App version ${fp.appVersion} · ${path.basename(folder)}`);
  console.log(line);

  const order = ['Files', 'Bidline', 'Credit', 'Scoring', 'Portal'];
  const bySection = {};
  for (const f of findings) (bySection[f.section] = bySection[f.section] || []).push(f);
  for (const sec of order) {
    if (!bySection[sec]) continue;
    console.log(`\n${sec}`);
    for (const f of bySection[sec]) console.log(`  ${ICON[f.level]} ${f.msg}`);
  }

  // change-vs-last-month
  console.log('\nChange since last month');
  if (!fp._priorPeriod) console.log('  (no prior fingerprint for this base/aircraft/position — this run becomes the baseline)');
  else if (!changeNotes.length) console.log(`  No structural changes vs ${fp._priorPeriod}.`);
  else { console.log(`  vs ${fp._priorPeriod}:`); for (const c of changeNotes) console.log(`  • ${c}`); }

  // suggested actions
  const actionable = findings.filter(f => (f.level === 'err' || f.level === 'warn') && f.hint);
  if (actionable.length) {
    console.log('\nSuggested actions');
    let i = 1;
    for (const f of actionable) {
      console.log(`  ${i++}. (${f.level.toUpperCase()}) ${f.msg}`);
      console.log(`     → ${f.hint}`);
    }
  }

  // verdict
  const e = findings.filter(f => f.level === 'err').length;
  const w = findings.filter(f => f.level === 'warn').length;
  console.log('\n' + line);
  let verdict;
  if (e) verdict = `VERDICT: ${e} error(s), ${w} warning(s) — code changes likely needed (see Suggested actions).`;
  else if (w) verdict = `VERDICT: 0 errors, ${w} warning(s) — probably fine, worth a glance.`;
  else verdict = 'VERDICT: all clear — no code changes needed this month.';
  console.log(verdict);
  console.log(line);
}

main().catch(e => { console.error('\nUnexpected failure:', e); process.exit(2); });
