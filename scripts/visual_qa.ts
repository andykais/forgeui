/**
 * The visual QA pass: build the UI, walk every screen and state worth looking
 * at (`tests/e2e/qa.spec.ts`, against the fake ComfyUI), and lay the shots out
 * as one dense, self-contained HTML contact sheet.
 *
 * ```sh
 * deno task qa                          # build, shoot, write the sheet
 * deno task qa --out /tmp/qa            # somewhere else
 * deno task qa --no-build               # the SPA in src/frontend/dist as is
 * deno task qa --sheet-only             # re-render the sheet from manifest.json
 * deno task qa --link                   # reference shots/ instead of inlining
 * ```
 *
 * It prints the sheet's path. The sheet inlines every image by default, so
 * the one file is the whole report — it can be attached, published or opened
 * from anywhere. Exits non-zero only when there is nothing to show.
 */

import { parseArgs } from "@std/cli/parse-args";
import { encodeBase64 } from "@std/encoding/base64";
import { dirname, fromFileUrl, join, resolve } from "@std/path";

const repo = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const e2e = join(repo, "tests", "e2e");

interface Entry {
  file: string;
  group: string;
  title: string;
  note: string;
  viewport: string;
  url: string;
  error: string | null;
  console: string[];
}

interface GitInfo {
  branch: string;
  commit: string;
  subject: string;
  base: string | null;
  changed: string[];
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

async function run(
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<number> {
  console.log(`$ ${cmd.join(" ")}`);
  const { code } = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: options.cwd ?? repo,
    env: options.env,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return code;
}

async function git(...args: string[]): Promise<string | null> {
  try {
    const { code, stdout } = await new Deno.Command("git", {
      args,
      cwd: repo,
      stdout: "piped",
      stderr: "null",
    }).output();
    return code === 0 ? new TextDecoder().decode(stdout).trim() : null;
  } catch {
    return null;
  }
}

async function gitInfo(): Promise<GitInfo> {
  const base = (await git("rev-parse", "--verify", "--quiet", "origin/main"))
    ? "origin/main"
    : null;
  const changed = base
    ? (await git("diff", "--name-only", `${base}...HEAD`))?.split("\n")
      .filter((line) => line.length > 0) ?? []
    : [];
  return {
    branch: (await git("rev-parse", "--abbrev-ref", "HEAD")) ?? "?",
    commit: (await git("rev-parse", "--short", "HEAD")) ?? "?",
    subject: (await git("log", "-1", "--format=%s")) ?? "",
    base,
    changed,
  };
}

/**
 * Where a browser is. Playwright's `channel: "chrome"` needs Google Chrome,
 * which a container rarely has; the bundled chromium of a Playwright image is
 * the usual stand-in (`FORGEUI_E2E_BROWSER`, as for `deno task test:e2e`).
 */
function browser(): string | undefined {
  const named = Deno.env.get("FORGEUI_E2E_BROWSER");
  if (named) return named;
  const bundled = "/opt/pw-browsers/chromium";
  return exists(bundled) ? bundled : undefined;
}

async function shoot(outDir: string, build: boolean): Promise<void> {
  if (build) {
    if (!exists(join(repo, "src", "frontend", "node_modules"))) {
      await run(["deno", "task", "ui:install"]);
    }
    if (await run(["deno", "task", "ui:build"]) !== 0) {
      throw new Error("the UI did not build; nothing to photograph");
    }
  }
  if (!exists(join(e2e, "node_modules"))) {
    await run(["npm", "install", "--no-audit", "--no-fund", "--silent"], {
      cwd: e2e,
    });
  }
  await Deno.remove(outDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(join(outDir, "shots"), { recursive: true });
  const executable = browser();
  const code = await run(
    ["npx", "playwright", "test", "--config", "playwright.qa.config.ts"],
    {
      cwd: e2e,
      env: {
        FORGEUI_QA_DIR: outDir,
        ...(executable ? { FORGEUI_E2E_BROWSER: executable } : {}),
      },
    },
  );
  // Each shot records its own failure, so a red run still has a sheet worth
  // reading — it is said here and drawn there, rather than ending it.
  if (code !== 0) {
    console.warn(`playwright exited ${code}; building the sheet anyway`);
  }
}

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sheet(
  entries: Entry[],
  images: Map<string, string>,
  info: GitInfo,
  taken: Date,
): string {
  const failed = entries.filter((entry) => entry.error).length;
  const noisy = entries.filter((entry) => entry.console.length > 0).length;
  const groups = [...new Set(entries.map((entry) => entry.group))];
  const frontend = info.changed.filter((path) =>
    path.startsWith("src/frontend/")
  );

  const figures = (group: string) =>
    entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.group === group)
      .map(({ entry, index }) => {
        const flags = [
          entry.error ? `<span class="flag fail">failed</span>` : "",
          entry.console.length
            ? `<span class="flag warn">${entry.console.length} console</span>`
            : "",
        ].join("");
        return `<figure data-i="${index}" class="${
          entry.error ? "is-fail" : ""
        } ${entry.console.length ? "is-warn" : ""}" title="${
          escape(
            `${entry.title} — ${entry.note}\n${entry.url} · ${entry.viewport}`,
          )
        }">
<img src="${images.get(entry.file)}" alt="${
          escape(entry.title)
        }" decoding="async">
<figcaption><b>${String(index + 1).padStart(2, "0")}</b> ${
          escape(entry.title)
        }${flags}</figcaption>
</figure>`;
      })
      .join("\n");

  const data = JSON.stringify(
    entries.map((entry) => ({ ...entry, src: images.get(entry.file) })),
  ).replaceAll("</", "<\\/");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ForgeUI Visual QA</title>
<style>
:root {
  --bg: #111214; --panel: #1a1c1f; --line: #2a2d31; --text: #e6e6e6;
  --dim: #8b9097; --accent: #7aa2f7; --fail: #f7768e; --warn: #e0af68;
  --w: 230px;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg: #f4f4f5; --panel: #ffffff; --line: #d9d9de; --text: #18181b;
    --dim: #6b6b74; --accent: #3b5bdb; --fail: #c92a4a; --warn: #a86400;
    color-scheme: light;
  }
}
:root[data-theme="dark"] { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 12px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
code, .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
header { position: sticky; top: 0; z-index: 5; background: var(--panel);
  border-bottom: 1px solid var(--line); padding: 6px 16px; display: flex;
  flex-wrap: wrap; gap: 6px 16px; align-items: center; }
header h1 { font-size: 13px; margin: 0; }
.meta { color: var(--dim); }
.meta b { color: var(--text); font-weight: 600; }
.stat.fail b { color: var(--fail); }
.stat.warn b { color: var(--warn); }
.controls { display: flex; gap: 4px; align-items: center; margin-left: auto; flex-wrap: wrap; }
.controls button { background: transparent; color: var(--dim); border: 1px solid var(--line);
  border-radius: 4px; padding: 2px 8px; font: inherit; cursor: pointer; }
.controls button.on { color: var(--text); border-color: var(--accent); }
.controls input { width: 110px; accent-color: var(--accent); }
nav { display: flex; flex-wrap: wrap; gap: 2px 10px; width: 100%; }
nav a { color: var(--accent); text-decoration: none; }
details { width: 100%; color: var(--dim); }
details ul { margin: 4px 0; padding-left: 16px; columns: 3 260px; }
main { padding: 4px 16px 32px; }
section h2 { font-size: 12px; margin: 10px 0 4px; color: var(--dim); text-transform: uppercase;
  letter-spacing: .06em; }
.grid { display: grid; gap: 4px; grid-template-columns: repeat(auto-fill, minmax(min(var(--w), 100%), 1fr)); }
figure { margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 3px;
  overflow: hidden; cursor: zoom-in; }
figure:hover { border-color: var(--accent); }
figure.is-warn { border-color: var(--warn); }
figure.is-fail { border-color: var(--fail); border-width: 2px; }
figure img { display: block; width: 100%; height: auto; aspect-ratio: 16 / 10; object-fit: cover;
  object-position: top left; background: #000; }
figcaption { padding: 2px 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
figcaption b { color: var(--dim); font-weight: 500; }
.flag { margin-left: 4px; padding: 0 4px; border-radius: 3px; font-size: 10px; }
.flag.fail { background: var(--fail); color: #000; }
.flag.warn { background: var(--warn); color: #000; }
body.only-fail figure:not(.is-fail), body.only-warn figure:not(.is-warn) { display: none; }
body.only-fail section:not(:has(figure.is-fail)), body.only-warn section:not(:has(figure.is-warn)) { display: none; }
#box { position: fixed; inset: 0; z-index: 10; background: rgb(0 0 0 / .92); display: none;
  flex-direction: column; }
#box.open { display: flex; }
#box .bar { display: flex; gap: 12px; align-items: baseline; padding: 8px 16px; color: #ddd;
  flex-wrap: wrap; }
#box .bar .dim { color: #999; }
#box .stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
  padding: 0 16px 8px; }
#box img { max-width: 100%; max-height: 100%; object-fit: contain; }
#box pre { margin: 0 16px 8px; max-height: 24vh; overflow: auto; white-space: pre-wrap;
  font-size: 11px; padding: 6px 8px; border-radius: 4px; }
#box pre.err { background: rgb(247 118 142 / .15); color: #f7768e; }
#box pre.con { background: rgb(224 175 104 / .12); color: #e0af68; }
#box pre:empty { display: none; }
</style>
</head>
<body>
<header>
  <h1>ForgeUI visual QA</h1>
  <span class="meta"><b>${escape(info.branch)}</b> @ <code>${
    escape(info.commit)
  }</code> ${escape(info.subject)}</span>
  <span class="meta">${
    escape(taken.toISOString().replace("T", " ").slice(0, 16))
  } UTC</span>
  <span class="meta stat"><b>${entries.length}</b> shots</span>
  <span class="meta stat ${failed ? "fail" : ""}"><b>${failed}</b> failed</span>
  <span class="meta stat ${
    noisy ? "warn" : ""
  }"><b>${noisy}</b> with console errors</span>
  <div class="controls">
    <button data-filter="" class="on">All</button>
    <button data-filter="only-fail">Failed</button>
    <button data-filter="only-warn">Console</button>
    <label class="meta">size <input id="size" type="range" min="120" max="640" step="10" value="230"></label>
  </div>
  <nav>${
    groups.map((group) =>
      `<a href="#${escape(group.replaceAll(" ", "-"))}">${escape(group)}</a>`
    ).join("")
  }</nav>
  ${
    info.base
      ? `<details><summary>${info.changed.length} files changed against ${
        escape(info.base)
      }${
        frontend.length ? `, ${frontend.length} in src/frontend` : ""
      }</summary><ul>${
        info.changed.map((path) => `<li><code>${escape(path)}</code></li>`)
          .join("")
      }</ul></details>`
      : ""
  }
</header>
<main>
${
    groups.map((group) =>
      `<section id="${escape(group.replaceAll(" ", "-"))}"><h2>${
        escape(group)
      }</h2><div class="grid">
${figures(group)}
</div></section>`
    ).join("\n")
  }
</main>
<div id="box" role="dialog" aria-modal="true">
  <div class="bar"><b id="box-title"></b><span class="dim" id="box-note"></span>
    <code class="dim" id="box-url"></code><span class="dim">← → to step · esc to close</span></div>
  <pre class="err" id="box-err"></pre>
  <pre class="con" id="box-con"></pre>
  <div class="stage"><img id="box-img" alt=""></div>
</div>
<script>
const shots = ${data};
const box = document.getElementById("box");
let at = -1;
function show(i) {
  at = (i + shots.length) % shots.length;
  const s = shots[at];
  document.getElementById("box-img").src = s.src;
  document.getElementById("box-title").textContent = (at + 1) + ". " + s.group + " · " + s.title;
  document.getElementById("box-note").textContent = s.note;
  document.getElementById("box-url").textContent = s.url + " · " + s.viewport;
  document.getElementById("box-err").textContent = s.error || "";
  document.getElementById("box-con").textContent = s.console.join("\\n");
  box.classList.add("open");
}
document.querySelectorAll("figure").forEach((f) =>
  f.addEventListener("click", () => show(Number(f.dataset.i))));
box.addEventListener("click", (e) => { if (e.target !== document.getElementById("box-img")) box.classList.remove("open"); });
document.addEventListener("keydown", (e) => {
  if (!box.classList.contains("open")) return;
  if (e.key === "Escape") box.classList.remove("open");
  if (e.key === "ArrowRight") show(at + 1);
  if (e.key === "ArrowLeft") show(at - 1);
});
const size = document.getElementById("size");
size.addEventListener("input", () => document.documentElement.style.setProperty("--w", size.value + "px"));
document.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => {
  document.body.className = b.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach((o) => o.classList.toggle("on", o === b));
}));
</script>
</body>
</html>
`;
}

async function writeSheet(outDir: string, inline: boolean): Promise<string> {
  const manifest = join(outDir, "manifest.json");
  if (!exists(manifest)) {
    throw new Error(`no ${manifest}: nothing was photographed`);
  }
  const entries = JSON.parse(await Deno.readTextFile(manifest)) as Entry[];
  if (entries.length === 0) throw new Error("the manifest is empty");
  const images = new Map<string, string>();
  for (const entry of entries) {
    const path = join(outDir, "shots", entry.file);
    images.set(
      entry.file,
      inline && exists(path)
        ? `data:image/jpeg;base64,${encodeBase64(await Deno.readFile(path))}`
        : `shots/${entry.file}`,
    );
  }
  const taken = (await Deno.stat(manifest)).mtime ?? new Date();
  const html = sheet(entries, images, await gitInfo(), taken);
  const target = join(outDir, "index.html");
  await Deno.writeTextFile(target, html);

  const failed = entries.filter((entry) => entry.error);
  const noisy = entries.filter((entry) => entry.console.length > 0);
  console.log(
    `\n${entries.length} shots, ${failed.length} failed, ${noisy.length} with console errors`,
  );
  for (const entry of failed) {
    console.log(
      `  FAILED  ${entry.group} / ${entry.title}: ${
        entry.error?.split("\n")[0]
      }`,
    );
  }
  for (const entry of noisy) {
    console.log(
      `  CONSOLE ${entry.group} / ${entry.title}: ${entry.console[0]}`,
    );
  }
  console.log(`\nsheet: ${target} (${(html.length / 1e6).toFixed(1)} MB)`);
  if (inline && html.length > 15e6) {
    console.warn("over 15 MB: too big to publish as one page; try --link");
  }
  return target;
}

if (import.meta.main) {
  const flags = parseArgs(Deno.args, {
    string: ["out"],
    boolean: ["build", "sheet-only", "link"],
    default: { build: true },
    negatable: ["build"],
  });
  const outDir = resolve(flags.out ?? join(e2e, ".qa"));
  try {
    if (!flags["sheet-only"]) await shoot(outDir, flags.build);
    await writeSheet(outDir, !flags.link);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }
}
