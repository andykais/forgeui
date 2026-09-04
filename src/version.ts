import denoConfig from "../deno.json" with { type: "json" };

export const APP_VERSION: string = denoConfig.version;
