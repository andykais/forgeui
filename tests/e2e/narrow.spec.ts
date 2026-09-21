import { expect, test } from "@playwright/test";

/**
 * The Generate page in half a screen (§11.3).
 *
 * Side by side with an editor, the two fixed columns — 360px of params and
 * 306px of metadata — left the media about 240px, and the button that would
 * have given it its width back was pushed off the right edge of a header
 * that had run out of room. Below half a 16:9 window the layout turns: the
 * params take half the width, and the metadata takes half the *height* of
 * what is left.
 */

/**
 * Half of a 1920×1080 screen as a browser really reports it.
 *
 * The window is 960×1080 on the outside; the tab strip and the address bar
 * take their share, so the page gets about 960×990. This number is the whole
 * point of the test: an earlier version asserted 960×1080, which is the
 * viewport of a browser with no chrome at all, and that is the one aspect
 * ratio at which a rule written as `max-aspect-ratio: 8/9` still fired. It
 * passed, and the app did not work.
 */
const HALF = { width: 960, height: 990 };
/** The same window with a fuller chrome — a bookmarks bar, a smaller screen. */
const HALF_SHORT = { width: 960, height: 900 };
/** The suite's own viewport: a normal window, where nothing may change. */
const WIDE = { width: 1440, height: 900 };

/**
 * Something to open, made with a workflow of this file's own.
 *
 * Not Krea 2 Turbo: the panel refills itself from the last job for whichever
 * workflow is selected, so running one here would leave `smoke.spec.ts` —
 * which sorts after this file — a pre-filled prompt where it asserts that a
 * required field starts empty and gates the Generate button.
 */
async function anOutput(page: import("@playwright/test").Page) {
  await page.goto("/generate");
  await expect(page.getByText("ComfyUI connected")).toBeVisible();
  if (await page.locator(".tile").count() > 0) return;
  await page.locator(".workflow-card").click();
  await page.getByRole("button", { name: /^Illustrious XL prompt/ }).click();
  await expect(page.locator('[data-panel-loading="false"]')).toBeVisible();
  await page.locator('[data-param="prompt"] textarea').fill("a heron in reeds");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.locator(".tile")).toHaveCount(1, { timeout: 30_000 });
}

/** The sidebar is a stored preference, so every test leaves it showing. */
async function showMetadata(page: import("@playwright/test").Page) {
  const show = page.getByRole("button", { name: "Show metadata" });
  if (await show.count() > 0) await show.first().click();
  await expect(page.locator("aside.sidebar")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("in half a 16:9 window the metadata sits under the media", async ({ page }) => {
  await page.setViewportSize(HALF);
  await anOutput(page);
  await page.locator(".tile .surface").first().click();
  await showMetadata(page);

  await expectStacked(page);
});

/** And with more chrome than that, or a shorter screen behind it. */
test("a shorter window of the same width stacks too", async ({ page }) => {
  await page.setViewportSize(HALF_SHORT);
  await anOutput(page);
  await page.locator(".tile .surface").first().click();
  await showMetadata(page);

  await expectStacked(page);
});

async function expectStacked(page: import("@playwright/test").Page) {
  const panel = (await page.locator(".panel").boundingBox())!;
  const viewer = (await page.locator(".viewer").boundingBox())!;
  const media = (await page.locator(".media").boundingBox())!;
  const sidebar = (await page.locator("aside.sidebar").boundingBox())!;

  // Half the width each, of whatever the rail leaves.
  expect(Math.abs(panel.width - viewer.width)).toBeLessThan(2);
  // And the metadata is below the media rather than beside it, half high.
  expect(sidebar.y).toBeGreaterThan(media.y + media.height - 1);
  expect(Math.abs(sidebar.width - viewer.width)).toBeLessThan(2);
  expect(Math.abs(sidebar.height - viewer.height / 2)).toBeLessThan(4);
}

test("the metadata toggle is reachable, and gives the media the column", async ({ page }) => {
  await page.setViewportSize(HALF);
  await anOutput(page);
  await page.locator(".tile .surface").first().click();
  await showMetadata(page);

  // Whatever else the header drops, this button stays on screen: with the
  // sidebar open it is the only way to make the media bigger.
  const toggle = page.getByRole("button", { name: "Hide metadata" });
  await expect(toggle).toBeVisible();
  const box = (await toggle.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(HALF.width);

  const before = (await page.locator(".media").boundingBox())!;
  await toggle.click();
  await expect(page.locator("aside.sidebar")).toHaveCount(0);
  const after = (await page.locator(".media").boundingBox())!;
  // Params on the left, media on the right, and the media has the height.
  expect(after.height).toBeGreaterThan(before.height * 1.8);

  await showMetadata(page);
});

test("a normal window is untouched: two columns, 306px of metadata", async ({ page }) => {
  await page.setViewportSize(WIDE);
  await anOutput(page);
  await page.locator(".tile .surface").first().click();
  await showMetadata(page);

  const media = (await page.locator(".media").boundingBox())!;
  const sidebar = (await page.locator("aside.sidebar").boundingBox())!;
  expect(sidebar.width).toBe(306);
  // Beside, not below.
  expect(sidebar.y).toBeLessThan(media.y + 1);
  expect(sidebar.x).toBeGreaterThan(media.x + media.width - 1);
  // And the id, which the narrow header hides, is back.
  await expect(page.locator(".viewer .id")).toBeVisible();

  await page.keyboard.press("Escape");
});
