import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  /**
   * Script only: the components' styles are plain CSS, and vitePreprocess's
   * style pass needs a full Vite environment that vitest does not provide.
   */
  preprocess: vitePreprocess({ style: false }),
};
