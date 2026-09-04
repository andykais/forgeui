# ForgeUI

A workflow-first frontend for ComfyUI. Every generation runs a ComfyUI
workflow; the UI is only the inputs a workflow's manifest exposes; every
output ships with a sidecar that reproduces it.

Deno · SQLite · Svelte. See `docs/DESIGN.md`.

## Documents

| File | Purpose |
|---|---|
| `docs/DESIGN.md` | Authoritative spec: architecture, schema, API, UI. |
| `docs/IMPLEMENT-PHASE-1.md` | Work plan for the first milestone set (M0–M4), with definition of done. |
| `docs/MOCK-REVISIONS.md` | Changes to the UI mocks that have been decided but may not yet be drawn. |
| `docs/MOCK-REVIEW.md` | Review log of the mocks against the spec; every item carries its decision. Reference only. |
| `docs/mocks/` | Frame PNGs (numbered) and the source `.dc.html` of the mocks. |
| `.cursor/rules/project.mdc` | Rules the coding agent reads on every request. |

## Starting the build

Open `docs/IMPLEMENT-PHASE-1.md` and begin at M0. Replace the mock PNGs in
`docs/mocks/` with the revised frames when they are ready, keeping the
numbering.
