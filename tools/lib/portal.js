// Thin client for the deployed Atlas portal fetch endpoint (the same Vercel
// function the app uses: api/fetch-bid.js). Going through the live endpoint
// means the reviewer exercises the REAL production folder/file-matching path —
// exactly where the recurring monthly breakage happens (folder renames, the
// BIDLINES->BIDLINE rename, etc.) — and lets the job reach the SharePoint via
// Vercel without needing the runner to reach employees.atlasair.com directly.
//
// Uses Node 18+ global fetch; no extra dependencies.

const DEFAULT_ENDPOINT = 'https://bidline.vercel.app/api/fetch-bid';

function endpoint() {
  return process.env.VERCEL_FETCH_URL || DEFAULT_ENDPOINT;
}

async function post(body) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  return { status: res.status, json };
}

// List the matched files for one base/aircraft/position.
// Returns { ok, files, folder, status, error }.
async function listFiles(creds, aircraft, base, crewPosition) {
  const { status, json } = await post({
    action: 'list', username: creds.username, password: creds.password,
    aircraft, base, crewPosition,
  });
  if (status === 200 && json && json.files) {
    return { ok: true, files: json.files, folder: json.folder, status };
  }
  return { ok: false, status, error: (json && json.error) || `HTTP ${status}`, folder: json && json.folder };
}

// Download one file (by its ServerRelativeUrl) and return it as a Buffer.
async function downloadFile(creds, fileUrl) {
  const { status, json } = await post({
    action: 'download', username: creds.username, password: creds.password, fileUrl,
  });
  if (status === 200 && json && json.data) {
    return Buffer.from(json.data, 'base64');
  }
  const msg = (json && json.error) || `HTTP ${status}`;
  throw new Error(`download failed: ${msg}`);
}

module.exports = { listFiles, downloadFile, endpoint };
