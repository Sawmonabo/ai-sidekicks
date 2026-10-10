// Every window a person sees, drawn from the console document. The console document is never
// shown; it keeps what every window shares (the session stores, the UI-state store, the drafts, the
// appearance and the app's commands) and opens each window with `window.open`: the window used last
// first, on the address the launch named, then the rest from the kept window layout, each on the
// address it was kept on, and reopens the window main asks for when none is open
// (`useKeptWindowLayout`). A safe start opens that one window on the sessions list, reads no kept
// layout and leaves it as it was, and says so in a line whose `Restore windows` reopens the kept
// windows and ends the safe start.

import { useCallback, useEffect, useState } from "react";

import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { type OpenWindows } from "#renderer/services/window/open-windows.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "#renderer/store/persistence/caps.js";
import { DraftStore } from "#renderer/store/drafts.js";
import { type SessionBaseStateReader } from "#renderer/store/session/open/entry.js";
import { entityProjectorRegistry } from "#renderer/registries/entity-projectors/registry.js";
import { paneRegistry } from "#renderer/registries/panes/registry.js";
import { screenRegistry } from "#renderer/registries/screens/registry.js";
import { SafeStartNotice } from "#renderer/layout/AppShell/SafeStartNotice.js";
import { useAppCommands } from "./hooks/useAppCommands.js";
import { useAppearance } from "./hooks/useAppearance.js";
import { useKeptWindowLayout } from "./hooks/useKeptWindowLayout.js";
import { useLazyBodyIdleWarm } from "./hooks/useLazyBodyIdleWarm.js";
import { useSendPaneWindowWidths } from "./hooks/useSendPaneWindowWidths.js";
import { useSessionStoreRegistry } from "./hooks/useSessionStoreRegistry.js";
import { useLastSettingsPage } from "./hooks/useLastSettingsPage.js";
import { useUiStateStore } from "./hooks/useUiStateStore.js";
import { useWindowStores } from "./hooks/useWindowStores.js";
import { AppWindow, type AppStores } from "./AppWindow.js";
import { discloseUnkeptMenuSchemes } from "./unkept-scheme.js";

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
  const lastSettingsPage = useLastSettingsPage(uiStateStore);

  const [draftStore] = useState(
    () => new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
  );

  const sessionStoreRegistry = useSessionStoreRegistry(entityProjectorRegistry, props.readSession);

  const appStores: AppStores = {
    sessionStoreRegistry,
    uiStateStore,
    draftStore,
    lastSettingsPage,
  };

  // Main keeps the appearance; every window applies what main kept and asks main for a change.
  const appearance = useAppearance(bridge, openWindows);
  useSendPaneWindowWidths(bridge, appearance);

  // A window opened again comes forward through main, which keeps test windows unobtrusive.
  useEffect(
    () =>
      openWindows.bringForwardThrough((windowId) => {
        bridge.window.bringForward(windowId).catch((failure: unknown) => {
          recordRejectedRequest("app/AppWindows", "bring-forward-failed", failure);
        });
      }),
    [openWindows, bridge],
  );

  useLazyBodyIdleWarm(paneRegistry, screenRegistry);

  // Each window's frame store, kept here so the app's commands act on the window used last.
  const { windowStores, windows, hasServiceAnswered } = useWindowStores(openWindows, bridge);
  const windowStoreUsedLast = useCallback(() => windowStores.list()[0]?.store, [windowStores]);
  // A View-menu scheme main could not save is told on the window used last.
  useEffect(
    () => discloseUnkeptMenuSchemes(bridge.window, windowStoreUsedLast),
    [bridge, windowStoreUsedLast],
  );
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
    lastSettingsPage,
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
      {windows.map(({ openWindow, store }) => (
        <AppWindow
          key={openWindow.windowId}
          openWindow={openWindow}
          frameStore={store}
          bridge={bridge}
          appStores={appStores}
          appearance={appearance}
          commandRevision={commandRevision}
          appTitle={consoleDocument.title}
          hasServiceAnswered={hasServiceAnswered}
          notice={
            isRestoreOffered ? <SafeStartNotice onRestoreWindows={restoreWindows} /> : undefined
          }
        />
      ))}
    </>
  );
}
