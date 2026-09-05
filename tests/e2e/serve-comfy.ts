import { dirname, fromFileUrl, join } from "@std/path";
import { startApp } from "../../src/main.ts";

/**
 * The e2e server, but against the real ComfyUI `scripts/with_comfy.ts`
 * started rather than the fake behind a stub interpreter (`serve.ts`). It
 * boots on the data directory that wrapper created, whose `staging/` is that
 * ComfyUI's `--output-directory`.
 *
 * Only `tests/e2e/comfy.spec.ts` uses it, and only through
 * `deno task test:e2e:comfy`.
 */
const url = Deno.env.get("FORGEUI_COMFY_URL");
const dataDir = Deno.env.get("FORGEUI_COMFY_DATA_DIR");
const comfyDir = Deno.env.get("FORGEUI_COMFY_DIR");
const checkpoint = Deno.env.get("FORGEUI_COMFY_CKPT");
if (!url || !dataDir || !comfyDir) {
  console.error(
    "serve-comfy.ts needs FORGEUI_COMFY_URL, FORGEUI_COMFY_DATA_DIR and " +
      "FORGEUI_COMFY_DIR; run it through `deno task test:e2e:comfy`.",
  );
  Deno.exit(1);
}

const here = dirname(fromFileUrl(import.meta.url));
const repo = join(here, "..", "..");
const port = Number(Deno.env.get("FORGEUI_E2E_COMFY_APP_PORT") ?? "7898");

await Deno.writeTextFile(
  join(dataDir, "config.yaml"),
  [
    "comfy:",
    "  mode: local_url",
    `  url: ${url}`,
    "model_folders:",
    `  checkpoints: ["${join(comfyDir, "models", "checkpoints")}"]`,
    `  loras: ["${join(comfyDir, "models", "loras")}"]`,
    "",
  ].join("\n"),
);

// The bundled sd15 graph names the checkpoint setup-comfy.sh downloads; a
// different one gets a user copy that shadows it (§4.6).
const bundled = join(repo, "workflows", "bundled", "sd15");
const api = JSON.parse(
  await Deno.readTextFile(join(bundled, "workflow.api.json")),
);
if (checkpoint && api["1"].inputs.ckpt_name !== checkpoint) {
  const user = join(dataDir, "workflows", "user", "sd15");
  await Deno.mkdir(user, { recursive: true });
  api["1"].inputs.ckpt_name = checkpoint;
  await Deno.writeTextFile(
    join(user, "workflow.api.json"),
    JSON.stringify(api, null, 2),
  );
  await Deno.copyFile(
    join(bundled, "manifest.json"),
    join(user, "manifest.json"),
  );
}

const app = await startApp({
  argv: ["--data-dir", dataDir, "--port", String(port)],
});
await app.comfy.waitForState("running", 60_000).catch((error) => {
  console.error("ComfyUI did not come up:", error);
});
console.log(`e2e server ready on ${app.url}, ComfyUI at ${url}`);

const stop = async () => {
  await app.shutdown();
  Deno.exit(0);
};
Deno.addSignalListener("SIGTERM", stop);
Deno.addSignalListener("SIGINT", stop);
await new Promise(() => {});
