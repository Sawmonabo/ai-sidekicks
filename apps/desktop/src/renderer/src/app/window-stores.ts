// Each open window's frame store, kept by the app so its commands act on the window used last,
// and main's report of the background service, which every window shows. A store is built the
// first time its window is drawn, on the window's opening address, or it would publish its default
// route over that address; it goes when its window closes.

import type { MainProcessState } from "#shared/daemon/daemon-status-topic.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { parseRoute } from "#renderer/routing/routes.js";
import type { OpenWindow } from "#renderer/services/window/open-windows.js";
import { WindowStore } from "#renderer/store/window/window-store.js";

/** The frame store of every open window, and the one report of the service they share. */
export class WindowStores {
  readonly #heldByWindowId = new Map<string, HeldWindowStore>();
  readonly #routeListeners = new Set<() => void>();
  #latestReport: MainProcessState | undefined;

  /** The store `openWindow` draws from, built on the first ask. */
  public storeFor(openWindow: OpenWindow): WindowStore {
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
        this.#publishRouteChange();
      }
    });
    this.#heldByWindowId.set(openWindow.windowId, { store, stopHearingRoute });
    return store;
  }

  /** The store of the window `windowId` names, where that window has been drawn. */
  public storeOf(windowId: string): WindowStore | undefined {
    return this.#heldByWindowId.get(windowId)?.store;
  }

  /** Hand main's newest report to every window's store, and to each one built after. */
  public publishMainProcessReport(report: MainProcessState): void {
    this.#latestReport = report;
    for (const { store } of this.#heldByWindowId.values()) {
      store.publishMainProcessReport(report);
    }
  }

  /** Let go of the store of every window not in `openWindowIds`. */
  public keepOnly(openWindowIds: ReadonlySet<string>): void {
    for (const [windowId, held] of this.#heldByWindowId) {
      if (!openWindowIds.has(windowId)) {
        held.stopHearingRoute();
        this.#heldByWindowId.delete(windowId);
      }
    }
  }

  /** Hear every window's route move. */
  public subscribeRoutes(listener: () => void): Unsubscribe {
    this.#routeListeners.add(listener);
    return () => {
      this.#routeListeners.delete(listener);
    };
  }

  #publishRouteChange(): void {
    for (const listener of [...this.#routeListeners]) {
      listener();
    }
  }
}

/** One window's store and what stops hearing its route. */
interface HeldWindowStore {
  readonly store: WindowStore;
  readonly stopHearingRoute: Unsubscribe;
}
