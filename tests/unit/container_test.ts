import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { DEFAULT_MODEL_KINDS } from "../../src/config/defaults.ts";

/**
 * The container's `--models-dir` flags are the only way a containerised run
 * learns where its models are: `/models` is a volume, and nothing scans it
 * unless the entrypoint says so.
 *
 * A kind left out of that list is invisible twice over — it never reaches the
 * model library, and it never reaches the `extra_model_paths.yaml` handed to
 * ComfyUI, so a loader offers an empty combo for files that are plainly on
 * the volume. `latent_upscale_models` was missing exactly that way, which is
 * what this test is here to stop.
 */
Deno.test("the Containerfile wires every model kind the app knows", async () => {
  const root = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
  const containerfile = await Deno.readTextFile(join(root, "Containerfile"));

  const wired = [
    ...containerfile.matchAll(/"--models-dir",\s*"([^="]+)=([^"]+)"/g),
  ]
    .map(([, kind, path]) => ({ kind, path }));

  assertEquals(
    wired.map((entry) => entry.kind).sort(),
    [...DEFAULT_MODEL_KINDS].sort(),
  );
  // And each one points at the subfolder of /models that the README promises,
  // rather than somewhere only this file knows about.
  for (const { kind, path } of wired) {
    assertEquals(path, `/models/${kind}`);
  }
});

Deno.test("the README lists the same folders the Containerfile mounts", async () => {
  const root = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
  const readme = await Deno.readTextFile(join(root, "README.md"));
  // The paragraph tells the reader what to put on the volume; a kind the app
  // wires but nobody documents is a folder that never gets filled.
  for (const kind of DEFAULT_MODEL_KINDS) {
    assertEquals(
      readme.includes(`\`${kind}\``),
      true,
      `README does not mention the ${kind} folder`,
    );
  }
});

/**
 * ffmpeg is the app's only external binary (DESIGN-AUDIO §2.2): it draws the
 * waveform an audio output is shown by and reads the duration of a clip. It
 * is one word in a long `apt-get` line, which is exactly the kind of thing a
 * rebase drops — and its absence is silent, because everything degrades to
 * "no waveform" rather than failing.
 */
Deno.test("the container installs ffmpeg, and the README says why", async () => {
  const root = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
  const containerfile = await Deno.readTextFile(join(root, "Containerfile"));
  const installed = /apt-get install[^\n]*(\n[^\n]*)*?\bffmpeg\b/.test(
    containerfile,
  );
  assertEquals(installed, true, "Containerfile does not install ffmpeg");

  const readme = await Deno.readTextFile(join(root, "README.md"));
  assertEquals(
    readme.includes("ffmpeg"),
    true,
    "README does not mention ffmpeg",
  );
});
