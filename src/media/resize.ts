import { ffmpegAvailable } from "./audio.ts";

/**
 * A smaller copy of an output, for something that only has to *look* at it
 * (DESIGN-AGENT-LOOP §6.3).
 *
 * The bridge's `get_output_preview` is the customer: vision tokens land in
 * the same VRAM budget as the model, and a 1024² picture costs several times
 * a 768px one for no critique value. `thumb_url` is no substitute — tiles are
 * square crops, and cropping away the composition is exactly wrong for a
 * model being asked about composition. So this fits the whole frame inside
 * `max_edge` and never enlarges it.
 *
 * Nothing is cached. A preview is asked for once, by a model that then moves
 * on; a cache would be a directory to sweep for the sake of a second request
 * that does not come.
 */

export class ResizeUnavailableError extends Error {
  override readonly name = "ResizeUnavailableError";
}

export class ResizeError extends Error {
  override readonly name = "ResizeError";
}

/** The bounds `?max_edge=` accepts: a thumbnail's worth up to a 4K edge. */
export const MIN_EDGE = 64;
export const MAX_EDGE = 4096;

export interface Resized {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
}

/**
 * Fit inside `maxEdge` on the longer side, keeping the aspect, never growing.
 *
 * `min(iw, N)` × `min(ih, N)` is the box and `decrease` fits into it, so a
 * frame already smaller than the box comes out the size it went in.
 */
function scaleFilter(maxEdge: number, even: boolean): string {
  return `scale=w='min(iw,${maxEdge})':h='min(ih,${maxEdge})'` +
    `:force_original_aspect_ratio=decrease` +
    // H.264 in 4:2:0 wants even dimensions; a picture does not care.
    (even ? ":force_divisible_by=2" : "");
}

/**
 * Pictures as JPEG, video as small H.264 with its sound.
 *
 * JPEG rather than the PNG that came in, because the point is bytes, and
 * because it is the format every vision runtime reads: llama.cpp's loader
 * has no WebP. Video is re-encoded at a quality meant for judging motion and
 * framing, not for keeping, with `faststart` so it plays while it arrives.
 */
function ffmpegArgs(
  source: string,
  destination: string,
  maxEdge: number,
  kind: "image" | "video",
): string[] {
  const common = ["-nostdin", "-v", "error", "-y", "-i", source];
  if (kind === "image") {
    return [
      ...common,
      "-vf",
      // Flattened onto black first: a JPEG has no alpha, and without this a
      // transparent PNG's hidden pixels come through as whatever they were.
      `${scaleFilter(maxEdge, false)},format=rgb24`,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      destination,
    ];
  }
  return [
    ...common,
    "-vf",
    scaleFilter(maxEdge, true),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-movflags",
    "+faststart",
    destination,
  ];
}

export async function resizeMedia(
  source: string,
  kind: "image" | "video",
  maxEdge: number,
): Promise<Resized> {
  if (!await ffmpegAvailable()) {
    throw new ResizeUnavailableError(
      "max_edge needs ffmpeg, and this machine has none",
    );
  }
  const suffix = kind === "image" ? ".jpg" : ".mp4";
  const destination = await Deno.makeTempFile({
    prefix: "forgeui-preview-",
    suffix,
  });
  try {
    const { code, stderr } = await new Deno.Command("ffmpeg", {
      args: ffmpegArgs(source, destination, maxEdge, kind),
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).output();
    if (code !== 0) {
      const reason = new TextDecoder().decode(stderr).trim().split("\n").at(-1);
      throw new ResizeError(
        `could not resize ${kind}: ${reason || `ffmpeg exited ${code}`}`,
      );
    }
    return {
      bytes: await Deno.readFile(destination),
      contentType: kind === "image" ? "image/jpeg" : "video/mp4",
    };
  } finally {
    await Deno.remove(destination).catch(() => {});
  }
}
