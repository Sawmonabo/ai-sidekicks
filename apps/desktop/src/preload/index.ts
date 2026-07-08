// Electron preload script — Plan-023 Phase 1 (T-023p-1-4) substrate.
//
// At Tier 1 this file does one thing: expose a typed stub `SidekicksBridge`
// on `window.sidekicks` via Electron's `contextBridge.exposeInMainWorld`.
// The bridge object is produced by `createTier1Bridge()` from
// `@ai-sidekicks/contracts`; every method on it throws
// `NotImplementedAtTier1Error` until Tier 8 wires the real IPC handlers
// (Plan-023 §Implementation Steps step 6 against this same surface).
//
// Spec-023 §Security Hardening Baseline lock-in:
//   • `contextBridge.exposeInMainWorld` is the ONLY renderer-visible API —
//     no `ipcRenderer`, no `require`, no `process`, no Node built-in.
//   • The preload runs in the Electron preload-sandbox (`sandbox: true` is
//     locked by `apps/desktop/src/main/window.ts`); the bridge is the only
//     surface the renderer can reach.
//
// `Spec-023 §Acceptance Criteria` — "No auth material on
// `window.sidekicks`" — is enforced TYPEWISE by the conditional-type test
// `packages/contracts/src/desktop-bridge.test-d.ts`. The runtime side here is
// trivial because the renderer can only consume what the static type contract
// declares.
//
// See:
//   • docs/specs/023-desktop-shell-and-renderer.md §Preload Bridge Contract
//   • `docs/plans/023-desktop-shell-and-renderer.md §Tier 1 Partial PR Sequence` (Phase 1, the preload bullet)
//   • packages/contracts/src/desktop-bridge.ts

import { contextBridge } from "electron";

import { createTier1Bridge } from "@ai-sidekicks/contracts";

contextBridge.exposeInMainWorld("sidekicks", createTier1Bridge());
