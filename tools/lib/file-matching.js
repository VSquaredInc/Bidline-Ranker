// Filename classification rules for the Atlas bid package library.
//
// Mirrors the matching logic in api/fetch-bid.js (bidline/credit detection,
// credit1 vs credit2 ordering) so the local portal-download.js crawler tags
// files the same way the app's own portal fetch used to. Kept here instead
// of importing api/fetch-bid.js directly because that file is written for
// the Vercel/axios-ntlm runtime, not plain Node file lists.

const MONTHS = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };

// Classify a flat list of filenames (as seen in one base/aircraft folder)
// for one crew position. Returns [{ name, role }] where role is one of
// 'bidline', 'credit1', 'credit2'.
function classifyFiles(filenames, crewPosition) {
  const pos = crewPosition.toUpperCase();
  const matched = [];

  for (const name of filenames) {
    const n = name.toUpperCase();

    const bidlinePositionMatch = new RegExp(`[\\s\\-]+\\s*${pos}(\\s|\\.|$)`).test(n);
    if (n.includes('BIDLINE') && bidlinePositionMatch) {
      matched.push({ name, role: 'bidline' });
      continue;
    }

    if (n.includes('LINES') && n.includes('PERIOD') &&
        !n.includes('VTO') && !n.includes('PRIMARY')) {
      matched.push({ name, role: 'credit' });
    }
  }

  function periodEndScore(name) {
    const m = name.match(/([A-Za-z]{3})(\d{2})-([A-Za-z]{3})(\d{2})/);
    if (!m) return 0;
    const endMon = MONTHS[m[3].toUpperCase()];
    const endYr = parseInt(m[4]) + 2000;
    return endYr * 12 + (endMon !== undefined ? endMon : 0);
  }
  const credits = matched.filter(f => f.role === 'credit')
    .sort((a, b) => periodEndScore(a.name) - periodEndScore(b.name));
  if (credits[0]) credits[0].role = 'credit1';
  if (credits[1]) credits[1].role = 'credit2';

  return matched;
}

module.exports = { classifyFiles };
