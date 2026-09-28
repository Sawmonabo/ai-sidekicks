// Electron preload script.
//
// Exposes a typed `DesktopBridge` on `window.desktopBridge` via Electron's
// `contextBridge.exposeInMainWorld`. The bridge object is produced by
// `createStubBridge()` from `@ai-sidekicks/contracts`; every round-trip method on
// it throws `NotImplementedError` until the real IPC handlers are wired against
// this same surface. No logic and no branching: the expose call is the rule for
// `src/preload/`.
//
// The hardening lock-in: `contextBridge.exposeInMainWorld` is the ONLY
// renderer-visible API, with no `ipcRenderer`, no `require`, no `process`, and no
// Node built-in. The preload runs in the Electron preload-sandbox (`sandbox: true`
// is locked by `apps/desktop/src/main/window.ts`); the bridge is the only surface
// the renderer can reach.
//
// No auth material ever reaches `window.desktopBridge`, and that is enforced
// TYPEWISE by the conditional-type test
// `packages/contracts/src/desktop-bridge.test-d.ts`. The runtime side here is
// trivial because the renderer can only consume what the static type contract
// in `packages/contracts/src/desktop-bridge.ts` declares.

import { contextBridge } from "electron";

import { createStubBridge } from "@ai-sidekicks/contracts";

contextBridge.exposeInMainWorld("desktopBridge", createStubBridge());
