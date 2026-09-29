// The window: the stores it keeps, the bindings that keep them live, and the shell it
// renders the routed screen in.
//
// Everything here runs with a resolved bridge, because `AppBootstrap` above it is the
// gate.
//
//   • **One store per window, created once.** `useRef` rather than `useMemo`: a memo may
//     be discarded and recomputed, and a recreated store would silently drop every event
//     applied so far. The two stores that own a resource beyond their memory, the
//     session registry's subscriptions and the UI-state store's database connection, are
//     held by hooks instead, because a ref has no teardown.
//   • **The window store is born on the hash the window opened with.** A store that
//     started on the default route would publish that default to the hash on the first
//     pass and overwrite the address the window was opened at.
//   • **The palette follows the retained session, not the route.** The registry keeps a
//     session open after the route leaves it, so a command that needs one stays offered
//     from Settings; the router still reads the route's own session.

import { useLayoutEffect, useRef } from "react";

import { type ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { useWindowStore } from "@renderer/store/window/hooks/useWindowStore.js";
import { useLocationHash } from "@renderer/routing/hooks/useLocationHash.js";
import { parseRoute } from "@renderer/routing/routes.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { type SessionSnapshotReader } from "@renderer/store/session/open-session-entry.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { entityProjectorRegistry } from "@renderer/registries/entity-projectors/entity-projector-registry.js";
import { paneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";
import { screenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { AppShell } from "@renderer/layout/AppShell/AppShell.js";
import { useActiveSessionStore } from "./hooks/useActiveSessionStore.js";
import { useHashRouteBinding } from "./hooks/useHashRouteBinding.js";
import { useLazyBodyIdleWarm } from "./hooks/useLazyBodyIdleWarm.js";
import { useSchemePreference } from "./hooks/useSchemePreference.js";
import { useSessionStoreRegistry } from "./hooks/useSessionStoreRegistry.js";
import { useUiStateStore } from "./hooks/useUiStateStore.js";
import { useWindowFocusRefresh } from "./hooks/useWindowFocusRefresh.js";
import { useWindowCommands } from "./hooks/useWindowCommands.js";
import { AppRouter } from "./router.js";
import { applyColorScheme } from "./token-installation.js";

/** What the bootstrap hands the window once the bridge has resolved. */
export interface AppWindowProps {
  readonly bridge: ConsoleBridge;
  /** The call that reads one session's base state, handed to the session registry. */
  readonly readSession: SessionSnapshotReader;
}

/** The window: its stores and bindings, and the shell around the screen the route names. */
export function AppWindow(props: AppWindowProps): React.JSX.Element {
  // Read first, because the window store is born on it; it also keeps the
  // hash-to-route direction live for every later navigation.
  const hash = useLocationHash();

  const frameStoreRef = useRef<WindowStore>(undefined);
  frameStoreRef.current ??= new WindowStore({ initialRoute: parseRoute(hash) });
  const frameStore = frameStoreRef.current;

  // A hook, because this store owns a database connection; its opening returns at once,
  // so first paint waits on no storage.
  const uiStateStore = useUiStateStore();

  // A ref is enough: a draft store owns a `Map` and nothing outside its own memory.
  const draftStoreRef = useRef<DraftStore>(undefined);
  draftStoreRef.current ??= new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT });
  const draftStore = draftStoreRef.current;

  // The stores fold with what the composition claimed, handed in rather than reached for.
  const sessionStoreRegistry = useSessionStoreRegistry(entityProjectorRegistry, props.readSession);

  const route = useWindowStore(frameStore, (state) => state.route);
  const lastOpenedSessionId = useWindowStore(frameStore, (state) => state.lastOpenedSessionId);
  const { schemePreference, chooseScheme } = useSchemePreference(frameStore, uiStateStore);

  // The token sheet is already on the document; the scheme attribute follows a setting
  // only a window with a bridge can read back.
  useLayoutEffect(() => {
    applyColorScheme(document, schemePreference);
  }, [schemePreference]);

  useHashRouteBinding(frameStore, hash);

  // Every loader-backed body on both boards, warmed on idle after the first frame.
  useLazyBodyIdleWarm(paneRegistry, screenRegistry);

  // Window focus is a refresh reason, not a poll.
  useWindowFocusRefresh(frameStore, sessionStoreRegistry);

  const palette = useWindowCommands({
    route,
    lastOpenedSessionId,
    windowStore: frameStore,
    uiStateStore,
    chooseScheme,
    surfaceRegistry: screenRegistry,
  });

  const sessionStore = useActiveSessionStore(sessionStoreRegistry, frameStore.activeSessionId);

  const surfaceContext: ScreenContext = {
    route,
    bridge: props.bridge,
    frameStore,
    sessionStore,
    sessionStoreRegistry,
    // The board the composition registered every pane body into.
    paneRegistry: paneRegistry,
    uiStateStore,
    draftStore,
    chooseScheme,
  };

  return (
    <AppShell frameStore={frameStore} surfaceRegistry={screenRegistry} palette={palette}>
      <AppRouter context={surfaceContext} />
    </AppShell>
  );
}
