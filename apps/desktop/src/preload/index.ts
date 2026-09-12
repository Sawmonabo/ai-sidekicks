// Electron preload script.
//
// Today this file does one thing: expose a typed `SidekicksBridge` on
// `window.sidekicks` via Electron's `contextBridge.exposeInMainWorld`. The
// bridge object is produced by `createTier1Bridge()` from
// `@ai-sidekicks/contracts`; every round-trip method on it throws
// `NotImplementedAtTier1Error` until the real IPC handlers are wired against
// this same surface.
//
// TWO NAMESPACES ARE ALREADY WIRED, and each is wired the way its direction
// demands:
//
//   • `shell` runs main-to-renderer and is not a round trip: main speaks to this
//     window over a channel that exists today. The factory takes it as a
//     parameter, and the relay that satisfies it lives in `./shell-signals.ts`.
//   • `window`, the shell's auxiliary-window controls, runs renderer-to-main and
//     is spread over the stub rather than left throwing: its main-process
//     handlers already ship (`../main/auxiliary-window-ipc.ts`). A pane moved
//     into a window of its own is a shell act end to end — no daemon call, no
//     control-plane procedure — so it needs no wire that does not exist yet, and
//     leaving it unwired would have meant the deck suppressed a pane and no
//     `BrowserWindow` ever opened.
//
// STILL NO LOGIC AND NO BRANCHING. Each `window` line below is one `ipcRenderer`
// call: three forwarders and two listener registrations. The Electron event
// object is dropped rather than forwarded — an `IpcRendererEvent` carries
// `sender` and `ports`, and handing either to the renderer would put the
// boundary this file exists to hold on the far side of it. Everything else in
// this file is the expose call, which is the rule for `src/preload/`.
//
// The hardening lock-in:
//   • `contextBridge.exposeInMainWorld` is the ONLY renderer-visible API —
//     no `ipcRenderer`, no `require`, no `process`, no Node built-in. The
//     `ipcRenderer` handed to the relay is CLOSED OVER and never exposed: what
//     the renderer receives is a subscribe function over one named channel, so
//     it can neither name a second channel nor send on this one.
//   • The preload runs in the Electron preload-sandbox (`sandbox: true` is
//     locked by `apps/desktop/src/main/window.ts`); the bridge is the only
//     surface the renderer can reach.
//
// No auth material ever reaches `window.sidekicks`, and that is enforced
// TYPEWISE by the conditional-type test
// `packages/contracts/src/desktop-bridge.test-d.ts`. The runtime side here is
// trivial because the renderer can only consume what the static type contract
// in `packages/contracts/src/desktop-bridge.ts` declares.

import { contextBridge, ipcRenderer } from "electron";

import {
  AUXILIARY_WINDOW_CHANNELS,
  createTier1Bridge,
  type AuxiliaryWindowControls,
  type AuxiliaryWindowDetachRequest,
  type AuxiliaryWindowHandle,
  type AuxiliaryWindowPaneError,
  type AuxiliaryWindowPaneReturn,
} from "@ai-sidekicks/contracts";

import { createShellSignals } from "./shell-signals.js";

const auxiliaryWindowControls: AuxiliaryWindowControls = {
  detachPane: async (request: AuxiliaryWindowDetachRequest): Promise<AuxiliaryWindowHandle> =>
    (await ipcRenderer.invoke(
      AUXILIARY_WINDOW_CHANNELS.detachPane,
      request,
    )) as AuxiliaryWindowHandle,
  focusAuxiliary: async (request: AuxiliaryWindowHandle): Promise<void> => {
    await ipcRenderer.invoke(AUXILIARY_WINDOW_CHANNELS.focusAuxiliary, request);
  },
  closeAuxiliary: async (request: AuxiliaryWindowHandle): Promise<void> => {
    await ipcRenderer.invoke(AUXILIARY_WINDOW_CHANNELS.closeAuxiliary, request);
  },
  subscribePaneErrors: (handler: (event: AuxiliaryWindowPaneError) => void) => {
    const deliver = (_event: unknown, report: AuxiliaryWindowPaneError): void => {
      handler(report);
    };
    ipcRenderer.on(AUXILIARY_WINDOW_CHANNELS.paneError, deliver);
    return () => {
      ipcRenderer.removeListener(AUXILIARY_WINDOW_CHANNELS.paneError, deliver);
    };
  },
  subscribePaneReturns: (handler: (event: AuxiliaryWindowPaneReturn) => void) => {
    const deliver = (_event: unknown, report: AuxiliaryWindowPaneReturn): void => {
      handler(report);
    };
    ipcRenderer.on(AUXILIARY_WINDOW_CHANNELS.paneReturn, deliver);
    return () => {
      ipcRenderer.removeListener(AUXILIARY_WINDOW_CHANNELS.paneReturn, deliver);
    };
  },
};

contextBridge.exposeInMainWorld("sidekicks", {
  ...createTier1Bridge(createShellSignals(ipcRenderer)),
  window: auxiliaryWindowControls,
});
