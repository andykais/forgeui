import { assertEquals, assertThrows } from "@std/assert";
import { ImageProbeError, probeImage } from "../../src/inputs/probe.ts";

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
