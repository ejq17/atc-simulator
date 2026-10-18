// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mirrorStyles, openPopup, popupFeatures, prepareDocument } from './popupWindow';
import { listWindows, onEachWindow, registerWindow } from './windows';

function popupWindow() {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const win = frame.contentWindow!;
  Object.defineProperty(win, 'closed', { get: () => !frame.isConnected });
  win.close = () => { win.dispatchEvent(new (win as unknown as typeof globalThis).Event('unload')); frame.remove(); };
  return win;
}

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('popup window helper', () => {
  it('opens with popup features and prepares title, dark background and a full-height #root', () => {
    const popup = popupWindow();
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);
    const onClosed = vi.fn();
    const handle = openPopup({ name: 'kacy-atc-radar', title: 'Radar - ATC Simulator', geometry: { x: 10, y: 20, w: 800, h: 600 }, onClosed })!;
    expect(open).toHaveBeenCalledWith('', 'kacy-atc-radar', 'popup,width=800,height=600,left=10,top=20');
    expect(popup.document.title).toBe('Radar - ATC Simulator');
    expect(popup.document.documentElement.style.height).toBe('100%');
    expect(popup.document.body.style.height).toBe('100%');
    expect(popup.document.body.style.background).toMatch(/rgb\(11, 14, 17\)|#0b0e11/);
    expect(handle.root.id).toBe('root');
    expect(handle.root.style.height).toBe('100%');
    expect(popup.document.body.contains(handle.root)).toBe(true);
    handle.close();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('returns null when the popup blocker refuses', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openPopup({ name: 'x', title: 'x', geometry: { x: 0, y: 0, w: 300, h: 200 }, onClosed: vi.fn() })).toBeNull();
  });

  it('reports a closed window once, whichever event arrives first', () => {
    const popup = popupWindow();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    const onClosed = vi.fn();
    openPopup({ name: 'x', title: 'x', geometry: { x: 0, y: 0, w: 300, h: 200 }, onClosed });
    popup.dispatchEvent(new (popup as unknown as typeof globalThis).Event('pagehide'));
    popup.dispatchEvent(new (popup as unknown as typeof globalThis).Event('beforeunload'));
    popup.dispatchEvent(new (popup as unknown as typeof globalThis).Event('unload'));
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('copies every style and stylesheet link into the popup and keeps following new and changed ones', async () => {
    document.head.innerHTML = '<style id="a">.x{color:red}</style><link rel="stylesheet" href="/assets/app.css"><link rel="icon" href="/f.svg">';
    const popup = popupWindow();
    prepareDocument(popup, 't');
    const stop = mirrorStyles(document, popup.document);
    const copies = () => Array.from(popup.document.head.querySelectorAll('style, link[rel~="stylesheet"]'));
    expect(copies()).toHaveLength(2);
    expect(popup.document.head.querySelector('style')!.textContent).toBe('.x{color:red}');
    expect((popup.document.head.querySelector('link[rel~="stylesheet"]') as HTMLLinkElement).href).toContain('/assets/app.css');
    expect(popup.document.head.querySelector('link[rel="icon"]')).toBeNull();

    const injected = document.createElement('style');
    injected.textContent = '.y{color:blue}';
    document.head.appendChild(injected); // a style injected later (Vite dev, Tailwind)
    await new Promise((r) => setTimeout(r, 0));
    expect(copies()).toHaveLength(3);

    document.getElementById('a')!.textContent = '.x{color:green}'; // HMR replaces the text
    await new Promise((r) => setTimeout(r, 0));
    expect(popup.document.head.querySelector('style')!.textContent).toBe('.x{color:green}');

    injected.remove();
    await new Promise((r) => setTimeout(r, 0));
    expect(copies()).toHaveLength(2);
    stop();
  });

  it('builds the window.open feature string', () => {
    expect(popupFeatures({ x: 1.6, y: 2, w: 640.4, h: 480 })).toBe('popup,width=640,height=480,left=2,top=2');
  });
});

describe('window registry', () => {
  it('runs a listener on the main window and on every window registered later, and cleans up when one goes away', () => {
    const popup = popupWindow();
    const seen: Window[] = [];
    const cleaned: Window[] = [];
    const off = onEachWindow((w) => { seen.push(w); return () => cleaned.push(w); });
    expect(seen).toEqual([window]);
    const unregister = registerWindow(popup);
    expect(seen).toEqual([window, popup]);
    expect(listWindows()).toContain(popup);
    unregister();
    expect(cleaned).toEqual([popup]);
    off();
    expect(cleaned).toContain(window);
  });
});
