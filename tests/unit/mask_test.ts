import { assertEquals, assertThrows } from "@std/assert";
import { coverage, drawMask, parseMaskRequest } from "../../src/inputs/mask.ts";
import { InputError } from "../../src/inputs/store.ts";

const IMAGE = "a".repeat(64) + ".png";

/** The mask as rows of `#` (white) and `.` (black), to read at a glance. */
function picture(mask: Uint8Array, width: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < mask.length / width; y++) {
    rows.push(
      [...mask.subarray(y * width, (y + 1) * width)]
        .map((value) => (value === 255 ? "#" : value === 0 ? "." : "?"))
        .join(""),
    );
  }
  return rows;
}

Deno.test("a rect covers the pixels whose centres fall inside it", () => {
  const mask = drawMask(8, 4, [
    { shape: "rect", x: 0.25, y: 0.25, w: 0.5, h: 0.5, erase: false },
  ]);
  assertEquals(picture(mask, 8), [
    "........",
    "..####..",
    "..####..",
    "........",
  ]);
  assertEquals(coverage(mask), 0.25);
});

Deno.test("an ellipse fills its box's inscribed ellipse", () => {
  const mask = drawMask(8, 8, [
    { shape: "ellipse", x: 0, y: 0, w: 1, h: 1, erase: false },
  ]);
  assertEquals(picture(mask, 8), [
    "..####..",
    ".######.",
    "########",
    "########",
    "########",
    "########",
    ".######.",
    "..####..",
  ]);
});

Deno.test("a polygon fills its inside, and erase cuts a hole in what is there", () => {
  const mask = drawMask(8, 8, [
    {
      shape: "polygon",
      points: [[0, 0], [1, 0], [0, 1]],
      erase: false,
    },
    { shape: "rect", x: 0, y: 0, w: 0.25, h: 0.25, erase: true },
  ]);
  // Inside is a centre with u + v < 1, less the erased corner.
  assertEquals(picture(mask, 8), [
    "..#####.",
    "..####..",
    "#####...",
    "####....",
    "###.....",
    "##......",
    "#.......",
    "........",
  ]);
});

Deno.test("start_from is painted over, and invert comes last", () => {
  const start = new Uint8Array(4 * 2).fill(255);
  const mask = drawMask(4, 2, [
    { shape: "rect", x: 0, y: 0, w: 0.5, h: 1, erase: true },
  ], { start, invert: true });
  assertEquals(picture(mask, 4), ["##..", "##.."]);
  // The start is not written through.
  assertEquals(start[0], 255);
});

Deno.test("a request is checked as strictly as a job's params", () => {
  const ok = parseMaskRequest({
    image: IMAGE,
    shapes: [{ shape: "ellipse", x: 0.1, y: 0.2, w: 0.3, h: 0.4 }],
  });
  assertEquals(ok.image, "a".repeat(64));
  assertEquals(ok.shapes[0], {
    shape: "ellipse",
    x: 0.1,
    y: 0.2,
    w: 0.3,
    h: 0.4,
    erase: false,
  });

  const refused = (body: unknown, message: string) =>
    assertThrows(() => parseMaskRequest(body), InputError, message);
  refused(
    { image: IMAGE, shapes: [{ shape: "rect", x: 0, y: 0, w: 1.5, h: 1 }] },
    "shapes[0].w: 1.5 is out of range (above 0–1)",
  );
  refused(
    { image: IMAGE, shapes: [{ shape: "rect", x: 10, y: 20, w: 50, h: 50 }] },
    "shapes[0].x: 10 is out of range (0–1)",
  );
  refused(
    { image: IMAGE, shapes: [{ shape: "circle", x: 0, y: 0, r: 1 }] },
    "shapes[0].shape: expected rect, ellipse or polygon",
  );
  refused(
    { image: IMAGE, shapes: [{ shape: "rect", x: 0, y: 0, w: 1, h: 1, r: 2 }] },
    'shapes[0] has no "r"',
  );
  refused(
    { image: IMAGE, shapes: [{ shape: "polygon", points: [[0, 0], [1, 1]] }] },
    "at least three",
  );
  refused({ image: IMAGE, shapes: [] }, "repaints nothing");
  refused(
    { image: "photo.png", shapes: [{ shape: "rect", x: 0, y: 0, w: 1, h: 1 }] },
    "image: expected a stored input's value",
  );
  refused(
    { image: IMAGE, shapes: [], feather: 4 },
    'the body has no "feather"',
  );
});
