// Every window a person sees, drawn from the console document. The console document is never
// shown; it keeps what every window shares (the session stores, the UI-state store, the drafts, the
// appearance and the app's commands) and opens each window with `window.open`: the window used last
// first, on the address the launch named, then the rest from the kept window layout, each on the
// address it was kept on, and reopens the window main asks for when none is open
// (`useKeptWindowLayout`). A safe start opens that one window on the sessions list, reads no kept
// layout and leaves it as it was, and says so in a line whose `Restore windows` reopens the kept
// windows and ends the safe start.

import { useCallback, useState } from "react";

import { type PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { type OpenWindows } from "#renderer/services/window/open-windows.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "#renderer/store/persistence/caps.js";
import { DraftStore } from "#renderer/store/draft-store.js";
import { type SessionBaseStateReader } from "#renderer/store/session/open-session/open-session-entry.js";
import { entityProjectorRegistry } from "#renderer/registries/entity-projectors/entity-projector-registry.js";
import { paneRegistry } from "#renderer/registries/panes/pane-registry.js";
import { screenRegistry } from "#renderer/registries/screens/screen-registry.js";
import { SafeStartNotice } from "#renderer/layout/AppShell/SafeStartNotice.js";
import { useAppCommands } from "./hooks/useAppCommands.js";
import { useAppearance } from "./hooks/useAppearance.js";
import { useKeptWindowLayout } from "./hooks/useKeptWindowLayout.js";
import { useLazyBodyIdleWarm } from "./hooks/useLazyBodyIdleWarm.js";
import { useOpenWindowList } from "./hooks/useOpenWindowList.js";
import { useSessionStoreRegistry } from "./hooks/useSessionStoreRegistry.js";
import { useUiStateStore } from "./hooks/useUiStateStore.js";
import { useWindowStores } from "./hooks/useWindowStores.js";
import { AppWindow, type AppStores } from "./AppWindow.js";

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
 * The draft store owns only its own memory, so state holds it for the app's life; the registry,
 * UI-state and frame stores own resources (subscriptions, a database connection), so hooks hold
 * them for teardown.
 */
export function AppWindows(props: AppWindowsProps): React.JSX.Element {
  const { bridge, openWindows } = props;
  const consoleDocument = document;

  // Opening the database connection returns at once, so first paint waits on no storage.
  const uiStateStore = useUiStateStore();

  const [draftStore] = useState(
    () => new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
  );

  const sessionStoreRegistry = useSessionStoreRegistry(entityProjectorRegistry, props.readSession);

  const appStores: AppStores = {
    sessionStoreRegistry,
    uiStateStore,
    draftStore,
  };

  // Main keeps the appearance; every window applies what main kept and asks main for a change.
  const appearance = useAppearance(bridge, openWindows);

  useLazyBodyIdleWarm(paneRegistry, screenRegistry);

  const windows = useOpenWindowList(openWindows);

  // Each window's frame store, kept here so the app's commands act on the window used last.
  const windowStores = useWindowStores(openWindows, bridge);
  const windowStoreUsedLast = useCallback(() => {
    const usedLast = openWindows.list()[0];
    return usedLast === undefined ? undefined : windowStores.storeOf(usedLast.windowId);
  }, [openWindows, windowStores]);
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

  const { isRestoreOffered, restoreWindows } = useKeptWindowLayout({
    openWindows,
    bridge,
    uiStateStore,
    windowStores,
    consoleDocument,
  });

  return (
    <>
      {windows.map((openWindow) => (
        <AppWindow
          key={openWindow.windowId}
          openWindow={openWindow}
          frameStore={windowStores.storeFor(openWindow)}
          bridge={bridge}
          appStores={appStores}
          appearance={appearance}
          commandRevision={commandRevision}
          appTitle={consoleDocument.title}
          notice={
            isRestoreOffered ? <SafeStartNotice onRestoreWindows={restoreWindows} /> : undefined
          }
        />
      ))}
    </>
  );
}
