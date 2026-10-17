import { useEffect, useRef } from 'react';

export interface CanvasSize { width: number; height: number; dpr: number }

/**
 * Owns a canvas that fills its container, keeps its backing store at device-pixel ratio, and calls `draw` on every
 * animation frame. `draw` receives a context already scaled to CSS pixels. `draw` is read through a ref, so it can
 * close over fresh props without restarting the loop.
 */
export function useCanvasLoop(draw: (ctx: CanvasRenderingContext2D, size: CanvasSize, nowMs: number) => void, onResize?: (size: CanvasSize) => void) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<CanvasSize>({ width: 0, height: 0, dpr: 1 });
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const resizeRef = useRef(onResize);
  resizeRef.current = onResize;

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = containerRef.current;
    if (!canvas || !box) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let alive = true;

    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = box.getBoundingClientRect();
      const width = Math.max(1, Math.floor(r.width));
      const height = Math.max(1, Math.floor(r.height));
      if (width !== sizeRef.current.width || height !== sizeRef.current.height || dpr !== sizeRef.current.dpr) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        sizeRef.current = { width, height, dpr };
        resizeRef.current?.(sizeRef.current);
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);

    const loop = (t: number) => {
      if (!alive) return;
      const s = sizeRef.current;
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      try {
        drawRef.current(ctx, s, t);
      } catch (err) {
        console.error('[ui] canvas draw failed', err);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return { canvasRef, containerRef, sizeRef };
}
