/**
 * Tower tab: a 3D view from the control tower cab. Same per-frame pattern as the Surface view (read the session from the store each
 * animation frame, sample the shared render buffer), no second simulation loop. This module is lazy-loaded by SimScreen, so three.js
 * stays out of the Surface/Radar startup bundle.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { OSM_ATTRIBUTION } from '../../airport';
import { useSimStore } from '../store/simStore';
import { useUiStore, viewBus } from '../store/uiStore';
import { OverlayBar, OVL_BTN } from '../display/DisplayChrome';
import { createTowerScene } from './towerScene';
import type { TowerScene } from './towerScene';
import { resolveTowerSite, CAB_EYE_HEIGHT_M } from './towerPosition';
import {
  applyDrag, applyZoom, bearingAndElevation, compassTicks, followStep, horizontalFov, initialCam, norm360, runwayEndTargets, snapToPoint, toMagnetic, toggleBinoculars,
} from './cameraMath';
import type { CamState } from './cameraMath';

// Remembered across Surface <-> Radar <-> Tower switches within one session.
let saved: { session: unknown; cam: CamState; follow: boolean } | null = null;

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && 'tagName' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export default function TowerDisplay() {
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const session = useSimStore((s) => s.session);
  const airport = session?.engine.getState().airport;
  const site = useMemo(() => (airport ? resolveTowerSite(airport) : undefined), [airport]);
  const camRef = useRef<CamState>(initialCam(0));
  const followRef = useRef(false);
  const [follow, setFollowState] = useState(false);
  const [binoc, setBinoc] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);
  const sceneRef = useRef<TowerScene | null>(null);
  const radarRange = useUiStore((s) => s.radarRangeNm);
  const rangeRef = useRef(radarRange);
  rangeRef.current = radarRange;

  const ends = useMemo(() => (airport ? runwayEndTargets(airport.runways) : []), [airport]);
  const endsRef = useRef(ends);
  endsRef.current = ends;
  const endIdx = useRef(-1);

  const setFollow = (f: boolean) => { followRef.current = f; setFollowState(f); };
  const setCam = (c: CamState) => { camRef.current = c; setBinoc(c.binoculars); };

  const snapTo = (i: number) => {
    if (!site || !endsRef.current.length) return;
    const n = endsRef.current.length;
    endIdx.current = ((i % n) + n) % n;
    setFollow(false);
    setCam(snapToPoint(camRef.current, site.pos, CAB_EYE_HEIGHT_M, endsRef.current[endIdx.current].threshold));
  };

  useEffect(() => {
    const overlay = overlayRef.current;
    const box = boxRef.current;
    const sess = useSimStore.getState().session;
    if (!overlay || !box || !sess || !site) return;
    // The GL canvas is created here, not by React: a canvas whose context was released on unmount (forceContextLoss) cannot get a new
    // context, and StrictMode runs mount, unmount, mount on the same element.
    const canvas = document.createElement('canvas');
    canvas.setAttribute('data-testid', 'tower-canvas');
    canvas.setAttribute('aria-label', 'Control tower 3D view');
    canvas.className = 'absolute inset-0 block cursor-grab touch-none active:cursor-grabbing';
    box.insertBefore(canvas, box.firstChild);
    const ap = sess.engine.getState().airport;

    if (saved && saved.session === sess) { camRef.current = { ...saved.cam }; followRef.current = saved.follow; setFollowState(saved.follow); setBinoc(saved.cam.binoculars); }
    else {
      // First look: along the runway with the most traffic would be a guess; start facing the airfield (the first runway's far threshold).
      const t = runwayEndTargets(ap.runways)[0];
      camRef.current = t ? snapToPoint(initialCam(0), site.pos, CAB_EYE_HEIGHT_M, ap.runways[0].ends[1].threshold) : initialCam(0);
    }

    let scene: TowerScene;
    try {
      scene = createTowerScene(canvas, ap, site);
    } catch (e) {
      console.warn('[tower] WebGL unavailable', e);
      canvas.remove();
      setError('WebGL is not available in this browser, so the Tower view cannot be drawn.');
      return;
    }
    sceneRef.current = scene;

    let raf = 0;
    let frames = 0;
    let alive = true;
    let w = 0;
    let h = 0;
    let ratio = 1;
    const fit = () => {
      const r = box.getBoundingClientRect();
      const nw = Math.max(1, Math.floor(r.width));
      const nh = Math.max(1, Math.floor(r.height));
      const nr = Math.min(2, window.devicePixelRatio || 1);
      if (nw === w && nh === h && nr === ratio) return;
      w = nw; h = nh; ratio = nr;
      scene.resize(w, h, ratio);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      overlay.width = Math.floor(w * ratio);
      overlay.height = Math.floor(h * ratio);
      overlay.style.width = `${w}px`;
      overlay.style.height = `${h}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    const ctx = overlay.getContext('2d');

    const drawOverlay = (cam: CamState) => {
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const aspect = w / h;
      const hfov = horizontalFov(cam.fovDeg, aspect);
      const var_ = ap.magneticVariationDeg;
      const centreMag = toMagnetic(cam.yawDeg, var_);
      // Heading strip (magnetic, like the headings controllers speak).
      const stripH = 30;
      ctx.fillStyle = 'rgba(7,9,12,0.72)';
      ctx.fillRect(0, 0, w, stripH);
      ctx.strokeStyle = 'rgba(77,88,100,0.9)';
      ctx.beginPath(); ctx.moveTo(0, stripH + 0.5); ctx.lineTo(w, stripH + 0.5); ctx.stroke();
      ctx.font = '11px "JetBrains Mono","SF Mono",Menlo,Consolas,monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const t of compassTicks(centreMag, hfov)) {
        const x = t.xFrac * w;
        ctx.strokeStyle = t.major ? '#9aa6b2' : '#56606b';
        ctx.beginPath(); ctx.moveTo(x + 0.5, stripH); ctx.lineTo(x + 0.5, stripH - (t.major ? 9 : 5)); ctx.stroke();
        if (t.label) { ctx.fillStyle = /[NESW]/.test(t.label) ? '#f2b33d' : '#d7dde4'; ctx.fillText(t.label, x, 10); }
      }
      ctx.fillStyle = '#39c5e8';
      ctx.beginPath(); ctx.moveTo(w / 2 - 5, stripH + 1); ctx.lineTo(w / 2 + 5, stripH + 1); ctx.lineTo(w / 2, stripH - 6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#39c5e8';
      ctx.font = 'bold 12px "JetBrains Mono","SF Mono",Menlo,Consolas,monospace';
      ctx.fillText(`${String(Math.round(centreMag) % 360 || 360).padStart(3, '0')}°M`, w / 2 + 38, 10);
      if (cam.binoculars) {
        // Binocular mask: dark vignette with a circular aperture.
        const r = Math.min(w, h) * 0.46;
        ctx.fillStyle = 'rgba(0,0,0,0.92)';
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2, true);
        ctx.fill('evenodd');
        ctx.strokeStyle = 'rgba(57,197,232,0.5)';
        ctx.beginPath(); ctx.moveTo(w / 2 - 14, h / 2); ctx.lineTo(w / 2 + 14, h / 2); ctx.moveTo(w / 2, h / 2 - 14); ctx.lineTo(w / 2, h / 2 + 14); ctx.stroke();
      }
    };

    const loop = (nowMs: number) => {
      if (!alive) return;
      raf = requestAnimationFrame(loop);
      const cur = useSimStore.getState().session;
      if (!cur || cur !== sess) return;
      try {
        const state = cur.engine.getState();
        const selectedId = state.selectedAircraftId;
        const pose = (ac: Parameters<typeof cur.buffer.sample>[0]) => cur.buffer.sample(ac, nowMs);
        if (followRef.current && selectedId) {
          const ac = state.aircraft[selectedId];
          if (ac) {
            const p = pose(ac);
            const hAgl = ac.onGround ? 3 : Math.max(0, (p.altitudeFt - ap.elevationFt) * 0.3048);
            const t = bearingAndElevation(site.pos, CAB_EYE_HEIGHT_M, { x: p.x, y: p.y }, hAgl);
            camRef.current = followStep(camRef.current, t.bearingDeg, t.elevationDeg, 0.18);
          }
        }
        scene.render({ state, nowMs, pose, selectedId, cam: camRef.current, width: w, height: h, rangeNm: rangeRef.current });
        drawOverlay(camRef.current);
        frames++;
        if (frames % 15 === 0) { canvas.dataset.frames = String(frames); canvas.dataset.drawCalls = String(scene.info.drawCalls()); }
      } catch (err) {
        console.error('[ui] tower draw failed', err);
        alive = false;
      }
    };
    raf = requestAnimationFrame(loop);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setCam(applyZoom(camRef.current, Math.exp(-e.deltaY * 0.0015)));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    const unsub = viewBus.subscribe((c) => {
      if (c.type === 'zoom') setCam(applyZoom(camRef.current, c.factor));
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
      const step = Math.max(1, camRef.current.fovDeg / 6);
      switch (e.key) {
        case 'ArrowLeft': e.preventDefault(); setFollow(false); setCam({ ...camRef.current, yawDeg: norm360(camRef.current.yawDeg - step) }); break;
        case 'ArrowRight': e.preventDefault(); setFollow(false); setCam({ ...camRef.current, yawDeg: norm360(camRef.current.yawDeg + step) }); break;
        case 'ArrowUp': e.preventDefault(); setCam({ ...camRef.current, pitchDeg: Math.min(80, camRef.current.pitchDeg + step) }); break;
        case 'ArrowDown': e.preventDefault(); setCam({ ...camRef.current, pitchDeg: Math.max(-45, camRef.current.pitchDeg - step) }); break;
        case ']': snapTo(endIdx.current + 1); break;
        case '[': snapTo(endIdx.current - 1); break;
        case 'b': case 'B': setCam(toggleBinoculars(camRef.current)); break;
        case 'f': case 'F': setFollow(!followRef.current); break;
        case 'c': case 'C': snapTo(0); break;
        default:
      }
    };
    window.addEventListener('keydown', onKey);

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
    };
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.moved += Math.abs(dx) + Math.abs(dy);
      d.x = e.clientX;
      d.y = e.clientY;
      if (d.moved > 4) {
        if (followRef.current) setFollow(false);
        setCam(applyDrag(camRef.current, dx, dy, canvas.clientHeight || 600));
      }
    };
    const onUp = (e: PointerEvent) => {
      const d = drag.current;
      drag.current = null;
      if (!d || d.moved > 4) return;
      const r = canvas.getBoundingClientRect();
      useSimStore.getState().selectAircraft(scene.pick(e.clientX - r.left, e.clientY - r.top));
    };
    const onCancel = () => { drag.current = null; };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
      unsub();
      saved = { session: sess, cam: { ...camRef.current }, follow: followRef.current };
      sceneRef.current = null;
      scene.dispose();
      canvas.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount (and a new session) only
  }, [site, session]);

  return (
    <div ref={boxRef} className="relative h-full w-full overflow-hidden bg-[#07090c]" data-testid="tower-display">
      <canvas ref={overlayRef} data-testid="tower-overlay" className="pointer-events-none absolute inset-0 block" />
      {error && (
        <div role="alert" className="absolute inset-0 z-20 flex items-center justify-center bg-atc-bg/90 p-6 text-center text-sm text-atc-amber" data-testid="tower-error">{error}</div>
      )}
      <OverlayBar className="left-3 top-11">
        <button type="button" data-testid="tower-follow" className={`${OVL_BTN} ${follow ? '!border-atc-cyan !text-atc-cyan' : ''}`} aria-pressed={follow} onClick={() => setFollow(!follow)} title="Keep the selected aircraft in view (F)">
          Follow
        </button>
        <button type="button" data-testid="tower-binoculars" className={`${OVL_BTN} ${binoc ? '!border-atc-cyan !text-atc-cyan' : ''}`} aria-pressed={binoc} onClick={() => setCam(toggleBinoculars(camRef.current))} title="Binoculars (B)">
          Binoculars
        </button>
        {ends.map((t, i) => (
          <button key={t.id} type="button" data-testid={`tower-rwy-${t.id}`} className={OVL_BTN} onClick={() => snapTo(i)} title={`Look at the runway ${t.id} threshold`}>
            RWY {t.id}
          </button>
        ))}
      </OverlayBar>
      <OverlayBar className="bottom-3 right-3 flex-col items-end !gap-1.5">
        <span className="bg-atc-bg/70 px-1.5 py-0.5 text-[9.5px] text-atc-muted" data-testid="tower-site">
          Cab at {site?.note ?? 'airport'} · eye {CAB_EYE_HEIGHT_M} m AGL
        </span>
        <span className="bg-atc-bg/70 px-1.5 py-0.5 text-[9.5px] text-atc-muted">{OSM_ATTRIBUTION}</span>
      </OverlayBar>
    </div>
  );
}
