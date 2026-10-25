/**
 * The mask editor's arithmetic (§10), apart from any canvas so it can be
 * tested on its own. The editor paints into a canvas the size of the image,
 * and only the alpha of what it painted means anything: 255 repaints, 0
 * keeps. What goes to the server is that alpha as a grey PNG — white
 * repaints, black keeps — read on the red channel by `LoadImageMask` (§9).
 */

/** The alpha channel of an RGBA buffer: one byte per pixel. */
export function alphaOf(rgba: Uint8ClampedArray): Uint8Array {
  const alpha = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3]!;
  return alpha;
}

/** Write `alpha` back as the editor paints: `color` at that coverage. */
export function paintAlpha(
  rgba: Uint8ClampedArray,
  alpha: Uint8Array,
  color: [number, number, number],
): void {
  for (let i = 0; i < alpha.length; i++) {
    rgba[i * 4] = color[0];
    rgba[i * 4 + 1] = color[1];
    rgba[i * 4 + 2] = color[2];
    rgba[i * 4 + 3] = alpha[i]!;
  }
}

/** What the server is sent: the coverage as opaque grey, white repaints. */
export function maskPixels(alpha: Uint8Array): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(alpha.length * 4);
  for (let i = 0; i < alpha.length; i++) {
    const v = alpha[i]!;
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/**
 * Read a stored mask back into coverage, for painting on top of it: the red
 * channel, as `LoadImageMask` reads it, so what the editor shows is what the
 * workflow got.
 */
export function coverageOf(rgba: Uint8ClampedArray): Uint8Array {
  const alpha = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4]!;
  return alpha;
}

export function invert(alpha: Uint8Array): Uint8Array {
  const out = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) out[i] = 255 - alpha[i]!;
  return out;
}

/**
 * Nothing painted. The faint fringe a stroke leaves after it is erased is
 * still nothing: below this, a pixel would barely move under any feather.
 */
export function isBlank(alpha: Uint8Array, threshold = 8): boolean {
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i]! >= threshold) return false;
  }
  return true;
}

/**
 * Undo and redo as whole snapshots of the coverage, one per stroke, invert
 * or clear. A snapshot is a byte per pixel, so the depth follows the size of
 * the picture: a 4096² mask is 16 MB a step, and a phone-sized one costs
 * nothing.
 */
export class MaskHistory {
  #undo: Uint8Array[] = [];
  #redo: Uint8Array[] = [];
  readonly limit: number;

  constructor(pixels: number, budget = 256 * 1024 * 1024) {
    this.limit = Math.max(4, Math.min(50, Math.floor(budget / pixels)));
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  /** Before a change: what it was. A new change forgets what was undone. */
  push(before: Uint8Array): void {
    this.#undo.push(before);
    if (this.#undo.length > this.limit) this.#undo.shift();
    this.#redo = [];
  }

  /** Step back from `current`; null when there is nothing to step to. */
  undo(current: Uint8Array): Uint8Array | null {
    const previous = this.#undo.pop();
    if (!previous) return null;
    this.#redo.push(current);
    return previous;
  }

  redo(current: Uint8Array): Uint8Array | null {
    const next = this.#redo.pop();
    if (!next) return null;
    this.#undo.push(current);
    return next;
  }
}

/** The range a brush may take for a picture, in the picture's own pixels. */
export function brushRange(width: number, height: number) {
  const short = Math.min(width, height);
  const max = Math.max(16, Math.round(Math.max(width, height) / 4));
  return {
    min: 2,
    max,
    initial: Math.min(max, Math.max(4, Math.round(short / 12))),
  };
}

/**
 * One press of `brush_larger` / `brush_smaller`: a quarter bigger or a fifth
 * smaller, so the steps are even to the eye at any size — but always at
 * least a pixel, or a small brush would never grow.
 */
export function stepBrush(
  size: number,
  direction: 1 | -1,
  range: { min: number; max: number },
): number {
  const next =
    direction > 0
      ? Math.max(size + 1, Math.round(size * 1.25))
      : Math.min(size - 1, Math.round(size * 0.8));
  return Math.min(range.max, Math.max(range.min, next));
}

/** Where a pointer is on the picture, in the picture's pixels. */
export function toImage(
  client: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: ((client.x - rect.left) * size.width) / rect.width,
    y: ((client.y - rect.top) * size.height) / rect.height,
  };
}

/** The address of a stored input in the media route (§9). */
export function inputUrl(filename: string): string {
  return `/api/media/inputs/${filename.slice(0, 2)}/${filename}`;
}
