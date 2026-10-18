/**
 * Registry of every browser window that shows part of the simulator: the main window plus any pop-out windows.
 * Components that need page-level listeners (keyboard shortcuts, Esc to close a drawer, key capture in Settings) use
 * `onEachWindow` so the same handler also runs while a popup has focus.
 */

type Cleanup = void | (() => void);
type Attach = (win: Window) => Cleanup;

const windows = new Set<Window>();
const watchers = new Set<{ attach: Attach; cleanups: Map<Window, () => void> }>();

function run(w: { attach: Attach; cleanups: Map<Window, () => void> }, win: Window) {
  const c = w.attach(win);
  if (typeof c === 'function') w.cleanups.set(win, c);
}

/** Register a window (idempotent). Returns the function that removes it again. */
export function registerWindow(win: Window): () => void {
  if (!windows.has(win)) {
    windows.add(win);
    for (const w of watchers) run(w, win);
  }
  return () => unregisterWindow(win);
}

export function unregisterWindow(win: Window) {
  if (!windows.delete(win)) return;
  for (const w of watchers) {
    w.cleanups.get(win)?.();
    w.cleanups.delete(win);
  }
}

export function listWindows(): Window[] {
  return [...windows];
}

/** Run `attach` for every registered window now and for every window registered later; the cleanup runs when that window goes away. */
export function onEachWindow(attach: Attach): () => void {
  const entry = { attach, cleanups: new Map<Window, () => void>() };
  watchers.add(entry);
  for (const win of windows) run(entry, win);
  return () => {
    watchers.delete(entry);
    for (const c of entry.cleanups.values()) c();
    entry.cleanups.clear();
  };
}

/** `window.addEventListener` on every simulator window. */
export function addWindowListener<K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, options?: boolean | AddEventListenerOptions): () => void {
  return onEachWindow((win) => {
    win.addEventListener(type, fn as EventListener, options);
    return () => win.removeEventListener(type, fn as EventListener, options);
  });
}

/** The window an element lives in (the popup for a portalled panel). */
export function windowOf(node: Node | null | undefined): Window {
  return node?.ownerDocument?.defaultView ?? window;
}

if (typeof window !== 'undefined') windows.add(window);
