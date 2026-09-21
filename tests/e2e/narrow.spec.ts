import { expect, test } from "@playwright/test";

/**
 * Where Generate puts its three panes (§11.3), and what a window too narrow
 * for three columns does to that.
 *
 * The narrow rule came first, from the app sitting in half a screen beside
 * an editor: 360px of params plus 306px of metadata left the media about
 * 240px, and the button that would have given it its width back had been
 * pushed off the end of the header. The layouts came after, because the
 * shape people want is not always the shape the window implies.
 */

/**
 * Half of a 1920×1080 screen as a browser really reports it.
 *
 * The window is 960×1080 on the outside; the tab strip and the address bar
 * take their share, so the page gets about 960×990. This number is the whole
 * point: an earlier version asserted 960×1080, which is the viewport of a
 * browser with no chrome at all, and that is the one aspect ratio at which a
 * rule written as `max-aspect-ratio: 8/9` still fired. It passed, and the
 * app did not work.
 */
const HALF = { width: 960, height: 990 };
/** The same window with a fuller chrome — a bookmarks bar, a smaller screen. */
const HALF_SHORT = { width: 960, height: 900 };
/** A normal window, where every layout has room to be itself. */
const WIDE = { width: 1600, height: 950 };

const LABELS = {
  columns: "Metadata beside",
  split: "Metadata below",
  wide: "No metadata",
  top: "Media on top",
  "top-split": "Media on top, metadata beside",
} as const;

async function anOutput(page: import("@playwright/test").Page) {
  await page.goto("/generate");
  await expect(page.getByText("ComfyUI connected")).toBeVisible();
  if (await page.locator(".tile").count() > 0) return;
  // Not Krea 2 Turbo: the panel refills itself from the last job for the
  // selected workflow, and `smoke.spec.ts` — which sorts after this file —
  // asserts that its required field starts empty.
  await page.locator(".workflow-card").click();
  await page.getByRole("button", { name: /^Illustrious XL prompt/ }).click();
  await expect(page.locator('[data-panel-loading="false"]')).toBeVisible();
  await page.locator('[data-param="prompt"] textarea').fill("a heron in reeds");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.locator(".tile")).toHaveCount(1, { timeout: 30_000 });
}

async function openOne(page: import("@playwright/test").Page) {
  await anOutput(page);
  await page.locator(".tile .surface").first().click();
  await expect(page.locator(".main")).toBeVisible();
}

/** Pick a layout through the control, the way a person would. */
async function choose(
  page: import("@playwright/test").Page,
  layout: keyof typeof LABELS,
) {
  await page.locator(".trigger").first().click();
  await page.getByRole("button", { name: LABELS[layout], exact: true }).click();
  await expect(page.locator(".generate")).toHaveAttribute(
    "data-layout",
    layout,
  );
}

type Box = { x: number; y: number; width: number; height: number };

async function boxes(page: import("@playwright/test").Page) {
  const at = async (selector: string): Promise<Box | null> => {
    const one = page.locator(selector).first();
    return await one.count() > 0 ? (await one.boundingBox())! : null;
  };
  return {
    screen: (await at(".generate"))!,
    inputs: (await at(".panel"))!,
    media: (await at(".main .media"))!,
    meta: await at("aside.sidebar"),
  };
}

/** Every layout is left at the one the app opens as. */
test.afterEach(async ({ page }) => {
  await page.goto("/generate");
  await page.evaluate(() =>
    fetch("/api/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ui: { layout: { generate: "columns" } } }),
    })
  );
});

test.describe.configure({ mode: "serial" });

test("the five layouts put the three panes where they say", async ({ page }) => {
  await page.setViewportSize(WIDE);
  await openOne(page);

  // Three columns: inputs, media, metadata, in that order across.
  await choose(page, "columns");
  let seen = await boxes(page);
  expect(seen.meta).not.toBeNull();
  expect(seen.media.x).toBeGreaterThan(seen.inputs.x + seen.inputs.width - 1);
  expect(seen.meta!.x).toBeGreaterThan(seen.media.x + seen.media.width - 1);
  expect(seen.inputs.height).toBe(seen.screen.height);

  // Inputs beside, media over metadata.
  await choose(page, "split");
  seen = await boxes(page);
  expect(seen.inputs.height).toBe(seen.screen.height);
  expect(seen.meta!.y).toBeGreaterThan(seen.media.y + seen.media.height - 1);
  expect(seen.meta!.x).toBeGreaterThan(seen.inputs.x + seen.inputs.width - 1);

  // Inputs beside, media alone.
  await choose(page, "wide");
  seen = await boxes(page);
  expect(seen.meta).toBeNull();
  expect(seen.media.x).toBeGreaterThan(seen.inputs.x + seen.inputs.width - 1);
  expect(seen.inputs.height).toBe(seen.screen.height);

  // Media across the top, inputs the full width underneath.
  await choose(page, "top");
  seen = await boxes(page);
  expect(seen.meta).toBeNull();
  expect(seen.inputs.y).toBeGreaterThan(seen.media.y + seen.media.height - 1);
  expect(seen.inputs.width).toBe(seen.screen.width);

  // Media across the top; inputs and metadata share the row beneath it.
  await choose(page, "top-split");
  seen = await boxes(page);
  expect(seen.inputs.y).toBeGreaterThan(seen.media.y + seen.media.height - 1);
  expect(seen.meta!.y).toBe(seen.inputs.y);
  expect(seen.meta!.x).toBeGreaterThan(seen.inputs.x + seen.inputs.width - 1);
  expect(Math.round(seen.inputs.width + seen.meta!.width))
    .toBe(Math.round(seen.screen.width));
});

test("browsing the grid, no layout holds an empty metadata pane", async ({ page }) => {
  await page.setViewportSize(WIDE);
  await openOne(page);
  await choose(page, "columns");

  // Back to the results: there is nothing selected, so there is nothing for
  // a metadata column to hold.
  await page.keyboard.press("Escape");
  await expect(page.locator(".results")).toBeVisible();
  await expect(page.locator(".generate")).toHaveAttribute(
    "data-layout",
    "wide",
  );
  const results = (await page.locator(".results").boundingBox())!;
  const inputs = (await page.locator(".panel").boundingBox())!;
  const screen = (await page.locator(".generate").boundingBox())!;
  expect(Math.round(results.width + inputs.width)).toBe(
    Math.round(screen.width),
  );
});

test("Gallery is offered only the layouts it can use", async ({ page }) => {
  await page.setViewportSize(WIDE);
  await anOutput(page);
  await page.getByRole("link", { name: "Gallery" }).click();
  await page.locator(".tile .surface").first().click();
  await expect(page.locator(".main")).toBeVisible();

  await page.locator(".trigger").first().click();
  // No inputs panel there, so the two arrangements that mention one are not
  // offered at all.
  await expect(page.locator(".option")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Media on top", exact: true }))
    .toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("in half a 16:9 window the metadata sits under the media", async ({ page }) => {
  await page.setViewportSize(HALF);
  await openOne(page);
  await expectStacked(page);
});

/** And with more chrome than that, or a shorter screen behind it. */
test("a shorter window of the same width stacks too", async ({ page }) => {
  await page.setViewportSize(HALF_SHORT);
  await openOne(page);
  await expectStacked(page);
});

/**
 * Three columns asked for, but there is no width for them: the metadata
 * takes height instead, which is the `split` arrangement arrived at by the
 * window rather than by the picker.
 */
async function expectStacked(page: import("@playwright/test").Page) {
  await expect(page.locator(".generate")).toHaveAttribute(
    "data-layout",
    "columns",
  );
  const seen = await boxes(page);
  expect(Math.abs(seen.inputs.width - seen.screen.width / 2)).toBeLessThan(2);
  expect(seen.meta!.y).toBeGreaterThan(seen.media.y + seen.media.height - 1);
  expect(Math.abs(seen.meta!.height - seen.screen.height / 2)).toBeLessThan(4);
}

test("the layout control is reachable in a narrow window", async ({ page }) => {
  await page.setViewportSize(HALF);
  await openOne(page);

  // Whatever else the header drops, this stays on screen: it is what gets
  // the media its room back.
  const trigger = page.locator(".viewer .trigger, .main .trigger").first();
  await expect(trigger).toBeVisible();
  const box = (await trigger.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(HALF.width);

  const before = (await page.locator(".main .media").boundingBox())!;
  await choose(page, "wide");
  const after = (await page.locator(".main .media").boundingBox())!;
  expect(after.height).toBeGreaterThan(before.height * 1.5);
  await expect(page.locator("aside.sidebar")).toHaveCount(0);
});

test("a normal window is untouched: three columns, 306px of metadata", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOne(page);
  await choose(page, "columns");

  const seen = await boxes(page);
  expect(seen.meta!.width).toBe(306);
  // A column of its own, floor to ceiling, beside the media.
  expect(seen.meta!.y).toBe(seen.screen.y);
  expect(seen.meta!.height).toBe(seen.screen.height);
  await expect(page.locator(".viewer .id, .main .id")).toBeVisible();
  await page.keyboard.press("Escape");
});
