import { expect, type Page, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A video in the viewer, fullscreen, stepped with the arrows (§11.4).
 *
 * The page's player and the fullscreen one exist together while the black
 * field is up, and only the one on top may play. Stepping swapped both
 * players' `src`, and a new `src` with `autoplay` restarts a player — so the
 * page's copy started again underneath: not seen, but heard, a beat behind.
 *
 * The fake ComfyUI makes pictures, not clips, so two of the gallery's outputs
 * are dressed as videos on their way to the page.
 */

const clip = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures/clip.webm"),
);

async function asVideos(page: Page) {
  await page.route("**/qa-fixture/clip.webm*", (route) =>
    route.fulfill({ body: clip, contentType: "video/webm" }));
  const dress = (output: Record<string, unknown>) => ({
    ...output,
    kind: "video",
    // A query string apiece, so stepping really is a change of `src`.
    media_url: `/qa-fixture/clip.webm?${output.id}`,
    width: 64,
    height: 48,
    duration_ms: 2000,
  });
  await page.route(/\/api\/outputs(\?|$)/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.outputs = body.outputs.map(dress);
    await route.fulfill({ response, json: body });
  });
  await page.route(/\/api\/outputs\/[^/?]+$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, ...dress(body) } });
  });
}

/** Which players are playing: the page's and the fullscreen one. */
function playing(page: Page) {
  return page.evaluate(() => ({
    inline: [...document.querySelectorAll<HTMLVideoElement>(".media video")]
      .filter((video) => !video.paused).length,
    full: [...document.querySelectorAll<HTMLVideoElement>(".fullscreen video")]
      .filter((video) => !video.paused).length,
  }));
}

test("stepping a fullscreen video plays it once, not twice", async ({ page, request }) => {
  // Two outputs to step between.
  const before = (await (await request.get("/api/outputs/count")).json()).count;
  if (before < 2) {
    await page.goto("/generate");
    await expect(page.getByText("ComfyUI connected")).toBeVisible();
    await page.locator(".workflow-card").click();
    await page.getByRole("button", { name: /^Illustrious XL prompt/ }).click();
    await expect(page.locator('[data-panel-loading="false"]')).toBeVisible();
    for (let i = before; i < 2; i++) {
      await page.locator('[data-param="prompt"] textarea').fill(`a reel of film, take ${i}`);
      await page.getByRole("button", { name: "Generate", exact: true }).click();
      await expect.poll(async () =>
        (await (await request.get("/api/outputs/count")).json()).count, {
        timeout: 30_000,
      }).toBe(i + 1);
    }
  }

  await asVideos(page);
  await page.goto("/gallery");
  await page.locator(".tile .surface").first().click();
  await expect(page.locator(".media video")).toBeVisible();

  await page.keyboard.press("f");
  await expect(page.locator(".fullscreen video")).toBeVisible();
  await expect.poll(() => playing(page)).toEqual({ inline: 0, full: 1 });

  // Older, then newer again (the first tile is the newest): each step must
  // leave the page's player quiet.
  for (const key of ["ArrowRight", "ArrowLeft"]) {
    const src = await page.locator(".fullscreen video").getAttribute("src");
    await page.keyboard.press(key);
    await expect(page.locator(".fullscreen video")).not.toHaveAttribute("src", src!);
    await expect.poll(() => playing(page)).toEqual({ inline: 0, full: 1 });
    // Long enough for a restarted player to have got going.
    await page.waitForTimeout(600);
    expect(await playing(page)).toEqual({ inline: 0, full: 1 });
  }

  // Out of fullscreen the page's player takes over.
  await page.keyboard.press("Escape");
  await expect(page.locator(".fullscreen")).toHaveCount(0);
  await expect.poll(() => playing(page)).toEqual({ inline: 1, full: 0 });
});
