#!/usr/bin/env node
/**
 * setup-ocr-assets.cjs
 *
 * Copies tesseract.js worker + core WASM into public/tesseract/ so they ship
 * inside the packaged app instead of being downloaded from a public CDN at
 * runtime. Also fetches the English language traineddata once and caches it.
 *
 * Run as part of `npm run build` so the dist/ folder always has the assets.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'public', 'tesseract');
const NM = path.join(PROJECT_ROOT, 'node_modules');

// Pinned traineddata version — bumping requires a deliberate code review since
// the file is fetched from GitHub once and committed implicitly via the build.
const TESSDATA_URL = 'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_fast/eng.traineddata.gz';
const TESSDATA_FILE = path.join(OUT_DIR, 'eng.traineddata.gz');

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function copy(src, dstDir) {
  if (!fs.existsSync(src)) {
    console.warn('[ocr-assets] missing source:', src);
    return false;
  }
  const dst = path.join(dstDir, path.basename(src));
  fs.copyFileSync(src, dst);
  return true;
}

function download(url, dst) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        return download(res.headers.location, dst).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const file = fs.createWriteStream(dst);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Timeout fetching ' + url)));
  });
}

(async () => {
  ensureDir(OUT_DIR);

  // 1. Worker
  copy(path.join(NM, 'tesseract.js', 'dist', 'worker.min.js'), OUT_DIR);

  // 2. Core WASM bundles. tesseract.js picks the best variant at runtime
  // based on browser features, so we ship all of them.
  const coreDir = path.join(NM, 'tesseract.js-core');
  if (fs.existsSync(coreDir)) {
    for (const f of fs.readdirSync(coreDir)) {
      if (f.startsWith('tesseract-core') && (f.endsWith('.js') || f.endsWith('.wasm'))) {
        copy(path.join(coreDir, f), OUT_DIR);
      }
    }
  }

  // 3. English traineddata — fetch once and cache
  if (!fs.existsSync(TESSDATA_FILE)) {
    console.log('[ocr-assets] downloading eng.traineddata.gz (one-time)…');
    try {
      await download(TESSDATA_URL, TESSDATA_FILE);
      const sz = fs.statSync(TESSDATA_FILE).size;
      console.log(`[ocr-assets] downloaded ${sz} bytes`);
    } catch (e) {
      console.error('[ocr-assets] FAILED to fetch traineddata:', e.message);
      // Don't fail the build — runtime will fall back to CDN. But warn loudly.
      console.error('[ocr-assets] WARNING: app will fall back to CDN for OCR data.');
    }
  } else {
    console.log('[ocr-assets] eng.traineddata.gz already present — skipping fetch');
  }

  console.log('[ocr-assets] done. Assets in', OUT_DIR);
})();
