// Every window a person sees, drawn from the console document. The console document is never
// shown; it keeps what every window shares (the session stores, the UI-state store, the drafts, the
// appearance and the app's commands) and opens each window with `window.open`: the window used last
// first, on the address the launch named, then the rest from the kept window layout. A safe start
// opens that one window on the sessions list, reads no kept layout and leaves it as it was, and says
// so in a line whose `Restore windows` reopens the kept windows.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { parseRoute, formatRoute, DEFAULT_ROUTE, type AppRoute } from "#renderer/routing/routes.js";
import { type PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { type OpenWindow, type OpenWindows } from "#renderer/services/window/open-windows.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "#renderer/store/persistence/caps.js";
import { DraftStore } from "#renderer/store/draft-store.js";
import { type SessionBaseStateReader } from "#renderer/store/session/open-session/open-session-entry.js";
import {
  keepWindowIds,
  readKeptWindowIds,
} from "#renderer/store/window-layout/kept-window-layout.js";
import { WindowStore } from "#renderer/store/window/window-store.js";
import { entityProjectorRegistry } from "#renderer/registries/entity-projectors/entity-projector-registry.js";
import { paneRegistry } from "#renderer/registries/panes/pane-registry.js";
import { screenRegistry } from "#renderer/registries/screens/screen-registry.js";
import { SafeStartNotice } from "#renderer/layout/AppShell/SafeStartNotice.js";
import { SAFE_START_ATTRIBUTE } from "#shared/window/safe-start.js";
import { useAppCommands } from "./hooks/useAppCommands.js";
import { useAppearance } from "./hooks/useAppearance.js";
import { useLazyBodyIdleWarm } from "./hooks/useLazyBodyIdleWarm.js";
import { useSessionStoreRegistry } from "./hooks/useSessionStoreRegistry.js";
import { useUiStateStore } from "./hooks/useUiStateStore.js";
import { AppWindow, type AppStores } from "./AppWindow.js";
import { prepareWindowDocument } from "./window-document.js";

/** What the bootstrap hands the app once the bridge has resolved. */
export interface AppWindowsProps {
  readonly bridge: PlatformBridge;
  /** The call that reads one session's base state, handed to the session registry. */
  readonly readSession: SessionBaseStateReader;
  /** The windows the console document opens. */
  readonly openWindows: OpenWindows;
}

/**
 * The app: what every window shares, and one `AppWindow` per open window.
 *
 * A ref holds the draft store because a memo may be recomputed and a recreated store would drop
 * every draft; the registry and UI-state stores own resources (subscriptions, a database
 * connection), so hooks hold them for teardown.
 */
export function AppWindows(props: AppWindowsProps): React.JSX.Element {
  const { bridge, openWindows } = props;
  const consoleDocument = document;

  // Opening the database connection returns at once, so first paint waits on no storage.
  const uiStateStore = useUiStateStore();

  // A draft store owns only its own memory, so a ref suffices.
  const draftStoreRef = useRef<DraftStore>(undefined);
  draftStoreRef.current ??= new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT });

  const sessionStoreRegistry = useSessionStoreRegistry(entityProjectorRegistry, props.readSession);

  const appStores: AppStores = {
    sessionStoreRegistry,
    uiStateStore,
    draftStore: draftStoreRef.current,
  };

  // Main keeps the appearance; every window applies what main kept and asks main for a change.
  const appearance = useAppearance(bridge, openWindows);

  useLazyBodyIdleWarm(paneRegistry, screenRegistry);

  const windows = useSyncExternalStore(
    useCallback((onChange: () => void) => openWindows.subscribe(onChange), [openWindows]),
    useCallback(() => openWindows.list(), [openWindows]),
  );

  // Each window's frame store, kept here so the app's commands act on the window used last.
  const frameStoresRef = useRef(new Map<string, WindowStore>());
  const frameStoreFor = (openWindow: OpenWindow): WindowStore => {
    const frameStores = frameStoresRef.current;
    let frameStore = frameStores.get(openWindow.windowId);
    if (frameStore === undefined) {
      // The window store starts on the window's opening address, or it would publish its
      // default route over that address.
      frameStore = new WindowStore({
        initialRoute: parseRoute(openWindow.window.location.hash),
        ownerDocument: openWindow.window.document,
      });
      frameStores.set(openWindow.windowId, frameStore);
    }
    return frameStore;
  };
  const windowStoreUsedLast = useCallback((): WindowStore | undefined => {
    const usedLast = openWindows.list()[0];
    return usedLast === undefined ? undefined : frameStoresRef.current.get(usedLast.windowId);
  }, [openWindows]);
  const documentUsedLast = useCallback(
    (): Document | undefined => openWindows.list()[0]?.window.document,
    [openWindows],
  );

  const commandRevision = useAppCommands({
    windowStoreUsedLast,
    documentUsedLast,
    keyboardMap: bridge.keyboardMap,
    appearance,
    screenRegistry,
  });

  // Read once: main marks the console document it serves, and the mark does not change.
  const [isSafeStart] = useState(() =>
    consoleDocument.documentElement.hasAttribute(SAFE_START_ATTRIBUTE),
  );
  // Whether the kept layout follows the open windows; not in a safe start until it is restored.
  const [isLayoutKept, setLayoutKept] = useState(!isSafeStart);

  useEffect(() => {
    let isOpening = true;
    const stopPreparing = openWindows.prepareEveryDocument(prepareWindowDocument);
    const windowUsedLast = bridge.window.lastUsedWindowId;
    const consoleLocation = consoleDocument.location;
    if (isSafeStart) {
      openAt(openWindows, windowUsedLast, DEFAULT_ROUTE);
    } else {
      openAt(openWindows, windowUsedLast, parseRoute(consoleLocation.hash));
      void readKeptWindowIds(uiStateStore).then((keptWindowIds) => {
        if (isOpening) {
          for (const windowId of keptWindowIds) {
            openAt(openWindows, windowId, DEFAULT_ROUTE);
          }
        }
      });
    }
    // The launch's address went to the window used last; the console document routes nothing.
    consoleDocument.defaultView?.history.replaceState(
      null,
      "",
      `${consoleLocation.pathname}${consoleLocation.search}`,
    );
    return () => {
      isOpening = false;
      stopPreparing();
      openWindows.closeAll();
    };
  }, [openWindows, bridge, isSafeStart, uiStateStore, consoleDocument]);

  // A closed window's frame store goes with it.
  useEffect(
    () =>
      openWindows.subscribe(() => {
        const open = new Set(openWindows.list().map((openWindow) => openWindow.windowId));
        for (const windowId of frameStoresRef.current.keys()) {
          if (!open.has(windowId)) {
            frameStoresRef.current.delete(windowId);
          }
        }
      }),
    [openWindows],
  );

  // The kept layout follows the open windows, dropping a closed one only while another stays
  // open, so the last window closed comes back on the next start.
  useEffect(() => {
    if (!isLayoutKept) {
      return undefined;
    }
    const keep = (): void => {
      const open = openWindows.list();
      if (open.length > 0) {
        void keepWindowIds(
          uiStateStore,
          open.map((openWindow) => openWindow.windowId),
        );
      }
    };
    keep();
    return openWindows.subscribe(keep);
  }, [isLayoutKept, openWindows, uiStateStore]);

  const restoreWindows = useCallback(() => {
    void readKeptWindowIds(uiStateStore).then((keptWindowIds) => {
      for (const windowId of keptWindowIds) {
        openAt(openWindows, windowId, DEFAULT_ROUTE);
      }
      setLayoutKept(true);
    });
  }, [openWindows, uiStateStore]);

  return (
    <>
      {windows.map((openWindow) => (
        <AppWindow
          key={openWindow.windowId}
          openWindow={openWindow}
          frameStore={frameStoreFor(openWindow)}
          bridge={bridge}
          appStores={appStores}
          appearance={appearance}
          commandRevision={commandRevision}
          appTitle={consoleDocument.title}
          notice={isLayoutKept ? undefined : <SafeStartNotice onRestoreWindows={restoreWindows} />}
        />
      ))}
    </>
  );
}

/**
 * Open `windowId` on `route`; nothing for a window already open. The address is written before
 * anything is drawn, so the window's store starts on it. It is written as the hash alone: a blank
 * document resolves a whole address against its opener's, which it may not take.
 */
function openAt(openWindows: OpenWindows, windowId: string, route: AppRoute): void {
  if (openWindows.list().some((openWindow) => openWindow.windowId === windowId)) {
    return;
  }
  openWindows.open(windowId).window.location.hash = formatRoute(route);
}
