import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ProgressTracker } from "../../src/jobs/progress.ts";
import {
  seedNodeTimings,
  seedNodeTimingsIfEmpty,
} from "../../src/jobs/timings.ts";
import {
  buildSidecar,
  serializeSidecar,
  type SidecarWorkflow,
} from "../../src/jobs/sidecar.ts";
import {
  listNodeTimings,
  nodeTimingsFor,
  updateNodeTimings,
} from "../../src/db/queries.ts";
import { openDatabase } from "../../src/db/db.ts";
import { dataPaths, ensureDataDirs } from "../../src/config/paths.ts";
import { assertGoldenJson, goldenCases } from "../golden/runner.ts";
import type { ApiGraph } from "../../src/workflows/types.ts";
import type { Progress as ProgressRow } from "../../src/db/queries.ts";

/**
 * §5.1: the ETA is the elapsed weight of what is done over the weight of the
 * whole graph, with `node_timings` supplying the weights. The golden cases
 * are the same event sequence read twice — once by a workflow nobody has run
 * and once by one with a history — so the difference is the whole point.
 */

type Event =
  | { kind: "start" }
  | { kind: "cached"; nodes: string[] }
  | { kind: "executing"; node: string | null }
  | { kind: "progress"; node: string; value: number; max: number }
  | { kind: "advance"; ms: number }
  | { kind: "finish" };

interface Case {
  graph: ApiGraph;
  weights?: Record<string, number>;
  events: Event[];
}

function replay(input: Case): ProgressRow[] {
  let now = 1_000;
  const tracker = new ProgressTracker(input.graph, {
    now: () => now,
    weights: new Map(Object.entries(input.weights ?? {})),
  });
  const snapshots: ProgressRow[] = [];
  for (const event of input.events) {
    switch (event.kind) {
      case "start":
        tracker.start();
        break;
      case "cached":
        tracker.cached(event.nodes);
        break;
      case "executing":
        tracker.executing(event.node);
        break;
      case "progress":
        tracker.progress(event.node, event.value, event.max);
        break;
      case "advance":
        now += event.ms;
        break;
      case "finish":
        tracker.finish();
        break;
    }
    snapshots.push(tracker.snapshot());
  }
  return snapshots;
}

Deno.test("golden progress sequences", async (t) => {
  for (const testCase of await goldenCases("progress")) {
    await t.step(testCase.name, async () => {
      const input = await testCase.json<Case>("input.json");
      await assertGoldenJson(testCase.file("expected.json"), replay(input));
    });
  }
});

Deno.test("weights move the percentage onto the node that takes the time", () => {
  const graph: ApiGraph = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: {} },
    "3": { class_type: "KSampler", inputs: {} },
    "9": { class_type: "SaveImage", inputs: {} },
  };
  const events: Event[] = [
    { kind: "start" },
    { kind: "executing", node: "1" },
    { kind: "advance", ms: 100 },
    { kind: "executing", node: "3" },
  ];

  // Equal weights: one node of three.
  assertEquals(replay({ graph, events }).at(-1)?.pct, 33.3);
  // With history, the loader is a rounding error and the sampler is the run.
  const weighted = replay({
    graph,
    weights: { "1": 100, "3": 9800, "9": 100 },
    events,
  }).at(-1)!;
  assertEquals(weighted.pct, 1);
  // …so the ETA is ten seconds, not two hundred milliseconds.
  assertEquals(weighted.eta_ms, 9900);
});

Deno.test("a workflow with history has an ETA before anything finishes", () => {
  const graph: ApiGraph = {
    "3": { class_type: "KSampler", inputs: {} },
    "9": { class_type: "SaveImage", inputs: {} },
  };
  const cold = replay({ graph, events: [{ kind: "start" }] }).at(-1)!;
  assertEquals(cold.eta_ms, null, "nothing to go on, so nothing is claimed");

  const warm = replay({
    graph,
    weights: { "3": 8000, "9": 200 },
    events: [{ kind: "start" }, { kind: "advance", ms: 1500 }],
  }).at(-1)!;
  assertEquals(warm.pct, 0);
  assertEquals(warm.eta_ms, 6700, "what it took last time, less the elapsed");
});

Deno.test("the average is exponentially weighted, so it follows the machine", () => {
  const dir = Deno.makeTempDirSync({ prefix: "forgeui-timings-" });
  const db = openDatabase(join(dir, "app.db"));
  try {
    updateNodeTimings(db, "sha256:w", { "3": 10_000, "9": 100 });
    assertEquals(nodeTimingsFor(db, "sha256:w").get("3"), 10_000);
    assertEquals(listNodeTimings(db, "sha256:w")[0]?.samples, 1);

    // A run twice as fast pulls the average 30% of the way (α = 0.3).
    updateNodeTimings(db, "sha256:w", { "3": 5000 });
    assertEquals(nodeTimingsFor(db, "sha256:w").get("3"), 8500);
    assertEquals(listNodeTimings(db, "sha256:w")[0]?.samples, 2);

    // Another workflow keeps its own history.
    updateNodeTimings(db, "sha256:other", { "3": 200 });
    assertEquals(nodeTimingsFor(db, "sha256:other").get("3"), 200);
    assertEquals(nodeTimingsFor(db, "sha256:w").get("3"), 8500);
    // A job with no workflow behind it has nowhere to record anything.
    assertEquals(updateNodeTimings(db, null, { "3": 1 }), 0);
  } finally {
    db.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("seeding reads every sidecar, and reading twice changes nothing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-seed-" });
  const paths = dataPaths(dir);
  await ensureDataDirs(paths);
  const db = openDatabase(paths.db);
  try {
    const workflow: SidecarWorkflow = {
      id: "sd15",
      name: "Stable Diffusion 1.5",
      hash: "sha256:w",
      family: "sd15",
      kind: "image",
    };
    const write = async (
      day: string,
      jobId: string,
      nodes: Record<string, number>,
      hash: string | null = "sha256:w",
    ) => {
      const folder = join(paths.outputs, day);
      await Deno.mkdir(folder, { recursive: true });
      await Deno.writeTextFile(
        join(folder, `${jobId}.json`),
        serializeSidecar(buildSidecar({
          job_id: jobId,
          created_at: "2026-09-05T12:00:00Z",
          workflow: hash === null ? null : { ...workflow, hash },
          params: {},
          api_graph: null,
          outputs: [{ file: `${jobId}-0.png`, kind: "image" }],
          timing: { total_ms: 10_000, nodes },
        })),
      );
    };
    // Oldest first: the average is only meaningful played forwards.
    await write("2026/09/01", "01JAAA", { "3": 10_000, "9": 100 });
    await write("2026/09/02", "01JBBB", { "3": 5000, "9": 100 });
    await write("2026/09/03", "01JCCC", {}, null); // no workflow, nothing to learn
    await Deno.writeTextFile(
      join(paths.outputs, "2026/09/03", "broken.json"),
      "{ not json",
    );

    const first = await seedNodeTimings({ db, paths });
    assertEquals(first.sidecars, 2);
    assertEquals(first.workflows, 1);
    assertEquals(first.nodes, 2);
    assertEquals(first.skipped, 2, "the empty one and the broken one");
    // 10000, then 30% of the way to 5000.
    assertEquals(nodeTimingsFor(db, "sha256:w").get("3"), 8500);
    assertEquals(listNodeTimings(db, "sha256:w").map((row) => row.samples), [
      2,
      2,
    ]);

    // Seeding is a rebuild: the same files give the same table (§7).
    const before = listNodeTimings(db, "sha256:w");
    const second = await seedNodeTimings({ db, paths });
    assertEquals(second, first);
    assertEquals(listNodeTimings(db, "sha256:w"), before);

    // The boot pass only runs when nobody has filled the table.
    assertEquals(await seedNodeTimingsIfEmpty({ db, paths }), null);
    db.exec("DELETE FROM node_timings");
    const seeded = await seedNodeTimingsIfEmpty({ db, paths });
    assert(seeded !== null);
    assertEquals(listNodeTimings(db, "sha256:w"), before);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});
