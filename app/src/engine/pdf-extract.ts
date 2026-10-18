// A PDF's text and pages, in the webview. The method's first step wants the
// words of the lecture and one image per slide, and the agent used to get
// them by looking for pdftotext or pypdf on the machine -- a permission
// prompt on the first run from the website, and nothing at all on a laptop
// without them. pdf.js reads the same file here, with nothing installed --
// the desktop app's webview and the browser tab alike -- and the result goes
// beside the material through the sidecar (agent/extract.ts).

export interface TextPiece {
  str: string;
  hasEOL: boolean;
}

/** pdf.js text items to lines: a break where the item says so, runs of space collapsed, nothing trailing. */
export function pageLines(items: readonly TextPiece[]): string {
  let out = '';
  for (const it of items) {
    out += it.str;
    if (it.hasEOL) out += '\n';
  }
  return out
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** `p001` for page 1: zero-padded so a name sort is a page sort. */
export function pageStem(n: number): string {
  return `p${String(n).padStart(3, '0')}`;
}

export interface ExtractSink {
  /** One rendered page, JPEG bytes; called in page order, before `text`. */
  image(page: number, pages: number, jpeg: Uint8Array): Promise<void>;
  /** The whole text, once every page is done: a finished extraction is one with its text. */
  text(markdown: string): Promise<void>;
}

// A 16:9 slide comes out 1400×788. JPEG, not PNG: lecture slides are mostly
// photographs and diagrams, and the first live run wrote 1.1 MB PNGs -- 45 MB
// for one lecture, most of it noise the model would downscale anyway.
const MAX_WIDTH = 1400;
const MAX_SCALE = 2;
const JPEG_QUALITY = 0.85;
// pdf.js parses in a Web Worker, and a worker the browser has killed (memory,
// most often) gives no error: every promise simply never settles. Seen once
// live, as a run that sat at "page 11 of 41" for good. A deadline turns that
// into a message the user can act on.
const LOAD_DEADLINE_MS = 60_000;
const PAGE_DEADLINE_MS = 45_000;

function deadline<T>(what: string, p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish in ${Math.round(ms / 1000)}s — the PDF reader stopped answering; reload the tab and run extract again`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

type PdfPage = Awaited<ReturnType<Awaited<ReturnType<typeof import('pdfjs-dist').getDocument>['promise']>['getPage']>>;

// Not page.getTextContent(): pdf.js 6 drains its text stream with `for await`,
// and the macOS webview (WebKit) has no async iterator on ReadableStream --
// "undefined is not a function (near '...value of readableStream...')" on
// the first extract in the app. A reader works everywhere.
async function textPieces(page: PdfPage): Promise<TextPiece[]> {
  const reader = page.streamTextContent().getReader();
  const pieces: TextPiece[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return pieces;
    for (const it of value.items) if ('str' in it) pieces.push(it as TextPiece);
  }
}

/** Renders every page and collects its text. Runs on the main thread (pdf.js parses in its own worker; the canvas is here). */
export async function extractPdf(name: string, data: Uint8Array, sink: ExtractSink): Promise<{ pages: number }> {
  const pdfjs = await import('pdfjs-dist');
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data });
  const doc = await deadline(`opening ${name}`, task.promise, LOAD_DEADLINE_MS);
  const pages = doc.numPages;
  const parts: string[] = [`# ${name}\n\nExtracted by AnkiEngine: ${pages} page${pages === 1 ? '' : 's'}. One image per page sits beside this file as ${pageStem(1)}.jpg … ${pageStem(pages)}.jpg.\n`];
  const canvas = document.createElement('canvas');
  try {
    for (let n = 1; n <= pages; n += 1) {
      const page = await deadline(`page ${n}`, doc.getPage(n), PAGE_DEADLINE_MS);
      try {
        const pieces = await deadline(`page ${n} text`, textPieces(page), PAGE_DEADLINE_MS);
        parts.push(`\n## Page ${n}\n\n${pageLines(pieces)}\n`);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(MAX_SCALE, MAX_WIDTH / base.width) });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await deadline(`page ${n} image`, page.render({ canvas, viewport }).promise, PAGE_DEADLINE_MS);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`page ${n}: the canvas gave no image`))), 'image/jpeg', JPEG_QUALITY));
        await sink.image(n, pages, new Uint8Array(await blob.arrayBuffer()));
      } finally {
        page.cleanup();
      }
    }
    await sink.text(parts.join(''));
  } finally {
    canvas.width = 0;
    await task.destroy(); // pdf.js 6: the loading task owns the worker-side document
  }
  return { pages };
}

export { toBase64 } from './bytes.ts';
