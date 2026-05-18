# Atlas Air Bidline Ranker — Claude Code Instructions

This file travels with the repo (git + OneDrive) and is read automatically by Claude Code at the start of every session on any machine.

---

## Project Identity

**App name:** Bidline Ranker  
**Current version:** 1.2.0 (defined as `APP_VERSION` in ABR.html; displayed in footer at runtime)  
**Live URL:** https://vsquaredinc.github.io/Bidline-Ranker/ABR.html  
**GitHub repo:** https://github.com/VSquaredInc/Bidline-Ranker  
**Local path:** C:\Users\haine\OneDrive\Christopher\Coding\Bidline  
**Git user:** VSquaredInc / hainesusa@gmail.com  
**Developer:** Christopher Haines — visionvectorinc@gmail.com  
**Branding:** V² — Vision Vector Inc. Navy `#091d60`, gold `#ffb718`.

---

## About the User

Christopher is an Atlas Air pilot building this tool for personal and eventual commercial use. He has strong domain knowledge of airline operations (bidlines, deadheads, trip pairings, base airports, crew positions) but is not a professional developer. He tests manually by checking specific known line numbers against expected values. He works in short sessions across multiple devices and needs continuity between sessions.

---

## Required Steps After Every Editing Session

1. **Bump `APP_VERSION`** in ABR.html — patch (1.2.0→1.2.1) for small fixes, minor (1.2.0→1.3.0) for meaningful feature/fix sets.
2. **Bump `CACHE_NAME`** in service-worker.js — increment the number (e.g., `v9` → `v10`). **CRITICAL: this is what forces all existing users to download the new ABR.html.** If this is skipped, every returning visitor continues to run the old cached version indefinitely, regardless of how many times ABR.html is redeployed.
3. **Create a backup** — copy ABR.html to `backups/ABR_backup_YYYYMMDD_HHMMSS.html`.
4. **Commit and push** to GitHub — triggers GitHub Pages update automatically.
5. **Redeploy Vercel** if `api/fetch-bid.js` changed — user runs `npx vercel --prod` from the project directory.

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
| `backups/` | Timestamped HTML backups — never commit these to git |

**PDF parsing:** PDF.js runs in-browser. `parseBidlineWithPositions()` is the main parser. `parseCreditValue()` handles credit PDFs. PDF Y=0 is bottom; sort descending for top-to-bottom reading. `rowTolerance=3px`, `colTolerance=15px`.

**Portal fetch:** `api/fetch-bid.js` deployed on Vercel at `https://bidline.vercel.app/api/fetch-bid`. Supports both Basic Auth and NTLM against the Atlas Air SharePoint (`employees.atlasair.com/FlightOps/BidPackage`). Auto-detects auth type on first request.

---

## Bid Cycle Rules

- New bid packages are posted on the **15th of each month**.
- Each bid covers the **next two calendar months** (e.g., posted May 15 → covers June + July).
- Files are maintained through the **14th of the following month**.
- The bidline PDF header contains `CREW SCHEDULE FROM :MM/DD/YYYY TO MM/DD/YYYY` — this is the authoritative source for `bidPeriodStart` and `pageScheduleEnd`.
- All date defaults in the code must derive from `bidPeriodStart` (parsed from PDF) or `new Date()` — never hardcode a year or month number.

---

## Portal Folder & File Detection (api/fetch-bid.js)

**Folder finding:** Lists all folders in the BidPackage library, filters by folders containing both the base code (e.g., `ORD`) and aircraft type (e.g., `747`), then picks the one with the most recent date parsed from the folder name format `DD-MON YYYY` (e.g., `15-MAY 2026 ORD 747`). Fully dynamic — no hardcoded months.

**Bidline file match:** `n.includes('BIDLINES')` AND regex `[\s\-]+\s*{pos}(\s|\.|$)` — accepts any separator before the crew position (`747- FO`, `747 FO`, `747-FO`, etc.).

**Credit file match:** `n.includes('LINES') && n.includes('PERIOD')`, excluding `VTO` and `PRIMARY`.

**Credit file ordering:** Sorted by the **end date** of the period extracted from the filename (e.g., `May26-Jun26` → end = Jun 2026). This ensures the single-month file is always `credit1` and the two-month cumulative file is always `credit2`, regardless of which months are involved. (Alphabetical sort breaks when the second month name sorts before the first — e.g., Jun < May.)

---

## Key Parsing Concepts

- **`bidPeriodStart`** — global, set from the first page's `CREW SCHEDULE FROM` header; drives calendar open month and `defaultScheduleEnd` calculations.
- **`pageScheduleEnd`** — set per page from the `TO` date in the header. Fallback: `new Date(today.getFullYear(), today.getMonth() + 1, 1)` (first day of next month relative to today).
- **`defaultScheduleEnd`** (ranking logic) — derived from `bidPeriodStart`: BP1 lines = `bidPeriodStart + 1 month`, 60-day lines = `bidPeriodStart + 2 months`. Never hardcoded.
- **`baseYear`** fallback — `new Date().getFullYear()` in both parsers.

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
- Results table: 10 fixed-width columns
- Footer: developer name, email, V² branding, version number

---

## Beta Expiry

Currently set to `2026-08-01` in ABR.html (`DOMContentLoaded` handler). Covers May, June, and July bid cycles. Extend before August when ready.

---

## Future Considerations

- **Monetization:** when ready to charge, move from GitHub Pages to hosted+paywall (Gumroad download model or Netlify + access keys for PWA).
- **Repo visibility:** currently public (required for free GitHub Pages). Will need to go private when monetizing.
- **Icon:** higher-detail logo available in Downloads ("Golden pilot supporting the globe 1024.png").
