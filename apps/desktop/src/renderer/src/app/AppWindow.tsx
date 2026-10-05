// The window: the stores it keeps, the bindings that keep them live, and the `AppShell` around
// the routed screen. It runs only with a resolved bridge, because `AppBootstrap` gates it.

import { useRef } from "react";

import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { useWindowStore } from "@renderer/store/window/hooks/useWindowStore.js";
import { useLocationHash } from "@renderer/routing/hooks/useLocationHash.js";
import { parseRoute } from "@renderer/routing/routes.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { type SessionBaseStateReader } from "@renderer/store/session/open-session-entry.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { entityProjectorRegistry } from "@renderer/registries/entity-projectors/entity-projector-registry.js";
import { paneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";
import { screenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { AppShell } from "@renderer/layout/AppShell/AppShell.js";
import { useActiveSessionStore } from "./hooks/useActiveSessionStore.js";
import { useAppearance } from "./hooks/useAppearance.js";
import { useDaemonStatusReport } from "./hooks/useDaemonStatusReport.js";
import { useHashRouteBinding } from "./hooks/useHashRouteBinding.js";
import { useLazyBodyIdleWarm } from "./hooks/useLazyBodyIdleWarm.js";
import { useSessionStoreRegistry } from "./hooks/useSessionStoreRegistry.js";
import { useUiStateStore } from "./hooks/useUiStateStore.js";
import { useWindowFocusRefresh } from "./hooks/useWindowFocusRefresh.js";
import { useWindowCommands } from "./hooks/useWindowCommands.js";
import { AppRouter } from "./AppRouter.js";

/** What the bootstrap hands the window once the bridge has resolved. */
export interface AppWindowProps {
  readonly bridge: PlatformBridge;
  /** The call that reads one session's base state, handed to the session registry. */
  readonly readSession: SessionBaseStateReader;
}

/**
 * The window: its stores and bindings, and the `AppShell` around the screen the route names.
 *
 * Refs hold the window and draft stores because a memo may be recomputed and a recreated store
 * would drop every event applied so far; the registry and UI-state stores own resources
 * (subscriptions, a database connection), so hooks hold them for teardown. The window store
 * starts on the opening hash, or it would publish its default route over that address. The
 * palette follows the retained session, so session commands stay offered from Settings.
 */
export function AppWindow(props: AppWindowProps): React.JSX.Element {
  // Read first: the window store starts on it.
  const hash = useLocationHash();

  const frameStoreRef = useRef<WindowStore>(undefined);
  frameStoreRef.current ??= new WindowStore({ initialRoute: parseRoute(hash) });
  const frameStore = frameStoreRef.current;

  // Opening the database connection returns at once, so first paint waits on no storage.
  const uiStateStore = useUiStateStore();

  // A draft store owns only its own memory, so a ref suffices.
  const draftStoreRef = useRef<DraftStore>(undefined);
  draftStoreRef.current ??= new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT });
  const draftStore = draftStoreRef.current;

  const sessionStoreRegistry = useSessionStoreRegistry(entityProjectorRegistry, props.readSession);

  const route = useWindowStore(frameStore, (state) => state.route);
  const lastOpenedSessionId = useWindowStore(frameStore, (state) => state.lastOpenedSessionId);
  // Main keeps the appearance; the window applies what main kept and asks main for a change.
  const { chooseScheme, chooseNextScheme } = useAppearance(props.bridge, frameStore);

  useHashRouteBinding(frameStore, hash);

  useDaemonStatusReport(props.bridge, frameStore);

  useLazyBodyIdleWarm(paneRegistry, screenRegistry);

  // Focus triggers a refresh; nothing polls.
  useWindowFocusRefresh(frameStore, sessionStoreRegistry);

  const palette = useWindowCommands({
    route,
    lastOpenedSessionId,
    windowStore: frameStore,
    keyboardMap: props.bridge.keyboardMap,
    chooseNextScheme,
    screenRegistry,
  });

  const sessionStore = useActiveSessionStore(sessionStoreRegistry, frameStore.activeSessionId);

  const screenContext: ScreenContext = {
    route,
    bridge: props.bridge,
    frameStore,
    sessionStore,
    sessionStoreRegistry,
    paneRegistry: paneRegistry,
    uiStateStore,
    draftStore,
    chooseScheme,
  };

  return (
    <AppShell frameStore={frameStore} screenRegistry={screenRegistry} palette={palette}>
      <AppRouter context={screenContext} />
    </AppShell>
  );
}
