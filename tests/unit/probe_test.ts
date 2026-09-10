import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  detectFamily,
  headerOf,
  ProbeError,
  probeFamily,
} from "../../src/models/probe.ts";
import { writeFakeSafetensors } from "../fixtures/models.ts";

/**
 * The family probe (§6). Every fixture below is the discriminating tensor
 * name ComfyUI's own `comfy/model_detection.py` keys on, so if ComfyUI would
 * build the model, this agrees about what it is.
 */

function header(tensors: Record<string, number[]> | string[]) {
  const named = Array.isArray(tensors)
    ? Object.fromEntries(tensors.map((key) => [key, [1]]))
    : tensors;
  return headerOf(
    Object.fromEntries(
      Object.entries(named).map((
        [key, shape],
      ) => [key, { dtype: "F32", shape, data_offsets: [0, 4] }]),
    ),
  );
}

const FLUX = [
  "double_blocks.0.img_attn.norm.key_norm.weight",
  "img_in.weight",
];

Deno.test("a bare diffusion model is identified by its tensor names", () => {
  assertEquals(detectFamily(header(FLUX)), "flux");
  assertEquals(
    detectFamily(header([...FLUX, "double_stream_modulation_img.lin.weight"])),
    "flux2",
  );
  assertEquals(
    detectFamily(
      header([
        "double_blocks.0.img_attn.norm.key_norm.weight",
        "distilled_guidance_layer.norms.0.weight",
      ]),
    ),
    "chroma",
  );
  assertEquals(detectFamily(header(["txtfusion.projector.weight"])), "krea2");
  assertEquals(
    detectFamily(
      header([
        "blocks.0.mlp.layer1.weight",
        "llm_adapter.blocks.0.cross_attn.q_proj.weight",
      ]),
    ),
    "anima",
  );
});

Deno.test("LTX-2 is told from LTX-Video by its audio conditioning", () => {
  const ltx = ["adaln_single.emb.timestep_embedder.linear_1.bias"];
  assertEquals(detectFamily(header(ltx)), "ltx");
  assertEquals(
    detectFamily(header([...ltx, "audio_adaln_single.linear.weight"])),
    "ltx-2",
  );
});

Deno.test("Z-Image is Lumina 2 at a wider hidden size", () => {
  const lumina = {
    "cap_embedder.1.weight": [3840, 2048],
    "noise_refiner.0.attention.k_norm.weight": [1],
  };
  assertEquals(detectFamily(header(lumina)), "z-image");
  // Lumina 2 itself is not a family ForgeUI knows, so it stays unfiled
  // rather than being called Z-Image.
  assertEquals(
    detectFamily(
      header({ ...lumina, "cap_embedder.1.weight": [2304, 2048] }),
    ),
    null,
  );
});

Deno.test("an all-in-one checkpoint is read through its nested prefix", () => {
  // SDXL carries the size-conditioning embedding SD 1.5 has no use for.
  assertEquals(
    detectFamily(
      header([
        "model.diffusion_model.input_blocks.0.0.weight",
        "model.diffusion_model.label_emb.0.0.weight",
        "first_stage_model.encoder.down.0.block.0.conv1.weight",
      ]),
    ),
    "sdxl",
  );
  assertEquals(
    detectFamily(
      header([
        "model.diffusion_model.input_blocks.0.0.weight",
        "cond_stage_model.transformer.text_model.encoder.layers.0.mlp.fc1.weight",
      ]),
    ),
    "sd15",
  );
  // The same architecture as a bare unet, without the checkpoint's wrapper.
  assertEquals(
    detectFamily(header(["input_blocks.0.0.weight"])),
    "sd15",
  );
});

Deno.test("anything unrecognised is unfiled, never guessed at", () => {
  assertEquals(detectFamily(header(["lora_unet_x.lora_up.weight"])), null);
  assertEquals(detectFamily(header([])), null);
});

Deno.test("a real file is probed from its header alone", async () => {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-probe-" });
  try {
    const path = join(dir, "flux1-dev.safetensors");
    // Megabytes of tensor data the probe must not read to answer.
    await writeFakeSafetensors(path, {
      name: "flux",
      bytes: 4 * 1024 * 1024,
      tensors: FLUX,
    });
    assertEquals(await probeFamily(path), "flux");

    const plain = join(dir, "plain.safetensors");
    await writeFakeSafetensors(plain, { name: "plain" });
    assertEquals(await probeFamily(plain), null);

    // A file that is not safetensors at all is an error the caller records,
    // not a crash mid-scan.
    const broken = join(dir, "broken.safetensors");
    await Deno.writeTextFile(broken, "this is not a safetensors file");
    await assertRejects(() => probeFamily(broken), ProbeError);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
