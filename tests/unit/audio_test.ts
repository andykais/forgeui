import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  ffmpegAvailable,
  isAudioFile,
  readAudio,
  waveformPathFor,
} from "../../src/media/audio.ts";
import { toneColour, waveformColour } from "../../src/media/tone.ts";

/**
 * The audio side of a media file (DESIGN-AUDIO §2.2). ffmpeg is what answers
 * both questions, so the tests that need it say so and skip where it is not
 * installed — the app behaves the same way, and a developer without ffmpeg
 * should not get a red suite for it.
 */

const haveFfmpeg = await ffmpegAvailable();

/** A tone, a gap, a tone: something with a shape rather than a flat line. */
async function writeTone(path: string, volume = 1): Promise<void> {
  const { code, stderr } = await new Deno.Command("ffmpeg", {
    args: [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=mono:d=0.5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=1.5",
      "-filter_complex",
      `[0:a][1:a][2:a]concat=n=3:v=0:a=1,volume=${volume}`,
      path,
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
}

Deno.test("an audio file is recognised by its extension", () => {
  for (const name of ["take.flac", "take.mp3", "TAKE.OPUS", "a/b/take.wav"]) {
    assertEquals(isAudioFile(name), true, name);
  }
  for (const name of ["frame.png", "clip.mp4", "model.safetensors", "take"]) {
    assertEquals(isAudioFile(name), false, name);
  }
});

Deno.test("the waveform sits beside the media, named after it", () => {
  assertEquals(
    waveformPathFor("/data/outputs/2026/09/17/01J-0.flac"),
    "/data/outputs/2026/09/17/01J-0.flac.waveform.png",
  );
});

Deno.test({
  name: "ffmpeg reads the duration and draws the waveform",
  ignore: !haveFfmpeg,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      const take = join(dir, "take.wav");
      await writeTone(take);

      const facts = await readAudio(take);
      // Three seconds of tone, gap and tone, to the millisecond ffprobe gives.
      assertEquals(facts.duration_ms, 3000);
      assertEquals(facts.waveform, waveformPathFor(take));

      const drawn = await Deno.stat(waveformPathFor(take));
      assert(drawn.isFile);
      assert(drawn.size > 0, "the waveform is an empty file");
      // A PNG, because the tile and the viewer are an `<img>` and nothing more.
      const header = (await Deno.readFile(waveformPathFor(take))).subarray(
        0,
        8,
      );
      assertEquals([...header], [
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "a file ffmpeg cannot read costs nothing and leaves nothing behind",
  ignore: !haveFfmpeg,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      // The extension says audio and the bytes disagree, which is what a
      // truncated download or a mislabelled upload looks like.
      const broken = join(dir, "broken.flac");
      await Deno.writeTextFile(broken, "not a flac at all");

      assertEquals(await readAudio(broken), {
        duration_ms: null,
        waveform: null,
      });
      // No half-written PNG left where a waveform would go.
      await assertMissing(waveformPathFor(broken));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

async function assertMissing(path: string): Promise<void> {
  try {
    await Deno.stat(path);
    throw new Error(`${path} exists and should not`);
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound, `${path} exists`);
  }
}

/**
 * A quiet take is lifted so its loudest moment fills the picture (§2.2).
 *
 * A generated line often peaks around -30 dBFS. Drawn as the samples are, it
 * is a thread across an empty box — the complaint that started this. Scaled
 * by one constant the shape is legible, and because it *is* one constant, a
 * pause still looks like a pause.
 */
Deno.test({
  name: "a quiet clip is drawn as large as a loud one",
  ignore: !haveFfmpeg,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      const quiet = join(dir, "quiet.wav");
      const loud = join(dir, "loud.wav");
      await writeTone(quiet, 0.02);
      await writeTone(loud, 1.0);

      await readAudio(quiet);
      await readAudio(loud);
      const drawn = [
        await inkRows(waveformPathFor(quiet)),
        await inkRows(waveformPathFor(loud)),
      ];
      // Within a row of each other: the same tone at 2% and at 100% draws
      // the same picture, which is the whole point of the gain.
      assert(
        Math.abs(drawn[0]! - drawn[1]!) <= 1,
        `quiet drew ${drawn[0]} rows, loud drew ${drawn[1]}`,
      );
      // And it is a tall picture rather than the 6:1 strip it was: a tile is
      // square, and a strip that wide letterboxes to a thread.
      const [width, height] = await pngSize(waveformPathFor(loud));
      assert(width / height <= 3, `waveform is ${width}x${height}`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "a take with a tone is drawn in that tone's colour",
  ignore: !haveFfmpeg,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      const plain = join(dir, "plain.wav");
      const toned = join(dir, "toned.wav");
      await writeTone(plain);
      await writeTone(toned);

      await readAudio(plain);
      await readAudio(toned, waveformColour("an older man, unhurried"));

      // Untold, it is still the one grey both themes were chosen for.
      const grey = await inkColour(waveformPathFor(plain));
      assertEquals(grey[0], grey[1]);
      assertEquals(grey[1], grey[2]);

      // Told, it is the hue the tile will draw its tone line in — the same
      // mapping, so the caption and the shape under it always agree (§11.5).
      const [r, g, b] = await inkColour(waveformPathFor(toned));
      const wanted = toneColour("an older man, unhurried")!;
      const expected = [1, 3, 5].map((at) =>
        Number.parseInt(wanted.slice(at, at + 2), 16)
      );
      for (const [i, channel] of [r, g, b].entries()) {
        assert(
          Math.abs(channel - expected[i]!) <= 4,
          `channel ${i}: drew ${channel}, asked for ${expected[i]}`,
        );
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

/**
 * The brightest pixel in the drawn PNG, as `[r, g, b]`. The waveform is drawn
 * on transparency and `rgb24` composites that onto black, so the ink is the
 * one thing in the picture that is not black.
 */
async function inkColour(path: string): Promise<[number, number, number]> {
  const { code, stdout } = await new Deno.Command("ffmpeg", {
    args: [
      "-nostdin",
      "-v",
      "error",
      "-i",
      path,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    stdout: "piped",
    stderr: "null",
  }).output();
  assertEquals(code, 0, `could not read ${path}`);
  let brightest: [number, number, number] = [0, 0, 0];
  let best = -1;
  for (let at = 0; at + 2 < stdout.length; at += 3) {
    const pixel: [number, number, number] = [
      stdout[at]!,
      stdout[at + 1]!,
      stdout[at + 2]!,
    ];
    const sum = pixel[0] + pixel[1] + pixel[2];
    if (sum > best) {
      best = sum;
      brightest = pixel;
    }
  }
  return brightest;
}

/** The PNG header's width and height, which is all IHDR is needed for here. */
async function pngSize(path: string): Promise<[number, number]> {
  const bytes = await Deno.readFile(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return [view.getUint32(16), view.getUint32(20)];
}

/**
 * How many rows of the drawn PNG have ink in them — a stand-in for "how big
 * is the waveform", read out of the file rather than guessed.
 */
async function inkRows(path: string): Promise<number> {
  const { code, stdout } = await new Deno.Command("ffmpeg", {
    args: [
      "-nostdin",
      "-v",
      "error",
      "-i",
      path,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    stdout: "piped",
    stderr: "null",
  }).output();
  assertEquals(code, 0, `could not read ${path}`);
  const [width, height] = await pngSize(path);
  let rows = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // The waveform is drawn mid-grey on white, so anything darker is ink.
      if (stdout[y * width + x]! < 200) {
        rows++;
        break;
      }
    }
  }
  return rows;
}
