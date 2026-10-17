import { useEffect, useRef } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import { useSimStore } from '../store/simStore';
import { useUiStore, viewBus } from '../store/uiStore';
import { useCanvasLoop } from './useCanvasLoop';
import { drawRadar, radarScale, RADAR_RANGES_NM } from './radarRenderer';
import type { RadarLayers, RadarRangeNm } from './radarRenderer';
import { panBy } from './viewTransform';
import type { View } from './viewTransform';
import { hitTestAircraft } from './hitTest';
import type { Frame } from './frame';
import { LayerMenu, OverlayBar, OVL_BTN } from './DisplayChrome';
import { lerp } from '../lib/geom';

const LAYER_LABELS: Record<keyof RadarLayers, string> = {
  rings: 'Range rings', compass: 'Compass rose', approachPaths: 'Approach paths', navaids: 'Navaids', fixes: 'Approach fixes',
  allFixes: 'All fixes (not only key)', labels: 'Data blocks', history: 'History dots', groundTargets: 'Ground targets', sweep: 'Sweep line (cosmetic)',
};

export function RadarDisplay() {
  const range = useUiStore((s) => s.radarRangeNm);
  const setRange = useUiStore((s) => s.setRadarRange);
  const layers = useUiStore((s) => s.radarLayers);
  const toggle = useUiStore((s) => s.toggleRadarLayer);
  const follow = useUiStore((s) => s.follow);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const followRef = useRef(follow);
  followRef.current = follow;
  /** Pan offset of the scope centre in world metres. */
  const centre = useRef({ x: 0, y: 0 });
  const viewRef = useRef<View>({ cx: 0, cy: 0, scale: 0.01, width: 1, height: 1 });
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);

  const { canvasRef, containerRef } = useCanvasLoop((ctx, size, nowMs) => {
    const session = useSimStore.getState().session;
    if (!session) return;
    const state = session.engine.getState();
    const frame: Frame = { state, nowMs, pose: (ac) => session.buffer.sample(ac, nowMs), selectedId: state.selectedAircraftId };
    if (followRef.current && state.selectedAircraftId) {
      const ac = state.aircraft[state.selectedAircraftId];
      if (ac) {
        const p = frame.pose(ac);
        centre.current = { x: lerp(centre.current.x, p.x, 0.2), y: lerp(centre.current.y, p.y, 0.2) };
      }
    }
    const v = viewRef.current;
    v.width = size.width;
    v.height = size.height;
    v.scale = radarScale(rangeRef.current, size.width, size.height);
    v.cx = centre.current.x;
    v.cy = centre.current.y;
    drawRadar(ctx, frame, v, rangeRef.current, layersRef.current);
  });

  useEffect(() => {
    const idx = (r: number) => RADAR_RANGES_NM.indexOf(r as RadarRangeNm);
    return viewBus.subscribe((c) => {
      if (c.type === 'fit') {
        centre.current = { x: 0, y: 0 };
        return;
      }
      const i = idx(rangeRef.current);
      const next = c.factor > 1 ? RADAR_RANGES_NM[Math.max(0, i - 1)] : RADAR_RANGES_NM[Math.min(RADAR_RANGES_NM.length - 1, i + 1)];
      setRange(next);
    });
  }, [setRange]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      acc += e.deltaY;
      if (Math.abs(acc) < 60) return;
      const i = RADAR_RANGES_NM.indexOf(rangeRef.current);
      const next = acc < 0 ? Math.max(0, i - 1) : Math.min(RADAR_RANGES_NM.length - 1, i + 1);
      acc = 0;
      setRange(RADAR_RANGES_NM[next]);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [canvasRef, setRange]);

  const onDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
  };
  const onMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.moved += Math.abs(dx) + Math.abs(dy);
    d.x = e.clientX;
    d.y = e.clientY;
    if (d.moved > 4) {
      const next = panBy(viewRef.current, dx, dy);
      centre.current = { x: next.cx, y: next.cy };
      if (followRef.current) useUiStore.getState().setFollow(false);
    }
  };
  const onUp = (e: RPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved > 4) return;
    const session = useSimStore.getState().session;
    if (!session) return;
    const r = (e.target as HTMLElement).getBoundingClientRect();
    const now = performance.now();
    const frame: Frame = { state: session.engine.getState(), nowMs: now, pose: (ac) => session.buffer.sample(ac, now) };
    useSimStore.getState().selectAircraft(hitTestAircraft(frame, viewRef.current, e.clientX - r.left, e.clientY - r.top, 18));
  };

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-[#040806]" data-testid="radar-display">
      <canvas
        ref={canvasRef}
        data-testid="radar-canvas"
        aria-label="Radar display"
        className="absolute inset-0 block cursor-crosshair touch-none"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => (drag.current = null)}
      />
      <OverlayBar className="right-3 top-3">
        {RADAR_RANGES_NM.map((r) => (
          <button key={r} type="button" aria-pressed={r === range} className={`${OVL_BTN} ${r === range ? '!border-atc-cyan !text-atc-cyan' : ''}`} onClick={() => setRange(r)}>
            {r} NM
          </button>
        ))}
      </OverlayBar>
      <OverlayBar className="left-3 top-3">
        <LayerMenu layers={layers} labels={LAYER_LABELS} onToggle={toggle} />
        <button type="button" className={`${OVL_BTN} ${follow ? '!border-atc-cyan !text-atc-cyan' : ''}`} aria-pressed={follow} onClick={() => useUiStore.getState().setFollow(!follow)}>
          Follow
        </button>
        <button type="button" className={OVL_BTN} onClick={() => viewBus.emit({ type: 'fit' })}>Centre</button>
      </OverlayBar>
    </div>
  );
}
