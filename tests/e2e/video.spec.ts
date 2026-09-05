import { expect, test } from "@playwright/test";

/**
 * Records the walkthrough video. Not part of the suite: run with
 * `FORGEUI_E2E_STEP_DELAY=240 npx playwright test video.spec.ts`.
 */
test.use({ video: { mode: "on", size: { width: 1440, height: 900 } } });

test("a generation, watched from the browser", async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto("/generate");
  await expect(page.getByText("ComfyUI connected")).toBeVisible();
  await page.waitForTimeout(700);

  // Pick a workflow from the card's picker: grouped by family and kind.
  await page.locator(".workflow-card").click();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: /^Flux Krea 2 prompt/ }).click();
  await page.waitForTimeout(500);

  // The panel is rendered from this workflow's manifest alone.
  const prompt = page.locator('[data-param="prompt"] textarea');
  await prompt.click();
  await prompt.pressSequentially(
    "overgrown concrete stairwell at dusk, volumetric fog",
    {
      delay: 22,
    },
  );

  // Size presets are ratios, resolved against the workflow's base resolution.
  await page.getByRole("button", { name: "16:9" }).click();
  await page.waitForTimeout(400);

  // The seed: 🎲 rolls and locks it, so the next run repeats.
  await page.getByLabel("Roll a new seed").click();
  await page.waitForTimeout(600);

  // One click is one job.
  await page.getByRole("button", { name: "Generate", exact: true }).click();

  // The running card: percent, ETA, node label and step counter over the
  // preview frames ComfyUI streams.
  await expect(page.locator(".card.running")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2600);

  // It lands in the session grid.
  await expect(page.locator(".tile")).toHaveCount(1, { timeout: 40_000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLImageElement>(".tile img")].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(900);

  // Open it: the focused view keeps the panel and uses the gallery's viewer.
  await page.locator(".tile .surface").first().click();
  await expect(page.getByRole("button", { name: "Edit in Generate →" }))
    .toBeVisible();
  await page.waitForTimeout(2000);

  // Escape returns to the grid, then over to the gallery.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await page.getByRole("link", { name: "Gallery" }).click();
  await expect(page.getByText("Today")).toBeVisible();
  await page.waitForTimeout(1400);

  // The viewer, with the sidecar's metadata and the copyable file paths.
  await page.locator(".tile .surface").first().click();
  await expect(page.getByText("Files")).toBeVisible();
  await page.waitForTimeout(2200);

  // Delete has no confirmation: an undo toast stands for it.
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await page.waitForTimeout(1800);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".tile").first()).toBeVisible();
  await page.waitForTimeout(1500);
});
