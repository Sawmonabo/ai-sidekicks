// Electron preload script — Plan-023 Phase 1 (T-023p-1-4) substrate.
//
// At Tier 1 this file does one thing: expose a typed `SidekicksBridge` on
// `window.sidekicks` via Electron's `contextBridge.exposeInMainWorld`. The
// bridge object is produced by `createTier1Bridge()` from
// `@ai-sidekicks/contracts`; every round-trip method on it throws
// `NotImplementedAtTier1Error` until Tier 8 wires the real IPC handlers
// (Plan-023 §Implementation Steps step 6 against this same surface).
//
// THE ONE EXCEPTION IS THE `shell` NAMESPACE, and it is an exception because it
// is not a round trip: main speaks to this window over a channel that exists
// today. The factory takes it as a parameter, and the relay that satisfies it
// lives in `./shell-signals.ts` — so this file is still the expose call and
// nothing else, which is the rule for everything under `src/preload/`.
//
// Spec-023 §Security Hardening Baseline lock-in:
//   • `contextBridge.exposeInMainWorld` is the ONLY renderer-visible API —
//     no `ipcRenderer`, no `require`, no `process`, no Node built-in. The
//     `ipcRenderer` handed to the relay is CLOSED OVER and never exposed: what
//     the renderer receives is a subscribe function over one named channel, so
//     it can neither name a second channel nor send on this one.
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

import { contextBridge, ipcRenderer } from "electron";

import { createTier1Bridge } from "@ai-sidekicks/contracts";

import { createShellSignals } from "./shell-signals.js";

contextBridge.exposeInMainWorld("sidekicks", createTier1Bridge(createShellSignals(ipcRenderer)));
