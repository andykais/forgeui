import { expect, type Page, test } from "@playwright/test";

/**
 * Templates (DESIGN.md §4.8): a screen of their own on the rail, the bundled
 * Upscale templates behind the Upscale button, and a template saved from the
 * Generate panel that knows which inputs it still asks for.
 */

async function pickKrea(page: Page) {
  await page.goto("/generate");
  await page.locator(".workflow-card").click();
  await page.getByRole("button", { name: /^Krea 2 Turbo prompt/ }).click();
  await expect(page.locator('[data-panel-loading="false"]')).toBeVisible();
}

test("Templates sits on the rail and lists the bundled Upscale templates", async ({
  page,
}) => {
  await page.goto("/generate");
  await page.getByRole("link", { name: "Templates" }).click();
  await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();
  // One per image family, each on its img2img workflow.
  await expect(page.getByRole("cell", { name: "Upscale 2×" })).toHaveCount(6);

  await page.getByRole("row", { name: /Krea 2 Turbo \(img2img\)/ }).click();
  await expect(page.getByLabel("Template name")).toHaveValue("Upscale 2×");
  await expect(page.getByText("used by Upscale image")).toBeVisible();
  // What it sets, and what it leaves to whoever presses the button.
  const scale = page.locator('[data-param="scale"]');
  await expect(scale.getByRole("radio", { name: "Save value" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(scale).toContainText("2");
  await expect(
    page.locator('[data-param="image"]').getByRole("radio", { name: "Ask" }),
  ).toHaveAttribute("aria-checked", "true");
  // Bundled: not the user's to delete.
  await expect(page.getByRole("button", { name: /^Delete/ })).toHaveCount(0);
  // The rail item stays lit on a template's own page.
  await expect(page.getByRole("link", { name: "Templates" })).toHaveClass(/active/);
});

test("Upscale applies the family's template: its numbers, the picture, the run", async ({
  page,
}) => {
  await pickKrea(page);
  const prompt = `a stairwell to upscale, ${Date.now()}`;
  await page.locator('[data-param="prompt"] textarea').fill(prompt);
  const before = await page.locator(".tile").count();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.locator(".tile")).toHaveCount(before + 1, { timeout: 30_000 });

  await page.goto("/gallery");
  await page.locator(".tile .surface").first().click();
  await page.getByRole("button", { name: /Upscale/ }).first().click();

  await expect(page.locator(".workflow-card")).toContainText("Krea 2 Turbo (img2img)");
  const banner = page.locator(".from-template");
  await expect(banner).toContainText("Upscale 2×");
  await expect(banner).toContainText("asks for Image");
  // The template's numbers, over the workflow's plain img2img defaults.
  await expect(page.locator('[data-param="scale"] input.narrow')).toHaveValue("2");
  await expect(page.locator('[data-param="creativity"] input.narrow')).toHaveValue(
    "0.2",
  );
  // The run that made the picture fills the rest.
  await expect(page.locator('[data-param="prompt"] textarea')).toHaveValue(prompt);
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
});

test("a template saved from Generate asks for what it left out", async ({ page }) => {
  await pickKrea(page);
  // The panel starts from the last Krea run, which another spec may have
  // left with LoRAs on it; start from the workflow's own defaults instead.
  await page.getByRole("button", { name: "Reset to defaults" }).click();
  await page.locator('[data-param="prompt"] textarea').fill("a heron in reeds");
  await page.getByRole("button", { name: /Add/ }).click();
  // By its file or its title: another spec gives this one a title.
  await page.locator("button.option").filter({ hasText: /film.grain.35mm/i }).first()
    .click();

  await page.getByRole("button", { name: "Save as template" }).click();
  const name = `Grainy ${Date.now()}`;
  await page.getByLabel("Template name").fill(name);
  // The prompt is required, so it starts as asked; the LoRA was added, so
  // it starts as saved.
  const row = (key: string) => page.locator(`.save-template [data-param="${key}"]`);
  await expect(row("prompt").getByRole("radio", { name: "Ask" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(
    row("loras").getByRole("radio", { name: "Save value" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page.getByText(`Saved template “${name}”`)).toBeVisible();

  // The panel now follows it: the prompt is asked for, so emptying it
  // stops Generate.
  await expect(page.locator(".from-template")).toContainText(name);
  await page.locator('[data-param="prompt"] textarea').fill("");
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();

  // It is on the Templates screen, and its own page can move an input out
  // of it and delete it.
  await page.getByRole("link", { name: "Templates" }).click();
  await page.getByRole("cell", { name }).click();
  await expect(page.getByLabel("Template name")).toHaveValue(name);
  const loras = page.locator('[data-param="loras"]');
  await expect(loras).toContainText(/film.grain.35mm 1/i);
  await loras.getByRole("radio", { name: "Leave open" }).click();
  await expect(loras.getByRole("radio", { name: "Leave open" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();
  await expect(page.getByRole("cell", { name })).toHaveCount(0);
});
