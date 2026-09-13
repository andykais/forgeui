import type { Param } from "../types.ts";

/**
 * What a size means for one workflow (§11.3).
 *
 * The presets are ratios rather than pixel counts, and they resolve against
 * the workflow's own base resolution — its `default` — so 16:9 is one thing
 * on Flux and another on SDXL. Everything lands on the model's grid, which
 * `step` states.
 */

export type Size = [number, number];

export function stepOf(param: Param): number {
  return param.step ?? 8;
}

export function baseOf(param: Param): Size {
  return (param.default as Size) ?? [1024, 1024];
}

/** Onto the model's grid, and never below one whole step. */
export function snap(pixels: number, step: number): number {
  return Math.max(step, Math.round(pixels / step) * step);
}

/** A ratio at the workflow's own pixel budget. */
export function resolveRatio(param: Param, a: number, b: number): Size {
  const step = stepOf(param);
  const [baseWidth, baseHeight] = baseOf(param);
  const area = baseWidth * baseHeight;
  const width = Math.sqrt(area * (a / b));
  return [snap(width, step), snap(width / (a / b), step)];
}

/**
 * How far past the workflow's own resolution an image may be and still be
 * generated at its own size. Twice the pixels is roughly where the run stops
 * being the same proposition in time and memory; under that, "match the
 * picture" should mean what it says rather than second-guessing by a few
 * percent. A 1024x1024 next to a 1280x720 workflow is 1.14x, and asking for
 * 960x960 instead would be the app being clever at the user's expense.
 */
const AREA_HEADROOM = 2;

export interface ImageSize {
  size: Size;
  /** False when the ratio was kept but the pixels were brought down. */
  exact: boolean;
}

/**
 * The size to generate at for an attached image (§9, §11.3).
 *
 * The ratio is always the picture's: asking a model to make a 16:9 video out
 * of a square photograph is the thing nobody wants and everybody has to
 * remember to fix by hand.
 *
 * The pixels are the picture's too, snapped to the grid — until the picture
 * is far larger than anything this workflow was built to make. A photograph
 * off a phone is 12 megapixels, and handing that to a video model as a
 * resolution is not "matching the input", it is an out-of-memory an hour into
 * the evening. Past the headroom the ratio is kept and the area comes down to
 * the workflow's own, which is exactly what the ratio buttons already do —
 * and the caller is told, so it is never a silent substitution.
 */
export function sizeForImage(
  param: Param,
  width: number,
  height: number,
): ImageSize | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  const step = stepOf(param);
  const [baseWidth, baseHeight] = baseOf(param);
  if (width * height > baseWidth * baseHeight * AREA_HEADROOM) {
    return { size: resolveRatio(param, width, height), exact: false };
  }

  const clamp = (value: number) => {
    const snapped = snap(value, step);
    const min = param.min ?? step;
    const max = param.max;
    return Math.min(Math.max(snapped, min), max ?? snapped);
  };
  return { size: [clamp(width), clamp(height)], exact: true };
}
