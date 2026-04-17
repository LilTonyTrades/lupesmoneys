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

  // Pass 1: "Amount paid" is the most authoritative — prefer it over generic totals
  const amtPaidRe = /amount\s+paid[^$\d\n]*\$?\s*([\d,]+\.?\d{0,2})/i;
  const amtPaidMatch = text.match(amtPaidRe);
  if (amtPaidMatch) {
    amount = parseFloat(amtPaidMatch[1].replace(/,/g, ''));
    console.log('[OCR] Amount via "Amount paid":', amount);
  }

  // Pass 2: Bold/large total labels
  if (!amount) {
    const labelRe = /(?:total|amount\s+(?:due|charged)|grand\s+total|balance\s+due)[^$\d\n]*\$?\s*([\d,]+\.?\d{0,2})/gi;
    const labelMatches = [...text.matchAll(labelRe)].filter(m => parseFloat(m[1].replace(/,/g, '')) > 0);
    if (labelMatches.length) {
      amount = parseFloat(labelMatches[labelMatches.length - 1][1].replace(/,/g, ''));
      console.log('[OCR] Amount via label match:', amount);
    }
  }

  // Pass 3: Largest positive dollar amount on the page
  if (!amount) {
    const all = [...text.matchAll(/\$\s*([\d,]+\.\d{2})/g)].map(m => parseFloat(m[1].replace(/,/g, ''))).filter(n => n > 0);
    if (all.length) { amount = Math.max(...all); console.log('[OCR] Amount via largest $:', amount); }
  }

  // ── Date ────────────────────────────────────────────────────────────────────
  let date = null;
  const datePatterns = [
    /\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/,
    /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/,
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/i,
  ];
  const curYear = new Date().getFullYear();
  for (const pat of datePatterns) {
    const m = text.match(pat);
    if (m) {
      try {
        const d = new Date(m[0]);
        if (!isNaN(d.getTime())) {
          // Fix 2-digit year ambiguity: "4/17/26" can parse as 1926 in V8.
          // If the parsed year looks like a misread 2-digit year (e.g. < 2000
          // but the 2-digit suffix would map to a plausible recent year), shift it.
          const y = d.getFullYear();
          if (y < 2000) {
            const twoDigit = y % 100;
            const candidate = 2000 + twoDigit;
            // Accept if the candidate year is within 5 years of today; reject otherwise.
            if (Math.abs(candidate - curYear) <= 5) {
              d.setFullYear(candidate);
            } else {
              console.log('[OCR] Date rejected (implausible year):', m[0], '->', y);
              continue; // try next pattern
            }
          }
          // Final range check: reject dates more than 10 years old or in the future.
          const parsed = d.getFullYear();
          if (parsed < curYear - 10 || parsed > curYear + 1) {
            console.log('[OCR] Date rejected (out of range):', m[0], '->', parsed);
            continue;
          }
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
    // Strip trailing metadata that got OCR'd onto the same line (e.g. "OpenRouter, Inc Bill to")
    let cleaned = line.slice(0, 60);
    cleaned = cleaned.replace(/\s+(bill\s*to|ship\s*to|sold\s*to|pay\s*to|remit\s*to|invoice\s*(number|#|no)|receipt\s*(number|#|no)|date|paid|total|amount).*$/i, '').trim();
    if (cleaned.length >= 2) { vendor = cleaned; break; }
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
  let description = '';

  // Pass 1: Explicit invoice/order/receipt number — most reliable across vendors
  // e.g. "Invoice number UUJTYH6R-0001", "Order #12345"
  const invNumRe = /(?:invoice|order|receipt)\s+(?:number|#|no\.?)\s*[:\s]*([A-Z0-9][A-Z0-9\-]{3,})/i;
  const invMatch = text.match(invNumRe);
  if (invMatch) {
    // Reconstruct clean label rather than including OCR noise around it
    const keyword = invMatch[0].match(/^(invoice|order|receipt)/i)?.[0] || 'Invoice';
    description = `${keyword.charAt(0).toUpperCase() + keyword.slice(1).toLowerCase()} number ${invMatch[1].trim()}`;
  }

  // Pass 2: Product / service name — short line near the line-item table
  // e.g. "Claude Pro", "Max plan - 5x", "OpenRouter Credits"
  if (!description) {
    const productRe = /^([A-Za-z][A-Za-z0-9 \-–&+]{3,60})\s*$/m;
    // Scan lines that look like product names (no $, no digits-only, reasonable length)
    for (const line of lines) {
      if (line.length < 4 || line.length > 70) continue;
      if (/\$|^\d+$|@/.test(line)) continue;
      if (genericDocWordRe.test(line)) continue;
      if (metadataRe.test(line)) continue;
      if (spelledDateRe.test(line)) continue;
      if (/^(qty|unit\s*price|tax|amount|description|subtotal|total|payment)/i.test(line)) continue;
      // Must look like a product/service — contain at least one letter word
      if (productRe.test(line) && /[a-z]{3}/i.test(line)) {
        description = line.trim().slice(0, 80);
        break;
      }
    }
  }

  // Pass 3: Generic keyword fallback — but reject if the captured content is just
  // OCR logo noise (≤4 chars or mostly non-alpha after stripping the keyword)
  if (!description) {
    const descRe = /(?:order|invoice|receipt|purchase|service|subscription|payment\s+for)[:\s#]*([^\n]{3,80})/i;
    const dm = text.match(descRe);
    if (dm && dm[1]) {
      const afterKeyword = dm[1].trim();
      const alphaRatio = (afterKeyword.match(/[a-zA-Z]/g) || []).length / afterKeyword.length;
      // Only use if it has real words (not logo noise like "A\" or "<")
      if (afterKeyword.length >= 5 && alphaRatio > 0.4) {
        description = dm[0].trim().slice(0, 80);
      }
    }
  }

  if (!description) description = vendor;
  console.log('[OCR] Description:', description);

  const result = { amount, date, vendor, description };
  console.log('[OCR] Final parsed result:', result);
  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────
// Returns a Promise with a `.cancel()` method that aborts the OCR worker if
// called before completion. The promise rejects with an Error('OCR cancelled')
// when cancel() runs while recognition is in flight.
export function ocrReceiptFile({ data, mimeType, filename }, onProgress) {
  console.log('[OCR] ocrReceiptFile called. mimeType =', mimeType, '| filename =', filename, '| data length =', data?.length);

  let workerRef = null;
  let cancelled = false;
  let rejectFn = null;

  const promise = (async () => {
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
    if (cancelled) throw new Error('OCR cancelled');

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
    if (cancelled) throw new Error('OCR cancelled');

    console.log('[OCR] Creating Tesseract worker...');
    // Resolve bundled asset paths. In dev these come from Vite's public/ at
    // /tesseract/, in packaged Electron they're served from the same path
    // (Vite copies public/ → dist/, electron loads via file:// protocol).
    const assetBase = new URL('./tesseract/', document.baseURI).href;
    try {
      workerRef = await createWorker('eng', 1, {
        workerPath: assetBase + 'worker.min.js',
        corePath: assetBase,
        langPath: assetBase,
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
    if (cancelled) {
      try { await workerRef.terminate(); } catch (_) {}
      throw new Error('OCR cancelled');
    }

    try {
      console.log('[OCR] Running recognition...');
      const { data: { text } } = await workerRef.recognize(imageDataUrl);
      console.log('[OCR] Recognition complete, text length =', text.length);
      if (cancelled) throw new Error('OCR cancelled');
      onProgress?.({ status: 'Parsing…', pct: 0.95 });
      const result = parseReceiptText(text);
      onProgress?.({ status: 'Done', pct: 1.0 });
      return result;
    } catch (e) {
      console.error('[OCR] worker.recognize failed:', e);
      if (cancelled) throw new Error('OCR cancelled');
      throw new Error('OCR recognition failed: ' + (e.message || String(e)));
    } finally {
      try { await workerRef?.terminate(); } catch (_) {}
      workerRef = null;
    }
  })();

  // Attach cancel() to the returned promise. Calling cancel() terminates the
  // worker (which causes the in-flight recognize() to reject) and ensures the
  // returned promise rejects with 'OCR cancelled' even if the worker is still
  // initialising and hasn't been assigned yet.
  promise.cancel = () => {
    if (cancelled) return;
    cancelled = true;
    console.log('[OCR] cancel() invoked — terminating worker');
    if (workerRef) {
      try { workerRef.terminate(); } catch (_) {}
      workerRef = null;
    }
  };

  return promise;
}
