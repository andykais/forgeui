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
| `.cursor/rules/project.mdc` | Rules the coding agent reads on every request.                                             |

## Running it

Requires [Deno](https://deno.com) 2.x; there is nothing else to install.

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

`deno task test` needs no GPU and no ComfyUI: `tests/fake-comfy/` is an
in-process stand-in whose per-prompt behaviour comes from the data-driven
scenarios in `tests/fake-comfy/scenarios.ts`. Golden files under `tests/golden/`
are only rewritten when asked:

```sh
UPDATE_GOLDEN=1 deno task test
```

## Starting the build

Open `docs/IMPLEMENT-PHASE-1.md` and begin at M0. Replace the mock PNGs in
`docs/mocks/` with the revised frames when they are ready, keeping the
numbering.
