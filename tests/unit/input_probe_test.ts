import { assertEquals, assertThrows } from "@std/assert";
import {
  ImageProbeError,
  probeImage,
  probeMedia,
} from "../../src/inputs/probe.ts";
import { tinyWav } from "../fixtures/wav.ts";

/**
 * What the store writes an upload as, and how big it says the picture is
 * (§9). Both come from the bytes: a `.png` that is really a JPEG would
 * otherwise break at ComfyUI's load step, long past where anything useful
 * can be said about it.
 */

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** SOI, one segment to walk past, then the frame header holding the size. */
function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8]); // SOI
  bytes.set([0xff, 0xe0], 2); // APP0
  view.setUint16(4, 6); // its length, which has to be skipped
  bytes.set([0xff, 0xc0], 10); // SOF0
  view.setUint16(12, 11);
  bytes[14] = 8; // precision
  view.setUint16(15, height);
  view.setUint16(17, width);
  return bytes;
}

function webpLossy(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  const text = new TextEncoder();
  bytes.set(text.encode("RIFF"));
  bytes.set(text.encode("WEBP"), 8);
  bytes.set(text.encode("VP8 "), 12);
  const view = new DataView(bytes.buffer);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytes;
}

Deno.test("the extension and the size come from the bytes, not the name", () => {
  assertEquals(probeImage(png(1024, 768)), {
    ext: "png",
    contentType: "image/png",
    width: 1024,
    height: 768,
  });
  assertEquals(probeImage(jpeg(640, 480)), {
    ext: "jpg",
    contentType: "image/jpeg",
    width: 640,
    height: 480,
  });
  assertEquals(probeImage(webpLossy(300, 200)), {
    ext: "webp",
    contentType: "image/webp",
    width: 300,
    height: 200,
  });
});

Deno.test("anything else is refused where it can still be explained", () => {
  const text = new TextEncoder().encode("this is not an image at all, truly");
  assertThrows(() => probeImage(text), ImageProbeError, "PNG, JPEG and WebP");
  assertThrows(
    () => probeImage(new Uint8Array(4)),
    ImageProbeError,
    "too short",
  );
});

Deno.test("a JPEG with no frame header says so rather than guessing", () => {
  const truncated = new Uint8Array(24);
  truncated.set([0xff, 0xd8]);
  assertThrows(() => probeImage(truncated), ImageProbeError, "frame header");
});

/**
 * Sound goes through the same door (DESIGN-AUDIO §4.3): the magic decides the
 * extension, and the dimensions a picture would have are simply absent.
 */
Deno.test("audio is recognised by its container, and has no dimensions", () => {
  const wav = probeMedia(tinyWav({ seconds: 1 }));
  assertEquals(wav.kind, "audio");
  assertEquals(wav.ext, "wav");
  assertEquals(wav.contentType, "audio/wav");
  assertEquals(wav.width, null);
  assertEquals(wav.height, null);

  const header = (text: string, pad = 32) => {
    const bytes = new Uint8Array(pad);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  };
  assertEquals(probeMedia(header("fLaC")).ext, "flac");
  assertEquals(probeMedia(header("ID3")).ext, "mp3");

  // Ogg names its codec in the first page; Opus gets its own extension so
  // the file is called what it is.
  const ogg = header("OggS", 40);
  assertEquals(probeMedia(ogg).ext, "ogg");
  const opus = header("OggS", 40);
  for (const [i, ch] of [..."OpusHead"].entries()) {
    opus[28 + i] = ch.charCodeAt(0);
  }
  assertEquals(probeMedia(opus).ext, "opus");

  // A bare MPEG frame sync, which is an MP3 with no ID3 tag on the front.
  const bare = new Uint8Array(32);
  bare[0] = 0xff;
  bare[1] = 0xfb;
  assertEquals(probeMedia(bare).ext, "mp3");
});

Deno.test("a picture still comes back as a picture, with its size", () => {
  const image = probeMedia(png(640, 360));
  assertEquals(image.kind, "image");
  assertEquals(image.ext, "png");
  assertEquals([image.width, image.height], [640, 360]);
});

Deno.test("anything that is neither says so, naming both", () => {
  const junk = new Uint8Array(32).fill(0x7a);
  assertThrows(
    () => probeMedia(junk),
    ImageProbeError,
    "PNG, JPEG or WebP image",
  );
  assertThrows(() => probeMedia(junk), ImageProbeError, "WAV, FLAC, MP3");
});
