import { basename, fromFileUrl, join } from "@std/path";
import { copy, emptyDir, exists } from "@std/fs";
import type { DataPaths } from "../config/paths.ts";
import { workflowHash } from "./hash.ts";
import { apiGraphToLiteGraph, emptyLiteGraph } from "./litegraph.ts";
import {
  ManifestError,
  serializeManifest,
  validateManifest,
} from "./manifest.ts";
import type { ApiGraph, Manifest, Workflow, WorkflowSource } from "./types.ts";

export const MANIFEST_FILE = "manifest.json";
export const API_FILE = "workflow.api.json";
export const UI_FILE = "workflow.ui.json";

export class WorkflowNotFoundError extends Error {
  override readonly name = "WorkflowNotFoundError";
  constructor(id: string) {
    super(`no workflow "${id}"`);
  }
}

export class WorkflowConflictError extends Error {
  override readonly name = "WorkflowConflictError";
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
  let error: string | null = null;

  try {
    apiGraph = asGraph(await readJsonFile(join(dir, API_FILE)), API_FILE);
    const ui = await readJsonFile(join(dir, UI_FILE));
    uiGraph = ui === null ? null : (ui as Record<string, unknown>);
    const raw = await readJsonFile(join(dir, MANIFEST_FILE));
    if (raw === null) {
      error = `${MANIFEST_FILE} is missing`;
    } else {
      manifest = validateManifest(raw, { id, graph: apiGraph });
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
    error,
    apiGraph,
    uiGraph,
    hash: await workflowHash(apiGraph, manifest),
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
    params: [],
    outputs: [],
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
        ...workflow,
        hasBundled: shadowed !== undefined,
      });
    }
    this.#byId = byId;
  }

  /** Sorted by display name, which is the order the Workflows screen shows. */
  list(): Workflow[] {
    return [...this.#byId.values()].sort((a, b) =>
      (a.manifest?.name ?? a.id).localeCompare(b.manifest?.name ?? b.id)
    );
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
  async save(id: string, body: SaveWorkflowBody): Promise<Workflow> {
    const workflow = this.require(id);
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
      : asGraph(body.api_json, "api_json");
    // Validate before touching the filesystem, so a rejected save leaves no
    // half-made user copy behind.
    const manifest = body.manifest === undefined
      ? undefined
      : validateManifest(body.manifest, { id, graph });
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
    }
    return await this.#reloadOne(id);
  }

  /** `POST /api/workflows`: blank, or an imported LiteGraph document. */
  async create(body: CreateWorkflowBody = {}): Promise<Workflow> {
    const name = typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim()
      : "Untitled workflow";
    const id = this.#freeId(
      typeof body.id === "string" && body.id.length > 0
        ? body.id
        : slugify(name),
    );
    const dir = this.#userPath(id);
    await Deno.mkdir(dir, { recursive: true });

    const graph = body.api_json === undefined
      ? {}
      : asGraph(body.api_json, "api_json");
    const manifest = body.manifest === undefined
      ? stubManifest(id, name)
      : validateManifest(body.manifest, { id, graph });

    await writeJsonFile(
      join(dir, MANIFEST_FILE),
      JSON.parse(serializeManifest(manifest)),
    );
    await writeJsonFile(join(dir, API_FILE), graph);
    await writeJsonFile(
      join(dir, UI_FILE),
      body.ui_json ?? emptyLiteGraph(),
    );
    return await this.#reloadOne(id);
  }

  async duplicate(id: string): Promise<Workflow> {
    const source = this.require(id);
    const copyId = this.#freeId(`${id}-copy`);
    const dir = this.#userPath(copyId);
    await Deno.mkdir(dir, { recursive: true });
    await copy(source.dir, dir, { overwrite: true });

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

  /** `DELETE /api/workflows/:id`: user copies only, 409 for bundled (§12). */
  async remove(id: string): Promise<void> {
    const workflow = this.require(id);
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
