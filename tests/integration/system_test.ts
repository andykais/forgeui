import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { startTestApp, withTestApp } from "../fixtures/app.ts";
import { TestSocket } from "../fake-comfy/client.ts";
import type { ComfyStatus } from "../../src/comfy/manager.ts";

interface StatusResponse {
  comfy: ComfyStatus;
  data_dir: string;
}

Deno.test("GET /api/system/status reports the connection and the device", async () => {
  await withTestApp(async (app) => {
    const status = await app.json<StatusResponse>("/api/system/status");
    assertEquals(status.comfy.state, "running");
    assertEquals(status.comfy.mode, "local_url");
    assertEquals(status.comfy.url, app.fake!.url);
    assertEquals(status.comfy.error, null);
    // Straight from ComfyUI's /system_stats (§12).
    assertEquals(status.comfy.device, "cuda:0 FakeGPU");
    assert((status.comfy.vram_free ?? 0) > 0);
    assertStringIncludes(status.comfy.comfyui_version ?? "", "fake");
    // The app does not own this process, so there is no pid or log.
    assertEquals(status.comfy.pid, null);
    assertEquals(status.data_dir, app.paths.root);
  }, { comfy: true });
});

Deno.test("without ComfyUI the app still serves, and says it is not connected", async () => {
  await withTestApp(async (app) => {
    const status = await app.json<StatusResponse>("/api/system/status");
    // Nothing was started, so it never left the starting state (§11.3).
    assertEquals(status.comfy.state, "starting");
    assertEquals((await app.fetch("/api/workflows")).status, 200);
  });
});

Deno.test("restart and the log are managed-mode only", async () => {
  await withTestApp(async (app) => {
    const restart = await app.fetch("/api/system/comfy/restart", {
      method: "POST",
    });
    assertEquals(restart.status, 409);
    assertStringIncludes(
      (await restart.json() as { error: { message: string } }).error.message,
      "does not own this ComfyUI",
    );

    const log = await app.json<{ available: boolean; lines: string[] }>(
      "/api/system/comfy/log",
    );
    assertEquals(log.available, false);
    assertEquals(log.lines, []);
  }, { comfy: true });
});

Deno.test("/comfy/* proxies ComfyUI so the editor is same-origin (§4.1)", async () => {
  await withTestApp(async (app) => {
    const stats = await app.fetch("/comfy/system_stats");
    assertEquals(stats.status, 200);
    const body = await stats.json() as { devices: { name: string }[] };
    assertEquals(body.devices[0]?.name, "cuda:0 FakeGPU");

    const page = await app.fetch("/comfy/");
    assertEquals(page.status, 200);
    assertStringIncludes(await page.text(), "fake ComfyUI");

    // Query strings and status codes pass straight through.
    const missing = await app.fetch("/comfy/view?filename=nope.png");
    assertEquals(missing.status, 404);
    await missing.body?.cancel();

    // …and so does the websocket the editor keeps open.
    const socket = await TestSocket.connect(
      `${app.url.replace("http", "ws")}/comfy/ws?clientId=proxy-test`,
    );
    try {
      const status = await socket.waitFor("status");
      assert(status.kind === "json");
      assertEquals(status.data.sid, "proxy-test");
      assertEquals(app.fake!.socketCount >= 1, true);
    } finally {
      socket.close();
    }
  }, { comfy: true });
});

/**
 * The managed path (§2) with a stub interpreter in place of python: the app
 * spawns a real child process, passes it the three directory flags, captures
 * its log and can restart it.
 */
async function withManagedApp(
  body: (app: Awaited<ReturnType<typeof startTestApp>>) => Promise<void>,
): Promise<void> {
  const dataDir = await Deno.makeTempDir({ prefix: "forgeui-managed-" });
  const installDir = join(dataDir, "ComfyUI");
  await Deno.mkdir(installDir, { recursive: true });
  await Deno.writeTextFile(join(installDir, "main.py"), "# a stand-in\n");

  // The stub drops the "main.py" argument and runs the fake with the rest.
  const fakeMain = fromFileUrl(
    new URL("../fake-comfy/main.ts", import.meta.url),
  );
  const stub = join(dataDir, "python-stub.sh");
  await Deno.writeTextFile(
    stub,
    `#!/usr/bin/env bash\nshift\nexec ${Deno.execPath()} run --quiet ` +
      `--allow-net --allow-read --allow-write --allow-env ${fakeMain} "$@"\n`,
  );
  await Deno.chmod(stub, 0o755);

  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();

  const app = await startTestApp({
    dataDir,
    argv: ["--comfy-mode", "managed"],
    files: {
      "config.yaml": [
        "comfy:",
        "  mode: managed",
        `  path: ${installDir}`,
        `  url: http://127.0.0.1:${port}`,
        `  python: ${stub}`,
        "",
      ].join("\n"),
    },
  });
  try {
    await app.comfy.waitForState("running", 30_000);
    await body(app);
  } finally {
    await app.dispose();
  }
}

Deno.test("managed mode spawns ComfyUI with the flags of §2", async () => {
  await withManagedApp(async (app) => {
    const status = await app.json<StatusResponse>("/api/system/status");
    assertEquals(status.comfy.state, "running");
    assertEquals(status.comfy.mode, "managed");
    assert((status.comfy.pid ?? 0) > 0, "the child's pid is reported");
    assert((status.comfy.uptime_ms ?? -1) >= 0);
    // Settings shows these read-only, and they are what was really passed.
    assert(
      status.comfy.launch_flags.some((flag) =>
        flag === `--output-directory ${app.paths.staging}`
      ),
      status.comfy.launch_flags.join(" "),
    );

    const log = await app.json<{ available: boolean; lines: string[] }>(
      "/api/system/comfy/log",
    );
    assertEquals(log.available, true);
    const text = log.lines.join("\n");
    assertStringIncludes(text, `output directory: ${app.paths.staging}`);
    assertStringIncludes(text, `input directory: ${app.paths.comfyInput}`);
    assertStringIncludes(
      text,
      `extra model paths: ${app.paths.extraModelPaths}`,
    );
    assertStringIncludes(text, "To see the GUI go to:");
  });
});

Deno.test("a job runs end to end through the managed child process", async () => {
  await withManagedApp(async (app) => {
    const submitted = await app.json<{ id: string }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: "krea2",
        params: { prompt: "a granite bowl of figs" },
      }),
    });

    const deadline = Date.now() + 10_000;
    let status = "queued";
    while (!["done", "failed", "cancelled"].includes(status)) {
      if (Date.now() > deadline) throw new Error(`job stuck at ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = (await app.json<{ status: string }>(`/api/jobs/${submitted.id}`))
        .status;
    }
    assertEquals(status, "done");

    const outputs = await app.json<{ jobs: { outputs: string[] }[] }>(
      `/api/jobs?status=done`,
    );
    assertEquals(outputs.jobs[0]?.outputs, [`${submitted.id}-0`]);
  });
});

Deno.test("restarting the managed child gives a new process", async () => {
  await withManagedApp(async (app) => {
    const before = (await app.json<StatusResponse>("/api/system/status")).comfy;
    const restarted = await app.json<{ comfy: ComfyStatus }>(
      "/api/system/comfy/restart",
      { method: "POST" },
    );
    assert(["starting", "running"].includes(restarted.comfy.state));

    await app.comfy.waitForState("running", 30_000);
    const after = (await app.json<StatusResponse>("/api/system/status")).comfy;
    assertEquals(after.state, "running");
    assert(after.pid !== before.pid, "the pid changed");
  });
});
