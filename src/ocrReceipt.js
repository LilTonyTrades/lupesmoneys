/**
 * ocrReceipt.js
 * Local receipt OCR using pdfjs-dist (PDF → canvas) + tesseract.js (image → text).
 * No external API calls — everything runs on-device.
 */

import * as pdfjsLib from 'pdfjs-dist';

// Point PDF.js at its bundled worker (Vite resolves this correctly in both dev and prod)
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href;

// ─── PDF → canvas data URL ────────────────────────────────────────────────────
async function pdfToImageDataUrl(base64data) {
  const binary = atob(base64data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const page = await pdf.getPage(1);
  // Scale 2.5× so small text is readable by Tesseract
  const viewport = page.getViewport({ scale: 2.5 });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas.toDataURL('image/png');
}

// ─── Text → structured fields ─────────────────────────────────────────────────
function parseReceiptText(text) {
  // ── Amount ──────────────────────────────────────────────────────────────────
  let amount = null;

  // Prefer lines explicitly labelled as a total
  const labelRe = /(?:total|amount\s+(?:due|paid|charged)|grand\s+total|balance\s+due|subtotal)[^$\d\n]*\$?\s*([\d,]+\.?\d{0,2})/gi;
  const labelMatches = [...text.matchAll(labelRe)];
  if (labelMatches.length) {
    // Last match is usually "Grand Total" (comes after line-item subtotals)
    amount = parseFloat(labelMatches[labelMatches.length - 1][1].replace(/,/g, ''));
  }

  // Fallback: largest dollar figure on the page
  if (!amount) {
    const all = [...text.matchAll(/\$\s*([\d,]+\.\d{2})/g)]
      .map(m => parseFloat(m[1].replace(/,/g, '')));
    if (all.length) amount = Math.max(...all);
  }

  // ── Date ────────────────────────────────────────────────────────────────────
  let date = null;
  const datePatterns = [
    /\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/,                       // 2024-01-15
    /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/,                     // 01/15/2024
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/i,
  ];
  for (const pat of datePatterns) {
    const m = text.match(pat);
    if (m) {
      try {
        const d = new Date(m[0]);
        if (!isNaN(d.getTime())) { date = d.toISOString().slice(0, 10); break; }
      } catch { /* try next pattern */ }
    }
  }

  // ── Vendor ──────────────────────────────────────────────────────────────────
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let vendor = '';
  for (const line of lines.slice(0, 6)) {
    if (/^\d[\d\s\-(). ]{6,}$/.test(line)) continue;  // phone number
    if (/^\d+\s+[A-Z]/.test(line)) continue;           // street address
    if (/^https?:\/\//.test(line)) continue;            // URL
    if (/\$/.test(line)) continue;                      // price line
    if (/\d{4}[-\/]\d{2}/.test(line)) continue;        // date
    if (line.length < 2) continue;
    vendor = line.slice(0, 60);
    break;
  }

  // ── Description ─────────────────────────────────────────────────────────────
  const descRe = /(?:order|invoice|receipt|purchase|service|subscription|payment for)[:\s#]*([^\n]{3,80})/i;
  const dm = text.match(descRe);
  const description = dm ? dm[0].trim().slice(0, 80) : vendor;

  return { amount, date, vendor, description };
}

// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * Run OCR on a stored receipt file ({ data: base64, mimeType, filename }).
 * onProgress(({ status: string, pct: 0–1 })) is called throughout.
 * Returns { amount, date, vendor, description } — any field may be null.
 */
export async function ocrReceiptFile({ data, mimeType }, onProgress) {
  let imageDataUrl;

  if (mimeType === 'application/pdf') {
    onProgress?.({ status: 'Rendering PDF…', pct: 0.05 });
    imageDataUrl = await pdfToImageDataUrl(data);
  } else {
    // image/jpeg, image/png, etc. — use directly
    imageDataUrl = `data:${mimeType};base64,${data}`;
  }

  onProgress?.({ status: 'Loading OCR engine…', pct: 0.10 });

  // Dynamic import so tesseract.js only loads when the user actually scans
  const { createWorker } = await import('tesseract.js');

  const worker = await createWorker('eng', 1, {
    logger(m) {
      if (m.status === 'loading tesseract core')
        onProgress?.({ status: 'Loading OCR engine…', pct: 0.12 });
      else if (m.status === 'loading language traineddata')
        onProgress?.({ status: 'Downloading language data…', pct: 0.15 + (m.progress || 0) * 0.05 });
      else if (m.status === 'initializing tesseract')
        onProgress?.({ status: 'Initializing…', pct: 0.20 });
      else if (m.status === 'recognizing text')
        onProgress?.({ status: 'Reading text…', pct: 0.22 + m.progress * 0.70 });
    },
  });

  try {
    const { data: { text } } = await worker.recognize(imageDataUrl);
    onProgress?.({ status: 'Parsing…', pct: 0.95 });
    const result = parseReceiptText(text);
    onProgress?.({ status: 'Done', pct: 1.0 });
    return result;
  } finally {
    await worker.terminate();
  }
}
