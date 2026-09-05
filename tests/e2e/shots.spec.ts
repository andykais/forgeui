import { expect, test } from "@playwright/test";

/**
 * Walkthrough screenshots. Not part of the suite: run with
 * `npx playwright test shots.spec.ts` to refresh the artifacts.
 */
const shots = process.env.FORGEUI_SHOTS_DIR ?? "/opt/cursor/artifacts";

test.describe.configure({ mode: "serial" });

test("fill a gallery, then photograph every screen", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/generate");
  await expect(page.getByText("ComfyUI connected")).toBeVisible();

  // A handful of generations across two workflows, so the screens have data.
  const runs: [string, string][] = [
    [
      "Flux Krea 2",
      "overgrown concrete stairwell at dusk, volumetric fog, 35mm",
    ],
    ["Flux Krea 2", "a granite bowl of figs, north light"],
    ["Illustrious XL", "a heron in reeds at dawn, soft key"],
    ["Flux Krea 2", "ivy on a stairwell wall, wider lens"],
    ["Illustrious XL", "a fox asleep on warm stone"],
    ["Flux Krea 2", "stairwell, cooler grade, rain on the landing"],
  ];

  for (const [workflow, prompt] of runs) {
    await page.locator(".workflow-card").click();
    await page.getByRole("button", {
      name: new RegExp(`^${escapeRegExp(workflow)} (prompt|image)`),
    })
      .first()
      .click();
    const field = page.locator('[data-param="prompt"] textarea');
    await expect(field).toBeVisible();
    await field.fill(prompt);
    const generate = page.getByRole("button", {
      name: "Generate",
      exact: true,
    });
    await expect(generate).toBeEnabled();
    await generate.click();
    await page.waitForTimeout(350);
  }
  // Wait for the grid to hold every result, with its media decoded.
  await expect(page.locator(".tile")).toHaveCount(runs.length, {
    timeout: 60_000,
  });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLImageElement>(".tile img")].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    null,
    { timeout: 60_000 },
  );

  // 1. Generate, with the session grid full and the Advanced section open.
  await page.getByRole("button", { name: /Advanced/ }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${shots}/ui_generate.png` });

  // 2. The LoRA and workflow pickers, over the panel.
  await page.locator(".workflow-card").click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${shots}/ui_workflow_picker.png` });
  await page.keyboard.press("Escape");

  // 3. Generate's focused view: same viewer layout as Gallery (§11.2).
  await page.locator(".tile .surface").first().click();
  await expect(page.getByRole("button", { name: "Edit in Generate →" }))
    .toBeVisible();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${shots}/ui_generate_focused.png` });
  await page.keyboard.press("Escape");

  // 4. Gallery tiles with day dividers.
  await page.getByRole("link", { name: "Gallery" }).click();
  await expect(page.getByText("Today")).toBeVisible();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLImageElement>(".tile img")].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    null,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/ui_gallery.png` });

  // 5. Gallery table view.
  await page.getByRole("button", { name: "Table" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/ui_gallery_table.png` });
  await page.getByRole("button", { name: "Small tiles" }).click();

  // 6. The viewer, with the metadata sidebar and the filmstrip.
  await page.locator(".tile .surface").first().click();
  await expect(page.getByText("Files")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/ui_viewer.png` });
  await page.keyboard.press("Escape");

  // 7. Workflows list.
  await page.getByRole("link", { name: "Workflows" }).click();
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${shots}/ui_workflows.png` });

  // 8. The manifest editor.
  await page.getByRole("cell", { name: "Flux Krea 2", exact: true }).click();
  await expect(page.getByText("Panel preview")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/ui_manifest_editor.png` });

  // 9. Settings.
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "ComfyUI connection" }))
    .toBeVisible();
  await page.getByRole("button", { name: "View log" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/ui_settings.png`, fullPage: false });
});

test("the delete undo toast", async ({ page }) => {
  await page.goto("/gallery");
  await expect(page.locator(".tile").first()).toBeVisible();
  await page.locator(".tile .surface").first().click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await page.screenshot({ path: `${shots}/ui_delete_undo.png` });
  await page.getByRole("button", { name: "Undo" }).click();
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
