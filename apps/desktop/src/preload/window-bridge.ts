// The `window` members as the preload carries them to main. A subscription keeps its handler
// here, takes its first delivery from main's current value, and then every value main pushes.

import type { AppearanceRecord } from "@shared/appearance.js";
import {
  APPEARANCE_VALUE_CHANNEL,
  BRIDGE_CHANNELS,
  FULLSCREEN_VALUE_CHANNEL,
} from "@shared/bridge-channels.js";
import type { PreloadApi, Unsubscribe } from "@shared/preload-api.js";

/** The part of Electron's `ipcRenderer` the `window` members use. */
export interface WindowBridgeIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/** The `window` member the preload exposes for the window main built under `id`, over `ipc`. */
export function createWindowBridge(ipc: WindowBridgeIpc, id: string): PreloadApi["window"] {
  const appearance = new PushedValue<AppearanceRecord>(ipc, APPEARANCE_VALUE_CHANNEL);
  const fullscreen = new PushedValue<boolean>(ipc, FULLSCREEN_VALUE_CHANNEL);
  return {
    id,
    setAppearance: async (choice, grounds): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.setAppearance, { choice, grounds });
    },
    subscribeAppearance: (handler) =>
      appearance.subscribe(
        handler,
        async () => (await ipc.invoke(BRIDGE_CHANNELS.readAppearance)) as AppearanceRecord,
      ),
    subscribeFullscreen: (handler) =>
      fullscreen.subscribe(
        handler,
        async () => (await ipc.invoke(BRIDGE_CHANNELS.readFullscreen)) as boolean,
      ),
    setMinimumSize: async (size): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.setMinimumSize, size);
    },
  };
}

/** One value main pushes on a channel, and the page's handlers for it. */
class PushedValue<Value> {
  readonly #handlers = new Set<(value: Value) => void>();

  public constructor(ipc: WindowBridgeIpc, channel: string) {
    ipc.on(channel, (_event, value) => {
      for (const handler of this.#handlers) {
        handler(value as Value);
      }
    });
  }

  /**
   * Adds `handler` and hands it the value `readCurrent` answers, unless it was removed first. A
   * failed read is thrown on as an unhandled rejection, never dropped.
   */
  public subscribe(
    handler: (value: Value) => void,
    readCurrent: () => Promise<Value>,
  ): Unsubscribe {
    // A wrapper per subscription, so the same function subscribed twice is two subscriptions.
    const subscription = (value: Value): void => {
      handler(value);
    };
    this.#handlers.add(subscription);
    void readCurrent().then((current) => {
      if (this.#handlers.has(subscription)) {
        subscription(current);
      }
    });
    return () => {
      this.#handlers.delete(subscription);
    };
  }
}
