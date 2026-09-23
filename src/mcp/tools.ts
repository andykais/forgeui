/**
 * The tools the model sees (DESIGN-AGENT-LOOP §5.1).
 *
 * Everything but `generate` is a fast proxy over ForgeUI's API, called while
 * the model is resident. `generate` is the round of §5.2 and is the only one
 * that takes minutes.
 *
 * Note what is *not* here: a `source` argument. The bridge fills that in from
 * llama-swap (§6.2), so there is no parameter through which the model could
 * set it — the schema is the enforcement, not the server.
 */

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { encodeBase64 } from "@std/encoding/base64";
import type { ForgeUi } from "./forgeui.ts";
import type { LlamaSwap } from "./llama.ts";
import { runRound } from "./round.ts";
import { APP_VERSION } from "../version.ts";

export interface BridgeOptions {
  forge: ForgeUi;
  llama: LlamaSwap | null;
  /** Ask ComfyUI to drop its weights after each round. */
  freeVram: boolean;
  /** Relay per-job progress; off unless a human is watching (§5.3). */
  progress: boolean;
  /** Ceiling for a round, when the model does not name one. */
  defaultTimeoutMs: number;
}

const text = (value: unknown) => ({
  content: [{
    type: "text" as const,
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  }],
});

const failure = (cause: unknown) => ({
  // A tool execution error, not a protocol one: the model can usually fix a
  // bad param itself, and ForgeUI's message names which param it was.
  content: [{
    type: "text" as const,
    text: cause instanceof Error ? cause.message : String(cause),
  }],
  isError: true,
});

export function createBridgeServer(options: BridgeOptions): McpServer {
  const { forge, llama } = options;
  const server = new McpServer({ name: "forgeui", version: APP_VERSION });

  server.registerTool("list_workflows", {
    description:
      "Every workflow ForgeUI can run: id, name, family and kind. Start here — " +
      "the id is what `generate` takes.",
    inputSchema: z.object({}),
  }, async () => {
    try {
      return text(await forge.get("/api/workflows"));
    } catch (cause) {
      return failure(cause);
    }
  });

  server.registerTool("describe_workflow", {
    description:
      "One workflow in full: every parameter with its type, range and default, " +
      "and the prompting guidance for this model family. Read this before " +
      "writing a prompt — what Illustrious wants is not what Krea wants.",
    inputSchema: z.object({
      workflow_id: z.string().describe("id from list_workflows"),
    }),
  }, async ({ workflow_id }) => {
    try {
      return text(
        await forge.get(`/api/workflows/${encodeURIComponent(workflow_id)}`),
      );
    } catch (cause) {
      return failure(cause);
    }
  });

  server.registerTool("list_models", {
    description:
      "Checkpoints and LoRAs in the library, by display name. Use these names " +
      "when a workflow takes a model or a LoRA parameter.",
    inputSchema: z.object({
      kind: z.enum(["checkpoints", "loras"]).optional(),
    }),
  }, async ({ kind }) => {
    try {
      const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
      return text(await forge.get(`/api/models${query}`));
    } catch (cause) {
      return failure(cause);
    }
  });

  server.registerTool("search_gallery", {
    description:
      "Past outputs, newest first. Filter by project to find this project's " +
      "earlier rounds, or by source to see what was made by a model rather " +
      "than by hand. This is the loop's memory — it survives you being " +
      "unloaded and the harness restarting.",
    inputSchema: z.object({
      q: z.string().optional().describe("free text over prompts and notes"),
      project: z.string().optional(),
      source: z.string().optional(),
      workflow: z.string().optional(),
      kind: z.enum(["image", "video", "audio"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  }, async (args) => {
    try {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined) query.set(key, String(value));
      }
      return text(await forge.get(`/api/outputs?${query}`));
    } catch (cause) {
      return failure(cause);
    }
  });

  server.registerTool("get_output", {
    description:
      "Everything recorded about one output: the exact params, seed, models " +
      "and timings that produced it, and the note saying why it exists.",
    inputSchema: z.object({ output_id: z.string() }),
  }, async ({ output_id }) => {
    try {
      return text(
        await forge.get(`/api/outputs/${encodeURIComponent(output_id)}`),
      );
    } catch (cause) {
      return failure(cause);
    }
  });

  server.registerTool("get_output_image", {
    description:
      "Look at an output. Returns the picture itself, so you can judge it — " +
      "composition, anatomy, whether it matches what was asked for.",
    inputSchema: z.object({
      output_id: z.string(),
      max_edge: z.number().int().min(128).max(2048).optional().describe(
        "longest edge in pixels; smaller is cheaper and enough to critique",
      ),
    }),
  }, async ({ output_id, max_edge }) => {
    try {
      const { bytes, mimeType } = await forge.media(output_id);
      if (!mimeType.startsWith("image/")) {
        return failure(
          `output ${output_id} is ${mimeType}, which cannot be looked at; ` +
            `use get_output for its metadata`,
        );
      }
      if (max_edge !== undefined) {
        // §6.3 puts the resize in ForgeUI, where ffmpeg already is. Until
        // that route exists the full frame is returned rather than a wrong
        // one, and the size is said out loud so the cost is not a surprise.
        return {
          content: [
            {
              type: "text" as const,
              text:
                `(full size — ForgeUI cannot resize yet, so max_edge=${max_edge} was not applied)`,
            },
            { type: "image" as const, data: encodeBase64(bytes), mimeType },
          ],
        };
      }
      return {
        content: [{
          type: "image" as const,
          data: encodeBase64(bytes),
          mimeType,
        }],
      };
    } catch (cause) {
      return failure(cause);
    }
  });

  server.registerTool("gpu_status", {
    description:
      "What is on the GPU right now and how much VRAM is free. Ask before a " +
      "big job: a video workflow needs far more room than an SDXL one.",
    inputSchema: z.object({}),
  }, async () => {
    try {
      const status = await forge.get("/api/system/status").catch(() => null);
      const running = llama === null
        ? []
        : await llama.running().catch(() => []);
      return text({
        llm_resident: running,
        llm_model: llama === null ? null : await llama.currentModel(),
        comfyui: status,
      });
    } catch (cause) {
      return failure(cause);
    }
  });

  server.registerTool("generate", {
    description:
      "Make media. Takes a batch — ask for several variants in one call " +
      "rather than one at a time, because the GPU changes hands twice per " +
      "call whether it carries one job or six. Blocks until every job " +
      "finishes; you are unloaded while it runs and will see the results " +
      "when it returns. Name the project and say what you are testing: that " +
      "note is what search_gallery finds later.",
    inputSchema: z.object({
      jobs: z.array(z.object({
        workflow_id: z.string(),
        params: z.record(z.string(), z.unknown()),
        note: z.string().optional().describe(
          "what is different about this one",
        ),
      })).min(1).max(24),
      project: z.string().optional().describe(
        "groups the round with its siblings, e.g. kitchen-lighting",
      ),
      note: z.string().optional().describe(
        "what this round is testing, e.g. pushing the LoRA past 0.9",
      ),
      timeout_s: z.number().int().min(30).max(7200).optional(),
    }),
  }, async ({ jobs, project, note, timeout_s }, ctx) => {
    // Only when the client asked for progress: a notification against a token
    // it never issued is one the spec says not to send, and the model cannot
    // see these anyway — it is unloaded for the whole call (§5.3).
    const token = ctx.mcpReq._meta?.progressToken;
    const onProgress = options.progress && token !== undefined
      ? (done: number, total: number, message: string) => {
        void ctx.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken: token, progress: done, total, message },
        }).catch(() => {});
      }
      : undefined;
    try {
      const result = await runRound({
        jobs,
        project,
        note,
        timeoutMs: (timeout_s ?? options.defaultTimeoutMs / 1000) * 1000,
      }, { forge, llama, freeVram: options.freeVram, onProgress });
      return text(result);
    } catch (cause) {
      return failure(cause);
    }
  });

  return server;
}
