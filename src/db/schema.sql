-- ForgeUI schema, verbatim from DESIGN.md §7. The database is a derived index:
-- every row about outputs, inputs and samples can be rebuilt from files and
-- sidecars by `deno task reindex`. No foreign keys point at workflows.

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,            -- ULID
  prompt_id TEXT,                 -- ComfyUI id
  workflow_id TEXT, workflow_hash TEXT,
  status TEXT NOT NULL,           -- queued|running|done|failed|cancelled
  params_json TEXT NOT NULL,
  api_graph_json TEXT NOT NULL,   -- the rewritten graph that was queued (enables retry of failed jobs)
  progress_json TEXT,             -- {pct, eta_ms, node_id, node_label, node_index, node_total, step, max}
  error_json TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);

CREATE TABLE outputs (
  id TEXT PRIMARY KEY,            -- <jobid>-<n>
  job_id TEXT,                    -- no FK; index is rebuildable from sidecars
  path TEXT NOT NULL UNIQUE,      -- relative to <appdata>
  sidecar_path TEXT NOT NULL,
  kind TEXT NOT NULL,             -- image|video
  width INTEGER, height INTEGER, duration_ms INTEGER,
  sha256 TEXT,
  workflow_id TEXT, workflow_hash TEXT, family TEXT,
  prompt TEXT,                    -- denormalised for search
  params_json TEXT NOT NULL,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX outputs_created ON outputs(created_at DESC, id DESC);
CREATE INDEX outputs_workflow ON outputs(workflow_id, created_at DESC);
CREATE VIRTUAL TABLE outputs_fts USING fts5(prompt, content='outputs', content_rowid='rowid');

CREATE TABLE models (
  hash TEXT PRIMARY KEY,          -- sha256 of file
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,             -- checkpoint|lora|vae|controlnet|…
  size INTEGER NOT NULL, mtime INTEGER NOT NULL,
  display_name TEXT,              -- editable; NULL → basename(path) minus extension
  family TEXT,                    -- user- or civitai-derived
  civitai_json TEXT, notes TEXT, tags_json TEXT,
  strength_min REAL, strength_max REAL,  -- what a LoRA's sliders span; NULL → the -2..2 default (§8.1)
  thumb_path TEXT,                -- chosen sample's media, or NULL → most recent output → empty plate
  output_count INTEGER NOT NULL DEFAULT 0,  -- derived from output_models; maintained on insert/delete and by reindex
  last_used_at INTEGER,           -- derived: max(outputs.created_at) over output_models; same maintenance
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE model_probes (      -- derived: what a file's header says it is
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL, mtime INTEGER NOT NULL,  -- re-probe when either moves
  arch TEXT,                      -- a FAMILIES entry, or NULL when unrecognised
  probed_at INTEGER NOT NULL
);

CREATE TABLE output_models (      -- discoverability: what used what
  output_id TEXT NOT NULL, model_hash TEXT NOT NULL, role TEXT NOT NULL,
  PRIMARY KEY (output_id, model_hash, role)
);
CREATE INDEX output_models_model ON output_models(model_hash);

CREATE TABLE inputs (
  sha256 TEXT PRIMARY KEY,
  path TEXT NOT NULL, ext TEXT NOT NULL,
  kind TEXT NOT NULL,             -- image|mask|video
  width INTEGER, height INTEGER,
  original_name TEXT, derived_from_output TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE output_inputs (
  output_id TEXT NOT NULL, input_sha256 TEXT NOT NULL, param_key TEXT NOT NULL,
  PRIMARY KEY (output_id, input_sha256, param_key)
);

CREATE TABLE samples (
  id TEXT PRIMARY KEY,
  model_hash TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE, sidecar_path TEXT NOT NULL,
  kind TEXT NOT NULL, source_url TEXT,
  params_json TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX samples_model ON samples(model_hash);

CREATE TABLE node_timings (       -- for progress estimation
  workflow_hash TEXT NOT NULL, node_id TEXT NOT NULL,
  ewma_ms REAL NOT NULL, samples INTEGER NOT NULL,
  PRIMARY KEY (workflow_hash, node_id)
);
