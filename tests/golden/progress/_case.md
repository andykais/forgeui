# Progress golden cases

One directory per case. `input.json` is

```json
{
  "graph": { "<node id>": { "class_type": "…", "_meta": { "title": "…" } } },
  "weights": { "<node id>": 9800 },
  "events": [
    { "kind": "start" },
    { "kind": "cached", "nodes": ["1"] },
    { "kind": "executing", "node": "3" },
    { "kind": "progress", "node": "3", "value": 2, "max": 4 },
    { "kind": "advance", "ms": 500 },
    { "kind": "finish" }
  ]
}
```

`expected.json` is the `progress_json` snapshot (§7) after each event, so a case
reads as the sequence a client would have seen. `weights` is what `node_timings`
holds for the workflow (§5.1); leave it out for a workflow nobody has run yet.

Update with `UPDATE_GOLDEN=1 deno task test`, never by hand.
