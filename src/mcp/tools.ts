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
import { basename, join } from "@std/path";
import type {
  ForgeUi,
  MediaBytes,
  ModelListing,
  ModelRow,
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

/** What a preview is sized to when the model does not say (§6.3). */
const DEFAULT_PREVIEW_EDGE = 768;

/**
 * The most `get_output_file` returns inline. Base64 in a JSON-RPC message
 * grows a file by a third, and a harness holds the whole message in memory;
 * a longer clip goes to disk through `save_to` instead.
 */
const INLINE_LIMIT_MB = 32;

const seconds = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? undefined : Number((ms / 1000).toFixed(3));

function sizeOf(bytes: Uint8Array): string {
  const kb = bytes.length / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/** `video · 1280×720 · 6.04s`: what the original is, in one line. */
function describeOutput(output: MediaBytes["output"]): string {
  const parts = [output.kind ?? "output"];
  if (output.width && output.height) {
    parts.push(`${output.width}×${output.height}`);
  }
  const duration = seconds(output.duration_ms);
  if (duration !== undefined) parts.push(`${duration}s`);
  return parts.join(" · ");
}

/**
 * The content block for some media: the image and audio types MCP has, and
 * for video — which it has no type for — the clip as an embedded resource,
 * the bytes with their MIME type and the URL they came from.
 */
function mediaBlock(media: MediaBytes, forgeUrl: string) {
  const data = encodeBase64(media.bytes);
  if (media.mimeType.startsWith("image/")) {
    return { type: "image" as const, data, mimeType: media.mimeType };
  }
  if (media.mimeType.startsWith("audio/")) {
    return { type: "audio" as const, data, mimeType: media.mimeType };
  }
  return {
    type: "resource" as const,
    resource: {
      uri: `${forgeUrl}${media.output.media_url ?? ""}`,
      mimeType: media.mimeType,
      blob: data,
    },
  };
}

/**
 * Where `save_to` means: a directory gets the file under the name it has in
 * ForgeUI, anything else is the file's own path.
 */
async function saveTarget(
  saveTo: string,
  outputPath: string | undefined,
  outputId: string,
): Promise<string> {
  const isDir = await Deno.stat(saveTo).then((s) => s.isDirectory)
    .catch(() => false);
  if (!isDir) return saveTo;
  return join(saveTo, outputPath ? basename(outputPath) : outputId);
}

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
      "`get_output_preview` shows you — or `file`, a path on the machine " +
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
    noun: "checkpoint",
    description:
      "Checkpoints — the base models a workflow generates with, across every " +
      "folder that holds one. Filter by family to see only the ones a " +
      "workflow can use: a krea2 workflow takes a krea2 checkpoint and nothing " +
      "else. Pass the `name` back, not the display name.",
  });

  registerLibraryTool(server, forge, {
    name: "list_loras",
    modelClass: "lora",
    noun: "LoRA",
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
      "than by hand. `q` searches the prompts **and the notes** — what a " +
      "person wrote about a picture after looking at it, which is the " +
      "feedback worth reading before making another one. This is the loop's " +
      "memory: it survives you being unloaded and the harness restarting.",
    inputSchema: z.object({
      q: z.string().optional().describe(
        "free text over the prompts and the notes written about an output",
      ),
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
      "and timings that produced it, the origin saying who asked for it and " +
      "why, and `notes` — what a person said about it afterwards. Read the " +
      "notes on what you made last time before deciding what to make next. " +
      "Metadata only: to see the output use get_output_preview, and for the " +
      "file itself get_output_file.",
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

  server.registerTool("get_output_preview", {
    description:
      "Look at an output — the convenient way, and the one to reach for " +
      "first. Returns a small copy sized for judging and sharing: a picture " +
      "as a JPEG whose longest edge is `max_edge` (768 unless you say), a " +
      "video as a small, low-bitrate MP4 of the whole clip at that size. " +
      "Enough to critique composition, anatomy, motion and whether it " +
      "matches what was asked, at a fraction of the tokens. Never for " +
      "chaining or keeping: attach_input and get_output_file work from the " +
      "full-quality original. Audio has no smaller copy; use get_output_file.",
    inputSchema: z.object({
      output_id: z.string(),
      max_edge: z.number().int().min(128).max(2048).optional().describe(
        "longest edge in pixels, default 768; smaller is cheaper and enough " +
          "to critique",
      ),
    }),
  }, async ({ output_id, max_edge }) => {
    const edge = max_edge ?? DEFAULT_PREVIEW_EDGE;
    try {
      const media = await forge.media(output_id, { maxEdge: edge });
      const { mimeType, output } = media;
      if (mimeType.startsWith("audio/")) {
        return failure(
          `output ${output_id} is audio, which has no preview; ` +
            `get_output_file returns the take itself`,
        );
      }
      if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/")) {
        return failure(
          `output ${output_id} is ${mimeType}, which cannot be previewed; ` +
            `use get_output for its metadata`,
        );
      }
      if (
        !media.resized && media.bytes.length > INLINE_LIMIT_MB * 1024 * 1024
      ) {
        return failure(
          `ForgeUI has no ffmpeg, so there is no smaller copy of ${output_id}, ` +
            `and the file itself is ${sizeOf(media.bytes)}; ` +
            `get_output_file with save_to writes it to disk`,
        );
      }
      const note = media.resized
        ? `preview, longest edge at most ${edge}px, ${sizeOf(media.bytes)} — ` +
          `the original is ${describeOutput(output)}`
        : `full size (${describeOutput(output)}, ${sizeOf(media.bytes)}): ` +
          `ForgeUI has no ffmpeg, so max_edge=${edge} was not applied`;
      return {
        content: [
          { type: "text" as const, text: note },
          mediaBlock(media, forge.url),
        ],
      };
    } catch (cause) {
      return failure(cause);
    }
  });

  server.registerTool("get_output_file", {
    description:
      "The output itself, byte for byte — the full-resolution picture, the " +
      "whole video, the audio take — exactly as ComfyUI wrote it. Large: a " +
      "video can be hundreds of megabytes, so to only look at something use " +
      "get_output_preview. Returned inline as an image, audio or video " +
      "block, or with `save_to` written to a path on the machine running " +
      "this bridge and the path handed back instead of the bytes — the way " +
      "to pass a result to another program. Inline stops at " +
      `${INLINE_LIMIT_MB} MB; past that, save_to is the way.`,
    inputSchema: z.object({
      output_id: z.string(),
      save_to: z.string().optional().describe(
        "absolute path of a file to write, or of an existing directory to " +
          "write it into under its own name",
      ),
    }),
  }, async ({ output_id, save_to }) => {
    try {
      const media = await forge.media(output_id);
      if (save_to !== undefined) {
        const path = await saveTarget(save_to, media.output.path, output_id);
        await Deno.writeFile(path, media.bytes);
        return text({
          saved: path,
          kind: media.output.kind,
          mime_type: media.mimeType,
          bytes: media.bytes.length,
          width: media.output.width ?? undefined,
          height: media.output.height ?? undefined,
          duration_s: seconds(media.output.duration_ms),
        });
      }
      if (media.bytes.length > INLINE_LIMIT_MB * 1024 * 1024) {
        return failure(
          `output ${output_id} is ${sizeOf(media.bytes)}, too big to return ` +
            `inline; pass save_to to write it to disk, or look at it with ` +
            `get_output_preview`,
        );
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `${describeOutput(media.output)}, ${sizeOf(media.bytes)}`,
          },
          mediaBlock(media, forge.url),
        ],
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
  /** What one of these is called, in a message about there being none. */
  noun: string;
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
    }),
  }, async ({ family, q, tags }) => {
    try {
      // The family is filtered here rather than by the server, so that an
      // answer of "none" can carry the families this class *does* have. A
      // filter that matched nothing and says nothing is what sends a model
      // off to poke ForgeUI's REST API on its own.
      const query = new URLSearchParams({ class: tool.modelClass });
      if (q) query.set("q", q);
      if (tags) query.set("tags", tags);
      const listing = await forge.get<ModelListing>(`/api/models?${query}`);
      // A row whose file has gone keeps its page so its outputs stay linked
      // (§8.1), but it cannot be generated with, so it is not offered here.
      const all = listing.models.filter((model) => model.present !== false);
      const counts = new Map<string, number>();
      for (const model of all) {
        counts.set(model.family, (counts.get(model.family) ?? 0) + 1);
      }
      const matched = family === undefined
        ? all
        : all.filter((model) => model.family === family);
      return text({
        family: family ?? null,
        total: matched.length,
        families: [...counts]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([name, count]) => ({ family: name, count })),
        note: emptyNote(tool, listing, all.length, matched.length, family),
        // Every one of them. A library is a closed set the owner curated, and
        // a page of it is worse than useless here: the model cannot tell a
        // truncated list from the whole shelf, so it picks from the first
        // sixty and never learns the rest exist.
        models: matched.map((model) => entry(model, tool.strengths ?? false)),
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

/** What a picker shows: enough to choose with, and nothing the screen needs. */
function entry(model: ModelRow, strengths: boolean) {
  return {
    name: model.name,
    display_name: model.display_name,
    family: model.family,
    kind: model.kind,
    tags: model.tags.length > 0 ? model.tags : undefined,
    notes: model.notes ?? undefined,
    strength_min: strengths ? model.strength_min : undefined,
    strength_max: strengths ? model.strength_max : undefined,
    outputs: model.output_count,
  };
}

/**
 * Why the list is empty, when it is.
 *
 * Two different nothings, and an empty array tells them apart from neither.
 * Either the family excluded everything — in which case the counts beside
 * this say what to ask for instead — or the class itself is empty, which,
 * with folders configured, usually means a folder is filed under the wrong
 * one: these tools ask by class, and a folder name the default table does
 * not know lands in `other`. Both cases end with a model that concludes the
 * bridge is broken and goes looking for ForgeUI's REST API.
 */
function emptyNote(
  tool: LibraryTool,
  listing: ModelListing,
  inClass: number,
  matched: number,
  family?: string,
): string | undefined {
  if (matched > 0) return undefined;
  if (inClass > 0) {
    return `no ${tool.noun} has family "${family}" — \`families\` lists the ` +
      `ones that do, and leaving family out lists all ${inClass}.`;
  }
  const folders = Object.entries(listing.classes ?? {})
    .map(([kind, modelClass]) => `${kind} (${modelClass})`)
    .join(", ");
  if (!folders) return `no model folders are configured at all.`;
  return `nothing in this library is classed \`${tool.modelClass}\`. The ` +
    `configured folders are: ${folders}. A folder that holds ${tool.noun}s ` +
    `but is filed under another class has to be named by \`model_classes\` ` +
    `in config.yaml before anything will list it.`;
}
