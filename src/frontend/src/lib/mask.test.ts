import { describe, expect, test } from "vitest";
import {
  alphaOf,
  brushRange,
  coverageOf,
  inputUrl,
  invert,
  isBlank,
  MaskHistory,
  maskPixels,
  paintAlpha,
  stepBrush,
  toImage,
} from "./mask.ts";

/**
 * The mask editor's arithmetic (§10): what is painted is the alpha of the
 * canvas, what is sent is that alpha as grey with white repainting, and
 * undo is a snapshot per step.
 */

describe("the pixels", () => {
  test("painted coverage goes out as opaque grey, white repainting", () => {
    const rgba = new Uint8ClampedArray([
      111,
      182,
      200,
      255, // painted
      0,
      0,
      0,
      0, // untouched
      111,
      182,
      200,
      128, // a stroke's soft edge
    ]);
    const alpha = alphaOf(rgba);
    expect([...alpha]).toEqual([255, 0, 128]);
    expect([...maskPixels(alpha)]).toEqual([
      255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255,
    ]);
  });

  test("a stored mask reads back on the red channel, as the workflow reads it", () => {
    const stored = maskPixels(new Uint8Array([255, 0, 64]));
    expect([...coverageOf(stored)]).toEqual([255, 0, 64]);
    // And paints back in the tint at that coverage.
    const rgba = new Uint8ClampedArray(12);
    paintAlpha(rgba, coverageOf(stored), [1, 2, 3]);
    expect([...rgba]).toEqual([1, 2, 3, 255, 1, 2, 3, 0, 1, 2, 3, 64]);
  });

  test("invert swaps painted and kept", () => {
    expect([...invert(new Uint8Array([0, 255, 100]))]).toEqual([255, 0, 155]);
  });

  test("blank is nothing painted, eraser fringe included", () => {
    expect(isBlank(new Uint8Array(16))).toBe(true);
    expect(isBlank(new Uint8Array([0, 3, 7, 0]))).toBe(true);
    expect(isBlank(new Uint8Array([0, 0, 40, 0]))).toBe(false);
  });
});

describe("undo and redo", () => {
  test("each step comes back, and a new change forgets what was undone", () => {
    const history = new MaskHistory(4);
    const a = new Uint8Array([0, 0, 0, 0]);
    const b = new Uint8Array([255, 0, 0, 0]);
    const c = new Uint8Array([255, 255, 0, 0]);
    expect(history.canUndo).toBe(false);

    history.push(a); // a → b
    history.push(b); // b → c
    expect(history.undo(c)).toBe(b);
    expect(history.undo(b)).toBe(a);
    expect(history.undo(a)).toBeNull();
    expect(history.redo(a)).toBe(b);
    expect(history.canRedo).toBe(true);

    history.push(b); // a new stroke from b
    expect(history.canRedo).toBe(false);
  });

  test("depth follows the size of the picture", () => {
    expect(new MaskHistory(512 * 512).limit).toBe(50);
    expect(new MaskHistory(4096 * 4096).limit).toBe(16);
    // Never so shallow that undo is a single step.
    expect(new MaskHistory(16384 * 16384).limit).toBe(4);
    const history = new MaskHistory(16384 * 16384);
    for (let i = 0; i < 10; i++) history.push(new Uint8Array([i]));
    let steps = 0;
    while (history.undo(new Uint8Array(1))) steps++;
    expect(steps).toBe(4);
  });
});

describe("the brush", () => {
  test("starts at a twelfth of the short side, within a range for the picture", () => {
    expect(brushRange(1024, 768)).toEqual({ min: 2, max: 256, initial: 64 });
    expect(brushRange(32, 32)).toEqual({ min: 2, max: 16, initial: 4 });
  });

  test("steps evenly to the eye, at least a pixel, and stays in range", () => {
    const range = { min: 2, max: 100 };
    expect(stepBrush(40, 1, range)).toBe(50);
    expect(stepBrush(40, -1, range)).toBe(32);
    expect(stepBrush(2, 1, range)).toBe(3);
    expect(stepBrush(3, -1, range)).toBe(2);
    expect(stepBrush(2, -1, range)).toBe(2);
    expect(stepBrush(90, 1, range)).toBe(100);
  });

  test("a pointer lands in the picture's own pixels, however it is shown", () => {
    // A 2048×1024 picture shown at 512×256, offset by the toolbar.
    expect(
      toImage(
        { x: 140, y: 112 },
        { left: 12, top: 48, width: 512, height: 256 },
        {
          width: 2048,
          height: 1024,
        },
      ),
    ).toEqual({ x: 512, y: 256 });
  });
});

test("a stored input is addressed by its own name (§9)", () => {
  const name = `${"c".repeat(64)}.png`;
  expect(inputUrl(name)).toBe(`/api/media/inputs/cc/${name}`);
});
