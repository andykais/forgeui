import { expect, test } from "@playwright/test";

/**
 * The one end-to-end flow §14.1 asks for: submit a job, watch progress, see
 * the output card appear, refresh, and confirm it is still there. Everything
 * below the browser is real — the Deno server, SQLite, the job pipeline and a
 * managed ComfyUI child process (the fake one).
 */
test("submit, watch progress, see the card, refresh, still there", async ({ page }) => {
  await page.goto("/generate");

  // The shell comes up with the rail and the queue strip.
  await expect(page.getByRole("navigation", { name: "Screens" })).toBeVisible();
  await expect(page.getByText("ComfyUI connected")).toBeVisible();

  // Pick a workflow through the card's picker popover (§11.2).
  await page.locator(".workflow-card").click();
  await page.getByRole("button", { name: /^Flux Krea 2 prompt/ }).click();
  await expect(page.locator('[data-panel-loading="false"]')).toBeVisible();
  await expect(page.locator(".workflow-card")).toContainText("Flux Krea 2");

  // The panel renders from the manifest alone: this workflow's six params.
  const prompt = page.locator('[data-param="prompt"] textarea');
  await expect(prompt).toBeVisible();
  await expect(page.locator('[data-param="size"]')).toBeVisible();
  await expect(page.locator('[data-param="seed"]')).toBeVisible();

  // Required params gate the Generate button (§11.3).
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await expect(generate).toBeDisabled();

  const promptText = `a heron in reeds, take ${Date.now()}`;
  await prompt.fill(promptText);
  await expect(generate).toBeEnabled();

  const before = await page.locator(".tile").count();
  await generate.click();

  // Progress arrives over the websocket, then the card lands in the grid.
  await expect(page.locator(".tile")).toHaveCount(before + 1, { timeout: 30_000 });
  const tile = page.locator(".tile").first();
  await expect(tile).toContainText(promptText.slice(0, 20));

  // A refresh loses nothing: the row and its output come from the database.
  await page.reload();
  await expect(page.locator(".tile").first()).toContainText(promptText.slice(0, 20));

  // The same output is in the gallery, with its day divider.
  await page.getByRole("link", { name: "Gallery" }).click();
  await expect(page.getByText("Today")).toBeVisible();
  await expect(page.locator(".tile").first()).toContainText(promptText.slice(0, 20));

  // Opening it shows the viewer with the sidecar's metadata.
  await page.locator(".tile .surface").first().click();
  await expect(page.getByRole("button", { name: "Edit in Generate →" })).toBeVisible();
  await expect(page.getByText("Files")).toBeVisible();
  await expect(page.getByText("Flux Krea 2", { exact: false }).first()).toBeVisible();
  // The sidecar's own numbers, not the row's.
  await expect(page.getByText("duration")).toBeVisible();

  // Escape returns to the grid (§11.4).
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder("Search prompts…")).toBeVisible();
});

test("the workflows screen lists the bundled workflows", async ({ page }) => {
  await page.goto("/workflows");
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
  for (
    const name of [
      "Flux Krea 2",
      "Flux Krea 2 (img2img)",
      "Illustrious XL",
      "LTX Video",
      "Anima",
      "Flux Klein",
      "Z-Image Turbo",
      "Stable Diffusion 1.5",
    ]
  ) {
    await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();
  }

  // The manifest editor opens with the panel preview beside the inputs (§4.7).
  await page.getByRole("cell", { name: "Flux Krea 2", exact: true }).click();
  await expect(page.getByText("Panel preview")).toBeVisible();
  // The chain row is synthetic and excluded from the literal-input count.
  await expect(page.getByText("synthetic · rewrites the graph")).toBeVisible();
  await expect(page.getByText(/plus the synthetic LoRA chain/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save manifest" })).toBeVisible();
});

test("settings shows the connection, the folders and the bindings", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "ComfyUI connection" })).toBeVisible();
  await expect(page.getByText("--output-directory")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Model folders" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Keyboard" })).toBeVisible();
  await expect(page.getByText("select_prev")).toBeVisible();

  // Reindex is the only maintenance action in Phase 1 (§M4).
  await page.getByRole("button", { name: "Run reindex" }).click();
  await expect(page.getByText(/sidecars/)).toBeVisible();
});

/**
 * The UI preferences of §3.1 live in `config.yaml`, which means they have to
 * take effect at once *and* survive a reload. Nothing asserted either until
 * the tiles / table toggle turned out to be silently doing nothing.
 */
test("ui preferences take effect and persist", async ({ page }) => {
  await page.goto("/gallery");
  await expect(page.getByPlaceholder("Search prompts…")).toBeVisible();

  // Tiles → table.
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(page.locator("table")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Prompt" })).toBeVisible();
  await expect(page.locator(".tile")).toHaveCount(0);

  // The rail expands to its labelled form.
  await page.getByRole("button", { name: "Expand the rail" }).click();
  await expect(page.getByRole("link", { name: "Gallery" })).toContainText("Gallery");

  // Both are on the config, not just in the page.
  const config = await page.evaluate(() =>
    fetch("/api/config").then((response) => response.json())
  );
  expect(config.ui.tile_size.gallery).toBe("table");
  expect(config.ui.rail_expanded).toBe(true);

  // …so a reload comes back the same way.
  await page.reload();
  await expect(page.locator("table")).toBeVisible();
  await expect(page.getByRole("link", { name: "Gallery" })).toContainText("Gallery");

  // Put it back, and check the other direction persists too.
  await page.getByRole("button", { name: "Small tiles", exact: true }).click();
  await page.getByRole("button", { name: "Collapse the rail" }).click();
  await expect(page.locator("table")).toHaveCount(0);
  const restored = await page.evaluate(() =>
    fetch("/api/config").then((response) => response.json())
  );
  expect(restored.ui.tile_size.gallery).toBe("small");
  expect(restored.ui.rail_expanded).toBe(false);
});

/**
 * The read-only model scan of §M4 reaching the browser: the e2e server drops
 * two fixture LoRAs in a folder and points `model_folders.loras` at it.
 */
test("the LoRA picker lists the scanned folder, and rows link their strengths", async ({
  page,
}) => {
  await page.goto("/generate");
  await page.locator(".workflow-card").click();
  await page.getByRole("button", { name: /^Flux Krea 2 prompt/ }).click();
  await expect(page.locator('[data-panel-loading="false"]')).toBeVisible();

  await page.getByRole("button", { name: /Add/ }).click();
  const option = page.getByRole("button", { name: /film-grain-35mm/ });
  await expect(option).toBeVisible();
  // Display names fall back to the filename minus its extension (§8.1).
  await expect(page.getByRole("button", { name: /soft-studio-light/ })).toBeVisible();
  await option.click();

  // Linked strengths are the default; ⛓ splits them into two (§11.3).
  await expect(page.getByLabel("film-grain-35mm strength")).toBeVisible();
  await page.getByRole("button", { name: "Unlink strengths" }).click();
  await expect(page.getByLabel("film-grain-35mm model strength")).toBeVisible();
  await expect(page.getByLabel("film-grain-35mm clip strength")).toBeVisible();

  // Already-added LoRAs stay listed, marked rather than offered twice.
  await page.getByRole("button", { name: /Add/ }).click();
  await expect(page.getByText("added")).toBeVisible();
});
