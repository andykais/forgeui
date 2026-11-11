import { ffmpegAvailable } from "../media/audio.ts";
import { decodePng, encodePng } from "../jobs/png.ts";
import { INPUT_FILENAME, InputError, type InputStore } from "./store.ts";

/**
 * Masks drawn rather than painted (§9): shapes in fractions of the picture,
 * rasterised at the picture's own size, and a mask tinted over its picture
 * for something that can only look. `forge mcp` is the customer — it has no
 * brush, and what it did instead (ImageMagick on its own disk) got the size,
 * the convention or the format wrong without a word.
 */

export type MaskShape =
  | {
    shape: "rect" | "ellipse";
    x: number;
    y: number;
    w: number;
    h: number;
    erase: boolean;
  }
  | { shape: "polygon"; points: [number, number][]; erase: boolean };

export interface MaskRequest {
  /** The stored image the mask is for, by sha256. */
  image: string;
  shapes: MaskShape[];
  /** A stored mask the shapes paint over, by sha256. */
  startFrom: string | null;
  invert: boolean;
}

/** The sha256 of a stored input, named by its value (`<sha256>.<ext>`). */
export function inputSha(value: unknown, what: string): string {
  if (typeof value === "string") {
    const match = INPUT_FILENAME.exec(value) ?? /^([0-9a-f]{64})$/.exec(value);
    if (match) return match[1]!;
  }
  throw new InputError(
    `${what}: expected a stored input's value, <sha256>.<ext>, got ` +
      `${JSON.stringify(value) ?? typeof value}`,
  );
}

function fraction(value: unknown, at: string, positive = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InputError(`${at}: expected a fraction from 0 to 1`);
  }
  if (value < 0 || value > 1 || (positive && value === 0)) {
    throw new InputError(
      `${at}: ${value} is out of range (${positive ? "above 0" : "0"}–1)`,
    );
  }
  return value;
}

function only(
  raw: Record<string, unknown>,
  keys: string[],
  at: string,
): void {
  const unknown = Object.keys(raw).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new InputError(
      `${at} has no ${unknown.map((key) => `"${key}"`).join(", ")}; it ` +
        `takes ${keys.join(", ")}`,
    );
  }
}

function parseShape(raw: unknown, at: string): MaskShape {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InputError(`${at}: expected an object`);
  }
  const shape = raw as Record<string, unknown>;
  if (shape.erase !== undefined && typeof shape.erase !== "boolean") {
    throw new InputError(`${at}.erase: expected true or false`);
  }
  const erase = shape.erase === true;
  if (shape.shape === "rect" || shape.shape === "ellipse") {
    only(shape, ["shape", "x", "y", "w", "h", "erase"], at);
    return {
      shape: shape.shape,
      x: fraction(shape.x, `${at}.x`),
      y: fraction(shape.y, `${at}.y`),
      w: fraction(shape.w, `${at}.w`, true),
      h: fraction(shape.h, `${at}.h`, true),
      erase,
    };
  }
  if (shape.shape === "polygon") {
    only(shape, ["shape", "points", "erase"], at);
    if (!Array.isArray(shape.points) || shape.points.length < 3) {
      throw new InputError(`${at}.points: expected at least three [x, y]`);
    }
    const points = shape.points.map((point, i): [number, number] => {
      if (!Array.isArray(point) || point.length !== 2) {
        throw new InputError(`${at}.points[${i}]: expected [x, y]`);
      }
      return [
        fraction(point[0], `${at}.points[${i}][0]`),
        fraction(point[1], `${at}.points[${i}][1]`),
      ];
    });
    return { shape: "polygon", points, erase };
  }
  throw new InputError(
    `${at}.shape: expected rect, ellipse or polygon, got ` +
      `${JSON.stringify(shape.shape) ?? "nothing"}`,
  );
}

/** `POST /api/inputs/mask`'s body, checked as strictly as a job's params. */
export function parseMaskRequest(body: unknown): MaskRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InputError("expected {image, shapes, start_from?, invert?}");
  }
  const raw = body as Record<string, unknown>;
  only(raw, ["image", "shapes", "start_from", "invert"], "the body");
  if (!Array.isArray(raw.shapes)) {
    throw new InputError("shapes: expected a list of shapes");
  }
  if (raw.invert !== undefined && typeof raw.invert !== "boolean") {
    throw new InputError("invert: expected true or false");
  }
  const shapes = raw.shapes.map((shape, i) =>
    parseShape(shape, `shapes[${i}]`)
  );
  const startFrom = raw.start_from === undefined || raw.start_from === null
    ? null
    : inputSha(raw.start_from, "start_from");
  if (shapes.length === 0 && startFrom === null && raw.invert !== true) {
    throw new InputError(
      "shapes: a mask with nothing on it repaints nothing; give at least " +
        "one shape",
    );
  }
  return {
    image: inputSha(raw.image, "image"),
    shapes,
    startFrom,
    invert: raw.invert === true,
  };
}

/** Even-odd: a ray to the right crosses the edges an odd number of times. */
function insidePolygon(u: number, v: number, points: [number, number][]) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]!;
    const [xj, yj] = points[j]!;
    if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Rasterise shapes onto a grey mask, in order, over `start` if given, then
 * invert. A pixel is in a shape when its centre is: hard edges, because the
 * inpaint workflows' grow and feather are where softness is chosen.
 */
export function drawMask(
  width: number,
  height: number,
  shapes: MaskShape[],
  options: { start?: Uint8Array; invert?: boolean } = {},
): Uint8Array {
  const mask = options.start ? new Uint8Array(options.start) : new Uint8Array(
    width * height,
  );
  for (const shape of shapes) {
    const value = shape.erase ? 0 : 255;
    if (shape.shape === "polygon") {
      const xs = shape.points.map(([x]) => x);
      const ys = shape.points.map(([, y]) => y);
      const x0 = Math.max(0, Math.floor(Math.min(...xs) * width));
      const x1 = Math.min(width, Math.ceil(Math.max(...xs) * width));
      const y0 = Math.max(0, Math.floor(Math.min(...ys) * height));
      const y1 = Math.min(height, Math.ceil(Math.max(...ys) * height));
      for (let py = y0; py < y1; py++) {
        const v = (py + 0.5) / height;
        for (let px = x0; px < x1; px++) {
          if (insidePolygon((px + 0.5) / width, v, shape.points)) {
            mask[py * width + px] = value;
          }
        }
      }
      continue;
    }
    const x0 = Math.max(0, Math.floor(shape.x * width));
    const x1 = Math.min(width, Math.ceil((shape.x + shape.w) * width));
    const y0 = Math.max(0, Math.floor(shape.y * height));
    const y1 = Math.min(height, Math.ceil((shape.y + shape.h) * height));
    const cx = shape.x + shape.w / 2, cy = shape.y + shape.h / 2;
    const rx = shape.w / 2, ry = shape.h / 2;
    for (let py = y0; py < y1; py++) {
      const v = (py + 0.5) / height;
      for (let px = x0; px < x1; px++) {
        const u = (px + 0.5) / width;
        const inside = shape.shape === "rect"
          ? u >= shape.x && u < shape.x + shape.w && v >= shape.y &&
            v < shape.y + shape.h
          : ((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2 <= 1;
        if (inside) mask[py * width + px] = value;
      }
    }
  }
  if (options.invert) {
    for (let i = 0; i < mask.length; i++) mask[i] = 255 - mask[i]!;
  }
  return mask;
}

/** The share of the picture a mask repaints, 0 to 1, to three places. */
export function coverage(mask: Uint8Array): number {
  let sum = 0;
  for (const value of mask) sum += value;
  return Number((sum / 255 / Math.max(mask.length, 1)).toFixed(3));
}

/** A stored mask's red channel (§9: what `LoadImageMask` reads). */
async function readMask(
  inputs: InputStore,
  sha: string,
): Promise<{ width: number; height: number; grey: Uint8Array }> {
  const stored = inputs.get(sha);
  if (!stored) throw new InputError(`no input "${sha}"`);
  const pixels = stored.ext === "png"
    ? await decodePng(await inputs.read(sha))
    : null;
  if (!pixels) {
    throw new InputError(
      `input "${sha}" is not a PNG this app can read as a mask`,
    );
  }
  const grey = new Uint8Array(pixels.width * pixels.height);
  for (let i = 0; i < grey.length; i++) grey[i] = pixels.rgba[i * 4]!;
  return { width: pixels.width, height: pixels.height, grey };
}

function imageSize(inputs: InputStore, sha: string, what: string) {
  const stored = inputs.get(sha);
  if (!stored) throw new InputError(`${what}: no input "${sha}"`);
  if (stored.kind !== "image" || !stored.width || !stored.height) {
    throw new InputError(`${what}: input "${sha}" is not a picture`);
  }
  return { width: stored.width, height: stored.height };
}

function sizeMismatch(mask: { width: number; height: number }, image: {
  width: number;
  height: number;
}): InputError {
  // The submit's own words (§9), so the two refusals read as one rule.
  return new InputError(
    `mask: painted on a ${mask.width}×${mask.height} picture, but image is ` +
      `${image.width}×${image.height}`,
  );
}

/** Draw the mask a request describes, as PNG bytes, with its coverage. */
export async function renderMask(
  inputs: InputStore,
  request: MaskRequest,
): Promise<{ png: Uint8Array; coverage: number }> {
  const { width, height } = imageSize(inputs, request.image, "image");
  let start: Uint8Array | undefined;
  if (request.startFrom !== null) {
    const existing = await readMask(inputs, request.startFrom);
    if (existing.width !== width || existing.height !== height) {
      throw sizeMismatch(existing, { width, height });
    }
    start = existing.grey;
  }
  const mask = drawMask(width, height, request.shapes, {
    start,
    invert: request.invert,
  });
  return {
    png: await encodePng(width, height, 1, mask),
    coverage: coverage(mask),
  };
}

/** A stored picture as 8-bit RGB: PNG here, anything else through ffmpeg. */
async function readRgb(
  inputs: InputStore,
  sha: string,
  size: { width: number; height: number },
): Promise<Uint8Array> {
  const stored = inputs.get(sha)!;
  if (stored.ext === "png") {
    const pixels = await decodePng(await inputs.read(sha));
    if (pixels) {
      const rgb = new Uint8Array(pixels.width * pixels.height * 3);
      for (let i = 0; i < pixels.width * pixels.height; i++) {
        rgb[i * 3] = pixels.rgba[i * 4]!;
        rgb[i * 3 + 1] = pixels.rgba[i * 4 + 1]!;
        rgb[i * 3 + 2] = pixels.rgba[i * 4 + 2]!;
      }
      return rgb;
    }
  }
  if (!await ffmpegAvailable()) {
    throw new InputError(
      `showing a mask over a ${stored.ext} picture needs ffmpeg, and this ` +
        `machine has none`,
    );
  }
  const { code, stdout } = await new Deno.Command("ffmpeg", {
    args: [
      "-nostdin",
      "-v",
      "error",
      "-i",
      inputs.absolute(stored.path),
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).output();
  if (code !== 0 || stdout.length !== size.width * size.height * 3) {
    throw new InputError(`could not decode input "${sha}"`);
  }
  return stdout;
}

/** The tint (§9): red, at half strength where the mask is white. */
const TINT = [255, 32, 64] as const;

/**
 * The mask tinted over its picture, fitted inside `maxEdge` and never
 * enlarged, as a PNG. Each preview pixel averages the box of source pixels
 * it stands for, so a thin stroke fades rather than vanishing.
 */
export async function renderOverlay(
  inputs: InputStore,
  maskSha: string,
  imageSha: string,
  maxEdge: number,
): Promise<Uint8Array> {
  const size = imageSize(inputs, imageSha, "on");
  const mask = await readMask(inputs, maskSha);
  if (mask.width !== size.width || mask.height !== size.height) {
    throw sizeMismatch(mask, size);
  }
  const rgb = await readRgb(inputs, imageSha, size);
  const { width, height } = size;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const ow = Math.max(1, Math.round(width * scale));
  const oh = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(ow * oh * 3);
  for (let oy = 0; oy < oh; oy++) {
    const y0 = Math.floor((oy * height) / oh);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * height) / oh));
    for (let ox = 0; ox < ow; ox++) {
      const x0 = Math.floor((ox * width) / ow);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * width) / ow));
      let r = 0, g = 0, b = 0, m = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * width + x;
          r += rgb[i * 3]!;
          g += rgb[i * 3 + 1]!;
          b += rgb[i * 3 + 2]!;
          m += mask.grey[i]!;
          n++;
        }
      }
      const alpha = (m / n / 255) * 0.5;
      const o = (oy * ow + ox) * 3;
      out[o] = Math.round((r / n) * (1 - alpha) + TINT[0] * alpha);
      out[o + 1] = Math.round((g / n) * (1 - alpha) + TINT[1] * alpha);
      out[o + 2] = Math.round((b / n) * (1 - alpha) + TINT[2] * alpha);
    }
  }
  return await encodePng(ow, oh, 3, out);
}
