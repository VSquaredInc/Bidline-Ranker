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
