import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withTestApp } from "../fixtures/app.ts";

/**
 * Templates (DESIGN.md §4.8): a saved way to fill one workflow's panel —
 * params set, params asked for, the rest left open. Bundled ones ship with
 * the app; the user's are written beside them and shadow them by id.
 */

interface TemplateView {
  id: string;
  name: string;
  description: string | null;
  workflow: string;
  workflow_name: string | null;
  family: string | null;
  action: string | null;
  values: Record<string, unknown>;
  ask: string[];
  source: "bundled" | "user";
  has_bundled: boolean;
  problems: string[];
}

const FAMILIES = [
  ["anima", "anima"],
  ["flux-klein", "flux2"],
  ["illustrious", "sdxl"],
  ["krea2", "krea2"],
  ["sd15", "sd15"],
  ["z-image", "z-image"],
] as const;

async function list(app: { json: <T>(path: string) => Promise<T> }) {
  return (await app.json<{ templates: TemplateView[] }>("/api/templates"))
    .templates;
}

async function send(
  app: { fetch: (path: string, init?: RequestInit) => Promise<Response> },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await app.fetch(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? JSON.parse(text) : null,
  };
}

Deno.test("every image family ships an Upscale template on its img2img workflow", async () => {
  await withTestApp(async (app) => {
    const templates = await list(app);
    const upscales = templates.filter((t) => t.action === "upscale");
    assertEquals(
      upscales.map((t) => [t.workflow, t.family]).sort(),
      FAMILIES.map(([id, family]) => [`${id}-img2img`, family]).sort(),
    );
    for (const template of upscales) {
      // The numbers the upscale workflows used to carry as defaults (§10),
      // and the picture left to whoever presses the button.
      assertEquals(template.values, { scale: 2, creativity: 0.2 });
      assertEquals(template.ask, ["image"]);
      assertEquals(template.source, "bundled");
      assertEquals(template.problems, [], template.id);
      assert(template.workflow_name?.endsWith("(img2img)"), template.id);
    }
  });
});

Deno.test("a template saved from the panel is checked against its workflow", async () => {
  await withTestApp(async (app) => {
    const created = await send(app, "POST", "/api/templates", {
      name: "Grainy portraits",
      workflow: "sd15",
      values: {
        loras: [{ name: "film-grain.safetensors", strength_model: 0.8 }],
        steps: "30",
        seed: -1,
      },
      ask: ["prompt"],
    });
    assertEquals(created.status, 201, JSON.stringify(created.body));
    const view = created.body as unknown as TemplateView;
    // Its id from its name, and its values as a job would read them (§4.3):
    // a number typed as text is a number; a LoRA row gains its clip
    // strength. -1 stays "random" rather than being rolled now.
    assertEquals(view.id, "grainy-portraits");
    assertEquals(view.values.steps, 30);
    assertEquals(view.values.seed, -1);
    assertEquals(
      (view.values.loras as { strength_clip: number }[])[0]!.strength_clip,
      0.8,
    );
    assertEquals(view.ask, ["prompt"]);
    assertEquals(view.source, "user");
    assertEquals(view.family, "sd15");
    // A user template is a file in templates/user/.
    const file = JSON.parse(
      await Deno.readTextFile(
        join(app.paths.userTemplates, "grainy-portraits.json"),
      ),
    );
    assertEquals(file.workflow, "sd15");

    // A second one with the same name gets its own id.
    const again = await send(app, "POST", "/api/templates", {
      name: "Grainy portraits",
      workflow: "sd15",
    });
    assertEquals(again.body!.id, "grainy-portraits-2");
  });
});

Deno.test("a template that does not fit its workflow is refused", async () => {
  await withTestApp(async (app) => {
    const cases: [unknown, string][] = [
      [{ name: "x", workflow: "nope" }, 'no workflow "nope"'],
      [
        { name: "x", workflow: "sd15", values: { tempo: 3 } },
        'sd15 has no param "tempo"',
      ],
      [
        {
          name: "x",
          workflow: "sd15",
          values: { prompt: "a" },
          ask: ["prompt"],
        },
        "either set or asked for, not both",
      ],
      [{ name: "x", workflow: "sd15", action: "inpaint" }, "one of upscale"],
      [{ workflow: "sd15" }, "name: expected a non-empty string"],
      [
        { name: "x", workflow: "sd15", values: { seed: 1.5 } },
        "seed: expected a whole number",
      ],
    ];
    for (const [body, message] of cases) {
      const response = await send(app, "POST", "/api/templates", body);
      assertEquals(response.status, 400, JSON.stringify(body));
      const error = response.body!.error as { message: string };
      assertStringIncludes(error.message, message, JSON.stringify(body));
    }
    assertEquals(
      (await list(app)).filter((t) => t.source === "user"),
      [],
    );
  });
});

Deno.test("editing a bundled template writes a copy; deleting the copy brings it back", async () => {
  await withTestApp(async (app) => {
    const edited = await send(app, "PUT", "/api/templates/krea2-upscale", {
      name: "Upscale 2× (gentle)",
      values: { scale: 2, creativity: 0.1 },
    });
    assertEquals(edited.status, 200, JSON.stringify(edited.body));
    assertEquals(edited.body!.source, "user");
    assertEquals(edited.body!.has_bundled, true);
    assertEquals(edited.body!.values, { scale: 2, creativity: 0.1 });
    // What the body did not send is kept.
    assertEquals(edited.body!.ask, ["image"]);
    assertEquals(edited.body!.action, "upscale");

    // A template fills one workflow; another is a new template.
    const moved = await send(app, "PUT", "/api/templates/krea2-upscale", {
      workflow: "sd15-img2img",
    });
    assertEquals(moved.status, 400);

    assertEquals(
      (await send(app, "DELETE", "/api/templates/krea2-upscale")).status,
      204,
    );
    const back = await app.json<TemplateView>("/api/templates/krea2-upscale");
    assertEquals(back.source, "bundled");
    assertEquals(back.values, { scale: 2, creativity: 0.2 });

    // The bundled one alone is not the user's to delete.
    const refused = await send(app, "DELETE", "/api/templates/krea2-upscale");
    assertEquals(refused.status, 409);
    assertEquals(
      (await send(app, "GET", "/api/templates/no-such-thing")).status,
      404,
    );
  });
});

Deno.test("a template outlives its workflow, and says what no longer fits", async () => {
  await withTestApp(async (app) => {
    // Written by hand, as a template made before its workflow changed or
    // went would be found on disk.
    await Deno.writeTextFile(
      join(app.paths.userTemplates, "orphan.json"),
      JSON.stringify({
        name: "Orphan",
        workflow: "deleted-workflow",
        values: { scale: 2 },
      }),
    );
    await Deno.writeTextFile(
      join(app.paths.userTemplates, "drifted.json"),
      JSON.stringify({
        name: "Drifted",
        workflow: "sd15",
        values: { tempo: 2 },
      }),
    );
    await Deno.writeTextFile(
      join(app.paths.userTemplates, "broken.json"),
      "{ not json",
    );
    await app.templates.reload();

    const byId = new Map((await list(app)).map((t) => [t.id, t]));
    assertEquals(byId.get("orphan")!.problems, [
      'no workflow "deleted-workflow"',
    ]);
    assertStringIncludes(byId.get("drifted")!.problems[0]!, '"tempo"');
    assertStringIncludes(byId.get("broken")!.problems[0]!, "broken.json");
    // The rest of the list is untouched by them.
    assertEquals(byId.get("sd15-upscale")!.problems, []);
    // And one that lists with a problem can still be deleted.
    assertEquals(
      (await send(app, "DELETE", "/api/templates/broken")).status,
      204,
    );
  });
});
