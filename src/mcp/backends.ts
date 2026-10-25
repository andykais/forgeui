/**
 * From `forge mcp`'s flags to the LLM server it takes turns with
 * (DESIGN-LLM-BACKENDS §3).
 *
 * A pure function, so the rules are tested without starting a process. There
 * is no `config.yaml` side to this: the bridge knows ForgeUI only by URL and
 * needs no data dir, and its launcher already owns its command line.
 */

import type { LlmBackend, LlmHost } from "./llm.ts";
import { LLM_BACKENDS } from "./llm.ts";
import { LlamaSwap } from "./llama.ts";
import { Strata } from "./strata.ts";

export const LLM_API_KEY_ENV = "FORGEUI_LLM_API_KEY";

/** The flags as Cliffy hands them over; every one optional. */
export interface LlmFlags {
  llmBackend?: string;
  llmUrl?: string;
  llmModel?: string;
  llmApiKey?: string;
  llmUnloadTimeout?: number;
  llmBusyWait?: number;
  llmLoadTimeout?: number;
  llmReload?: string;
  llamaSwap?: string;
  strata?: string;
}

export interface LlmOptions {
  backend: LlmBackend;
  url: string;
  model: string | null;
  apiKey: string | null;
  unloadTimeoutMs: number;
  busyWaitS: number;
  loadTimeoutMs: number;
  reload: "lazy" | "eager";
}

/** A flag combination that cannot mean anything. `forge mcp` exits 2. */
export class LlmFlagsError extends Error {
  override readonly name = "LlmFlagsError";
}

export interface EnvReader {
  get(key: string): string | undefined;
}

/**
 * `null` when no backend was named: the bridge then never evicts anything,
 * which is right when the LLM is not on this GPU.
 */
export function resolveLlmOptions(
  flags: LlmFlags,
  env: EnvReader = Deno.env,
): LlmOptions | null {
  const named: { backend: LlmBackend; url?: string; flag: string }[] = [];
  if (flags.llamaSwap !== undefined) {
    named.push({
      backend: "llama-swap",
      url: flags.llamaSwap,
      flag: "--llama-swap",
    });
  }
  if (flags.strata !== undefined) {
    named.push({ backend: "strata", url: flags.strata, flag: "--strata" });
  }
  if (flags.llmBackend !== undefined) {
    if (!(LLM_BACKENDS as readonly string[]).includes(flags.llmBackend)) {
      throw new LlmFlagsError(
        `--llm-backend: expected one of ${LLM_BACKENDS.join(", ")}, ` +
          `got "${flags.llmBackend}"`,
      );
    }
    named.push({
      backend: flags.llmBackend as LlmBackend,
      flag: "--llm-backend",
    });
  }

  const backends = new Set(named.map((entry) => entry.backend));
  if (backends.size > 1) {
    throw new LlmFlagsError(
      `${named.map((entry) => entry.flag).join(" and ")} name different LLM ` +
        `servers; the bridge takes turns with one`,
    );
  }

  const strataOnly: [string, unknown][] = [
    ["--llm-api-key", flags.llmApiKey],
    ["--llm-busy-wait", flags.llmBusyWait],
    ["--llm-load-timeout", flags.llmLoadTimeout],
    ["--llm-reload", flags.llmReload],
  ];

  if (backends.size === 0) {
    const stray = [
      ["--llm-url", flags.llmUrl],
      ["--llm-model", flags.llmModel],
      ["--llm-unload-timeout", flags.llmUnloadTimeout],
      ...strataOnly,
    ].filter(([, value]) => value !== undefined).map(([flag]) => flag);
    if (stray.length > 0) {
      throw new LlmFlagsError(
        `${stray.join(", ")} given without an LLM server; add --llama-swap ` +
          `<url>, --strata <url> or --llm-backend`,
      );
    }
    return null;
  }

  const backend = named[0]!.backend;
  const urls = new Set(
    [...named.map((entry) => entry.url), flags.llmUrl].filter(
      (url): url is string => url !== undefined,
    ),
  );
  if (urls.size === 0) {
    throw new LlmFlagsError(`--llm-backend ${backend} needs --llm-url`);
  }
  if (urls.size > 1) {
    throw new LlmFlagsError(
      `the LLM server's URL is given twice, differently: ${
        [...urls].join(" and ")
      }`,
    );
  }

  if (backend === "llama-swap") {
    // A flag that would do nothing is a mistake worth hearing about.
    const wasted = strataOnly.filter(([flag, value]) =>
      value !== undefined && !(flag === "--llm-reload" && value === "lazy")
    ).map(([flag]) => flag);
    if (wasted.length > 0) {
      throw new LlmFlagsError(
        `${wasted.join(", ")} only ${
          wasted.length === 1 ? "applies" : "apply"
        } to Strata; llama-swap loads the ` +
          `model on the next completion by itself`,
      );
    }
  }

  const reload = flags.llmReload ?? "lazy";
  if (reload !== "lazy" && reload !== "eager") {
    throw new LlmFlagsError(
      `--llm-reload: expected lazy or eager, got "${reload}"`,
    );
  }

  const seconds = (
    flag: string,
    value: number | undefined,
    fallback: number,
  ) => {
    const resolved = value ?? fallback;
    if (!Number.isFinite(resolved) || resolved < 0) {
      throw new LlmFlagsError(`${flag}: expected seconds, got ${value}`);
    }
    return resolved;
  };

  const envKey = env.get(LLM_API_KEY_ENV);
  return {
    backend,
    url: [...urls][0]!,
    model: flags.llmModel ?? null,
    apiKey: backend === "strata"
      ? flags.llmApiKey ?? (envKey && envKey.length > 0 ? envKey : null)
      : null,
    unloadTimeoutMs:
      seconds("--llm-unload-timeout", flags.llmUnloadTimeout, 60) * 1000,
    busyWaitS: seconds("--llm-busy-wait", flags.llmBusyWait, 30),
    loadTimeoutMs: seconds("--llm-load-timeout", flags.llmLoadTimeout, 45) *
      1000,
    reload,
  };
}

export function createLlmHost(
  options: LlmOptions | null,
  fetcher?: typeof fetch,
): LlmHost | null {
  if (options === null) return null;
  if (options.backend === "llama-swap") {
    return new LlamaSwap({
      url: options.url,
      model: options.model,
      unloadTimeoutMs: options.unloadTimeoutMs,
      fetch: fetcher,
    });
  }
  return new Strata({
    url: options.url,
    model: options.model,
    apiKey: options.apiKey,
    unloadTimeoutMs: options.unloadTimeoutMs,
    busyWaitS: options.busyWaitS,
    loadTimeoutMs: options.loadTimeoutMs,
    reload: options.reload,
    fetch: fetcher,
  });
}
