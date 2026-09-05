/**
 * What the contract tests need from the environment, and the gate that keeps
 * them out of the default suite.
 *
 * `scripts/with_comfy.ts` (`deno task test:comfy`) sets all of it after
 * starting the ComfyUI that `scripts/setup-comfy.sh` provisioned. Setting
 * `FORGEUI_COMFY_URL` by hand points the protocol tests at a ComfyUI of your
 * own; the tests that boot the app also need `FORGEUI_COMFY_DATA_DIR`,
 * because the app's `staging/` has to be that ComfyUI's `--output-directory`
 * (§6.3).
 */

/** Required: without it every contract test is ignored. */
export const COMFY_URL = Deno.env.get("FORGEUI_COMFY_URL");
/** ComfyUI's `--output-directory`, i.e. the app's `<appdata>/staging`. */
export const OUTPUT_DIR = Deno.env.get("FORGEUI_COMFY_OUTPUT_DIR");
/** ComfyUI's `--input-directory`. */
export const INPUT_DIR = Deno.env.get("FORGEUI_COMFY_INPUT_DIR");
/** An `<appdata>` laid out around those two, for the tests that boot the app. */
export const DATA_DIR = Deno.env.get("FORGEUI_COMFY_DATA_DIR");
/** The ComfyUI install, for its model folders. */
export const COMFY_DIR = Deno.env.get("FORGEUI_COMFY_DIR");
/** A checkpoint filename as ComfyUI lists it; enables the sampler tests. */
export const CHECKPOINT = Deno.env.get("FORGEUI_COMFY_CKPT");

export interface ContractTestOptions {
  /** Needs a real checkpoint, so it is skipped unless one was named. */
  sampler?: boolean;
  /** Boots the app, so it also needs the shared data dir. */
  app?: boolean;
}

export function contractTest(
  name: string,
  fn: () => Promise<void>,
  options: ContractTestOptions = {},
): void {
  const missing = COMFY_URL === undefined ||
    (options.sampler === true && CHECKPOINT === undefined) ||
    (options.app === true &&
      (DATA_DIR === undefined || COMFY_DIR === undefined));
  Deno.test({ name, ignore: missing, fn });
}
