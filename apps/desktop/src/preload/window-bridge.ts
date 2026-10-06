// The `window` members as the preload carries them to main. A subscription keeps its handler
// here and hears every push main makes on its channel; the appearance's first delivery is main's
// current value.

import type { AppearanceRecord } from "#shared/appearance.js";
import {
  APPEARANCE_VALUE_CHANNEL,
  BRIDGE_CHANNELS,
  REOPEN_WINDOW_CHANNEL,
} from "#shared/bridge-channels.js";
import type { PreloadApi, Unsubscribe } from "#shared/preload-api.js";

/** The part of Electron's `ipcRenderer` the `window` members use. */
export interface WindowBridgeIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/**
 * The `window` member the preload exposes to the console document, over `ipc`, which main
 * started with `lastUsedWindowId`.
 */
export function createWindowBridge(
  ipc: WindowBridgeIpc,
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
    setDefaultSizes: async (sizes): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.setDefaultSizes, sizes);
    },
    endSafeStart: async (): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.endSafeStart);
    },
    subscribeToReopenRequest: (handler) => reopenRequests.subscribe(handler),
  };
}

/** The values main pushes on one channel, and the handlers subscribed to them. */
class MainPushes<Value> {
  readonly #handlers = new Set<(value: Value) => void>();

  /** Hands `value` to every handler subscribed now. */
  public deliver(value: Value): void {
    for (const handler of [...this.#handlers]) {
      handler(value);
    }
  }

  /**
   * Adds `handler`, first handing it the value `readCurrent` answers when there is one to read,
   * unless it was removed first. A failed read is thrown on as an unhandled rejection, never
   * dropped.
   */
  public subscribe(
    handler: (value: Value) => void,
    readCurrent?: () => Promise<Value>,
  ): Unsubscribe {
    // A wrapper per subscription, so the same function subscribed twice is two subscriptions.
    const subscription = (value: Value): void => {
      handler(value);
    };
    this.#handlers.add(subscription);
    if (readCurrent !== undefined) {
      void readCurrent().then((current) => {
        if (this.#handlers.has(subscription)) {
          subscription(current);
        }
      });
    }
    return () => {
      this.#handlers.delete(subscription);
    };
  }
}
