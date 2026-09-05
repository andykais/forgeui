# ForgeUI

A workflow-first frontend for ComfyUI. Every generation runs a ComfyUI workflow;
the UI is only the inputs a workflow's manifest exposes; every output ships with
a sidecar that reproduces it.

Deno · SQLite · Svelte. See `docs/DESIGN.md`.

## Documents

| File                        | Purpose                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `docs/DESIGN.md`            | Authoritative spec: architecture, schema, API, UI.                                         |
| `docs/IMPLEMENT-PHASE-1.md` | Work plan for the first milestone set (M0–M4), with definition of done.                    |
| `docs/MOCK-REVISIONS.md`    | Changes to the UI mocks that have been decided but may not yet be drawn.                   |
| `docs/MOCK-REVIEW.md`       | Review log of the mocks against the spec; every item carries its decision. Reference only. |
| `docs/mocks/`               | Frame PNGs (numbered) and the source `.dc.html` of the mocks.                              |
| `docs/PHASE-1-HANDOFF.md`   | What Phase 1 delivered, the decisions worth knowing, and where Phase 2 picks up.           |
| `AGENTS.md`                 | How to navigate and build the repo, and the conventions a coding agent must follow.        |

Phase 1 is complete; see the handoff document. Phases 2–5 of DESIGN.md §13 are
not started.

## Running it

Requires [Deno](https://deno.com) 2.x to run. Node is needed only to build the
interface, which ships pre-built in a release.

```sh
deno task start --data-dir ./data   # serve the UI and the API
deno task test                      # unit + integration + golden tests
deno task check                      # type-check
deno task fmt                        # format
deno task lint                       # lint
deno task reindex                    # rebuild app.db from the sidecars on disk
```

The data directory holds `config.yaml`, `app.db`, workflows and every output
(§3). It comes from `--data-dir`, else `FORGEUI_DATA_DIR`, else `~/.forgeui`,
and is created with a default `config.yaml` on first run. Other flags
(`--comfy-path`, `--comfy-url`, `--models-dir kind=path`, `--host`, `--port`)
override `config.yaml` for one run and are never written back; `--help` lists
them.

## Tests

| Command              | What it covers                                   |
| -------------------- | ------------------------------------------------ |
| `deno task test`     | unit, golden and server integration tests        |
| `deno task test:ui`  | param-panel component tests (vitest + jsdom)     |
| `deno task test:e2e` | the Playwright smoke test, against the built app |

None of them need a GPU or a real ComfyUI: `tests/fake-comfy/` is a stand-in
whose per-prompt behaviour comes from the data-driven scenarios in
`tests/fake-comfy/scenarios.ts`, and the end-to-end test runs it as a managed
child process behind a stub interpreter. The Playwright test uses the browser
already installed on the machine (`channel: "chrome"`).

Golden files under `tests/golden/` are only rewritten when asked:

```sh
UPDATE_GOLDEN=1 deno task test
```

## The interface

The Svelte app lives in `src/frontend/`, is built by Vite into
`src/frontend/dist/`, and is served by the Deno process — so `deno task start`
serves the API and the UI on one port. Node is only needed to build it.

```sh
deno task ui:install   # once: npm install inside src/frontend
deno task ui:build     # build into dist/, which the Deno server serves
deno task ui:dev       # Vite dev server on :5173, proxying /api, /ws and /comfy
deno task ui:check     # svelte-check
deno task ui:fmt       # prettier
```

## Starting the build

Open `docs/IMPLEMENT-PHASE-1.md` and begin at M0. Replace the mock PNGs in
`docs/mocks/` with the revised frames when they are ready, keeping the
numbering.
