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
 * One grey, on transparency, for both themes. The waveform is a shape rather
 * than a colour — it has to read on the dark plate a tile sits on and on the
 * lighter one the viewer uses, and a single mid-tone does that where an accent
 * would fight one of them.
 */
const WAVEFORM_COLOUR = "0x8a8a8aff";
const WAVEFORM_SIZE = "960x160";

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
 * Draw `path`'s waveform to `<path>.waveform.png`, and say whether there is
 * now a file there.
 *
 * Mono, because two channels stacked in a 40px tile is a smear rather than a
 * shape, and one waveform is what a person means by "the waveform".
 */
export async function drawWaveform(path: string): Promise<string | null> {
  const destination = waveformPathFor(path);
  const { ok } = await run("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    path,
    "-filter_complex",
    `aformat=channel_layouts=mono,showwavespic=s=${WAVEFORM_SIZE}:colors=${WAVEFORM_COLOUR}`,
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
 */
export async function readAudio(path: string): Promise<AudioFacts> {
  if (!await ffmpegAvailable()) return { duration_ms: null, waveform: null };
  const [duration_ms, waveform] = await Promise.all([
    probeDuration(path),
    drawWaveform(path),
  ]);
  return { duration_ms, waveform };
}
