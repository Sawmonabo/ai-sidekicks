// The `window` members as the preload carries them to main. A subscription keeps its handler
// here and hears every push main makes on its channel; the appearance's first delivery is main's
// current value, and a navigation request's the one main held, when it held one
// (`./navigation-requests.ts`).

import type { AppearanceRecord } from "#shared/appearance.js";
import {
  APPEARANCE_VALUE_CHANNEL,
  BRIDGE_CHANNELS,
  NAVIGATION_REQUEST_CHANNEL,
  REOPEN_WINDOW_CHANNEL,
  UNKEPT_SCHEME_CHANNEL,
} from "#shared/bridge-channels.js";
import type { NavigationRequest, PreloadApi } from "#shared/preload-api.js";
import { MainPushes } from "./main-pushes.js";
import { NavigationRequests } from "./navigation-requests.js";
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
  const unkeptSchemes = new MainPushes<undefined>();
  ipc.on(UNKEPT_SCHEME_CHANNEL, () => {
    unkeptSchemes.deliver(undefined);
  });
  const navigationRequests = new NavigationRequests(
    async () =>
      (await ipc.invoke(BRIDGE_CHANNELS.readNavigationRequest)) as NavigationRequest | null,
  );
  ipc.on(NAVIGATION_REQUEST_CHANNEL, (_event, request) => {
    navigationRequests.deliver(request as NavigationRequest);
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
    subscribeToUnkeptScheme: (handler) => unkeptSchemes.subscribe(handler),
    subscribeToNavigationRequest: (handler) => navigationRequests.subscribe(handler),
  };
}
