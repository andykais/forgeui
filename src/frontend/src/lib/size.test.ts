import { describe, expect, it } from "vitest";
import { resolveRatio, sizeForImage, snap } from "./size.ts";
import type { Param } from "../types.ts";

/** LTX-2.3's size param: 1280x720 at a grid of 8. */
const ltx = { key: "size", type: "size", default: [1280, 720], step: 8 } as unknown as Param;
/** A Flux-shaped one: square base, coarser grid. */
const flux = { key: "size", type: "size", default: [1024, 1024], step: 64 } as unknown as Param;

describe("snap", () => {
  it("lands on the grid and never goes below one step", () => {
    expect(snap(1281, 8)).toBe(1280);
    expect(snap(1285, 8)).toBe(1288);
    expect(snap(3, 64)).toBe(64);
  });
});

describe("sizeForImage", () => {
  it("takes the picture's own size when it is anywhere near the workflow's", () => {
    // The case that motivated this: an image already the workflow's size.
    expect(sizeForImage(ltx, 1280, 720)).toEqual({ size: [1280, 720], exact: true });
    expect(sizeForImage(ltx, 640, 480)).toEqual({ size: [640, 480], exact: true });
    // 540 is not on an 8-grid, so it lands on the nearest that is — the same
    // rounding the ratio buttons do, and the reason the grid is stated.
    expect(sizeForImage(ltx, 960, 540)).toEqual({ size: [960, 544], exact: true });
  });

  it("a little over the workflow's own resolution is still exact", () => {
    // 1024x1024 beside a 1280x720 workflow is 1.14x the pixels. Substituting
    // 960x960 for it would be the app being clever at the user's expense.
    expect(sizeForImage(ltx, 1024, 1024)).toEqual({ size: [1024, 1024], exact: true });
  });

  it("snaps an odd size onto the grid", () => {
    expect(sizeForImage(ltx, 1021, 767)).toEqual({ size: [1024, 768], exact: true });
    expect(sizeForImage(flux, 700, 500)).toEqual({ size: [704, 512], exact: true });
  });

  it("keeps the ratio but comes down when the image is far bigger", () => {
    // A phone photograph: 12 megapixels is not a resolution to generate at.
    const result = sizeForImage(ltx, 4032, 3024)!;
    expect(result.exact).toBe(false);
    const [w, h] = result.size;
    expect(w * h).toBeLessThanOrEqual(1280 * 720 * 1.05);
    // 4:3, still.
    expect(w / h).toBeCloseTo(4 / 3, 1);
  });

  it("a portrait input gives a portrait output", () => {
    const [w, h] = sizeForImage(ltx, 2160, 3840)!.size;
    expect(h).toBeGreaterThan(w);
    expect(w / h).toBeCloseTo(9 / 16, 1);
  });

  it("agrees with the ratio buttons where they overlap", () => {
    // An oversized 16:9 image and the 16:9 preset are the same request.
    expect(sizeForImage(ltx, 3840, 2160)!.size).toEqual(resolveRatio(ltx, 16, 9));
  });

  it("respects a stated min and max", () => {
    const bounded = {
      ...ltx,
      min: 256,
      max: 1024,
    } as unknown as Param;
    expect(sizeForImage(bounded, 128, 128)).toEqual({ size: [256, 256], exact: true });
  });

  it("has no answer for a picture with no size", () => {
    expect(sizeForImage(ltx, 0, 100)).toBeNull();
    expect(sizeForImage(ltx, Number.NaN, 100)).toBeNull();
  });
});
