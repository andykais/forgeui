import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  detectFamily,
  detectLoraFamily,
  headerOf,
  isLora,
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

Deno.test("Wan 2.1 and 2.2 are the one family the files describe", () => {
  // ComfyUI builds both generations from this one key, so §8.1 files both
  // under `wan2` rather than inventing a split the headers cannot support.
  assertEquals(detectFamily(header(["head.modulation"])), "wan2");
  assertEquals(
    detectFamily(
      header(["head.modulation", "blocks.0.cross_attn.k_img.weight"]),
    ),
    "wan2",
  );
  assertEquals(
    detectFamily(header(["model.diffusion_model.head.modulation"])),
    "wan2",
  );
});

Deno.test("Qwen-Image is told from Mage-Flow by its two widths", () => {
  const qwen = {
    "txt_norm.weight": [3584],
    "proj_out.weight": [64],
    "img_in.weight": [3072, 64],
  };
  assertEquals(detectFamily(header(qwen)), "qwen-image");
  // The same key at Mage-Flow's widths is not Qwen, and Mage-Flow is not a
  // family ForgeUI knows, so it stays unfiled.
  assertEquals(
    detectFamily(
      header({ ...qwen, "txt_norm.weight": [2560], "proj_out.weight": [128] }),
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

function loraHeader(
  names: string[],
  metadata: Record<string, string> = {},
) {
  return headerOf({
    __metadata__: metadata,
    ...Object.fromEntries(
      names.map((
        key,
      ) => [key, { dtype: "F16", shape: [8, 8], data_offsets: [0, 4] }]),
    ),
  });
}

/** sd-scripts names every patched module `lora_unet_<path with _ for .>`. */
const KOHYA_FLUX = [
  "lora_unet_double_blocks_0_img_attn_qkv.lora_up.weight",
  "lora_unet_double_blocks_0_img_attn_qkv.lora_down.weight",
  "lora_unet_single_blocks_0_linear1.alpha",
];
const KOHYA_SD15 = [
  "lora_unet_input_blocks_1_1_transformer_blocks_0_attn1_to_q.lora_up.weight",
  "lora_unet_output_blocks_5_1_transformer_blocks_0_attn2_to_k.lora_down.weight",
  "lora_te_text_model_encoder_layers_0_self_attn_q_proj.lora_up.weight",
];
const KOHYA_SDXL = [
  "lora_unet_input_blocks_4_1_transformer_blocks_0_attn1_to_q.lora_up.weight",
  "lora_unet_output_blocks_2_1_transformer_blocks_5_attn2_to_k.lora_down.weight",
  "lora_te2_text_model_encoder_layers_0_self_attn_q_proj.lora_up.weight",
];

Deno.test("a LoRA is told apart from the model it patches", () => {
  assertEquals(isLora(loraHeader(KOHYA_FLUX)), true);
  assertEquals(isLora(header(FLUX)), false);
  // The diffusers/PEFT spelling of the same thing.
  assertEquals(
    isLora(
      loraHeader(["transformer.transformer_blocks.0.attn.to_q.lora_A.weight"]),
    ),
    true,
  );
});

Deno.test("a LoRA's family comes from the modules it patches", () => {
  assertEquals(detectLoraFamily(loraHeader(KOHYA_FLUX)), "flux");
  assertEquals(
    detectLoraFamily(
      loraHeader([
        "transformer.single_transformer_blocks.0.attn.to_q.lora_A.weight",
      ]),
    ),
    "flux",
  );
  assertEquals(
    detectLoraFamily(
      loraHeader(["lora_unet_txtfusion_projector.lora_up.weight"]),
    ),
    "krea2",
  );
  assertEquals(
    detectLoraFamily(
      loraHeader([
        "lora_unet_adaln_single_emb_timestep_embedder.lora_up.weight",
      ]),
    ),
    "ltx",
  );
  assertEquals(
    detectLoraFamily(
      loraHeader([
        "lora_unet_adaln_single_emb.lora_up.weight",
        "lora_unet_audio_adaln_single_linear.lora_up.weight",
      ]),
    ),
    "ltx-2",
  );
});

Deno.test("Wan and Qwen LoRAs are read off the modules they patch", () => {
  assertEquals(
    detectLoraFamily(
      loraHeader([
        "lora_unet_blocks_0_self_attn_q.lora_up.weight",
        "lora_unet_blocks_0_cross_attn_k.lora_down.weight",
      ]),
    ),
    "wan2",
  );
  // An image-to-video LoRA, which trains only the image-conditioned half.
  assertEquals(
    detectLoraFamily(
      loraHeader(["lora_unet_blocks_0_cross_attn_k_img.lora_up.weight"]),
    ),
    "wan2",
  );
  assertEquals(
    detectLoraFamily(
      loraHeader([
        "transformer.transformer_blocks.0.img_mod.1.lora_A.weight",
        "transformer.transformer_blocks.0.txt_mod.1.lora_B.weight",
      ]),
    ),
    "qwen-image",
  );
  // Declared, as the trainers write it.
  assertEquals(
    detectLoraFamily(
      loraHeader(["lora_unet_blah.lora_up.weight"], {
        "modelspec.architecture": "Qwen-Image/lora",
      }),
    ),
    "qwen-image",
  );
  assertEquals(
    detectLoraFamily(
      loraHeader(["lora_unet_blah.lora_up.weight"], {
        ss_base_model_version: "Wan2.2-I2V-A14B",
      }),
    ),
    "wan2",
  );
  assertEquals(
    detectLoraFamily(
      loraHeader(["lora_unet_blah.lora_up.weight"], {
        "modelspec.architecture": "wanvideo/lora",
      }),
    ),
    "wan2",
  );
});

Deno.test("SDXL is told from SD 1.5 by its second encoder and its depth", () => {
  assertEquals(detectLoraFamily(loraHeader(KOHYA_SD15)), "sd15");
  assertEquals(detectLoraFamily(loraHeader(KOHYA_SDXL)), "sdxl");
  // No text encoder trained at all: the deeper attention still gives it away.
  assertEquals(
    detectLoraFamily(loraHeader(KOHYA_SDXL.slice(0, 2))),
    "sdxl",
  );
  assertEquals(
    detectLoraFamily(loraHeader(KOHYA_SD15.slice(0, 2))),
    "sd15",
  );
});

Deno.test("what the file declares about itself is trusted first", () => {
  // A LoRA whose keys look like nothing in particular, but which says so.
  const vague = ["lora_unet_blah_blah.lora_up.weight"];
  assertEquals(detectLoraFamily(loraHeader(vague)), null);
  assertEquals(
    detectLoraFamily(loraHeader(vague, {
      "modelspec.architecture": "flux-1-dev/lora",
    })),
    "flux",
  );
  assertEquals(
    detectLoraFamily(loraHeader(vague, {
      "modelspec.architecture": "stable-diffusion-xl-v1-base/lora",
    })),
    "sdxl",
  );
  assertEquals(
    detectLoraFamily(
      loraHeader(vague, { ss_base_model_version: "sdxl_base_v1-0" }),
    ),
    "sdxl",
  );
  assertEquals(
    detectLoraFamily(loraHeader(vague, { ss_base_model_version: "sd_v1" })),
    "sd15",
  );
  // And it outranks the keys, which is the point of trusting it.
  assertEquals(
    detectLoraFamily(loraHeader(KOHYA_SD15, {
      "modelspec.architecture": "flux-1-dev/lora",
    })),
    "flux",
  );
});

Deno.test("a LoRA that matches nothing is unfiled, never guessed at", () => {
  assertEquals(detectLoraFamily(loraHeader(["thing.lora_up.weight"])), null);
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
