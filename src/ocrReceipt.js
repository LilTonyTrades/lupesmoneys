/**
 * ocrReceipt.js
 * Local receipt OCR using pdfjs-dist (PDF → canvas) + tesseract.js (image → text).
 * No external API calls — everything runs on-device.
 */

import * as pdfjsLib from 'pdfjs-dist';

// Resolve the PDF.js worker URL. In a packaged Electron app the worker file
// sits inside an ASAR archive which web workers cannot read directly, so we
// redirect to the unpacked copy that electron-builder places alongside the ASAR.
let _workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href;

if (_workerSrc.includes('app.asar/')) {
  _workerSrc = _workerSrc.replace('app.asar/', 'app.asar.unpacked/');
}

pdfjsLib.GlobalWorkerOptions.workerSrc = _workerSrc;

console.log('[OCR] Module loaded. PDF worker src:', pdfjsLib.GlobalWorkerOptions.workerSrc);

// ─── PDF → canvas data URL ────────────────────────────────────────────────────
async function pdfToImageDataUrl(base64data) {
  console.log('[OCR] pdfToImageDataUrl: decoding base64, length =', base64data.length);

  const binary = atob(base64data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  console.log('[OCR] pdfToImageDataUrl: calling pdfjsLib.getDocument(), bytes =', bytes.length);

  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  } catch (e) {
    console.error('[OCR] pdfjsLib.getDocument() failed:', e);
    throw new Error('PDF render failed: ' + (e.message || String(e)));
  }

  console.log('[OCR] PDF loaded, pages =', pdf.numPages);

  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2.5 });
  console.log('[OCR] Page viewport:', viewport.width, 'x', viewport.height);

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  try {
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  } catch (e) {
    console.error('[OCR] page.render() failed:', e);
    throw new Error('PDF page render failed: ' + (e.message || String(e)));
  }

  const dataUrl = canvas.toDataURL('image/png');
  console.log('[OCR] Canvas rendered, dataUrl length =', dataUrl.length);
  return dataUrl;
}

// ─── Text → structured fields ─────────────────────────────────────────────────
function parseReceiptText(text) {
  console.log('[OCR] Raw OCR text (' + text.length + ' chars):\n', text.slice(0, 600));

  // ── Amount ──────────────────────────────────────────────────────────────────
  let amount = null;
  const labelRe = /(?:total|amount\s+(?:due|paid|charged)|grand\s+total|balance\s+due|subtotal)[^$\d\n]*\$?\s*([\d,]+\.?\d{0,2})/gi;
  const labelMatches = [...text.matchAll(labelRe)];
  if (labelMatches.length) {
    amount = parseFloat(labelMatches[labelMatches.length - 1][1].replace(/,/g, ''));
    console.log('[OCR] Amount via label match:', amount);
  }
  if (!amount) {
    const all = [...text.matchAll(/\$\s*([\d,]+\.\d{2})/g)].map(m => parseFloat(m[1].replace(/,/g, '')));
    if (all.length) { amount = Math.max(...all); console.log('[OCR] Amount via largest $:', amount); }
  }

  // ── Date ────────────────────────────────────────────────────────────────────
  let date = null;
  const datePatterns = [
    /\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/,
    /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/,
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/i,
  ];
  for (const pat of datePatterns) {
    const m = text.match(pat);
    if (m) {
      try {
        const d = new Date(m[0]);
        if (!isNaN(d.getTime())) {
          date = d.toISOString().slice(0, 10);
          console.log('[OCR] Date matched:', m[0], '->', date);
          break;
        }
      } catch { /* try next */ }
    }
  }

  // ── Vendor ──────────────────────────────────────────────────────────────────
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  // Generic document-type words that are never a vendor name.
  // Match even when followed by noise chars (e.g. "Receipt <", "Invoice #001")
  const genericDocWordRe = /^(receipt|invoice|statement|bill|order|confirmation|payment|purchase|transaction|summary|quote|estimate)s?\b/i;
  let vendor = '';

  // Metadata label prefixes that are never a vendor name
  const metadataRe = /^(date|invoice\s*(number|#|no\.?)|receipt\s*(number|#|no\.?)|bill\s*to|ship\s*to|sold\s*to|order\s*(number|#|no\.?)|paid|payment|amount\s*paid|sub\s*total|total|tax|from|to)\b/i;
  // Spelled-out date pattern (e.g. "March 16, 2026" or "April 14 2026")
  const spelledDateRe = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}/i;

  // Pass 1: first non-noise line in top 8, skipping generic doc words
  for (const line of lines.slice(0, 8)) {
    if (/^\d[\d\s\-(). ]{6,}$/.test(line)) continue;
    if (/^\d+\s+[A-Z]/.test(line)) continue;
    if (/^https?:\/\//.test(line)) continue;
    if (/\$/.test(line)) continue;
    if (/\d{4}[-\/]\d{2}/.test(line)) continue;
    if (line.length < 2) continue;
    if (genericDocWordRe.test(line)) continue;
    if (metadataRe.test(line)) continue;
    if (spelledDateRe.test(line)) continue;
    // Skip lines that are just symbols / OCR noise (no real letters)
    if (!/[a-zA-Z]{2}/.test(line)) continue;
    vendor = line.slice(0, 60);
    break;
  }

  // Pass 2: if still empty (or only got a generic word), scan full text for
  // a line that looks like a registered business name
  if (!vendor) {
    const bizRe = /\b(Inc\.?|LLC\.?|Corp\.?|Ltd\.?|Co\.?|Group|Services|Solutions|Technologies|Networks?|Systems?|Consulting|Associates?|Partners?|Enterprises?)\b/i;
    for (const line of lines) {
      if (line.length < 3 || line.length > 80) continue;
      if (/\$/.test(line)) continue;
      if (/^\d/.test(line)) continue;
      if (bizRe.test(line)) { vendor = line.slice(0, 60); break; }
    }
  }

  console.log('[OCR] Vendor:', vendor);

  // ── Description ─────────────────────────────────────────────────────────────
  const descRe = /(?:order|invoice|receipt|purchase|service|subscription|payment for)[:\s#]*([^\n]{3,80})/i;
  const dm = text.match(descRe);
  const description = dm ? dm[0].trim().slice(0, 80) : vendor;
  console.log('[OCR] Description:', description);

  const result = { amount, date, vendor, description };
  console.log('[OCR] Final parsed result:', result);
  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────
export async function ocrReceiptFile({ data, mimeType, filename }, onProgress) {
  console.log('[OCR] ocrReceiptFile called. mimeType =', mimeType, '| filename =', filename, '| data length =', data?.length);

  if (!data) throw new Error('No file data to scan.');

  let imageDataUrl;

  if (mimeType === 'application/pdf') {
    console.log('[OCR] Handling as PDF');
    onProgress?.({ status: 'Rendering PDF…', pct: 0.05 });
    imageDataUrl = await pdfToImageDataUrl(data);
  } else {
    console.log('[OCR] Handling as image:', mimeType);
    imageDataUrl = `data:${mimeType};base64,${data}`;
  }

  onProgress?.({ status: 'Loading OCR engine…', pct: 0.10 });
  console.log('[OCR] Dynamically importing tesseract.js...');

  let createWorker;
  try {
    ({ createWorker } = await import('tesseract.js'));
    console.log('[OCR] tesseract.js imported successfully');
  } catch (e) {
    console.error('[OCR] Failed to import tesseract.js:', e);
    throw new Error('OCR engine failed to load: ' + (e.message || String(e)));
  }

  console.log('[OCR] Creating Tesseract worker...');
  let worker;
  try {
    worker = await createWorker('eng', 1, {
      logger(m) {
        console.log('[OCR] Tesseract:', m.status, m.progress != null ? Math.round(m.progress * 100) + '%' : '');
        if (m.status === 'loading tesseract core')
          onProgress?.({ status: 'Loading OCR engine…', pct: 0.12 });
        else if (m.status === 'loading language traineddata')
          onProgress?.({ status: 'Downloading language data…', pct: 0.15 + (m.progress || 0) * 0.05 });
        else if (m.status === 'initializing tesseract')
          onProgress?.({ status: 'Initializing…', pct: 0.20 });
        else if (m.status === 'recognizing text')
          onProgress?.({ status: 'Reading text…', pct: 0.22 + (m.progress || 0) * 0.70 });
      },
    });
    console.log('[OCR] Tesseract worker created');
  } catch (e) {
    console.error('[OCR] Tesseract createWorker failed:', e);
    throw new Error('OCR worker init failed: ' + (e.message || String(e)));
  }

  try {
    console.log('[OCR] Running recognition...');
    const { data: { text } } = await worker.recognize(imageDataUrl);
    console.log('[OCR] Recognition complete, text length =', text.length);
    onProgress?.({ status: 'Parsing…', pct: 0.95 });
    const result = parseReceiptText(text);
    onProgress?.({ status: 'Done', pct: 1.0 });
    return result;
  } catch (e) {
    console.error('[OCR] worker.recognize failed:', e);
    throw new Error('OCR recognition failed: ' + (e.message || String(e)));
  } finally {
    await worker.terminate().catch(() => {});
  }
}
