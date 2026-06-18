// Month-over-month structural fingerprints. Each run saves a compact JSON
// snapshot of "what this month's files look like" keyed by base/aircraft/
// position, so the next run can diff against the last known-good month and
// surface exactly what changed (filename pattern, credit table format, value
// ranges, new line types, etc.).

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'fingerprints');

function keyFor(fp) {
  return `${fp.base || 'XXX'}-${fp.aircraft || 'XXX'}-${fp.position || 'XX'}`;
}

function fileFor(fp) {
  return path.join(DIR, `${keyFor(fp)}.json`);
}

function loadHistory(fp) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(fp), 'utf8'));
  } catch {
    return [];
  }
}

// Most recent saved snapshot for a DIFFERENT period than the current one.
function priorSnapshot(history, currentPeriod) {
  const others = history
    .filter(h => h.period && h.period !== currentPeriod)
    .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  return others[0] || null;
}

function save(fp) {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  // Drop transient, report-only fields (e.g. _priorPeriod) before persisting.
  const clean = {};
  for (const k of Object.keys(fp)) if (!k.startsWith('_')) clean[k] = fp[k];
  fp = clean;
  const history = loadHistory(fp);
  const idx = history.findIndex(h => h.period === fp.period);
  if (idx >= 0) history[idx] = fp; else history.push(fp);
  // keep the last 24 months
  const trimmed = history.slice(-24);
  fs.writeFileSync(fileFor(fp), JSON.stringify(trimmed, null, 2));
  return fileFor(fp);
}

// Human-readable diff of the fields that matter for "did the format change?".
function diff(prev, cur) {
  if (!prev) return [];
  const changes = [];
  const note = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push(`${label}: ${fmt(a)} -> ${fmt(b)}`);
  };
  note('credit table format', prev.creditFormat, cur.creditFormat);
  note('bidline filename matches portal', prev.filenameBidlineOk, cur.filenameBidlineOk);
  note('credit filename matches portal', prev.filenameCreditOk, cur.filenameCreditOk);
  note('header date parsed', prev.headerDateOk, cur.headerDateOk);
  note('credit guarantee landmark found', prev.creditLandmarkOk, cur.creditLandmarkOk);

  // Line-type set changes (new or vanished types).
  const prevTypes = new Set(Object.keys(prev.lineTypeHistogram || {}));
  const curTypes = new Set(Object.keys(cur.lineTypeHistogram || {}));
  const added = [...curTypes].filter(t => !prevTypes.has(t));
  const gone = [...prevTypes].filter(t => !curTypes.has(t));
  if (added.length) changes.push(`new line type(s): ${added.join(', ')}`);
  if (gone.length) changes.push(`line type(s) no longer present: ${gone.join(', ')}`);

  // A jump in the "guarantee not read" rate is the strongest "parser regressed"
  // signal (0/missing guarantees, not legitimate contract-minimum 64s).
  if (prev.primaryUnreadPct != null && cur.primaryUnreadPct != null) {
    const delta = cur.primaryUnreadPct - prev.primaryUnreadPct;
    if (Math.abs(delta) >= 15) {
      changes.push(`primary lines with no guarantee read: ${prev.primaryUnreadPct}% -> ${cur.primaryUnreadPct}% (${delta > 0 ? '+' : ''}${delta}%)`);
    }
  }
  // Guarantee range shifts can indicate column mis-mapping.
  if (prev.guaranteeRange && cur.guaranteeRange) {
    note('guarantee range', prev.guaranteeRange, cur.guaranteeRange);
  }
  return changes;
}

function fmt(v) {
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return String(v);
}

module.exports = { loadHistory, priorSnapshot, save, diff, keyFor };
