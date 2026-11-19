/**
 * Workflows an agent writes itself (DESIGN.md §4.9, DESIGN-AGENT-LOOP §5.1):
 * `get_workflow_source`, `create_workflow`, `update_workflow`.
 *
 * The rule — an agent changes only the workflows an agent made — is held in
 * two places, and either is enough on its own:
 *
 * 1. Here. `update_workflow` reads the workflow first and refuses one that
 *    has no `agent` record, with a message that says what to do instead.
 *    There is no tool that deletes, resets or duplicates a workflow, and no
 *    parameter through which the model could name itself or claim a
 *    workflow: the bridge fills `agent` in as code, as it fills
 *    `origin.source` for a round (§6.2).
 * 2. In ForgeUI. Every write the bridge makes carries `agent`, and the
 *    server refuses (403) any such write to a workflow without `agent.json`
 *    — which only a create carrying `agent` ever writes. A bug in this file
 *    therefore cannot reach a person's workflow either.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type ForgeUi, ForgeUiError } from "./forgeui.ts";
import { describeError, type LlmHost, sourceFor } from "./llm.ts";
import {
  checkGraphAgainstNodes,
  checkGraphShape,
  type ObjectInfo,
} from "../workflows/graph_check.ts";
import {
  describeNodes,
  nodePacks,
  searchNodes,
} from "../workflows/node_catalog.ts";
import { NODE_PACKS } from "../workflows/nodes.ts";
import { editorToApi } from "../workflows/editor_graph.ts";
import {
  type ApiGraph,
  FAMILIES,
  PARAM_TYPES,
  WORKFLOW_KINDS,
} from "../workflows/types.ts";

/** What `GET /api/workflows/:id` answers, narrowed to what these tools read. */
export interface WorkflowSource {
  id: string;
  name: string;
  kind: string;
  source: "bundled" | "user";
  runnable: boolean;
  error: string | null;
  has_ui_json: boolean;
  agent: { source: string; created_at: number } | null;
  manifest:
    | Record<string, unknown> & {
      params?: Record<string, unknown>[];
      outputs?: { node: string; kind: string }[];
    }
    | null;
  api_json: Record<string, unknown>;
  ui_json?: unknown;
}

const text = (value: unknown) => ({
  content: [{
    type: "text" as const,
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  }],
});

const failure = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

const PARAMS_HELP =
  "the panel's inputs, in order. Each is {key, type, bind, ...}: `key` is " +
  "lower_snake_case and is what generate takes; `type` is one of " +
  `${PARAM_TYPES.join(", ")}; \`bind\` is "<node id>.<input name>" ` +
  'for most types (e.g. "6.text", "3.seed"), {"w": "5.width", "h": ' +
  '"5.height"} for size, and for lora_list {"chain": {"model_from": ' +
  '"1.MODEL", "clip_from": "1.CLIP", "model_to": ["3.model"], ' +
  '"clip_to": ["6.clip"]}}. Optional: label, description, required, ' +
  "advanced, default, min, max, step, options (enum), section, when. " +
  "An input not bound to a param stays as the graph has it. Read a " +
  "bundled workflow with get_workflow_source for worked examples.";

/** The manifest fields both tools take, each replacing the whole field. */
const manifestFields = {
  description: z.string().nullable().optional().describe(
    "a sentence on what it makes and what is fixed",
  ),
  family: z.string().nullable().optional().describe(
    `the model family, which filters its model and LoRA pickers: one of ${
      FAMILIES.join(", ")
    }, or null`,
  ),
  kind: z.enum(WORKFLOW_KINDS).optional().describe(
    "what it makes; image when left out of a new workflow",
  ),
  category: z.enum(["img2img"]).nullable().optional().describe(
    "img2img only for a workflow taking `image` (required), `creativity` " +
      "and `scale`; otherwise leave out",
  ),
  params: z.array(z.record(z.string(), z.unknown())).optional().describe(
    PARAMS_HELP,
  ),
  outputs: z.array(z.strictObject({
    node: z.string().describe("id of a node that saves a file, e.g. SaveImage"),
    kind: z.enum(WORKFLOW_KINDS),
  })).optional().describe(
    "the nodes whose files are the result; without one it cannot run",
  ),
  sections: z.array(z.record(z.string(), z.unknown())).optional().describe(
    'titled groups of params: [{"id": "mask", "label": "Mask"}]; a param ' +
      "joins one with `section`",
  ),
  prompt: z.string().nullable().optional().describe(
    "the key of the text param that is the prompt, when there are several",
  ),
  tone: z.array(z.string()).optional(),
  requires: z.array(z.string()).optional().describe(
    "custom node packs the graph needs",
  ),
};

const apiJson = z.record(z.string(), z.unknown()).describe(
  'the ComfyUI graph in API format: {"<node id>": {"class_type": ' +
    '"KSampler", "inputs": {"steps": 20, "model": ["4", 0]}}}. A link is ' +
    '["<node id>", <output slot>] with the id a string.',
);

type ManifestFields = {
  [K in keyof typeof manifestFields]?: z.infer<typeof manifestFields[K]>;
};

function defined(fields: ManifestFields): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

function bullets(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join("\n");
}

interface ComfyCheck {
  errors: string[];
  warnings: string[];
  /** False when ComfyUI could not be asked, and why. */
  checked: boolean;
  note?: string;
}

/**
 * The graph, before it is saved: its shape, then against the node types the
 * ComfyUI behind ForgeUI actually has, read through ForgeUI's `/comfy`
 * proxy. When ComfyUI cannot be reached the graph is still saved — the
 * server checks its shape and every bind regardless — and the answer says
 * the nodes went unchecked.
 */
/**
 * ComfyUI's node list, through ForgeUI's `/comfy` proxy — the same ComfyUI
 * a round runs on, custom nodes and model files included.
 */
async function objectInfo(forge: ForgeUi): Promise<ObjectInfo> {
  const info = await forge.get<ObjectInfo>("/comfy/object_info");
  if (typeof info !== "object" || info === null || Array.isArray(info)) {
    throw new ForgeUiError("ComfyUI's /object_info was not a node list");
  }
  return info;
}

const COMFY_UNREACHABLE =
  "ComfyUI could not be reached through ForgeUI, so its node list cannot " +
  "be read right now; gpu_status says whether it is running";

async function checkGraph(
  forge: ForgeUi,
  graph: Record<string, unknown>,
): Promise<ComfyCheck> {
  if (Object.keys(graph).length === 0) {
    return { errors: [], warnings: [], checked: false };
  }
  const shape = checkGraphShape(graph as ApiGraph);
  if (shape.length > 0) return { errors: shape, warnings: [], checked: true };
  let info: ObjectInfo;
  try {
    info = await objectInfo(forge);
  } catch {
    return {
      errors: [],
      warnings: [],
      checked: false,
      note: "ComfyUI could not be reached, so node types, required inputs " +
        "and link types were not checked; the first generate will be",
    };
  }
  return { ...checkGraphAgainstNodes(graph as ApiGraph, info), checked: true };
}

function graphRefusal(check: ComfyCheck): string {
  const count = check.errors.length;
  return [
    `Nothing was saved: the graph (api_json) has ${count} problem${
      count === 1 ? "" : "s"
    } ComfyUI would refuse it for. Fix all of them and call again.`,
    bullets(check.errors),
    ...(check.warnings.length > 0
      ? [
        "Also worth fixing (warnings; each says whether a run would fail):",
        bullets(check.warnings),
      ]
      : []),
  ].join("\n");
}

/** ForgeUI's refusal, said in terms of which part of the request it was. */
function saveRefusal(cause: unknown, workflowId?: string): string {
  if (!(cause instanceof ForgeUiError)) {
    return `Nothing was saved: ${describeError(cause)}`;
  }
  const detail = cause.detail;
  if (cause.status === 403) {
    return `Nothing was saved: ${detail}`;
  }
  if (cause.status === 404) {
    return `Nothing was saved: there is no workflow "${
      workflowId ?? "?"
    }" (list_workflows lists them)`;
  }
  const part = detail.startsWith("api_json")
    ? "the graph (api_json)"
    : detail.startsWith("manifest")
    ? "the params/outputs (the manifest)"
    : detail.startsWith("agent")
    ? "the request"
    : null;
  return part === null
    ? `Nothing was saved: ${detail}`
    : `Nothing was saved: ForgeUI refused ${part}. ${detail}`;
}

/**
 * Fields of a param the server does not know, so dropped without a word:
 * `maximum` for `max`, `choices` for `options`. A workflow saved with one of
 * these runs, just not as its author meant.
 */
function ignoredFields(
  sent: Record<string, unknown>[] | undefined,
  saved: Record<string, unknown>[] | undefined,
): string[] {
  if (!sent) return [];
  const out: string[] = [];
  for (const param of sent) {
    const kept = saved?.find((other) => other.key === param.key);
    if (!kept) continue;
    const dropped = Object.keys(param).filter((field) => !(field in kept));
    if (dropped.length > 0) {
      out.push(
        `param "${param.key}": ${
          dropped.map((field) => `"${field}"`).join(", ")
        } ${dropped.length === 1 ? "is" : "are"} not a param field, so ` +
          `${dropped.length === 1 ? "it was" : "they were"} ignored`,
      );
    }
  }
  return out;
}

function whyNotRunnable(saved: WorkflowSource): string | undefined {
  if (saved.runnable) return undefined;
  if (saved.error) return saved.error;
  if (Object.keys(saved.api_json).length === 0) return "it has no graph yet";
  if ((saved.manifest?.outputs ?? []).length === 0) {
    return "manifest.outputs is empty: name the node that saves the result";
  }
  return "it cannot be run yet";
}

function report(
  saved: WorkflowSource,
  check: ComfyCheck | null,
  sentParams: Record<string, unknown>[] | undefined,
) {
  const warnings = [
    ...(check?.warnings ?? []),
    ...ignoredFields(sentParams, saved.manifest?.params),
  ];
  const notes = [check?.note].filter((note): note is string => !!note);
  return {
    id: saved.id,
    name: saved.name,
    kind: saved.kind,
    runnable: saved.runnable,
    not_runnable_because: whyNotRunnable(saved),
    made_by: saved.agent?.source ?? null,
    params: (saved.manifest?.params ?? []).map((param) => {
      const { bind: _bind, ...rest } = param;
      return rest;
    }),
    outputs: saved.manifest?.outputs ?? [],
    graph_checked_against_comfyui: check?.checked ?? false,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    next: saved.runnable
      ? `run it like any other: generate with workflow_id "${saved.id}"`
      : `fix it with update_workflow (workflow_id "${saved.id}")`,
  };
}

interface TemplateEntry {
  name: string;
  title?: string;
  description?: string;
  tags?: string[];
  models?: string[];
  date?: string;
  size?: number;
  openSource?: boolean;
  mediaType?: string;
  io?: { outputs?: { mediaType?: string }[] };
}

/**
 * ComfyUI's `templates/index.json` (categories, each with templates),
 * searched. A template that calls a paid API is one marked not open
 * source, or named `api_…`.
 */
export function searchTemplates(
  index: unknown,
  filters: {
    query?: string;
    media?: string;
    include_api?: boolean;
    limit?: number;
    offset?: number;
  },
) {
  const categories = Array.isArray(index) ? index : [];
  const all: (TemplateEntry & { category: string })[] = [];
  const seen = new Set<string>();
  for (const category of categories) {
    if (typeof category !== "object" || category === null) continue;
    const c = category as { title?: string; templates?: TemplateEntry[] };
    for (const t of c.templates ?? []) {
      if (typeof t?.name !== "string" || seen.has(t.name)) continue;
      seen.add(t.name);
      all.push({ ...t, category: c.title ?? "" });
    }
  }
  const words = (filters.query ?? "").toLowerCase().split(/\s+/).filter(
    Boolean,
  );
  const isApi = (t: TemplateEntry) =>
    t.openSource === false || t.name.startsWith("api_");
  const makes = (t: TemplateEntry & { category: string }) => {
    const out = t.io?.outputs?.[0]?.mediaType;
    if (/3d/i.test(t.category) || (t.tags ?? []).some((x) => /3d/i.test(x))) {
      return "3d";
    }
    return out ??
      (/video/i.test(t.category)
        ? "video"
        : /audio/i.test(t.category)
        ? "audio"
        : "image");
  };
  let api = 0;
  const matches = all.filter((t) => {
    const text = [
      t.name,
      t.title,
      t.description,
      ...(t.tags ?? []),
      ...(t.models ?? []),
    ]
      .join("\n").toLowerCase();
    if (!words.every((w) => text.includes(w))) return false;
    if (filters.media && makes(t) !== filters.media) return false;
    if (isApi(t) && !filters.include_api) {
      api++;
      return false;
    }
    return true;
  });
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 20;
  return {
    total: matches.length,
    offset,
    templates: matches.slice(offset, offset + limit).map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      makes: makes(t),
      models: t.models ?? [],
      ...(typeof t.size === "number" && t.size > 0
        ? { model_download_gb: Math.round(t.size / 1e8) / 10 }
        : {}),
      tags: t.tags ?? [],
      ...(t.date ? { date: t.date } : {}),
      ...(isApi(t) ? { paid_api: true } : {}),
    })),
    ...(api > 0 ? { left_out: { paid_api: api } } : {}),
    ...(matches.length > offset + limit
      ? {
        next: `${matches.length - offset - limit} more: pass offset ${
          offset + limit
        }`,
      }
      : {}),
  };
}

/** What a save node writes, by its type's name. */
function outputKind(classType: string): "image" | "video" | "audio" {
  if (/audio/i.test(classType)) return "audio";
  if (/video|webm|animated/i.test(classType)) return "video";
  return "image";
}

/**
 * A converted graph's results: its nodes that write files, the ones
 * ComfyUI marks as output nodes and that save rather than preview.
 */
function outputNodes(
  graph: Record<string, unknown>,
  info: ObjectInfo,
): { node: string; kind: string }[] {
  return Object.entries(graph)
    .filter(([, node]) => {
      const type = (node as { class_type?: string }).class_type ?? "";
      // What a job collects: pictures, clips, sound — not a 3D file.
      return info[type]?.output_node === true &&
        /^Save(Image|Video|Animated|WEBM|Audio)/i.test(type);
    })
    .map(([id, node]) => ({
      node: id,
      kind: outputKind((node as { class_type: string }).class_type),
    }));
}

/** The label every write carries: the model the LLM server has loaded. */
async function agentLabel(llm: LlmHost | null): Promise<string> {
  const model = llm === null
    ? null
    : await llm.currentModel().catch(() => null);
  return sourceFor(model);
}

export function registerWorkflowTools(
  server: McpServer,
  options: { forge: ForgeUi; llm: LlmHost | null },
): void {
  const { forge, llm } = options;
  const read = (id: string) =>
    forge.get<WorkflowSource>(`/api/workflows/${encodeURIComponent(id)}`);

  server.registerTool("search_comfy_nodes", {
    description:
      "Find the node types the ComfyUI behind ForgeUI has — what a " +
      "workflow's graph can be built from, custom nodes included. Each " +
      "match is one line: its inputs (`name: TYPE`, `?` for optional), its " +
      "output types in slot order, and where it comes from. Filter by " +
      "words (`query`: name, display name, aliases, category, description), " +
      "by `category`, or by what it plugs into: `output_type` finds what " +
      "can make a CONDITIONING, `input_type` what can take a LATENT. With " +
      "no filter you get the categories to start from. Then call " +
      "describe_comfy_nodes for the ones you will use: it gives every " +
      "input's range, default and choices, and a node ready to paste. Paid " +
      "cloud API nodes and deprecated ones are left out unless asked for. " +
      "This and describe_comfy_nodes cover everything in ComfyUI's " +
      "/object_info; never read that whole, it is megabytes.",
    inputSchema: z.strictObject({
      query: z.string().optional().describe(
        'words that must all match, e.g. "qwen image" or "upscale"',
      ),
      category: z.string().optional().describe(
        'a category or the start of one, e.g. "model/loaders", "sampling"',
      ),
      input_type: z.string().optional().describe(
        'only nodes with an input of this type, e.g. "LATENT"',
      ),
      output_type: z.string().optional().describe(
        'only nodes with an output of this type, e.g. "MODEL"',
      ),
      include_api_nodes: z.boolean().optional().describe(
        "include paid cloud API nodes (they need a Comfy account and credits)",
      ),
      include_deprecated: z.boolean().optional(),
      source: z.string().optional().describe(
        'where nodes come from: "core", "api", "custom" (any pack), or a ' +
          "pack's folder name from list_node_packs",
      ),
      limit: z.number().int().min(1).max(100).optional().describe(
        "default 30",
      ),
      offset: z.number().int().min(0).optional(),
    }),
  }, async (filters) => {
    let info: ObjectInfo;
    try {
      info = await objectInfo(forge);
    } catch {
      return failure(COMFY_UNREACHABLE);
    }
    const unfiltered = filters.query === undefined &&
      filters.category === undefined && filters.input_type === undefined &&
      filters.output_type === undefined && filters.source === undefined;
    const result = searchNodes(info, filters);
    if (unfiltered) {
      // Hundreds of lines nobody asked for: the map, and how to narrow it.
      return text({
        total: result.total,
        categories: result.categories,
        left_out: result.left_out,
        next: "narrow with query, category, input_type or output_type",
      });
    }
    return text({
      ...result,
      // A signature line is not enough to write a node: say where the rest
      // is, before an agent goes looking in the raw node list.
      ...(result.nodes.length > 0
        ? {
          details: "these are signatures only: describe_comfy_nodes gives " +
            "each input's default, range and choices and a node to paste " +
            "(raw: true for ComfyUI's entry unabridged)",
        }
        : {}),
      ...(result.total > result.offset + result.nodes.length
        ? {
          next:
            `${
              result.total - result.offset - result.nodes.length
            } more: pass offset ${result.offset + result.nodes.length}, ` +
            "or narrow the search",
        }
        : {}),
      ...(result.total === 0
        ? {
          next: "nothing matched; try fewer words, a category from a " +
            "search with no filter, or include_api_nodes",
        }
        : {}),
    });
  });

  server.registerTool("search_comfy_templates", {
    description:
      "ComfyUI's own workflow templates — known-good graphs for each " +
      "model it supports, the best start for a new workflow. Each has a " +
      "name to pass to create_workflow's from_comfy_template, what it " +
      "makes, the models it needs (and how much they weigh), and its " +
      "tags. Filter by words over the name, title, description, tags and " +
      "models. Templates that call paid cloud APIs are left out unless " +
      "asked for. A template's model files must be on disk for it to " +
      "run: describe_comfy_nodes on its loaders lists what is.",
    inputSchema: z.strictObject({
      query: z.string().optional().describe(
        'words that must all match, e.g. "qwen image edit"',
      ),
      media: z.enum(["image", "video", "audio", "3d"]).optional().describe(
        "what it makes",
      ),
      include_api: z.boolean().optional().describe(
        "include templates that call paid cloud APIs",
      ),
      limit: z.number().int().min(1).max(100).optional().describe(
        "default 20",
      ),
      offset: z.number().int().min(0).optional(),
    }),
  }, async ({ query, media, include_api, limit, offset }) => {
    let index: unknown;
    try {
      index = await forge.get("/comfy/templates/index.json");
    } catch {
      return failure(
        "ComfyUI's template list could not be read through ForgeUI " +
          "(ComfyUI not running, or a build without templates)",
      );
    }
    const result = searchTemplates(index, {
      query,
      media,
      include_api,
      limit,
      offset,
    });
    return text(result);
  });

  server.registerTool("list_node_packs", {
    description:
      "The custom node packs this ComfyUI has loaded, each with how many " +
      "node types it adds (search_comfy_nodes with `source` set to its " +
      "name lists them), and the packs ForgeUI's own workflows can need, " +
      "each with whether it is installed and which workflows wait on it. " +
      "Build only on nodes that are there: a pack is installed by whoever " +
      "runs ComfyUI, never from here.",
    inputSchema: z.strictObject({}),
  }, async () => {
    let info: ObjectInfo;
    try {
      info = await objectInfo(forge);
    } catch {
      return failure(COMFY_UNREACHABLE);
    }
    const packs = nodePacks(info, NODE_PACKS);
    // Which workflows name a pack that is not there (manifest `requires`).
    const missing = new Set(
      packs.known.filter((pack) => !pack.installed).map((pack) => pack.id),
    );
    const waiting: Record<string, string[]> = {};
    if (missing.size > 0) {
      try {
        const { workflows } = await forge.get<{ workflows: { id: string }[] }>(
          "/api/workflows",
        );
        const details = await Promise.all(
          workflows.map((w) => read(w.id).catch(() => null)),
        );
        for (const detail of details) {
          const requires = (detail?.manifest?.requires ?? []) as string[];
          for (const pack of requires) {
            if (missing.has(pack)) (waiting[pack] ??= []).push(detail!.id);
          }
        }
      } catch { /* the list is still worth having without this */ }
    }
    return text({
      installed: packs.installed,
      known: packs.known.map((pack) => ({
        ...pack,
        ...(waiting[pack.id] ? { workflows_needing_it: waiting[pack.id] } : {}),
      })),
      ...(packs.installed.length === 0
        ? { note: "no custom node packs: every node here is ComfyUI's own" }
        : {}),
    });
  });

  server.registerTool("describe_comfy_nodes", {
    description:
      "Node types in full, as the ComfyUI behind ForgeUI has them: each " +
      "input with what it takes (a link from another node, a value, one of " +
      "its choices), its type, default, min/max/step and tooltip; each " +
      "output by slot, name and type, which is what a link " +
      '["<node id>", <slot>] points at; and `example`, the node in API ' +
      "format with every required input filled — replace each " +
      '"<link: TYPE>" with a link. For a loader, `choices` are the model ' +
      "files actually on disk, so use one of them. Also said where they " +
      "apply: `upload` (a file in ComfyUI's input folder — expose it as an " +
      "image/video/audio param), `multiselect` (the value is a list), " +
      "`advanced` (ComfyUI tucks it away; a fair default for the param). " +
      "Tooltips are left out unless `include_tooltips` is set, and then " +
      "come whole; `inputs` narrows to the ones you care about, so the " +
      "way to read them is: search, describe, then describe again with " +
      "include_tooltips and the inputs in question. Choice lists over 100 " +
      "are cut, and `raw: true` gives each node's entry exactly as " +
      "ComfyUI's /object_info has it. Never read /object_info whole: it is " +
      "megabytes. Get names from search_comfy_nodes or a workflow's graph " +
      "(get_workflow_source).",
    inputSchema: z.strictObject({
      node_types: z.array(z.string()).min(1).max(20).describe(
        'class_type names, e.g. ["KSampler", "UNETLoader"]',
      ),
      include_tooltips: z.boolean().optional().describe(
        "every input's and output's tooltip, in full",
      ),
      inputs: z.array(z.string()).min(1).optional().describe(
        'only these inputs, e.g. ["cfg", "denoise"]; the outputs still come',
      ),
      raw: z.boolean().optional().describe(
        "each node's /object_info entry as ComfyUI serves it, unabridged",
      ),
    }),
  }, async ({ node_types, raw, include_tooltips, inputs }) => {
    let info: ObjectInfo;
    try {
      info = await objectInfo(forge);
    } catch {
      return failure(COMFY_UNREACHABLE);
    }
    return text({
      nodes: describeNodes(info, node_types, {
        raw,
        tooltips: include_tooltips,
        inputs,
      }),
    });
  });

  server.registerTool("get_workflow_source", {
    description:
      "One workflow as it is stored: the ComfyUI graph (api_json) and the " +
      "full manifest, binds included. Any workflow can be read. `editable` " +
      "says whether update_workflow may change it — only workflows you or " +
      "another agent made are; the rest you copy with create_workflow's " +
      "`from_workflow`. `comfyui_check` is the graph checked against the " +
      "node types this ComfyUI has right now — what would make a run fail " +
      "(a missing model file, a wrong sampler name, a node type that is " +
      "not installed) — so read it when a workflow is refused. Large: use " +
      "describe_workflow to run one.",
    inputSchema: z.strictObject({
      workflow_id: z.string().describe("id from list_workflows"),
    }),
  }, async ({ workflow_id }) => {
    try {
      const detail = await read(workflow_id);
      // The same check a create runs, against today's ComfyUI: model files
      // come and go, so a workflow that passed when it was made may not now.
      const check = await checkGraph(forge, detail.api_json);
      return text({
        id: detail.id,
        name: detail.name,
        editable: detail.agent !== null,
        made_by: detail.agent?.source ?? null,
        runnable: detail.runnable,
        error: detail.error ?? undefined,
        comfyui_check: check.checked
          ? { errors: check.errors, warnings: check.warnings }
          : { skipped: check.note ?? "the graph is empty" },
        manifest: detail.manifest,
        api_json: detail.api_json,
      });
    } catch (cause) {
      return failure(
        saveRefusal(cause, workflow_id).replace(
          "Nothing was saved: ",
          "",
        ),
      );
    }
  });

  server.registerTool("create_workflow", {
    description:
      "Make a new workflow: a ComfyUI graph (api_json) and the params that " +
      "expose its inputs. It appears in ForgeUI beside the others and runs " +
      "with generate like any of them; you can change it later with " +
      "update_workflow. Start from an existing workflow with " +
      "`from_workflow` (its graph and params are copied, and whatever you " +
      "pass replaces that field), from one of ComfyUI's own templates " +
      "(`from_comfy_template`, see search_comfy_templates), from a " +
      "workflow as ComfyUI's editor saves it (`editor_json`), or write the " +
      "graph yourself (`api_json`). A template or editor document is " +
      "converted as ComfyUI's editor would queue it, subgraphs flattened " +
      "(an inner node is <instance>:<node>), and its save nodes become the " +
      "outputs; it starts with no params, so it runs exactly as it came " +
      "until you expose some with update_workflow. The graph " +
      "is checked against the node types this ComfyUI has before anything " +
      "is saved, and every problem comes back at once, naming the node; " +
      "then ForgeUI checks each param's bind against the graph. Nothing is " +
      "saved unless both pass.",
    inputSchema: z.strictObject({
      name: z.string().min(1).describe("display name, e.g. SD 1.5 (8 steps)"),
      id: z.string().optional().describe(
        "lowercase id, e.g. sd15-fast; made from the name when left out. " +
          "Must not be taken",
      ),
      from_workflow: z.string().optional().describe(
        "copy this ForgeUI workflow's graph and params first",
      ),
      from_comfy_template: z.string().optional().describe(
        "start from one of ComfyUI's own templates, by the name " +
          "search_comfy_templates gives",
      ),
      editor_json: z.record(z.string(), z.unknown()).optional().describe(
        "a workflow as ComfyUI's editor saves it ({nodes, links, …}, the " +
          "format shared workflows come in); it is converted to api_json",
      ),
      api_json: apiJson.optional(),
      ...manifestFields,
    }),
  }, async (
    {
      name,
      id,
      from_workflow,
      from_comfy_template,
      editor_json,
      api_json,
      ...fields
    },
  ) => {
    const starts = [from_workflow, from_comfy_template, editor_json, api_json]
      .filter((x) => x !== undefined).length;
    if (starts > 1) {
      return failure(
        "Nothing was saved: give one starting point — from_workflow, " +
          "from_comfy_template, editor_json or api_json",
      );
    }
    let graph: Record<string, unknown> = api_json ?? {};
    let manifest: Record<string, unknown> = {
      kind: "image",
      params: [],
      outputs: [],
    };
    let uiJson: unknown;
    if (from_workflow !== undefined) {
      let base: WorkflowSource;
      try {
        base = await read(from_workflow);
      } catch (cause) {
        return failure(
          `Nothing was saved: from_workflow: ${
            cause instanceof ForgeUiError && cause.status === 404
              ? `there is no workflow "${from_workflow}"`
              : cause instanceof Error
              ? cause.message
              : String(cause)
          }`,
        );
      }
      if (api_json === undefined) {
        graph = base.api_json;
        // Same graph, so the layout a person gave it in the editor still fits.
        if (base.has_ui_json) uiJson = base.ui_json;
      }
      if (base.manifest) {
        const { id: _id, name: _name, ...rest } = base.manifest;
        manifest = rest;
      }
    }
    const converted: string[] = [];
    if (from_comfy_template !== undefined || editor_json !== undefined) {
      let doc: unknown = editor_json;
      if (from_comfy_template !== undefined) {
        try {
          doc = await forge.get(
            `/comfy/templates/${encodeURIComponent(from_comfy_template)}.json`,
          );
        } catch {
          return failure(
            `Nothing was saved: ComfyUI has no template "${from_comfy_template}" ` +
              "(search_comfy_templates lists them by name)",
          );
        }
      }
      let info: ObjectInfo;
      try {
        info = await objectInfo(forge);
      } catch {
        return failure(
          `Nothing was saved: ${COMFY_UNREACHABLE}, and converting needs it`,
        );
      }
      const result = editorToApi(doc, info);
      if (result.errors.length > 0) {
        return failure(
          [
            "Nothing was saved: the editor document could not be converted.",
            bullets(result.errors),
          ].join("\n"),
        );
      }
      graph = result.graph as Record<string, unknown>;
      converted.push(...result.notes);
      // The document is kept as the editor's, so the graph opens as it was
      // laid out rather than rebuilt.
      uiJson = doc;
      if (fields.outputs === undefined) {
        manifest.outputs = outputNodes(graph, info);
      }
      if (fields.kind === undefined) {
        const kinds = (manifest.outputs as { kind: string }[]).map((o) =>
          o.kind
        );
        if (kinds.length > 0) manifest.kind = kinds[0];
      }
    }
    manifest = { ...manifest, ...defined(fields) };

    const check = await checkGraph(forge, graph);
    if (check.errors.length > 0) return failure(graphRefusal(check));
    check.warnings.unshift(...converted);
    try {
      const saved = await forge.post("/api/workflows", {
        id,
        name,
        manifest: { ...manifest, name },
        api_json: graph,
        ui_json: uiJson,
        agent: await agentLabel(llm),
      }) as WorkflowSource;
      return text(report(saved, check, fields.params));
    } catch (cause) {
      return failure(saveRefusal(cause));
    }
  });

  server.registerTool("update_workflow", {
    description:
      "Change a workflow you made with create_workflow. Workflows that " +
      "came with ForgeUI or that a person made cannot be changed — copy " +
      "one with create_workflow's `from_workflow` instead; " +
      "get_workflow_source says which are `editable`. Pass only what " +
      "changes: each field you pass replaces that whole field (`params` " +
      "is the whole list, so read it first with get_workflow_source and " +
      "send back what should stay). The same checks as create_workflow " +
      "run, and a refused change leaves the workflow as it was.",
    inputSchema: z.strictObject({
      workflow_id: z.string().describe("a workflow you made"),
      name: z.string().min(1).optional(),
      api_json: apiJson.optional(),
      ...manifestFields,
    }),
  }, async ({ workflow_id, name, api_json, ...fields }) => {
    let current: WorkflowSource;
    try {
      current = await read(workflow_id);
    } catch (cause) {
      return failure(saveRefusal(cause, workflow_id));
    }
    if (current.agent === null) {
      return failure(
        `Nothing was saved: "${workflow_id}" was not made by an agent ` +
          `(it ${
            current.source === "bundled"
              ? "came with ForgeUI"
              : "is one a person made or edited"
          }), and you can only change workflows you made. To work from ` +
          `it, call create_workflow with from_workflow "${workflow_id}" ` +
          `and change the copy.`,
      );
    }
    const changes = defined(fields);
    if (
      name === undefined && api_json === undefined &&
      Object.keys(changes).length === 0
    ) {
      return failure(
        "Nothing was saved: pass at least one field to change (name, " +
          "api_json, params, outputs, …)",
      );
    }
    const check = api_json === undefined
      ? null
      : await checkGraph(forge, api_json);
    if (check && check.errors.length > 0) return failure(graphRefusal(check));
    const base = current.manifest ??
      { kind: current.kind, params: [], outputs: [] };
    try {
      const saved = await forge.put(
        `/api/workflows/${encodeURIComponent(workflow_id)}`,
        {
          manifest: {
            ...base,
            ...changes,
            id: workflow_id,
            name: name ?? current.manifest?.name ?? current.name,
          },
          api_json,
          agent: await agentLabel(llm),
        },
      ) as WorkflowSource;
      return text(report(saved, check, fields.params));
    } catch (cause) {
      return failure(saveRefusal(cause, workflow_id));
    }
  });

  server.registerTool("delete_workflow", {
    description:
      "Delete a workflow you made: a draft that went nowhere, a copy you " +
      "no longer need. Workflows that came with ForgeUI or that a person " +
      "made cannot be deleted. What it already made stays in the gallery.",
    inputSchema: z.strictObject({
      workflow_id: z.string().describe("a workflow you made"),
    }),
  }, async ({ workflow_id }) => {
    let current: WorkflowSource;
    try {
      current = await read(workflow_id);
    } catch (cause) {
      return failure(
        saveRefusal(cause, workflow_id).replace(
          "Nothing was saved",
          "Nothing was deleted",
        ),
      );
    }
    if (current.agent === null) {
      return failure(
        `Nothing was deleted: "${workflow_id}" was not made by an agent ` +
          `(it ${
            current.source === "bundled"
              ? "came with ForgeUI"
              : "is one a person made or edited"
          }), and you can only delete workflows you made.`,
      );
    }
    try {
      await forge.delete(
        `/api/workflows/${encodeURIComponent(workflow_id)}`,
        { agent: await agentLabel(llm) },
      );
      return text({ deleted: workflow_id });
    } catch (cause) {
      return failure(
        saveRefusal(cause, workflow_id).replace(
          "Nothing was saved",
          "Nothing was deleted",
        ),
      );
    }
  });
}
