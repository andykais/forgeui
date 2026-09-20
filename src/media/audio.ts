import { extname } from "@std/path";

/**
 * The audio side of a media file, by way of ffmpeg (DESIGN-AUDIO §2.2).
 *
 * ffmpeg is the one external binary this app shells out to, and it earns that
 * by answering two questions nothing else here can: how long is this clip, and
 * what does it look like. A grid is built on pictures and sound has none, so
 * every audio file gets a waveform drawn beside it — a picture of the thing,
 * filed like a thumbnail and served like one.
 *
 * Every call here is best-effort. A machine without ffmpeg loses waveforms and
 * durations; it does not lose generations.
 */

/** Appended to the media path: `01J….flac` → `01J….flac.waveform.png`. */
export const WAVEFORM_SUFFIX = ".waveform.png";

/**
 * What a take with no tone is drawn in: one grey, on transparency, for both
 * themes. It has to read on the dark plate a tile sits on and on the lighter
 * one the viewer uses, and a single mid-tone does that where an accent would
 * fight one of them.
 *
 * A take that does have a tone is drawn in that tone's colour instead
 * (`media/tone.ts`), which is what makes a grid of speech group by voice.
 */
const WAVEFORM_COLOUR = "0x8a8a8aff";
/**
 * 3:2, which is two thirds of a square tile once it is drawn edge to edge.
 *
 * This started as a 6:1 strip and went to 2.5:1, and both were the same
 * mistake at different sizes: a wide picture letterboxed into a square cell
 * is a band across the middle of it, and a fifth of the tile is not enough
 * room to tell a shape from a smudge. The tile anchors it to the bottom
 * rather than centring it, so the height the drawing gains is height the
 * take actually fills.
 */
const WAVEFORM_SIZE = "1000x660";
/**
 * The most a quiet take is lifted by. A generated line often peaks around
 * -30 dBFS, and drawn as-is it is a flat line in a large empty box; scaled so
 * its loudest moment reaches the top, it is a shape. The cap is what stops a
 * near-silent file from being drawn as a wall of noise.
 */
const MAX_WAVEFORM_GAIN_DB = 40;

export function waveformPathFor(mediaPath: string): string {
  return `${mediaPath}${WAVEFORM_SUFFIX}`;
}

/** True for the extensions ComfyUI's save-audio nodes write, plus uploads. */
const AUDIO_EXTENSIONS = new Set([
  ".flac",
  ".mp3",
  ".opus",
  ".wav",
  ".ogg",
  ".m4a",
]);

export function isAudioFile(path: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(path).toLowerCase());
}

async function run(
  command: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { code, stdout, stderr } = await new Deno.Command(command, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      ok: code === 0,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  } catch (error) {
    // NotFound is "no ffmpeg on this machine", which is a state, not a fault.
    if (error instanceof Deno.errors.NotFound) {
      return { ok: false, stdout: "", stderr: "not installed" };
    }
    throw error;
  }
}

/**
 * Whether ffmpeg is on this machine, asked once.
 *
 * The container installs it (§6). A developer running the app from a checkout
 * may not have it, and the answer decides whether to bother trying rather than
 * whether to proceed: everything here degrades to "no waveform".
 */
let available: Promise<boolean> | null = null;

export function ffmpegAvailable(): Promise<boolean> {
  available ??= run("ffmpeg", ["-version"]).then((result) => result.ok);
  return available;
}

/** For tests, which need to ask again after changing what is installed. */
export function forgetFfmpeg(): void {
  available = null;
}

/**
 * How long a clip runs, in milliseconds, read from the container rather than
 * guessed from its size. Null when ffprobe cannot say — a partial file, a
 * format it does not know, or no ffmpeg at all.
 */
export async function probeDuration(path: string): Promise<number | null> {
  const { ok, stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  if (!ok) return null;
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

/**
 * How much to lift this file by so its loudest moment fills the picture.
 *
 * One constant for the whole clip, from `volumedetect`'s peak — not
 * `dynaudnorm` or a `sqrt` axis, both of which flatter the quiet parts and
 * turn a considered pause into something that looks like speech. The shape
 * stays the shape; only the scale changes.
 *
 * Best-effort like everything else here: a file ffmpeg cannot measure is
 * drawn unscaled rather than not drawn.
 */
async function peakGainDb(path: string): Promise<number> {
  const { ok, stderr } = await run("ffmpeg", [
    "-nostdin",
    "-v",
    "info",
    "-i",
    path,
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  if (!ok) return 0;
  const peak = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  if (!peak) return 0;
  const headroom = -Number.parseFloat(peak[1]!);
  if (!Number.isFinite(headroom) || headroom <= 0) return 0;
  return Math.min(headroom, MAX_WAVEFORM_GAIN_DB);
}

/**
 * Draw `path`'s waveform to `<path>.waveform.png`, and say whether there is
 * now a file there.
 *
 * Mono, because two channels stacked in a tile is a smear rather than a
 * shape, and one waveform is what a person means by "the waveform".
 */
export async function drawWaveform(
  path: string,
  colour?: string | null,
): Promise<string | null> {
  const destination = waveformPathFor(path);
  const gain = await peakGainDb(path);
  const { ok } = await run("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    path,
    "-filter_complex",
    `aformat=channel_layouts=mono,volume=${gain}dB,` +
    `showwavespic=s=${WAVEFORM_SIZE}:colors=${colour ?? WAVEFORM_COLOUR}`,
    "-frames:v",
    "1",
    destination,
  ]);
  if (!ok) {
    // ffmpeg writes the output file before it fails on some inputs; a
    // half-written PNG is worse than none, so it does not get to stay.
    await Deno.remove(destination).catch(() => {});
    return null;
  }
  return destination;
}

export interface AudioFacts {
  duration_ms: number | null;
  /** The waveform's path, or null when one could not be drawn. */
  waveform: string | null;
}

/**
 * Both answers for one file, in one place: what completion needs after moving
 * an audio output, and what the input store needs after writing an upload.
 *
 * `colour` is `media/tone.ts`'s answer for whatever the take was asked to
 * sound like (§11.5). An upload has no tone — nobody described it, it was
 * recorded — so it keeps the grey.
 */
export async function readAudio(
  path: string,
  colour?: string | null,
): Promise<AudioFacts> {
  if (!await ffmpegAvailable()) return { duration_ms: null, waveform: null };
  const [duration_ms, waveform] = await Promise.all([
    probeDuration(path),
    drawWaveform(path, colour),
  ]);
  return { duration_ms, waveform };
}
