import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  openTelemetryDatabase,
  TELEMETRY_SCHEMA_VERSION,
} from "../../src/telemetry/db.ts";
import { TelemetryStore } from "../../src/telemetry/store.ts";
import {
  decodeEntryCursor,
  listModelSizes,
  listSeries,
  totalEntries,
} from "../../src/telemetry/queries.ts";
import { CursorError } from "../../src/outputs/cursor.ts";
import { VramMonitor } from "../../src/telemetry/vram.ts";

/**
 * The telemetry log in isolation (§7.1): its own database, the entry shapes
 * the five reports record, the filters the chips read as, and the two rules
 * that keep it from observing itself.
 */

interface Harness {
  store: TelemetryStore;
  now: { at: number };
  dispose(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-telemetry-" });
  const db = openTelemetryDatabase(join(dir, "telemetry.db"));
  const now = { at: 1_760_000_000_000 };
  return {
    store: new TelemetryStore({ db, now: () => now.at }),
    now,
    async dispose() {
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function withHarness(body: (h: Harness) => Promise<void> | void) {
  const h = await harness();
  try {
    await body(h);
  } finally {
    await h.dispose();
  }
}

Deno.test("the telemetry database is its own file at its own version", async () => {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-telemetry-" });
  try {
    const path = join(dir, "telemetry.db");
    const db = openTelemetryDatabase(path);
    assertEquals(
      db.prepare("PRAGMA user_version").value<[number]>()?.[0],
      TELEMETRY_SCHEMA_VERSION,
    );
    assertEquals(
      db.prepare("PRAGMA journal_mode").value<[string]>()?.[0],
      "wal",
    );
    db.close();
    // Reopening an existing file runs no migration twice.
    const again = openTelemetryDatabase(path);
    assertEquals(
      again.prepare("PRAGMA user_version").value<[number]>()?.[0],
      TELEMETRY_SCHEMA_VERSION,
    );
    again.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("every entry but a size entry records the log's new size", async () => {
  await withHarness(({ store }) => {
    store.recordApiRequest({
      method: "GET",
      route: "/api/outputs",
      path: "/api/outputs",
      status: 200,
      duration_ms: 12.5,
    });
    assertEquals(store.count("api_requests"), 1);
    // The size report follows the request entry, and nothing follows it: the
    // log would otherwise never stop writing about itself (§7.1).
    assertEquals(store.count("telemetry_size"), 1);
    assertEquals(totalEntries(store.db), 2);

    const size = store.entries("telemetry_size").entries[0]!;
    assertEquals(size.label, "api_requests");
    assert(size.value > 0, "the log has a size");
    assertEquals(size.data.report, "api_requests");
    assertEquals(size.data.entries, 2);
  });
});

Deno.test("an api request entry keeps the route pattern and the path apart", async () => {
  await withHarness(({ store }) => {
    store.recordApiRequest({
      method: "GET",
      route: "/api/outputs/:id",
      path: "/api/outputs/01JA-0",
      status: 404,
      duration_ms: 3,
    });
    const entry = store.entries("api_requests").entries[0]!;
    // The pattern is the filterable dimension; the path it matched is raw
    // data only, so one output id cannot crowd out the url filter (§7.1).
    assertEquals(entry.route, "/api/outputs/:id");
    assertEquals(entry.method, "GET");
    assertEquals(entry.status, 404);
    assertEquals(entry.value, 3);
    assertEquals(entry.data.path, "/api/outputs/01JA-0");
  });
});

Deno.test("filters are an OR within a dimension and an AND across them", async () => {
  await withHarness(({ store, now }) => {
    const request = (
      method: string,
      route: string,
      status: number,
      ms: number,
    ) => {
      now.at += 1000;
      store.recordApiRequest({
        method,
        route,
        path: route,
        status,
        duration_ms: ms,
      });
    };
    request("GET", "/api/outputs", 200, 10);
    request("POST", "/api/jobs", 200, 500);
    request("GET", "/api/models", 500, 20);
    request("DELETE", "/api/outputs/:id", 200, 30);

    assertEquals(store.count("api_requests"), 4);
    assertEquals(
      store.count("api_requests", { method: ["GET"] }),
      2,
    );
    assertEquals(
      store.count("api_requests", { method: ["GET", "POST"] }),
      3,
    );
    assertEquals(
      store.count("api_requests", { method: ["GET"], status: [500] }),
      1,
    );
    // `min_value` is the "min duration" chip of §11.2.
    assertEquals(store.count("api_requests", { min_value: 20 }), 3);
    assertEquals(
      store.count("api_requests", { method: ["GET"], min_value: 20 }),
      1,
    );
  });
});

Deno.test("the series is every point under the filters, oldest first", async () => {
  await withHarness(({ store, now }) => {
    for (const ms of [5, 50, 500]) {
      now.at += 60_000;
      store.recordApiRequest({
        method: "GET",
        route: "/api/outputs",
        path: "/api/outputs",
        status: 200,
        duration_ms: ms,
      });
    }
    const series = store.series("api_requests");
    assertEquals(series.points.map((point) => point.value), [5, 50, 500]);
    assertEquals(series.truncated, false);
    // Sorted by time, which for the graph is the x axis.
    assert(series.points[0]!.at < series.points[2]!.at);

    const filtered = store.series("api_requests", { min_value: 50 });
    assertEquals(filtered.points.map((point) => point.value), [50, 500]);
  });
});

Deno.test("a series past the cap keeps the newest points and says so", async () => {
  await withHarness(({ store, now }) => {
    for (let i = 0; i < 6; i++) {
      now.at += 1000;
      store.recordVram({
        phase: "tick",
        used: i,
        free: 1,
        total: 2,
        device: "cuda:0",
      });
    }
    const capped = listSeries(store.db, "vram", {}, 4);
    assertEquals(capped.truncated, true);
    assertEquals(capped.points.map((point) => point.value), [2, 3, 4, 5]);
  });
});

Deno.test("entries page backwards through time on one keyset cursor", async () => {
  await withHarness(({ store, now }) => {
    for (let i = 0; i < 5; i++) {
      now.at += 1000;
      store.recordOutput({
        output_id: `job-${i}`,
        path: `outputs/2026/09/11/job-${i}.png`,
        bytes: 1000 + i,
        kind: "image",
        family: i % 2 === 0 ? "flux" : "sdxl",
        workflow_id: "krea2",
        job_id: "job",
      });
    }
    const first = store.entries("output_size", { limit: 2 });
    assertEquals(first.entries.map((entry) => entry.label), ["job-4", "job-3"]);
    assert(first.cursor !== null, "there is more to read");

    const second = store.entries("output_size", {
      limit: 2,
      cursor: decodeEntryCursor(first.cursor!),
    });
    assertEquals(second.entries.map((entry) => entry.label), [
      "job-2",
      "job-1",
    ]);

    const third = store.entries("output_size", {
      limit: 2,
      cursor: decodeEntryCursor(second.cursor!),
    });
    assertEquals(third.entries.map((entry) => entry.label), ["job-0"]);
    // The last page says so rather than handing back an empty one.
    assertEquals(third.cursor, null);

    // The family filter narrows the same list the chips do.
    const flux = store.entries("output_size", {
      filters: { family: ["flux"] },
    });
    assertEquals(flux.entries.map((entry) => entry.label), [
      "job-4",
      "job-2",
      "job-0",
    ]);
  });

  assertThrows(() => decodeEntryCursor("not-a-cursor"), CursorError);
});

Deno.test("a model pass records what changed and nothing else", async () => {
  await withHarness(({ store, now }) => {
    const sdxl = {
      path: "/models/checkpoints/sdxl.safetensors",
      size: 6_000_000_000,
      model_class: "diffusion",
      family: "sdxl",
      kind: "checkpoints",
      display_name: "SDXL",
    };
    const grain = {
      path: "/models/loras/grain.safetensors",
      size: 200_000_000,
      model_class: "lora",
      family: null,
      kind: "loras",
      display_name: "Film grain",
    };

    assertEquals(store.recordModelPass([sdxl, grain]), {
      added: 2,
      deleted: 0,
    });
    assertEquals(store.count("model_size"), 2);
    assertEquals(listModelSizes(store.db).size, 2);

    // Startup and every rescan call this; an unchanged pass writes nothing.
    now.at += 60_000;
    assertEquals(store.recordModelPass([sdxl, grain]), {
      added: 0,
      deleted: 0,
    });
    assertEquals(store.count("model_size"), 2);

    // A model that is gone is an entry of its own, carrying the size it had.
    now.at += 60_000;
    assertEquals(store.recordModelPass([sdxl]), { added: 0, deleted: 1 });
    const deleted = store.entries("model_size").entries[0]!;
    assertEquals(deleted.change, "deleted");
    assertEquals(deleted.label, "Film grain");
    assertEquals(deleted.value, grain.size);
    assertEquals(deleted.model_class, "lora");

    // A file whose size moved is recorded again: it is new bytes on disk.
    now.at += 60_000;
    assertEquals(
      store.recordModelPass([{ ...sdxl, size: sdxl.size + 1024 }]),
      { added: 1, deleted: 0 },
    );
    const regrown = store.entries("model_size").entries[0]!;
    assertEquals(regrown.change, "added");
    assertEquals(regrown.data.previous_size, sdxl.size);
  });
});

Deno.test("the catalogue offers the values a report has actually recorded", async () => {
  await withHarness(({ store }) => {
    store.recordApiRequest({
      method: "GET",
      route: "/api/outputs",
      path: "/api/outputs",
      status: 200,
      duration_ms: 1,
    });
    store.recordApiRequest({
      method: "POST",
      route: "/api/jobs",
      path: "/api/jobs",
      status: 503,
      duration_ms: 2,
    });

    const catalogue = store.catalogue();
    assertEquals(catalogue.map((report) => report.id), [
      "api_requests",
      "output_size",
      "model_size",
      "vram",
      "telemetry_size",
    ]);

    const requests = catalogue[0]!;
    const methods = requests.filters.find((filter) => filter.key === "method");
    assertEquals(methods?.options?.map((option) => option.value), [
      "GET",
      "POST",
    ]);
    assertEquals(
      methods?.options?.every((option) => option.entries === 1),
      true,
    );
    // Numeric dimensions come back as numbers, so a chip reads `200`.
    const status = requests.filters.find((filter) => filter.key === "status");
    assertEquals(status?.options?.map((option) => option.value), [200, 503]);
    // `min duration` is typed, not picked, so it offers nothing.
    const min = requests.filters.find((filter) => filter.key === "min_value");
    assertEquals(min?.options, undefined);

    // A report nothing has recorded lists no options rather than guessing.
    const models = catalogue[2]!;
    assertEquals(
      models.filters.every((filter) => filter.options?.length === 0),
      true,
    );
    assertEquals(models.entries, 0);
  });
});

Deno.test("the vram monitor samples a generation's start, ticks and end", async () => {
  await withHarness(async ({ store }) => {
    let reading: { free: number | null; total: number | null } = {
      free: 4_000_000_000,
      total: 10_000_000_000,
    };
    const monitor = new VramMonitor({
      store,
      read: () => Promise.resolve({ ...reading, device: "cuda:0" }),
      intervalMs: 20,
    });

    monitor.generationStarted("job-a");
    await monitor.idle();
    assertEquals(store.count("vram"), 1);
    assertEquals(store.entries("vram").entries[0]!.label, "start");
    // The value is what is in use, not what is free.
    assertEquals(store.entries("vram").entries[0]!.value, 6_000_000_000);

    // A second job does not restart the window.
    monitor.generationStarted("job-b");
    await monitor.idle();
    assertEquals(store.count("vram"), 1);
    assert(monitor.sampling, "still sampling while a job runs");

    await new Promise((resolve) => setTimeout(resolve, 70));
    await monitor.idle();
    const ticks = store.entries("vram").entries.filter((entry) =>
      entry.label === "tick"
    );
    assert(ticks.length >= 2, `expected ticks, got ${ticks.length}`);

    // The window closes only with the last job, and closing takes a sample.
    monitor.generationFinished("job-a");
    await monitor.idle();
    assert(monitor.sampling, "job-b is still running");
    monitor.generationFinished("job-b");
    await monitor.idle();
    assertEquals(monitor.sampling, false);
    assertEquals(store.entries("vram").entries[0]!.label, "end");

    // Nothing is sampled once the window is shut.
    const settled = store.count("vram");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await monitor.idle();
    assertEquals(store.count("vram"), settled);

    // Without both numbers there is nothing to plot, so nothing is written.
    reading = { free: null, total: null };
    monitor.sample("tick");
    await monitor.idle();
    assertEquals(store.count("vram"), settled);
    monitor.stop();
  });
});
