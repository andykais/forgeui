import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type TestApp, withTestApp } from "../fixtures/app.ts";
import { tinyWav } from "../fixtures/wav.ts";
import { tinyPng } from "../fixtures/png.ts";
import type { ApiGraph, Manifest } from "../../src/workflows/types.ts";

/**
 * The three bundled audio workflows (DESIGN-AUDIO §2.1, §2.1.1): two that
 * speak and one that sings.
 *
 * Two of them are the first thing this repo ships that stock ComfyUI cannot
 * run, so the pack is part of what is under test here — a ComfyUI without it
 * rejects the graph exactly as the fake does, and that is the failure a user
 * would otherwise meet as "node type not found".
 */

const BREEZE = "ComfyUI-Breeze-TTS-2";
const TERMINAL = ["done", "failed", "cancelled"];

interface JobResponse {
  id: string;
  status: string;
  error: string | null;
  api_graph: ApiGraph;
}

async function submit(
  app: TestApp,
  workflow: string,
  params: Record<string, unknown>,
): Promise<JobResponse> {
  return await app.json<JobResponse>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ workflow_id: workflow, params }),
  });
}

async function settle(app: TestApp, id: string): Promise<JobResponse> {
  const deadline = Date.now() + 5000;
  let current = await app.json<JobResponse>(`/api/jobs/${id}`);
  while (!TERMINAL.includes(current.status)) {
    if (Date.now() > deadline) {
      throw new Error(`job ${id} stuck at "${current.status}"`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = await app.json<JobResponse>(`/api/jobs/${id}`);
  }
  await app.jobs.idle();
  return current;
}

interface OutputView {
  id: string;
  kind: string;
  duration_ms: number | null;
}

async function latestOutput(app: TestApp): Promise<OutputView> {
  const page = await app.json<{ outputs: OutputView[] }>(
    "/api/outputs?limit=1",
  );
  const output = page.outputs[0];
  assert(output, "the run produced no output row");
  return output;
}

async function uploadClip(app: TestApp): Promise<string> {
  const form = new FormData();
  form.set(
    "file",
    new File([tinyWav({ seconds: 3 }).buffer as ArrayBuffer], "reference.wav"),
  );
  const media = await app.json<{ filename: string }>("/api/inputs", {
    method: "POST",
    body: form,
  });
  return media.filename;
}

Deno.test("the audio workflows list, and say what they need", async () => {
  await withTestApp(async (app) => {
    const listed = await app.json<
      { workflows: { id: string; kind: string; runnable: boolean }[] }
    >("/api/workflows");
    const audio = listed.workflows.filter((w) => w.kind === "audio");
    assertEquals(audio.map((w) => w.id), [
      "ace-step-song",
      "breeze-tts-clone",
      "breeze-tts-design",
    ]);
    for (const workflow of audio) assertEquals(workflow.runnable, true);

    // Only the speech pair needs the pack; the song runs on stock ComfyUI,
    // which is why it was the one to prove the audio path with (§2.1.1).
    const requires = async (id: string) =>
      (await app.json<{ manifest: Manifest }>(`/api/workflows/${id}`))
        .manifest.requires;
    assertEquals(await requires("breeze-tts-clone"), [BREEZE]);
    assertEquals(await requires("breeze-tts-design"), [BREEZE]);
    assertEquals(await requires("ace-step-song"), []);
  });
});

Deno.test("voice design speaks, and the description reaches the node", async () => {
  await withTestApp(async (app) => {
    const done = await settle(
      app,
      (await submit(app, "breeze-tts-design", {
        voice: "an older man, warm, unhurried, faint Irish accent",
        text: "(sigh) It is good to hear your voice again.",
        seed: 7,
      })).id,
    );
    assertEquals(done.status, "done");

    const design = done.api_graph["3"]!;
    assertEquals(design.class_type, "BreezeTTS2VoiceDesign");
    assertEquals(
      design.inputs.instruction,
      "an older man, warm, unhurried, faint Irish accent",
    );
    assertEquals(
      design.inputs.text,
      "(sigh) It is good to hear your voice again.",
    );
    // The seed is a primitive both the node and a rerun read, so it is there
    // rather than on the node itself.
    assertEquals(done.api_graph["2"]!.inputs.value, 7);

    const output = await latestOutput(app);
    assertEquals(output.kind, "audio");
  }, { comfy: { packs: [BREEZE] } });
});

Deno.test("without the node pack, the failure names the node", async () => {
  await withTestApp(async (app) => {
    // The same workflow against a ComfyUI that has not got the pack: this is
    // what a user running outside the container meets (§4.6). ComfyUI rejects
    // the prompt outright, so the job never runs — it comes back failed from
    // the submit itself.
    const response = await app.fetch("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: "breeze-tts-design",
        params: {
          voice: "a warm, thoughtful young woman",
          text: "Welcome aboard.",
        },
      }),
    });
    assertEquals(response.status, 502);
    const body = await response.json() as {
      error: { code: string };
      job: { status: string };
    };
    assertEquals(body.error.code, "comfy_rejected");
    assertEquals(body.job.status, "failed");
    // Which node, by name: the whole point of declaring the pack is that this
    // is diagnosable rather than mysterious.
    assertStringIncludes(JSON.stringify(body), "BreezeTTS2LoadModel");
  }, { comfy: true });
});

Deno.test("the clone workflow switches between cloning and directing", async () => {
  await withTestApp(async (app) => {
    const reference = await uploadClip(app);
    const params = {
      reference,
      transcript: "This is the exact transcript of the reference audio.",
      text: "(sigh) It is good to hear your voice again.",
    };

    // Off: the save node reads the plain clone, which runs at cfg 1 and takes
    // no instruction — the reference is the delivery (§2.1).
    const plain = await settle(
      app,
      (await submit(app, "breeze-tts-clone", {
        ...params,
        direct: false,
      })).id,
    );
    assertEquals(plain.status, "done");
    assertEquals(plain.api_graph["9"]!.inputs.switch, false);
    assertEquals(plain.api_graph["7"]!.class_type, "BreezeTTS2VoiceClone");
    assertEquals(plain.api_graph["7"]!.inputs.cfg_scale, 1.0);

    // On: the same voice, delivered to an instruction, through the node that
    // takes one.
    const directed = await settle(
      app,
      (await submit(app, "breeze-tts-clone", {
        ...params,
        direct: true,
        instruction: "Speak quickly, delighted.",
      })).id,
    );
    assertEquals(directed.status, "done");
    assertEquals(directed.api_graph["9"]!.inputs.switch, true);
    assertEquals(
      directed.api_graph["8"]!.inputs.instruction,
      "Speak quickly, delighted.",
    );

    // The clip went up under the name the graph holds, both times.
    assertEquals(app.fake!.uploads.map((file) => file.name), [
      reference,
      reference,
    ]);
    assertEquals((await latestOutput(app)).kind, "audio");
  }, { comfy: { packs: [BREEZE] } });
});

Deno.test("one duration reaches both the encoder and the latent", async () => {
  await withTestApp(async (app) => {
    const done = await settle(
      app,
      (await submit(app, "ace-step-song", {
        style: "neo-soul, live drums, warm rhodes, female vocal",
        lyrics: "[verse]\nNeon on the wet street\n",
        duration: 45,
        bpm: 92,
      })).id,
    );
    assertEquals(done.status, "done");

    // ACE-Step writes an arrangement to fit the length it is told, and it is
    // told twice — the encoder and the empty latent must agree, so both read
    // the one primitive the param binds (§2.1.1).
    assertEquals(done.api_graph["5"]!.inputs.value, 45);
    assertEquals(done.api_graph["7"]!.inputs.duration, ["5", 0]);
    assertEquals(done.api_graph["9"]!.inputs.seconds, ["5", 0]);
    assertEquals(done.api_graph["7"]!.inputs.bpm, 92);

    assertEquals((await latestOutput(app)).kind, "audio");
  }, { comfy: true });
});

// ------------------------------------------------------------------ ia2v

/**
 * The point of all of the above (DESIGN-AUDIO §3): a take made here, carried
 * into video that is lip-synced to it.
 *
 * What makes the mouth match is not that the audio is *present* — `ltx2-i2v`
 * already carries an audio latent — but that the supplied clip is encoded
 * into that latent and masked so the sampler keeps it. So the mask and where
 * the duration lands are the two things worth holding still.
 */
Deno.test("image plus audio to video pins the take and sets the length", async () => {
  await withTestApp(async (app) => {
    const clip = await uploadClip(app);
    const frame = new FormData();
    frame.set(
      "file",
      new File(
        [tinyPng({ width: 64, height: 64 }).buffer as ArrayBuffer],
        "frame.png",
      ),
    );
    const picture = await app.json<{ filename: string }>("/api/inputs", {
      method: "POST",
      body: frame,
    });

    const done = await settle(
      app,
      (await submit(app, "ltx2-ia2v", {
        image: picture.filename,
        audio: clip,
        prompt: "the cactus creature talks to the camera",
        duration: 6,
        start: 1.5,
        fps: 24,
      })).id,
    );
    assertEquals(done.status, "done");

    // The clip is what the graph loads, under the name the store gave it.
    assertEquals(done.api_graph["55"]!.inputs.audio, clip);
    assertEquals(done.api_graph["54"]!.inputs.image, picture.filename);

    // A noise mask of 0 means "keep this". It is the whole mechanism: with a
    // mask of 1 the sampler would regenerate the audio and there would be
    // nothing to lip-sync to.
    assertEquals(done.api_graph["44"]!.inputs.value, 0);
    assertEquals(done.api_graph["38"]!.inputs.mask, ["44", 0]);
    assertEquals(done.api_graph["38"]!.inputs.samples, ["39", 0]);
    assertEquals(done.api_graph["39"]!.class_type, "LTXVAudioVAEEncode");
    assertEquals(done.api_graph["39"]!.inputs.audio, ["43", 0]);

    // One duration trims the clip and sets the frame count — `a * b + 1`
    // against the frame rate — so the video cannot be a different length
    // from the sound (§3.3).
    assertEquals(done.api_graph["42"]!.inputs.value, 6);
    assertEquals(done.api_graph["43"]!.inputs.duration, ["42", 0]);
    assertEquals(done.api_graph["43"]!.inputs.start_index, 1.5);
    assertEquals(done.api_graph["40"]!.inputs.expression, "a * b + 1");
    assertEquals(done.api_graph["40"]!.inputs["values.a"], ["42", 0]);
    assertEquals(done.api_graph["40"]!.inputs["values.b"], ["34", 0]);
    assertEquals(done.api_graph["34"]!.inputs.value, 24);

    // Both files went up before the prompt did, and the result remembers
    // both of them (§9 step 5).
    assertEquals(
      app.fake!.uploads.map((file) => file.name).sort(),
      [clip, picture.filename].sort(),
    );
    const output = await latestOutput(app);
    assertEquals(output.kind, "video");
    const links = app.db.prepare(
      `SELECT param_key FROM output_inputs WHERE output_id = ? ORDER BY param_key`,
    ).all<{ param_key: string }>(output.id);
    assertEquals(links.map((row) => row.param_key), ["audio", "image"]);
  }, { comfy: true });
});
