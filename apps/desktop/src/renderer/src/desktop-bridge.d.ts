// Types the `window.desktopBridge` global the preload installs with
// `contextBridge.exposeInMainWorld`, which carries no static type of its own. Both renderer graphs
// include this file: the production one through `src/renderer/tsconfig.json`, the test one
// through `src/renderer/tsconfig.test.json`'s `src/**/*.d.ts`. The top-level `import type` makes
// it a module, hence `declare global`.

import type { PreloadApi } from "#shared/preload-api.js";

declare global {
  interface Window {
    /** The bridge the preload exposes to the renderer. */
    desktopBridge: PreloadApi;
  }
}
