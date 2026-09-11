import type { TelemetryUnit } from "../types.ts";

/**
 * The y axis's top (§11.2). The axis is rounded up inside the unit it will be
 * labelled in, so a peak of 11.2 GB reads 12 GB — not 1.0 TB, which is what a
 * ladder that only covered ratios 1 to 10 of a 1024 magnitude used to fall
 * through to.
 *
 * The step is a fifth of the peak's own decade, which keeps the axis within a
 * fifth of the data it is drawn for — "scaled to the data points" — while
 * still landing on a number a person would have picked.
 */
export function niceCeiling(peak: number, unit: TelemetryUnit): number {
  if (!Number.isFinite(peak) || peak <= 0) return 1;
  // Bytes are labelled in powers of 1024, so the rounding happens to the
  // number the reader actually sees: 11.2 is rounded, not 12,025,908,428.
  let scale = 1;
  if (unit === "bytes") {
    while (peak / scale >= 1024 && scale < 1024 ** 4) scale *= 1024;
  }
  const scaled = peak / scale;
  const step = 10 ** Math.floor(Math.log10(scaled)) / 5;
  // `toPrecision` because a fifth of a decade is 0.2 and its multiples are
  // not exact in binary: without it a 1.6 GB axis is 1.6000000000000003.
  const rounded = Number((Math.ceil(scaled / step) * step).toPrecision(12));
  return rounded * scale;
}
