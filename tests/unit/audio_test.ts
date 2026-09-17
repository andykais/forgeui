import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  ffmpegAvailable,
  isAudioFile,
  readAudio,
  waveformPathFor,
} from "../../src/media/audio.ts";

/**
 * The audio side of a media file (DESIGN-AUDIO §2.2). ffmpeg is what answers
 * both questions, so the tests that need it say so and skip where it is not
 * installed — the app behaves the same way, and a developer without ffmpeg
 * should not get a red suite for it.
 */

const haveFfmpeg = await ffmpegAvailable();

/** A tone, a gap, a tone: something with a shape rather than a flat line. */
async function writeTone(path: string): Promise<void> {
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
      "[0:a][1:a][2:a]concat=n=3:v=0:a=1",
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
