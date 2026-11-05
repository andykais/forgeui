import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type TestApp, withTestApp } from "../fixtures/app.ts";
import { tinyPng } from "../fixtures/png.ts";
import { decodePng } from "../../src/jobs/png.ts";
import { ffmpegAvailable } from "../../src/media/audio.ts";

const haveFfmpeg = await ffmpegAvailable();

/**
 * Masks drawn from shapes, and a mask tinted over its picture (§9), through
 * the routes `forge mcp` calls. The pixels are decoded and checked, because
 * "a PNG came back" is exactly what a white-on-transparent mask also does.
 */

interface MaskView {
  sha256: string;
  filename: string;
  width: number;
  height: number;
  coverage: number;
}

async function upload(
  app: TestApp,
  bytes: Uint8Array,
  name = "picture.png",
): Promise<{ sha256: string; filename: string }> {
  const form = new FormData();
  form.set("file", new File([bytes.buffer as ArrayBuffer], name));
  return await app.json("/api/inputs", { method: "POST", body: form });
}

function draw(app: TestApp, body: unknown): Promise<Response> {
  return app.fetch("/api/inputs/mask", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function pixelsOf(app: TestApp, sha256: string) {
  const view = await app.json<{ url: string }>(`/api/inputs/${sha256}`);
  const bytes = new Uint8Array(await (await app.fetch(view.url)).arrayBuffer());
  return (await decodePng(bytes))!;
}

Deno.test("a mask drawn from shapes is the image's size, white on black", async () => {
  await withTestApp(async (app) => {
    const image = await upload(app, tinyPng({ width: 200, height: 100 }));
    const response = await draw(app, {
      image: image.filename,
      shapes: [{ shape: "rect", x: 0.5, y: 0, w: 0.5, h: 1 }],
    });
    assertEquals(response.status, 201);
    const mask = await response.json() as MaskView;
    assertEquals([mask.width, mask.height], [200, 100]);
    assertEquals(mask.coverage, 0.5);
    assert(mask.filename.endsWith(".png"));

    // The red channel is what LoadImageMask reads: white repaints.
    const pixels = await pixelsOf(app, mask.sha256);
    const red = (x: number, y: number) => pixels.rgba[(y * 200 + x) * 4];
    assertEquals(red(10, 50), 0);
    assertEquals(red(150, 50), 255);
    // Opaque: a transparent background is the convention nobody reads right.
    assertEquals(pixels.rgba[3], 255);

    // It goes into a job as any mask does — the submit's size check passes.
    const job = await app.fetch("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: "sd15-inpaint",
        params: { prompt: "x", image: image.filename, mask: mask.filename },
      }),
    });
    await job.body?.cancel();
    // No ComfyUI in this app: refused for that, not for the mask.
    assertEquals(job.status, 503);
  });
});

Deno.test("start_from paints over a mask that exists, and must fit the image", async () => {
  await withTestApp(async (app) => {
    const image = await upload(app, tinyPng({ width: 100, height: 100 }));
    // A mask painted in the editor: the left half.
    const painted = await upload(
      app,
      tinyPng({
        width: 100,
        height: 100,
        pixel: (x) => (x < 50 ? [255, 255, 255] : [0, 0, 0]),
      }),
    );
    const response = await draw(app, {
      image: image.filename,
      start_from: painted.filename,
      shapes: [{ shape: "rect", x: 0, y: 0, w: 1, h: 0.5, erase: true }],
    });
    assertEquals(response.status, 201);
    const mask = await response.json() as MaskView;
    // The bottom-left quarter is what is left.
    assertEquals(mask.coverage, 0.25);

    const small = await upload(app, tinyPng({ width: 40, height: 40 }));
    const misfit = await draw(app, {
      image: image.filename,
      start_from: small.filename,
      shapes: [{ shape: "rect", x: 0, y: 0, w: 1, h: 1 }],
    });
    assertEquals(misfit.status, 400);
    const body = await misfit.json() as { error: { message: string } };
    assertStringIncludes(body.error.message, "painted on a 40×40 picture");
  });
});

Deno.test("a mask is drawn tinted over its picture, fitted to max_edge", async () => {
  await withTestApp(async (app) => {
    const image = await upload(
      app,
      tinyPng({ width: 400, height: 200, color: [0, 0, 255] }),
    );
    const mask = await (await draw(app, {
      image: image.filename,
      shapes: [{ shape: "rect", x: 0, y: 0, w: 0.5, h: 1 }],
    })).json() as MaskView;

    const response = await app.fetch(
      `/api/inputs/${mask.sha256}/overlay?on=${image.filename}&max_edge=100`,
    );
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "image/png");
    const preview = (await decodePng(
      new Uint8Array(await response.arrayBuffer()),
    ))!;
    assertEquals([preview.width, preview.height], [100, 50]);
    const at = (
      x: number,
      y: number,
    ) => [...preview.rgba.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 3)];
    // Masked: half the tint over the blue. Not masked: the blue as it was.
    assertEquals(at(10, 25), [128, 16, 160]);
    assertEquals(at(90, 25), [0, 0, 255]);

    const other = await upload(app, tinyPng({ width: 64, height: 64 }));
    const misfit = await app.fetch(
      `/api/inputs/${mask.sha256}/overlay?on=${other.filename}`,
    );
    assertEquals(misfit.status, 400);
    await misfit.body?.cancel();
  });
});

Deno.test({
  name: "a mask is drawn over a JPEG too, which ffmpeg decodes",
  ignore: !haveFfmpeg,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "forgeui-mask-jpeg-" });
    try {
      const png = `${dir}/in.png`, jpeg = `${dir}/in.jpg`;
      await Deno.writeFile(
        png,
        tinyPng({ width: 120, height: 80, color: [0, 0, 255] }),
      );
      const made = await new Deno.Command("ffmpeg", {
        args: ["-v", "error", "-y", "-i", png, "-q:v", "2", jpeg],
        stdout: "null",
        stderr: "null",
      }).output();
      assert(made.success, "ffmpeg made the JPEG");
      await withTestApp(async (app) => {
        const image = await upload(app, await Deno.readFile(jpeg), "in.jpg");
        assert(image.filename.endsWith(".jpg"), image.filename);
        const mask = await (await draw(app, {
          image: image.filename,
          shapes: [{ shape: "ellipse", x: 0.25, y: 0.25, w: 0.5, h: 0.5 }],
        })).json() as MaskView;
        const response = await app.fetch(
          `/api/inputs/${mask.sha256}/overlay?on=${image.filename}`,
        );
        assertEquals(response.status, 200);
        const preview = (await decodePng(
          new Uint8Array(await response.arrayBuffer()),
        ))!;
        // Never enlarged past the picture's own size.
        assertEquals([preview.width, preview.height], [120, 80]);
        const centre = (40 * 120 + 60) * 4;
        // Tinted toward red in the middle; a JPEG is not exact, so roughly.
        assert(preview.rgba[centre]! > 100, `red ${preview.rgba[centre]}`);
      });
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("a mask request that names nothing real is refused", async () => {
  await withTestApp(async (app) => {
    const missing = await draw(app, {
      image: "b".repeat(64) + ".png",
      shapes: [{ shape: "rect", x: 0, y: 0, w: 1, h: 1 }],
    });
    assertEquals(missing.status, 400);
    const body = await missing.json() as { error: { message: string } };
    assertStringIncludes(body.error.message, "no input");
  });
});
