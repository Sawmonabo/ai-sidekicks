// The `window` members as the preload carries them to main. A subscription keeps its handler
// here, takes its first delivery from main's current value, and then every value main pushes.

import type { AppearanceRecord } from "#shared/appearance.js";
import { APPEARANCE_VALUE_CHANNEL, BRIDGE_CHANNELS } from "#shared/bridge-channels.js";
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
  const appearance = new PushedValues<AppearanceRecord>();
  ipc.on(APPEARANCE_VALUE_CHANNEL, (_event, record) => {
    appearance.deliver(APPEARANCE_VALUE_CHANNEL, record as AppearanceRecord);
  });
  return {
    lastUsedWindowId,
    setAppearance: async (choice, grounds): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.setAppearance, { choice, grounds });
    },
    subscribeAppearance: (handler) =>
      appearance.subscribe(
        APPEARANCE_VALUE_CHANNEL,
        handler,
        async () => (await ipc.invoke(BRIDGE_CHANNELS.readAppearance)) as AppearanceRecord,
      ),
    setMinimumSize: async (windowId, size): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.setMinimumSize, { windowId, size });
    },
    setDefaultSizes: async (sizes): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.setDefaultSizes, sizes);
    },
  };
}

/** Values main pushes, each under a key, the channel they arrive on. */
class PushedValues<Value> {
  readonly #handlers = new Map<string, Set<(value: Value) => void>>();

  /** Hands `value` to every handler subscribed under `key`. */
  public deliver(key: string, value: Value): void {
    for (const handler of this.#handlers.get(key) ?? []) {
      handler(value);
    }
  }

  /**
   * Adds `handler` under `key` and hands it the value `readCurrent` answers, unless it was removed
   * first. A failed read is thrown on as an unhandled rejection, never dropped.
   */
  public subscribe(
    key: string,
    handler: (value: Value) => void,
    readCurrent: () => Promise<Value>,
  ): Unsubscribe {
    // A wrapper per subscription, so the same function subscribed twice is two subscriptions.
    const subscription = (value: Value): void => {
      handler(value);
    };
    const handlers = this.#handlers.get(key) ?? new Set<(value: Value) => void>();
    this.#handlers.set(key, handlers);
    handlers.add(subscription);
    void readCurrent().then((current) => {
      if (handlers.has(subscription)) {
        subscription(current);
      }
    });
    return () => {
      handlers.delete(subscription);
      if (handlers.size === 0 && this.#handlers.get(key) === handlers) {
        this.#handlers.delete(key);
      }
    };
  }
}
