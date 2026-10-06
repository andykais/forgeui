import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { type TestApp, withTestApp } from "../fixtures/app.ts";
import { tinyPng } from "../fixtures/png.ts";
import { parseSidecar } from "../../src/jobs/sidecar.ts";

/**
 * A mask (§9, §10): a PNG the size of its image, stored and uploaded like
 * any other input, bound to `LoadImageMask` in `sd15-inpaint` (§4.6) — and
 * refused at the submit when it was painted on a picture of another size,
 * which ComfyUI would otherwise stretch over the image in silence.
 */

interface InputView {
  sha256: string;
  filename: string;
  width: number;
  height: number;
}

const TERMINAL = ["done", "failed", "cancelled"];

async function upload(app: TestApp, bytes: Uint8Array): Promise<InputView> {
  const form = new FormData();
  form.set("file", new File([bytes.buffer as ArrayBuffer], "mask.png"));
  return await app.json<InputView>("/api/inputs", {
    method: "POST",
    body: form,
  });
}

function submit(app: TestApp, params: Record<string, unknown>) {
  return app.fetch("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ workflow_id: "sd15-inpaint", params }),
  });
}

async function settle(app: TestApp, id: string): Promise<void> {
  const deadline = Date.now() + 5000;
  let status = "queued";
  while (!TERMINAL.includes(status)) {
    if (Date.now() > deadline) throw new Error(`job ${id} stuck`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = (await app.json<{ status: string }>(`/api/jobs/${id}`)).status;
  }
  await app.jobs.idle();
  assertEquals(status, "done");
}

async function refusal(response: Response): Promise<string> {
  assertEquals(response.status, 400);
  const body = await response.json() as { error: { message: string } };
  return body.error.message;
}

Deno.test("an inpaint run uploads the image and its mask, and records both", async () => {
  await withTestApp(async (app) => {
    const image = await upload(app, tinyPng({ width: 64, height: 48 }));
    const mask = await upload(
      app,
      tinyPng({ width: 64, height: 48, color: [255, 255, 255] }),
    );
    const response = await submit(app, {
      image: image.filename,
      mask: mask.filename,
      prompt: "a heron in reeds",
      grow: 4,
      feather: 12,
    });
    assertEquals(response.status, 201);
    const job = await response.json() as { id: string; outputs: string[] };
    await settle(app, job.id);

    // §9 step 3: ComfyUI has both files, under the names the graph binds.
    const uploaded = app.fake!.uploads.map((file) => file.name);
    for (const name of [image.filename, mask.filename]) {
      assert(uploaded.includes(name), `${name} not among ${uploaded}`);
    }

    const { outputs } = await app.json<{ outputs: { id: string }[] }>(
      "/api/outputs?limit=1",
    );
    const output = outputs[0]!;
    // §9 step 5: the output says what it was made from, mask included, so
    // Reuse parameters and a rerun bring the mask back with the picture.
    const links = app.db.prepare(
      `SELECT input_sha256, param_key FROM output_inputs WHERE output_id = ?
       ORDER BY param_key`,
    ).all<{ input_sha256: string; param_key: string }>(output.id);
    assertEquals(links, [
      { input_sha256: image.sha256, param_key: "image" },
      { input_sha256: mask.sha256, param_key: "mask" },
    ]);

    const detail = await app.json<{ sidecar_path: string }>(
      `/api/outputs/${output.id}`,
    );
    const sidecar = parseSidecar(
      await Deno.readTextFile(join(app.paths.root, detail.sidecar_path)),
      detail.sidecar_path,
    );
    const graph = sidecar.api_graph as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    assertEquals(graph["25"]!.inputs.image, image.filename);
    // White repaints: the red channel reads it as 1, where alpha would read
    // the same file inverted (§9).
    assertEquals(graph["40"]!.inputs.image, mask.filename);
    assertEquals(graph["40"]!.inputs.channel, "red");
    // The edge is the workflow's, not the brush's (§10).
    assertEquals(graph["41"]!.inputs.expand, 4);
    assertEquals(graph["43"]!.inputs.blur_radius, 12);
  }, { comfy: true });
});

Deno.test("a mask painted on a picture of another size is refused", async () => {
  await withTestApp(async (app) => {
    const image = await upload(app, tinyPng({ width: 64, height: 48 }));
    const mask = await upload(
      app,
      tinyPng({ width: 32, height: 32, color: [255, 255, 255] }),
    );
    const message = await refusal(
      await submit(app, { image: image.filename, mask: mask.filename }),
    );
    assertStringIncludes(
      message,
      "mask: painted on a 32×32 picture, but image is 64×48",
    );

    // Nothing ran, and nothing was left behind to explain itself.
    const { jobs } = await app.json<{ jobs: unknown[] }>(
      "/api/jobs?status=all",
    );
    assertEquals(jobs.length, 0);
    assertEquals(app.fake!.uploads.length, 0);
  }, { comfy: true });
});

Deno.test("an inpaint without a mask asks for one", async () => {
  await withTestApp(async (app) => {
    const image = await upload(app, tinyPng({ width: 64, height: 48 }));
    const message = await refusal(
      await submit(app, { image: image.filename }),
    );
    assertStringIncludes(message, "mask");
  }, { comfy: true });
});
