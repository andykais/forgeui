/**
 * What an uploaded file actually is (§9).
 *
 * The browser's `Content-Type` and the name a file was dropped under are both
 * hearsay — a `.png` that is really a JPEG breaks ComfyUI at load time, well
 * after the point where anything can be said about it. The first bytes of the
 * file are not hearsay, so the extension the store writes and the dimensions
 * it records both come from there.
 *
 * Audio is recognised the same way and measured differently: a container
 * header says what a file is, but how long it runs is `ffprobe`'s answer, and
 * that needs a path rather than a prefix (DESIGN-AUDIO §4.3).
 */

export class ImageProbeError extends Error {
  override readonly name = "ImageProbeError";
}

export interface ProbedImage {
  /** Without the dot, and always lower case: what the stored file is named. */
  ext: string;
  contentType: string;
  width: number;
  height: number;
}

/** A file the store will take: a picture with a size, or sound without one. */
export interface ProbedMedia {
  ext: string;
  contentType: string;
  kind: "image" | "audio";
  /** Null for audio, which has no dimensions to record. */
  width: number | null;
  height: number | null;
}

function u16(bytes: Uint8Array, at: number, littleEndian = false): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint16(at, littleEndian);
}

function u32(bytes: Uint8Array, at: number, littleEndian = false): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(at, littleEndian);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, i) => bytes[i] === byte);
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * JPEG is a stream of segments rather than a header, so the size lives in
 * whichever `SOFn` marker the encoder used — and the ones that are not `SOFn`
 * have to be walked past to find it.
 */
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = bytes[at + 1]!;
    // Padding and the standalone markers carry no length to skip by.
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (
      marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)
    ) {
      at += 2;
      continue;
    }
    const length = u16(bytes, at + 2);
    // SOF0..SOF15, less the four that are not frame headers at all.
    const isFrame = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > bytes.length) break;
      return { height: u16(bytes, at + 5), width: u16(bytes, at + 7) };
    }
    if (length < 2) break;
    at += 2 + length;
  }
  throw new ImageProbeError(
    "this JPEG has no frame header to read a size from",
  );
}

/** WebP comes in three shapes, and the size sits in a different place in each. */
function webpSize(bytes: Uint8Array): { width: number; height: number } {
  const fourcc = new TextDecoder().decode(bytes.subarray(12, 16));
  if (fourcc === "VP8 ") {
    return {
      width: u16(bytes, 26, true) & 0x3fff,
      height: u16(bytes, 28, true) & 0x3fff,
    };
  }
  if (fourcc === "VP8L") {
    const bits = u32(bytes, 21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === "VP8X") {
    const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
    const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
    return { width, height };
  }
  throw new ImageProbeError(`unrecognised WebP chunk "${fourcc}"`);
}

/**
 * The audio containers ComfyUI's `LoadAudio` will take.
 *
 * Only the magic is read here. Duration comes from ffprobe once the bytes are
 * on disk, because for MP3 the honest alternatives are trusting a VBR header
 * or counting every frame, and ffmpeg is already a dependency (§2.2).
 */
function probeAudio(bytes: Uint8Array): ProbedMedia | null {
  const text = (at: number, length: number) =>
    new TextDecoder().decode(bytes.subarray(at, at + length));
  const audio = (ext: string, contentType: string): ProbedMedia => ({
    ext,
    contentType,
    kind: "audio",
    width: null,
    height: null,
  });

  if (text(0, 4) === "RIFF" && text(8, 4) === "WAVE") {
    return audio("wav", "audio/wav");
  }
  if (text(0, 4) === "fLaC") return audio("flac", "audio/flac");
  // Ogg carries several codecs; Opus and Vorbis both name themselves in the
  // first page, and anything else in an Ogg is still an Ogg to `LoadAudio`.
  if (text(0, 4) === "OggS") {
    return text(28, 8) === "OpusHead"
      ? audio("opus", "audio/ogg")
      : audio("ogg", "audio/ogg");
  }
  // MP3 is either an ID3 tag or a bare frame sync (11 set bits).
  if (text(0, 3) === "ID3") return audio("mp3", "audio/mpeg");
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    return audio("mp3", "audio/mpeg");
  }
  // ISO-BMFF: `....ftyp` at offset 4, which is what an m4a/aac file is.
  if (text(4, 4) === "ftyp") return audio("m4a", "audio/mp4");
  return null;
}

/** The formats ComfyUI's `LoadImage` will take, and nothing else. */
export function probeImage(bytes: Uint8Array): ProbedImage {
  if (bytes.length < 16) {
    throw new ImageProbeError("this file is too short to be an image");
  }
  if (startsWith(bytes, PNG_MAGIC)) {
    // IHDR is always the first chunk, at a fixed offset after the magic.
    return {
      ext: "png",
      contentType: "image/png",
      width: u32(bytes, 16),
      height: u32(bytes, 20),
    };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { ext: "jpg", contentType: "image/jpeg", ...jpegSize(bytes) };
  }
  const riff = new TextDecoder().decode(bytes.subarray(0, 4));
  const webp = new TextDecoder().decode(bytes.subarray(8, 12));
  if (riff === "RIFF" && webp === "WEBP") {
    return { ext: "webp", contentType: "image/webp", ...webpSize(bytes) };
  }
  throw new ImageProbeError(
    "only PNG, JPEG and WebP can be used as an input image",
  );
}

/**
 * What the store takes: a picture or a sound, decided by the bytes.
 *
 * Images are tried first because they are the common case and their magic is
 * unambiguous; the error when neither matches names both, since "only PNG,
 * JPEG and WebP" is a confusing thing to be told about a `.wav`.
 */
export function probeMedia(bytes: Uint8Array): ProbedMedia {
  if (bytes.length < 16) {
    throw new ImageProbeError("this file is too short to be media");
  }
  const audio = probeAudio(bytes);
  if (audio) return audio;
  try {
    const image = probeImage(bytes);
    return { ...image, kind: "image" };
  } catch {
    throw new ImageProbeError(
      "an input must be a PNG, JPEG or WebP image, " +
        "or a WAV, FLAC, MP3, Opus, Ogg or M4A sound",
    );
  }
}
