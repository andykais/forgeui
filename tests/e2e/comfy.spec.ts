import { expect, type Page, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * What only a browser can prove, against a real ComfyUI: that a generation
 * works from the interface a person actually uses, and that the embedded
 * editor's `app.graphToPrompt()` is reachable through the same-origin
 * `/comfy/*` proxy — the one Phase 1 path that could not be tested at all
 * (`docs/PHASE-1-HANDOFF.md`, "Verify the embedded editor").
 *
 * `deno task test:e2e:comfy` provides the ComfyUI and the environment.
 */

const dataDir = process.env.FORGEUI_COMFY_DATA_DIR!;

/**
 * Set `FORGEUI_SHOTS_DIR` to keep a picture of what the run looked like. A
 * screenshot is documentation, so a failure to write one never fails a test.
 */
const shots = process.env.FORGEUI_SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (!shots) return;
  await page.screenshot({ path: join(shots, name) }).catch((cause) => {
    console.warn(`could not write ${name}: ${cause}`);
  });
}

test("generate with Stable Diffusion 1.5 and watch it land", async ({ page }) => {
  await page.goto("/generate");
  await expect(page.getByRole("navigation", { name: "Screens" })).toBeVisible();
  await expect(page.getByText("ComfyUI connected")).toBeVisible();

  await page.locator(".workflow-card").click();
  await page.getByRole("button", { name: /^Stable Diffusion 1\.5/ }).click();
  await expect(page.locator('[data-panel-loading="false"]')).toBeVisible();
  await expect(page.locator(".workflow-card")).toContainText(
    "Stable Diffusion 1.5",
  );

  const promptText = `a granite bowl of figs, north light, take ${Date.now()}`;
  await page.locator('[data-param="prompt"] textarea').fill(promptText);

  // 256×256 and four steps: a few seconds of CPU rather than a few minutes.
  await page.getByLabel("Width").fill("256");
  await page.getByLabel("Height").fill("256");
  await page.getByRole("button", { name: /^Advanced/ }).click();
  await page.locator('[data-param="steps"] input').first().fill("4");

  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await expect(generate).toBeEnabled();
  await generate.click();

  // The job card, then the image itself — decoded by the browser, so this is
  // the real PNG ComfyUI wrote and the app moved out of staging. Which state
  // the card is caught in depends on how fast the CPU got there, so the
  // running frame is asserted over the websocket in the pipeline test.
  await expect(page.locator(".card").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".tile")).toHaveCount(1, { timeout: 240_000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLImageElement>(".tile img")].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    null,
    { timeout: 60_000 },
  );

  await shot(page, "real-generate.png");

  // The viewer reads the sidecar the app wrote beside the file.
  await page.locator(".tile .surface").first().click();
  await expect(page.getByRole("button", { name: "Edit in Generate →" }))
    .toBeVisible();
  await expect(page.getByText("Stable Diffusion 1.5").first()).toBeVisible();
  await expect(page.getByText(promptText.slice(0, 24)).first()).toBeVisible();
  await shot(page, "real-viewer.png");
});

test("the embedded editor loads and Save & return captures the graph", async ({ page }) => {
  await page.goto("/workflows");
  await page.getByRole("cell", { name: "Stable Diffusion 1.5", exact: true })
    .click();
  await page.getByRole("link", { name: /Open in ComfyUI/ }).click();

  // ComfyUI's own frontend, served same-origin through /comfy/* so the app
  // can call into it (§4.1).
  await expect(page.locator("iframe[title='ComfyUI']")).toBeVisible();
  await page.waitForFunction(
    () => {
      const frame = document.querySelector<HTMLIFrameElement>(
        "iframe[title='ComfyUI']",
      );
      const win = frame?.contentWindow as
        | (Window & { app?: { graphToPrompt?: unknown } })
        | null;
      return typeof win?.app?.graphToPrompt === "function";
    },
    null,
    { timeout: 240_000 },
  );

  // The toolbar only offers the save once the editor answered.
  await expect(page.getByRole("button", { name: "Save & return" }))
    .toBeEnabled({ timeout: 240_000 });

  // The app pushed this workflow's own graph into the editor: the loaded
  // graph is sd15's seven nodes, not ComfyUI's default one.
  const classes = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>(
      "iframe[title='ComfyUI']",
    );
    const win = frame?.contentWindow as
      | (Window & { app?: { graph?: { _nodes?: { type: string }[] } } })
      | null;
    return (win?.app?.graph?._nodes ?? []).map((node) => node.type).sort();
  });
  expect(classes).toContain("CheckpointLoaderSimple");
  expect(classes).toContain("KSampler");
  expect(classes).toContain("SaveImage");
  await shot(page, "real-editor.png");

  // Save & return calls graphToPrompt() and writes both files as a user copy.
  await page.getByRole("button", { name: "Save & return" }).click();
  await expect(page.getByText("Saved both workflow files")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stable Diffusion 1.5" }))
    .toBeVisible();

  const user = join(dataDir, "workflows", "user", "sd15");
  expect(existsSync(join(user, "workflow.api.json"))).toBe(true);
  expect(existsSync(join(user, "workflow.ui.json"))).toBe(true);
});

/**
 * The model library's screens against a real 2 GB checkpoint (§8.1, §8.3,
 * M9): the card, the page, the sample promoted from a real generation, and
 * the thumbnail that follows from it.
 */
test("the model library, from the card to the thumbnail", async ({ page }) => {
  await page.goto("/models");

  const card = page.locator("[data-model]").first();
  await expect(card).toBeVisible();
  // The boot scan hashes in the background; two gigabytes take a moment.
  await expect(card).toHaveAttribute("data-hashing", "false", { timeout: 240_000 });
  await expect(page.getByText(/1 output/).first()).toBeVisible();
  await shot(page, "real-models.png");

  await card.getByText("v1-5-pruned-emaonly-fp16").first().click();
  await expect(page.getByLabel("Display name")).toHaveValue("v1-5-pruned-emaonly-fp16");
  // The whole sha256, on its own line (§11.2).
  await expect(page.locator(".hash .value")).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.getByText("Samples")).toBeVisible();

  // Rename it in place: blur commits, and it survives a reload.
  const name = page.getByLabel("Display name");
  await name.fill("Stable Diffusion 1.5");
  await name.blur();
  await page.reload();
  await expect(page.getByLabel("Display name")).toHaveValue("Stable Diffusion 1.5");

  // Promote the generation it made, from the viewer on this page.
  await page.locator(".tile .surface").first().click();
  await page.getByRole("button", { name: "Promote to sample" }).click();
  await page.getByRole("button", { name: /Stable Diffusion 1\.5/ }).click();
  await page.getByRole("button", { name: "Promote", exact: true }).click();
  await expect(page.getByText(/Promoted to 1 sample/)).toBeVisible();

  await page.keyboard.press("Escape");
  await page.reload();
  const sample = page.locator("figure").first();
  await expect(sample).toBeVisible();
  await sample.hover();
  await page.getByLabel(/Set .* as thumbnail/).click();
  await expect(page.getByText("thumbnail")).toBeVisible();
  await shot(page, "real-model-page.png");
});
