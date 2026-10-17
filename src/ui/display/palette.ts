/** Canvas colours (canvas cannot read CSS variables cheaply; values mirror the atc-* tokens in src/index.css). */
export const C = {
  bg: '#07090c',
  grid: '#10151a',
  apron: '#141a20',
  apronEdge: '#202932',
  twyWide: '#171e25',
  twyLine: '#3d4c5a',
  twyUnnamed: '#222c35',
  runway: '#1f272e',
  runwayEdge: '#56667a',
  runwayCenter: '#8696a8',
  text: '#d7dde4',
  muted: '#7f8a96',
  dim: '#4d5864',
  green: '#39d353',
  greenDim: '#1f6f2e',
  cyan: '#39c5e8',
  amber: '#f2b33d',
  red: '#ff4d4f',
  white: '#ffffff',
  hold: '#f2c744',
  labelBg: 'rgba(7,9,12,0.82)',
} as const;

export const FONT_MONO = '"JetBrains Mono","SF Mono",Menlo,Consolas,monospace';
