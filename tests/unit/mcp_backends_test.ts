import { assertEquals, assertThrows } from "@std/assert";
import {
  createLlmHost,
  type EnvReader,
  LLM_API_KEY_ENV,
  type LlmFlags,
  LlmFlagsError,
  resolveLlmOptions,
} from "../../src/mcp/backends.ts";

/**
 * `forge mcp`'s LLM flags (DESIGN-LLM-BACKENDS §3). A flag that cannot mean
 * anything stops the bridge before it listens, rather than being ignored.
 */

const noEnv: EnvReader = { get: (_key: string) => undefined };
const envWith = (key: string) => ({
  get: (name: string) => name === LLM_API_KEY_ENV ? key : undefined,
});
const resolve = (flags: LlmFlags, env: EnvReader = noEnv) =>
  resolveLlmOptions(flags, env);

Deno.test("no LLM server named is no LLM server", () => {
  assertEquals(resolve({}), null);
  assertEquals(createLlmHost(null), null);
});

Deno.test("--llama-swap is unchanged, and means what the long form means", () => {
  const short = resolve({ llamaSwap: "http://swap", llmModel: "qwen-vlm" });
  const long = resolve({
    llmBackend: "llama-swap",
    llmUrl: "http://swap",
    llmModel: "qwen-vlm",
  });
  assertEquals(short, long);
  assertEquals(short, {
    backend: "llama-swap",
    url: "http://swap",
    model: "qwen-vlm",
    apiKey: null,
    unloadTimeoutMs: 60_000,
    busyWaitS: 30,
    loadTimeoutMs: 45_000,
    reload: "lazy",
  });
  assertEquals(createLlmHost(short)?.backend, "llama-swap");
});

Deno.test("--strata takes the defaults measured on the box", () => {
  const options = resolve({ strata: "http://127.0.0.1:2335" });
  assertEquals(
    options,
    resolve({
      llmBackend: "strata",
      llmUrl: "http://127.0.0.1:2335",
    }),
  );
  assertEquals(options?.apiKey, null, "Strata runs without a key by default");
  assertEquals(options?.loadTimeoutMs, 45_000);
  assertEquals(options?.reload, "lazy");
  const host = createLlmHost(options);
  assertEquals(host?.backend, "strata");
  assertEquals(host?.url, "http://127.0.0.1:2335");
});

Deno.test("every Strata knob reaches the options", () => {
  assertEquals(
    resolve({
      strata: "http://s",
      llmModel: "label",
      llmApiKey: "k",
      llmUnloadTimeout: 10,
      llmBusyWait: 0,
      llmLoadTimeout: 90,
      llmReload: "eager",
    }),
    {
      backend: "strata",
      url: "http://s",
      model: "label",
      apiKey: "k",
      unloadTimeoutMs: 10_000,
      busyWaitS: 0,
      loadTimeoutMs: 90_000,
      reload: "eager",
    },
  );
});

Deno.test("the key comes from the environment, and the flag wins over it", () => {
  assertEquals(resolve({ strata: "http://s" }, envWith("env"))?.apiKey, "env");
  assertEquals(
    resolve({ strata: "http://s", llmApiKey: "flag" }, envWith("env"))?.apiKey,
    "flag",
  );
  assertEquals(resolve({ strata: "http://s" }, envWith(""))?.apiKey, null);
  // An environment shared with other tools is not a mistake on llama-swap.
  assertEquals(
    resolve({ llamaSwap: "http://swap" }, envWith("env"))?.apiKey,
    null,
  );
});

Deno.test("flags that cannot mean anything stop the bridge", () => {
  const cases: [LlmFlags, string][] = [
    [{ llamaSwap: "http://a", strata: "http://b" }, "name different"],
    [{ strata: "http://a", llmBackend: "llama-swap" }, "name different"],
    [{ llmBackend: "ollama", llmUrl: "http://a" }, "expected one of"],
    [{ llmBackend: "strata" }, "needs --llm-url"],
    [{ strata: "http://a", llmUrl: "http://b" }, "given twice"],
    [{ llmUrl: "http://a" }, "without an LLM server"],
    [{ llmModel: "qwen" }, "without an LLM server"],
    [{ llamaSwap: "http://a", llmApiKey: "k" }, "to Strata; llama-swap"],
    [{ llamaSwap: "http://a", llmBusyWait: 5 }, "to Strata; llama-swap"],
    [{ llamaSwap: "http://a", llmLoadTimeout: 5 }, "to Strata; llama-swap"],
    [{ llamaSwap: "http://a", llmReload: "eager" }, "to Strata; llama-swap"],
    [{ strata: "http://a", llmReload: "sometimes" }, "expected lazy or eager"],
    [{ strata: "http://a", llmBusyWait: -1 }, "expected seconds"],
  ];
  for (const [flags, message] of cases) {
    assertThrows(() => resolve(flags), LlmFlagsError, message);
  }
});

Deno.test("the same URL given both ways is not a conflict", () => {
  assertEquals(
    resolve({ strata: "http://s", llmUrl: "http://s" })?.url,
    "http://s",
  );
  // Lazy is what llama-swap does anyway, so saying so is harmless.
  assertEquals(
    resolve({ llamaSwap: "http://a", llmReload: "lazy" })?.reload,
    "lazy",
  );
});
