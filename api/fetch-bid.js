// Atlas Air portal document fetcher — RETIRED (v1.12.0, September 2026).
//
// Atlas moved the bid package library from the on-prem SharePoint at
// employees.atlasair.com (Basic/NTLM auth) to SharePoint Online at
// atlasairww.sharepoint.com, behind Microsoft Entra Conditional Access with
// Duo MFA and a Defender for Cloud Apps (.mcas.ms) session proxy. A server-side
// script cannot complete that sign-in on a pilot's behalf, and the old host no
// longer answers at all.
//
// The app stopped calling this endpoint in v1.12.0. It is kept deployed only so
// that users still running a cached pre-1.12 copy of the app (the service
// worker serves the old ABR.html for one launch after any deploy) get an
// immediate, readable explanation instead of hanging until the 30 s function
// timeout. It never reads or forwards credentials.
//
// The previous implementation is in git history (commit 36ca2f4 and earlier).

const PORTAL_URL = 'https://atlasairww.sharepoint.com/sites/Employees-FlightOps/SitePages/BidPackage.aspx';

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    return res.status(410).json({
        error: 'Automatic portal fetch is no longer available: the Atlas bid portal moved to a new site that '
             + 'requires Duo sign-in. Download the PDFs from the portal and use the "Upload Manually" tab. '
             + 'Close and reopen the app to get the latest version.',
        portalUrl: PORTAL_URL,
        retired: true
    });
};
