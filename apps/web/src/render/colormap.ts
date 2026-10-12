// Utilisation colour maps (design doc 応力の可視化): 0 % blue → 100 % red, over 100 % magenta
// (blinking, done in the shader), and a viridis palette for colour-vision accessibility.
// Pure: colours are linear-ish sRGB triples in 0..1, written straight into vertex colours.

export type PaletteId = 'stress' | 'viridis';
export type Rgb = readonly [number, number, number];

export interface Palette {
  id: PaletteId;
  /** Japanese label for the toggle */
  label: string;
  /** colour stops for utilisation 0..1, evenly spaced */
  stops: readonly Rgb[];
  /** utilisation > 1 */
  over: Rgb;
}

const hex = (h: number): Rgb => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

export const PALETTES: Record<PaletteId, Palette> = {
  stress: {
    id: 'stress',
    label: '標準',
    stops: [hex(0x2a52be), hex(0x22a7d8), hex(0x3fbf5f), hex(0xf2c230), hex(0xe0312b)],
    over: hex(0xff2bd6),
  },
  viridis: {
    id: 'viridis',
    label: 'viridis',
    stops: [hex(0x440154), hex(0x3b528b), hex(0x21918c), hex(0x5ec962), hex(0xfde725)],
    over: hex(0xff2bd6),
  },
};

/** Colour of a cell before the first solve result arrives. */
export const NEUTRAL: Rgb = hex(0xc4c8cf);
/** Protected (keep) cells: excluded from the judgement, shown neutral + hatched. */
export const KEEP_TINT: Rgb = hex(0x8f97a6);
/** Obstacles (block). */
export const BLOCK_COLOR: Rgb = hex(0x55595f);

/** Colour of utilisation `u` (fraction, 1 = allowable) into `out[offset..offset+2]`. */
export function colorAt(p: Palette, u: number, out: Float32Array | number[], offset = 0): void {
  if (!(u <= 1)) {
    // > 1, or NaN (treat as failing so it is never hidden)
    out[offset] = p.over[0];
    out[offset + 1] = p.over[1];
    out[offset + 2] = p.over[2];
    return;
  }
  const t = Math.max(0, u) * (p.stops.length - 1);
  const i = Math.min(p.stops.length - 2, Math.floor(t));
  const f = t - i;
  const a = p.stops[i]!;
  const b = p.stops[i + 1]!;
  out[offset] = a[0] + (b[0] - a[0]) * f;
  out[offset + 1] = a[1] + (b[1] - a[1]) * f;
  out[offset + 2] = a[2] + (b[2] - a[2]) * f;
}

export function cssColor(c: Rgb): string {
  const to = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${to(c[0])} ${to(c[1])} ${to(c[2])})`;
}

/** CSS gradient for the legend bar, 0 % at the bottom/left. */
export function legendGradient(p: Palette, direction = 'to top'): string {
  const n = p.stops.length - 1;
  const parts = p.stops.map((s, i) => `${cssColor(s)} ${((i / n) * 100).toFixed(0)}%`);
  return `linear-gradient(${direction}, ${parts.join(', ')})`;
}

/** Per-vertex shader flags (see voxelMesh.ts). */
export const FLAG_KEEP = 1;
export const FLAG_OVER = 2;
/** thinner than the 2-voxel minimum (T-308 warning dots) */
export const FLAG_THIN = 4;

/** sRGB → linear (Three.js treats vertex colours as linear). */
export function srgbToLinear(c: Rgb): Rgb {
  const f = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return [f(c[0]), f(c[1]), f(c[2])];
}

/** The same palette with linear stops, for vertex colours. */
export function linearPalette(p: Palette): Palette {
  return { ...p, stops: p.stops.map(srgbToLinear), over: srgbToLinear(p.over) };
}

export interface PaintInput {
  /** palette in the colour space of the output (use `linearPalette` for vertex colours) */
  palette: Palette;
  /** colours of neutral (unsolved) and protected cells, same space as `palette` */
  neutral: Rgb;
  keepTint: Rgb;
  /** per element utilisation, or null before the first result */
  utilization: Float32Array | null;
  keep: Uint8Array;
  /** per element thin-wall warning flags (T-308), or null/absent to hide the tint */
  thin?: Uint8Array | null;
}

/**
 * Fill per-vertex colours (4 vertices × rgb per quad) and per-vertex flags for a chunk
 * mesh from the element of each quad.
 */
export function paintQuads(
  quadElement: Uint32Array,
  input: PaintInput,
  colors: Float32Array,
  flags: Uint8Array,
): void {
  const rgb = [0, 0, 0];
  const thin = input.thin ?? null;
  for (let q = 0; q < quadElement.length; q++) {
    const e = quadElement[q]!;
    let f = 0;
    if (input.keep[e]) {
      rgb[0] = input.keepTint[0];
      rgb[1] = input.keepTint[1];
      rgb[2] = input.keepTint[2];
      f = FLAG_KEEP;
    } else if (input.utilization) {
      const u = input.utilization[e] ?? 0;
      colorAt(input.palette, u, rgb);
      if (!(u <= 1)) f = FLAG_OVER;
    } else {
      rgb[0] = input.neutral[0];
      rgb[1] = input.neutral[1];
      rgb[2] = input.neutral[2];
    }
    if (thin?.[e] && !input.keep[e]) f |= FLAG_THIN;
    for (let c = 0; c < 4; c++) {
      const v = q * 4 + c;
      colors[v * 3] = rgb[0]!;
      colors[v * 3 + 1] = rgb[1]!;
      colors[v * 3 + 2] = rgb[2]!;
      flags[v] = f;
    }
  }
}

/** Element-wise maximum over load cases (the colour map shows the envelope). */
export function envelope(fields: readonly Float32Array[]): Float32Array | null {
  const first = fields[0];
  if (!first) return null;
  if (fields.length === 1) return first;
  const out = new Float32Array(first);
  for (let k = 1; k < fields.length; k++) {
    const f = fields[k]!;
    for (let e = 0; e < out.length; e++) if (f[e]! > out[e]!) out[e] = f[e]!;
  }
  return out;
}
