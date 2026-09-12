// Renderer-wide ambient declaration for the `window.sidekicks` contextBridge global.
// The preload (`apps/desktop/src/preload/index.ts`) installs the bridge at runtime via
// `contextBridge.exposeInMainWorld('sidekicks', ...)` — a runtime-only registration
// with no static typing. TypeScript needs an ambient augmentation to type the resulting
// `window.sidekicks` access; a dedicated `.d.ts` is the conventional Electron + Vite
// pattern for typing contextBridge-exposed globals.
//
// This file is picked up by both renderer typecheck graphs, but via different
// `include` patterns: the PRODUCTION renderer graph globs it in through
// `src/renderer/tsconfig.json`'s `include: ["**/*"]`; the renderer TEST graph
// globs it in through `src/renderer/tsconfig.test.json`'s `"src/**/*.d.ts"`
// entry. The test config needs its own glob because TS `extends` replaces
// (does not merge) `include`, so the test config does not inherit the
// production `["**/*"]`. With both in place every renderer consumer (production
// and test) sees `window.sidekicks` as `SidekicksBridge`-typed without
// importing anything.
//
// Hoisted out of `session-bootstrap/SessionBootstrap.tsx`: the declaration was
// originally colocated in the first renderer consumer and lives here now that
// the renderer has more than one.
//
// The top-level `import type` makes this file a module, so `declare global` is
// the correct augmentation form (a script-scoped `interface Window` would
// merge into the global scope without the `declare global` wrapper, but the
// module scope here requires it). No `export {}` is needed — the `import type`
// already marks the file as a module.

import type { SidekicksBridge } from "@ai-sidekicks/contracts";

declare global {
  interface Window {
    sidekicks: SidekicksBridge;
  }
}
