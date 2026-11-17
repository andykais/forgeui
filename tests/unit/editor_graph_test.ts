import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { editorToApi } from "../../src/workflows/editor_graph.ts";
import {
  expectedInputs,
  type ObjectInfo,
} from "../../src/workflows/node_spec.ts";
import { GOLDEN_ROOT } from "../golden/runner.ts";

/**
 * editorToApi against what ComfyUI's own editor queued for the same document
 * (tests/golden/editor_graph/_case.md). Compared as ComfyUI would run it.
 */

const ROOT = join(GOLDEN_ROOT, "editor_graph");
const INFO = JSON.parse(
  await Deno.readTextFile(join(ROOT, "object_info.json")),
) as ObjectInfo;

type Graph = Record<
  string,
  { class_type: string; inputs: Record<string, unknown> }
>;

/** What ComfyUI runs: the nodes an output node needs. */
function needed(graph: Graph): Graph {
  const keep = new Set<string>();
  const stack = Object.keys(graph).filter((id) =>
    INFO[graph[id]!.class_type]?.output_node
  );
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (keep.has(id) || !graph[id]) continue;
    keep.add(id);
    for (const value of Object.values(graph[id]!.inputs)) {
      if (Array.isArray(value) && typeof value[0] === "string") {
        stack.push(value[0]);
      }
    }
  }
  return Object.fromEntries([...keep].map((id) => [id, graph[id]!]));
}

/**
 * One line per node, ids replaced by what they point at: the same graph
 * under other ids reads the same. Inputs the node does not declare are left
 * out, as ComfyUI leaves them out.
 */
function signature(graph: Graph): string[] {
  return Object.values(graph).map((node) => {
    const declared = expectedInputs(INFO[node.class_type] ?? {}, node.inputs);
    const parts = Object.entries(node.inputs)
      .filter(([name]) => declared.has(name) || name.includes("."))
      .map(([name, value]) =>
        Array.isArray(value)
          ? `${name}<-${graph[value[0] as string]?.class_type}.${value[1]}`
          : `${name}=${
            JSON.stringify(
              typeof value === "number" ? Number(value.toPrecision(12)) : value,
            )
          }`
      )
      .sort();
    return `${node.class_type}{${parts.join(",")}}`;
  }).sort();
}

for await (const entry of Deno.readDir(ROOT)) {
  if (!entry.isDirectory) continue;
  Deno.test(`editor graph: ${entry.name} queues as ComfyUI's editor queues it`, async () => {
    const doc = JSON.parse(
      await Deno.readTextFile(join(ROOT, entry.name, "editor.json")),
    );
    const want = JSON.parse(
      await Deno.readTextFile(join(ROOT, entry.name, "comfy_api.json")),
    ) as Graph;
    const { graph, errors } = editorToApi(doc, INFO);
    assertEquals(errors, []);
    assertEquals(signature(needed(graph as Graph)), signature(needed(want)));
  });
}

Deno.test("editor graph: subgraph nodes are named <instance>:<node>", async () => {
  const doc = JSON.parse(
    await Deno.readTextFile(
      join(ROOT, "subgraph-proxy-widgets", "editor.json"),
    ),
  );
  const { graph } = editorToApi(doc, INFO);
  assert("238:227" in graph, Object.keys(graph).join(" "));
  assertEquals(graph["60"]!.inputs["images"], [
    "238:231",
    0,
  ]);
});

Deno.test("editor graph: a node type this ComfyUI lacks is named, and so is a non-document", () => {
  const { errors } = editorToApi({
    nodes: [{ id: 1, type: "AILab_QwenVL", mode: 0, inputs: [], outputs: [] }],
    links: [],
  }, INFO);
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0]!, '"AILab_QwenVL" is not in this ComfyUI');
  assertStringIncludes(
    editorToApi({ "1": { class_type: "KSampler", inputs: {} } }, INFO)
      .errors[0]!,
    "goes in api_json instead",
  );
});
