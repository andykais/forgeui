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
import { basename } from "@std/path";
import type {
  FamilyListing,
  ForgeUi,
  ModelListing,
  StoredInputView,
} from "./forgeui.ts";
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
      "One workflow in full: every parameter with its type, range, default " +
      "and when it applies, and how to supply any media it takes. Read this " +
      "before writing a prompt — what Illustrious wants is not what Krea " +
      "wants.",
    inputSchema: z.object({
      workflow_id: z.string().describe("id from list_workflows"),
    }),
  }, async ({ workflow_id }) => {
    try {
      const detail = await forge.get<WorkflowDetail>(
        `/api/workflows/${encodeURIComponent(workflow_id)}`,
      );
      // Not the whole route body: it carries `api_json` and `ui_json`, the
      // entire ComfyUI graph twice over. The model binds params, not nodes.
      return text({
        id: detail.id,
        name: detail.name,
        family: detail.family,
        kind: detail.kind,
        category: detail.category,
        description: detail.description,
        runnable: detail.runnable,
        error: detail.error ?? undefined,
        params: (detail.manifest?.params ?? []).map((param) => {
          const { bind: _bind, ...rest } = param;
          const supply = supplyHint(param);
          return supply ? { ...rest, supply } : rest;
        }),
      });
    } catch (cause) {
      return failure(cause);
    }
  });

  server.registerTool("attach_input", {
    description:
      "Put a file into ForgeUI's input store and get back the value to pass " +
      "for an image, audio, mask or video parameter. This is how one round " +
      "feeds the next: make a picture, make a take, then attach both and " +
      "run ltx2-ia2v on them. Takes either `output_id` — anything `generate` " +
      "returned, attached whole, at full quality, never the downscaled copy " +
      "`get_output_image` shows you — or `file`, a path on the machine " +
      "running this bridge, for media you did not make here.",
    inputSchema: z.object({
      output_id: z.string().optional().describe(
        "an output id from generate or search_gallery",
      ),
      file: z.string().optional().describe(
        "absolute path to an image or audio file on the bridge's own disk",
      ),
    }),
  }, async ({ output_id, file }) => {
    if ((output_id === undefined) === (file === undefined)) {
      return failure("pass exactly one of `output_id` or `file`");
    }
    try {
      let stored: StoredInputView;
      if (output_id !== undefined) {
        stored = await forge.attachOutput(output_id);
      } else {
        // The bridge reads its own disk; ForgeUI may be on another machine,
        // so the bytes go up rather than the path across.
        let bytes: Uint8Array;
        try {
          bytes = await Deno.readFile(file!);
        } catch (cause) {
          return failure(
            `cannot read ${file}: ${
              cause instanceof Error ? cause.message : cause
            }`,
          );
        }
        stored = await forge.attachFile(basename(file!), bytes);
      }
      return text({
        // Named `value` because that is all it is for: the thing to put in
        // the param. Its shape (a content hash) is not worth reasoning about.
        value: stored.filename,
        kind: stored.kind,
        width: stored.width ?? undefined,
        height: stored.height ?? undefined,
        duration_s: stored.duration_ms === null
          ? undefined
          : Number((stored.duration_ms / 1000).toFixed(3)),
        bytes: stored.bytes,
      });
    } catch (cause) {
      return failure(cause);
    }
  });

  registerLibraryTool(server, forge, {
    name: "list_checkpoints",
    modelClass: "diffusion",
    description:
      "Checkpoints — the base models a workflow generates with, across every " +
      "folder that holds one. Filter by family to see only the ones a " +
      "workflow can use: a krea2 workflow takes a krea2 checkpoint and nothing " +
      "else. Pass the `name` back, not the display name.",
  });

  registerLibraryTool(server, forge, {
    name: "list_loras",
    modelClass: "lora",
    description:
      "LoRAs in the library. Filter by family — a LoRA trained for one base " +
      "model does nothing for another, and mixing families is the usual " +
      "cause of a result that ignores the prompt. Each one carries the " +
      "strength range its owner set, which is the range worth exploring. " +
      "Pass the `name` back in a workflow's lora list, not the display name.",
    strengths: true,
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
      "note is what search_gallery finds later. A param that takes media — " +
      "an image, a clip — wants a value from attach_input, not a filename " +
      "or an id. Every finished job comes back with its outputs named, so " +
      "the next round can attach one.",
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

interface LibraryTool {
  name: string;
  modelClass: "diffusion" | "lora";
  description: string;
  /** LoRAs carry the strength range their owner set; checkpoints do not. */
  strengths?: boolean;
}

/**
 * One of the two library listings.
 *
 * What comes back is a projection, not the API's rows: the Models screen
 * needs two dozen fields per model and this needs five, and the difference is
 * the whole context window when a library holds three hundred LoRAs. `name`
 * is first among them because `name` is what a workflow param binds to — a
 * display name passed to `generate` reaches ComfyUI and fails there.
 */
function registerLibraryTool(
  server: McpServer,
  forge: ForgeUi,
  tool: LibraryTool,
): void {
  server.registerTool(tool.name, {
    description: tool.description,
    inputSchema: z.object({
      family: z.string().optional().describe(
        "exact family, e.g. krea2 or sdxl; list_workflows names the " +
          "family each workflow wants",
      ),
      q: z.string().optional().describe("substring of the name or a tag"),
      tags: z.string().optional().describe("comma-separated; all must match"),
      limit: z.number().int().min(1).max(500).optional(),
    }),
  }, async ({ family, q, tags, limit }) => {
    try {
      const query = new URLSearchParams({ class: tool.modelClass });
      if (family) query.set("family", family);
      if (q) query.set("q", q);
      if (tags) query.set("tags", tags);
      const [listing, families] = await Promise.all([
        forge.get<ModelListing>(`/api/models?${query}`),
        // The vocabulary, so a family that matched nothing is a mistake the
        // model can fix on its own rather than a silent empty list.
        forge.get<FamilyListing>("/api/families").catch(() => null),
      ]);
      // A row whose file has gone keeps its page so its outputs stay linked
      // (§8.1), but it cannot be generated with, so it is not offered here.
      const all = listing.models.filter((model) => model.present !== false);
      const shown = all.slice(0, limit ?? 60);
      return text({
        family: family ?? null,
        total: all.length,
        families: families?.families.map((entry) => entry.family) ?? undefined,
        models: shown.map((model) => ({
          name: model.name,
          display_name: model.display_name,
          family: model.family,
          kind: model.kind,
          tags: model.tags.length > 0 ? model.tags : undefined,
          notes: model.notes ?? undefined,
          strength_min: tool.strengths ? model.strength_min : undefined,
          strength_max: tool.strengths ? model.strength_max : undefined,
          outputs: model.output_count,
        })),
      });
    } catch (cause) {
      return failure(cause);
    }
  });
}

/** `GET /api/workflows/:id`, narrowed to the half a model can act on. */
interface WorkflowDetail {
  id: string;
  name: string;
  family: string | null;
  kind: string;
  category: string | null;
  description: string | null;
  runnable: boolean;
  error?: string | null;
  manifest: { params?: ManifestParam[] } | null;
}

interface ManifestParam {
  key: string;
  type: string;
  bind?: unknown;
  step?: number;
  /** An `audio` param whose length this one takes (\u00a711.3). */
  follows?: string;
  [field: string]: unknown;
}

/**
 * How to fill a param the schema alone cannot explain.
 *
 * A media param's value is a store filename, which nothing about `type:
 * "image"` says; and a length that `follows` a clip is the one number the
 * panel fills in for a human, so over the API it is the one number a model
 * silently gets wrong — the default trims the take instead.
 */
function supplyHint(param: ManifestParam): string | undefined {
  if (["image", "mask", "video", "audio"].includes(param.type)) {
    return `attach_input first (by output_id, or by file), then pass the ` +
      `\`value\` it returns`;
  }
  if (typeof param.follows === "string") {
    const step = typeof param.step === "number" && param.step > 0
      ? param.step
      : 1;
    return `the length of the \`${param.follows}\` clip: take duration_s ` +
      `from attach_input and round it UP to the next ${step}. Short cuts ` +
      `the take off mid-word; long leaves padding the model fills.`;
  }
  return undefined;
}
