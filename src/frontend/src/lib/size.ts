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
 * The size to generate at for an attached image (§9, §11.3).
 *
 * The picture's own shape and its own pixels, snapped to the model's grid
 * because that is the only size it can actually make. Nothing else: an
 * earlier version brought a large picture down to the workflow's own
 * resolution, which is the app deciding something the person attaching a
 * 2720x1536 frame has already decided. The size row is right there to adjust.
 */
export function sizeForImage(param: Param, width: number, height: number): Size | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  const step = stepOf(param);
  const clamp = (value: number) => {
    const snapped = snap(value, step);
    const min = param.min ?? step;
    const max = param.max;
    return Math.min(Math.max(snapped, min), max ?? snapped);
  };
  return [clamp(width), clamp(height)];
}
