// The shell's half of the bridge: main speaking to this window, over one channel.
//
// Every other `SidekicksBridge` namespace runs renderer → main, and today every
// one of them refuses. This one runs the other way and works today, because a shell
// signal needs no daemon, no control plane, and no credential — main already has a
// `webContents` and this window already has an `ipcRenderer`.
//
// IT IS ITS OWN MODULE SO `index.ts` STAYS THE EXPOSE CALL. The preload's rule is
// that it holds `contextBridge.exposeInMainWorld` and nothing that decides anything;
// a relay written inline would be the first paragraph of logic in that file and the
// first thing there no test could reach without stubbing `contextBridge`.
//
// IT TAKES THE RECEIVER RATHER THAN IMPORTING IT. `ipcRenderer` is a live Electron
// singleton whose listeners outlive a test, so a module that reached for it directly
// could only be checked by mocking the whole module. Handed the receiver, the seam
// is exercised against the same two methods the real one is called through.

import type { IpcRenderer } from "electron";

import type { ShellSignals } from "@ai-sidekicks/contracts";

import { COMPOSER_FOCUS_REQUEST_CHANNEL } from "../shared/composer-chord.js";

/**
 * The two methods this relay uses, and no more.
 *
 * `ipcRenderer` also carries `send` and `invoke`; naming the pair here is what keeps
 * a later signal from quietly acquiring the ability to speak back on a surface whose
 * whole contract is that it listens.
 */
export type ShellSignalReceiver = Pick<IpcRenderer, "on" | "removeListener">;

/**
 * Build the `shell` namespace over a receiver.
 *
 * The handler is invoked with NO arguments. Electron calls a listener with its
 * `IpcRendererEvent` first, and that event carries `sender` — both a capability the
 * renderer must never hold and a value `contextBridge` cannot clone — so the relay
 * drops every argument rather than forwarding what the ask does not carry anyway.
 */
export function createShellSignals(receiver: ShellSignalReceiver): ShellSignals {
  return {
    subscribeToComposerFocusRequest: (handler: () => void) => {
      const deliverRequest = (): void => {
        handler();
      };
      receiver.on(COMPOSER_FOCUS_REQUEST_CHANNEL, deliverRequest);
      return () => {
        receiver.removeListener(COMPOSER_FOCUS_REQUEST_CHANNEL, deliverRequest);
      };
    },
  };
}
