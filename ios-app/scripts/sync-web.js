// Copies the web app from the repo root into ios-app/www so Capacitor can bundle it.
// ABR.html stays the single source of truth; www/ is generated and gitignored.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const www = path.resolve(__dirname, '..', 'www');

const FILES = [
  ['ABR.html', 'index.html'],
  ['pdf.min.js'],
  ['pdf.worker.min.js'],
  ['icon-192.png'],
  ['icon-512.png'],
  ['Atlas Air Worldwide Logo.png'],
  ['ibt.png'],
  ['manifest.json'],
];

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });
for (const [src, dest = src] of FILES) {
  fs.copyFileSync(path.join(root, src), path.join(www, dest));
  console.log(`  ${src} -> www/${dest}`);
}
console.log('Web assets synced.');
