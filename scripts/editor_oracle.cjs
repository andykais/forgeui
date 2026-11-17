// What ComfyUI's own editor queues for a saved workflow: load each editor
// document into the frontend in a headless browser and call
// app.graphToPrompt(). The reference editorToApi is tested against
// (tests/golden/editor_graph/_case.md).
//
//   node scripts/editor_oracle.cjs <comfyui url> <dir of editor json> <out dir> [name…]
//
// Needs Playwright (tests/e2e has it: NODE_PATH=tests/e2e/node_modules) and a
// running ComfyUI. Writes <out dir>/<name>.json, or <name>.json.err.
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const [, , url, srcDir, outDir, ...names] = process.argv;
  if (!url || !srcDir || !outDir) {
    console.error(
      "usage: editor_oracle.cjs <comfyui url> <src dir> <out dir> [name…]",
    );
    process.exit(2);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch(
    process.env.FORGEUI_E2E_BROWSER
      ? { executablePath: process.env.FORGEUI_E2E_BROWSER }
      : {},
  );
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => globalThis.app?.graph, null, {
    timeout: 120_000,
  });
  const files = names.length > 0
    ? names.map((n) => `${n}.json`)
    : fs.readdirSync(srcDir).filter((f) => f.endsWith(".json"));
  let ok = 0;
  let failed = 0;
  for (const file of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(srcDir, file), "utf8"));
    try {
      const output = await page.evaluate(async (doc) => {
        await globalThis.app.loadGraphData(doc, true, true, null, {
          showMissingModelsDialog: false,
          showMissingNodesDialog: false,
        });
        return (await globalThis.app.graphToPrompt()).output;
      }, doc);
      fs.writeFileSync(
        path.join(outDir, file),
        `${JSON.stringify(output, null, 1)}\n`,
      );
      ok++;
    } catch (error) {
      fs.writeFileSync(path.join(outDir, `${file}.err`), String(error));
      failed++;
    }
  }
  console.log(`ok ${ok}, failed ${failed}`);
  await browser.close();
})();
