# Atlas Air Bidline Ranker — Claude Code Instructions

This file travels with the repo (git + OneDrive) and is read automatically by Claude Code at the start of every session on any machine.

---

## Project Identity

**App name:** Bidline Ranker  
**Current version:** 1.7.0 (defined as `APP_VERSION` in ABR.html; displayed in footer at runtime)  
**Current CACHE_NAME:** `bidline-ranker-v13` (in service-worker.js)  
**Live URL:** https://vsquaredinc.github.io/Bidline-Ranker/ABR.html  
**GitHub repo:** https://github.com/VSquaredInc/Bidline-Ranker  
**Local path:** C:\Users\haine\OneDrive\Christopher\Coding\Bidline  
**Git user:** VSquaredInc / hainesusa@gmail.com  
**Developer:** Christopher Haines — visionvectorinc@gmail.com  
**Branding:** V² — Vision Vector Inc. Navy `#091d60`, gold `#ffb718`.

---

## About the User

Christopher is an Atlas Air pilot building this tool for personal and eventual commercial use. He has strong domain knowledge of airline operations (bidlines, deadheads, trip pairings, base airports, crew positions) but is not a professional developer. He tests manually by checking specific known line numbers against expected values. He works in short sessions across multiple devices and needs continuity between sessions.

**Node.js** is NOT installed on all machines. On machines without Node.js, Vercel must be redeployed via the Vercel dashboard, not via CLI.

---

## Required Steps After Every Editing Session

1. **Bump `APP_VERSION`** in ABR.html — patch (1.6.9→1.6.10) for small fixes, minor (1.6.9→1.7.0) for meaningful feature/fix sets.
2. **Bump `CACHE_NAME`** in service-worker.js — increment the number (e.g., `v12` → `v13`). **CRITICAL: this is what forces all existing users to download the new ABR.html.** If this is skipped, every returning visitor continues to run the old cached version indefinitely, regardless of how many times ABR.html is redeployed.
3. **Create a backup** — copy ABR.html to `backups/ABR_backup_YYYYMMDD_HHMMSS.html`.
4. **Commit and push** to GitHub — triggers GitHub Pages update automatically.
5. **Redeploy Vercel** if `api/fetch-bid.js` changed — user runs `npx vercel --prod` from the project directory (or via Vercel dashboard on machines without Node.js).

---

## Architecture

All app logic lives in a single file: **`ABR.html`** — no build step, no framework.

| File | Purpose |
|---|---|
| `ABR.html` | Entire app — parsing, ranking, UI, portal fetch client |
| `api/fetch-bid.js` | Vercel serverless function — authenticates to Atlas Air SharePoint and downloads bid PDFs |
| `service-worker.js` | PWA cache-first offline support |
| `manifest.json` | PWA manifest (name, icons, theme) |
| `pdf.min.js` / `pdf.worker.min.js` | PDF.js v3.11.174 bundled locally (not CDN) |
| `tools/` | Maintenance tooling (not shipped). `bid-file-doctor.js` — see below |
| `backups/` | Timestamped HTML backups — never commit these to git |

**PDF parsing:** PDF.js runs in-browser. `parseBidlineWithPositions()` is the main bidline parser; `parseCreditByGeometry()` parses 2026 credit PDFs positionally (legacy `parseCreditValue()` is the pre-2026 fallback). PDF Y=0 is bottom; sort descending for top-to-bottom reading. `rowTolerance=3px`, `colTolerance=15px`.

**Portal fetch:** `api/fetch-bid.js` deployed on Vercel at `https://bidline.vercel.app/api/fetch-bid`. Supports both Basic Auth and NTLM against the Atlas Air SharePoint (`employees.atlasair.com/FlightOps/BidPackage`). Auto-detects auth type on first request.

**Monthly file-review tool (`tools/bid-file-doctor.js`):** Run when a new bid posts, before assuming the new PDFs parse cleanly. It loads the *real* parsers out of `ABR.html` (via `lib/abr-loader.js`, so it tests shipped code, not a copy), runs them against a folder of that month's PDFs, checks invariants, and diffs against last month's saved fingerprint (`tools/fingerprints/<BASE>-<AC>-<POS>.json`). Surfaces filename-pattern changes, credit-table format changes, new/renamed line types, dropped lines, and the "everything floored to 64" symptom. Usage: `cd tools && npm install` (once), then `node bid-file-doctor.js "../LAX"`. Node-only, run on the dev machine. If `ABR.html` renames a parser, update `REQUIRED_FNS` in `lib/abr-loader.js`. See `tools/README.md`.

---

## Bid Cycle Rules

- New bid packages are posted on the **15th of each month**.
- Each bid covers the **next two calendar months** (e.g., posted May 15 → covers June + July).
- Files are maintained through the **14th of the following month**.
- The bidline PDF header contains `CREW SCHEDULE FROM :MM/DD/YYYY TO MM/DD/YYYY` — this is the authoritative source for `bidPeriodStart` and `pageScheduleEnd`.
- All date defaults in the code must derive from `bidPeriodStart` (parsed from PDF) or `new Date()` — never hardcode a year or month number.

---

## Portal Folder & File Detection (api/fetch-bid.js)

**Folder finding:** Lists all folders in the BidPackage library, filters by folders containing both the base code (e.g., `ORD`) and aircraft type (e.g., `747`), then picks the one with the most recent date parsed from the folder name format `DD-MON YYYY` (e.g., `15-MAY 2026 ORD 747`). Fully dynamic — no hardcoded months. **Fallback:** if no date can be parsed from any folder name (e.g., Atlas Air renames folders), falls back to the alphabetically last matching folder.

**Bidline file match:** `n.includes('BIDLINE')` AND regex `[\s\-]+\s*{pos}(\s|\.|$)` — accepts both singular (`BIDLINE`, Jul 2026 onward) and plural (`BIDLINES`, pre-Jul 2026) forms, with any separator before the crew position (`747- FO`, `747 FO`, `747-FO`, etc.). Atlas switched to the singular filename starting with the Jul 2026 posting. Primary detection also checks for `CREW SCHEDULE FROM` in the PDF text (case-insensitive date-column regex added in v1.5.5 for all-caps PDF formats).

**Credit file match:** `n.includes('LINES') && n.includes('PERIOD')`, excluding `VTO` and `PRIMARY`.

**Credit file ordering:** Sorted by the **end date** of the period extracted from the filename (e.g., `May26-Jun26` → end = Jun 2026). This ensures the single-month file is always `credit1` and the two-month cumulative file is always `credit2`, regardless of which months are involved. (Alphabetical sort breaks when the second month name sorts before the first — e.g., Jun < May.)

---

## Key Parsing Concepts

- **`bidPeriodStart`** — global, set from the first page's `CREW SCHEDULE FROM` header; drives calendar open month and `defaultScheduleEnd` calculations.
- **`pageScheduleEnd`** — set per page from the `TO` date in the header. Fallback: `new Date(today.getFullYear(), today.getMonth() + 1, 1)` (first day of next month relative to today).
- **`defaultScheduleEnd`** (ranking logic) — derived from `bidPeriodStart`: BP1 lines = `bidPeriodStart + 1 month`, 60-day lines = `bidPeriodStart + 2 months`. Never hardcoded.
- **`baseYear`** fallback — `new Date().getFullYear()` in both parsers.

### Credit PDF Parsing

**Active parser (v1.7.1+): `parseCreditByGeometry(file)`** — reads the 2026 column-per-line format **positionally** (groups text items into rows by Y, maps each value to its line number by X-coordinate), the same approach as `parseBidlineWithPositions()`. Dispatched via `parseCreditFile(file, text)`: geometry parser when the text contains `SUM OF CREDITS`, else falls back to the legacy `parseCreditValue(text)`.

**Why geometry, not flat text:** `extractTextFromPDF()` collapses the PDF into line-strings, and on some PDFs (e.g. Jul 2026 LAX 747) the guarantee row and the line-number rows fragment and interleave *by column*. This caused the old text parser to (a) silently drop ~half the lines when a line-number row got merged with neighbouring text, and (b) read the guarantee as 0 or mis-map it — so every line floored to the 64 hr contract minimum. The positional parser is immune to this collapse.

**Guarantee row** is identified as the topmost row whose label band (x < 175) contains `ART33` and which has real (non-zero) numeric cells — i.e. "SUM GREATER OF CREDIT OR RIG w ART33 AND ULR", which sits above the all-zero "Art 33 PREM" row. Days-off comes from the `Off` row; line types from the Primary/Secondary/Reserve string cells. For 60-day lines, credit1 (single month) and credit2 (two-month cumulative) are averaged in the merge step.

The legacy `parseCreditValue()` (flat-text) is retained only as the fallback for pre-2026 formats.

---

## Line Types (8 total, confirmed across all PDFs)

1. Primary Int
2. Primary AdH
3. Primary 60-day Int ← PDF shows "Primary 60-day In" (truncated)
4. Primary 60-day AdH ← PDF shows "Primary 60-day Ad" (truncated)
5. Secondary AdH
6. Secondary 60-day (no suffix)
7. Reserve AdH
8. Reserve 60-day AdH ← PDF shows "Reserve 60-day Ad" (truncated)

Reserve lines do NOT appear in credit PDFs. Fallback: guarantee=0, daysOff from bidline `DaysOFF>` count.

---

## Scoring Formula

**Effective value:** `guarantee + ((daysOff − avgDaysOff) × dayOffValue)`

Where:
- `avgDaysOff` is the average days off across all **candidate** (filtered) lines — not the full set
- `dayOffValue` is set by the **Ranking Priority** slider (3-position discrete):
  - **Guarantee** → 0 (days off ignored, rank purely by pay)
  - **Balanced** → 4.85 hrs/day
  - **Days Off** → 10.85 hrs/day

**Contract minimum:** Any line with guarantee < 64 hrs floors at 64 (covers Reserve lines which have no credit PDF data).

**Airport scoring:** Range-based log₂ scaling — `(pct/100) × valueRange × log₂(1 + matchCount)`. Symmetric: equal whitelist/blacklist match counts cancel exactly. Operates as an additive adjustment on top of effective value.

**60-day lines:** `(bp1Score + bp2Score) / 2` — normalized to a per-period basis for fair comparison with 30-day lines. BP2 scoring uses `nativeDaysOffBP2` as fallback when no credit file is uploaded.

---

## Conflict Optimizer

Two modes accessible via the results table: **Vacation Slide** and **Training Overlap**.

### Vacation Slide Mode
Computes the optimal legal vacation slide for each line given a conflict period (training or scheduling conflict). Implements CBA Article 7 rules (see below). Shows: conflict days covered, effective days off gained, score, slide dates.

**Trips display:** "Before" section (strikethrough) → "After" section. Training dates shown in After section labeled `tng` (e.g., `tng Jul 14–17`).

### Training Overlap Mode
Scores how well training dates land on already-scheduled workdays:
- Green ✓ = all training on workdays
- Orange ⚠ = partial overlap
- Red ✗ = all training on off-days

`effDaysOff = nativeDaysOff + overlapDays − offDaysInTraining` (training on off-days is penalized).

### Cross-Period Trip Attribution
`evalVacContribForPeriod()` accepts period bounds and clips trips at the BP1/BP2 boundary. Trips starting in BP1 but ending in BP2 are no longer attributed entirely to BP1. Training scoring uses `lineTrips` (all trips) so cross-boundary workdays are correctly evaluated.

---

## CBA Vacation Slide Rules (Article 7)

Implemented from Atlas Article 7.pdf (governing source):

| Article | Rule |
|---|---|
| 7.D.2.b | Anchor rule — at least one original vacation day must remain in place |
| 7.D.2.c | Partial conflict cap — slide only until the first **full** conflict day, then stop |
| 7.D.2.d | Partially conflicted vacation must abut Days-Off |
| 7.D.4 | Fully conflicted vacation may slide in either direction (with anchor) |
| 7.D.5 | Exempt weeks — company may designate up to 4 (max 1/month); sliding OUT is explicitly permitted |
| 7.D.7 | Award Days — ≤3 workdays at ONE edge of a trip pairing; only one set per vacation period |

**Source verification:** Atlas Article 25.pdf does NOT mention exempt weeks (25.K covers vacation bid period mechanics only). The IBT Teaching Topic (Vacation Slide.pdf, May 2024) is a user-friendly summary and source for the exempt weeks list and Award Days/exempt weeks intersection — but is NOT the governing CBA.

### Restricted Weeks

`RESTRICTED_WEEKS` — array of `{ start, end }` date objects representing the actual calendar weeks Atlas Air designates as restricted for the current bid year. Update annually when Atlas Air publishes the exempt weeks in bid materials.

**Current values (2026):**
- Jun 28 – Jul 4
- Sep 6 – Sep 12
- Nov 22 – Nov 28
- Dec 20 – Dec 26

**Implementation:**
- `restrictedWeeksIn(start, end)` — returns Set of RESTRICTED_WEEKS indices that overlap a date range (date-range overlap check, not ISO week math)
- Slide positions that would enter a restricted week the pilot was NOT already in are skipped
- `origRestrictedWeeks` computed from original `vacStart`/`vacEnd` — sliding OUT of a restricted week is allowed

**Award Days + restricted weeks:** `awardA`/`awardB` are zeroed when the pre/post-vacation workdays fall inside a restricted week. Note: 7.D.7 is silent on this — this rule comes from the IBT Teaching Topic only (conservative implementation).

---

## Deadhead (DH) Detection

- **Front DH:** `* [base]` pattern at the start of a trip column, where the previous column has no trip content (airports/times/flight numbers). WORK/reserve days count as "off" for this check.
- **Back DH (same day):** `* [non-base] [base]` all in one column, next column off, no airports after base.
- **Back DH (overnight):** `* [non-base]` today, base is first airport in next column, column after next is off.
- Mid-trip `*` markers must NOT be counted. At most one front DH and one back DH per column.

### hasContent check (prevents 2-letter airline codes from bleeding)
Content is real only if it matches: airport pattern (3-letter, not in excludeCodes) OR `/^\w{4,}/` (flight numbers) OR `/:\d{2}/` (times) OR `WORK`.

### Validated lines (April 2026 ORD 747 FO)
| Line | Front DH | Back DH |
|---|---|---|
| 4111 | 2 | 0 |
| 4112 | ? | 1 |
| 4164 | 2 | 3 |
| 4168 | 3 | 2 |
| 4190 | 2 | 2 |
| 4206 | 3 | 3 |

---

## Off-Day Detection

- X markers are searched across **all rows in a bidline block** (not just the schedule row).
- Blank columns are **not** reliable off-day indicators — do not use as fallback.
- `scheduleEnd` promotion on merge: only for `lineType.includes('60-day')` lines.
- BP1 lines can appear on the second-month page when a trip ends just before the month boundary — this must NOT promote `scheduleEnd`.

---

## UI Notes

- White header: Atlas Air logo (left) | divider | title | How to Use button | divider | IBT logo (right)
- Two upload sources: "Fetch from Portal" tab and "Upload Manually" tab
- Three file slots: Bidline Schedule (required), Line Credit Month 1 (optional), Line Credit Month 2 (optional)
- Filters: Line Type checkboxes (Primary/Secondary/Reserve), Line Duration, Dates Desired Off (date ranges), Airport Preferences (whitelist/blacklist, absolute or % adjustment)
- Results table: 10 fixed-width columns; Conflict Optimizer columns added when optimizer mode is active
- Footer: developer name, email, V² branding, version number

---

## Known Open Items

- **ISO week accuracy:** July 4, 2026 is ISO week 27 — verify published Jun/Jul 2026 bid materials confirm which weeks Atlas Air designated as exempt for this cycle. Update `EXEMPT_ISO_WEEKS` if needed.
- **ANC CA pilot confirmation:** The vacation slide fix (partial conflict cap, v1.6.4+) has not yet been confirmed working by the ANC CA pilot who reported the original bug.

---

## Beta Expiry

Currently set to `2026-08-01` in ABR.html (`DOMContentLoaded` handler). Covers May, June, and July bid cycles. Extend before August when ready.

---

## Future Considerations

- **Monetization:** when ready to charge, move from GitHub Pages to hosted+paywall (Gumroad download model or Netlify + access keys for PWA).
- **Repo visibility:** currently public (required for free GitHub Pages). Will need to go private when monetizing.
- **Icon:** higher-detail logo available in Downloads ("Golden pilot supporting the globe 1024.png").
