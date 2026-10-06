import { expect, type Page, test } from "@playwright/test";
import { deflateSync } from "node:zlib";

/**
 * The mask editor (DESIGN.md §10): a mask is painted over the picture its
 * param names, with a brush and an eraser, undo, invert and the keys of
 * §11.4, and what Done stores is a grey PNG the size of that picture.
 * `sd15-inpaint` is the workflow that takes one (§4.6).
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A solid RGB PNG, so the test needs no fixture file. */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** How much of the editor's canvas is painted, 0 to 1. */
function painted(page: Page): Promise<number> {
  return page.locator("[data-mask-canvas]").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height)
      .data;
    let covered = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 127) covered++;
    return covered / (canvas.width * canvas.height);
  });
}

/** A stroke across the middle third of the picture, left to right. */
async function strokeAcross(page: Page) {
  const box = (await page.locator("[data-mask-canvas]").boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 3, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(box.x + box.width / 3 + (box.width / 3) * (step / 10), y);
  }
  await page.mouse.up();
}

test("a mask is painted over its picture, and the run takes it", async ({ page, request }) => {
  await page.goto("/generate?workflow=sd15-inpaint");
  await expect(page.locator(".workflow-card")).toContainText("Stable Diffusion 1.5 (inpaint)");
  await expect(page.locator('[data-panel-loading="false"]')).toBeVisible();

  // Nothing to paint on yet, and it says what is missing.
  const maskRow = page.locator('[data-param="mask"]');
  await expect(maskRow).toContainText("Attach the image first");
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();

  await page.locator('[data-param="image"] input[type="file"]').setInputFiles({
    name: "field.png",
    mimeType: "image/png",
    buffer: png(320, 240, [90, 120, 60]),
  });
  await expect(page.locator('[data-param="image"]')).toContainText("320×240");

  // Into the editor.
  await page.getByRole("button", { name: "Mask: paint the mask" }).click();
  const editor = page.getByRole("dialog", { name: "Paint Mask" });
  await expect(editor).toBeVisible();
  await expect(page.locator("[data-mask-canvas]")).toHaveAttribute("width", "320");
  await expect(page.locator("[data-mask-canvas]")).toHaveAttribute("height", "240");
  expect(await painted(page)).toBe(0);

  // The brush starts at a twelfth of the short side; `]` and `[` step it.
  const size = editor.getByLabel("Brush size");
  await expect(size).toHaveValue("20");
  await page.keyboard.press("]");
  await expect(size).toHaveValue("25");
  await page.keyboard.press("[");
  await expect(size).toHaveValue("20");

  await strokeAcross(page);
  const stroke = await painted(page);
  // A 20px brush across a third of a 320px picture: about 3% of it.
  expect(stroke).toBeGreaterThan(0.02);
  expect(stroke).toBeLessThan(0.05);

  // `z` undoes the stroke, `y` brings it back; the buttons agree.
  await page.keyboard.press("z");
  expect(await painted(page)).toBe(0);
  await expect(editor.getByRole("button", { name: "Undo" })).toBeDisabled();
  await page.keyboard.press("y");
  expect(await painted(page)).toBeCloseTo(stroke, 5);

  // Invert swaps painted and kept; twice is where it started.
  await editor.getByRole("button", { name: "Invert" }).click();
  expect(await painted(page)).toBeCloseTo(1 - stroke, 1);
  await editor.getByRole("button", { name: "Invert" }).click();
  expect(await painted(page)).toBeCloseTo(stroke, 5);

  // The eraser takes paint off where it goes.
  await editor.getByRole("radio", { name: "Eraser" }).click();
  await strokeAcross(page);
  expect(await painted(page)).toBeLessThan(stroke / 4);
  await page.keyboard.press("z");
  expect(await painted(page)).toBeCloseTo(stroke, 5);

  // Escape is the editor's own: it closes the editor and leaves the screen
  // behind it alone — and keeps nothing that was painted.
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(page.locator(".workflow-card")).toBeVisible();
  await expect(page.getByRole("button", { name: "Mask: paint the mask" })).toBeVisible();

  // Again, for real this time.
  await page.getByRole("button", { name: "Mask: paint the mask" }).click();
  await strokeAcross(page);
  await editor.getByRole("button", { name: "Done" }).click();
  await expect(editor).toHaveCount(0);
  const edit = page.getByRole("button", { name: "Mask: edit the mask" });
  await expect(edit).toBeVisible();
  await expect(edit.locator("[data-mask-tint]")).toBeVisible();

  // Reopened, it paints on top of what is there.
  await edit.click();
  await expect.poll(() => painted(page)).toBeGreaterThan(0.02);
  await editor.getByRole("button", { name: "Cancel" }).click();

  const prompt = `a stone well in the field, ${Date.now()}`;
  await page.locator('[data-param="prompt"] textarea').fill(prompt);
  const before = await page.locator(".tile").count();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.locator(".tile")).toHaveCount(before + 1, { timeout: 30_000 });

  // The run recorded the mask, and the mask is the picture's size: white
  // where the stroke went, black where it did not (§9).
  const { outputs } = await (await request.get("/api/outputs?limit=1")).json();
  expect(outputs[0].prompt).toBe(prompt);
  const output = await (await request.get(`/api/outputs/${outputs[0].id}`)).json();
  const mask = output.params.mask as string;
  expect(mask).toMatch(/^[0-9a-f]{64}\.png$/);
  const stored = await (await request.get(`/api/inputs/${mask.slice(0, 64)}`)).json();
  expect([stored.width, stored.height]).toEqual([320, 240]);
  const [middle, corner] = await page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    return [
      [...ctx.getImageData(160, 120, 1, 1).data],
      [...ctx.getImageData(2, 2, 1, 1).data],
    ];
  }, stored.url);
  expect(middle).toEqual([255, 255, 255, 255]);
  expect(corner).toEqual([0, 0, 0, 255]);
});

test("a mask from another picture says to paint it again", async ({ page }) => {
  await page.goto("/generate?workflow=sd15-inpaint");
  await expect(page.locator('[data-panel-loading="false"]')).toBeVisible();
  const imageInput = page.locator('[data-param="image"] input[type="file"]');
  await imageInput.setInputFiles({
    name: "small.png",
    mimeType: "image/png",
    buffer: png(64, 64, [200, 40, 40]),
  });
  await expect(page.locator('[data-param="image"]')).toContainText("64×64");
  await page.getByRole("button", { name: /Mask: (paint|edit) the mask/ }).click();
  await strokeAcross(page);
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("button", { name: "Mask: edit the mask" })).toBeVisible();

  // A different picture under the same mask.
  await imageInput.setInputFiles({
    name: "wide.png",
    mimeType: "image/png",
    buffer: png(96, 64, [40, 40, 200]),
  });
  await expect(page.locator('[data-param="mask"]')).toContainText(
    "Painted on a 64×64 picture; this one is 96×64. Paint it again.",
  );
});
