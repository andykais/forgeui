import { expect, test } from "@playwright/test";

/**
 * Getting around the pages opened from a list (DESIGN.md §11.4): a
 * workflow links its templates and a template its workflow, and Escape is
 * each page's Back button — one step at a time, and never out of a field
 * being typed in.
 */

test("a workflow links its templates, and a template its workflow", async ({ page }) => {
  await page.goto("/workflows/krea2-img2img");
  const links = page.locator("[data-workflow-templates]");
  await links.getByRole("link", { name: "Upscale 2×" }).click();
  await expect(page).toHaveURL(/\/templates\/krea2-upscale$/);
  await expect(page.getByLabel("Template name")).toHaveValue("Upscale 2×");

  await page.getByRole("link", { name: /Krea 2 Turbo \(img2img\)/ }).click();
  await expect(page).toHaveURL(/\/workflows\/krea2-img2img$/);
  await expect(page.getByRole("heading", { name: "Krea 2 Turbo (img2img)" })).toBeVisible();

  // A workflow with no templates says nothing about them.
  await page.goto("/workflows/sd15");
  await expect(page.getByRole("heading", { name: "Stable Diffusion 1.5" })).toBeVisible();
  await expect(page.locator("[data-workflow-templates]")).toHaveCount(0);
});

test("escape is the Back button on a workflow's page and a template's", async ({ page }) => {
  // The workflow page has a Back button now, and the key is the same thing.
  await page.goto("/workflows/krea2-img2img");
  await expect(page.getByRole("heading", { name: "Krea 2 Turbo (img2img)" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/workflows$/);
  await page.goto("/workflows/krea2-img2img");
  await page.getByRole("button", { name: "Back to workflows (esc)" }).click();
  await expect(page).toHaveURL(/\/workflows$/);

  await page.goto("/templates/krea2-upscale");
  const name = page.getByLabel("Template name");
  await expect(name).toHaveValue("Upscale 2×");
  // Typing keeps the key: Escape reverts the field and the page stays.
  await name.fill("Renamed while typing");
  await name.press("Escape");
  await expect(name).toHaveValue("Upscale 2×");
  await expect(page).toHaveURL(/\/templates\/krea2-upscale$/);
  // Out of the field, it goes back.
  await name.blur();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/templates$/);
});
