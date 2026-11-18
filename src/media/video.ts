import { ffmpegAvailable } from "./audio.ts";

/**
 * What an attached video is, by way of ffprobe: its frame size and how long it
 * runs. Neither is in the first bytes of an MP4 or a WebM in any form worth
 * parsing by hand — the size lives in a track header that can sit anywhere in
 * the file — so the input store asks once the file is on disk, as it does for
 * an audio clip's duration (`media/audio.ts`).
 *
 * Best-effort like everything ffmpeg answers here: a machine without it
 * records a video with no size and no duration, and the video still runs.
 */
export interface VideoFacts {
  width: number | null;
  height: number | null;
  duration_ms: number | null;
}

const NOTHING: VideoFacts = { width: null, height: null, duration_ms: null };

export async function readVideo(path: string): Promise<VideoFacts> {
  if (!await ffmpegAvailable()) return NOTHING;
  let stdout: string;
  try {
    const result = await new Deno.Command("ffprobe", {
      args: [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:format=duration",
        "-of",
        "json",
        path,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!result.success) return NOTHING;
    stdout = new TextDecoder().decode(result.stdout);
  } catch {
    return NOTHING;
  }
  try {
    const parsed = JSON.parse(stdout) as {
      streams?: { width?: number; height?: number }[];
      format?: { duration?: string };
    };
    const stream = parsed.streams?.[0];
    const seconds = Number.parseFloat(parsed.format?.duration ?? "");
    return {
      width: positive(stream?.width),
      height: positive(stream?.height),
      duration_ms: Number.isFinite(seconds) && seconds > 0
        ? Math.round(seconds * 1000)
        : null,
    };
  } catch {
    return NOTHING;
  }
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}
