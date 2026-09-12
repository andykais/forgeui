import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { type TestApp, withTestApp } from "../fixtures/app.ts";
import { tinyPng } from "../fixtures/png.ts";
import { parseSidecar } from "../../src/jobs/sidecar.ts";

/**
 * Input media (§9): the content-addressed store, the one route that fills
 * it, and what happens on the way to ComfyUI. The store is the reason an
 * image can be reused for nothing — so the tests check the filesystem, not
 * just the API's word for it.
 */

interface InputView {
  sha256: string;
  ext: string;
  filename: string;
  width: number;
  height: number;
  url: string;
  derived_from_output: string | null;
}

const TERMINAL = ["done", "failed", "cancelled"];

async function upload(
  app: TestApp,
  bytes: Uint8Array,
  name = "picture.png",
): Promise<InputView> {
  const form = new FormData();
  form.set("file", new File([bytes.buffer as ArrayBuffer], name));
  return await app.json<InputView>("/api/inputs", {
    method: "POST",
    body: form,
  });
}

async function generate(
  app: TestApp,
  workflow: string,
  params: Record<string, unknown>,
): Promise<string> {
  const job = await app.json<{ id: string }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ workflow_id: workflow, params }),
  });
  const deadline = Date.now() + 5000;
  let status = "queued";
  while (!TERMINAL.includes(status)) {
    if (Date.now() > deadline) throw new Error(`job ${job.id} stuck`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = (await app.json<{ status: string }>(`/api/jobs/${job.id}`)).status;
  }
  await app.jobs.idle();
  assertEquals(status, "done");
  return job.id;
}

Deno.test("an uploaded image lands in the store under its own hash", async () => {
  await withTestApp(async (app) => {
    const bytes = tinyPng({ width: 64, height: 32 });
    const input = await upload(app, bytes);

    assertEquals(input.ext, "png");
    assertEquals([input.width, input.height], [64, 32]);
    assertEquals(input.filename, `${input.sha256}.png`);
    // `inputs/<first two>/<sha>.<ext>` — the fan-out keeps one directory from
    // growing to tens of thousands of entries (§9).
    assertEquals(
      input.url,
      `/api/media/inputs/${input.sha256.slice(0, 2)}/${input.sha256}.png`,
    );
    const onDisk = await Deno.readFile(
      join(
        app.paths.root,
        "inputs",
        input.sha256.slice(0, 2),
        `${input.sha256}.png`,
      ),
    );
    assertEquals(onDisk, bytes);

    // And it is served back, which is what the panel shows as a thumbnail.
    const served = await app.fetch(input.url);
    assertEquals(served.status, 200);
    assertEquals(served.headers.get("content-type"), "image/png");
    assertEquals(new Uint8Array(await served.arrayBuffer()), bytes);
  }, { comfy: true });
});

Deno.test("the same bytes twice are one file and one row", async () => {
  await withTestApp(async (app) => {
    const bytes = tinyPng({ width: 16, height: 16 });
    const first = await upload(app, bytes, "original.png");
    const again = await upload(app, bytes, "a-copy-someone-renamed.png");

    assertEquals(again.sha256, first.sha256);
    const rows = app.db.prepare(`SELECT COUNT(*) FROM inputs`).value<
      [number]
    >();
    assertEquals(rows?.[0], 1);
    // The name recorded is the one that arrived first: later arrivals are
    // the same picture, and outputs already point at what it says.
    const name = app.db.prepare(
      `SELECT original_name FROM inputs WHERE sha256 = ?`,
    ).value<[string]>(first.sha256);
    assertEquals(name?.[0], "original.png");
  }, { comfy: true });
});

Deno.test("a file that is not an image is refused with the reason", async () => {
  await withTestApp(async (app) => {
    const form = new FormData();
    form.set(
      "file",
      new File([
        new TextEncoder().encode(
          "not an image, just a long enough line of prose",
        ),
      ], "x.png"),
    );
    const response = await app.fetch("/api/inputs", {
      method: "POST",
      body: form,
    });
    assertEquals(response.status, 400);
    const body = await response.json() as { error: { message: string } };
    assertStringIncludes(body.error.message, "PNG, JPEG and WebP");
  }, { comfy: true });
});

Deno.test("an output can be adopted as an input without copying it", async () => {
  await withTestApp(async (app) => {
    await generate(app, "krea2", { prompt: "a granite bowl of figs" });
    const { outputs } = await app.json<
      { outputs: { id: string; path: string }[] }
    >(
      "/api/outputs?limit=1",
    );
    const output = outputs[0]!;

    const input = await app.json<InputView>("/api/inputs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ output_id: output.id }),
    });
    assertEquals(input.derived_from_output, output.id);

    // Hard link, not a copy: one inode, so reusing a render costs nothing.
    const source = await Deno.stat(join(app.paths.root, output.path));
    const stored = await Deno.stat(
      join(
        app.paths.root,
        "inputs",
        input.sha256.slice(0, 2),
        `${input.sha256}.png`,
      ),
    );
    assertEquals(stored.ino, source.ino);
    assertEquals(stored.size, source.size);
  }, { comfy: true });
});

Deno.test("an upscale run uploads its input and records what it came from", async () => {
  await withTestApp(async (app) => {
    await generate(app, "krea2", { prompt: "a granite bowl of figs" });
    const { outputs } = await app.json<{ outputs: { id: string }[] }>(
      "/api/outputs?limit=1",
    );
    const source = outputs[0]!;
    const input = await app.json<InputView>("/api/inputs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ output_id: source.id }),
    });

    const jobId = await generate(app, "krea2-upscale", {
      image: input.filename,
      creativity: 0.4,
    });

    // §9 step 3: ComfyUI has the file, under the name the graph binds.
    const uploaded = app.fake!.uploads.map((file) => file.name);
    assert(
      uploaded.includes(input.filename),
      `expected ${input.filename} among ${JSON.stringify(uploaded)}`,
    );

    // §9 step 5: the new output says what it was made from.
    const { outputs: after } = await app.json<{ outputs: { id: string }[] }>(
      `/api/outputs?limit=1`,
    );
    const upscaled = after[0]!;
    assert(
      upscaled.id.startsWith(jobId),
      `${upscaled.id} is not from ${jobId}`,
    );
    const links = app.db.prepare(
      `SELECT input_sha256, param_key FROM output_inputs WHERE output_id = ?`,
    ).all<{ input_sha256: string; param_key: string }>(upscaled.id);
    assertEquals(links, [{ input_sha256: input.sha256, param_key: "image" }]);

    // And the graph that ran names the file rather than the template's.
    const detail = await app.json<{ sidecar_path: string }>(
      `/api/outputs/${upscaled.id}`,
    );
    const sidecar = parseSidecar(
      await Deno.readTextFile(join(app.paths.root, detail.sidecar_path)),
      detail.sidecar_path,
    );
    const graph = sidecar.api_graph as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    assertEquals(graph["6"]!.inputs.image, input.filename);
    // Creativity is the slice of the model's own schedule to re-run (§10),
    // so it lands on the sigma split rather than on a sampler's `denoise`.
    assertEquals(graph["13"]!.inputs.denoise, 0.4);
    assertEquals(graph["12"]!.inputs.steps, 8);
    assertEquals(graph["17"]!.inputs.sigmas, ["13", 1]);
  }, { comfy: true });
});

Deno.test("a job naming an input the store has lost says so", async () => {
  await withTestApp(async (app) => {
    const missing = "f".repeat(64);
    const response = await app.fetch("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: "krea2-upscale",
        params: { image: `${missing}.png` },
      }),
    });
    assertEquals(response.status, 400);
    const body = await response.json() as { error: { message: string } };
    assertStringIncludes(body.error.message, "attach the image again");
  }, { comfy: true });
});
