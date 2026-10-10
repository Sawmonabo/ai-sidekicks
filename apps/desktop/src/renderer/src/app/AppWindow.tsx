// One window a person sees: its frame store, the bindings that keep it live, the `AppShell`
// around the routed screen and the window's one hover label, drawn into the window's own document
// through a portal from the console document's tree. Until the background service first answers
// the window draws only its boot cover, so no screen reads a service that is not there yet and
// nothing is drawn half painted; at the answer the console mounts under the cover as it fades.
// Everything below reads the window it is in from `OwnerWindowProvider`, and runs its frame work
// on that window's own paint through `WindowClockProvider`.

import { useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { WindowHoverLabel } from "#renderer/components/HoverLabel/WindowHoverLabel.js";
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
import { useIsUpdateStaged } from "#renderer/store/update/hooks/useIsUpdateStaged.js";
import { useWindowStore } from "#renderer/store/window/hooks/useWindowStore.js";
import { type WindowStore } from "#renderer/store/window/store.js";
import type { SchemePreference } from "#renderer/styles/tokens.js";
import { paneRegistry } from "#renderer/registries/panes/registry.js";
import { type ScreenContext } from "#renderer/registries/screens/context.js";
import { screenRegistry } from "#renderer/registries/screens/registry.js";
import { AppShell } from "#renderer/layout/AppShell/AppShell.js";
import { BootCover } from "#renderer/layout/AppShell/BootCover.js";
import { useBootCover } from "#renderer/layout/AppShell/hooks/useBootCover.js";
import { PANE_LAYOUT_LOOSEST_MINIMUM_PANE_WIDTH_PX } from "#renderer/features/sessions/index.js";
import { useActiveSessionStore } from "./hooks/useActiveSessionStore.js";
import { useHashRouteBinding } from "./hooks/useHashRouteBinding.js";
import { useWindowFocusRefresh } from "./hooks/useWindowFocusRefresh.js";
import { useWindowCommands } from "./hooks/useWindowCommands.js";
import { useWindowTitle } from "./hooks/useWindowTitle.js";
import { AppRouter } from "./AppRouter.js";
import { chooseNextColorScheme, discloseUnkeptScheme } from "./unkept-scheme.js";
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
  /** Whether the service has answered since the app opened; it never goes back to false. */
  readonly hasServiceAnswered: boolean;
  /** One line about the window itself, drawn above its banners. */
  readonly notice?: ReactNode;
}

/**
 * One window: its stores and bindings, its `AppShell` and its hover label, drawn in its own
 * document, under its boot cover until the service first answers.
 */
export function AppWindow(props: AppWindowProps): React.JSX.Element {
  const ownerWindow = props.openWindow.window;
  return createPortal(
    <OwnerWindowProvider window={ownerWindow}>
      <WindowClockProvider frames={ownerWindow}>
        <WindowBody {...props} />
        <WindowHoverLabel />
      </WindowClockProvider>
    </OwnerWindowProvider>,
    windowMountPoint(ownerWindow.document),
    props.openWindow.windowId,
  );
}

/** The window's title, its console once the service has answered, and its boot cover. */
function WindowBody(props: AppWindowProps): React.JSX.Element {
  const { frameStore, hasServiceAnswered } = props;
  const route = useWindowStore(frameStore, (state) => state.route);
  useWindowTitle(props.openWindow.window, route, props.appTitle);
  const cover = useBootCover(frameStore, hasServiceAnswered);
  return (
    <>
      {hasServiceAnswered ? <WindowContents {...props} /> : null}
      {cover === undefined ? null : (
        <BootCover cover={cover} requestStart={props.bridge.daemon.requestStart} />
      )}
    </>
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

  const { palette, readBoundChord } = useWindowCommands({
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

  const cycleColorScheme = useCallback(() => {
    chooseNextColorScheme(appearance, frameStore);
  }, [appearance, frameStore]);

  // The window's one reading of the updater, which the rail's Settings dot reads.
  const isUpdateStaged = useIsUpdateStaged(bridge.update);

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
      readBoundChord={readBoundChord}
      onCycleColorScheme={cycleColorScheme}
      isUpdateStaged={isUpdateStaged}
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
