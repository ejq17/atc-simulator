import { useEffect, useRef } from 'react';
import { OSM_ATTRIBUTION } from '../../airport';
import { useSimStore } from '../store/simStore';
import { useUiStore, viewBus } from '../store/uiStore';
import { useCanvasLoop } from './useCanvasLoop';
import { drawSurface } from './surfaceRenderer';
import type { SurfaceLayers } from './surfaceRenderer';
import { buildSurfaceStatic } from './surfaceStatic';
import { fitBounds, panBy, zoomAt } from './viewTransform';
import type { View } from './viewTransform';
import { hitTestAircraft } from './hitTest';
import { attachGestures } from './pointerGestures';
import type { Frame } from './frame';
import { LayerMenu, OverlayBar, OVL_BTN } from './DisplayChrome';
import { lerp } from '../lib/geom';

const LAYER_LABELS: Record<keyof SurfaceLayers, string> = {
  labels: 'Aircraft labels', taxiwayIds: 'Taxiway identifiers', routes: 'Taxi routes', trails: 'Movement trails', parking: 'Parking positions', unnamed: 'Unnamed lanes',
};

// Remembered across Surface <-> Radar switches within one session.
let saved: { session: unknown; view: View } | null = null;

export function SurfaceDisplay() {
  const viewRef = useRef<View>({ cx: 0, cy: 0, scale: 0.3, width: 1, height: 1 });
  const fitted = useRef(false);
  const layers = useUiStore((s) => s.surfaceLayers);
  const toggle = useUiStore((s) => s.toggleSurfaceLayer);
  const follow = useUiStore((s) => s.follow);
  const setFollow = useUiStore((s) => s.setFollow);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const followRef = useRef(follow);
  followRef.current = follow;

  const doFit = () => {
    const session = useSimStore.getState().session;
    if (!session) return;
    const st = buildSurfaceStatic(session.engine.getState().airport);
    viewRef.current = fitBounds(st.bounds, viewRef.current.width, viewRef.current.height, 0.07);
  };

  const { canvasRef, containerRef } = useCanvasLoop(
    (ctx, size, nowMs) => {
      const session = useSimStore.getState().session;
      if (!session) return;
      const v = viewRef.current;
      v.width = size.width;
      v.height = size.height;
      const state = session.engine.getState();
      const frame: Frame = { state, nowMs, pose: (ac) => session.buffer.sample(ac, nowMs), selectedId: state.selectedAircraftId };
      if (followRef.current && state.selectedAircraftId) {
        const ac = state.aircraft[state.selectedAircraftId];
        if (ac) {
          const p = frame.pose(ac);
          v.cx = lerp(v.cx, p.x, 0.2);
          v.cy = lerp(v.cy, p.y, 0.2);
        }
      }
      drawSurface(ctx, frame, v, layersRef.current);
    },
    (size) => {
      const v = viewRef.current;
      const session = useSimStore.getState().session;
      v.width = size.width;
      v.height = size.height;
      if (!fitted.current && session) {
        fitted.current = true;
        if (saved && saved.session === session) viewRef.current = { ...saved.view, width: size.width, height: size.height };
        else doFit();
      }
    },
  );

  useEffect(() => {
    const session = useSimStore.getState().session;
    if (session && viewRef.current.width > 1 && !fitted.current) {
      fitted.current = true;
      if (saved && saved.session === session) viewRef.current = { ...saved.view, width: viewRef.current.width, height: viewRef.current.height };
      else doFit();
    }
    const unsub = viewBus.subscribe((c) => {
      if (c.type === 'zoom') viewRef.current = zoomAt(viewRef.current, c.factor);
      else doFit();
    });
    return () => {
      unsub();
      saved = { session: useSimStore.getState().session, view: { ...viewRef.current } };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only
  }, []);

  // Wheel zoom must be a non-passive native listener so the page does not scroll.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      viewRef.current = zoomAt(viewRef.current, Math.exp(-e.deltaY * 0.0015), { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [canvasRef]);

  // One finger / mouse drag pans, two fingers pinch-zoom, a tap selects (Pointer Events; works the same in a pop-out window).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    return attachGestures(el, {
      pan: (dx, dy) => { viewRef.current = panBy(viewRef.current, dx, dy); },
      zoom: (factor, anchor) => { viewRef.current = zoomAt(viewRef.current, factor, anchor); },
      moved: () => { if (followRef.current) setFollow(false); },
      tap: (x, y, pointerType) => {
        const session = useSimStore.getState().session;
        if (!session) return;
        const state = session.engine.getState();
        const now = performance.now();
        const frame: Frame = { state, nowMs: now, pose: (ac) => session.buffer.sample(ac, now) };
        useSimStore.getState().selectAircraft(hitTestAircraft(frame, viewRef.current, x, y, pointerType === 'touch' ? 28 : undefined));
      },
    });
  }, [canvasRef, setFollow]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-[#07090c]" data-testid="surface-display">
      <canvas
        ref={canvasRef}
        data-testid="surface-canvas"
        aria-label="Airport surface display"
        className="absolute inset-0 block cursor-crosshair touch-none"
      />
      <OverlayBar className="left-2 top-2 flex-wrap sm:left-3 sm:top-3">
        <LayerMenu layers={layers} labels={LAYER_LABELS} onToggle={toggle} />
        <button type="button" className={`${OVL_BTN} ${follow ? '!border-atc-cyan !text-atc-cyan' : ''}`} aria-pressed={follow} onClick={() => setFollow(!follow)} title="Keep the selected aircraft centred">
          Follow
        </button>
        <button type="button" className={OVL_BTN} onClick={() => doFit()} title="Fit the whole airport">Fit</button>
      </OverlayBar>
      <OverlayBar className="bottom-2 right-2 max-w-[calc(100%-1rem)] flex-col items-end !gap-1.5 sm:bottom-3 sm:right-3">
        <div className="flex gap-1">
          <button type="button" className={OVL_BTN} aria-label="Zoom in" onClick={() => viewBus.emit({ type: 'zoom', factor: 1.4 })}>+</button>
          <button type="button" className={OVL_BTN} aria-label="Zoom out" onClick={() => viewBus.emit({ type: 'zoom', factor: 1 / 1.4 })}>−</button>
        </div>
        <span className="max-w-full truncate bg-atc-bg/70 px-1.5 py-0.5 text-[9.5px] text-atc-muted">{OSM_ATTRIBUTION}</span>
      </OverlayBar>
    </div>
  );
}
