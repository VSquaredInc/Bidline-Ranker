# Bidline Ranker — iPad app

A native iPad wrapper (Capacitor 8) around `../ABR.html`. **ABR.html stays the only
source of app logic** — this folder just packages it. The web PWA is unaffected.

## How it fits together

| Path | What it is |
|---|---|
| `scripts/sync-web.js` | Copies ABR.html (as `index.html`), PDF.js, logos into `www/` (generated, gitignored) |
| `capacitor.config.json` | App ID `com.visionvector.bidlineranker`, name, navy background |
| `ios/` | Xcode project (Swift Package Manager, no CocoaPods). iPad-only, v1.16.0 |
| `../.github/workflows/ios-build.yml` | Builds on a GitHub-hosted Mac; outputs an unsigned `.ipa` |

Native-only behaviour in ABR.html is gated on `IS_NATIVE_APP`:
- service worker is skipped (files are bundled; nothing to cache)
- CSV export opens the iOS share sheet (Save to Files / Mail / AirDrop) instead of a download
- analytics `device` = `ios-app`

## Building (no Mac needed)

Pushing a change to `ABR.html` or `ios-app/` on `main` builds automatically. Or run it by hand:

    gh workflow run ios-build.yml
    gh run watch
    gh run download --name BidlineRanker-<version>-unsigned

## Installing on your own iPad (free Apple ID, no developer account)

1. Install **Sideloadly** (sideloadly.io) and **iTunes from apple.com** (not the Microsoft Store version — Sideloadly needs its USB drivers).
2. Plug the iPad into the PC by USB, tap **Trust**.
3. Drag the `.ipa` into Sideloadly, enter your Apple ID, click **Start**.
4. On the iPad: **Settings → General → VPN & Device Management** → trust your Apple ID.
   On iPadOS 16+ also turn on **Settings → Privacy & Security → Developer Mode** (iPad restarts).

Limits of the free route: the app **stops opening after 7 days** (re-run Sideloadly to refresh;
Sideloadly can auto-refresh over Wi-Fi while the PC is on), max 3 sideloaded apps, and it only
works on devices you plug in yourself — you cannot hand it to other pilots this way.

## Updating the app

Edit ABR.html as usual → commit/push → download the new `.ipa` → re-sideload.
Unlike the PWA there is no stale-cache launch: the new version is there on first open.

## Next: TestFlight (to give it to other pilots)

Needs the Apple Developer Program ($99/yr). Then: register the bundle ID, create the app in
App Store Connect, add an App Store Connect API key + distribution certificate as GitHub
secrets, and extend the workflow with a signed archive + upload step.
