import { basename, fromFileUrl, join } from "@std/path";
import { copy, emptyDir, exists } from "@std/fs";
import type { DataPaths } from "../config/paths.ts";
import { workflowHash } from "./hash.ts";
import { apiGraphToLiteGraph, emptyLiteGraph } from "./litegraph.ts";
import {
  ManifestError,
  resolveDefaults,
  serializeManifest,
  staleCopiedDefaults,
  validateManifest,
  withoutGraphDefaults,
} from "./manifest.ts";
import { log } from "../log.ts";
import type {
  ApiGraph,
  Manifest,
  Param,
  Workflow,
  WorkflowAgent,
  WorkflowSource,
} from "./types.ts";
import { checkGraphShape } from "./graph_check.ts";

export const MANIFEST_FILE = "manifest.json";
export const API_FILE = "workflow.api.json";
export const UI_FILE = "workflow.ui.json";
/** Who made a workflow, when an agent did (§4.9). User workflows only. */
export const AGENT_FILE = "agent.json";

export class WorkflowNotFoundError extends Error {
  override readonly name = "WorkflowNotFoundError";
  constructor(id: string) {
    super(`no workflow "${id}"`);
  }
}

export class WorkflowConflictError extends Error {
  override readonly name = "WorkflowConflictError";
}

/**
 * A write made on an agent's behalf to a workflow no agent made (§4.9).
 * The server's half of the rule; the bridge's tools are the other half.
 */
export class WorkflowForbiddenError extends Error {
  override readonly name = "WorkflowForbiddenError";
}

/** What `agent` on a create or save may hold: the agent's source label. */
const AGENT_SOURCE_MAX = 120;

/**
 * The `agent` field of `POST`/`PUT /api/workflows` (§4.9): absent for a
 * person's write, else the label of the agent the write is made for, the
 * same string a job it submits carries as `origin.source` (§6.2).
 */
export function readAgentSource(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ManifestError(
      'agent: expected the agent\'s source label, e.g. "llm:qwen-vlm"',
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length > AGENT_SOURCE_MAX) {
    throw new ManifestError(`agent: at most ${AGENT_SOURCE_MAX} characters`);
  }
  return trimmed;
}

/**
 * `agent.json`, or null. Anything that is not a well-formed record reads as
 * null: a damaged file makes the workflow a person's, which an agent cannot
 * change, rather than one it can. The rule fails closed.
 */
async function readAgentFile(dir: string): Promise<WorkflowAgent | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(dir, AGENT_FILE));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof raw?.source === "string" && raw.source.length > 0 &&
      typeof raw.created_at === "number"
    ) {
      return { source: raw.source, created_at: raw.created_at };
    }
  } catch { /* falls through */ }
  log(`workflows: ${dir}: ignoring a malformed ${AGENT_FILE}`);
  return null;
}

/** Where the shipped workflows live in the source tree. */
export function shippedBundledDir(): string {
  return fromFileUrl(new URL("../../workflows/bundled", import.meta.url));
}

async function readJsonFile(path: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ManifestError(
      `${basename(path)}: invalid JSON: ${
        cause instanceof Error ? cause.message : cause
      }`,
    );
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function asGraph(value: unknown, where: string): ApiGraph {
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestError(`${where}: expected an object of nodes`);
  }
  return value as ApiGraph;
}

/**
 * A graph about to be written, checked for the shape every queued prompt
 * needs (§4.9): nodes with a `class_type` and `inputs`, links that point at
 * nodes which exist. Every problem at once, so a caller that wrote the graph
 * by hand — an agent, usually — fixes them in one go rather than one per
 * round trip. Only on writes: a graph already on disk loads as it is.
 */
function checkedGraph(value: unknown, where: string): ApiGraph {
  const graph = asGraph(value, where);
  const problems = checkGraphShape(graph);
  if (problems.length > 0) {
    throw new ManifestError(
      `${where}: ${problems.length} problem${
        problems.length === 1 ? "" : "s"
      }: ${problems.join("; ")}`,
    );
  }
  return graph;
}

/**
 * Read one workflow directory. A manifest that fails validation does not stop
 * the workflow from loading: it lists with its error so the user can fix it in
 * the manifest editor, it just cannot be run.
 */
export async function loadWorkflowDir(
  dir: string,
  id: string,
  source: WorkflowSource,
): Promise<Workflow> {
  let apiGraph: ApiGraph = {};
  let uiGraph: Record<string, unknown> | null = null;
  let manifest: Manifest | null = null;
  let declared: Manifest | null = null;
  let error: string | null = null;

  try {
    apiGraph = asGraph(await readJsonFile(join(dir, API_FILE)), API_FILE);
    const ui = await readJsonFile(join(dir, UI_FILE));
    uiGraph = ui === null ? null : (ui as Record<string, unknown>);
    const raw = await readJsonFile(join(dir, MANIFEST_FILE));
    if (raw === null) {
      error = `${MANIFEST_FILE} is missing`;
    } else {
      // The graph supplies the defaults it already holds, so a loader edited
      // in ComfyUI shows up in the panel instead of being overwritten by a
      // stale copy in the manifest.
      declared = validateManifest(raw, { id, graph: apiGraph });
      manifest = resolveDefaults(declared, apiGraph);
    }
  } catch (cause) {
    if (!(cause instanceof ManifestError)) throw cause;
    manifest = null;
    error = cause.message;
  }

  return {
    id,
    source,
    dir,
    hasUserCopy: source === "user",
    hasBundled: source === "bundled",
    manifest,
    declared,
    error,
    apiGraph,
    uiGraph,
    hash: await workflowHash(apiGraph, manifest),
    // Bundled workflows ship with the app; nothing an agent wrote is in one.
    agent: source === "user" ? await readAgentFile(dir) : null,
  };
}

async function loadDirectory(
  root: string,
  source: WorkflowSource,
): Promise<Workflow[]> {
  const out: Workflow[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory || entry.name.startsWith(".")) continue;
      out.push(
        await loadWorkflowDir(join(root, entry.name), entry.name, source),
      );
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return out;
}

/**
 * Refresh `<appdata>/workflows/bundled` from the copy that ships with the app
 * (§4.6: bundled workflows are overwritten on upgrade). User copies are never
 * touched.
 */
export async function syncBundledWorkflows(
  targetDir: string,
  sourceDir = shippedBundledDir(),
): Promise<number> {
  if (!(await exists(sourceDir))) return 0;
  await emptyDir(targetDir);
  let count = 0;
  for await (const entry of Deno.readDir(sourceDir)) {
    if (!entry.isDirectory) {
      await copy(join(sourceDir, entry.name), join(targetDir, entry.name), {
        overwrite: true,
      });
      continue;
    }
    await copy(join(sourceDir, entry.name), join(targetDir, entry.name), {
      overwrite: true,
    });
    count++;
  }
  return count;
}

export interface SaveWorkflowBody {
  manifest?: unknown;
  ui_json?: unknown;
  api_json?: unknown;
}

export interface CreateWorkflowBody extends SaveWorkflowBody {
  id?: string;
  name?: string;
}

/** Who a write is made for: a person (null) or an agent's label (§4.9). */
export interface WriteActor {
  agent: string | null;
}

const PERSON: WriteActor = { agent: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "workflow";
}

function stubManifest(id: string, name: string): Manifest {
  return {
    id,
    name,
    family: null,
    kind: "image",
    category: null,
    description: null,
    requires: [],
    prompt: null,
    tone: [],
    sections: [],
    params: [],
    outputs: [],
  };
}

/**
 * A user copy with the defaults an older build copied into it taken back
 * out (§4.6, {@link staleCopiedDefaults}), so its graph decides them again.
 *
 * In memory only: the file on disk is the user's, and is not rewritten
 * behind their back. The next save from the workflow page writes the
 * manifest without them, since they come back marked as the graph's.
 */
async function withoutStaleDefaults(
  user: Workflow,
  bundled: Workflow,
): Promise<Workflow> {
  if (!user.declared || !bundled.declared) return user;
  const stale = staleCopiedDefaults(
    user.declared,
    user.apiGraph,
    bundled.declared,
    bundled.apiGraph,
  );
  if (stale.length === 0) return user;
  log(
    `workflows: ${user.id}: ${stale.join(", ")} follow the edited graph ` +
      `rather than the bundled values an earlier save copied into the manifest`,
  );
  const declared: Manifest = {
    ...user.declared,
    params: user.declared.params.map((param) => {
      if (!stale.includes(param.key)) return param;
      const { default: _copied, ...rest } = param as Param & {
        default?: unknown;
      };
      return rest as Param;
    }),
  };
  const manifest = resolveDefaults(declared, user.apiGraph);
  return {
    ...user,
    declared,
    manifest,
    hash: await workflowHash(user.apiGraph, manifest),
  };
}

/**
 * Every workflow the app knows about, with user copies shadowing bundled ones
 * of the same id (§4.6). Writes go to `workflows/user/` only.
 */
export class WorkflowStore {
  #bundledDir: string;
  #userDir: string;
  #byId = new Map<string, Workflow>();

  private constructor(bundledDir: string, userDir: string) {
    this.#bundledDir = bundledDir;
    this.#userDir = userDir;
  }

  static async load(
    paths: Pick<DataPaths, "bundledWorkflows" | "userWorkflows">,
  ) {
    const store = new WorkflowStore(
      paths.bundledWorkflows,
      paths.userWorkflows,
    );
    await store.reload();
    return store;
  }

  async reload(): Promise<void> {
    const bundled = await loadDirectory(this.#bundledDir, "bundled");
    const user = await loadDirectory(this.#userDir, "user");
    const byId = new Map<string, Workflow>();
    for (const workflow of bundled) byId.set(workflow.id, workflow);
    for (const workflow of user) {
      const shadowed = byId.get(workflow.id);
      byId.set(workflow.id, {
        ...(shadowed
          ? await withoutStaleDefaults(workflow, shadowed)
          : workflow),
        hasBundled: shadowed !== undefined,
      });
    }
    this.#byId = byId;
  }

  /**
   * The order the Workflows screen shows, and with it the Generate picker:
   * whatever the user dragged into place first, in that order, then
   * everything else by display name.
   *
   * `order` holds only the ids that were moved, so a workflow added later
   * falls in among the names rather than at the end of a list nobody
   * updated, and one that is deleted leaves nothing behind (§4.6).
   */
  list(order: readonly string[] = []): Workflow[] {
    const placed = new Map(order.map((id, at) => [id, at]));
    const name = (workflow: Workflow) => workflow.manifest?.name ?? workflow.id;
    return [...this.#byId.values()].sort((a, b) => {
      const at = placed.get(a.id) ?? Infinity;
      const bt = placed.get(b.id) ?? Infinity;
      if (at !== bt) return at - bt;
      return name(a).localeCompare(name(b));
    });
  }

  get(id: string): Workflow | undefined {
    return this.#byId.get(id);
  }

  require(id: string): Workflow {
    const workflow = this.#byId.get(id);
    if (!workflow) throw new WorkflowNotFoundError(id);
    return workflow;
  }

  /** The LiteGraph document for the editor, rebuilt when none was saved. */
  uiGraph(workflow: Workflow): Record<string, unknown> {
    if (workflow.uiGraph) return workflow.uiGraph;
    if (Object.keys(workflow.apiGraph).length === 0) {
      return emptyLiteGraph() as unknown as Record<string, unknown>;
    }
    return apiGraphToLiteGraph(workflow.apiGraph) as unknown as Record<
      string,
      unknown
    >;
  }

  #userPath(id: string): string {
    return join(this.#userDir, id);
  }

  /** Copy a bundled workflow into `workflows/user/` before writing to it. */
  async #ensureUserCopy(workflow: Workflow): Promise<string> {
    const dir = this.#userPath(workflow.id);
    if (workflow.source === "user") return dir;
    await Deno.mkdir(dir, { recursive: true });
    await copy(workflow.dir, dir, { overwrite: true });
    return dir;
  }

  async #reloadOne(id: string): Promise<Workflow> {
    await this.reload();
    return this.require(id);
  }

  /**
   * `PUT /api/workflows/:id`: write the manifest and/or the two graph files.
   * Saving a bundled workflow creates the user copy first (§4.6).
   */
  async save(
    id: string,
    body: SaveWorkflowBody,
    actor: WriteActor = PERSON,
  ): Promise<Workflow> {
    const workflow = this.require(id);
    // First, before anything else is read or written: an agent may change
    // only what an agent made (§4.9). A person may change anything,
    // including an agent's workflow, which stays the agent's to edit too.
    if (actor.agent !== null && workflow.agent === null) {
      throw new WorkflowForbiddenError(
        `"${id}" was not made by an agent, so it cannot be changed on an ` +
          `agent's behalf; make a new workflow instead (a copy of this one ` +
          `is a fine start)`,
      );
    }
    if (
      body.manifest === undefined && body.ui_json === undefined &&
      body.api_json === undefined
    ) {
      throw new ManifestError(
        "nothing to save: send manifest, ui_json or api_json",
      );
    }
    const graph = body.api_json === undefined
      ? workflow.apiGraph
      : checkedGraph(body.api_json, "api_json");
    // Validate before touching the filesystem, so a rejected save leaves no
    // half-made user copy behind.
    // Without the defaults the screen was only showing: the ones the graph
    // filled in come back marked, and stay the graph's (§4.6).
    const manifest = body.manifest === undefined
      ? undefined
      : validateManifest(withoutGraphDefaults(body.manifest), { id, graph });
    if (
      manifest === undefined && body.api_json !== undefined && workflow.manifest
    ) {
      // The graph changed under an existing manifest: re-check the binds.
      validateManifest(workflow.manifest, { id, graph });
    }

    const dir = await this.#ensureUserCopy(workflow);
    if (manifest !== undefined) {
      await writeJsonFile(
        join(dir, MANIFEST_FILE),
        JSON.parse(serializeManifest(manifest)),
      );
    }
    if (body.api_json !== undefined) {
      await writeJsonFile(join(dir, API_FILE), graph);
    }
    if (body.ui_json !== undefined) {
      await writeJsonFile(join(dir, UI_FILE), body.ui_json);
    } else if (body.api_json !== undefined) {
      // A new graph without its editor document leaves the old document
      // describing a graph that no longer runs. Without one, the editor
      // rebuilds it from the api graph (§4.1), which is at least the truth.
      await Deno.remove(join(dir, UI_FILE)).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
    return await this.#reloadOne(id);
  }

  /** `POST /api/workflows`: blank, or an imported LiteGraph document. */
  async create(
    body: CreateWorkflowBody = {},
    actor: WriteActor = PERSON,
  ): Promise<Workflow> {
    const named = typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim()
      : null;
    const asked = typeof body.id === "string" && body.id.length > 0
      ? body.id
      : null;
    // An agent that names an id means that id: quietly saving it as
    // `<id>-2` would leave it editing, and running, something it did not
    // make (§4.9). A person's import is renamed, as it always was.
    if (actor.agent !== null && asked !== null && this.#byId.has(asked)) {
      throw new WorkflowConflictError(
        `a workflow "${asked}" already exists; pick another id, or leave ` +
          `it out to have one made from the name`,
      );
    }
    const manifestName = isRecord(body.manifest) &&
        typeof body.manifest.name === "string" &&
        body.manifest.name.trim().length > 0
      ? body.manifest.name.trim()
      : null;
    const name = named ?? manifestName ?? "Untitled workflow";
    const id = this.#freeId(asked ?? slugify(name));

    // Everything is checked before the directory exists, so a refused
    // create leaves nothing behind for the next listing to trip over.
    const graph = body.api_json === undefined
      ? {}
      : checkedGraph(body.api_json, "api_json");
    const manifest = body.manifest === undefined
      ? stubManifest(id, name)
      : validateManifest(
        // The directory decides the id, and a manifest with no name of its
        // own takes the request's: neither has to be given twice.
        // A manifest copied from another workflow's detail carries the
        // defaults that graph only filled in; they stay the graph's (§4.3).
        isRecord(body.manifest)
          ? withoutGraphDefaults({
            ...body.manifest,
            id,
            name: manifestName ?? name,
          })
          : body.manifest,
        { id, graph },
      );

    const dir = this.#userPath(id);
    await Deno.mkdir(dir, { recursive: true });
    try {
      await writeJsonFile(
        join(dir, MANIFEST_FILE),
        JSON.parse(serializeManifest(manifest)),
      );
      await writeJsonFile(join(dir, API_FILE), graph);
      if (body.ui_json !== undefined) {
        await writeJsonFile(join(dir, UI_FILE), body.ui_json);
      } else if (Object.keys(graph).length === 0) {
        await writeJsonFile(join(dir, UI_FILE), emptyLiteGraph());
      }
      // A graph with no editor document gets none: the editor rebuilds one
      // from the api graph (§4.1), laid out, rather than opening blank.
      if (actor.agent !== null) {
        const record: WorkflowAgent = {
          source: actor.agent,
          created_at: Date.now(),
        };
        await writeJsonFile(join(dir, AGENT_FILE), record);
      }
    } catch (error) {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      throw error;
    }
    return await this.#reloadOne(id);
  }

  async duplicate(id: string): Promise<Workflow> {
    const source = this.require(id);
    const copyId = this.#freeId(`${id}-copy`);
    const dir = this.#userPath(copyId);
    await Deno.mkdir(dir, { recursive: true });
    await copy(source.dir, dir, { overwrite: true });
    // A copy someone asked for in the app is theirs, whoever made the
    // original (§4.9).
    await Deno.remove(join(dir, AGENT_FILE)).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });

    const manifest = source.manifest
      ? { ...source.manifest, id: copyId, name: `${source.manifest.name} copy` }
      : stubManifest(copyId, `${id} copy`);
    await writeJsonFile(
      join(dir, MANIFEST_FILE),
      JSON.parse(serializeManifest(manifest)),
    );
    return await this.#reloadOne(copyId);
  }

  /** `POST /api/workflows/:id/reset`: drop the user copy, revert to bundled. */
  async reset(id: string): Promise<Workflow> {
    const workflow = this.require(id);
    if (!workflow.hasBundled) {
      throw new WorkflowConflictError(
        `"${id}" has no bundled version to reset to`,
      );
    }
    if (workflow.source !== "user") {
      throw new WorkflowConflictError(`"${id}" has no user copy`);
    }
    await Deno.remove(this.#userPath(id), { recursive: true });
    return await this.#reloadOne(id);
  }

  /**
   * `DELETE /api/workflows/:id`: user copies only, 409 for bundled (§12).
   * On an agent's behalf, only a workflow an agent made (§4.9).
   */
  async remove(id: string, actor: WriteActor = PERSON): Promise<void> {
    const workflow = this.require(id);
    if (actor.agent !== null && workflow.agent === null) {
      throw new WorkflowForbiddenError(
        `"${id}" was not made by an agent, so it cannot be deleted on an ` +
          `agent's behalf`,
      );
    }
    if (workflow.hasBundled) {
      throw new WorkflowConflictError(
        workflow.source === "user"
          ? `"${id}" shadows a bundled workflow; reset it instead of deleting it`
          : `"${id}" is bundled and cannot be deleted`,
      );
    }
    await Deno.remove(workflow.dir, { recursive: true });
    await this.reload();
  }

  #freeId(base: string): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(base)) {
      throw new ManifestError(
        `id "${base}": expected a lowercase directory-safe id`,
      );
    }
    if (!this.#byId.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`;
      if (!this.#byId.has(candidate)) return candidate;
    }
    throw new WorkflowConflictError(`cannot find a free id based on "${base}"`);
  }
}
