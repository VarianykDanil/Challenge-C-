/**
 * Release 1.3 — OWNED BY P3 statements. The worker thread that reads a statement PDF's positioned text with pdfjs-dist
 * (legacy build: no fonts loaded, no XFA forms; pdfjs-dist 6 never compiles code from a PDF). It runs apart from the
 * server's main thread, so a PDF that keeps the parser busy never stalls the app: lib/statements/pdf.ts ends the worker
 * when a read takes too long and starts a fresh one for the next PDF.
 *
 * Message in:  { id, data: Uint8Array, maxPages }
 * Message out: { id, ok: true, items, pages } | { id, ok: false, name, message }
 */
import { parentPort } from 'node:worker_threads';
import type { PdfTextItem } from '@lm/shared';

interface PdfjsTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: Promise<Pdfjs> | null = null;
const loadPdfjs = () => (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

async function extract(data: Uint8Array, maxPages: number): Promise<{ items: PdfTextItem[]; pages: number }> {
  const lib = await loadPdfjs();
  const task = lib.getDocument({
    data, // pdfjs takes ownership of the bytes it is given
    enableXfa: false,
    // (no isEvalSupported: pdfjs-dist 6 removed that option with the code path it guarded — it never compiles code
    // from a PDF; neither build file calls eval or new Function on PDF data)
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    stopAtErrors: false,
  });
  try {
    const doc = await task.promise;
    const pages = Math.min(doc.numPages, maxPages);
    const items: PdfTextItem[] = [];
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      for (const raw of content.items as PdfjsTextItem[]) {
        const t = raw.transform;
        if (typeof raw.str !== 'string' || !t || t.length < 6) continue;
        const height = raw.height && raw.height > 0 ? raw.height : Math.hypot(t[2] ?? 0, t[3] ?? 0);
        items.push({ str: raw.str, x: t[4]!, y: t[5]!, width: raw.width ?? 0, height, page: p });
      }
      page.cleanup();
    }
    return { items, pages: doc.numPages };
  } finally {
    void task.destroy().catch(() => {});
  }
}

parentPort?.on('message', (msg: { id: number; data: Uint8Array; maxPages: number }) => {
  extract(msg.data, msg.maxPages).then(
    (out) => parentPort!.postMessage({ id: msg.id, ok: true, ...out }),
    (err: unknown) => {
      const e = (err ?? {}) as { name?: string; message?: string };
      parentPort!.postMessage({ id: msg.id, ok: false, name: e.name ?? 'Error', message: e.message ?? String(err) });
    },
  );
});
