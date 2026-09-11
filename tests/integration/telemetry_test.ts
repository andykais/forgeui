import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { startTestApp, type TestApp, withTestApp } from "../fixtures/app.ts";
import { writeFakeSafetensors } from "../fixtures/models.ts";
import type { ReportView } from "../../src/telemetry/store.ts";
import type { TelemetryEntryRow } from "../../src/telemetry/queries.ts";

/**
 * The telemetry reports through their routes (§7.1, §12). Every assertion
 * goes through HTTP, including the recording: a report is only worth having
 * if using the app fills it in.
 */

interface CatalogueResponse {
  reports: ReportView[];
  bytes: number;
}

interface SeriesResponse {
  report: string;
  series: {
    key: string | null;
    points: { id: number; at: number; value: number }[];
  }[];
  truncated: boolean;
  total: number;
}

interface EntriesResponse {
  report: string;
  entries: TelemetryEntryRow[];
  cursor: string | null;
}

function entries(app: TestApp, report: string, query = "") {
  return app.json<EntriesResponse>(
    `/api/telemetry/${report}/entries${query ? `?${query}` : ""}`,
  );
}

function series(app: TestApp, report: string, query = "") {
  return app.json<SeriesResponse>(
    `/api/telemetry/${report}/series${query ? `?${query}` : ""}`,
  );
}

/** The fake's events arrive over a websocket, so wait for the row to settle. */
async function awaitJob(app: TestApp, id: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const job = await app.json<{ status: string; outputs: string[] }>(
      `/api/jobs/${id}`,
    );
    if (["done", "failed", "cancelled"].includes(job.status)) {
      await app.jobs.idle();
      return await app.json<{ status: string; outputs: string[] }>(
        `/api/jobs/${id}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`job ${id} was still "${job.status}"`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

Deno.test("the telemetry log is its own database beside app.db", async () => {
  await withTestApp(async (app) => {
    await app.json("/api/config");
    // §7.1: a separate file, and `app.db` has no telemetry table in it.
    const stat = await Deno.stat(join(app.dataDir, "telemetry.db"));
    assert(stat.isFile, "telemetry.db exists");
    const tables = app.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all<{ name: string }>().map((row) => row.name);
    assertEquals(tables.includes("entries"), false);
    assertEquals(tables.includes("model_sizes"), false);
  });
});

Deno.test("the catalogue names five reports and what each one can be filtered by", async () => {
  await withTestApp(async (app) => {
    const body = await app.json<CatalogueResponse>("/api/telemetry/reports");
    assertEquals(body.reports.map((report) => report.id), [
      "api_requests",
      "output_size",
      "model_size",
      "memory",
      "telemetry_size",
    ]);
    assertEquals(body.reports.map((report) => report.title), [
      "API request duration",
      "Output size",
      "Model size",
      "Memory Usage",
      "Size of the telemetry log",
    ]);
    assert(body.bytes > 0, "the log has a size");

    const byId = new Map(body.reports.map((report) => [report.id, report]));
    assertEquals(
      byId.get("api_requests")!.filters.map((filter) => filter.key),
      ["method", "route", "status", "min_value"],
    );
    assertEquals(
      byId.get("output_size")!.filters.map((filter) => filter.key),
      ["family"],
    );
    assertEquals(
      byId.get("model_size")!.filters.map((filter) => filter.key),
      ["model_class", "family"],
    );
    // §11.2: these two have no filters at all.
    assertEquals(byId.get("memory")!.filters, []);
    assertEquals(byId.get("telemetry_size")!.filters, []);

    // The columns are the graphed value plus everything filterable (§11.2).
    assertEquals(
      byId.get("api_requests")!.columns.map((column) => column.key),
      ["at", "value", "method", "route", "status"],
    );
    assertEquals(byId.get("api_requests")!.unit, "ms");
    assertEquals(byId.get("output_size")!.unit, "bytes");

    // The graph reads both of these off the catalogue (§7.1): what a line
    // plots, and how many lines there are.
    assertEquals(byId.get("output_size")!.cumulative, true);
    assertEquals(byId.get("model_size")!.cumulative, true);
    assertEquals(byId.get("api_requests")!.cumulative, false);
    assertEquals(byId.get("memory")!.series, [
      { key: "vram", label: "VRAM" },
      { key: "ram", label: "RAM" },
    ]);
  });
});

Deno.test("every api request is recorded under its route pattern, and the reports are not", async () => {
  await withTestApp(async (app) => {
    await app.json("/api/config");
    await app.json("/api/workflows");
    await app.json("/api/outputs?limit=5");
    // A 404 from a route that matched is still that route's entry.
    const missing = await app.fetch("/api/outputs/nope");
    assertEquals(missing.status, 404);
    // A path that matched nothing is filed under one route name, never under
    // the path it asked for (§7.1).
    const unrouted = await app.fetch("/api/not-a-thing");
    assertEquals(unrouted.status, 404);

    const page = await entries(app, "api_requests", "limit=50");
    const routes = page.entries.map((entry) => entry.route);
    assert(routes.includes("/api/config"), `config missing from ${routes}`);
    assert(routes.includes("/api/workflows"));
    assert(routes.includes("/api/outputs"));
    assert(routes.includes("/api/outputs/:id"));
    // Reading a report does not fill the report in.
    assertEquals(
      routes.some((route) => route?.startsWith("/api/telemetry")),
      false,
    );

    const config = page.entries.find((entry) => entry.route === "/api/config")!;
    assertEquals(config.method, "GET");
    assertEquals(config.status, 200);
    assert(config.value >= 0, "a duration was measured");
    assertEquals(config.data.path, "/api/config");
    // The raw entry the sidebar shows is on the row already (§11.2).
    assertEquals(config.data.method, "GET");

    const byRoute = page.entries.find((entry) =>
      entry.route === "/api/outputs/:id"
    )!;
    assertEquals(byRoute.status, 404);
    assertEquals(byRoute.data.path, "/api/outputs/nope");
    const unmatched = page.entries.find((entry) =>
      entry.route === "(no route)"
    )!;
    assertEquals(unmatched.status, 404);
    assertEquals(unmatched.data.path, "/api/not-a-thing");

    // The filters the chips read as, over the same rows.
    const byMethod = await entries(app, "api_requests", "method=GET&limit=50");
    assertEquals(
      byMethod.entries.every((entry) => entry.method === "GET"),
      true,
    );
    const slow = await series(app, "api_requests", "min_value=1000000");
    assertEquals(slow.series, []);
    assertEquals(slow.total, 0);

    const statuses = await entries(app, "api_requests", "status=404&limit=50");
    assertEquals(
      statuses.entries.every((entry) => entry.status === 404),
      true,
    );
  });
});

Deno.test("the table pages and the graph does not", async () => {
  await withTestApp(async (app) => {
    // Enough requests that one page cannot hold them.
    for (let i = 0; i < 12; i++) await app.json("/api/config");

    const first = await entries(app, "api_requests", "limit=5");
    assertEquals(first.entries.length, 5);
    assert(first.cursor !== null, "there is a next page");
    const second = await entries(
      app,
      "api_requests",
      `limit=5&cursor=${encodeURIComponent(first.cursor!)}`,
    );
    assertEquals(second.entries.length, 5);
    // Newest first, and no row appears twice.
    const ids = new Set([
      ...first.entries.map((entry) => entry.id),
      ...second.entries.map((entry) => entry.id),
    ]);
    assertEquals(ids.size, 10);

    // The graph asks for all of it for all time (§11.2).
    const graph = await series(app, "api_requests");
    // One line, and it is the only one: this report declares no series.
    assertEquals(graph.series.length, 1);
    assertEquals(graph.series[0]!.key, null);
    const points = graph.series[0]!.points;
    assert(points.length >= 12, `got ${points.length} points`);
    assertEquals(graph.truncated, false);
    assertEquals(graph.total, points.length);
    for (let i = 1; i < points.length; i++) {
      assert(points[i - 1]!.at <= points[i]!.at, "points are oldest first");
    }

    // A report that does not exist is a 404, and a bad cursor is a 400.
    assertEquals((await app.fetch("/api/telemetry/nope/series")).status, 404);
    assertEquals(
      (await app.fetch("/api/telemetry/api_requests/entries?cursor=??")).status,
      400,
    );
    assertEquals(
      (await app.fetch("/api/telemetry/api_requests/entries?limit=0")).status,
      400,
    );
  });
});

Deno.test("the log records its own size for every entry but its own", async () => {
  await withTestApp(async (app) => {
    await app.json("/api/config");
    const sizes = await entries(app, "telemetry_size", "limit=50");
    assert(sizes.entries.length > 0, "the size report has entries");
    // Every size entry names the report that caused it, and none names this
    // one: that is the rule that makes it terminate (§7.1).
    assertEquals(
      sizes.entries.every((entry) => entry.label !== "telemetry_size"),
      true,
    );
    const caused = sizes.entries[0]!;
    assertEquals(caused.label, "api_requests");
    assert((caused.data.entries as number) > 0);
    assert(caused.value > 0);
  });
});

Deno.test("a generation records an entry per output and a memory window", async () => {
  await withTestApp(async (app) => {
    const submitted = await app.json<{ id: string }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: "krea2",
        params: { prompt: "a telemetry test", size: [64, 64] },
      }),
    });
    const done = await awaitJob(app, submitted.id);
    assertEquals(done.status, "done");
    await app.memory.idle();

    // One entry per file the job produced, sized from disk (§7.1).
    const outputs = await entries(app, "output_size", "limit=50");
    assertEquals(outputs.entries.length, done.outputs.length);
    const output = outputs.entries[0]!;
    assertEquals(output.label, done.outputs[0]);
    assert(output.value > 0, "the output has a size");
    assertEquals(output.family, "krea2");
    assertEquals(output.data.kind, "image");
    assertEquals(output.data.workflow_id, "krea2");

    // The family chip is the one filter this report has.
    assertEquals(
      (await entries(app, "output_size", "family=krea2")).entries.length,
      done.outputs.length,
    );
    assertEquals(
      (await entries(app, "output_size", "family=sdxl")).entries.length,
      0,
    );

    // The output graph is the running total of those entries (§7.1).
    const outputGraph = await series(app, "output_size");
    const cumulative = outputGraph.series[0]!.points.map((point) =>
      point.value
    );
    const sizes = outputs.entries.map((entry) => entry.value).reverse();
    assertEquals(cumulative.length, sizes.length);
    assertEquals(
      cumulative[cumulative.length - 1],
      sizes.reduce((total, size) => total + size, 0),
    );

    // The window opened when the job started executing and closed when it
    // finished, so both ends are on the graph (§7.1).
    const memory = await entries(app, "memory", "limit=50");
    const phases = memory.entries.map((entry) => entry.label);
    assert(phases.includes("start"), `no start in ${phases}`);
    assert(phases.includes("end"), `no end in ${phases}`);

    // Each sample is two entries, and the graph draws them as two lines.
    const vram = memory.entries.find((entry) => entry.series === "vram")!;
    const ram = memory.entries.find((entry) => entry.series === "ram")!;
    // The fake reports 25.7GB of VRAM with 24.0GB free, and 67GB of RAM with
    // 41GB free, so "in use" is the rest of each.
    assertEquals(vram.value, 25_757_220_864 - 24_051_089_408);
    assertEquals(ram.value, 67_108_864_000 - 41_231_686_144);
    assertEquals(vram.data.device, "cuda:0 FakeGPU");
    assertEquals(vram.data.job_id, submitted.id);

    const memoryGraph = await series(app, "memory");
    assertEquals(
      memoryGraph.series.map((line) => line.key).sort(),
      ["ram", "vram"],
    );
    // Nothing keeps sampling once the generation is over.
    assertEquals(app.memory.sampling, false);
  }, { comfy: true });
});

Deno.test("a model scan records what it added, and a later one what it lost", async () => {
  const folders = await Deno.makeTempDir({
    prefix: "forgeui-telemetry-models-",
  });
  const checkpoints = join(folders, "checkpoints");
  const loras = join(folders, "loras");
  await writeFakeSafetensors(join(checkpoints, "sdxl-base.safetensors"), {
    name: "sdxl",
  });
  await writeFakeSafetensors(join(loras, "film-grain.safetensors"), {
    name: "grain",
    bytes: 4096,
  });

  const app = await startTestApp({
    argv: [
      "--models-dir",
      `checkpoints=${checkpoints}`,
      "--models-dir",
      `loras=${loras}`,
    ],
  });
  try {
    // The boot pass is off in tests, so this is the first scan (§8.1).
    await app.models.rescan();
    await app.models.idle();

    const added = await entries(app, "model_size", "limit=50");
    assertEquals(added.entries.length, 2);
    assertEquals(
      added.entries.every((entry) => entry.change === "added"),
      true,
    );
    const lora = added.entries.find((entry) => entry.model_class === "lora")!;
    assertEquals(lora.label, "film-grain");
    assert(lora.value > 0, "the model has a size");
    assertEquals(lora.data.kind, "loras");

    // The model-type chip of §11.2 is the class, not the folder.
    const classes = await entries(app, "model_size", "model_class=diffusion");
    assertEquals(classes.entries.length, 1);
    assertEquals(classes.entries[0]!.label, "sdxl-base");

    // A rescan that finds the same files writes nothing.
    await app.models.rescan();
    await app.models.idle();
    assertEquals(
      (await entries(app, "model_size", "limit=50")).entries.length,
      2,
    );

    // A model that is gone is its own entry, carrying the size it had.
    await Deno.remove(join(loras, "film-grain.safetensors"));
    await app.models.rescan();
    await app.models.idle();
    const after = await entries(app, "model_size", "limit=50");
    assertEquals(after.entries.length, 3);
    assertEquals(after.entries[0]!.change, "deleted");
    assertEquals(after.entries[0]!.label, "film-grain");
    assertEquals(after.entries[0]!.value, lora.value);

    // Three entries, and a line that goes up by each model and back down by
    // the one that left (§7.1).
    const graph = await series(app, "model_size");
    const running = graph.series[0]!.points.map((point) => point.value);
    assertEquals(running.length, 3);
    assertEquals(graph.total, 3);
    // Both models on disk, then the one that left taken back out again.
    const both = added.entries.reduce((total, entry) => total + entry.value, 0);
    assertEquals(running[1], both);
    assertEquals(running[2], both - lora.value);
  } finally {
    await app.dispose();
    await Deno.remove(folders, { recursive: true });
  }
});
