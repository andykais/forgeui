import { dirname, fromFileUrl, join } from "@std/path";
import { startApp } from "../../src/main.ts";

/**
 * Boots the app for the end-to-end test the way a user would meet it: the
 * built Svelte app served by the Deno process, with ComfyUI managed as a child
 * process — except that the "python" it launches is a stub that runs the fake
 * ComfyUI (§14.1), so the whole path is exercised without a GPU.
 */
const here = dirname(fromFileUrl(import.meta.url));
const repo = join(here, "..", "..");
const dataDir = Deno.env.get("FORGEUI_E2E_DATA_DIR") ?? join(here, ".tmp-data");
const port = Number(Deno.env.get("FORGEUI_E2E_PORT") ?? "7899");
const comfyPort = Number(Deno.env.get("FORGEUI_E2E_COMFY_PORT") ?? "8299");

await Deno.remove(dataDir, { recursive: true }).catch(() => {});
await Deno.mkdir(join(dataDir, "ComfyUI"), { recursive: true });
await Deno.writeTextFile(join(dataDir, "ComfyUI", "main.py"), "# a stand-in\n");

const stub = join(dataDir, "python-stub.sh");
await Deno.writeTextFile(
  stub,
  `#!/usr/bin/env bash\nshift\nexec ${Deno.execPath()} run --quiet ` +
    `--allow-net --allow-read --allow-write --allow-env ` +
    `${join(repo, "tests", "fake-comfy", "main.ts")} "$@"\n`,
);
await Deno.chmod(stub, 0o755);

/**
 * A couple of fixture LoRAs, so the pickers and the MODELS chips have
 * something real to show and the read-only model scan is exercised end to
 * end. A safetensors file is an 8-byte little-endian header length, a JSON
 * header, then tensor bytes; the Phase 1 scan only stats them, but a
 * plausible file costs nothing.
 */
const loraDir = join(dataDir, "models", "loras");
await Deno.mkdir(loraDir, { recursive: true });
for (const name of ["film-grain-35mm", "soft-studio-light"]) {
  const header = new TextEncoder().encode(
    JSON.stringify({ __metadata__: { name } }),
  );
  const file = new Uint8Array(8 + header.length + 16);
  new DataView(file.buffer).setBigUint64(0, BigInt(header.length), true);
  file.set(header, 8);
  await Deno.writeFile(join(loraDir, `${name}.safetensors`), file);
}

// Extra args reach the child verbatim (§3.1), which is how the demo slows
// the fake down enough to watch progress arrive.
const stepDelay = Deno.env.get("FORGEUI_E2E_STEP_DELAY");
await Deno.writeTextFile(
  join(dataDir, "config.yaml"),
  [
    "comfy:",
    "  mode: managed",
    `  path: ${join(dataDir, "ComfyUI")}`,
    `  url: http://127.0.0.1:${comfyPort}`,
    `  python: ${stub}`,
    ...(stepDelay ? [`  extra_args: ["--step-delay", "${stepDelay}"]`] : []),
    "model_folders:",
    `  loras: ["${loraDir}"]`,
    "",
  ].join("\n"),
);

const app = await startApp({
  argv: ["--data-dir", dataDir, "--port", String(port)],
});
await app.comfy.waitForState("running", 60_000).catch((error) => {
  console.error("ComfyUI did not come up:", error);
});
console.log(`e2e server ready on ${app.url}`);

const stop = async () => {
  await app.shutdown();
  Deno.exit(0);
};
Deno.addSignalListener("SIGTERM", stop);
Deno.addSignalListener("SIGINT", stop);
await new Promise(() => {});
