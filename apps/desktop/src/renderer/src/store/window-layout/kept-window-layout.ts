// The kept window layout: which windows of session views were open and where each one was, keyed
// by window id, the id main's own place file keeps each window's place under. The app opens the
// window used last first and the rest from here. It holds every window open now, and the last one
// closed while none other is open, so a reopen brings that window back; it is read from storage,
// so each entry is checked.
//
// A window's place is its address, kept as the hash the route grammar writes, so the layout and
// the address bar speak one grammar. A link to one message is not kept: a restart lands on the
// session, not on the message a link once named. An address the persistence grammar cannot hold,
// one naming nothing to come back to, and one that no longer parses all keep the window and come
// back on the sessions list.

import { isIdentifierShaped } from "#renderer/lib/identifier-grammar.js";
import { formatRoute, parseRoute, DEFAULT_ROUTE, type AppRoute } from "#renderer/routing/routes.js";
import { isConsoleWindowId } from "#shared/window/frame-name.js";
import type { PersistableValue } from "../persistence/persisted-value-classes.js";
import type { PersistenceWriteResult, UiStateStore } from "../persistence/ui-state-store.js";

/** One kept window: its id and the address it was on. */
export interface KeptWindow {
  readonly windowId: string;
  readonly route: AppRoute;
}

/** The global key the kept window layout is stored under. */
const KEPT_WINDOWS_KEY = "windows";

/** The kept windows, in the order they were kept; empty when none were. */
export async function readKeptWindows(uiStateStore: UiStateStore): Promise<readonly KeptWindow[]> {
  const record = await uiStateStore.readGlobal(KEPT_WINDOWS_KEY);
  const layout = record?.value;
  if (
    layout === undefined ||
    layout === null ||
    typeof layout !== "object" ||
    Array.isArray(layout)
  ) {
    return [];
  }
  return Object.entries(layout as Readonly<Record<string, PersistableValue>>)
    .flatMap(([windowId, entry]): (readonly [KeptWindow, number])[] => {
      const { order, address } = (entry ?? {}) as {
        readonly order?: unknown;
        readonly address?: unknown;
      };
      return isConsoleWindowId(windowId) && typeof order === "number"
        ? [[{ windowId, route: keptRouteOf(address) }, order]]
        : [];
    })
    .sort(([, left], [, right]) => left - right)
    .map(([keptWindow]) => keptWindow);
}

/**
 * Keep `windows` as the open windows, in this order. A refused write is counted on the store's
 * health, which the person sees, as every refused UI-state write is.
 */
export async function keepWindows(
  uiStateStore: UiStateStore,
  windows: readonly KeptWindow[],
): Promise<PersistenceWriteResult> {
  const layout: Record<string, PersistableValue> = {};
  windows.forEach(({ windowId, route }, order) => {
    const address = keptAddressOf(route);
    layout[windowId] = address === undefined ? { order } : { order, address };
  });
  return await uiStateStore.writeGlobal(KEPT_WINDOWS_KEY, "layout", layout);
}

/** The address a window is kept on, or `undefined` where it is kept with none. */
function keptAddressOf(route: AppRoute): string | undefined {
  switch (route.kind) {
    case "not-found":
    case "pane-harness":
      return undefined;
    case "session":
      return identifierShapedOrNone(formatRoute({ kind: "session", sessionId: route.sessionId }));
    case "sessions":
    case "workflows":
    case "settings":
      return identifierShapedOrNone(formatRoute(route));
  }
}

function identifierShapedOrNone(address: string): string | undefined {
  return isIdentifierShaped(address) ? address : undefined;
}

/** The route a kept address reads as: the sessions list where it names nothing to come back to. */
function keptRouteOf(address: unknown): AppRoute {
  if (typeof address !== "string") {
    return DEFAULT_ROUTE;
  }
  const route = parseRoute(address);
  return route.kind === "not-found" || route.kind === "pane-harness" ? DEFAULT_ROUTE : route;
}
