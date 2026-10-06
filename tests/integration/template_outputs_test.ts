import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { type TestApp, withTestApp } from "../fixtures/app.ts";
import { reindex } from "../../src/outputs/reindex.ts";
import type { OutputRow, TemplateRef } from "../../src/db/queries.ts";
import { parseSidecar } from "../../src/jobs/sidecar.ts";

/**
 * Which template an output was made with (DESIGN.md §4.8, §6.2): named on
 * the submit, kept on the job, written into the sidecar and every output,
 * and found again with `GET /api/outputs?template=`. The sidecar is the
 * record and the columns the index, so a rebuild must bring it back.
 */

interface OutputView extends OutputRow {
  media_url: string;
}

interface JobView {
  id: string;
  status: string;
  template: TemplateRef | null;
  outputs: string[];
}

const TERMINAL = ["done", "failed", "cancelled"];

async function generate(
  app: TestApp,
  body: Record<string, unknown>,
): Promise<JobView> {
  const job = await app.json<JobView>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      workflow_id: "krea2",
      params: { prompt: "a granite bowl of figs" },
      ...body,
    }),
  });
  await settle(app, job.id);
  return await app.json<JobView>(`/api/jobs/${job.id}`);
}

async function settle(app: TestApp, id: string): Promise<void> {
  const deadline = Date.now() + 5000;
  let status = "queued";
  while (!TERMINAL.includes(status)) {
    if (Date.now() > deadline) throw new Error(`job ${id} stuck`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = (await app.json<JobView>(`/api/jobs/${id}`)).status;
  }
  await app.jobs.idle();
  assertEquals(status, "done");
}

async function makeTemplate(
  app: TestApp,
  name: string,
  workflow = "krea2",
): Promise<string> {
  const template = await app.json<{ id: string }>("/api/templates", {
    method: "POST",
    body: JSON.stringify({
      name,
      workflow,
      values: { steps: 6 },
      ask: ["prompt"],
    }),
  });
  return template.id;
}

async function outputsFor(app: TestApp, template: string) {
  return (await app.json<{ outputs: OutputView[] }>(
    `/api/outputs?template=${encodeURIComponent(template)}`,
  )).outputs;
}

Deno.test("the template travels from the submit to the job, the sidecar and the output", async () => {
  await withTestApp(async (app) => {
    const id = await makeTemplate(app, "Quick figs");
    const job = await generate(app, {
      template: id,
      params: { prompt: "a granite bowl of figs", steps: 6 },
    });
    assertEquals(job.template, { id: "quick-figs", name: "Quick figs" });

    const output = await app.json<OutputView>(`/api/outputs/${job.outputs[0]}`);
    assertEquals(output.template, { id: "quick-figs", name: "Quick figs" });
    const sidecar = parseSidecar(
      await Deno.readTextFile(join(app.paths.root, output.sidecar_path)),
    );
    assertEquals(sidecar.template, { id: "quick-figs", name: "Quick figs" });

    // A run that used none says so, and is not found under it.
    const plain = await generate(app, {});
    assertEquals(plain.template, null);
    const found = await outputsFor(app, id);
    assertEquals(found.map((o) => o.id), job.outputs);
    assertEquals(await outputsFor(app, "no-such-template"), []);
  }, { comfy: true });
});

Deno.test("a submit naming a template it could not have come from is refused", async () => {
  await withTestApp(async (app) => {
    const other = await makeTemplate(app, "For SD", "sd15");
    const cases: [unknown, string][] = [
      ["no-such-template", 'no template "no-such-template"'],
      [other, `"${other}" fills sd15, not krea2`],
      [42, "expected a template id"],
    ];
    for (const [template, expected] of cases) {
      const response = await app.fetch("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          workflow_id: "krea2",
          params: { prompt: "a granite bowl of figs" },
          template,
        }),
      });
      assertEquals(response.status, 400, String(template));
      const body = await response.json() as { error: { message: string } };
      assertStringIncludes(body.error.message, expected);
    }
    // Nothing ran.
    const { jobs } = await app.json<{ jobs: unknown[] }>(
      "/api/jobs?status=all",
    );
    assertEquals(jobs.length, 0);
  }, { comfy: true });
});

Deno.test("a rerun keeps the template; renaming it later leaves what it made alone", async () => {
  await withTestApp(async (app) => {
    const id = await makeTemplate(app, "Quick figs");
    const first = await generate(app, { template: id });

    // A rerun replays the same values, so it came from the same place.
    const rerun = await app.json<JobView>("/api/jobs/rerun", {
      method: "POST",
      body: JSON.stringify({ output_id: first.outputs[0] }),
    });
    await settle(app, rerun.id);
    assertEquals(
      (await app.json<JobView>(`/api/jobs/${rerun.id}`)).template,
      { id, name: "Quick figs" },
    );

    // The name recorded is the name it had: a later rename is the template's
    // business, not a rewrite of what it made. The id still finds them.
    await app.json(`/api/templates/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "Figs, quickly" }),
    });
    const found = await outputsFor(app, id);
    assertEquals(found.length, 2);
    for (const output of found) {
      assertEquals(output.template, { id, name: "Quick figs" });
    }
  }, { comfy: true });
});

Deno.test("reindex rebuilds the template from the sidecar", async () => {
  await withTestApp(async (app) => {
    const id = await makeTemplate(app, "Quick figs");
    await generate(app, { template: id });
    await generate(app, {});
    app.db.exec("DELETE FROM outputs");
    app.db.exec("DELETE FROM jobs");

    const result = await reindex({ db: app.db, paths: app.paths });
    assert(result.outputs >= 2, "something was rebuilt");

    const found = await outputsFor(app, id);
    assertEquals(found.length, 1);
    assertEquals(found[0]!.template, { id, name: "Quick figs" });
    const { jobs } = await app.json<{ jobs: JobView[] }>(
      "/api/jobs?status=all",
    );
    assertEquals(
      jobs.map((job) => job.template?.id ?? null).sort(),
      [id, null].sort(),
    );
  }, { comfy: true });
});
