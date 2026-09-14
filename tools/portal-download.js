#!/usr/bin/env node
/*
 * Local portal downloader — replaces the old automated per-user "Fetch from
 * Portal" feature (retired in v1.12.0 when Atlas moved the bid portal to
 * SharePoint Online behind Duo MFA + Conditional Access; no server-side
 * script can complete that login for a user).
 *
 * This drives a REAL browser on THIS machine: you log in once (including the
 * Duo prompt) in a visible window, and the script then crawls every
 * base/aircraft folder under BidPackage, matches the bidline (per crew
 * position) + the two credit PDFs the same way api/fetch-bid.js used to, and
 * downloads them via SharePoint's own download.aspx endpoint — replacing the
 * tedious "open 24 folders by hand" step, not the login itself.
 *
 * Output layout (feeds bid-file-doctor.js / portal-review.js --local, one
 * self-contained combo per folder):
 *   tools/out/portal-download/<BASE>-<AIRCRAFT>-<POS>/<bidline>.pdf
 *   tools/out/portal-download/<BASE>-<AIRCRAFT>-<POS>/<credit1>.pdf
 *   tools/out/portal-download/<BASE>-<AIRCRAFT>-<POS>/<credit2>.pdf
 *
 * Resumable: files already on disk are skipped, so a run that stalls can just
 * be started again. A full log goes to tools/out/portal-download/run.log.
 *
 * Why the recovery logic (2026-09-10 run: 11/24 combos): every stall was
 * ~400 s = a burst of 30 s download timeouts, then the 5-minute login wait,
 * then downloads resumed by themselves. So the MCAS-proxied session gets
 * bounced periodically (re-auth / interstitial), and the old script slept
 * through it instead of noticing. Now: the login wait only waits while the
 * page is actually on an identity host, a failed download re-checks the
 * session and retries, and a direct cookie-sharing GET is tried as a fallback
 * path (and probed at startup, so the log says whether it works at all).
 *
 * Usage:  cd tools && node portal-download.js [--only LAX-747,MIA-767] [--fresh]
 *   --only   comma list of BASE-AIRCRAFT pairs to fetch (default: all)
 *   --fresh  ignore files already on disk (re-download everything)
 */

'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const AIRCRAFT_BASES = require('./lib/aircraft-bases');
const { classifyFiles } = require('./lib/file-matching');

const PROFILE_DIR  = path.join(__dirname, '.browser-profile');
const HOST          = 'https://atlasairww.sharepoint.com';
const SITE_PATH     = '/sites/Employees-FlightOps';
const LANDING_URL   = `${HOST}${SITE_PATH}/SitePages/BidPackage.aspx`;
const LIBRARY_PATH  = `${SITE_PATH}/BidPackage`;
const POSITIONS     = ['CA', 'FO'];
const OUT_ROOT       = path.join(__dirname, 'out', 'portal-download');
const LOG_FILE       = path.join(OUT_ROOT, 'run.log');

const LOGIN_WAIT_MS    = 5 * 60 * 1000;  // while on an identity host (human needed)
const SETTLE_WAIT_MS   = 45 * 1000;      // while somewhere unexpected (interstitial, error page)
const DOWNLOAD_WAIT_MS = 20 * 1000;
const DOWNLOAD_TRIES   = 3;

const args = process.argv.slice(2);
const FRESH = args.includes('--fresh');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? new Set((args[onlyIdx + 1] || '').toUpperCase().split(',').filter(Boolean)) : null;

// ── logging ─────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_ROOT, { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(...parts) {
  const line = parts.join(' ');
  console.log(line);
  logStream.write(`${new Date().toISOString()} ${line}\n`);
}

// ── URL classification ──────────────────────────────────────────────────────
function hostOf(page) {
  try { return new URL(page.url()).hostname; } catch { return ''; }
}
// On the Atlas SharePoint (directly or via the MCAS proxy alias).
function arrived(page) { return /atlasairww\.sharepoint\.com/i.test(hostOf(page)); }
// On a sign-in step that needs a human (Microsoft login, Duo, ADFS/Okta-style SSO).
function onIdentityHost(page) {
  return /login\.microsoftonline\.com|login\.live\.com|duosecurity\.com|duo\.com|adfs|sso|okta|microsoftonline/i.test(hostOf(page));
}

function downloadUrl(serverRelativeFilePath) {
  return `${HOST}${SITE_PATH}/_layouts/15/download.aspx?SourceUrl=${encodeURIComponent(serverRelativeFilePath)}`;
}

// Wait until we're back on SharePoint. Waits the long timeout only while the
// page is on an identity host (someone has to type/approve); anywhere else
// (interstitial, error page, blank) it waits briefly and then re-navigates to
// the landing page to shake the session loose.
async function ensureSession(page, why) {
  if (arrived(page)) return;
  log(`  [session] not on SharePoint (${hostOf(page) || page.url()}) — ${why}`);
  const start = Date.now();
  let lastHost = null;
  let nudged = false;
  for (;;) {
    if (arrived(page)) break;
    const identity = onIdentityHost(page);
    const host = hostOf(page);
    if (host !== lastHost) {
      lastHost = host;
      if (identity) {
        console.log('\n>>> LOGIN NEEDED: complete the sign-in (username, password, Duo) in the browser window.');
        log(`  [session] at identity host ${host} — waiting for you`);
      } else {
        log(`  [session] at ${host || '(blank)'} — waiting for it to settle`);
      }
    }
    const elapsed = Date.now() - start;
    if (identity) {
      if (elapsed > LOGIN_WAIT_MS) throw new Error('Timed out waiting for login.');
    } else if (elapsed > SETTLE_WAIT_MS && !nudged) {
      nudged = true;
      log('  [session] nudging: reloading the landing page');
      await page.goto(LANDING_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log(`  [session] nudge failed: ${e.message}`));
    } else if (elapsed > SETTLE_WAIT_MS + LOGIN_WAIT_MS) {
      throw new Error(`Session never recovered (stuck at ${host || page.url()}).`);
    }
    await page.waitForTimeout(2000);
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  log('  [session] OK');
}

// Discover the top-level folders under BidPackage.
async function discoverFolders(page) {
  await page.goto(LANDING_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ensureSession(page, 'initial login');
  await page.waitForTimeout(1500);

  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]')).map(a => a.href)
  );

  const prefix = `${LIBRARY_PATH}/`;
  const folders = [];
  for (const href of hrefs) {
    let pathname;
    try { pathname = decodeURIComponent(new URL(href).pathname); } catch { continue; }
    if (!pathname.startsWith(prefix)) continue;
    const rest = pathname.slice(prefix.length);
    if (rest.includes('/') || rest.includes('.')) continue; // a file or nested path, not a top-level folder
    folders.push({ name: rest, serverRelativeUrl: `${LIBRARY_PATH}/${rest}` });
  }
  const seen = new Set();
  return folders.filter(f => (seen.has(f.name) ? false : (seen.add(f.name), true)));
}

function findFolder(folders, aircraft, base) {
  const matches = folders.filter(f => {
    const n = f.name.toUpperCase();
    return n.includes(base.toUpperCase()) && n.includes(aircraft);
  });
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    matches.sort((a, b) => b.name.localeCompare(a.name));
    log(`  (${matches.length} folders matched ${base} ${aircraft}, using the alphabetically last: ${matches.map(m => m.name).join(' | ')})`);
  }
  return matches[0];
}

// List filenames inside a folder by scraping the modern list view's rendered
// row text (the modern DetailsList doesn't expose plain <a href> per file).
async function listFilenamesInFolder(page, folder) {
  const url = `${HOST}${folder.serverRelativeUrl}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ensureSession(page, `opening folder ${folder.name}`);
  await page.waitForTimeout(2500);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(500);

  const rowTexts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-automationid="DetailsRow"], .ms-DetailsRow, [role="row"]'))
      .map(r => r.textContent.trim())
      .filter(Boolean)
  );

  const EXT = /\.(pdf|xlsx?|docx?)/i;
  const names = [];
  for (const row of rowTexts) {
    const m = row.match(new RegExp('^(.*?' + EXT.source + ')', 'i'));
    if (m) names.push(m[1]);
  }
  return [...new Set(names)];
}

function looksLikePdf(buf) {
  return buf && buf.length > 1000 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

// Path A: navigate the page to download.aspx and catch the download event.
async function downloadViaPage(page, url, destPath) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: DOWNLOAD_WAIT_MS }),
    page.goto(url).catch(() => {}), // navigation aborts once the download starts — expected
  ]);
  await download.saveAs(destPath);
  const buf = fs.readFileSync(destPath);
  if (!looksLikePdf(buf)) throw new Error(`saved file is not a PDF (${buf.length} bytes)`);
}

// Path B: plain GET with the browser's cookies (no page navigation, no
// download event to race). Whether MCAS lets this through is exactly what
// the startup probe records in the log.
async function downloadViaRequest(context, url, destPath) {
  const res = await context.request.get(url, { timeout: DOWNLOAD_WAIT_MS, maxRedirects: 5 });
  const buf = await res.body();
  if (res.status() !== 200 || !looksLikePdf(buf)) {
    throw new Error(`HTTP ${res.status()} ${res.headers()['content-type'] || ''} (${buf.length} bytes)`);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
}

let requestPathWorks = null; // set by the startup probe: true / false

async function downloadFile(context, page, folder, filename, destPath) {
  const url = downloadUrl(`${folder.serverRelativeUrl}/${filename}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  let lastErr;
  for (let attempt = 1; attempt <= DOWNLOAD_TRIES; attempt++) {
    // Prefer whichever path the probe showed to work; fall back to the other.
    const order = requestPathWorks ? ['request', 'page'] : ['page', 'request'];
    for (const how of order) {
      try {
        if (how === 'request') await downloadViaRequest(context, url, destPath);
        else                   await downloadViaPage(page, url, destPath);
        return how;
      } catch (e) {
        lastErr = e;
        log(`    (${how} path failed, attempt ${attempt}: ${e.message})`);
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch { /* ignore */ }
      }
    }
    // Both paths failed — the usual cause is the session being bounced.
    // Re-establish it (this is where a human may be needed) before retrying.
    await page.goto(`${HOST}${folder.serverRelativeUrl}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await ensureSession(page, `download of ${filename} failed`);
  }
  throw lastErr;
}

async function main() {
  log('='.repeat(60));
  log(`portal-download start${ONLY ? ' --only ' + [...ONLY].join(',') : ''}${FRESH ? ' --fresh' : ''}`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 950 },
    acceptDownloads: true,
  });
  const page = context.pages()[0] || await context.newPage();

  log('Discovering bid folders...');
  const folders = await discoverFolders(page);
  log(`Found ${folders.length} top-level folder(s) under BidPackage: ${folders.map(f => f.name).join(' | ')}`);

  // Startup probe: does a cookie-sharing GET reach the real host, or does the
  // MCAS proxy reject anything that isn't a page navigation? Recorded once so
  // the run log answers the question either way.
  try {
    const probe = await context.request.get(`${HOST}${SITE_PATH}/_api/web/title`, {
      headers: { Accept: 'application/json;odata=nometadata' }, timeout: 10000, maxRedirects: 5,
    });
    requestPathWorks = probe.status() === 200;
    log(`Direct-request probe: HTTP ${probe.status()} -> ${requestPathWorks ? 'request path usable' : 'page-navigation path only'}`);
  } catch (e) {
    requestPathWorks = false;
    log(`Direct-request probe failed (${e.message}) -> page-navigation path only`);
  }

  const results = [];

  for (const aircraft of Object.keys(AIRCRAFT_BASES)) {
    for (const base of AIRCRAFT_BASES[aircraft]) {
      const label = `${base} ${aircraft}`;
      if (ONLY && !ONLY.has(`${base}-${aircraft}`)) continue;
      const folder = findFolder(folders, aircraft, base);
      if (!folder) {
        log(`[SKIP] ${label} — no matching folder found.`);
        results.push({ label, ok: false, error: 'no matching folder' });
        continue;
      }

      log(`\n[${label}] folder: ${folder.name}`);
      let filenames;
      try {
        filenames = await listFilenamesInFolder(page, folder);
      } catch (e) {
        log(`[FAIL] ${label} — could not list files: ${e.message}`);
        results.push({ label, ok: false, error: `list failed: ${e.message}` });
        continue;
      }
      log(`  ${filenames.length} file(s): ${filenames.join(' | ')}`);

      for (const pos of POSITIONS) {
        const matched = classifyFiles(filenames, pos);
        const bidline = matched.find(f => f.role === 'bidline');
        const credit1 = matched.find(f => f.role === 'credit1');
        const credit2 = matched.find(f => f.role === 'credit2');

        if (!bidline) {
          log(`  [SKIP] ${label} ${pos} — no bidline file matched.`);
          results.push({ label: `${label} ${pos}`, ok: false, error: 'no bidline matched' });
          continue;
        }

        const comboDir = path.join(OUT_ROOT, `${base}-${aircraft}-${pos}`);
        const toGet = [bidline, credit1, credit2].filter(Boolean);
        log(`  [${pos}] ${toGet.length} file(s) -> ${path.relative(process.cwd(), comboDir)}`);

        let failed = false;
        for (const f of toGet) {
          const dest = path.join(comboDir, f.name);
          if (!FRESH && fs.existsSync(dest) && looksLikePdf(fs.readFileSync(dest))) {
            log(`    = ${f.name} (already on disk)`);
            continue;
          }
          try {
            const how = await downloadFile(context, page, folder, f.name, dest);
            log(`    ✓ ${f.name} (${fs.statSync(dest).size} bytes, ${how})`);
          } catch (e) {
            failed = true;
            log(`    ✗ ${f.name} — ${e.message}`);
          }
          await page.waitForTimeout(400);
        }
        results.push({ label: `${label} ${pos}`, ok: !failed, files: toGet.length });
      }
    }
  }

  log('\n' + '='.repeat(60));
  log('SUMMARY');
  log('='.repeat(60));
  for (const r of results) {
    log(`  [${r.ok ? 'OK  ' : 'FAIL'}] ${r.label}${r.error ? ' — ' + r.error : ''}`);
  }
  const failCount = results.filter(r => !r.ok).length;
  log(`\n${results.length} combo(s), ${failCount} failure(s).`);
  log(`Files written under: ${path.relative(process.cwd(), OUT_ROOT)}`);
  if (failCount) log('Re-run the same command to retry only what is missing.');
  log(`Log: ${path.relative(process.cwd(), LOG_FILE)}`);

  await context.close();
  process.exitCode = failCount > 0 ? 1 : 0;
}

main().catch(e => {
  log(`Fatal error: ${e.stack || e}`);
  process.exitCode = 1;
}).finally(() => logStream.end());
