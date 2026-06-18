// Loads the REAL parser functions out of ABR.html and makes them callable in
// Node, so the doctor always exercises the exact code that ships to users
// (no drifting re-implementation). The parsers only depend on a `pdfjsLib`
// global and a mutable `bidPeriodStart` global — both supplied here.
//
// If ABR.html renames or removes one of these functions, extraction throws a
// clear error. That itself is a useful signal: the doctor's assumptions about
// the app have gone stale and need updating alongside the app.

const fs = require('fs');

const REQUIRED_FNS = [
  'extractTextFromPDF',
  'parseBidlineWithPositions',
  'detectFileType',
  'extractCreditPeriod',
  'parseCreditValue',
  'parseCreditByGeometry',
  'parseCreditFile',
];

// Extract a single function's source by brace-matching from its declaration.
// A small state machine skips braces that live inside comments or string
// literals so they don't throw off the count. (Regex quantifier braces like
// \d{2} are balanced pairs, so plain counting handles them correctly.)
function extractFunctionSource(html, name) {
  const decl = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = decl.exec(html);
  if (!m) throw new Error(`Could not find function ${name}() in ABR.html — has it been renamed?`);
  const start = m.index;
  let i = html.indexOf('{', start);
  if (i < 0) throw new Error(`Malformed function ${name}() — no opening brace.`);

  let depth = 0;
  let state = 'code'; // code | line | block | sq | dq | tpl
  for (; i < html.length; i++) {
    const c = html[i], n = html[i + 1];
    switch (state) {
      case 'code':
        if (c === '/' && n === '/') { state = 'line'; i++; }
        else if (c === '/' && n === '*') { state = 'block'; i++; }
        else if (c === "'") state = 'sq';
        else if (c === '"') state = 'dq';
        else if (c === '`') state = 'tpl';
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
        break;
      case 'line':  if (c === '\n') state = 'code'; break;
      case 'block': if (c === '*' && n === '/') { state = 'code'; i++; } break;
      case 'sq':    if (c === '\\') i++; else if (c === "'") state = 'code'; break;
      case 'dq':    if (c === '\\') i++; else if (c === '"') state = 'code'; break;
      case 'tpl':   if (c === '\\') i++; else if (c === '`') state = 'code'; break;
    }
  }
  throw new Error(`Unbalanced braces while extracting ${name}() from ABR.html.`);
}

// Build a live module of the app's parsers, sharing one mutable bidPeriodStart.
function loadAbrParsers(htmlPath, pdfjsLib) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  let body = 'let bidPeriodStart = null;\n';
  for (const name of REQUIRED_FNS) body += extractFunctionSource(html, name) + '\n';
  body += `return {
    ${REQUIRED_FNS.join(', ')},
    getBidPeriodStart: () => bidPeriodStart,
    resetBidPeriodStart: () => { bidPeriodStart = null; }
  };`;
  // eslint-disable-next-line no-new-func
  return new Function('pdfjsLib', body)(pdfjsLib);
}

// Read the APP_VERSION constant for reporting.
function readAppVersion(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  return m ? m[1] : 'unknown';
}

// Wrap a Buffer as the minimal File-like object the parsers expect.
function fileFromPath(p) {
  const fsp = require('fs');
  const path = require('path');
  return {
    name: path.basename(p),
    arrayBuffer: async () => {
      const b = fsp.readFileSync(p);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  };
}

module.exports = { loadAbrParsers, readAppVersion, fileFromPath, REQUIRED_FNS };
