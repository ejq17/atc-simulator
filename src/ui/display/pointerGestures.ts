/**
 * Pointer Events gestures shared by the canvas displays: one pointer drags (pan), two pointers pinch (zoom about their midpoint,
 * plus pan), a short press without movement is a tap. Mouse, pen and touch all arrive here, so the displays have no touch-only code.
 * Listeners are attached to the element itself, so the same code works in a pop-out window's document.
 */

export interface GestureHandlers {
  /** Screen-space drag delta in CSS pixels. */
  pan(dx: number, dy: number): void;
  /** Multiplicative zoom factor about `anchor` (CSS pixels relative to the element). */
  zoom(factor: number, anchor: { x: number; y: number }): void;
  /** A press that did not move; `x`/`y` are relative to the element. */
  tap(x: number, y: number, pointerType: string): void;
  /** Called when a gesture starts moving the view (the displays turn "follow" off). */
  moved?(): void;
}

interface P { x: number; y: number }

const TAP_SLOP = 4;
const TOUCH_TAP_SLOP = 10;

export function attachGestures(el: HTMLElement, h: GestureHandlers): () => void {
  const pointers = new Map<number, P>();
  let movedPx = 0;
  let multi = false;
  let lastDist = 0;
  let lastMid: P = { x: 0, y: 0 };
  let kind = 'mouse';
  let signalled = false;

  const rel = (p: P): P => {
    const r = el.getBoundingClientRect();
    return { x: p.x - r.left, y: p.y - r.top };
  };
  const pair = () => {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };
  const signal = () => {
    if (!signalled) { signalled = true; h.moved?.(); }
  };

  const down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointers cannot be captured */ }
    if (pointers.size === 0) { movedPx = 0; multi = false; signalled = false; kind = e.pointerType || 'mouse'; }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      multi = true;
      const p = pair();
      lastDist = p.dist;
      lastMid = p.mid;
    }
  };
  const move = (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    if (pointers.size >= 2) {
      const p = pair();
      if (lastDist > 0 && p.dist > 0) {
        signal();
        h.zoom(p.dist / lastDist, rel(p.mid));
        h.pan(p.mid.x - lastMid.x, p.mid.y - lastMid.y);
      }
      lastDist = p.dist;
      lastMid = p.mid;
      return;
    }
    if (multi) return; // one finger left after a pinch: ignore until everything is lifted
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    movedPx += Math.abs(dx) + Math.abs(dy);
    if (movedPx > TAP_SLOP) {
      signal();
      h.pan(dx, dy);
    }
  };
  const up = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    const last = pointers.get(e.pointerId)!;
    pointers.delete(e.pointerId);
    if (pointers.size === 1) { // a pinch ended with one finger still down
      lastDist = 0;
    }
    if (pointers.size === 0) {
      const wasTap = !multi && e.type === 'pointerup' && movedPx <= (kind === 'touch' ? TOUCH_TAP_SLOP : TAP_SLOP);
      multi = false;
      if (wasTap) {
        const r = rel({ x: e.clientX || last.x, y: e.clientY || last.y });
        h.tap(r.x, r.y, kind);
      }
    }
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    pointers.clear();
  };
}
