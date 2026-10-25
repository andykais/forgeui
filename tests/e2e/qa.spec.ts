import { expect, type Page, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The visual QA walk: every screen, and the states of it worth looking at,
 * photographed into one folder for `deno task qa` to lay out as a contact
 * sheet (`scripts/visual_qa.ts`). Not part of any suite.
 *
 * Nothing in here asserts the app is right — that is the reviewer's eye, and
 * the other specs' job. A step that cannot reach its state is photographed
 * anyway, as whatever the screen shows instead, and marked failed on the
 * sheet: a broken screen is exactly what this is for, so it must not stop
 * the walk. Console errors and uncaught exceptions are counted per shot.
 *
 * When a change adds a screen or a state someone would want to see, add a
 * `shot()` for it here.
 */
const out = process.env.FORGEUI_QA_DIR;
const comfyUrl = "http://127.0.0.1:8296";

test.skip(!out, "run through `deno task qa`, which sets FORGEUI_QA_DIR");
test.describe.configure({ mode: "serial" });

interface Entry {
  file: string;
  group: string;
  title: string;
  note: string;
  viewport: string;
  url: string;
  error: string | null;
  console: string[];
}

const entries: Entry[] = [];
const consoleBuffer: string[] = [];

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function watchConsole(page: Page) {
  page.on("console", (message) => {
    if (message.type() === "error") consoleBuffer.push(message.text());
  });
  page.on("pageerror", (error) => consoleBuffer.push(`uncaught: ${error.message}`));
}

/** Let media decode and animations finish, without ever failing the shot. */
async function settle(page: Page) {
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll<HTMLImageElement>("img")].every(
          (image) => image.complete,
        ),
      null,
      { timeout: 5_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(300);
}

/**
 * Bring the page to a state with `setup`, then photograph it. `setup` may
 * fail; the shot is taken regardless and carries the error.
 */
async function shot(
  page: Page,
  group: string,
  title: string,
  note: string,
  setup?: () => Promise<unknown>,
  /** The state is an error on purpose; its console errors are not news. */
  expectErrors = false,
) {
  let error: string | null = null;
  try {
    await setup?.();
  } catch (caught) {
    error = (caught instanceof Error ? caught.message : String(caught))
      // deno-lint-ignore no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(0, 4)
      .join("\n");
  }
  await settle(page);
  const viewport = page.viewportSize();
  const file = `${String(entries.length + 1).padStart(3, "0")}-${slug(group)}-${
    slug(title)
  }.jpg`;
  await page
    .screenshot({ path: join(out!, "shots", file), type: "jpeg", quality: 72 })
    .catch((caught) => {
      error ??= `screenshot failed: ${caught}`;
    });
  entries.push({
    file,
    group,
    title,
    note,
    viewport: viewport ? `${viewport.width}×${viewport.height}` : "?",
    url: page.url().replace(/^https?:\/\/[^/]+/, ""),
    error,
    console: consoleBuffer.splice(0).filter(() => !expectErrors),
  });
  // After every shot, so a walk that dies part way still leaves a sheet.
  writeFileSync(join(out!, "manifest.json"), JSON.stringify(entries, null, 2));
}

async function connected(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByText("ComfyUI connected")).toBeVisible({ timeout: 30_000 });
}

async function pickWorkflow(page: Page, name: RegExp) {
  await page.locator(".workflow-card").click();
  await page.getByRole("button", { name }).first().click();
  await expect(page.locator('[data-panel-loading="false"]')).toBeVisible();
}

async function generate(page: Page, workflow: RegExp, prompt: string) {
  await pickWorkflow(page, workflow);
  await page.locator('[data-param="prompt"] textarea').fill(prompt);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
}

/** Every scrolled container to its end, for the bottom half of long screens. */
async function scrollToBottom(page: Page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll<HTMLElement>("*")) {
      const style = getComputedStyle(element);
      if (
        /(auto|scroll)/.test(style.overflowY) &&
        element.scrollHeight > element.clientHeight
      ) {
        element.scrollTop = element.scrollHeight;
      }
    }
  });
}

async function closePopovers(page: Page) {
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  await page.mouse.move(0, 0);
}

/** The LoRA fixture serve.ts writes, as the library has it. */
async function aLora(page: Page): Promise<string | null> {
  const body = await (await page.request.get("/api/models?kind=loras")).json();
  return body.models?.[0]?.id ?? null;
}

const GENERATE_LAYOUTS = {
  columns: "3 vertical columns: input, media, metadata",
  split: "2 vertical columns: input, then media above metadata",
  wide: "2 vertical columns: input, media — no metadata",
  top: "2 horizontal rows: media, then input — no metadata",
  "top-split": "Media across the top; input and metadata in 2 columns below",
  "media-split": "Media and metadata, in 2 columns — no input panel",
  media: "Just media — no input panel, no metadata",
} as const;

const GALLERY_LAYOUTS = {
  columns: "2 vertical columns: media, metadata",
  split: "2 horizontal rows: media, then metadata",
  wide: "Media only — no metadata",
} as const;

async function chooseLayout(page: Page, label: string) {
  await page.locator(".trigger").first().click();
  await page.getByRole("button", { name: label, exact: true }).click();
}

test.beforeAll(() => {
  mkdirSync(join(out!, "shots"), { recursive: true });
});

test("a fresh install, before anything has been made", async ({ page }) => {
  watchConsole(page);
  const group = "Empty";
  await shot(page, group, "Generate", "First launch: nothing generated yet.", () =>
    connected(page, "/generate"));
  await shot(page, group, "Gallery", "No outputs at all.", () =>
    page.goto("/gallery"));
  await shot(page, group, "Models", "Two fixture LoRAs, possibly still hashing.", () =>
    page.goto("/models"));
  await shot(page, group, "Telemetry", "Only this walk's own requests recorded.", () =>
    page.goto("/telemetry"));
});

test("Generate", async ({ page, request }) => {
  watchConsole(page);
  const group = "Generate";
  await connected(page, "/generate");

  await shot(page, group, "Workflow picker", "Grouped by family and kind.", () =>
    page.locator(".workflow-card").click());
  await closePopovers(page);

  await shot(page, group, "Panel filled", "Krea 2 Turbo with a prompt, Advanced open.", async () => {
    await pickWorkflow(page, /^Krea 2 Turbo prompt/);
    await page
      .locator('[data-param="prompt"] textarea')
      .fill("overgrown concrete stairwell at dusk, volumetric fog, 35mm");
    await page.getByRole("button", { name: /^Advanced/ }).click();
  });

  await shot(page, group, "LoRA picker", "The Add menu of the LoRA chain.", () =>
    page.getByRole("button", { name: /Add/ }).first().click());
  await shot(page, group, "LoRA chain", "Two LoRAs added to the chain.", async () => {
    await page.getByRole("button", { name: /film-grain-35mm/ }).first().click();
    await page.getByRole("button", { name: /Add/ }).first().click();
    await page.getByRole("button", { name: /soft-studio-light/ }).first().click();
  });

  await shot(page, group, "Running and queued", "One job mid-flight, one waiting behind it.", async () => {
    const button = page.getByRole("button", { name: "Generate", exact: true });
    await button.click();
    await button.click();
    await expect(page.locator(".card.running")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".card.queued").first()).toBeVisible();
    await page.waitForTimeout(800);
  });
  await expect(page.locator(".card.running, .card.queued")).toHaveCount(0, {
    timeout: 60_000,
  }).catch(() => {});

  await shot(page, group, "Failed job", "The fake ComfyUI errors mid-graph.", async () => {
    await request.post(`${comfyUrl}/__fake/scenario?name=error-mid-graph`);
    await generate(page, /^Illustrious XL prompt/, "a heron in reeds, this one fails");
    await expect(page.locator(".card.failed")).toBeVisible({ timeout: 30_000 });
  });

  await shot(page, group, "Session grid", "Several finished generations.", async () => {
    for (const prompt of ["a granite bowl of figs, north light", "a fox asleep on warm stone"]) {
      const before = await page.locator(".tile").count();
      await generate(page, /^Illustrious XL prompt/, prompt);
      await expect(page.locator(".tile")).toHaveCount(before + 1, { timeout: 60_000 });
    }
  });

  await shot(page, group, "Focused output", "A tile opened: panel, viewer, metadata.", async () => {
    await page.locator(".tile .surface").first().click();
    await expect(page.getByRole("button", { name: "Reuse parameters →" })).toBeVisible();
  });
  await shot(page, group, "Fullscreen", "`f` in the focused view.", () =>
    page.keyboard.press("f"));
  await page.keyboard.press("Escape");

  await shot(page, group, "Layout picker", "The layout menu open.", () =>
    page.locator(".trigger").first().click());
  await closePopovers(page);
  for (const [layout, label] of Object.entries(GENERATE_LAYOUTS)) {
    if (layout === "columns") continue;
    await shot(page, group, `Layout: ${layout}`, label, () => chooseLayout(page, label));
  }
  await chooseLayout(page, GENERATE_LAYOUTS.columns).catch(() => {});
  await page.keyboard.press("Escape");

  await shot(page, group, "Table view", "The session grid as a table.", () =>
    page.getByRole("button", { name: "Table" }).first().click());
  await page.getByRole("button", { name: /tiles/ }).first().click().catch(() => {});
});

test("Gallery", async ({ page }) => {
  watchConsole(page);
  const group = "Gallery";
  await shot(page, group, "Tiles", "Every output, with the day divider.", async () => {
    await page.goto("/gallery");
    await expect(page.locator(".tile").first()).toBeVisible();
  });
  await shot(page, group, "Small tiles", "The denser grid.", () =>
    page.getByRole("button", { name: "Small tiles" }).click());
  await shot(page, group, "Table", "MODELS chips, size, seed, duration.", () =>
    page.getByRole("button", { name: "Table" }).click());
  await page.getByRole("button", { name: "Small tiles" }).click().catch(() => {});

  await shot(page, group, "Workflow filter", "The workflow chip's menu.", () =>
    page.getByRole("button", { name: /^Workflow/ }).first().click());
  await closePopovers(page);
  await shot(page, group, "Models filter", "The models chip's menu.", () =>
    page.getByRole("button", { name: /^Models/ }).first().click());
  await closePopovers(page);
  await shot(page, group, "Sort menu", "The sort chip's menu.", () =>
    page.getByRole("button", { name: /^Sort|Newest|Oldest/ }).first().click());
  await closePopovers(page);

  await shot(page, group, "Viewer", "Metadata sidebar, FILES, filmstrip.", async () => {
    await page.locator(".tile .surface").first().click();
    await expect(page.getByText("Files")).toBeVisible();
  });
  await shot(page, group, "Viewer bottom", "The sidebar scrolled to its end.", () =>
    scrollToBottom(page));
  await shot(page, group, "Viewer 1:1", "Actual pixels instead of fit.", () =>
    page.getByRole("button", { name: "1:1" }).click());
  await page.getByRole("button", { name: "Fit" }).click().catch(() => {});
  for (const [layout, label] of Object.entries(GALLERY_LAYOUTS)) {
    if (layout === "columns") continue;
    await shot(page, group, `Layout: ${layout}`, label, () => chooseLayout(page, label));
  }
  await chooseLayout(page, GALLERY_LAYOUTS.columns).catch(() => {});

  await shot(page, group, "Delete and undo", "No confirmation; an undo toast.", async () => {
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  });
  await page.getByRole("button", { name: "Undo" }).click().catch(() => {});
});

test("Models", async ({ page }) => {
  watchConsole(page);
  const group = "Models";
  await shot(page, group, "No diffusion models", "The default tab, empty here.", () =>
    page.goto("/models"));
  await shot(page, group, "LoRAs", "The library as cards.", async () => {
    await page.goto("/models?class=lora");
    await expect(page.locator("[data-model]").first()).toBeVisible();
  });
  await shot(page, group, "LoRAs table", "The library as a table.", () =>
    page.locator('button[title="Table"]').click());

  const id = await aLora(page).catch(() => null);
  await shot(page, group, "Model page", "A LoRA's page: header, strengths, outputs.", async () => {
    if (!id) throw new Error("no LoRA in /api/models");
    await page.goto(`/models/${id}`);
    await expect(page.getByLabel("Display name")).toBeVisible();
  });
  await shot(page, group, "Model page bottom", "Scrolled to its outputs.", () =>
    scrollToBottom(page));

  await shot(page, group, "Samples strip", "Three samples uploaded through the route.", async () => {
    await page.evaluate(async (model) => {
      for (const colour of ["#b84", "#48b", "#8b4"]) {
        const canvas = new OffscreenCanvas(320, 200);
        const context = canvas.getContext("2d")!;
        context.fillStyle = colour;
        context.fillRect(0, 0, 320, 200);
        const form = new FormData();
        form.set("file", await canvas.convertToBlob(), "sample.png");
        await fetch(`/api/models/${model}/samples`, { method: "POST", body: form });
      }
    }, id);
    await page.reload();
    await expect(page.getByRole("button", { name: /^Open sample/ }).first()).toBeVisible();
  });
  await shot(page, group, "Sample menu", "Hovering a sample.", async () => {
    await page.locator("figure.sample").first().hover();
    await page.waitForTimeout(300);
  });
  await shot(page, group, "Sample viewer", "A sample at full size.", () =>
    page.getByRole("button", { name: /^Open sample/ }).first().click());
  await page.keyboard.press("Escape");

  await shot(page, group, "Not found", "A model id that does not exist.", () =>
    page.goto("/models/does-not-exist"), true);
});

test("Workflows", async ({ page }) => {
  watchConsole(page);
  const group = "Workflows";
  await shot(page, group, "List", "Every bundled workflow.", async () => {
    await page.goto("/workflows");
    await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
  });
  await shot(page, group, "Row actions", "A row's more-actions menu.", () =>
    page.getByRole("button", { name: /^More actions for/ }).first().click());
  await closePopovers(page);

  await shot(page, group, "Manifest editor", "Krea 2 Turbo, with the panel preview.", async () => {
    await page.getByRole("cell", { name: "Krea 2 Turbo", exact: true }).click();
    await expect(page.getByText("Panel preview")).toBeVisible();
  });
  await shot(page, group, "Exposed only", "The editor filtered to exposed params.", () =>
    page.getByRole("button", { name: "Exposed", exact: false }).first().click());
  await shot(page, group, "Editor bottom", "Scrolled to the hidden inputs.", () =>
    scrollToBottom(page));
  await shot(page, group, "Not found", "A workflow id that does not exist.", () =>
    page.goto("/workflows/does-not-exist"), true);
});

test("ComfyUI, Telemetry, Settings", async ({ page }) => {
  watchConsole(page);
  // Loaded directly rather than through the rail: a bare /comfy is the app's
  // screen, and the iframe inside it is what reaches the proxy.
  await shot(page, "ComfyUI", "Editor", "The embedded editor (a stand-in here).", async () => {
    await connected(page, "/comfy");
    await page.waitForTimeout(1_500);
  });
  await shot(page, "ComfyUI", "Editing a workflow", "Krea 2 Turbo, with the Save & return toolbar.", async () => {
    await connected(page, "/comfy?workflow=krea2");
    await page.waitForTimeout(1_500);
  });

  const group = "Telemetry";
  await shot(page, group, "API requests", "The default report, bars.", async () => {
    await page.goto("/telemetry");
    await expect(page.locator(".chart svg")).toBeVisible();
  });
  await shot(page, group, "Line graph", "The smoothed line.", () =>
    page.getByRole("button", { name: "Line" }).click());
  await page.getByRole("button", { name: "Bars" }).click().catch(() => {});
  await shot(page, group, "Raw entry", "A row's sidebar.", async () => {
    await page.locator("tbody tr").first().click();
    await expect(page.locator(".sidebar")).toBeVisible();
  });
  await page.keyboard.press("Escape");
  for (const report of ["Output Size", "Model Size", "Memory Usage", "Telemetry Log Size"]) {
    await shot(page, group, report, `The ${report} report.`, () =>
      page.getByRole("button", { name: new RegExp(report) }).click());
  }

  await shot(page, "Settings", "Top", "Connection, with the log open.", async () => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "ComfyUI connection" })).toBeVisible();
    await page.getByRole("button", { name: "View log" }).click();
  });
  await shot(page, "Settings", "Bottom", "Storage, keyboard, maintenance.", () =>
    scrollToBottom(page));
});

test("edge states", async ({ page }) => {
  watchConsole(page);
  const group = "Edge";
  await shot(page, group, "Server unreachable", "Every /api request refused.", async () => {
    await page.route("**/api/**", (route) => route.abort());
    await page.goto("/generate");
    await expect(page.getByText("Is the ForgeUI server still running?")).toBeVisible();
  }, true);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await shot(page, group, "Queue strip collapsed", "The strip folded away.", async () => {
    await connected(page, "/gallery");
    await page.getByLabel("Collapse the queue strip").click();
  });
  await page.getByLabel("Show the queue").click().catch(() => {});
});

/** Half of a 1920×1080 screen, the window beside an editor (narrow.spec.ts). */
test("half a screen", async ({ page }) => {
  watchConsole(page);
  await page.setViewportSize({ width: 960, height: 990 });
  const group = "Narrow 960";
  const screens: [string, string][] = [
    ["Generate", "/generate"],
    ["Gallery", "/gallery"],
    ["Models", "/models"],
    ["Workflows", "/workflows"],
    ["Telemetry", "/telemetry"],
    ["Settings", "/settings"],
  ];
  for (const [title, path] of screens) {
    await shot(page, group, title, `${path} at half a screen.`, () => connected(page, path));
  }
  await shot(page, group, "Generate focused", "A tile opened, narrow.", async () => {
    await connected(page, "/generate");
    await page.locator(".tile .surface").first().click();
    await expect(page.getByRole("button", { name: "Reuse parameters →" })).toBeVisible();
  });
  await shot(page, group, "Gallery viewer", "The viewer, narrow.", async () => {
    await connected(page, "/gallery");
    await page.locator(".tile .surface").first().click();
    await expect(page.getByText("Files")).toBeVisible();
  });
  const id = await aLora(page).catch(() => null);
  await shot(page, group, "Model page", "A LoRA's page, narrow.", () =>
    page.goto(`/models/${id}`));
  await shot(page, group, "Manifest editor", "The editor, narrow.", async () => {
    await page.goto("/workflows");
    await page.getByRole("cell", { name: "Krea 2 Turbo", exact: true }).click();
  });
});
