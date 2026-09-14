import { describe, expect, it } from "vitest";
import { sizeForImage, snap } from "./size.ts";
import type { Param } from "../types.ts";

/** LTX-2.3's size param: 1280x720 at a grid of 8. */
const ltx = {
  key: "size",
  type: "size",
  default: [1280, 720],
  step: 8,
} as unknown as Param;
/** A Flux-shaped one: square base, coarser grid. */
const flux = {
  key: "size",
  type: "size",
  default: [1024, 1024],
  step: 64,
} as unknown as Param;

describe("snap", () => {
  it("lands on the grid and never goes below one step", () => {
    expect(snap(1281, 8)).toBe(1280);
    expect(snap(1285, 8)).toBe(1288);
    expect(snap(3, 64)).toBe(64);
  });
});

describe("sizeForImage", () => {
  it("takes the picture's own size", () => {
    expect(sizeForImage(ltx, 1280, 720)).toEqual([1280, 720]);
    expect(sizeForImage(ltx, 640, 480)).toEqual([640, 480]);
    // 540 is not on an 8-grid, so it lands on the nearest that is — the same
    // rounding the ratio buttons do, and the reason the grid is stated.
    expect(sizeForImage(ltx, 960, 540)).toEqual([960, 544]);
  });

  it("takes it however far past the workflow's own resolution it is", () => {
    // An upscaled frame handed in on purpose. Bringing this down to the
    // workflow's 1280x720 would be overruling a decision already made; the
    // size row is right there to adjust.
    expect(sizeForImage(ltx, 2720, 1536)).toEqual([2720, 1536]);
    expect(sizeForImage(ltx, 4032, 3024)).toEqual([4032, 3024]);
  });

  it("snaps an odd size onto the grid", () => {
    expect(sizeForImage(ltx, 1021, 767)).toEqual([1024, 768]);
    expect(sizeForImage(flux, 700, 500)).toEqual([704, 512]);
  });

  it("a portrait input gives a portrait output", () => {
    const [w, h] = sizeForImage(ltx, 2160, 3840)!;
    expect(h).toBeGreaterThan(w);
    expect(w / h).toBeCloseTo(9 / 16, 2);
  });

  it("respects a stated min and max", () => {
    const bounded = { ...ltx, min: 256, max: 1024 } as unknown as Param;
    expect(sizeForImage(bounded, 128, 128)).toEqual([256, 256]);
    expect(sizeForImage(bounded, 4000, 4000)).toEqual([1024, 1024]);
  });

  it("has no answer for a picture with no size", () => {
    expect(sizeForImage(ltx, 0, 100)).toBeNull();
    expect(sizeForImage(ltx, Number.NaN, 100)).toBeNull();
  });
});
