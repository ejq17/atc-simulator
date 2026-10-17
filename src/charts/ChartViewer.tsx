import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { CYCLE, isCycleCurrent, listChartGroups, type ChartEntry } from './chartIndex';
import { ChartLoadError, DEFAULT_PROXY_BASE, destroyDoc, loadChartPdf, type ChartLoadVia } from './pdfLoader';
import { MAX_SCALE, MIN_SCALE, ZOOM_STEP, clampScale, fitScale, formatPercent, renderScaleFor, type FitMode } from './viewMath';

export interface ChartViewerProps {
  /** Chart id (d-TPP file stem, e.g. "00669AD") to open first. Defaults to the airport diagram. */
  initialChartId?: string;
  /** Airport whose charts are listed (default KACY). */
  icao?: string;
  /** Called whenever the selected chart changes (including the first selection). */
  onChartChange?: (chart: ChartEntry) => void;
  /** Backend proxy endpoint. Defaults to `/api/charts/pdf`. */
  proxyBase?: string;
  className?: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; via: ChartLoadVia }
  | { status: 'error'; error: ChartLoadError | Error };

const BTN =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-sm border border-atc-border bg-atc-panel-2 px-2 text-xs text-atc-text ' +
  'hover:border-atc-cyan hover:text-atc-cyan focus-visible:outline focus-visible:outline-1 focus-visible:outline-atc-cyan ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-atc-border disabled:hover:text-atc-text';

function isCancel(err: unknown): boolean {
  return err instanceof Error && (err.name === 'RenderingCancelledException' || err.name === 'AbortError');
}

export function ChartViewer({ icao = 'KACY', initialChartId, onChartChange, proxyBase = DEFAULT_PROXY_BASE, className = '' }: ChartViewerProps) {
  const groups = useMemo(() => listChartGroups(icao), [icao]);
  const charts = useMemo(() => groups.flatMap((g) => g.charts), [groups]);
  const [selectedId, setSelectedId] = useState<string>(() => (charts.find((c) => c.id === initialChartId) ?? charts[0]).id);
  const chart = charts.find((c) => c.id === selectedId) ?? charts[0];

  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [pageSize, setPageSize] = useState({ w: 0, h: 0 });
  const [fit, setFit] = useState<FitMode>('page');
  const [customScale, setCustomScale] = useState(1);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [night, setNight] = useState(false);
  const [rendering, setRendering] = useState(false);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const anchorRef = useRef<{ fx: number; fy: number; px: number; py: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const scale = fit === 'custom' ? customScale : fitScale(fit, pageSize, box);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  useEffect(() => {
    onChartChange?.(chart);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notify on selection only
  }, [chart.id]);

  // ---- load document (destroys the previous one; aborts in-flight fetch) ----
  useEffect(() => {
    const ctrl = new AbortController();
    let loaded: PDFDocumentProxy | null = null;
    setLoad({ status: 'loading' });
    if (canvasRef.current) {
      canvasRef.current.width = 0; // drop the previous chart's bitmap
      canvasRef.current.height = 0;
    }
    setDoc(null);
    setPage(null);
    setNumPages(0);
    setPageNum(1);
    setPageSize({ w: 0, h: 0 });
    loadChartPdf(chart.pdfUrl, ctrl.signal, proxyBase)
      .then(({ doc: d, via }) => {
        if (ctrl.signal.aborted) {
          destroyDoc(d);
          return;
        }
        loaded = d;
        setDoc(d);
        setNumPages(d.numPages);
        setLoad({ status: 'ready', via });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || isCancel(err)) return;
        setLoad({ status: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      });
    return () => {
      ctrl.abort();
      if (loaded) destroyDoc(loaded);
    };
  }, [chart.pdfUrl, proxyBase, reloadKey]);

  // ---- resolve the current page proxy and its base size ----
  useEffect(() => {
    if (!doc) return;
    let stale = false;
    doc
      .getPage(pageNum)
      .then((p) => {
        if (stale) return;
        const vp = p.getViewport({ scale: 1 });
        setPage(p);
        setPageSize({ w: vp.width, h: vp.height });
      })
      .catch((err: unknown) => {
        if (!stale && !isCancel(err)) setLoad({ status: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      });
    return () => {
      stale = true;
    };
  }, [doc, pageNum]);

  // ---- track viewport size ----
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setBox({ w: Math.max(0, el.clientWidth - 32), h: Math.max(0, el.clientHeight - 32) });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- render (debounced, offscreen, cancellable, device-pixel crisp) ----
  useEffect(() => {
    const target = canvasRef.current;
    if (!page || !target || pageSize.w === 0) return;
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    let task: RenderTask | null = null;
    let cancelled = false;
    const timer = setTimeout(() => {
      const rs = renderScaleFor(scale, dpr, pageSize);
      const viewport = page.getViewport({ scale: rs });
      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.floor(viewport.width));
      off.height = Math.max(1, Math.floor(viewport.height));
      setRendering(true);
      try {
        task = page.render({ canvas: off, viewport, background: '#ffffff' });
      } catch (err) {
        setRendering(false);
        setLoad({ status: 'error', error: err instanceof Error ? err : new Error(String(err)) });
        return;
      }
      task.promise
        .then(() => {
          if (cancelled) return;
          target.width = off.width;
          target.height = off.height;
          target.getContext('2d')?.drawImage(off, 0, 0);
          off.width = off.height = 0; // release the backing store promptly
          setRendering(false);
        })
        .catch((err: unknown) => {
          if (cancelled || isCancel(err)) return;
          setRendering(false);
          setLoad({ status: 'error', error: err instanceof Error ? err : new Error(String(err)) });
        });
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
    };
  }, [page, pageSize, scale]);

  // ---- keep the cursor anchored while wheel-zooming ----
  useLayoutEffect(() => {
    const a = anchorRef.current;
    const sc = scrollerRef.current;
    const cv = canvasRef.current;
    if (!a || !sc || !cv) return;
    anchorRef.current = null;
    sc.scrollLeft = cv.offsetLeft + a.fx * cv.offsetWidth - a.px;
    sc.scrollTop = cv.offsetTop + a.fy * cv.offsetHeight - a.py;
  }, [scale]);

  const zoomTo = useCallback((next: number, anchor?: { clientX: number; clientY: number }) => {
    const sc = scrollerRef.current;
    const cv = canvasRef.current;
    if (anchor && sc && cv) {
      const r = cv.getBoundingClientRect();
      const sr = sc.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        anchorRef.current = {
          fx: (anchor.clientX - r.left) / r.width,
          fy: (anchor.clientY - r.top) / r.height,
          px: anchor.clientX - sr.left,
          py: anchor.clientY - sr.top,
        };
      }
    }
    setFit('custom');
    setCustomScale(clampScale(next));
  }, []);

  // wheel zoom needs a non-passive native listener to preventDefault
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomTo(scaleRef.current * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  // ---- drag to pan ----
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !scrollerRef.current) return;
    drag.current = { x: e.clientX, y: e.clientY, left: scrollerRef.current.scrollLeft, top: scrollerRef.current.scrollTop };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const sc = scrollerRef.current;
    if (!d || !sc) return;
    sc.scrollLeft = d.left - (e.clientX - d.x);
    sc.scrollTop = d.top - (e.clientY - d.y);
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const goPage = (n: number) => setPageNum(Math.min(Math.max(1, n), Math.max(1, numPages)));

  const onViewerKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case '+':
      case '=':
        zoomTo(scale * ZOOM_STEP);
        break;
      case '-':
      case '_':
        zoomTo(scale / ZOOM_STEP);
        break;
      case '0':
      case 'p':
        setFit('page');
        break;
      case 'w':
        setFit('width');
        break;
      case 'PageDown':
      case ']':
        goPage(pageNum + 1);
        break;
      case 'PageUp':
      case '[':
        goPage(pageNum - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const select = (id: string) => setSelectedId(id);
  const onListKey = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const i = charts.findIndex((c) => c.id === selectedId);
    let n = i;
    if (e.key === 'ArrowDown') n = Math.min(charts.length - 1, i + 1);
    else if (e.key === 'ArrowUp') n = Math.max(0, i - 1);
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = charts.length - 1;
    else return;
    e.preventDefault();
    if (n !== i) select(charts[n].id);
  };

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);

  const cssW = pageSize.w * scale;
  const cssH = pageSize.h * scale;
  const cycleCurrent = isCycleCurrent();

  return (
    <section
      aria-label="FAA chart viewer"
      className={`flex h-full min-h-0 w-full overflow-hidden border border-atc-border bg-atc-bg text-atc-text ${className}`}
    >
      {/* ---------------- chart list ---------------- */}
      <nav aria-label={`${icao} charts`} className="flex w-64 shrink-0 flex-col border-r border-atc-border bg-atc-panel">
        <div className="border-b border-atc-border px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.2em] text-atc-muted">{icao} charts</div>
          <div className="mt-0.5 text-[11px] text-atc-cyan">d-TPP {CYCLE.cycle} - {charts.length} charts</div>
        </div>
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Charts"
          aria-activedescendant={`${listId}-${selectedId}`}
          tabIndex={0}
          onKeyDown={onListKey}
          className="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-atc-cyan"
        >
          {groups.map((g) => (
            <li key={g.id} role="presentation">
              <div className="sticky top-0 z-10 border-y border-atc-border bg-atc-panel-2 px-3 py-1 text-[10px] uppercase tracking-[0.15em] text-atc-muted">
                {g.label}
              </div>
              <ul role="group" aria-label={g.label}>
                {g.charts.map((c) => {
                  const active = c.id === selectedId;
                  return (
                    <li
                      key={c.id}
                      id={`${listId}-${c.id}`}
                      role="option"
                      aria-selected={active}
                      onClick={() => select(c.id)}
                      className={`cursor-pointer border-l-2 px-3 py-1.5 text-xs leading-snug ${
                        active
                          ? 'border-atc-green bg-atc-panel-2 text-atc-green'
                          : 'border-transparent text-atc-text hover:bg-atc-panel-2'
                      }`}
                    >
                      {c.name}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
        <div className="border-t border-atc-border px-3 py-1.5 text-[10px] leading-snug text-atc-muted">
          Up/Down to change chart. Reference only - not for navigation.
        </div>
      </nav>

      {/* ---------------- viewer ---------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-atc-border bg-atc-panel px-4 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold tracking-wide text-atc-text" data-testid="chart-title">
                {chart.name}
              </h2>
              <span className="shrink-0 rounded-sm border border-atc-green-dim px-1.5 text-[10px] uppercase tracking-wider text-atc-green">
                Official FAA
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-atc-muted" data-testid="chart-cycle">
              {CYCLE.label}
            </p>
            {chart.note && <p className="mt-0.5 text-[11px] text-atc-amber">{chart.note}</p>}
            {!cycleCurrent && (
              <p className="mt-0.5 text-[11px] text-atc-amber" role="status">
                This cycle's effective period has ended; a newer FAA d-TPP cycle is in force.
              </p>
            )}
          </div>
          <a
            href={chart.pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-xs text-atc-cyan underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-atc-cyan"
          >
            Open official PDF ({chart.pdfName}) {'↗'}
          </a>
        </header>

        <div
          role="toolbar"
          aria-label="Chart controls"
          className="flex flex-wrap items-center gap-2 border-b border-atc-border bg-atc-panel-2 px-3 py-1.5"
        >
          <button type="button" className={BTN} aria-label="Zoom out" title="Zoom out (-)" disabled={scale <= MIN_SCALE + 1e-6} onClick={() => zoomTo(scale / ZOOM_STEP)}>
            {'−'}
          </button>
          <span className="w-12 text-center text-xs tabular-nums text-atc-cyan" aria-label="Zoom level" data-testid="zoom-level">
            {formatPercent(scale)}
          </span>
          <button type="button" className={BTN} aria-label="Zoom in" title="Zoom in (+)" disabled={scale >= MAX_SCALE - 1e-6} onClick={() => zoomTo(scale * ZOOM_STEP)}>
            +
          </button>
          <span className="mx-1 h-4 w-px bg-atc-border" />
          <button type="button" className={`${BTN} ${fit === 'width' ? 'border-atc-cyan text-atc-cyan' : ''}`} aria-pressed={fit === 'width'} title="Fit to width (w)" onClick={() => setFit('width')}>
            Fit width
          </button>
          <button type="button" className={`${BTN} ${fit === 'page' ? 'border-atc-cyan text-atc-cyan' : ''}`} aria-pressed={fit === 'page'} title="Fit whole page (0)" onClick={() => setFit('page')}>
            Fit page
          </button>
          <button type="button" className={`${BTN} ${night ? 'border-atc-amber text-atc-amber' : ''}`} aria-pressed={night} title="Invert the chart for low-light viewing (display filter only)" onClick={() => setNight((v) => !v)}>
            Night
          </button>
          <span className="mx-1 h-4 w-px bg-atc-border" />
          <button type="button" className={BTN} aria-label="Previous page" title="Previous page ([)" disabled={pageNum <= 1} onClick={() => goPage(pageNum - 1)}>
            {'‹'}
          </button>
          <span className="text-xs tabular-nums text-atc-text" aria-live="polite" data-testid="page-indicator">
            {numPages > 0 ? `Page ${pageNum} / ${numPages}` : 'Page -'}
          </span>
          <button type="button" className={BTN} aria-label="Next page" title="Next page (])" disabled={pageNum >= numPages} onClick={() => goPage(pageNum + 1)}>
            {'›'}
          </button>
          <span className="ml-auto hidden text-[10px] text-atc-muted lg:inline">Wheel = zoom, drag = pan</span>
        </div>

        <div className="relative min-h-0 flex-1 bg-[#07090b]">
          <div
            ref={scrollerRef}
            tabIndex={0}
            role="region"
            aria-label={`${chart.name} chart`}
            onKeyDown={onViewerKey}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className={`absolute inset-0 flex overflow-auto p-4 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-atc-cyan ${
              dragging ? 'cursor-grabbing' : 'cursor-grab'
            } select-none`}
            style={{ touchAction: 'none' }}
          >
            <canvas
              ref={canvasRef}
              data-testid="chart-canvas"
              className="m-auto block shrink-0 bg-white shadow-[0_0_0_1px_var(--color-atc-border)]"
              style={{
                width: cssW || undefined,
                height: cssH || undefined,
                visibility: load.status === 'ready' ? 'visible' : 'hidden',
                filter: night ? 'invert(0.92) hue-rotate(180deg)' : undefined,
              }}
            />
          </div>

          {load.status === 'loading' && (
            <div role="status" aria-live="polite" className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="rounded-sm border border-atc-border bg-atc-panel px-4 py-3 text-xs text-atc-cyan">
                <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-atc-cyan" />
                Loading {chart.name} from the FAA...
              </div>
            </div>
          )}
          {load.status === 'ready' && rendering && (
            <div className="pointer-events-none absolute right-3 top-3 rounded-sm border border-atc-border bg-atc-panel/90 px-2 py-0.5 text-[10px] text-atc-muted">Rendering...</div>
          )}
          {load.status === 'ready' && (
            <div className="pointer-events-none absolute bottom-2 right-3 text-[10px] text-atc-muted">
              {load.via === 'proxy' ? 'via local proxy' : 'direct from aeronav.faa.gov'}
            </div>
          )}
          {load.status === 'error' && (
            <ErrorPanel error={load.error} chart={chart} onRetry={() => setReloadKey((k) => k + 1)} />
          )}
        </div>
      </div>
    </section>
  );
}

function ErrorPanel({ error, chart, onRetry }: { error: ChartLoadError | Error; chart: ChartEntry; onRetry: () => void }) {
  const loadErr = error instanceof ChartLoadError ? error : null;
  return (
    <div role="alert" className="absolute inset-0 flex items-center justify-center p-6">
      <div className="max-w-xl border border-atc-red/60 bg-atc-panel p-5 text-xs leading-relaxed">
        <h3 className="text-sm font-semibold text-atc-red">Chart could not be loaded</h3>
        <p className="mt-2 text-atc-text">{error.message}</p>
        {loadErr?.backendDown && (
          <p className="mt-2 text-atc-text">
            The viewer reads FAA charts through the simulator's local backend, because aeronav.faa.gov does not allow browser pages to
            download its PDFs directly (no CORS header). Start the backend with <code className="text-atc-cyan">npm run server</code> (port 8787)
            and retry.
          </p>
        )}
        {loadErr && (
          <dl className="mt-3 space-y-1 border-t border-atc-border pt-2 text-[11px] text-atc-muted">
            <div>
              <dt className="inline">Backend proxy: </dt>
              <dd className="inline">{loadErr.proxyDetail || 'ok'}</dd>
            </div>
            <div>
              <dt className="inline">Direct from FAA: </dt>
              <dd className="inline">{loadErr.directDetail}</dd>
            </div>
          </dl>
        )}
        <div className="mt-4 flex items-center gap-3">
          <button type="button" className={BTN} onClick={onRetry}>
            Retry
          </button>
          <a href={chart.pdfUrl} target="_blank" rel="noopener noreferrer" className="text-atc-cyan hover:underline">
            Open the official PDF in a new tab {'↗'}
          </a>
        </div>
      </div>
    </div>
  );
}

export default ChartViewer;
