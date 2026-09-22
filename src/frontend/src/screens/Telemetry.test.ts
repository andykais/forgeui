import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import type {
  ModelEntry,
  TelemetryEntry,
  TelemetryLine,
  TelemetryReport,
} from "../types.ts";

/**
 * The telemetry table (§11.2): the two columns that name something with a
 * page of its own — an output row is its filename, linked to itself in the
 * gallery, and a model row is linked to the model's page — and the line the
 * graph draws where the row under the pointer falls in its span.
 */

let reports: TelemetryReport[] = [];
let entries: TelemetryEntry[] = [];
let series: TelemetryLine[] = [];

vi.mock("../api.ts", () => ({
  api: {
    telemetryReports: () => Promise.resolve({ reports, bytes: 1024 }),
    telemetrySeries: () =>
      Promise.resolve({ series, truncated: false, total: entries.length }),
    telemetryEntries: () => Promise.resolve({ entries, cursor: null }),
  },
}));

const library: ModelEntry[] = [];
vi.mock("../stores/app.svelte.ts", () => ({
  app: {
    modelByPath: (path: string) =>
      library.find((model) => model.path === path) ?? null,
  },
}));

const { default: Telemetry } = await import("./Telemetry.svelte");

function report(overrides: Partial<TelemetryReport>): TelemetryReport {
  return {
    id: "output_size",
    title: "Output Size",
    description: "",
    unit: "bytes",
    value_label: "Size on disk",
    shape: "total",
    columns: [],
    filters: [],
    entries: 1,
    ...overrides,
  };
}

function entry(overrides: Partial<TelemetryEntry>): TelemetryEntry {
  return {
    id: 1,
    report: "output_size",
    at: 1_789_000_000_000,
    value: 1_400_000,
    label: null,
    method: null,
    route: null,
    status: null,
    family: null,
    model_class: null,
    change: null,
    series: null,
    data: {},
    ...overrides,
  };
}

/** The screen loads its report and its rows on mount; wait for the rows. */
async function mount() {
  render(Telemetry);
  await vi.waitFor(() => {
    if (document.querySelectorAll("tbody tr").length === 0) {
      throw new Error("no rows yet");
    }
  });
}

describe("the telemetry table", () => {
  beforeEach(() => {
    library.length = 0;
    reports = [];
    entries = [];
    series = [];
    history.replaceState(null, "", "/telemetry");
  });

  test("an output is named by its file and links to itself in the gallery", async () => {
    reports = [
      report({ columns: [{ key: "label", label: "Output", kind: "output" }] }),
    ];
    entries = [
      entry({
        label: "01JOUT",
        data: { output_id: "01JOUT", path: "outputs/2026/09/11/01JOUT-0.png" },
      }),
    ];
    await mount();

    const link = document.querySelector("tbody td a");
    // The generated id names this row to the database and to nobody else.
    expect(link?.textContent?.trim()).toBe("01JOUT-0.png");
    expect(link?.getAttribute("href")).toBe("/gallery?output=01JOUT");
  });

  test("an output whose row recorded no path still says which one it is", async () => {
    reports = [
      report({ columns: [{ key: "label", label: "Output", kind: "output" }] }),
    ];
    entries = [entry({ label: "01JOUT", data: {} })];
    await mount();

    expect(document.querySelector("tbody td a")?.textContent?.trim()).toBe(
      "01JOUT",
    );
  });

  test("a model links to its own page", async () => {
    library.push({
      id: "f".repeat(64),
      hash: "f".repeat(64),
      path: "loras/film-grain-35mm.safetensors",
      name: "film-grain-35mm.safetensors",
    } as ModelEntry);
    reports = [
      report({
        id: "model_size",
        title: "Model Size",
        columns: [{ key: "label", label: "Model", kind: "model" }],
      }),
    ];
    entries = [
      entry({
        report: "model_size",
        label: "Film grain 35mm",
        data: { path: "loras/film-grain-35mm.safetensors" },
      }),
    ];
    await mount();

    const link = document.querySelector("tbody td a");
    expect(link?.textContent?.trim()).toBe("Film grain 35mm");
    expect(link?.getAttribute("href")).toBe(`/models/${"f".repeat(64)}`);
  });

  test("a model that has since gone is left as plain text", async () => {
    // The report is a record of what the folders held, so a deleted model is
    // still a row — and there is no page to send anyone to.
    reports = [
      report({
        id: "model_size",
        title: "Model Size",
        columns: [{ key: "label", label: "Model", kind: "model" }],
      }),
    ];
    entries = [
      entry({
        report: "model_size",
        label: "Film grain 35mm",
        change: "deleted",
        data: { path: "loras/film-grain-35mm.safetensors" },
      }),
    ];
    await mount();

    expect(document.querySelector("tbody td a")).toBeNull();
    expect(document.querySelector("tbody td")?.textContent?.trim()).toBe(
      "Film grain 35mm",
    );
  });
});

/** The graph marks the row the pointer is on (§11.2). */
describe("pointing at a row", () => {
  const WHEN = [1_789_000_000_000, 1_789_000_060_000, 1_789_000_120_000];

  beforeEach(() => {
    reports = [
      report({
        shape: "events",
        columns: [
          { key: "at", label: "When", kind: "time" },
          { key: "value", label: "Size", kind: "value" },
        ],
      }),
    ];
    // Newest first in the table, oldest first in the series: the two halves
    // come from different routes and are ordered as each is read.
    entries = WHEN.map((at, index) => entry({ id: index + 1, at })).reverse();
    series = [
      {
        key: null,
        points: WHEN.map((at, index) => ({ id: index + 1, at, value: 10 })),
      },
    ];
  });

  function markX(): number | null {
    const line = document.querySelector("svg line.mark");
    return line === null ? null : Number(line.getAttribute("x1"));
  }

  test("the graph draws a line where that entry falls, and clears it after", async () => {
    await mount();
    expect(markX()).toBeNull();

    const rows = [...document.querySelectorAll("tbody tr")];
    await fireEvent.mouseEnter(rows[0]!);
    const newest = markX();
    expect(newest).not.toBeNull();

    await fireEvent.mouseEnter(rows[2]!);
    const oldest = markX();
    expect(oldest).not.toBeNull();
    // The table reads newest first, so the last row sits to the left of the
    // first one — the line follows the time, not the row's position.
    expect(oldest!).toBeLessThan(newest!);

    await fireEvent.mouseLeave(document.querySelector("tbody")!);
    expect(markX()).toBeNull();
  });

  test("a row from before the drawn span is not pinned to the edge", async () => {
    // The series is capped at the newest points; the table pages past them.
    // A line at the edge would say an entry is there when it is not.
    entries = [entry({ id: 9, at: WHEN[0]! - 3_600_000 }), ...entries];
    await mount();
    await fireEvent.mouseEnter(document.querySelectorAll("tbody tr")[0]!);
    expect(markX()).toBeNull();
  });

  test("the keyboard gets the same line", async () => {
    await mount();
    await fireEvent.focus(document.querySelectorAll("tbody tr")[1]!);
    expect(markX()).not.toBeNull();
  });
});
