import { expect, test } from "@playwright/test";

/**
 * The screenshots in `docs/screenshots/phase-2/`, taken against the real
 * ComfyUI and the real 2 GB checkpoint that `deno task comfy:setup`
 * provisions — so the images are generations rather than fixture plates.
 *
 * Not part of any suite. Regenerate with:
 *
 * ```sh
 * FORGEUI_SHOTS_DIR=docs/screenshots/phase-2 deno task test:e2e:comfy
 * ```
 *
 * Each shot is named for what it shows, and nothing is staged: the outputs
 * come from generations this file makes.
 */
const shots = process.env.FORGEUI_SHOTS_DIR;

test.skip(!shots, "set FORGEUI_SHOTS_DIR to regenerate the documentation shots");
test.describe.configure({ mode: "serial" });

async function generate(page: import("@playwright/test").Page, prompt: string) {
  await page.goto("/generate");
  await expect(page.getByText("ComfyUI connected")).toBeVisible();
  await page.locator(".workflow-card").click();
  await page.getByRole("button", { name: /^Stable Diffusion 1\.5 prompt/ }).click();
  await expect(page.locator('[data-panel-loading="false"]')).toBeVisible();
  await page.locator('[data-param="prompt"] textarea').fill(prompt);
  await page.getByLabel("Width").fill("256");
  await page.getByLabel("Height").fill("256");
  await page.getByRole("button", { name: /^Advanced/ }).click();
  await page.locator('[data-param="steps"] input').first().fill("4");
  const before = await page.locator(".tile").count();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.locator(".tile")).toHaveCount(before + 1, { timeout: 240_000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLImageElement>(".tile img")].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    null,
    { timeout: 60_000 },
  );
}

/**
 * First, before anything else has happened: the data directory is new, so
 * the boot scan is still reading the two gigabytes and the model has no
 * identity yet. That window is a few seconds wide and cannot be staged.
 */
test("the models screen while the first scan is still hashing", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/models");
  const card = page.locator("[data-model]").first();
  await expect(card).toHaveAttribute("data-hashing", "true", { timeout: 10_000 });
  await expect(page.getByText("hashing", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${shots}/models-hashing.png` });

  // Its page, in the same state: the badge, and every field disabled.
  await card.locator("a.name").click();
  await expect(page.getByLabel("Display name")).toBeDisabled();
  await expect(page.getByText("still being read")).toBeVisible();
  await page.screenshot({ path: `${shots}/model-page-hashing.png` });

  await expect(page.getByText("hashing", { exact: true })).toBeHidden({
    timeout: 300_000,
  });
});

test("two generations, so the library has a history to show", async ({ page }) => {
  test.setTimeout(600_000);
  await generate(page, "a granite bowl of figs, north light");
  await generate(page, "a heron in reeds at dusk, volumetric fog");
});

test("the models screen, once the library knows what it has", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/models");
  const card = page.locator("[data-model]").first();
  await expect(card).toHaveAttribute("data-hashing", "false", { timeout: 300_000 });
  await expect(page.getByText(/2 outputs/).first()).toBeVisible();
  await page.screenshot({ path: `${shots}/models.png` });

  await page.getByRole("button", { name: "Table" }).click();
  await expect(page.locator("table")).toBeVisible();
  await page.screenshot({ path: `${shots}/models-table.png` });
});

test("the model page, its samples strip and the outputs beneath", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/models");
  await page.locator("[data-model]").first().locator("a.name").click();

  const name = page.getByLabel("Display name");
  await expect(name).toBeVisible();
  await name.fill("Stable Diffusion 1.5");
  await name.blur();
  await page.getByLabel("Add a tag").fill("base");
  await page.getByLabel("Add a tag").press("Enter");
  await page.getByLabel("Notes").fill(
    "The one the contract check generates with: four steps at 256×256 on a CPU.",
  );
  await page.getByLabel("Notes").blur();
  await expect(page.getByText("base")).toBeVisible();

  // Promote one of the generations, so the strip has something in it.
  await page.locator(".tile .surface").first().click();
  await page.getByRole("button", { name: "Promote to sample" }).click();
  await page.screenshot({ path: `${shots}/viewer-promote-to-sample.png` });
  await page.getByRole("button", { name: /Stable Diffusion 1\.5/ }).click();
  await page.getByRole("button", { name: "Promote", exact: true }).click();
  await expect(page.getByText(/Promoted to 1 sample/)).toBeVisible();
  await page.keyboard.press("Escape");

  await page.reload();
  const sample = page.locator("figure").first();
  await expect(sample).toBeVisible();
  await sample.hover();
  await expect(page.getByLabel(/Set .* as thumbnail/)).toBeVisible();
  await page.waitForTimeout(300); // the menu fades in
  await page.screenshot({ path: `${shots}/model-page-sample-menu.png` });

  await page.getByLabel(/Set .* as thumbnail/).click();
  await expect(page.getByText("thumbnail")).toBeVisible();
  // Neither hovered nor focused, or the menu stays open over the sample.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/model-page.png` });

  // The family combo, which is the fixed list plus unset and nothing else.
  await page.getByRole("button", { name: /unset/ }).click();
  await expect(page.getByRole("button", { name: /^sd15/ })).toBeVisible();
  await page.screenshot({ path: `${shots}/model-page-family.png` });
});

test("the gallery's models filter, and the viewer's model links", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/gallery");
  await expect(page.locator(".tile").first()).toBeVisible();
  await page.getByRole("button", { name: /^Models:/ }).click();
  await expect(page.getByText("checkpoints")).toBeVisible();
  await page.screenshot({ path: `${shots}/gallery-models-filter.png` });

  // Selecting one filters the grid to what that model made.
  await page.getByRole("button", { name: /Stable Diffusion 1\.5/ }).first().click();
  await expect(page).toHaveURL(/models=[0-9a-f]{64}/);
  await page.keyboard.press("Escape");
  await page.locator(".tile .surface").first().click();
  await expect(page.getByRole("button", { name: "Edit in Generate →" })).toBeVisible();
  await page.screenshot({ path: `${shots}/gallery-viewer-model-links.png` });
});

test("settings: the storage cards and the rescan button", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Model folders" })).toBeVisible();
  await expect(page.getByText("outputs", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${shots}/settings-storage.png` });
});
