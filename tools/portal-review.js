#!/usr/bin/env node
//
// Monthly Portal Review
// =====================
// Pulls the current bid posting for every base/aircraft/position from the Atlas
// portal (via the app's own fetch endpoint), runs each schedule through the same
// format checks as bid-file-doctor, and emits:
//   • a consolidated review report (alerts on any format change), and
//   • the PARSED DATASET per combo (per-line facts) for later in-app use.
//
// Intended to run on a schedule on the 15th (see .github/workflows). The dataset
// is written under tools/out/ and treated as PRIVATE (uploaded as a CI artifact,
// never committed) until a hosting/access model is chosen.
//
// Credentials come from env: ATLAS_USERNAME, ATLAS_PASSWORD.
//
//   node portal-review.js                 # fetch all combos from the portal
//   node portal-review.js --local ../LAX  # no creds: run the pipeline on a local folder
//
// Exit 0 = clean, 1 = errors found (so CI fails and notifies).

const fs = require('fs');
const path = require('path');

// Requiring bid-file-doctor installs the pdfjs console-noise filter and gives us
// the shared review engine (analyzeSchedule / printReport).
const { analyzeSchedule, printReport } = require('./bid-file-doctor');
const { loadAbrParsers, readAppVersion, readAircraftBases, fileFromPath, fileFromBuffer } = require('./lib/abr-loader');
const fingerprint = require('./lib/fingerprint');
const portal = require('./lib/portal');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const ABR_HTML = path.join(REPO_ROOT, 'ABR.html');
const POSITIONS = ['CA', 'FO'];

function isoDay(d) { return d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : null; }

// Merge bidline + credit parse output into the per-line facts dataset that a
// future in-app data store would consume. Scores are intentionally NOT computed
// here — scoring stays interactive in the app; we store inputs only.
function buildDataset(parsed, fp) {
  const { bidlineLines, c1, c2 } = parsed;
  const lines = Object.values(bidlineLines).map(l => {
    const a = c1 && c1[l.lineNum], b = c2 && c2[l.lineNum];
    const bp1 = a ? a.guarantee : null;
    const bp2 = b ? b.guarantee : null;
    let guarantee = null;
    if (bp1 != null && bp2 != null) guarantee = (bp1 + bp2) / 2;
    else if (bp1 != null) guarantee = bp1;
    else if (bp2 != null) guarantee = bp2;
    return {
      lineNum: l.lineNum,
      lineType: l.lineType,
      daysOff: l.daysOffCount,
      guarantee, bp1Guarantee: bp1, bp2Guarantee: bp2,
      frontDH: l.frontDH, backDH: l.backDH,
      airports: l.airports,
      scheduleEnd: isoDay(l.scheduleEnd),
      trips: (l.trips || []).map(t => ({ start: isoDay(t.start), end: isoDay(t.end) })),
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    appVersion: fp.appVersion,
    base: fp.base, aircraft: fp.aircraft, position: fp.position, period: fp.period,
    lineCount: lines.length,
    lines,
  };
}

// Build the analyzeSchedule inputs (a bidline doc + credit docs) from a set of
// downloaded/loaded files tagged with role.
async function buildDocs(parsers, files) {
  const bidlineFile = files.find(f => f.role === 'bidline');
  const creditFiles = files.filter(f => /^credit/.test(f.role || ''));
  if (!bidlineFile) return null;
  const bidlineDoc = { name: bidlineFile.name, file: bidlineFile.file };
  const creditDocs = [];
  for (const cf of creditFiles) {
    const text = await parsers.extractTextFromPDF(cf.file);
    creditDocs.push({ name: cf.name, file: cf.file, text });
  }
  return { bidlineDoc, creditDocs };
}

async function reviewOne(parsers, appVersion, label, files, outDir, report) {
  const docs = await buildDocs(parsers, files);
  if (!docs) { report.combo(label, 'err', 'No bidline file among the fetched files'); return { error: true }; }

  const { findings, fp, parsed } = await analyzeSchedule(docs.bidlineDoc, docs.creditDocs, parsers, appVersion);

  // fingerprint diff
  let changeNotes = [];
  if (fp.base && fp.aircraft && fp.position) {
    const history = fingerprint.loadHistory(fp);
    const prior = fingerprint.priorSnapshot(history, fp.period);
    changeNotes = fingerprint.diff(prior, fp);
    fp._priorPeriod = prior ? prior.period : null;
  }

  printReport(REPO_ROOT, fp, changeNotes, findings);

  // dataset (private)
  if (fp.base && fp.aircraft && fp.position) {
    const dsDir = path.join(outDir, 'data');
    fs.mkdirSync(dsDir, { recursive: true });
    const ds = buildDataset(parsed, fp);
    fs.writeFileSync(path.join(dsDir, `${fp.base}-${fp.aircraft}-${fp.position}.json`), JSON.stringify(ds, null, 2));
    fingerprint.save(fp);
  }

  const errs = findings.filter(f => f.level === 'err').length;
  const warns = findings.filter(f => f.level === 'warn').length;
  report.combo(label, errs ? 'err' : (warns ? 'warn' : 'ok'),
    `${fp.base || '?'} ${fp.aircraft || '?'} ${fp.position || '?'} — ${errs} err / ${warns} warn` +
    (fp.primaryUnreadPct != null ? `, ${fp.primaryUnreadPct}% primaries unread` : '') +
    (fp.primaryAtFloorPct ? `, ${fp.primaryAtFloorPct}% at 64 floor` : ''));
  return { error: errs > 0, fp, changeNotes };
}

// ── input sources ────────────────────────────────────────────────────────────

// Portal: list + download files for one combo. Returns tagged file objects.
async function fetchCombo(creds, aircraft, base, pos) {
  const res = await portal.listFiles(creds, aircraft, base, pos);
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  const files = [];
  for (const f of res.files) {
    const buf = await portal.downloadFile(creds, f.url);
    files.push({ name: f.name, role: f.role, file: fileFromBuffer(f.name, buf) });
  }
  return { ok: true, files, folder: res.folder };
}

// Local folder: classify PDFs with the app's detector (single-combo, for testing
// and as a credential-free manual fallback).
async function loadLocal(parsers, folder) {
  const files = [];
  for (const name of fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.pdf'))) {
    const file = fileFromPath(path.join(folder, name));
    const text = await parsers.extractTextFromPDF(file);
    const type = parsers.detectFileType(text);
    if (type === 'bidline') files.push({ name, role: 'bidline', file });
    else if (type === 'credit') files.push({ name, role: 'credit', file });
  }
  return files;
}

// ── simple report aggregator ──────────────────────────────────────────────────
function makeReport() {
  const rows = [];
  return {
    combo: (label, level, msg) => rows.push({ label, level, msg }),
    summary() {
      const c = { ok: 0, warn: 0, err: 0 };
      for (const r of rows) c[r.level] = (c[r.level] || 0) + 1;
      const line = '═'.repeat(64);
      console.log('\n' + line + '\nMONTHLY PORTAL REVIEW — SUMMARY\n' + line);
      for (const r of rows) console.log(`  [${r.level.toUpperCase().padEnd(4)}] ${r.label.padEnd(16)} ${r.msg}`);
      console.log(line);
      console.log(`Combos checked: ${rows.length}  |  ok: ${c.ok}  warn: ${c.warn}  err: ${c.err}`);
      return c;
    },
    rows,
  };
}

// Write the non-sensitive review summary (counts, findings, format notes — no
// bid line data) for CI to surface as an artifact. The parsed dataset stays out
// of this file and is never uploaded from CI (the repo is public).
function writeSummary(outDir, report) {
  const file = path.join(outDir, 'review-summary.json');
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), combos: report.rows }, null, 2));
  return file;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const appVersion = readAppVersion(ABR_HTML);
  const parsers = loadAbrParsers(ABR_HTML, pdfjsLib);
  const stamp = new Date().toISOString().slice(0, 7); // YYYY-MM
  const outDir = path.join(__dirname, 'out', stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const report = makeReport();

  const localIdx = process.argv.indexOf('--local');
  if (localIdx >= 0) {
    const folder = path.resolve(process.argv[localIdx + 1] || '');
    if (!fs.existsSync(folder)) { console.error(`--local folder not found: ${folder}`); process.exitCode = 2; return; }
    console.log(`Running in LOCAL mode against ${folder} (no portal fetch).`);
    const files = await loadLocal(parsers, folder);
    await reviewOne(parsers, appVersion, path.basename(folder), files, outDir, report);
    report.summary();
    writeSummary(outDir, report);
    console.log(`\nReport + dataset written under: ${path.relative(REPO_ROOT, outDir)}`);
    process.exitCode = report.rows.some(r => r.level === 'err') ? 1 : 0;
    return;
  }

  // Portal mode — needs credentials.
  const creds = { username: process.env.ATLAS_USERNAME, password: process.env.ATLAS_PASSWORD };
  if (!creds.username || !creds.password) {
    console.error('Set ATLAS_USERNAME and ATLAS_PASSWORD (env / GitHub Actions secrets) for portal mode,');
    console.error('or use:  node portal-review.js --local <folder>');
    process.exitCode = 2;
    return;
  }

  const AIRCRAFT_BASES = readAircraftBases(ABR_HTML);
  console.log(`Portal: ${portal.endpoint()}`);
  let listed = 0, listFailed = 0, authFailed = false;
  sweep:
  for (const aircraft of Object.keys(AIRCRAFT_BASES)) {
    for (const base of AIRCRAFT_BASES[aircraft]) {
      for (const pos of POSITIONS) {
        const label = `${base} ${aircraft} ${pos}`;
        try {
          const fetched = await fetchCombo(creds, aircraft, base, pos);
          if (!fetched.ok) {
            listFailed++;
            const level = fetched.status === 404 ? 'warn' : 'err';
            report.combo(label, level, `fetch failed (${fetched.status}): ${fetched.error}`);
            // A 401 is a credential problem, not a per-combo one — every remaining
            // combo would fail identically. Abandon the WHOLE sweep: continuing
            // fires a rejected login per combo at the real Atlas account and can
            // trip a lockout. (Until 2026-08-15 this `break` was unlabelled, so it
            // left only the POSITIONS loop and kept going: the 2026-08-15 13:30Z
            // run logged "stopping" 12 times and silently skipped every FO combo.)
            if (fetched.status === 401) {
              authFailed = true;
              console.error('Authentication failed — abandoning the sweep (no further login attempts).');
              break sweep;
            }
            continue;
          }
          listed++;
          await reviewOne(parsers, appVersion, label, fetched.files, outDir, report);
        } catch (e) {
          report.combo(label, 'err', `unexpected: ${e.message}`);
        }
      }
    }
  }

  const counts = report.summary();
  writeSummary(outDir, report);
  console.log(`\nReview summary: ${path.relative(REPO_ROOT, path.join(outDir, 'review-summary.json'))}`);
  console.log(`Parsed datasets (PRIVATE, not uploaded from CI): ${path.relative(REPO_ROOT, path.join(outDir, 'data'))}`);

  // Fail the job if anything errored, or if the whole listing collapsed.
  // The two causes of a collapse look identical in the counts but need opposite
  // responses, so name the one we actually detected — reporting a credential
  // rejection as a "folder/file-matching change" sends the reader into
  // api/fetch-bid.js for a problem that is fixed by rotating a secret.
  const systemic = listed === 0 && listFailed > 0;
  if (authFailed) {
    console.error('\nThe portal REJECTED THE CREDENTIALS (401 Invalid username or password).');
    console.error('Fix: update the ATLAS_USERNAME / ATLAS_PASSWORD repository secrets');
    console.error('     (Settings -> Secrets and variables -> Actions), then re-run this workflow.');
    console.error('This is NOT a file-format change — no parser or api/fetch-bid.js work is implied.');
  } else if (systemic) {
    console.error('\nNo combos could be listed, and the credentials were accepted — so this is');
    console.error('likely a portal folder/file-matching change (api/fetch-bid.js).');
  }
  // Set the code and let the event loop drain rather than process.exit()-ing.
  // Forcing exit immediately after an HTTP request tears down undici's socket
  // while it is still closing; on Windows that trips a libuv assertion
  // ("!(handle->flags & UV_HANDLE_CLOSING)") and replaces the exit code with
  // 0xC0000409, so a *failing* run reports neither 0 nor 1 and CI/callers can no
  // longer read the result. Draining costs well under a second.
  process.exitCode = counts.err > 0 || systemic ? 1 : 0;
}

main().catch(e => { console.error('\nUnexpected failure:', e); process.exitCode = 2; });
