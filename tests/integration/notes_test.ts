import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type TestApp, withTestApp } from "../fixtures/app.ts";
import { reindex } from "../../src/outputs/reindex.ts";
import type { OutputRow } from "../../src/db/queries.ts";
import type { Sidecar } from "../../src/jobs/sidecar.ts";

/**
 * Notes on an output (§6.2): what a person made of a picture, written after
 * looking at it, for the MCP bridge to read back before making another one.
 *
 * The interesting cases are the ones where the row and the file could drift
 * apart, and the search index, which holds a copy of its own.
 */

const TERMINAL = ["done", "failed", "cancelled"];

async function generate(app: TestApp, prompt: string): Promise<string[]> {
  const job = await app.json<{ id: string; status: string }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ workflow_id: "krea2", params: { prompt } }),
  });
  const deadline = Date.now() + 5000;
  let status = job.status;
  while (!TERMINAL.includes(status)) {
    if (Date.now() > deadline) throw new Error(`job ${job.id} stuck`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = (await app.json<{ status: string }>(`/api/jobs/${job.id}`)).status;
  }
  await app.jobs.idle();
  return (await app.json<{ outputs: string[] }>(`/api/jobs/${job.id}`)).outputs;
}

const note = (app: TestApp, id: string, notes: string | null) =>
  app.json<OutputRow>(`/api/outputs/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ notes }),
  });

const search = async (app: TestApp, q: string) =>
  (await app.json<{ outputs: OutputRow[] }>(
    `/api/outputs?q=${encodeURIComponent(q)}`,
  )).outputs;

Deno.test("a note lands in the row and in the sidecar", async () => {
  await withTestApp(async (app) => {
    const [id] = await generate(app, "a granite bowl of figs");
    const saved = await note(
      app,
      id!,
      "  hands are mangled, the light is right  ",
    );
    // Trimmed on the way in: trailing whitespace is not feedback.
    assertEquals(saved.notes, "hands are mangled, the light is right");

    const detail = await app.json<{ notes: string; sidecar: Sidecar }>(
      `/api/outputs/${id}`,
    );
    assertEquals(detail.notes, "hands are mangled, the light is right");
    assertEquals(
      detail.sidecar.outputs[0]!.notes,
      "hands are mangled, the light is right",
    );
  }, { comfy: true });
});

Deno.test("a note is searchable, and rewriting it forgets the old words", async () => {
  // The index holds its own copy, so an edit has to take the old text out of
  // it. Getting the order wrong leaves a word findable for ever.
  await withTestApp(async (app) => {
    const [id] = await generate(app, "a granite bowl of figs");
    await note(app, id!, "hands are mangled");

    assertEquals((await search(app, "mangled")).length, 1);
    // The prompt is still indexed beside it.
    assertEquals((await search(app, "figs")).length, 1);

    await note(app, id!, "actually fine, keep this seed");
    assertEquals((await search(app, "mangled")).length, 0);
    assertEquals((await search(app, "seed")).length, 1);

    await note(app, id!, null);
    assertEquals((await search(app, "seed")).length, 0);
    assertEquals((await search(app, "figs")).length, 1);
  }, { comfy: true });
});

Deno.test("a note survives a rebuild from the sidecars", async () => {
  // Which is the whole reason it is in the file and not only in a column: a
  // note is feedback meant to outlive the index.
  await withTestApp(async (app) => {
    const [id] = await generate(app, "a granite bowl of figs");
    await note(app, id!, "the composition is the one to keep");
    app.db.exec("DELETE FROM outputs");

    const result = await reindex({ db: app.db, paths: app.paths });
    assert(result.outputs > 0, "something was rebuilt");

    const detail = await app.json<OutputRow>(`/api/outputs/${id}`);
    assertEquals(detail.notes, "the composition is the one to keep");
    // And findable again, which means the index was rebuilt with it.
    assertEquals((await search(app, "composition")).length, 1);
  }, { comfy: true });
});

Deno.test("clearing a note takes it out of the sidecar too", async () => {
  await withTestApp(async (app) => {
    const [id] = await generate(app, "a granite bowl of figs");
    await note(app, id!, "something");
    const cleared = await note(app, id!, "   ");
    assertEquals(cleared.notes, null);

    const detail = await app.json<{ sidecar: Sidecar }>(`/api/outputs/${id}`);
    assert(
      !("notes" in detail.sidecar.outputs[0]!),
      "the key goes, rather than being left as an empty string",
    );
  }, { comfy: true });
});

Deno.test("notes belong to an output, not to the job that made it", async () => {
  // One sidecar covers every frame of a batch, and two frames of the same
  // batch are not the same picture.
  await withTestApp(async (app) => {
    const ids = await generate(app, "a granite bowl of figs");
    assert(ids.length > 1, `expected several outputs, got ${ids.length}`);

    await note(app, ids[0]!, "the first one is soft");
    await note(app, ids[1]!, "the second one is sharp");

    const first = await app.json<OutputRow>(`/api/outputs/${ids[0]}`);
    const second = await app.json<OutputRow>(`/api/outputs/${ids[1]}`);
    assertEquals(first.notes, "the first one is soft");
    assertEquals(second.notes, "the second one is sharp");
    assertEquals((await search(app, "soft")).map((row) => row.id), [ids[0]]);
  }, { comfy: { scenario: "multi-output" } });
});

Deno.test("a bad note is refused, and an unknown output is a 404", async () => {
  await withTestApp(async (app) => {
    const [id] = await generate(app, "a granite bowl of figs");
    const cases: [unknown, number, string][] = [
      [7, 400, "notes: expected a string"],
      ["x".repeat(2001), 400, "at most 2000"],
    ];
    for (const [notes, status, expected] of cases) {
      const response = await app.fetch(`/api/outputs/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ notes }),
      });
      assertEquals(response.status, status);
      const body = await response.json() as { error: { message: string } };
      assertStringIncludes(body.error.message, expected);
    }

    const empty = await app.fetch(`/api/outputs/${id}`, {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    assertEquals(empty.status, 400);

    const missing = await app.fetch("/api/outputs/nope", {
      method: "PATCH",
      body: JSON.stringify({ notes: "hello" }),
    });
    assertEquals(missing.status, 404);
  }, { comfy: true });
});
