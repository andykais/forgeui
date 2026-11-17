import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { exists } from "@std/fs";
import { join } from "@std/path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { type TestApp, withTestApp } from "../fixtures/app.ts";
import { ForgeUi } from "../../src/mcp/forgeui.ts";
import { createBridgeServer } from "../../src/mcp/tools.ts";
import { NODE_PACKS } from "../../src/workflows/nodes.ts";

/**
 * Workflows an agent writes (DESIGN.md §4.9): made through the bridge,
 * listed and run like any other, and changeable through the bridge only
 * when an agent made them — refused by the bridge, and again by the server
 * when a write says it is made on an agent's behalf.
 */

interface ToolResult {
  isError?: boolean;
  text: string;
}

async function call(
  app: TestApp,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const forge = new ForgeUi({ url: app.url });
  const handler = createMcpHandler(() =>
    createBridgeServer({
      forge,
      llm: null,
      freeVram: false,
      progress: false,
      defaultTimeoutMs: 30_000,
    })
  );
  try {
    const response = await handler.fetch(
      new Request("http://bridge/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
    );
    const body = await response.text();
    const data = body.split("\n").find((line) => line.startsWith("data:"));
    assert(data, `no JSON-RPC response in: ${body}`);
    const message = JSON.parse(data.slice("data:".length)) as {
      result?: { isError?: boolean; content: { text?: string }[] };
      error?: { message: string };
    };
    assert(!message.error, `${name} failed: ${message.error?.message}`);
    return {
      isError: message.result!.isError,
      text: message.result!.content[0]!.text!,
    };
  } finally {
    await handler.close();
  }
}

async function ok<T>(
  app: TestApp,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await call(app, name, args);
  assert(!result.isError, `${name} answered an error: ${result.text}`);
  return JSON.parse(result.text) as T;
}

async function refused(
  app: TestApp,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await call(app, name, args);
  assert(result.isError, `${name} should have failed, got: ${result.text}`);
  return result.text;
}

interface Saved {
  id: string;
  name: string;
  runnable: boolean;
  not_runnable_because?: string;
  made_by: string | null;
  params: { key: string; advanced?: boolean; max?: number }[];
  graph_checked_against_comfyui: boolean;
  warnings?: string[];
  notes?: string[];
}

interface Listed {
  id: string;
  source: string;
  runnable: boolean;
  agent: { source: string; created_at: number } | null;
}

async function listed(app: TestApp): Promise<Listed[]> {
  const response = await app.fetch("/api/workflows");
  return (await response.json() as { workflows: Listed[] }).workflows;
}

/** A complete SD 1.5 graph, written out as an agent would write it. */
function sd15Graph(): Record<string, unknown> {
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "v1-5-pruned-emaonly-fp16.safetensors" },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: "", clip: ["1", 1] },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: "blurry", clip: ["1", 1] },
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width: 512, height: 512, batch_size: 1 },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed: 0,
        steps: 8,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    "7": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "forge", images: ["6", 0] },
    },
  };
}

const SD15_PARAMS = [
  { key: "prompt", type: "text", required: true, bind: "2.text" },
  { key: "seed", type: "seed", bind: "5.seed" },
  { key: "steps", type: "int", min: 1, max: 30, bind: "5.steps" },
];

Deno.test("an agent's workflow lists, describes and runs like any other", async () => {
  await withTestApp(async (app) => {
    const saved = await ok<Saved>(app, "create_workflow", {
      name: "SD 1.5 (8 steps)",
      id: "sd15-fast",
      family: "sd15",
      api_json: sd15Graph(),
      params: SD15_PARAMS,
      outputs: [{ node: "7", kind: "image" }],
    });
    assertEquals(saved.id, "sd15-fast");
    assert(saved.runnable, saved.not_runnable_because);
    assertEquals(saved.made_by, "llm:unknown");
    assert(saved.graph_checked_against_comfyui);
    assertEquals(saved.params.map((param) => param.key), [
      "prompt",
      "seed",
      "steps",
    ]);

    // The Workflows screen and the picker see it, marked as an agent's.
    const row = (await listed(app)).find((w) => w.id === "sd15-fast");
    assert(row, "the new workflow is listed");
    assertEquals(row.source, "user");
    assert(row.runnable);
    assertEquals(row.agent?.source, "llm:unknown");

    const described = await ok<{ editable: boolean; params: unknown[] }>(
      app,
      "describe_workflow",
      { workflow_id: "sd15-fast" },
    );
    assertEquals(described.editable, true);

    // And it runs through the same round as a bundled one.
    const round = await ok<{
      counts: { done: number };
      jobs: { error?: string }[];
    }>(app, "generate", {
      jobs: [{
        workflow_id: "sd15-fast",
        params: { prompt: "a lighthouse", steps: 6 },
      }],
    });
    assertEquals(round.counts.done, 1, round.jobs[0]?.error);
  }, { comfy: true });
});

Deno.test("from_workflow copies a workflow, and the copy is the agent's", async () => {
  await withTestApp(async (app) => {
    const saved = await ok<Saved>(app, "create_workflow", {
      name: "SD 1.5, steps up front",
      from_workflow: "sd15",
    });
    assertEquals(saved.id, "sd-1-5-steps-up-front");
    assert(saved.runnable, saved.not_runnable_because);
    assertEquals(
      saved.params.map((param) => param.key),
      ["prompt", "negative", "size", "seed", "loras", "steps", "cfg"],
    );

    // The original is untouched: still bundled, no user copy, no record.
    const sd15 = (await listed(app)).find((w) => w.id === "sd15")!;
    assertEquals(sd15.source, "bundled");
    assertEquals(sd15.agent, null);
  }, { comfy: true });
});

Deno.test("every bundled workflow can be the start of one", async () => {
  // The node check must not refuse a graph that ships with the app: a copy
  // of any of them is the obvious first move for an agent.
  await withTestApp(async (app) => {
    const bundled = (await listed(app)).filter((w) => w.source === "bundled");
    assert(bundled.length > 20);
    for (const workflow of bundled) {
      const saved = await ok<Saved>(app, "create_workflow", {
        name: `${workflow.id} copy`,
        from_workflow: workflow.id,
      });
      assertEquals(saved.runnable, workflow.runnable, workflow.id);
      assertEquals(saved.warnings, undefined, workflow.id);
    }
  }, { comfy: { packs: Object.keys(NODE_PACKS) } });
});

Deno.test("a graph ComfyUI would refuse is refused before anything is saved, every problem at once", async () => {
  await withTestApp(async (app) => {
    const graph = sd15Graph();
    (graph["5"] as { class_type: string }).class_type = "KSampler2";
    (graph["6"] as { inputs: Record<string, unknown> }).inputs.vae = ["1", 7];
    (graph["2"] as { inputs: Record<string, unknown> }).inputs.clip = [1, 1];

    // The shape problem stops it first, on its own.
    let message = await refused(app, "create_workflow", {
      name: "broken",
      api_json: graph,
      params: SD15_PARAMS,
      outputs: [{ node: "7", kind: "image" }],
    });
    assertStringIncludes(message, "Nothing was saved");
    assertStringIncludes(message, 'node "2" (CLIPTextEncode).clip');
    assertStringIncludes(message, '["1", 1], not [1, 1]');

    // Then everything ComfyUI's node list says, in one answer.
    (graph["2"] as { inputs: Record<string, unknown> }).inputs.clip = ["1", 1];
    message = await refused(app, "create_workflow", {
      name: "broken",
      api_json: graph,
      params: SD15_PARAMS,
      outputs: [{ node: "7", kind: "image" }],
    });
    assertStringIncludes(message, "2 problems");
    assertStringIncludes(
      message,
      'node "5" (KSampler2): this ComfyUI has no node type "KSampler2" — ' +
        'did you mean "KSampler"?',
    );
    assertStringIncludes(
      message,
      'node "6" (VAEDecode).vae: links to output 7',
    );
    assertStringIncludes(message, "0: MODEL, 1: CLIP, 2: VAE");

    assert(!(await listed(app)).some((w) => w.id === "broken"));
  }, { comfy: true });
});

Deno.test("a bind the graph does not have is ForgeUI's refusal, and names the param", async () => {
  await withTestApp(async (app) => {
    const message = await refused(app, "create_workflow", {
      name: "Bad bind",
      api_json: sd15Graph(),
      params: [{ key: "prompt", type: "text", bind: "9.text" }],
      outputs: [{ node: "7", kind: "image" }],
    });
    assertStringIncludes(
      message,
      "ForgeUI refused the params/outputs (the manifest)",
    );
    assertStringIncludes(message, "manifest.params[0] (prompt).bind");
    assertStringIncludes(message, 'no node "9"');
    assert(!(await listed(app)).some((w) => w.id === "bad-bind"));
    assert(
      !(await exists(join(app.paths.userWorkflows, "bad-bind"))),
      "a refused create leaves no directory behind",
    );
  }, { comfy: true });
});

Deno.test("an agent's workflow can be changed by the agent; a field the manifest lacks is reported", async () => {
  await withTestApp(async (app) => {
    await ok<Saved>(app, "create_workflow", {
      name: "Mine",
      api_json: sd15Graph(),
      params: SD15_PARAMS,
    });
    const draft = await ok<Saved>(app, "get_workflow_source", {
      workflow_id: "mine",
    });
    assertEquals((draft as unknown as { editable: boolean }).editable, true);

    const updated = await ok<Saved>(app, "update_workflow", {
      workflow_id: "mine",
      outputs: [{ node: "7", kind: "image" }],
      params: [
        ...SD15_PARAMS.slice(0, 2),
        { key: "steps", type: "int", maximum: 50, bind: "5.steps" },
      ],
    });
    assert(updated.runnable, updated.not_runnable_because);
    assertEquals(updated.warnings, [
      'param "steps": "maximum" is not a param field, so it was ignored',
    ]);
  }, { comfy: true });
});

Deno.test("a draft says why it cannot run yet", async () => {
  await withTestApp(async (app) => {
    const saved = await ok<Saved>(app, "create_workflow", {
      name: "No outputs",
      api_json: sd15Graph(),
      params: SD15_PARAMS,
    });
    assertEquals(saved.runnable, false);
    assertStringIncludes(
      saved.not_runnable_because!,
      "manifest.outputs is empty",
    );
  }, { comfy: true });
});

Deno.test("the bridge refuses to change a workflow no agent made, and says what to do", async () => {
  await withTestApp(async (app) => {
    const message = await refused(app, "update_workflow", {
      workflow_id: "sd15",
      description: "mine now",
    });
    assertStringIncludes(message, '"sd15" was not made by an agent');
    assertStringIncludes(message, "came with ForgeUI");
    assertStringIncludes(message, 'from_workflow "sd15"');
    assert(!(await exists(join(app.paths.userWorkflows, "sd15"))));

    // A person's own workflow is just as off limits.
    const created = await app.fetch("/api/workflows", {
      method: "POST",
      body: JSON.stringify({ name: "Hand made" }),
    });
    assertEquals(created.status, 201);
    const theirs = await refused(app, "update_workflow", {
      workflow_id: "hand-made",
      description: "mine now",
    });
    assertStringIncludes(theirs, "a person made or edited");
  }, { comfy: true });
});

Deno.test("the server refuses an agent's write to a workflow no agent made, whatever sent it", async () => {
  await withTestApp(async (app) => {
    // The second line of the rule (§4.9): not the bridge, the server.
    const response = await app.fetch("/api/workflows/sd15", {
      method: "PUT",
      body: JSON.stringify({
        agent: "llm:somebody",
        manifest: {
          id: "sd15",
          name: "Taken",
          kind: "image",
          params: [],
          outputs: [],
        },
      }),
    });
    assertEquals(response.status, 403);
    const body = await response.json() as {
      error: { code: string; message: string };
    };
    assertEquals(body.error.code, "forbidden");
    assertStringIncludes(body.error.message, "not made by an agent");
    assert(
      !(await exists(join(app.paths.userWorkflows, "sd15"))),
      "a refused write makes no user copy",
    );

    // A person's write is unaffected, and may edit an agent's workflow too.
    await app.fetch("/api/workflows", {
      method: "POST",
      body: JSON.stringify({ name: "Agent's", agent: "llm:qwen" }),
    });
    const human = await app.fetch("/api/workflows/agent-s", {
      method: "PUT",
      body: JSON.stringify({
        manifest: {
          id: "agent-s",
          name: "Renamed",
          kind: "image",
          params: [],
          outputs: [],
        },
      }),
    });
    assertEquals(human.status, 200, await human.clone().text());
    // …and that does not take it away from the agent.
    const row = (await listed(app)).find((w) => w.id === "agent-s")!;
    assertEquals(row.agent?.source, "llm:qwen");

    // An agent naming an id that is taken is told, not renamed.
    const taken = await app.fetch("/api/workflows", {
      method: "POST",
      body: JSON.stringify({ id: "sd15", name: "x", agent: "llm:qwen" }),
    });
    assertEquals(taken.status, 409);
    await taken.body?.cancel();
  });
});

Deno.test("agent.json is the record, a copy is not the agent's, and a damaged record fails closed", async () => {
  await withTestApp(async (app) => {
    await app.fetch("/api/workflows", {
      method: "POST",
      body: JSON.stringify({ name: "Made", agent: "llm:qwen" }),
    });
    const record = JSON.parse(
      await Deno.readTextFile(
        join(app.paths.userWorkflows, "made", "agent.json"),
      ),
    );
    assertEquals(record.source, "llm:qwen");
    assertEquals(typeof record.created_at, "number");

    const copy = await app.fetch("/api/workflows/made/duplicate", {
      method: "POST",
    });
    assertEquals(copy.status, 201);
    assertEquals((await copy.json() as Listed).agent, null);

    await Deno.writeTextFile(
      join(app.paths.userWorkflows, "made", "agent.json"),
      "{not json",
    );
    await app.workflows.reload();
    const damaged = (await listed(app)).find((w) => w.id === "made")!;
    assertEquals(damaged.agent, null);
  });
});

Deno.test("with no ComfyUI the graph is still saved, and the answer says it went unchecked", async () => {
  await withTestApp(async (app) => {
    const saved = await ok<Saved>(app, "create_workflow", {
      name: "Offline",
      api_json: sd15Graph(),
      params: SD15_PARAMS,
      outputs: [{ node: "7", kind: "image" }],
    });
    assertEquals(saved.graph_checked_against_comfyui, false);
    assertStringIncludes(saved.notes![0]!, "ComfyUI could not be reached");
  });
});

Deno.test("a graph ComfyUI refuses at run time says which node and why, and get_workflow_source shows it beforehand", async () => {
  await withTestApp(async (app) => {
    await ok<Saved>(app, "create_workflow", {
      name: "Drifts",
      api_json: sd15Graph(),
      params: SD15_PARAMS,
      outputs: [{ node: "7", kind: "image" }],
    });
    // Something changes after it was made — here a person's save, past the
    // bridge's check — so the graph no longer validates in ComfyUI.
    const graph = sd15Graph();
    (graph["5"] as { class_type: string }).class_type = "KSamplerTurbo";
    const saved = await app.fetch("/api/workflows/drifts", {
      method: "PUT",
      body: JSON.stringify({ api_json: graph }),
    });
    assertEquals(saved.status, 200, await saved.clone().text());

    const source = await ok<{
      comfyui_check: { errors: string[]; warnings: string[] };
    }>(app, "get_workflow_source", { workflow_id: "drifts" });
    assertEquals(source.comfyui_check.errors.length, 1);
    assertStringIncludes(
      source.comfyui_check.errors[0]!,
      'no node type "KSamplerTurbo" — did you mean "KSampler"',
    );

    const message = await refused(app, "generate", {
      jobs: [{ workflow_id: "drifts", params: { prompt: "x" } }],
    });
    assertStringIncludes(message, "502");
    assertStringIncludes(message, '- node "5" (KSamplerTurbo):');
  }, { comfy: true });
});

Deno.test("search_comfy_nodes and describe_comfy_nodes read the ComfyUI behind ForgeUI", async () => {
  await withTestApp(async (app) => {
    // No filter: the map, not 900 lines.
    const map = await ok<{
      total: number;
      categories: unknown[];
      nodes?: unknown;
      next: string;
    }>(app, "search_comfy_nodes", {});
    assert(map.total > 20);
    assertEquals(map.nodes, undefined);
    assertStringIncludes(map.next, "narrow");

    const found = await ok<{ nodes: { name: string; outputs: string }[] }>(
      app,
      "search_comfy_nodes",
      { query: "ksampler" },
    );
    assert(found.nodes.some((n) => n.name === "KSampler"));

    const described = await ok<{
      nodes: ({ name: string; example?: unknown; error?: string })[];
    }>(app, "describe_comfy_nodes", {
      node_types: ["KSampler", "KSamplr"],
    });
    assertEquals(described.nodes[0]!.name, "KSampler");
    assert(described.nodes[0]!.example);
    assertStringIncludes(described.nodes[1]!.error!, 'did you mean "KSampler"');

    const raw = await ok<{ nodes: { name: string; raw?: unknown }[] }>(
      app,
      "describe_comfy_nodes",
      { node_types: ["KSampler"], raw: true },
    );
    assert(raw.nodes[0]!.raw, "raw: true hands back the node's own entry");
    assertStringIncludes(
      JSON.stringify(found),
      "describe_comfy_nodes",
    );
  }, { comfy: true });
});

Deno.test("with no ComfyUI the node tools say so rather than answer empty", async () => {
  await withTestApp(async (app) => {
    const message = await refused(app, "search_comfy_nodes", { query: "x" });
    assertStringIncludes(message, "ComfyUI could not be reached");
  });
});

Deno.test("delete_workflow: an agent deletes what it made, and nothing else", async () => {
  await withTestApp(async (app) => {
    await ok<Saved>(app, "create_workflow", {
      name: "Draft",
      api_json: sd15Graph(),
      params: SD15_PARAMS,
    });
    assertEquals(
      await ok<{ deleted: string }>(app, "delete_workflow", {
        workflow_id: "draft",
      }),
      { deleted: "draft" },
    );
    assert(!(await listed(app)).some((w) => w.id === "draft"));

    const bundled = await refused(app, "delete_workflow", {
      workflow_id: "sd15",
    });
    assertStringIncludes(bundled, "Nothing was deleted");
    assertStringIncludes(bundled, "came with ForgeUI");

    await app.fetch("/api/workflows", {
      method: "POST",
      body: JSON.stringify({ name: "Theirs" }),
    });
    assertStringIncludes(
      await refused(app, "delete_workflow", { workflow_id: "theirs" }),
      "you can only delete workflows you made",
    );

    // The server's half: DELETE on an agent's behalf is held to the record.
    const forbidden = await app.fetch("/api/workflows/theirs", {
      method: "DELETE",
      body: JSON.stringify({ agent: "llm:qwen" }),
    });
    assertEquals(forbidden.status, 403);
    await forbidden.body?.cancel();
    assert((await listed(app)).some((w) => w.id === "theirs"));

    // A person may delete an agent's workflow.
    await app.fetch("/api/workflows", {
      method: "POST",
      body: JSON.stringify({ name: "Agent made", agent: "llm:qwen" }),
    });
    const human = await app.fetch("/api/workflows/agent-made", {
      method: "DELETE",
    });
    assertEquals(human.status, 204);
  }, { comfy: true });
});

Deno.test("list_node_packs: what is installed, and which workflows wait on a missing pack", async () => {
  // No packs: the Breeze workflows name one they cannot have.
  await withTestApp(async (app) => {
    const packs = await ok<{
      installed: unknown[];
      known: {
        id: string;
        installed: boolean;
        missing_nodes?: string[];
        workflows_needing_it?: string[];
      }[];
    }>(app, "list_node_packs", {});
    assertEquals(packs.installed, []);
    const breeze = packs.known.find((p) => p.id === "ComfyUI-Breeze-TTS-2")!;
    assertEquals(breeze.installed, false);
    assert(breeze.missing_nodes!.includes("BreezeTTS2LoadModel"));
    assertEquals(breeze.workflows_needing_it!.sort(), [
      "breeze-tts-clone",
      "breeze-tts-design",
    ]);
  }, { comfy: true });

  // With it installed: listed, and searchable by source.
  await withTestApp(async (app) => {
    const packs = await ok<{
      installed: { pack: string; node_count: number }[];
      known: { id: string; installed: boolean }[];
    }>(app, "list_node_packs", {});
    assertEquals(packs.installed.map((p) => p.pack), ["ComfyUI-Breeze-TTS-2"]);
    assert(packs.known[0]!.installed);
    const found = await ok<{ nodes: { name: string; source: string }[] }>(
      app,
      "search_comfy_nodes",
      { source: "ComfyUI-Breeze-TTS-2" },
    );
    assert(found.nodes.length > 0);
    assert(
      found.nodes.every((n) => n.source === "custom: ComfyUI-Breeze-TTS-2"),
    );
  }, { comfy: { packs: ["ComfyUI-Breeze-TTS-2"] } });
});

Deno.test("search_comfy_templates lists ComfyUI's templates, paid ones only on request", async () => {
  await withTestApp(async (app) => {
    const free = await ok<{
      templates: { name: string; makes: string; model_download_gb?: number }[];
      left_out?: { paid_api: number };
    }>(app, "search_comfy_templates", { query: "text to image" });
    assertEquals(free.templates.map((t) => t.name), ["fake_sd15_t2i"]);
    assertEquals(free.templates[0]!.makes, "image");
    assertEquals(free.templates[0]!.model_download_gb, 2);
    assertEquals(free.left_out, { paid_api: 1 });
    const all = await ok<{ templates: { name: string; paid_api?: true }[] }>(
      app,
      "search_comfy_templates",
      { include_api: true },
    );
    assertEquals(
      all.templates.find((t) => t.paid_api)?.name,
      "api_fake_paid_t2i",
    );
  }, { comfy: true });
});

Deno.test("create_workflow from a ComfyUI template: converted, its save node the output, runnable as it came", async () => {
  await withTestApp(async (app) => {
    const saved = await ok<
      Saved & { outputs: { node: string; kind: string }[] }
    >(
      app,
      "create_workflow",
      { name: "From template", from_comfy_template: "fake_sd15_t2i" },
    );
    assert(saved.runnable, saved.not_runnable_because);
    assertEquals(saved.outputs, [{ node: "9", kind: "image" }]);
    assertEquals(saved.params, []);

    // The template was the bundled sd15 graph, saved as an editor document
    // by litegraph.ts: converting it back gives the same graph.
    const source = await ok<
      { api_json: Record<string, { class_type: string; inputs: unknown }> }
    >(
      app,
      "get_workflow_source",
      { workflow_id: "from-template" },
    );
    const bundled = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../workflows/bundled/sd15/workflow.api.json",
          import.meta.url,
        ),
      ),
    ) as Record<string, { class_type: string; inputs: unknown }>;
    const strip = (g: typeof bundled) =>
      Object.fromEntries(
        Object.entries(g).map((
          [id, n],
        ) => [id, { class_type: n.class_type, inputs: n.inputs }]),
      );
    assertEquals(strip(source.api_json), strip(bundled));
    // The editor keeps the document it came as, layout and all.
    const row = (await listed(app)).find((w) => w.id === "from-template") as
      & Listed
      & { has_ui_json?: boolean };
    assertEquals(row.has_ui_json, true);

    const round = await ok<
      { counts: { done: number }; jobs: { error?: string }[] }
    >(
      app,
      "generate",
      { jobs: [{ workflow_id: "from-template" }] },
    );
    assertEquals(round.counts.done, 1, round.jobs[0]?.error);
  }, { comfy: true });
});

Deno.test("create_workflow from editor_json, and the ways a start is refused", async () => {
  await withTestApp(async (app) => {
    const doc =
      await (await fetch(`${app.fake!.url}/templates/fake_sd15_t2i.json`))
        .json();
    const saved = await ok<Saved>(app, "create_workflow", {
      name: "Pasted",
      editor_json: doc,
    });
    assert(saved.runnable, saved.not_runnable_because);

    assertStringIncludes(
      await refused(app, "create_workflow", {
        name: "Two starts",
        editor_json: doc,
        from_workflow: "sd15",
      }),
      "give one starting point",
    );
    assertStringIncludes(
      await refused(app, "create_workflow", {
        name: "Not a document",
        editor_json: { "1": { class_type: "KSampler", inputs: {} } },
      }),
      "not a ComfyUI editor document",
    );
    assertStringIncludes(
      await refused(app, "create_workflow", {
        name: "Missing pack",
        editor_json: {
          nodes: [{
            id: 1,
            type: "SomePackNode",
            mode: 0,
            inputs: [],
            outputs: [],
          }],
          links: [],
        },
      }),
      '"SomePackNode" is not in this ComfyUI',
    );
    assertStringIncludes(
      await refused(app, "create_workflow", {
        name: "No such",
        from_comfy_template: "no_such_template",
      }),
      'ComfyUI has no template "no_such_template"',
    );
  }, { comfy: true });
});
