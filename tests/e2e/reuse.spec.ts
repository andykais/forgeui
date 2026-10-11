import { expect, type Page, test } from "@playwright/test";

/**
 * Reuse image (DESIGN.md §10), dragging a picture out of the open viewer,
 * and a pasted picture finding the output it came from (§9).
 */

/**
 * Z-Image rather than Krea 2: the panel refills from a workflow's last run,
 * and `smoke.spec.ts` expects Krea 2's required prompt to start empty.
 */
async function generateZImage(page: Page, prompt: string) {
  await page.goto("/generate?workflow=z-image-turbo");
  await expect(page.locator('[data-panel-loading="false"]')).toBeVisible();
  await page.locator('[data-param="prompt"] textarea').fill(prompt);
  const before = await page.locator(".tile").count();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.locator(".tile")).toHaveCount(before + 1, { timeout: 30_000 });
}

test("Reuse image opens any workflow that takes a picture, with the picture and the words", async ({
  page,
}) => {
  const prompt = `a stone well in a field, ${Date.now()}`;
  await generateZImage(page, prompt);
  await page.locator(".tile .surface").first().click();
  await expect(page.locator(".main")).toBeVisible();

  await page.getByRole("button", { name: "Reuse image" }).click();
  const menu = page.locator("[data-reuse-menu]");
  // Its own family first, then everything else that takes a picture.
  await expect(menu.locator(".reuse-family").first()).toHaveText(
    "z-image · this picture's family",
  );
  const rows = await menu.locator(".reuse-option").allTextContents();
  const at = (name: string) => rows.findIndex((row) => row.trim() === name);
  expect(at("Z-Image Turbo (img2img)")).toBe(0);
  // Another family's, and a video made from a picture, are there too.
  expect(at("Krea 2 Turbo (inpaint)")).toBeGreaterThan(0);
  expect(at("Stable Diffusion 1.5 (inpaint)")).toBeGreaterThan(0);
  expect(at("LTX-2.3 Image to Video")).toBeGreaterThan(0);
  // But never a workflow that takes no picture.
  expect(at("Z-Image Turbo")).toBe(-1);
  expect(at("Krea 2 Turbo")).toBe(-1);

  await menu.locator(".reuse-option", { hasText: "Stable Diffusion 1.5 (inpaint)" }).click();
  await expect(page.locator(".workflow-card")).toContainText("Stable Diffusion 1.5 (inpaint)");
  await expect(page.locator('[data-param="image"] img')).toBeVisible();
  // The words come along, so nothing has to be copied across by hand.
  await expect(page.locator('[data-param="prompt"] textarea')).toHaveValue(prompt);
  // A mask is painted for this picture, so it starts empty.
  await expect(page.getByRole("button", { name: "Mask: paint the mask" })).toBeVisible();
});

test("a picture dragged out of the open viewer lands in an image param", async ({ page }) => {
  await generateZImage(page, `a heron, ${Date.now()}`);
  await page.goto("/generate?workflow=z-image-img2img");
  await expect(page.locator('[data-panel-loading="false"]')).toBeVisible();
  // Start empty, whatever the last run of this workflow held.
  const image = page.locator('[data-param="image"]');
  const remove = image.getByRole("button", { name: "Remove this image" });
  if (await remove.count()) await remove.click();
  await expect(image).toContainText("Choose, drop or paste an image");

  await page.locator(".tile .surface").first().click();
  const shown = page.locator(".main .media img").first();
  await expect(shown).toBeVisible();
  await shown.dragTo(image.locator(".zone"));
  // Adopted, not uploaded: the stored size is the output's own.
  await expect(image.locator(".meta")).toContainText("×");
  await expect(image.locator("img.shot")).toBeVisible();
});

test("a pasted picture knows which output it came from", async ({
  page,
  request,
  browserName,
}) => {
  // Firefox drops `clipboardData` from a paste event a page makes itself,
  // so it cannot be pasted into from a test; a person's paste is unaffected.
  test.skip(browserName === "firefox", "synthetic paste carries no data in Firefox");
  await generateZImage(page, `a lighthouse, ${Date.now()}`);
  const { outputs } = await (await request.get("/api/outputs?limit=1")).json();
  const source = outputs[0];

  await page.goto("/generate?workflow=z-image-img2img");
  await expect(page.locator('[data-panel-loading="false"]')).toBeVisible();
  const image = page.locator('[data-param="image"]');
  const remove = image.getByRole("button", { name: "Remove this image" });
  if (await remove.count()) await remove.click();

  // What a browser's Copy Image puts on the clipboard: the picture drawn and
  // written out again, so not one byte of the file comes with it.
  await image.locator(".zone").hover();
  const uploaded = page.waitForResponse((r) =>
    r.url().endsWith("/api/inputs") && r.request().method() === "POST"
  );
  await page.evaluate(async (url) => {
    const picture = new Image();
    picture.src = url;
    await picture.decode();
    const canvas = document.createElement("canvas");
    canvas.width = picture.naturalWidth;
    canvas.height = picture.naturalHeight;
    canvas.getContext("2d")!.drawImage(picture, 0, 0);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/png")
    );
    const data = new DataTransfer();
    data.items.add(new File([blob], "image.png", { type: "image/png" }));
    window.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, source.media_url);
  const input = await (await uploaded).json();
  // The fake paints every run the same flat colour, as a rerun of one seed
  // does for real, so the parent is the earliest output with these pixels
  // (§9): this one, or one made before it that looks exactly like it.
  const parent = input.derived_from_output as string;
  expect(parent).not.toBeNull();
  const made = await (await request.get(`/api/outputs/${parent}`)).json();
  expect([made.width, made.height]).toEqual([source.width, source.height]);
  expect(made.created_at).toBeLessThanOrEqual(source.created_at);

  // And what is made from it is its child.
  const before = (await (await request.get(`/api/outputs/${parent}/lineage`)).json())
    .children.length;
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(async () => {
    const lineage = await (await request.get(`/api/outputs/${parent}/lineage`)).json();
    return lineage.children.length;
  }, { timeout: 30_000 }).toBe(before + 1);
});
