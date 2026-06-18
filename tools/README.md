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

## Automated monthly review from the portal (`portal-review.js`)

`bid-file-doctor.js` checks a local folder. `portal-review.js` does the same
checks but pulls the files itself from the Atlas portal — for **every**
base/aircraft/position — so nothing has to be downloaded by hand. It runs
automatically on the 15th via `.github/workflows/monthly-bid-review.yml`.

It fetches through the app's own endpoint (`api/fetch-bid.js` on Vercel), which
means it also exercises the real folder/file-matching logic — the part that
breaks when Atlas renames things. It iterates the `AIRCRAFT_BASES` map read
straight from `ABR.html` (747/767/777 × their bases × CA/FO).

```
# all combos from the portal (needs credentials):
ATLAS_USERNAME=... ATLAS_PASSWORD=... node portal-review.js

# credential-free: run the same review + dataset build on a local folder
node portal-review.js --local ../LAX
```

**Two outputs:**
1. A **review** (per-combo report + a `review-summary.json`). In CI the job
   *fails* — emailing you — if any combo shows an error, so you hear about a
   format change without watching anything.
2. The **parsed dataset** per combo under `tools/out/<month>/data/` — the
   per-line facts (guarantee, days-off, trips, deadheads, airports, line type),
   *not* scores. This is the groundwork for letting the app load pre-parsed data
   so pilots just pick aircraft/position/base (see "Roadmap" below).

### Privacy

The repo is **public**, so CI artifacts are publicly downloadable. The workflow
therefore uploads **only** `review-summary.json` (counts/findings — no bid
content). The parsed dataset is written to `tools/out/` (gitignored) and is only
produced in full when **you** run `portal-review.js` locally with your
credentials. No Atlas bid data is published anywhere until a hosting/access
model is chosen.

### CI setup (once)

Add repository secrets `ATLAS_USERNAME` and `ATLAS_PASSWORD`
(Settings → Secrets and variables → Actions). Trigger a manual test run from the
Actions tab ("Monthly Bid File Review" → Run workflow) to confirm it can log in
and fetch before relying on the schedule.

## Roadmap (data-in-app)

The intended end state: the monthly job publishes the parsed dataset to a
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
