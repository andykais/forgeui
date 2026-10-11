import { assertEquals, assertNotEquals } from "@std/assert";
import { deflateSync } from "node:zlib";
import { type TestApp, withTestApp } from "../fixtures/app.ts";
import { tinyPng } from "../fixtures/png.ts";
import { decodePng, serializeChunks } from "../../src/jobs/png.ts";
import { backfillPixelHashes } from "../../src/outputs/pixels.ts";

/**
 * Where an input came from (§9): adopted by id, the same file as an output,
 * or — a paste, which the browser re-encodes — the same pixels. Each is
 * checked through the routes, and the lineage the viewer draws from it.
 */

interface InputView {
  sha256: string;
  filename: string;
  derived_from_output: string | null;
}

interface Lineage {
  parents: { id: string }[];
  children: { id: string }[];
}

const TERMINAL = ["done", "failed", "cancelled"];

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
  return `${job.id}-0`;
}

async function upload(app: TestApp, bytes: Uint8Array, name = "pasted.png") {
  const form = new FormData();
  form.set("file", new File([bytes.buffer as ArrayBuffer], name));
  return await app.json<InputView>("/api/inputs", {
    method: "POST",
    body: form,
  });
}

async function mediaOf(app: TestApp, outputId: string): Promise<Uint8Array> {
  const { media_url } = await app.json<{ media_url: string }>(
    `/api/outputs/${outputId}`,
  );
  return new Uint8Array(await (await app.fetch(media_url)).arrayBuffer());
}

/**
 * What a browser's clipboard does to a picture: the same pixels, written
 * again as RGBA with its own filtering and compression, and none of the
 * file's text chunks — so not one byte in common with the file it came from.
 */
async function asPasted(png: Uint8Array): Promise<Uint8Array> {
  const { width, height, rgba } = (await decodePng(png))!;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    // Filter 1 (Sub) on every row, where the original used none.
    const row = y * (width * 4 + 1);
    raw[row] = 1;
    for (let x = 0; x < width * 4; x++) {
      const left = x >= 4 ? rgba[y * width * 4 + x - 4]! : 0;
      raw[row + 1 + x] = (rgba[y * width * 4 + x]! - left) & 0xff;
    }
  }
  return serializeChunks([
    { type: "IHDR", data: header },
    { type: "IDAT", data: new Uint8Array(deflateSync(raw, { level: 9 })) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
}

Deno.test("a pasted picture finds the output it came from, and the lineage shows it", async () => {
  await withTestApp(async (app) => {
    const source = await generate(app, "krea2", { prompt: "a granite bowl" });
    const file = await mediaOf(app, source);

    // The same file, dragged back in from disk: matched on its bytes.
    const dropped = await upload(app, file, "saved-from-the-gallery.png");
    assertEquals(dropped.derived_from_output, source);

    // A paste: not a byte in common, every pixel the same.
    const pasted = await asPasted(file);
    assertNotEquals(pasted, file);
    const input = await upload(app, pasted);
    assertNotEquals(input.sha256, dropped.sha256);
    assertEquals(input.derived_from_output, source);

    // And a run with it is a child of the output, both ways round (§11.2).
    const child = await generate(app, "krea2-img2img", {
      image: input.filename,
    });
    const up = await app.json<Lineage>(`/api/outputs/${child}/lineage`);
    assertEquals(up.parents.map((node) => node.id), [source]);
    const down = await app.json<Lineage>(`/api/outputs/${source}/lineage`);
    assertEquals(down.children.map((node) => node.id), [child]);
  }, { comfy: true });
});

Deno.test("a picture from outside has no parent, and none is invented", async () => {
  await withTestApp(async (app) => {
    await generate(app, "krea2", { prompt: "a granite bowl" });
    const outside = await upload(
      app,
      tinyPng({ width: 40, height: 30, color: [1, 2, 3] }),
    );
    assertEquals(outside.derived_from_output, null);
  }, { comfy: true });
});

Deno.test("the same picture made twice: its parent is the first", async () => {
  await withTestApp(async (app) => {
    // The fake paints every run of a workflow the same colour, which is what
    // a rerun of one seed does for real.
    const first = await generate(app, "krea2", { prompt: "a granite bowl" });
    const again = await generate(app, "krea2", { prompt: "a granite bowl" });
    const input = await upload(app, await asPasted(await mediaOf(app, again)));
    assertEquals(input.derived_from_output, first);

    // Unless the first is gone: then the one still here.
    await app.fetch(`/api/outputs/${first}`, { method: "DELETE" });
    const later = await upload(
      app,
      await asPasted(await mediaOf(app, again)).then((png) => {
        // A different file of the same picture: one more byte of text.
        return serializeChunks([
          ...[{
            type: "IHDR",
            data: png.subarray(16, 29),
          }],
          { type: "tEXt", data: new TextEncoder().encode("note\0x") },
          ...[{ type: "IDAT", data: idatOf(png) }],
          { type: "IEND", data: new Uint8Array(0) },
        ]);
      }),
    );
    assertEquals(later.derived_from_output, again);
  }, { comfy: true });
});

Deno.test("what was pasted before pixel hashes finds its parent after boot", async () => {
  await withTestApp(async (app) => {
    const source = await generate(app, "krea2", { prompt: "a granite bowl" });
    const input = await upload(app, await asPasted(await mediaOf(app, source)));
    // As it stood before migration 14: nothing hashed, nothing matched.
    app.db.exec(`UPDATE outputs SET pixel_hash = NULL`);
    app.db.exec(
      `UPDATE inputs SET pixel_hash = NULL, derived_from_output = NULL`,
    );

    const done = await backfillPixelHashes({ db: app.db, paths: app.paths });
    assertEquals(done.parents, 1);
    assertEquals(
      (await app.json<InputView>(`/api/inputs/${input.sha256}`))
        .derived_from_output,
      source,
    );
    // And once is enough: a second pass has nothing left to do.
    assertEquals(
      await backfillPixelHashes({ db: app.db, paths: app.paths }),
      { outputs: 0, inputs: 0, parents: 0 },
    );
  }, { comfy: true });
});

function idatOf(png: Uint8Array): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    if (type === "IDAT") return png.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
  }
  throw new Error("no IDAT");
}
