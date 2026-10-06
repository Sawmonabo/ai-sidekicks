// The `update` members as the preload carries them to main: each call invokes its own channel,
// and the subscription hears every state main pushes on `UPDATE_STATE_CHANNEL`.

import { BRIDGE_CHANNELS, UPDATE_STATE_CHANNEL } from "#shared/bridge-channels.js";
import type { PreloadApi, UpdateState } from "#shared/preload-api.js";
import { MainPushes } from "./main-pushes.js";
import type { PreloadIpc } from "./ipc.js";

/** The `update` member the preload exposes to the console document, carried over `ipc`. */
export function createUpdateBridge(ipc: Pick<PreloadIpc, "invoke" | "on">): PreloadApi["update"] {
  const states = new MainPushes<UpdateState>();
  ipc.on(UPDATE_STATE_CHANNEL, (_event, state) => {
    states.deliver(state as UpdateState);
  });
  return {
    getState: async (): Promise<UpdateState> =>
      (await ipc.invoke(BRIDGE_CHANNELS.readUpdateState)) as UpdateState,
    // No first delivery: the reader asks `getState` for the current state itself.
    subscribe: (handler) => states.subscribe(handler),
    requestCheck: async (): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.requestUpdateCheck);
    },
    requestDownload: async (): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.requestUpdateDownload);
    },
    requestRestart: async (): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.requestUpdateRestart);
    },
  };
}
