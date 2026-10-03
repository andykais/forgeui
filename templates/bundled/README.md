# Bundled templates

A template is a saved way to fill one workflow's panel (DESIGN.md §4.8): the
params it **sets** (`values`), the ones it **asks** for (`ask`, required while
it is applied), and everything else left as the panel would have it.

These ship with the app and are copied into `<appdata>/templates/bundled/` on
every launch. Saving one from the app writes a user copy into
`<appdata>/templates/user/`, which shadows it; deleting that copy brings this
one back.

| id                    | workflow              | sets                     | asks  | action  |
| --------------------- | --------------------- | ------------------------ | ----- | ------- |
| `anima-upscale`       | `anima-img2img`       | scale 2 · creativity 0.2 | image | upscale |
| `flux-klein-upscale`  | `flux-klein-img2img`  | scale 2 · creativity 0.2 | image | upscale |
| `illustrious-upscale` | `illustrious-img2img` | scale 2 · creativity 0.2 | image | upscale |
| `krea2-upscale`       | `krea2-img2img`       | scale 2 · creativity 0.2 | image | upscale |
| `sd15-upscale`        | `sd15-img2img`        | scale 2 · creativity 0.2 | image | upscale |
| `z-image-upscale`     | `z-image-img2img`     | scale 2 · creativity 0.2 | image | upscale |

`action: "upscale"` is what the **Upscale image** button on an output looks for,
in the output's own family (DESIGN.md §10).
