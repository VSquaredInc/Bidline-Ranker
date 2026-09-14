# Bidline File Doctor

A maintenance tool (not shipped to users) that reviews a month's Atlas Air bid
PDFs and flags any format changes that may require updates to the Bidline Ranker.
Run it whenever a new bid posts (the 15th) before assuming the app will parse the
new files cleanly.

It catches the kinds of monthly breakage we keep hitting:

- the `Bidlines` → `Bidline` filename rename (portal fetch silently finds nothing)
- the 2026 credit-PDF layout that made every guarantee read as the 64 hr minimum
- new/renamed line types, header-format changes, dropped lines, column mis-maps

## How it works

It loads the **real** parser functions out of `ABR.html` (so it tests the exact
code that ships, never a drifting copy), runs them against the folder you point
it at, checks a battery of invariants, and diffs the results against last month's
saved "fingerprint" to show what changed.

## Setup (once)

```
cd tools
npm install
```

Requires Node.js (already installed on the main dev machine). Pulls in
`pdfjs-dist@3.11.174` to match the version bundled in `ABR.html`.

## Usage

```
cd tools
node bid-file-doctor.js "../LAX"
```

Point it at a folder containing one month's PDFs for a single base/aircraft/
position: the bidline schedule plus its one or two credit (`…LINES…PERIOD…`)
PDFs — exactly what you'd download from the portal. Run with no argument to list
folders in the repo that contain PDFs.

Exit code is `0` when clean (or warnings only) and `1` when errors are found, so
it can gate a script if you ever want that.

## Reading the report

- **`[OK]` / `[WARN]` / `[ERR]`** per section (Files, Bidline, Credit, Scoring, Portal).
- **Change since last month** — the structural diff vs the previous fingerprint
  for this base/aircraft/position. This is where a format change jumps out.
- **Suggested actions** — for each warning/error, which part of the code or
  `CLAUDE.md` likely needs attention.
- **Verdict** — one-line summary.

The single most important line is in **Scoring**: the percentage of *Primary*
lines floored to 64 hrs. Primary lines should almost always have a real
guarantee, so a high floor rate means the credit guarantees aren't being read —
the "everything is 64" symptom.

## Monthly review, all combos (`portal-download.js` + `portal-review.js --local`)

**September 2026: the portal moved.** Atlas migrated the bid package library
from the on-prem SharePoint (`employees.atlasair.com`, username/password) to
SharePoint Online (`atlasairww.sharepoint.com`) behind Duo MFA and a Defender
for Cloud Apps session proxy (`.mcas.ms`). No unattended script can log in
any more, so the app's "Fetch from Portal" feature was retired (v1.12.0), the
Vercel endpoint answers `410`, and the scheduled GitHub Actions review is
disabled (`workflow_dispatch` only). The monthly review is now a local,
two-command job — one human Duo login, the rest automated:

```
cd tools
node portal-download.js          # opens a browser; complete the Duo login once
node portal-review.js --local out/portal-download/LAX-747-FO   # per combo
```

`portal-download.js` crawls every base/aircraft folder under BidPackage,
classifies files exactly as `api/fetch-bid.js` used to (`lib/file-matching.js`),
and downloads the bidline + both credit PDFs per position into
`out/portal-download/<BASE>-<AIRCRAFT>-<POS>/`. It is **resumable** (files
already on disk are skipped — just run it again after a stall), logs to
`out/portal-download/run.log`, and takes `--only LAX-747,MIA-767` to limit the
sweep and `--fresh` to re-download everything. The browser profile with the
session cookies lives in `.browser-profile/` (gitignored — never commit it).

If a sign-in prompt appears mid-run, the script says `LOGIN NEEDED` in the
terminal and waits for you; anywhere else it stalls it retries on its own.
The first run (2026-09-10) completed 11/24 combos because the proxied session
was bounced periodically and the old script slept through it — the log will
show whether the recovery logic holds up.

`portal-review.js` in portal mode (`ATLAS_USERNAME`/`ATLAS_PASSWORD`) is kept
but no longer works; it explains why and points at the commands above.

**Two outputs of the review:**
1. A **review** (per-combo report + a `review-summary.json`).
2. The **parsed dataset** per combo under `tools/out/<month>/data/` — the
   per-line facts (guarantee, days-off, trips, deadheads, airports, line type),
   *not* scores. This is the groundwork for letting the app load pre-parsed data
   so pilots just pick aircraft/position/base (see "Roadmap" below).

### Privacy

The repo is **public**. The parsed dataset and the downloaded PDFs are written
to `tools/out/` (gitignored). No Atlas bid data is published anywhere until a
hosting/access model is chosen.

**Known tooling bug:** `--local` runs and `bid-file-doctor.js` overwrite the
committed fingerprint baseline for the combo they parse (`savedAt`/`appVersion`
rewritten). After a troubleshooting run, `git checkout -- fingerprints/` before
committing anything.

## Roadmap (data-in-app)

The intended end state: the monthly local run publishes the parsed dataset to a
**private/access-controlled** store, and `ABR.html` loads it when a pilot selects
aircraft/position/base — no fetch or manual upload needed for normal use (manual
upload stays as a fallback). The server does the fragile, format-dependent
parsing once a month; the app keeps doing the interactive scoring. Phase 1 (this
tooling) builds and validates that dataset privately; Phase 2 wires the app to it
once hosting is decided.

## Fingerprints

Each run writes `fingerprints/<BASE>-<AC>-<POS>.json` (a small history, last 24
months). These are committed so the baseline travels between machines; the next
month's run diffs against them automatically. They contain only structural
metadata (counts, ranges, formats) — no PDF content.

## Maintenance

If `ABR.html` renames or removes a parser, extraction fails fast with a clear
error. Update the `REQUIRED_FNS` list in `lib/abr-loader.js` (and the checks in
`bid-file-doctor.js`) to match. Keep `pdfjs-dist` in `package.json` pinned to the
version bundled in `ABR.html`.
