// The object the preload exposes. Every round-trip method throws `NotImplementedError` until
// main wires its IPC handler.

import { createStubBridge, type PreloadApi } from "@shared/preload-api.js";

/** The bridge object `index.ts` exposes on `window.desktopBridge`. */
export const preloadApi: PreloadApi = createStubBridge({
  version: "0.0.0",
  // The supported matrix is darwin, linux and win32 on arm64 and x64. `process.platform` and
  // `process.arch` can name others; the real implementation validates them before they reach
  // the renderer, where this stub only narrows them.
  platform: process.platform as unknown as "darwin" | "linux" | "win32",
  arch: process.arch as unknown as "arm64" | "x64",
  // The real implementation reads `app.getLocale()` from Electron's `app` module.
  locale: "en-US",
});
