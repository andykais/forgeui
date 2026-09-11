-- ForgeUI telemetry schema, verbatim from DESIGN.md §7.1. This database is not
-- a derived index: nothing rebuilds it, `reindex` never touches it, and losing
-- the file costs history and nothing else.

CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report TEXT NOT NULL,        -- api_requests|output_size|model_size|vram|telemetry_size
  at INTEGER NOT NULL,         -- epoch ms, when the thing happened
  value REAL NOT NULL,         -- what the graph plots: ms for durations, bytes for sizes
  label TEXT,                  -- the row's name: the path, the output id, the model
  method TEXT,                 -- api_requests
  route TEXT,                  -- api_requests: the route pattern, not the path
  status INTEGER,              -- api_requests
  family TEXT,                 -- output_size, model_size
  model_class TEXT,            -- model_size: diffusion|lora|vae|…
  change TEXT,                 -- model_size: added|deleted
  data_json TEXT NOT NULL      -- the raw entry, verbatim, for the sidebar
);
CREATE INDEX entries_report_at ON entries(report, at DESC, id DESC);

CREATE TABLE model_sizes (     -- what the last model pass saw, so the next one can diff
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  model_class TEXT NOT NULL,
  family TEXT,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL
);
