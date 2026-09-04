import { assertEquals, assertObjectMatch, assertThrows } from "@std/assert";
import {
  buildSidecar,
  isoSeconds,
  parseSidecar,
  serializeSidecar,
  SidecarError,
  type SidecarInit,
} from "../../src/jobs/sidecar.ts";
import { APP_VERSION } from "../../src/version.ts";
import { fixtureSidecar } from "../fixtures/sidecar.ts";
import { assertGoldenJson, goldenCases } from "../golden/runner.ts";

Deno.test("timestamps are UTC seconds", () => {
  assertEquals(
    isoSeconds(new Date(Date.UTC(2026, 8, 3, 18, 12, 4, 567))),
    "2026-09-03T18:12:04Z",
  );
  assertEquals(isoSeconds("2026-09-03T18:12:04.999Z"), "2026-09-03T18:12:04Z");
  assertThrows(() => isoSeconds("not a date"), SidecarError);
});

Deno.test("a built sidecar carries the app version and the §6.2 field order", () => {
  const sidecar = fixtureSidecar();
  assertEquals(sidecar.app_version, APP_VERSION);
  assertEquals(Object.keys(sidecar), [
    "app_version",
    "job_id",
    "created_at",
    "workflow",
    "params",
    "models",
    "api_graph",
    "outputs",
    "timing",
    "raw",
  ]);
});

Deno.test("sidecars round-trip through JSON", () => {
  const sidecar = fixtureSidecar();
  assertEquals(parseSidecar(serializeSidecar(sidecar)), sidecar);
});

Deno.test("unknown fields survive a round-trip", () => {
  const sidecar = fixtureSidecar();
  const fromTheFuture = {
    ...sidecar,
    lineage: { parents: ["01JOLD-0"] },
    outputs: [{ ...sidecar.outputs[0]!, colour_space: "srgb" }],
  };
  const text = JSON.stringify(fromTheFuture);
  const parsed = parseSidecar(text);
  assertEquals(parsed.lineage, { parents: ["01JOLD-0"] });
  assertEquals(parsed.outputs[0]?.colour_space, "srgb");
  assertEquals(JSON.parse(serializeSidecar(parsed)), fromTheFuture);
});

Deno.test("an imported sample has no workflow and keeps raw data", () => {
  const sidecar = buildSidecar({
    job_id: "01JSAMPLE",
    created_at: "2026-09-03T18:12:04Z",
    workflow: null,
    params: {},
    api_graph: null,
    outputs: [{ file: "01JSAMPLE-0.png", kind: "image" }],
    raw: { infotext: "Steps: 28, Sampler: Euler", source: "civitai" },
  });
  assertObjectMatch(parseSidecar(serializeSidecar(sidecar)), {
    workflow: null,
    api_graph: null,
    raw: { source: "civitai" },
  });
});

Deno.test("malformed sidecars are rejected with the field that is wrong", () => {
  assertThrows(() => parseSidecar("{"), SidecarError, "invalid JSON");
  const sidecar = fixtureSidecar() as Record<string, unknown>;
  const without = (key: string) => {
    const copy = { ...sidecar };
    delete copy[key];
    return JSON.stringify(copy);
  };
  assertThrows(() => parseSidecar(without("job_id")), SidecarError, "job_id");
  assertThrows(() => parseSidecar(without("timing")), SidecarError, "timing");
  assertThrows(
    () =>
      parseSidecar(
        JSON.stringify({ ...sidecar, outputs: [{ file: "x", kind: "audio" }] }),
      ),
    SidecarError,
    "expected image or video",
  );
});

Deno.test("golden sidecars", async (t) => {
  for (const testCase of await goldenCases("sidecar")) {
    await t.step(testCase.name, async () => {
      const init = await testCase.json<SidecarInit>("init.json");
      await assertGoldenJson(
        testCase.file("expected.json"),
        buildSidecar(init),
      );
    });
  }
});
