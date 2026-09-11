import { describe, expect, test } from "vitest";
import { niceCeiling } from "./chart.ts";

/**
 * The axis is read, not computed against, so its top has to be a number a
 * person would have chosen — and it has to be near the data (§11.2).
 */
describe("the y axis ceiling", () => {
  test("rounds inside the unit the axis is labelled in", () => {
    const GB = 1024 ** 3;
    // The bug this replaces: 11.2 GB fell through a ladder that only went to
    // ten times a 1024 magnitude, and the axis jumped to 1.0 TB.
    expect(niceCeiling(11.2 * GB, "bytes")).toBe(12 * GB);
    expect(niceCeiling(1.58 * GB, "bytes")).toBe(1.6 * GB);
    expect(niceCeiling(6.4 * GB, "bytes")).toBe(6.4 * GB);
    expect(niceCeiling(940 * 1024 ** 2, "bytes")).toBe(940 * 1024 ** 2);
  });

  test("stays close to the peak rather than ballooning past it", () => {
    for (const peak of [69, 512, 4096, 1e6, 3.3e9, 2.2e12]) {
      const ceiling = niceCeiling(peak, "bytes");
      expect(ceiling).toBeGreaterThanOrEqual(peak);
      // Never more than a fifth of headroom above the tallest mark: the
      // axis is drawn for the data, not for a round number above it.
      expect(ceiling).toBeLessThanOrEqual(peak * 1.2);
    }
  });

  test("lands on a number the gridlines can quarter", () => {
    const GB = 1024 ** 3;
    for (const peak of [11.2 * GB, 640, 47, 1e6]) {
      const ceiling = niceCeiling(peak, "bytes");
      const scaled = ceiling / 1024 ** Math.floor(Math.log(ceiling) / Math.log(1024));
      // Two decimals at most in the unit it is drawn in, so the quarter
      // ticks under it stay readable rather than trailing digits.
      expect(Math.round(scaled * 100) / 100).toBeCloseTo(scaled, 6);
    }
  });

  test("durations round on the same ladder, without the 1024 step", () => {
    expect(niceCeiling(15, "ms")).toBe(16);
    expect(niceCeiling(420, "ms")).toBe(420);
    expect(niceCeiling(413, "ms")).toBe(420);
    expect(niceCeiling(0.4, "ms")).toBe(0.4);
  });

  test("an empty report still has an axis", () => {
    expect(niceCeiling(0, "bytes")).toBe(1);
    expect(niceCeiling(Number.NaN, "ms")).toBe(1);
  });
});
