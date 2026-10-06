// The `window` members as the preload carries them to main. A subscription keeps its handler
// here and hears every push main makes on its channel; the appearance's first delivery is main's
// current value.

import type { AppearanceRecord } from "#shared/appearance.js";
import {
  APPEARANCE_VALUE_CHANNEL,
  BRIDGE_CHANNELS,
  REOPEN_WINDOW_CHANNEL,
} from "#shared/bridge-channels.js";
import type { PreloadApi } from "#shared/preload-api.js";
import { MainPushes } from "./main-pushes.js";
import type { PreloadIpc } from "./ipc.js";

/**
 * The `window` member the preload exposes to the console document, over `ipc`, which main
 * started with `lastUsedWindowId`.
 */
export function createWindowBridge(
  ipc: Pick<PreloadIpc, "invoke" | "on">,
  lastUsedWindowId: string,
): PreloadApi["window"] {
  const appearance = new MainPushes<AppearanceRecord>();
  ipc.on(APPEARANCE_VALUE_CHANNEL, (_event, record) => {
    appearance.deliver(record as AppearanceRecord);
  });
  const reopenRequests = new MainPushes<string>();
  ipc.on(REOPEN_WINDOW_CHANNEL, (_event, windowId) => {
    reopenRequests.deliver(windowId as string);
  });
  return {
    lastUsedWindowId,
    setAppearance: async (choice, grounds): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.setAppearance, { choice, grounds });
    },
    subscribeAppearance: (handler) =>
      appearance.subscribe(
        handler,
        async () => (await ipc.invoke(BRIDGE_CHANNELS.readAppearance)) as AppearanceRecord,
      ),
    setMinimumSize: async (windowId, size): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.setMinimumSize, { windowId, size });
    },
    bringForward: async (windowId): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.bringWindowForward, windowId);
    },
    setDefaultSizes: async (sizes): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.setDefaultSizes, sizes);
    },
    endSafeStart: async (): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.endSafeStart);
    },
    subscribeToReopenRequest: (handler) => reopenRequests.subscribe(handler),
  };
}
