import { parseArgs } from "@std/cli/parse-args";
import { startFakeComfy } from "./server.ts";
import type { ScenarioName } from "./scenarios.ts";

/**
 * The fake ComfyUI as a command line program, so the managed-child-process
 * path (§2) can be tested for real: a stub interpreter runs this in place of
 * `main.py` and it accepts the flags the app passes.
 */
if (import.meta.main) {
  const flags = parseArgs(Deno.args, {
    string: [
      "port",
      "listen",
      "output-directory",
      "input-directory",
      "extra-model-paths-config",
      "scenario",
    ],
    unknown: () => true,
  });

  const port = Number(flags.port ?? "8188");
  const staging = flags["output-directory"];
  if (!staging) {
    console.error("fake ComfyUI: --output-directory is required");
    Deno.exit(2);
  }

  const fake = await startFakeComfy({
    stagingDir: staging,
    inputDir: flags["input-directory"] ?? undefined,
    hostname: flags.listen ?? "127.0.0.1",
    port,
    scenario: (flags.scenario as ScenarioName) ?? "success",
  });

  // Lines the log route can show, in the spirit of ComfyUI's own startup.
  console.log("** fake ComfyUI startup");
  console.log(`** output directory: ${staging}`);
  console.log(`** input directory: ${flags["input-directory"] ?? "(none)"}`);
  console.log(
    `** extra model paths: ${flags["extra-model-paths-config"] ?? "(none)"}`,
  );
  console.log(`Starting server`);
  console.log(`To see the GUI go to: ${fake.url}`);

  const stop = () => {
    console.log("** stopping");
    fake.close().finally(() => Deno.exit(0));
  };
  Deno.addSignalListener("SIGTERM", stop);
  Deno.addSignalListener("SIGINT", stop);
  await new Promise(() => {});
}
