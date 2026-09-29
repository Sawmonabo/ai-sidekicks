// Types the `window.desktopBridge` global the preload installs with
// `contextBridge.exposeInMainWorld`, which carries no static type of its own.
//
// Both renderer graphs pick this file up: the production one through
// `src/renderer/tsconfig.json`'s `**/*`, the test one through `src/renderer/tsconfig.test.json`'s
// `src/**/*.d.ts` (a test config's `include` replaces the one it extends). The top-level
// `import type` makes the file a module, so the augmentation needs `declare global`.

import type { PreloadApi } from "@shared/preload-api.js";

declare global {
  interface Window {
    desktopBridge: PreloadApi;
  }
}
