// The window itself: the stores it keeps, the bindings that keep them live, and
// what it hands `AppFrame`.
//
// Everything here runs with a RESOLVED bridge, because `ConsoleFrameHost.tsx` above
// it is the gate. The pieces this file used to hold inline are spread across the
// family's sub-modules — `RouteSurface.tsx` beside it resolves a route to a surface
// and `rail-navigation.ts` beside it builds the rail, `frame/frame-commands.ts` at the
// family root carries the frame's own commands and chords, `session/` owns the
// session registry, and `bindings/` owns the durable store's life, the window's focus
// transition, and the color scheme end to end — and every decision below is one the
// rest of the substrate depends on:
//
//   • **One store per window, created once.** `useRef` rather than `useMemo`: a
//     memo may be discarded and recomputed, and a recreated `SessionStore` would
//     silently drop every event applied so far. React documents `useMemo` as a
//     performance hint; store identity is correctness. The two stores that own a
//     resource beyond their own memory — the session registry's subscriptions and
//     the UI-state store's database connection — are held by hooks instead, because
//     a ref has no teardown and both of those have to be given one.
//   • **The route follows the hash, and the hash follows the route.** Both
//     directions, because a window can open at an address and the
//     rail navigates in-window — owned by `frame/bindings/hash-route-binding.ts`, which is where
//     the rules that make a two-way binding terminate are written down. The store is
//     still BORN on the hash the window opened with rather than adopting it one
//     commit later: a store that started on the default route left the route-to-hash
//     direction publishing that default on the very first pass — long enough to
//     overwrite the address the window was opened at with `#/sessions`.
//   • **The palette follows the RETAINED session, not the route.** The registry
//     keeps a session open after the route leaves it, so a command that needs one
//     stays offered from Settings. `RouteSurface` still reads the route's own
//     session, which is a different question — what to render now, rather than what
//     the window holds.
//   • **The frame's background is inert for exactly a modal overlay's lifetime.**
//     The dialog family traps focus and leaves inerting the app root to the shell,
//     and this file is the shell — so it is the only place that can hand `AppFrame`
//     the flag. It reads TWO producers and hands down one: the palette, whose open
//     state it owns outright, and the frame store's `isModalSurfaceOpen`, which is
//     how a card a VIEW family renders says it is up at all. The frame may not
//     import that family — `console-view-family-isolation` — so the card publishes
//     into the window store and this fold is where the two meet. Neither is a copy
//     of the other: the palette's state is not written to the store.
//   • **The bridge is provided, never reached for.** No component below this one
//     touches `window.desktopBridge`.
//   • **The family-owned frame-lifetime reads wrap this whole subtree.** A view
//     family cannot be imported here — `console-view-family-isolation` forbids the
//     frame from naming one — so a read whose value the rail renders reaches the
//     window through the frame-binding board the composition filled, and the fold
//     around the return is where it is mounted. Once per window, up with the frame
//     and down with it, so a destination that used to hold such a read is now a
//     reader of it and navigating away no longer ends it.

import { useLayoutEffect, useMemo, useRef } from "react";

import { type ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/console/core/constants/persistence-caps.js";
import {
  CONSOLE_CHORD_PLATFORM,
  PaletteOverlay,
  consoleCommands,
} from "@renderer/console/palette/index.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { parseRoute } from "@renderer/console/routing/routes.js";
import { railDestinationFor } from "@renderer/routing/route-readers.js";
import {
  consolePaneRegistry,
  consoleSurfaceRegistry,
  frameBindingRegistry,
  mountFrameBindings,
  type FrameBindingContext,
} from "@renderer/console/seats/index.js";
import { FrameStore } from "@renderer/store/window/window-store.js";
import { consoleEntityProjectorRegistry } from "@renderer/registries/entity-projectors/entity-projector-registry.js";
import { useFrameStore } from "@renderer/console/store/shell/frame-hooks.js";
import { useLocationHash } from "@renderer/routing/hooks/useLocationHash.js";
import { type SessionSnapshotReader } from "@renderer/store/session/open-session-entry.js";
import { AppFrame } from "./AppFrame.js";
import { describeScope, useFrameCommandSurface } from "@renderer/console/frame/frame-commands.js";
import { applyConsoleScheme } from "@renderer/app/token-installation.js";
import { useHashRouteBinding } from "@renderer/app/hooks/useHashRouteBinding.js";
import { useLazyBodyIdleWarm } from "@renderer/app/hooks/useLazyBodyIdleWarm.js";
import { useSchemePreference } from "@renderer/app/hooks/useSchemePreference.js";
import { useUiStateStore } from "@renderer/app/hooks/useUiStateStore.js";
import { useWindowFocusRefresh } from "@renderer/app/hooks/useWindowFocusRefresh.js";
import {
  RAIL_ENTRIES,
  routeForDestination,
  warmDestination,
} from "../NavigationRail/rail-navigation.js";
import { RouteSurface } from "@renderer/app/router.js";
import {
  useActiveSessionStore,
  useSessionStoreRegistry,
} from "@renderer/console/frame/session/session-lifecycle.js";
import { type ConsoleSurfaceContext } from "@renderer/console/seats/index.js";

export interface ConsoleFrameProps {
  readonly bridge: ConsoleBridge;
  /** The call that reads one session's base state, handed to the session registry. */
  readonly readSession: SessionSnapshotReader;
}

export function ConsoleFrame(props: ConsoleFrameProps): React.JSX.Element {
  // Read first, because the store is born on it. `useLocationHash` is a
  // subscription rather than a read, so this same value keeps the hash-to-route
  // direction live for every later navigation.
  const hash = useLocationHash();

  // Stores are per window and created exactly once.
  //
  // The frame store is seeded with the route the window OPENED at. The ref
  // initializer runs on the first render only, so this reads the opening hash and
  // never a later one — every later hash reaches the store through `adoptHash`.
  const frameStoreRef = useRef<FrameStore>(undefined);
  frameStoreRef.current ??= new FrameStore({ initialRoute: parseRoute(hash) });
  const frameStore = frameStoreRef.current;

  // A hook rather than a ref, because this store owns a database connection and a
  // ref has nowhere to close one from. `frame/bindings/ui-state-lifecycle.ts` says what an unclosed
  // one costs; `UiStateStore.opening` still returns immediately, so first paint
  // waits on no storage.
  const uiStateStore = useUiStateStore();

  // A ref is right for this one: a draft store owns a `Map` and nothing outside its
  // own memory, so the window dropping it is the whole of its teardown.
  const draftStoreRef = useRef<DraftStore>(undefined);
  draftStoreRef.current ??= new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT });
  const draftStore = draftStoreRef.current;

  // The window's stores fold with what the composition in `ConsoleRoot.tsx`
  // claimed, handed in rather than reached for — the same rule the two boards
  // beside it follow.
  const sessionStoreRegistry = useSessionStoreRegistry(
    consoleEntityProjectorRegistry,
    props.readSession,
  );

  const route = useFrameStore(frameStore, (state) => state.route);
  const banners = useFrameStore(frameStore, (state) => state.banners);
  // The session this window has in hand, which OUTLIVES a route that names none.
  const lastOpenedSessionId = useFrameStore(frameStore, (state) => state.lastOpenedSessionId);
  // The other half of the inert fold — see the background bullet in this file's
  // header. A boolean, so zustand's `Object.is` compares it by value and a window
  // with no card up re-renders on nothing.
  const isModalSurfaceOpen = useFrameStore(frameStore, (state) => state.isModalSurfaceOpen);
  const { schemePreference, chooseScheme } = useSchemePreference(frameStore, uiStateStore);

  // The sheet is already on the document — `ConsoleFrameHost` installed it above
  // the bridge gate. What is left here is the scheme attribute, which follows a
  // setting only a window with a bridge can read back.
  useLayoutEffect(() => {
    applyConsoleScheme(document, schemePreference);
  }, [schemePreference]);

  // The route follows the hash and the hash follows the route, both through one
  // owner. `frame/bindings/hash-route-binding.ts` says why one owner and not two effects here.
  useHashRouteBinding(frameStore, hash);

  // Every loader-backed body on both boards, warmed once after this window's first
  // frame. `frame/bindings/lazy-body-warm-binding.ts` says why this is what a loader costs a person
  // rather than a launch: the chunks are fetched on idle callbacks, so the first open
  // of any pane or destination is warm and none of it was charged to the launch.
  useLazyBodyIdleWarm(consolePaneRegistry, consoleSurfaceRegistry);

  // Window focus is a refresh reason, not a poll. `window-focus-refresh.ts` owns both
  // edges and says why the re-read rides the TRANSITION rather than the event.
  useWindowFocusRefresh(frameStore, sessionStoreRegistry);

  const activeSessionId = frameStore.activeSessionId;

  const commandSurface = useFrameCommandSurface({
    route,
    lastOpenedSessionId,
    frameStore,
    uiStateStore,
    chooseScheme,
    surfaceRegistry: consoleSurfaceRegistry,
  });

  const sessionStore = useActiveSessionStore(sessionStoreRegistry, activeSessionId);

  const surfaceContext: ConsoleSurfaceContext = {
    route,
    bridge: props.bridge,
    frameStore,
    sessionStore,
    sessionStoreRegistry,
    // The same board the composition above registered every family's bodies into, so
    // a surface that opens a pane resolves it from the board this window was composed
    // with rather than from whichever one a module happened to reach for.
    paneRegistry: consolePaneRegistry,
    uiStateStore,
    draftStore,
  };

  // What the window's family-owned frame-lifetime reads are handed. Three identities,
  // every one stable for the window's whole life — which is why the surface context
  // beside it is deliberately not what travels here: that one is composed fresh on
  // every render and carries the route, so a binding keyed on it would rebuild its
  // read whenever a person navigated, which is the lifetime a binding exists to
  // escape.
  const frameBindingContext = useMemo<FrameBindingContext>(
    () => ({ bridge: props.bridge, frameStore, sessionStoreRegistry }),
    [props.bridge, frameStore, sessionStoreRegistry],
  );

  // A fragment around the fold, so this component keeps its element return type while
  // `mountFrameBindings` keeps the honest one: a board with no registrations folds to
  // whatever it was handed, which the type system cannot know is an element.
  return (
    <>
      {mountFrameBindings(
        frameBindingRegistry,
        frameBindingContext,
        <AppFrame
          route={route}
          railEntries={RAIL_ENTRIES}
          railDestination={railDestinationFor(route)}
          onSelectDestination={(destination) => {
            // Warmed BEFORE the navigation, which is the whole of why the two lines are in
            // this order: `navigate` commits the route synchronously and the surface mounts
            // on the commit after it, so a fetch started first is already in flight when the
            // mount asks for the body. `rail-navigation.ts` says what a destination whose
            // surface is not loader-backed does here, which is nothing.
            warmDestination(consoleSurfaceRegistry, destination);
            frameStore.navigate(routeForDestination(destination));
          }}
          modalOverlayOpen={commandSurface.paletteOpen || isModalSurfaceOpen}
          banners={banners}
          onDismissBanner={(bannerId) => {
            frameStore.dismissBanner(bannerId);
          }}
          overlays={
            <PaletteOverlay
              registry={consoleCommands}
              context={commandSurface.whenContext}
              open={commandSurface.paletteOpen}
              onOpenChange={commandSurface.setPaletteOpen}
              platform={CONSOLE_CHORD_PLATFORM}
              bindings={commandSurface.keyBindings}
              scopeLabel={describeScope(route)}
              revision={commandSurface.commandRevision}
            />
          }
        >
          <RouteSurface context={surfaceContext} />
        </AppFrame>,
      )}
    </>
  );
}
