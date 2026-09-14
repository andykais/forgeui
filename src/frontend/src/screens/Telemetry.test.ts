import { beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/svelte";
import type { ModelEntry, TelemetryEntry, TelemetryReport } from "../types.ts";

/**
 * The telemetry table's two columns that name something with a page of its
 * own (§11.2): an output row is its filename, linked to itself in the
 * gallery, and a model row is linked to the model's page.
 */

let reports: TelemetryReport[] = [];
let entries: TelemetryEntry[] = [];

vi.mock("../api.ts", () => ({
  api: {
    telemetryReports: () => Promise.resolve({ reports, bytes: 1024 }),
    telemetrySeries: () =>
      Promise.resolve({ series: [], truncated: false, total: entries.length }),
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

    expect(document.querySelector("tbody td a")?.textContent?.trim()).toBe("01JOUT");
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
