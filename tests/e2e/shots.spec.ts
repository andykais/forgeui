import { expect, test } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The screenshots in `docs/screenshots/phase-1/`. Not part of the suite; run
 * it to refresh them:
 *
 *     FORGEUI_E2E_DATA_DIR=/tmp/forgeui-docs FORGEUI_E2E_STEP_DELAY=260 \
 *       npx playwright test shots.spec.ts
 *
 * The step delay slows the fake ComfyUI down enough to catch a running job,
 * and the data dir is chosen so the paths in Settings and FILES read cleanly.
 */
const here = dirname(fileURLToPath(import.meta.url));
const shots = process.env.FORGEUI_SHOTS_DIR ??
  join(here, "..", "..", "docs", "screenshots", "phase-1");

const RUNS: [string, string][] = [
  ["Flux Krea 2", "overgrown concrete stairwell at dusk, volumetric fog, 35mm"],
  ["Flux Krea 2", "a granite bowl of figs, north light"],
  ["Illustrious XL", "a heron in reeds at dawn, soft key"],
  ["Flux Krea 2", "ivy on a stairwell wall, wider lens"],
  ["Illustrious XL", "a fox asleep on warm stone"],
  ["Flux Krea 2", "stairwell, cooler grade, rain on the landing"],
];

test.describe.configure({ mode: "serial" });

/** Media is large and uncompressed in tests; wait for it before shooting. */
async function mediaLoaded(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLImageElement>(".tile img")].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    null,
    { timeout: 60_000 },
  );
}

async function pickWorkflow(
  page: import("@playwright/test").Page,
  name: string,
) {
  await page.locator(".workflow-card").click();
  await page
    .getByRole("button", {
      name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (prompt|image)`),
    })
    .first()
    .click();
}

test("photograph every screen", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/generate");
  await expect(page.getByText("ComfyUI connected")).toBeVisible();

  // The workflow picker, grouped by family and kind (§11.2).
  await page.locator(".workflow-card").click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${shots}/generate-workflow-picker.png` });
  await page.keyboard.press("Escape");

  for (const [index, [workflow, prompt]] of RUNS.entries()) {
    await pickWorkflow(page, workflow);
    const field = page.locator('[data-param="prompt"] textarea');
    await expect(field).toBeVisible();
    await field.fill(prompt);
    const generate = page.getByRole("button", { name: "Generate", exact: true });
    await expect(generate).toBeEnabled();
    await generate.click();

    // The first job is caught mid-flight: the running card's percent, ETA,
    // node label and step counter over the streaming preview, and the queue
    // strip's running chip (§11.1, §11.2).
    if (index === 0) {
      await expect(page.locator(".card.running")).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(1400);
      await page.screenshot({ path: `${shots}/generate-running.png` });
    }
    await expect(page.locator(".tile")).toHaveCount(index + 1, { timeout: 60_000 });
  }
  await mediaLoaded(page);

  // Generate, with the session grid full and the Advanced section open.
  await page.getByRole("button", { name: /Advanced/ }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${shots}/generate.png` });

  // The focused view: the panel stays, the viewer layout is Gallery's (§11.2).
  await page.locator(".tile .surface").first().click();
  await expect(page.getByRole("button", { name: "Edit in Generate →" })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/generate-focused.png` });
  await page.keyboard.press("Escape");

  // Gallery tiles, with the day divider and its lazily fetched count.
  await page.getByRole("link", { name: "Gallery" }).click();
  await expect(page.getByText("Today")).toBeVisible();
  await mediaLoaded(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/gallery.png` });

  // The table half of the toggle: MODELS chips, SIZE, seed, DURATION.
  await page.getByRole("button", { name: "Table" }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/gallery-table.png` });
  await page.getByRole("button", { name: "Small tiles" }).click();
  await mediaLoaded(page);

  // The viewer: metadata sidebar, FILES, filmstrip.
  await page.locator(".tile .surface").first().click();
  await expect(page.getByText("Files")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/gallery-viewer.png` });

  // Delete has no confirmation; an undo toast stands for it (§11.2).
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${shots}/gallery-delete-undo.png` });
  await page.getByRole("button", { name: "Undo" }).click();
  await page.waitForTimeout(400);

  // The workflows table: the manifest surface at a glance.
  await page.getByRole("link", { name: "Workflows" }).click();
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/workflows.png` });

  // The manifest editor (§4.7), with the live panel preview.
  await page.getByRole("cell", { name: "Flux Krea 2", exact: true }).click();
  await expect(page.getByText("Panel preview")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/workflow-manifest-editor.png` });

  // Settings: the config.yaml sections of frame 08, read-only.
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "ComfyUI connection" })).toBeVisible();
  await page.getByRole("button", { name: "View log" }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/settings.png` });
});
