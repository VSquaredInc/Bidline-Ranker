// Atlas Air portal document fetcher
// Auto-detects whether the portal uses Basic Auth or NTLM on first request.

const { NtlmClient } = require('axios-ntlm');
const axios = require('axios');

const SHAREPOINT_HOST = 'https://employees.atlasair.com';
const SITE_PATH       = '/FlightOps';
const LIBRARY_PATH    = '/FlightOps/BidPackage';

const MONTHS = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };

// Encode spaces in a server-relative path so it is safe to embed in a URL
function spEncode(path) {
    return path.replace(/ /g, '%20');
}

// ── Auth type detection ───────────────────────────────────────────────────────
// Cached per warm Lambda instance (won't change between requests)
let cachedAuthType = null;

async function getAuthType() {
    if (cachedAuthType) return cachedAuthType;

    try {
        const probe = await axios.get(
            `${SHAREPOINT_HOST}${SITE_PATH}/_api/web/title`,
            { validateStatus: () => true, timeout: 8000 }
        );
        const wwwAuth = (probe.headers['www-authenticate'] || '').toLowerCase();
        cachedAuthType = wwwAuth.includes('basic') ? 'basic' : 'ntlm';
        console.log(`[fetch-bid] Auth type detected: ${cachedAuthType} (www-authenticate: "${wwwAuth}")`);
    } catch (e) {
        console.log(`[fetch-bid] Auth probe failed (${e.message}), defaulting to ntlm`);
        cachedAuthType = 'ntlm';
    }

    return cachedAuthType;
}

// ── Unified authenticated GET ─────────────────────────────────────────────────
// Returns a normalised { status, data, headers } regardless of auth type.
async function makeGet(url, username, password, config = {}) {
    const authType = await getAuthType();

    if (authType === 'basic') {
        const res = await axios.get(url, {
            ...config,
            auth: { username, password },
            validateStatus: () => true,
        });
        return { status: res.status, data: res.data, headers: res.headers };
    }

    // NTLM — must NOT pass validateStatus here; axios-ntlm's error interceptor
    // drives the NTLM handshake and only fires when axios throws on 401.
    const client = NtlmClient({ username, password, domain: '', workstation: '' });
    try {
        const res = await client.get(url, config);
        return { status: res.status, data: res.data, headers: res.headers };
    } catch (err) {
        // Catch HTTP errors (4xx/5xx) and return them as a normal response
        // so callers can check status codes consistently.
        if (err.response) {
            return { status: err.response.status, data: err.response.data, headers: err.response.headers };
        }
        throw err; // re-throw network / connection errors
    }
}

// ── List the matching files for a given aircraft / base / crew position ───────
async function listFiles(username, password, aircraft, base, crewPosition) {

    // 1. Enumerate all folders in the BidPackage library
    const foldersUrl =
        `${SHAREPOINT_HOST}${SITE_PATH}/_api/web` +
        `/GetFolderByServerRelativeUrl('${LIBRARY_PATH}')` +
        `/Folders?$select=Name,ServerRelativeUrl`;

    const foldersRes = await makeGet(foldersUrl, username, password, {
        headers: { Accept: 'application/json;odata=nometadata' }
    });

    if (foldersRes.status === 401) {
        const wwwAuth = foldersRes.headers['www-authenticate'] || '(none)';
        const authUsed = await getAuthType();
        console.log(`[fetch-bid] 401 on folder list. Auth used: ${authUsed}. WWW-Authenticate: "${wwwAuth}"`);
        const err = new Error('Invalid username or password.');
        err.statusCode = 401;
        throw err;
    }
    if (foldersRes.status !== 200) {
        const err = new Error(`Portal returned HTTP ${foldersRes.status}.`);
        err.statusCode = 502;
        throw err;
    }

    // Support both odata=nometadata (value) and odata=verbose (d.results)
    const foldersData = foldersRes.data;
    const folders = foldersData.value || (foldersData.d && foldersData.d.results) || [];

    // 2. Keep only folders whose name contains both base and aircraft type
    const matching = folders.filter(f => {
        const n = f.Name.toUpperCase();
        return n.includes(base.toUpperCase()) && n.includes(aircraft);
    });

    if (matching.length === 0) {
        const err = new Error(`No bid folder found for ${aircraft} at ${base}. Check that the current bid has been published.`);
        err.statusCode = 404;
        throw err;
    }

    // 3. Find the most recently dated folder — format: "DD-MON YYYY BASE AIRCRAFT"
    let targetFolder = null;
    let latestDate   = null;
    for (const folder of matching) {
        const m = folder.Name.match(/(\d{2})-([A-Z]{3})\s+(\d{4})/i);
        if (m) {
            const mon = MONTHS[m[2].toUpperCase()];
            if (mon !== undefined) {
                const d = new Date(parseInt(m[3]), mon, parseInt(m[1]));
                if (!latestDate || d > latestDate) { latestDate = d; targetFolder = folder; }
            }
        }
    }

    if (!targetFolder) {
        const err = new Error(`Could not parse bid-period date from folder names for ${aircraft} at ${base}.`);
        err.statusCode = 404;
        throw err;
    }

    // 4. List all files inside the target folder
    const encodedFolderPath = spEncode(targetFolder.ServerRelativeUrl);
    const filesUrl =
        `${SHAREPOINT_HOST}${SITE_PATH}/_api/web` +
        `/GetFolderByServerRelativeUrl('${encodedFolderPath}')` +
        `/Files?$select=Name,ServerRelativeUrl`;

    const filesRes = await makeGet(filesUrl, username, password, {
        headers: { Accept: 'application/json;odata=nometadata' }
    });

    if (filesRes.status !== 200) {
        const err = new Error(`Could not list files in folder (HTTP ${filesRes.status}).`);
        err.statusCode = 502;
        throw err;
    }

    const filesData = filesRes.data;
    const allFiles  = filesData.value || (filesData.d && filesData.d.results) || [];

    // 5. Filter to the three document types we need
    const pos = crewPosition.toUpperCase(); // "CA" or "FO"
    const matched = [];

    for (const f of allFiles) {
        const n = f.Name.toUpperCase();

        // Bidline schedule for the pilot's crew position
        if (n.includes('BIDLINES') && n.includes(`- ${pos}`)) {
            matched.push({ name: f.Name, url: f.ServerRelativeUrl, role: 'bidline' });
            continue;
        }

        // Line-value PDFs: must contain "LINES" and "PERIOD"
        // Exclude VTO ("PERIOD VTO") and primary-line-value files ("PRIMARY")
        if (n.includes('LINES') && n.includes('PERIOD') &&
            !n.includes('VTO') && !n.includes('PRIMARY')) {
            matched.push({ name: f.Name, url: f.ServerRelativeUrl, role: 'credit' });
        }
    }

    if (matched.length === 0) {
        const err = new Error(
            `No matching files found for ${crewPosition} in "${targetFolder.Name}". ` +
            `Verify the bid has been published for this position.`
        );
        err.statusCode = 404;
        throw err;
    }

    // 6. Assign credit roles: sort alphabetically so "Apr-Apr" < "Apr-May"
    //    making credit1 the single-month file and credit2 the two-month file
    const credits = matched.filter(f => f.role === 'credit').sort((a, b) => a.name.localeCompare(b.name));
    if (credits[0]) credits[0].role = 'credit1';
    if (credits[1]) credits[1].role = 'credit2';

    return { files: matched, folder: targetFolder.Name };
}

// ── Download a single file and return it as a base64 string ──────────────────
async function downloadFile(username, password, serverRelativeUrl) {
    const url = `${SHAREPOINT_HOST}${spEncode(serverRelativeUrl)}`;
    const res = await makeGet(url, username, password, { responseType: 'arraybuffer' });

    if (res.status !== 200) {
        const err = new Error(`File download failed (HTTP ${res.status}).`);
        err.statusCode = 502;
        throw err;
    }

    return Buffer.from(res.data).toString('base64');
}

// ── Vercel handler ────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed.' });

    const { action, username, password, aircraft, base, crewPosition, fileUrl } = req.body || {};

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
    }

    try {
        if (action === 'list') {
            if (!aircraft || !base || !crewPosition) {
                return res.status(400).json({ error: 'Aircraft, base, and crew position are required.' });
            }
            const result = await listFiles(username, password, aircraft, base, crewPosition);
            return res.status(200).json(result);

        } else if (action === 'download') {
            if (!fileUrl) {
                return res.status(400).json({ error: 'fileUrl is required.' });
            }
            const data = await downloadFile(username, password, fileUrl);
            return res.status(200).json({ data });

        } else {
            return res.status(400).json({ error: `Unknown action "${action}".` });
        }

    } catch (err) {
        const status = err.statusCode || 500;
        console.error(`[fetch-bid] ${err.message}`);
        return res.status(status).json({ error: err.message });
    }
};
