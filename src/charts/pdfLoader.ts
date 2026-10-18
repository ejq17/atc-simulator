/**
 * Loads an FAA chart PDF into pdf.js.
 *
 * Order: (1) a same-origin file bundled at build time, `${BASE_URL}charts/<ICAO>/<file>.pdf`
 * (`scripts/fetch-charts.ts` downloads them; FAA d-TPP charts are US government public domain);
 * (2) the local backend proxy `/api/charts/pdf?url=...` (skipped on the static build, which has no backend);
 * (3) a direct fetch of the official aeronav.faa.gov URL.
 *
 * CORS finding (curl, 2026-10-16): aeronav.faa.gov answers GET/HEAD/OPTIONS with
 * HTTP 200 but sends NO Access-Control-Allow-Origin header, so (3) is blocked by
 * the browser unless the page runs somewhere CORS is not enforced. It is kept
 * as a last resort because it costs nothing.
 *
 * pdf.js is imported lazily so it stays out of the main bundle until a chart is
 * opened.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { baseUrl, isStaticHosting } from '../hosting';

export const DEFAULT_PROXY_BASE = '/api/charts/pdf';

export type ChartLoadVia = 'bundled' | 'proxy' | 'direct';

/** Same-origin URL of a chart PDF downloaded at build time (honours the Vite base path, e.g. /atc-simulator/). */
export function bundledChartUrl(icao: string, pdfName: string): string {
  return `${baseUrl()}charts/${encodeURIComponent(icao.toUpperCase())}/${encodeURIComponent(pdfName)}`;
}

export interface LoadedChart {
  doc: PDFDocumentProxy;
  via: ChartLoadVia;
}

export class ChartLoadError extends Error {
  /** True when the proxy looks absent/down (network error, 5xx without a JSON body, or no such route). */
  readonly backendDown: boolean;
  readonly proxyDetail: string;
  readonly directDetail: string;
  readonly bundledDetail: string;
  /** True on the static (GitHub Pages) build, where there is no backend to start. */
  readonly staticHosting: boolean;
  constructor(message: string, backendDown: boolean, proxyDetail: string, directDetail: string, bundledDetail = 'not attempted', staticHosting = false) {
    super(message);
    this.name = 'ChartLoadError';
    this.backendDown = backendDown;
    this.proxyDetail = proxyDetail;
    this.directDetail = directDetail;
    this.bundledDetail = bundledDetail;
    this.staticHosting = staticHosting;
  }
}

/** Release a document's worker-side memory (destroying the loading task destroys the document). */
export function destroyDoc(doc: PDFDocumentProxy): void {
  try {
    void Promise.resolve(doc.loadingTask.destroy()).catch(() => undefined);
  } catch {
    /* already destroyed */
  }
}

type PdfJs = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfJs> | null = null;

export function getPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= (async () => {
    const [lib, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  })().catch((err: unknown) => {
    pdfjsPromise = null;
    throw err;
  });
  return pdfjsPromise;
}

export function proxyUrlFor(pdfUrl: string, proxyBase: string = DEFAULT_PROXY_BASE): string {
  return `${proxyBase}?url=${encodeURIComponent(pdfUrl)}`;
}

const isAbort = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError';

async function fetchPdfBytes(
  url: string,
  signal: AbortSignal,
): Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false; down: boolean; detail: string }> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (isAbort(err)) throw err;
    return { ok: false, down: true, detail: err instanceof Error ? err.message : 'network error' };
  }
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    let code = '';
    let msg = `HTTP ${res.status}`;
    if (type.includes('json')) {
      try {
        const j = (await res.json()) as { error?: { code?: string; message?: string } };
        code = j.error?.code ?? '';
        if (j.error?.message) msg = j.error.message;
      } catch {
        /* ignore */
      }
    }
    // 404 NOT_FOUND from the backend router = handler not mounted; 5xx with no JSON error = Vite proxy could not reach the backend.
    const down = code === 'NOT_FOUND' || (res.status >= 500 && !code) || (res.status === 404 && !code);
    return { ok: false, down, detail: code ? `${code}: ${msg}` : msg };
  }
  const bytes = await res.arrayBuffer();
  const head = new Uint8Array(bytes.slice(0, 5));
  const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
  if (!isPdf) {
    // e.g. the dev server returned index.html because /api is not proxied
    return { ok: false, down: true, detail: `response was not a PDF (content-type "${type || 'unknown'}")` };
  }
  return { ok: true, bytes };
}

export async function loadChartPdf(
  pdfUrl: string,
  signal: AbortSignal,
  proxyBase: string = DEFAULT_PROXY_BASE,
  /** Same-origin bundled copy (see bundledChartUrl); omit to skip that step. */
  bundledUrl?: string,
): Promise<LoadedChart> {
  const lib = await getPdfJs();
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');

  const staticHosting = isStaticHosting();
  let bytes: ArrayBuffer | null = null;
  let via: ChartLoadVia = 'bundled';
  let bundledDetail = 'not attempted';
  let proxyDetail = staticHosting ? 'no backend on this hosting' : 'not attempted';
  let directDetail = 'not attempted';
  let backendDown = false;

  if (bundledUrl) {
    const bundled = await fetchPdfBytes(bundledUrl, signal);
    if (bundled.ok) bytes = bundled.bytes;
    else bundledDetail = bundled.detail;
  }
  if (!bytes && !staticHosting) {
    const viaProxy = await fetchPdfBytes(proxyUrlFor(pdfUrl, proxyBase), signal);
    if (viaProxy.ok) {
      bytes = viaProxy.bytes;
      via = 'proxy';
    } else {
      proxyDetail = viaProxy.detail;
      backendDown = viaProxy.down;
    }
  }
  if (!bytes) {
    const direct = await fetchPdfBytes(pdfUrl, signal);
    if (direct.ok) {
      bytes = direct.bytes;
      via = 'direct';
    } else {
      directDetail = direct.detail;
    }
  }

  if (!bytes) {
    throw new ChartLoadError(
      staticHosting
        ? 'This chart is not bundled with this build, and the browser cannot fetch the FAA PDF directly.'
        : backendDown
          ? 'The chart proxy is not responding, and the browser cannot fetch the FAA PDF directly.'
          : `The chart could not be downloaded: ${proxyDetail}`,
      backendDown,
      proxyDetail,
      directDetail,
      bundledDetail,
      staticHosting,
    );
  }

  const task = lib.getDocument({ data: new Uint8Array(bytes) });
  const onAbort = () => void task.destroy();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const doc = await task.promise;
    if (signal.aborted) {
      destroyDoc(doc);
      throw new DOMException('aborted', 'AbortError');
    }
    return { doc, via };
  } catch (err) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    throw new ChartLoadError(
      `The downloaded file could not be opened as a PDF (${err instanceof Error ? err.message : 'unknown error'}).`,
      false,
      proxyDetail,
      directDetail,
      bundledDetail,
      staticHosting,
    );
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
