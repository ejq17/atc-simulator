/**
 * Browser pop-out windows that share the main window's JS context. Nothing here knows about React or the layout:
 * it opens the window, mirrors the stylesheets, and reports when it goes away.
 */

export interface PopupGeometry { x: number; y: number; w: number; h: number }

export const POPUP_BG = '#0b0e11';

/** Copy every <style> and <link rel=stylesheet> of `from` into `to.head`, and keep them in sync (Vite HMR, Tailwind's injected styles). */
export function mirrorStyles(from: Document, to: Document): () => void {
  const clones = new Map<Node, Element>();
  const wanted = () => Array.from(from.querySelectorAll('style, link[rel~="stylesheet"]'));

  const clone = (src: Element): Element => {
    const el = to.createElement(src.tagName.toLowerCase());
    for (const a of Array.from(src.attributes)) el.setAttribute(a.name, a.value);
    if (src instanceof HTMLLinkElement) el.setAttribute('href', src.href); // absolute: the popup starts on about:blank
    else el.textContent = src.textContent;
    return el;
  };

  const sync = () => {
    const live = new Set<Node>();
    for (const src of wanted()) {
      live.add(src);
      const have = clones.get(src);
      if (!have) {
        const c = clone(src);
        clones.set(src, c);
        to.head.appendChild(c);
      } else if (!(src instanceof HTMLLinkElement) && have.textContent !== src.textContent) {
        have.textContent = src.textContent;
      }
    }
    for (const [src, c] of clones) {
      if (!live.has(src)) {
        c.remove();
        clones.delete(src);
      }
    }
  };
  sync();
  const MO = (from.defaultView as (Window & typeof globalThis) | null)?.MutationObserver ?? MutationObserver;
  const mo = new MO(sync);
  mo.observe(from.head, { childList: true, subtree: true, characterData: true, attributes: true });
  return () => mo.disconnect();
}

/** Prepare the empty document `window.open('')` returns: charset, viewport, title, dark background, a full-height #root. */
export function prepareDocument(win: Window, title: string): HTMLElement {
  const doc = win.document;
  doc.head.replaceChildren();
  doc.body.replaceChildren();
  doc.title = title;
  doc.documentElement.lang = 'en';
  doc.documentElement.style.cssText = `height:100%;background:${POPUP_BG};color-scheme:dark`;
  doc.body.style.cssText = `height:100%;margin:0;background:${POPUP_BG};overflow:hidden`;
  const meta = (attrs: Record<string, string>) => {
    const m = doc.createElement('meta');
    for (const [k, v] of Object.entries(attrs)) m.setAttribute(k, v);
    doc.head.appendChild(m);
  };
  meta({ charset: 'UTF-8' });
  meta({ name: 'viewport', content: 'width=device-width, initial-scale=1.0' });
  const base = doc.createElement('base');
  base.href = window.document.baseURI;
  doc.head.appendChild(base);
  const root = doc.createElement('div');
  root.id = 'root';
  root.dataset.popout = 'true';
  root.style.cssText = 'height:100%;width:100%';
  doc.body.appendChild(root);
  return root;
}

export interface PopupHandle {
  win: Window;
  root: HTMLElement;
  /** Current position and size of the window on the screen. */
  geometry(): PopupGeometry;
  close(): void;
  stopStyles(): void;
}

export interface OpenPopupOptions {
  name: string;
  title: string;
  geometry: PopupGeometry;
  /** Called once when the window is closed by the user, by `close()`, or when it navigates away. */
  onClosed(): void;
}

export function popupFeatures(g: PopupGeometry): string {
  return `popup,width=${Math.round(g.w)},height=${Math.round(g.h)},left=${Math.round(g.x)},top=${Math.round(g.y)}`;
}

/** Open a pop-out. Returns null when the browser's popup blocker refused (call this from a click handler). */
export function openPopup(opts: OpenPopupOptions): PopupHandle | null {
  let win: Window | null = null;
  try {
    win = window.open('', opts.name, popupFeatures(opts.geometry));
  } catch {
    win = null;
  }
  if (!win || win.closed) return null;
  const root = prepareDocument(win, opts.title);
  const stopStyles = mirrorStyles(document, win.document);

  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    stopStyles();
    clearInterval(poll);
    opts.onClosed();
  };
  const w = win;
  w.addEventListener('beforeunload', finish);
  w.addEventListener('unload', finish);
  w.addEventListener('pagehide', finish);
  const poll = setInterval(() => { if (w.closed) finish(); }, 500); // Safari does not always fire the events above

  return {
    win: w,
    root,
    stopStyles,
    geometry: () => ({ x: w.screenX, y: w.screenY, w: w.outerWidth, h: w.outerHeight }),
    close() {
      const wasClosed = closed;
      finish();
      if (!wasClosed || !w.closed) {
        try { w.close(); } catch { /* already gone */ }
      }
    },
  };
}
