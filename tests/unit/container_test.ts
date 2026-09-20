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

/**
 * The speech workflows are the first thing in this repo that stock ComfyUI
 * cannot run (DESIGN-AUDIO §4.6, §6). Three things have to hold together, and
 * each fails quietly on its own: the pack has to be pinned to a commit rather
 * than a branch, its dependencies have to go into ComfyUI's venv rather than
 * the system python, and the weights have to land on the /models mount rather
 * than inside the image.
 */
Deno.test("the container pins the Breeze node pack and installs it in the venv", async () => {
  const root = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
  const containerfile = await Deno.readTextFile(join(root, "Containerfile"));

  // A commit, not a branch: a pack that moves under you is the likeliest
  // source of "it worked last week".
  const pin = containerfile.match(
    /ARG BREEZE_NODES_COMMIT=([0-9a-f]{40})\s/,
  );
  assertEquals(
    pin !== null,
    true,
    "Containerfile does not pin BREEZE_NODES_COMMIT to a full commit sha",
  );

  assertEquals(
    /git clone "\$\{BREEZE_NODES_REPO\}"/.test(containerfile),
    true,
    "Containerfile does not clone the node pack",
  );
  assertEquals(
    /checkout "\$\{BREEZE_NODES_COMMIT\}"/.test(containerfile),
    true,
    "Containerfile clones the node pack but never checks out the pin",
  );
  // Into ComfyUI's venv — the system python is not what runs the nodes.
  assertEquals(
    /venv\/bin\/pip" install[^\n]*(\n[^\n]*)*?custom_nodes\/ComfyUI-Breeze-TTS-2\/requirements\.txt/
      .test(containerfile),
    true,
    "the pack's requirements are not installed into ComfyUI's venv",
  );

  // The pack's first download always goes to the running install's own models
  // tree, which no yaml key redirects; the symlink is what keeps gigabytes of
  // weights off the image and on the volume.
  assertEquals(
    /ln -s \/models\/breezetts2 "\$\{COMFY_HOME\}\/models\/breezetts2"/.test(
      containerfile,
    ),
    true,
    "Containerfile does not symlink the breezetts2 weights onto /models",
  );
});

Deno.test("the README documents the node pack it installs", async () => {
  const root = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
  const readme = await Deno.readTextFile(join(root, "README.md"));
  for (const mention of ["ComfyUI-Breeze-TTS-2", "BREEZE_NODES_COMMIT"]) {
    assertEquals(
      readme.includes(mention),
      true,
      `README does not mention ${mention}`,
    );
  }
});

/**
 * The image never fetches weights at run time (§4.6). Three things hold that
 * together and this is the outermost: huggingface_hub reads these two
 * variables itself, so a pack reaching for the Hub fails immediately and
 * locally instead of hanging until DNS gives up.
 */
Deno.test("the container tells huggingface_hub it is offline", async () => {
  const root = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
  const containerfile = await Deno.readTextFile(join(root, "Containerfile"));
  for (const variable of ["HF_HUB_OFFLINE=1", "TRANSFORMERS_OFFLINE=1"]) {
    assertEquals(
      containerfile.includes(variable),
      true,
      `Containerfile does not set ${variable}`,
    );
  }
});
