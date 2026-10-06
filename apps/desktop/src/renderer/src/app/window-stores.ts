// Each open window's frame store, kept by the app so its commands act on the window used last,
// and main's report of the background service, which every window shows. A store is built when its
// window opens, on the address the window opened on, so it never publishes its default route over
// that address; it goes when its window closes.

import type { MainProcessState } from "#shared/daemon/status-topic.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { parseRoute } from "#renderer/routing/routes.js";
import type { OpenWindow, OpenWindows } from "#renderer/services/window/open-windows.js";
import { WindowStore } from "#renderer/store/window/window-store.js";

/** One open window and the frame store it draws from. */
export interface OpenWindowStore {
  readonly openWindow: OpenWindow;
  readonly store: WindowStore;
}

/** The frame store of every open window, and the one report of the service they share. */
export class WindowStores {
  readonly #heldByWindowId = new Map<string, HeldWindowStore>();
  readonly #listeners = new Set<() => void>();
  #usedLastFirst: readonly OpenWindowStore[] = [];
  #latestReport: MainProcessState | undefined;

  /**
   * Hold a store for each window `openWindows` has open, now and on each open, close and focus
   * move, until the returned call. A store is built on its window's first open and kept until the
   * window closes.
   */
  public follow(openWindows: OpenWindows): Unsubscribe {
    const hold = (): void => {
      this.#holdOnly(openWindows.list());
    };
    hold();
    return openWindows.subscribe(hold);
  }

  /** Every open window with its store, the one used last first. The same array until it moves. */
  public list(): readonly OpenWindowStore[] {
    return this.#usedLastFirst;
  }

  /** Hand main's newest report to every window's store, and to each one built after. */
  public publishMainProcessReport(report: MainProcessState): void {
    this.#latestReport = report;
    for (const { store } of this.#heldByWindowId.values()) {
      store.publishMainProcessReport(report);
    }
  }

  /** Hear every window open, close or come forward, and every window's route move. */
  public subscribe(listener: () => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Build a store for each window not yet held, let go of every closed one's, then publish. */
  #holdOnly(openWindows: readonly OpenWindow[]): void {
    const openWindowIds = new Set(openWindows.map(({ windowId }) => windowId));
    for (const [windowId, held] of this.#heldByWindowId) {
      if (!openWindowIds.has(windowId)) {
        held.stopHearingRoute();
        this.#heldByWindowId.delete(windowId);
      }
    }
    this.#usedLastFirst = openWindows.map((openWindow) => ({
      openWindow,
      store: this.#storeFor(openWindow),
    }));
    this.#publish();
  }

  #storeFor(openWindow: OpenWindow): WindowStore {
    const held = this.#heldByWindowId.get(openWindow.windowId);
    if (held !== undefined) {
      return held.store;
    }
    const store = new WindowStore({
      initialRoute: parseRoute(openWindow.window.location.hash),
      ownerDocument: openWindow.window.document,
    });
    if (this.#latestReport !== undefined) {
      store.publishMainProcessReport(this.#latestReport);
    }
    const stopHearingRoute = store.readable.subscribe((state, previous) => {
      if (state.route !== previous.route) {
        this.#publish();
      }
    });
    this.#heldByWindowId.set(openWindow.windowId, { store, stopHearingRoute });
    return store;
  }

  #publish(): void {
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }
}

/** One window's store and what stops hearing its route. */
interface HeldWindowStore {
  readonly store: WindowStore;
  readonly stopHearingRoute: Unsubscribe;
}
