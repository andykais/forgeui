/**
 * Templates (DESIGN.md §4.8): a saved way to fill one workflow's panel. Each
 * of the workflow's params is **set** (a value in `values`), **asked for**
 * (in `ask`: left to whoever applies the template, and required while it is
 * applied) or **open** (in neither: whatever the panel would hold anyway).
 *
 * Files, as workflows are (§4.6): `templates/bundled/<id>.json` ships with
 * the app and is refreshed on every launch; `templates/user/<id>.json` is the
 * user's, and a user file with a bundled id shadows the bundled one. Deleting
 * that copy brings the bundled one back; a bundled template with no copy
 * cannot be deleted.
 *
 * A template outlives its workflow, as an output does (§7): one whose
 * workflow is gone, or that sets a key the workflow no longer has, still
 * lists, with what is wrong with it in `problems`. Only writes are refused.
 */

import { basename, extname, fromFileUrl, join } from "@std/path";
import { copy, emptyDir, exists } from "@std/fs";
import type { DataPaths } from "../config/paths.ts";
import { coerceParams, ParamError } from "../workflows/coerce.ts";
import type { WorkflowStore } from "../workflows/loader.ts";
import type { Manifest, Param } from "../workflows/types.ts";

export const TEMPLATE_FORMAT = 1;

/** What an action on an output looks templates up by (§4.8, §10). */
export const TEMPLATE_ACTIONS = ["upscale"] as const;
export type TemplateAction = typeof TEMPLATE_ACTIONS[number];

export interface Template {
  format: number;
  id: string;
  name: string;
  description: string | null;
  /** The one workflow this template fills, by id. */
  workflow: string;
  action: TemplateAction | null;
  /** The params this template sets, by key. */
  values: Record<string, unknown>;
  /** The params it leaves to whoever applies it, required while applied. */
  ask: string[];
}

export interface StoredTemplate extends Template {
  source: "bundled" | "user";
  /** True when a user copy shadows a bundled template of the same id. */
  hasBundled: boolean;
  /** Set when the file itself could not be read; the rest is then a stub. */
  error: string | null;
}

export class TemplateError extends Error {
  override readonly name = "TemplateError";
}

export class TemplateNotFoundError extends Error {
  override readonly name = "TemplateNotFoundError";
  constructor(id: string) {
    super(`no template "${id}"`);
  }
}

export class TemplateConflictError extends Error {
  override readonly name = "TemplateConflictError";
}

const ID = /^[a-z0-9][a-z0-9._-]*$/;

/** Where the shipped templates live in the source tree. */
export function shippedTemplatesDir(): string {
  return fromFileUrl(new URL("../../templates/bundled", import.meta.url));
}

/**
 * Refresh `<appdata>/templates/bundled` from the copy that ships with the
 * app; user templates are never touched (§4.8).
 */
export async function syncBundledTemplates(
  targetDir: string,
  sourceDir = shippedTemplatesDir(),
): Promise<number> {
  if (!(await exists(sourceDir))) return 0;
  await emptyDir(targetDir);
  let count = 0;
  for await (const entry of Deno.readDir(sourceDir)) {
    if (!entry.isFile || extname(entry.name) !== ".json") continue;
    await copy(join(sourceDir, entry.name), join(targetDir, entry.name), {
      overwrite: true,
    });
    count++;
  }
  return count;
}

// ------------------------------------------------------------ the shape

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TemplateError(`${where}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TemplateError(`${where}: expected a non-empty string`);
  }
  return value.trim();
}

function optionalText(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new TemplateError(`${where}: expected a string`);
  }
  return value.trim().length > 0 ? value.trim() : null;
}

function action(value: unknown, where: string): TemplateAction | null {
  if (value === undefined || value === null) return null;
  if (!(TEMPLATE_ACTIONS as readonly unknown[]).includes(value)) {
    throw new TemplateError(
      `${where}: expected one of ${TEMPLATE_ACTIONS.join(", ")}`,
    );
  }
  return value as TemplateAction;
}

function keys(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((key) => typeof key !== "string")) {
    throw new TemplateError(`${where}: expected a list of param keys`);
  }
  return [...new Set(value as string[])];
}

/**
 * A template's own shape, before anything is checked against its workflow:
 * what a file must hold to be read at all, and what a write must send.
 */
export function validateTemplate(value: unknown, id: string): Template {
  const raw = record(value, "template");
  const format = raw.format ?? TEMPLATE_FORMAT;
  if (format !== TEMPLATE_FORMAT) {
    throw new TemplateError(
      `template.format: ${format} is newer than this build reads`,
    );
  }
  const values = raw.values === undefined
    ? {}
    : record(raw.values, "template.values");
  const ask = keys(raw.ask, "template.ask");
  const both = ask.filter((key) => key in values);
  if (both.length > 0) {
    throw new TemplateError(
      `${both.join(", ")}: a param is either set or asked for, not both`,
    );
  }
  return {
    format: TEMPLATE_FORMAT,
    id,
    name: text(raw.name, "template.name"),
    description: optionalText(raw.description, "template.description"),
    workflow: text(raw.workflow, "template.workflow"),
    action: action(raw.action, "template.action"),
    values: structuredClone(values),
    ask,
  };
}

/**
 * Check a template against its workflow's params, and give back the values
 * as a job would see them: by the param's own type (§4.3), with nothing
 * required, because a template fills a panel rather than submitting one.
 * `seed: -1` stays -1 — "random" is a choice to keep, not one to roll now.
 */
export function checkTemplate(template: Template, manifest: Manifest): {
  values: Record<string, unknown>;
} {
  const params = new Map(manifest.params.map((param) => [param.key, param]));
  const unknown = [...Object.keys(template.values), ...template.ask]
    .filter((key) => !params.has(key));
  if (unknown.length > 0) {
    throw new TemplateError(
      `${template.workflow} has no param ${
        unknown.map((key) => `"${key}"`).join(", ")
      }`,
    );
  }
  const set: Param[] = Object.keys(template.values).map((key) =>
    ({
      ...params.get(key)!,
      required: false,
    }) as Param
  );
  let coerced: Record<string, unknown>;
  try {
    coerced = coerceParams({ ...manifest, params: set }, template.values, {
      randomSeed: () => 0,
    }).values;
  } catch (cause) {
    if (cause instanceof ParamError) {
      throw new TemplateError(cause.message);
    }
    throw cause;
  }
  for (const param of set) {
    if (param.type !== "seed") continue;
    const seed = template.values[param.key];
    if (typeof seed !== "number" || !Number.isInteger(seed) || seed < -1) {
      throw new TemplateError(
        `${param.key}: expected a whole number, or -1 for random`,
      );
    }
    coerced[param.key] = seed;
  }
  return { values: coerced };
}

// ------------------------------------------------------------ the store

export interface TemplateBody {
  name?: unknown;
  description?: unknown;
  workflow?: unknown;
  action?: unknown;
  values?: unknown;
  ask?: unknown;
}

export class TemplateStore {
  #bundledDir: string;
  #userDir: string;
  #byId = new Map<string, StoredTemplate>();

  private constructor(bundledDir: string, userDir: string) {
    this.#bundledDir = bundledDir;
    this.#userDir = userDir;
  }

  static async load(
    paths: Pick<DataPaths, "bundledTemplates" | "userTemplates">,
  ): Promise<TemplateStore> {
    const store = new TemplateStore(
      paths.bundledTemplates,
      paths.userTemplates,
    );
    await store.reload();
    return store;
  }

  async reload(): Promise<void> {
    const byId = new Map<string, StoredTemplate>();
    for (const template of await readDirectory(this.#bundledDir, "bundled")) {
      byId.set(template.id, template);
    }
    for (const template of await readDirectory(this.#userDir, "user")) {
      byId.set(template.id, {
        ...template,
        hasBundled: byId.has(template.id),
      });
    }
    this.#byId = byId;
  }

  /** By name; the order the Templates screen shows. */
  list(): StoredTemplate[] {
    return [...this.#byId.values()].sort((a, b) =>
      a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    );
  }

  get(id: string): StoredTemplate | undefined {
    return this.#byId.get(id);
  }

  require(id: string): StoredTemplate {
    const template = this.#byId.get(id);
    if (!template) throw new TemplateNotFoundError(id);
    return template;
  }

  /** `POST /api/templates`: a new user template, its id from its name. */
  async create(
    body: TemplateBody,
    workflows: WorkflowStore,
  ): Promise<StoredTemplate> {
    const name = text(body.name, "name");
    const id = this.#freeId(slugify(name));
    const template = validateTemplate({ ...body, name }, id);
    await this.#write(this.#checked(template, workflows));
    return this.require(id);
  }

  /**
   * `PUT /api/templates/:id`: replace what the body sends. A bundled
   * template gains a user copy, which shadows it (§4.8). The workflow a
   * template fills is fixed: a template for another one is a new template.
   */
  async save(
    id: string,
    body: TemplateBody,
    workflows: WorkflowStore,
  ): Promise<StoredTemplate> {
    const current = this.require(id);
    if (body.workflow !== undefined && body.workflow !== current.workflow) {
      throw new TemplateError(
        `a template fills one workflow; save a new template for ` +
          `"${String(body.workflow)}"`,
      );
    }
    const template = validateTemplate({
      name: body.name ?? current.name,
      description: body.description === undefined
        ? current.description
        : body.description,
      workflow: current.workflow,
      action: body.action === undefined ? current.action : body.action,
      values: body.values ?? current.values,
      ask: body.ask ?? current.ask,
    }, id);
    await this.#write(this.#checked(template, workflows));
    return this.require(id);
  }

  /**
   * `DELETE /api/templates/:id`: a user template goes; a user copy goes and
   * the bundled one it shadowed is back; a bundled one alone stays (409).
   */
  async remove(id: string): Promise<void> {
    const template = this.require(id);
    if (template.source === "bundled") {
      throw new TemplateConflictError(
        `"${id}" is bundled and cannot be deleted; a copy of it can`,
      );
    }
    await Deno.remove(join(this.#userDir, `${id}.json`));
    await this.reload();
  }

  #checked(template: Template, workflows: WorkflowStore): Template {
    const workflow = workflows.get(template.workflow);
    if (!workflow) {
      throw new TemplateError(`no workflow "${template.workflow}"`);
    }
    if (!workflow.manifest) {
      throw new TemplateError(
        `"${template.workflow}" has no manifest to fill${
          workflow.error ? `: ${workflow.error}` : ""
        }`,
      );
    }
    return { ...template, ...checkTemplate(template, workflow.manifest) };
  }

  async #write(template: Template): Promise<void> {
    await Deno.mkdir(this.#userDir, { recursive: true });
    const path = join(this.#userDir, `${template.id}.json`);
    const tmp = `${path}.tmp`;
    await Deno.writeTextFile(tmp, `${JSON.stringify(template, null, 2)}\n`);
    await Deno.rename(tmp, path);
    await this.reload();
  }

  #freeId(base: string): string {
    if (!this.#byId.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`;
      if (!this.#byId.has(candidate)) return candidate;
    }
    throw new TemplateConflictError(
      `cannot find a free id based on "${base}"`,
    );
  }
}

/**
 * What a template's workflow makes of it now, for the list: nothing wrong,
 * or the sentences that say what is. Never thrown — a template whose
 * workflow moved on still lists (§4.8).
 */
export function templateProblems(
  template: StoredTemplate,
  workflows: WorkflowStore,
): string[] {
  if (template.error) return [template.error];
  const workflow = workflows.get(template.workflow);
  if (!workflow) return [`no workflow "${template.workflow}"`];
  if (!workflow.manifest) {
    return [`"${template.workflow}" has no manifest to fill`];
  }
  try {
    checkTemplate(template, workflow.manifest);
    return [];
  } catch (cause) {
    return [cause instanceof Error ? cause.message : String(cause)];
  }
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "template";
}

async function readDirectory(
  dir: string,
  source: StoredTemplate["source"],
): Promise<StoredTemplate[]> {
  const out: StoredTemplate[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return out;
    throw cause;
  }
  for (const entry of entries) {
    if (!entry.isFile || extname(entry.name) !== ".json") continue;
    const id = basename(entry.name, ".json");
    if (!ID.test(id)) continue;
    const path = join(dir, entry.name);
    try {
      const template = validateTemplate(
        JSON.parse(await Deno.readTextFile(path)),
        id,
      );
      out.push({ ...template, source, hasBundled: false, error: null });
    } catch (cause) {
      // One bad file lists with its error rather than hiding the others.
      out.push({
        format: TEMPLATE_FORMAT,
        id,
        name: id,
        description: null,
        workflow: "",
        action: null,
        values: {},
        ask: [],
        source,
        hasBundled: false,
        error: `${entry.name}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      });
    }
  }
  return out;
}
