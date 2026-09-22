import { expect, test } from "@playwright/test";

/**
 * The viewer on a model's page (§11.2, §11.4).
 *
 * It is the same component the gallery opens, but the model page was the one
 * screen that bound none of the keys of §11.4 — so the Back button said
 * `esc` while the key did nothing, and `f` and the arrows were dead too.
 *
 * This file sorts last on purpose: it may leave a generation attributed to a
 * fixture LoRA behind, and `smoke.spec.ts` counts the outputs on that
 * model's page.
 */
test.describe.configure({ mode: "serial" });

const LORA = "film-grain-35mm.safetensors";

/**
 * That LoRA as the library has it: its id, and whether anything used it.
 *
 * Through the API rather than the page, because this is asked before the
 * first navigation — and by id rather than by name, since the display name
 * is editable and `smoke.spec.ts` renames this very model before this file
 * runs.
 */
async function theLora(request: import("@playwright/test").APIRequestContext) {
  const body = await (await request.get("/api/models?kind=loras")).json();
  const found = body.models.find((model: { filename: string }) =>
    model.filename === LORA
  );
  return found
    ? { id: found.id as string, outputs: found.output_count as number }
    : null;
}

/** A generation that used it, so its page has a tile to open. */
async function generateWithTheLora(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
) {
  await page.goto("/generate");
  await expect(page.getByText("ComfyUI connected")).toBeVisible();
  await page.locator(".workflow-card").click();
  await page.getByRole("button", { name: /^Illustrious XL prompt/ }).click();
  await expect(page.locator('[data-panel-loading="false"]')).toBeVisible();

  const prompt = `a brass orrery on slate, viewer keys ${Date.now()}`;
  await page.locator('[data-param="prompt"] textarea').fill(prompt);
  await page.getByRole("button", { name: /Add/ }).first().click();
  await page.getByRole("button", { name: /film-grain-35mm/ }).first().click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.locator(".tile").first()).toContainText(prompt.slice(0, 20), {
    timeout: 30_000,
  });

  // Attribution needs the file hashed, which the boot pass does in its own
  // time (§8.1), so the count is waited for rather than assumed.
  await expect.poll(async () => (await theLora(request))?.outputs ?? 0, {
    timeout: 30_000,
  }).toBeGreaterThan(0);
}

/** Its page, with one of its takes open in the viewer. */
async function openATakeUnderTheModel(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
) {
  // Only the first run has to make one: in a whole-suite run `smoke.spec.ts`
  // has already left a generation on this model.
  if (!(await theLora(request))?.outputs) await generateWithTheLora(page, request);
  const lora = await theLora(request);
  await page.goto(`/models/${lora!.id}`);

  const tile = page.locator(".grid .tile .surface").first();
  await expect(tile).toBeVisible({ timeout: 30_000 });
  await tile.click();
  await expect(page.locator(".main")).toBeVisible();
}

test("the model page answers the keys its own button promises", async ({
  page,
  request,
}) => {
  await openATakeUnderTheModel(page, request);
  // The promise the key has to keep. It was written on the button all along.
  await expect(page.getByRole("button", { name: /Back to grid/ })).toBeVisible();

  // `f` puts the black field up, and `esc` leaves it without leaving the
  // viewer — one step at a time, as in the gallery.
  await page.keyboard.press("f");
  await expect(page.locator(".fullscreen")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".fullscreen")).toHaveCount(0);
  await expect(page.locator(".main")).toBeVisible();

  // The next one goes back to the grid, which is what the button says.
  await page.keyboard.press("Escape");
  await expect(page.locator(".main")).toHaveCount(0);
  await expect(page.locator(".grid .tile").first()).toBeVisible();
});

test("escape in the model's own fields still reverts the edit", async ({
  page,
  request,
}) => {
  await openATakeUnderTheModel(page, request);
  await page.keyboard.press("Escape");
  await expect(page.locator(".main")).toHaveCount(0);

  // The header edits in place and `esc` reverts it (§8.1) — the window
  // binding must not take that key out of a field it is being typed into.
  const name = page.getByLabel("Display name");
  const was = await name.inputValue();
  await name.fill("Renamed while typing");
  await name.press("Escape");
  await expect(name).toHaveValue(was);
  // And nothing navigated away from the page underneath it.
  await expect(page).toHaveURL(/\/models\/[0-9a-f]{64}/);
});
