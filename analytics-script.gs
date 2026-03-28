/**
 * Atlas Bidline Ranker — Usage Analytics
 * Google Apps Script Web App
 *
 * SETUP INSTRUCTIONS
 * ──────────────────
 * 1. Go to https://sheets.google.com and create a new spreadsheet.
 *    Name it something like "Bidline Ranker Analytics".
 *
 * 2. In the spreadsheet, open Extensions → Apps Script.
 *
 * 3. Delete any existing code and paste the entire contents of this file.
 *
 * 4. Click Deploy → New deployment.
 *      Type:              Web app
 *      Execute as:        Me
 *      Who has access:    Anyone
 *    Click Deploy and authorize when prompted.
 *
 * 5. Copy the Web app URL (looks like:
 *    https://script.google.com/macros/s/AKfy.../exec)
 *
 * 6. In ABR.html, replace the ANALYTICS_URL placeholder with that URL:
 *      const ANALYTICS_URL = 'https://script.google.com/macros/s/AKfy.../exec';
 *
 * 7. Commit and push ABR.html. Done — events will start appearing in the sheet.
 *
 * NOTE: Any time you edit this script you must create a NEW deployment
 * (Deploy → New deployment) — editing an existing deployment does not update
 * the live URL.
 */

const SHEET_NAME = 'Events';

const COLUMNS = [
  'Timestamp',
  'User ID',
  'Session ID',
  'Event',
  'App Version',
  'Device',
  'Aircraft Type',
  'Base',
  'Position',
  'Lines Ranked',
  'Lines Excluded',
  'Has Credit Files',
  'Filter Primary',
  'Filter Secondary',
  'Filter Reserve',
  'Duration Filter',
  'Desired Dates Count',
  'Airport Prefs Used',
  'Error Message'
];

function getOrCreateSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    const header = sheet.getRange(1, 1, 1, COLUMNS.length);
    header.setValues([COLUMNS]);
    header.setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const sheet = getOrCreateSheet_();

    sheet.appendRow([
      data.ts            || new Date().toISOString(),
      data.userId        || '',
      data.sessionId     || '',
      data.event         || '',
      data.appVersion    || '',
      data.device        || '',
      data.aircraftType  || '',
      data.base          || '',
      data.position      || '',
      data.linesRanked   !== undefined ? data.linesRanked   : '',
      data.linesExcluded !== undefined ? data.linesExcluded : '',
      data.hasCreditFiles !== undefined ? data.hasCreditFiles : '',
      data.filterPrimary   !== undefined ? data.filterPrimary   : '',
      data.filterSecondary !== undefined ? data.filterSecondary : '',
      data.filterReserve   !== undefined ? data.filterReserve   : '',
      data.lineDurationFilter || '',
      data.desiredDatesCount  !== undefined ? data.desiredDatesCount  : '',
      data.airportPrefsUsed   !== undefined ? data.airportPrefsUsed   : '',
      data.errorMessage  || ''
    ]);

    return ContentService.createTextOutput('ok');
  } catch (err) {
    return ContentService.createTextOutput('error: ' + err.message);
  }
}
