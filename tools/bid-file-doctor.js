#!/usr/bin/env node
//
// Bidline File Doctor
// ===================
// Reviews a month's Atlas Air bid PDFs and reports any format changes that may
// require updates to the Bidline Ranker. It runs the REAL parsers extracted
// from ABR.html (so it catches actual breakage, not a stale re-implementation),
// checks a battery of invariants, and diffs against last month's fingerprint.
//
// Handles all Atlas fleets (747, 767, 777). A folder may hold one schedule or
// several (any base / aircraft / position); each bidline is analysed on its own
// and paired only with the credit files for its aircraft.
//
// Usage:
//   cd tools
//   npm install            # once, to fetch pdfjs-dist
//   node bid-file-doctor.js "../LAX"
//
// Exit code 0 = clean / warnings only, 1 = errors found (CI-friendly).

const fs = require('fs');
const path = require('path');

// Silence pdfjs's harmless console noise (canvas polyfill warnings at require
// time, plus per-font "TT: undefined function" warnings). We only extract text.
for (const m of ['log', 'warn']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => {
    if (/Cannot polyfill|module 'canvas'|TT: undefined function/i.test(String(a[0] || ''))) return;
    orig(...a);
  };
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

// ── helpers ──────────────────────────────────────────────────────────────────
function listPdfs(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .map(f => path.join(dir, f));
}

// Normalize a header aircraft code to its credit-file family token.
// Bidline headers can read 744 (747-400); credit files are named "747 Lines".
function aircraftFamily(code) {
  const d = String(code || '').replace(/\D/g, '');
  if (d.startsWith('74')) return '747';
  if (d.startsWith('76')) return '767';
  if (d.startsWith('77')) return '777';
  return d.slice(0, 3) || null;
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

function periodScore(text) {
  const m = text.match(/([A-Za-z]{3})(\d{2})-([A-Za-z]{3})(\d{2})/);
  if (!m) return 0;
  const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const endMon = MONTHS[m[3].toUpperCase()] || 0;
  const endYr = parseInt(m[4]) + 2000;
  return endYr * 12 + endMon;
}

// ── per-schedule analysis ─────────────────────────────────────────────────────
// Analyses one bidline schedule + its paired credit files. Returns the findings
// list and the structural fingerprint. Self-contained (no shared mutable state)
// so a folder with several schedules produces an independent report each.
async function analyzeSchedule(bidlineDoc, creditDocs, parsers, appVersion) {
  const findings = [];
  const ok = (s, m) => findings.push({ level: 'ok', section: s, msg: m });
  const warn = (s, m, h) => findings.push({ level: 'warn', section: s, msg: m, hint: h });
  const err = (s, m, h) => findings.push({ level: 'err', section: s, msg: m, hint: h });

  const fp = { savedAt: new Date().toISOString(), appVersion, base: null, aircraft: null, position: null, period: null };

  // bidline
  parsers.resetBidPeriodStart();
  let bidlineLines = {}, meta = {};
  let res;
  try { res = await parsers.parseBidlineWithPositions(bidlineDoc.file); }
  catch (e) { err('Bidline', `Parser threw: ${e.message}`, 'parseBidlineWithPositions() failed outright — a structural assumption broke.'); }
  if (res) { bidlineLines = res.lines; meta = res.meta || {}; }

  const count = Object.keys(bidlineLines).length;
  fp.base = meta.baseAirport || null;
  fp.aircraft = meta.aircraftType || null;
  fp.position = meta.crewPosition || null;
  fp.bidlineLineCount = count;

  if (count === 0) err('Bidline', 'Parsed 0 lines from the schedule',
    'Row/column detection failed — the schedule table layout likely changed (parseBidlineWithPositions).');
  else ok('Bidline', `${count} lines parsed`);

  const bps = parsers.getBidPeriodStart();
  fp.headerDateOk = !!bps;
  if (!bps) err('Bidline', 'CREW SCHEDULE FROM header date not parsed — date defaults will be used',
    'The header regex in parseBidlineWithPositions did not match. All date math falls back to today. See CLAUDE.md "Bid Cycle Rules".');
  else ok('Bidline', `Bid period start: ${bps.toISOString().slice(0, 10)}`);

  if (!meta.aircraftType || !meta.crewPosition)
    warn('Bidline', `Header fields incomplete (base=${meta.baseAirport || '?'}, ac=${meta.aircraftType || '?'}, pos=${meta.crewPosition || '?'})`,
      'The "<BASE> <AC> <POS>" header pattern did not fully match — check the header regex.');
  else ok('Bidline', `${meta.baseAirport} ${meta.aircraftType} ${meta.crewPosition}`);

  // line types / trips / days off
  const typeHist = {}, unknownTypes = {};
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
  if (count > 0 && unknownTotal === 0) ok('Bidline', `Line types all known (${Object.keys(typeHist).length} distinct)`);
  else if (unknownTotal) {
    const detail = Object.entries(unknownTypes).map(([t, c]) => `"${t}"x${c}`).join(', ');
    const report = unknownTotal > count * 0.3 ? err : warn;
    report('Bidline', `${unknownTotal} line(s) have unrecognized type: ${detail}`,
      'New/renamed line-type label. Add it to the type lists in ABR.html and to KNOWN_TYPES here, and to CLAUDE.md "Line Types".');
  }
  if (daysOffVals.length) {
    const outliers = daysOffVals.filter(d => d < DAYSOFF_MIN || d > DAYSOFF_MAX).length;
    if (outliers) warn('Bidline', `${outliers} line(s) have days-off outside ${DAYSOFF_MIN}-${DAYSOFF_MAX} (range ${fp.daysOffRange.join('-')})`,
      'Off-day (X marker) detection may be mis-counting. See CLAUDE.md "Off-Day Detection".');
    else ok('Bidline', `Days-off per line within ${fp.daysOffRange.join('-')}`);
  }
  if (zeroTrips) warn('Bidline', `${zeroTrips} line(s) parsed with 0 trips`, 'Trip (working-block) detection may have failed for these lines.');

  // bidline filename vs portal
  if (fp.position) {
    fp.filenameBidlineOk = bidlineFilenameOk(bidlineDoc.name, fp.position);
    if (fp.filenameBidlineOk) ok('Portal', `Bidline filename matches portal pattern for ${fp.position}`);
    else err('Portal', `Bidline filename "${bidlineDoc.name}" would NOT be found by the portal fetch`,
      'api/fetch-bid.js requires the name to contain BIDLINE and a separator before the position. Update that matcher (and CLAUDE.md). Redeploy Vercel.');
  }

  // credit
  const creditData = [];
  for (const doc of creditDocs) {
    let data = {};
    try { data = await parsers.parseCreditFile(doc.file, doc.text); }
    catch (e) { err('Credit', `Parser threw on "${doc.name}": ${e.message}`); continue; }
    const format = doc.text.includes('SUM OF CREDITS') ? 'geometry-2026' : 'legacy';
    creditData.push({ name: doc.name, text: doc.text, data, format });
  }
  creditData.sort((a, b) => periodScore(a.text) - periodScore(b.text));
  const c1 = creditData[0] && creditData[0].data;
  const c2 = creditData[1] && creditData[1].data;

  fp.creditFormat = creditData[0] ? creditData[0].format : 'none';
  fp.creditFiles = creditData.map(cd => ({ name: cd.name, lineCount: Object.keys(cd.data).length, guaranteeNonZero: Object.values(cd.data).filter(v => v.guarantee > 0).length }));

  if (!creditData.length) {
    const fam = aircraftFamily(meta.aircraftType);
    warn('Credit', `No ${fam || ''} credit (LINES…PERIOD) PDFs paired with this schedule — guarantees fall back to the ${CONTRACT_MIN} hr minimum`,
      'Either no credit file for this aircraft is in the folder, or the credit filename changed (needs LINES + PERIOD, not VTO/PRIMARY).');
  }

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
        'Guarantee row not found — credit table format changed. This is the failure fixed in v1.7.1; review ART33 guarantee-row detection in parseCreditByGeometry.');
      creditLandmarkOk = false;
    } else {
      ok('Credit', `"${cd.name}": ${vals.length} lines, ${nonZero} real guarantees (${cd.format})`);
    }
    if (!creditFilenameOk(cd.name))
      warn('Portal', `Credit filename "${cd.name}" would NOT be matched by the portal fetch`,
        'Needs LINES + PERIOD and must not contain VTO/PRIMARY. Update api/fetch-bid.js if Atlas renamed these.');
  }
  fp.creditLandmarkOk = creditLandmarkOk;
  fp.filenameCreditOk = creditData.length ? creditData.every(cd => creditFilenameOk(cd.name)) : null;

  // headline scoring: would the user see a wall of 64s?
  const bidlineList = Object.values(bidlineLines);
  if (bidlineList.length && creditData.length) {
    const primaries = bidlineList.filter(l => /^Primary/.test(l.lineType));
    const mergedVals = [];
    let noCreditMatch = 0, primaryUnread = 0, primaryAtFloor = 0;
    for (const l of bidlineList) {
      const g = mergedGuarantee(l.lineNum, c1, c2);
      if (g == null) noCreditMatch++; else mergedVals.push(g);
    }
    // The real failure signature is a guarantee that wasn't read at all
    // (null/0) — what the v1.7.1 bug produced. A genuine 64 (credit below the
    // contract minimum, common on short-haul / AdH lines) is NOT a failure, so
    // it must not be counted as one. Track the two separately.
    for (const l of primaries) {
      const g = mergedGuarantee(l.lineNum, c1, c2);
      if (g == null || g === 0) primaryUnread++;
      else if (g <= CONTRACT_MIN + 0.01) primaryAtFloor++;
    }
    fp.guaranteeRange = range(mergedVals.filter(v => v > 0));
    fp.primaryCount = primaries.length;
    fp.primaryUnreadCount = primaryUnread;
    fp.primaryUnreadPct = primaries.length ? Math.round((primaryUnread / primaries.length) * 100) : 0;
    fp.primaryAtFloorPct = primaries.length ? Math.round((primaryAtFloor / primaries.length) * 100) : 0;

    if (noCreditMatch) {
      const pct = Math.round((noCreditMatch / bidlineList.length) * 100);
      (pct > 25 ? err : warn)('Scoring', `${noCreditMatch} of ${bidlineList.length} bidline lines (${pct}%) have no matching credit entry — they floor to ${CONTRACT_MIN}`,
        'Lines present in the schedule but missing from the credit parse. Either a line-number dropped in the credit parser, or the paired credit file does not cover this position/base.');
    }
    if (primaries.length >= 5) {
      const floorNote = fp.primaryAtFloorPct ? ` (${fp.primaryAtFloorPct}% legitimately at the ${CONTRACT_MIN} hr floor)` : '';
      if (fp.primaryUnreadPct >= 50)
        err('Scoring', `${fp.primaryUnreadPct}% of Primary lines have NO guarantee value (0/missing) — guarantees are not being read`,
          'The "everything is 64" symptom. A real 64 (credit below the contract minimum) is fine; this counts only 0/missing values. Review credit guarantee extraction and confirm the right credit file was paired.');
      else if (fp.primaryUnreadPct >= 20)
        warn('Scoring', `${fp.primaryUnreadPct}% of Primary lines have no guarantee value (0/missing)`, 'Higher than usual; spot-check a few primary lines against the credit PDF.');
      else
        ok('Scoring', `Primary guarantees read OK (${primaries.length - primaryUnread}/${primaries.length}${floorNote}; range ${fp.guaranteeRange ? fp.guaranteeRange.join('-') : 'n/a'})`);
    }
    if (fp.guaranteeRange) {
      const high = mergedVals.filter(v => v > GUARANTEE_HIGH).length;
      const below = mergedVals.filter(v => v > 0 && v < CONTRACT_MIN).length;
      if (high) warn('Scoring', `${high} line(s) have guarantee > ${GUARANTEE_HIGH} hrs (max ${fp.guaranteeRange[1]})`, 'Verify these are not column mis-mappings.');
      if (below) warn('Scoring', `${below} line(s) have a raw guarantee below the ${CONTRACT_MIN} hr minimum`, 'Unusual — check the guarantee row alignment.');
    }
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

  // period (for fingerprint key)
  fp.period = bps
    ? `${bps.getFullYear()}-${String(bps.getMonth() + 1).padStart(2, '0')}`
    : (creditData.map(cd => parsers.extractCreditPeriod(cd.text)).find(Boolean) || 'unknown');

  return { findings, fp, parsed: { bidlineLines, meta, c1, c2 } };
}

// ── report ───────────────────────────────────────────────────────────────────
function printReport(folder, fp, changeNotes, findings) {
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

  console.log('\nChange since last month');
  if (!fp._priorPeriod) console.log('  (no prior fingerprint for this base/aircraft/position — this run becomes the baseline)');
  else if (!changeNotes.length) console.log(`  No structural changes vs ${fp._priorPeriod}.`);
  else { console.log(`  vs ${fp._priorPeriod}:`); for (const c of changeNotes) console.log(`  • ${c}`); }

  const actionable = findings.filter(f => (f.level === 'err' || f.level === 'warn') && f.hint);
  if (actionable.length) {
    console.log('\nSuggested actions');
    let i = 1;
    for (const f of actionable) {
      console.log(`  ${i++}. (${f.level.toUpperCase()}) ${f.msg}`);
      console.log(`     → ${f.hint}`);
    }
  }

  const e = findings.filter(f => f.level === 'err').length;
  const w = findings.filter(f => f.level === 'warn').length;
  console.log('\n' + line);
  let verdict;
  if (e) verdict = `VERDICT: ${e} error(s), ${w} warning(s) — code changes likely needed (see Suggested actions).`;
  else if (w) verdict = `VERDICT: 0 errors, ${w} warning(s) — probably fine, worth a glance.`;
  else verdict = 'VERDICT: all clear — no code changes needed.';
  console.log(verdict);
  console.log(line);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const folderArg = process.argv[2];
  if (!folderArg) {
    console.log('Usage: node bid-file-doctor.js <folder-with-month-PDFs>\n');
    const candidates = fs.readdirSync(REPO_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && !['tools', 'backups', 'node_modules'].includes(d.name))
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

  // classify every PDF with the app's own detector
  const classified = [];
  for (const p of pdfs) {
    const file = fileFromPath(p);
    let text = '';
    try { text = await parsers.extractTextFromPDF(file); }
    catch (e) { console.log(`\n[ERR]  Could not read ${path.basename(p)}: ${e.message}`); continue; }
    classified.push({ path: p, name: path.basename(p), file, text, type: parsers.detectFileType(text) });
  }
  const bidlineDocs = classified.filter(c => c.type === 'bidline');
  const creditDocs = classified.filter(c => c.type === 'credit');
  const unknownDocs = classified.filter(c => c.type === 'unknown');

  if (unknownDocs.length) {
    console.log('\nUnrecognized files (not bidline or credit):');
    for (const u of unknownDocs) console.log(`  [WARN] ${u.name} — check detectFileType() if this should be parsed`);
  }
  if (!bidlineDocs.length) {
    console.error('\n[ERR] No bidline schedule PDF found in this folder. The schedule did not match detectFileType()==="bidline" (check the CREW SCHEDULE FROM / "<AC> <POS>" header).');
    process.exit(1);
  }

  // Do the credit files carry an aircraft token (e.g. "747 Lines")? If so, pair
  // each schedule only with the credit files for its fleet; otherwise (un-tagged
  // names) all credit files belong to the single schedule in the folder.
  const creditTagged = creditDocs.some(c => /\b7\d{2}\b/.test(c.name));

  console.log(`\nFound ${bidlineDocs.length} schedule(s) and ${creditDocs.length} credit file(s) in ${path.basename(folder)}.`);

  let anyError = false;
  for (const bidlineDoc of bidlineDocs) {
    // peek the aircraft so we can pair credit files before the full analysis
    parsers.resetBidPeriodStart();
    let fam = null;
    try {
      const probe = await parsers.parseBidlineWithPositions(bidlineDoc.file);
      fam = aircraftFamily(probe.meta && probe.meta.aircraftType);
    } catch { /* analyzeSchedule will report the failure */ }

    const paired = (creditTagged && fam)
      ? creditDocs.filter(c => c.name.toUpperCase().includes(fam))
      : creditDocs;

    const { findings, fp } = await analyzeSchedule(bidlineDoc, paired, parsers, appVersion);

    let changeNotes = [];
    if (fp.base && fp.aircraft && fp.position) {
      const history = fingerprint.loadHistory(fp);
      const prior = fingerprint.priorSnapshot(history, fp.period);
      changeNotes = fingerprint.diff(prior, fp);
      fp._priorPeriod = prior ? prior.period : null;
    }

    printReport(folder, fp, changeNotes, findings);

    if (fp.base && fp.aircraft && fp.position) {
      const saved = fingerprint.save(fp);
      console.log(`Fingerprint saved: ${path.relative(REPO_ROOT, saved)}`);
    } else {
      console.log('(Fingerprint not saved — base/aircraft/position could not be determined.)');
    }
    if (findings.some(f => f.level === 'err')) anyError = true;
  }

  process.exit(anyError ? 1 : 0);
}

// Run as a CLI, or expose the engine for the portal reviewer to reuse.
if (require.main === module) {
  main().catch(e => { console.error('\nUnexpected failure:', e); process.exit(2); });
}

module.exports = { analyzeSchedule, printReport, aircraftFamily, mergedGuarantee, KNOWN_TYPES };
