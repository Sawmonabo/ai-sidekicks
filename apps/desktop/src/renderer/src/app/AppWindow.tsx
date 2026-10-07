// One window a person sees: its frame store, the bindings that keep it live, and the `AppShell`
// around the routed screen, drawn into the window's own document through a portal from the console
// document's tree. Everything below reads the window it is in from `OwnerWindowProvider`, and runs
// its frame work on that window's own paint through `WindowClockProvider`.

import { useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { OwnerWindowProvider } from "#renderer/components/OwnerWindow/OwnerWindowProvider.js";
import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import { useLocationHash } from "#renderer/routing/hooks/useLocationHash.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { WindowClockProvider } from "#renderer/services/platform/WindowClockProvider.js";
import type { AppearanceClient } from "#renderer/services/window/appearance-client.js";
import type { OpenWindow } from "#renderer/services/window/open-windows.js";
import { type DraftStore } from "#renderer/store/drafts.js";
import { type LastSettingsPage } from "#renderer/store/last-settings-page.js";
import { type UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import { type SessionStoreRegistry } from "#renderer/store/session/registry.js";
import { useWindowStore } from "#renderer/store/window/hooks/useWindowStore.js";
import { type WindowStore } from "#renderer/store/window/store.js";
import type { SchemePreference } from "#renderer/styles/tokens.js";
import { paneRegistry } from "#renderer/registries/panes/registry.js";
import { type ScreenContext } from "#renderer/registries/screens/context.js";
import { screenRegistry } from "#renderer/registries/screens/registry.js";
import { AppShell } from "#renderer/layout/AppShell/AppShell.js";
import { PANE_LAYOUT_LOOSEST_MINIMUM_PANE_WIDTH_PX } from "#renderer/features/sessions/index.js";
import { useActiveSessionStore } from "./hooks/useActiveSessionStore.js";
import { useHashRouteBinding } from "./hooks/useHashRouteBinding.js";
import { useWindowFocusRefresh } from "./hooks/useWindowFocusRefresh.js";
import { useWindowCommands } from "./hooks/useWindowCommands.js";
import { useWindowTitle } from "./hooks/useWindowTitle.js";
import { AppRouter } from "./AppRouter.js";
import { discloseUnkeptScheme } from "./unkept-scheme.js";
import { windowMountPoint } from "./window/document.js";

/** The stores every window shares, which the app keeps for as long as it runs. */
export interface AppStores {
  readonly sessionStoreRegistry: SessionStoreRegistry;
  readonly uiStateStore: UiStateStore;
  readonly draftStore: DraftStore;
  readonly lastSettingsPage: LastSettingsPage;
}

/** What the app hands one window. */
export interface AppWindowProps {
  readonly openWindow: OpenWindow;
  /** This window's frame store, which the app keeps so its commands can act on it. */
  readonly frameStore: WindowStore;
  readonly bridge: PlatformBridge;
  readonly appStores: AppStores;
  readonly appearance: AppearanceClient;
  /** The app's command revision, bumped when the command set changed. */
  readonly commandRevision: number;
  /** The app's own name, the title of a window whose route names nothing more particular. */
  readonly appTitle: string;
  /** One line about the window itself, drawn above its banners. */
  readonly notice?: ReactNode;
}

/** One window: its stores and bindings and its `AppShell`, drawn in its own document. */
export function AppWindow(props: AppWindowProps): React.JSX.Element {
  const ownerWindow = props.openWindow.window;
  return createPortal(
    <OwnerWindowProvider window={ownerWindow}>
      <WindowClockProvider frames={ownerWindow}>
        <WindowContents {...props} />
      </WindowClockProvider>
    </OwnerWindowProvider>,
    windowMountPoint(ownerWindow.document),
    props.openWindow.windowId,
  );
}

/**
 * The window's bindings and chrome. The palette follows the retained session, so session commands
 * stay offered from Settings.
 */
function WindowContents(props: AppWindowProps): React.JSX.Element {
  const { frameStore, bridge, appStores, appearance } = props;
  const ownerWindow = props.openWindow.window;
  const hash = useLocationHash(ownerWindow);

  const route = useWindowStore(frameStore, (state) => state.route);
  const lastOpenedSessionId = useWindowStore(frameStore, (state) => state.lastOpenedSessionId);

  useHashRouteBinding(frameStore, hash, ownerWindow);

  // Focus triggers a refresh; nothing polls.
  useWindowFocusRefresh(frameStore, appStores.sessionStoreRegistry, ownerWindow);

  useWindowTitle(ownerWindow, route, props.appTitle);

  const palette = useWindowCommands({
    route,
    lastOpenedSessionId,
    ownerWindow,
    revision: props.commandRevision,
  });

  const chooseScheme = useCallback(
    (preference: SchemePreference) => {
      discloseUnkeptScheme(appearance.chooseScheme(preference), frameStore);
    },
    [appearance, frameStore],
  );

  const sessionStore = useActiveSessionStore(
    appStores.sessionStoreRegistry,
    frameStore.activeSessionId,
  );

  const screenContext: ScreenContext = {
    route,
    bridge,
    frameStore,
    sessionStore,
    sessionStoreRegistry: appStores.sessionStoreRegistry,
    paneRegistry,
    uiStateStore: appStores.uiStateStore,
    draftStore: appStores.draftStore,
    lastSettingsPage: appStores.lastSettingsPage,
    chooseScheme,
  };

  return (
    <AppShell
      frameStore={frameStore}
      screenRegistry={screenRegistry}
      lastSettingsPage={appStores.lastSettingsPage}
      palette={palette}
      notice={props.notice}
      // The loosest density's floor, so the window holds one pane beside the conversation at
      // whichever density the pane layout runs at; in px as the layout holds it, so it does not
      // grow with the text size.
      minimumPaneWidthPx={PANE_LAYOUT_LOOSEST_MINIMUM_PANE_WIDTH_PX}
      onWindowFloorChange={(floor) => {
        bridge.window.setMinimumSize(props.openWindow.windowId, floor).catch((failure: unknown) => {
          recordRejectedRequest("app/AppWindow", "minimum-size-not-set", failure);
        });
      }}
    >
      <AppRouter context={screenContext} />
    </AppShell>
  );
}
