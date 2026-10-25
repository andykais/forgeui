/**
 * The LLM server the bridge takes turns with (DESIGN-LLM-BACKENDS §1).
 *
 * Two of them today — llama-swap and Strata — and a round needs the same three
 * things from either: what is resident, what to call it, and the GPU back.
 * Getting the GPU back to the LLM afterwards is usually nobody's job here: both
 * servers load the model on the next completion by themselves.
 */

export type LlmBackend = "llama-swap" | "strata";

export const LLM_BACKENDS: readonly LlmBackend[] = ["llama-swap", "strata"];

export class LlmHostError extends Error {
  override readonly name: string = "LlmHostError";
}

export interface LlmHost {
  readonly backend: LlmBackend;
  readonly url: string;
  /** The model ids resident right now. May throw; callers decide if it matters. */
  resident(): Promise<string[]>;
  /** The name a round is attributed to (`origin.source`). Never throws. */
  currentModel(): Promise<string | null>;
  /**
   * Make the GPU free, and do not return until it is — or throw
   * `LlmHostError`, in which case nothing may be submitted.
   */
  release(): Promise<{ was: string | null }>;
  /**
   * The round is over and ComfyUI has let go. A no-op unless the backend was
   * asked to load eagerly; never throws, because the next completion loads
   * the model anyway.
   */
  restore(): Promise<void>;
}

/** `llm:qwen-vlm` — what lands in `origin.source` (DESIGN-AGENT-LOOP §6.2). */
export function sourceFor(modelId: string | null): string {
  return modelId === null ? "llm:unknown" : `llm:${modelId}`;
}

/** The text and parsed JSON of a response, whatever it carried. */
export async function readBody(
  response: Response,
): Promise<{ text: string; json: unknown }> {
  const text = await response.text().catch(() => "");
  if (text.trim().length === 0) return { text, json: null };
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

/**
 * A pause between polls. Not unref'd: a release that is waiting on the GPU is
 * the one thing the process is doing, and must keep it alive.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
