/** Pure zoom / fit helpers for the chart viewer (scale 1 = 1 PDF point per CSS px). */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;
export const ZOOM_STEP = 1.25;
/** Upper bound on backing-store pixels for one canvas (keeps 400% zoom bounded in memory). */
export const MAX_CANVAS_PIXELS = 16_000_000;

export type FitMode = 'width' | 'page' | 'custom';

export const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function fitScale(mode: Exclude<FitMode, 'custom'>, page: { w: number; h: number }, box: { w: number; h: number }): number {
  if (page.w <= 0 || page.h <= 0 || box.w <= 0 || box.h <= 0) return 1;
  const byWidth = box.w / page.w;
  return clampScale(mode === 'width' ? byWidth : Math.min(byWidth, box.h / page.h));
}

/** Device-pixel render scale, reduced if the bitmap would exceed MAX_CANVAS_PIXELS. */
export function renderScaleFor(scale: number, dpr: number, page: { w: number; h: number }): number {
  const wanted = scale * Math.max(1, dpr);
  const maxByPixels = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, page.w * page.h));
  return Math.min(wanted, maxByPixels);
}

export const formatPercent = (scale: number): string => `${Math.round(scale * 100)}%`;
