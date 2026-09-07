// The window itself: the stores it keeps, the bindings that keep them live, and
// what it hands `AppFrame`.
//
// Everything here runs with a RESOLVED bridge, because `ConsoleFrameHost.tsx` above
// it is the gate. The pieces this file used to hold inline are siblings —
// `RouteSurface.tsx` resolves a route to a surface, `frame-commands.ts` carries the
// frame's own commands and chords, `rail-navigation.ts` builds the rail,
// `session-lifecycle.ts` owns the session registry, `ui-state-lifecycle.ts` owns the
// durable store's life, and `scheme-preference.ts` owns the colour scheme end to
// end — and every decision below is one the rest of the substrate depends on:
//
//   • **One store per window, created once.** `useRef` rather than `useMemo`: a
//     memo may be discarded and recomputed, and a recreated `SessionStore` would
//     silently drop every event applied so far. React documents `useMemo` as a
//     performance hint; store identity is correctness. The two stores that own a
//     resource beyond their own memory — the session registry's subscriptions and
//     the UI-state store's database connection — are held by hooks instead, because
//     a ref has no teardown and both of those have to be given one.
//   • **The route follows the hash, and the hash follows the route.** Both
//     directions, because the Window menu opens auxiliary windows by URL and the
//     rail navigates in-window — owned by `hash-route-binding.ts`, which is where
//     the rules that make a two-way binding terminate are written down. The store is
//     still BORN on the hash the window opened with rather than adopting it one
//     commit later: a store that started on the default route left the route-to-hash
//     direction publishing that default on the very first pass — long enough to
//     overwrite the address an auxiliary window was opened at with `#/sessions`.
//   • **The palette follows the RETAINED session, not the route.** The registry
//     keeps a session open after the route leaves it, so "Go to Workspace" stays
//     offered from Settings and goes back to the session that is still open.
//     `RouteSurface` still reads the route's own session, which is a different
//     question — what to render now, rather than where to go back to.
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
//     touches `window.sidekicks`.
//   • **The family-owned frame-lifetime reads wrap this whole subtree.** A view
//     family cannot be imported here — `console-view-family-isolation` forbids the
//     frame from naming one — so a read whose value the rail renders reaches the
//     window through the frame-binding board the composition filled, and the fold
//     around the return is where it is mounted. Once per window, up with the frame
//     and down with it, so a destination that used to hold such a read is now a
//     reader of it and navigating away no longer ends it.

import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";

import { type ConsoleBridge } from "../bridge/index.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "../core/index.js";
import { CONSOLE_CHORD_PLATFORM, PaletteOverlay, consoleCommands } from "../palette/index.js";
import { DraftStore } from "../persistence/index.js";
import { parseRoute, railDestinationFor } from "../routing/index.js";
import {
  consolePaneRegistry,
  consoleSurfaceRegistry,
  frameBindingRegistry,
  mountFrameBindings,
  type FrameBindingContext,
} from "../seats/index.js";
import {
  FrameStore,
  consoleEntityProjectorRegistry,
  shellMutationBlock,
  useFrameStore,
  useLocationHash,
  useRailAttentionCount,
  useShellState,
} from "../store/index.js";
import { AppFrame } from "./AppFrame.js";
import { describeScope, useFrameCommandSurface } from "./frame-commands.js";
import { useHashRouteBinding } from "./hash-route-binding.js";
import { useLazyBodyIdleWarm } from "./lazy-body-warm-binding.js";
import {
  railEntriesWithAttention,
  routeForDestination,
  warmDestination,
} from "./rail-navigation.js";
import { ShellChrome, useDaemonStartAction, useShellStateBinding } from "./shell-state/index.js";
import { RouteSurface } from "./RouteSurface.js";
import { useSchemePreference } from "./scheme-preference.js";
import { useActiveSessionStore, useSessionStoreRegistry } from "./session-lifecycle.js";
import { type ConsoleSurfaceContext } from "../seats/index.js";
import { applyConsoleScheme } from "./token-installation.js";
import { useUiStateStore } from "./ui-state-lifecycle.js";

export interface ConsoleFrameProps {
  readonly bridge: ConsoleBridge;
  readonly renderOverlays?: (context: ConsoleSurfaceContext) => ReactNode;
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
  // ref has nowhere to close one from. `ui-state-lifecycle.ts` says what an unclosed
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
  const sessionStoreRegistry = useSessionStoreRegistry(consoleEntityProjectorRegistry);

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
  // owner. `hash-route-binding.ts` says why one owner and not two effects here.
  useHashRouteBinding(frameStore, hash);

  // Every loader-backed body on both boards, warmed once after this window's first
  // frame. `lazy-body-warm-binding.ts` says why this is what a loader costs a person
  // rather than a launch: the chunks are fetched on idle callbacks, so the first open
  // of any pane or destination is warm and none of it was charged to the launch.
  useLazyBodyIdleWarm(consolePaneRegistry, consoleSurfaceRegistry);

  // What this window knows about the shell it is running against, kept live for the
  // frame's lifetime. One binding rather than a reader per consumer: the palette,
  // the settings daemon page, and the chrome all read the same store field, and a
  // second subscription would be a second answer to the same question.
  useShellStateBinding(frameStore, sessionStoreRegistry);
  const startDaemon = useDaemonStartAction(frameStore);

  // The rail's count, published by whichever surface performed the attention read.
  // Memoised so the entries keep their identity while the count does — the rail is
  // the most-seen surface in the window and re-rendering it is the one cost this
  // frame pays on every pass if it is not held.
  const railAttentionCount = useRailAttentionCount(frameStore);
  // The one derivation of "is this window read-only", read from the store's shell
  // state so the palette's line and every disabled control name the same cause.
  const shellBlock = shellMutationBlock(useShellState(frameStore));
  const railEntries = useMemo(
    () => railEntriesWithAttention(railAttentionCount),
    [railAttentionCount],
  );

  // Window focus is a refresh reason, not a poll.
  //
  // The re-read rides the TRANSITION into focus rather than the event itself. A
  // window that never lost focus missed nothing, so re-reading every open session
  // on a focus event a person did not cause would be the poll this design refuses;
  // a window that WAS blurred may have missed a delivery or a read while nobody was
  // looking, and its open stores are stale until something asks for them again.
  //
  // Whether the window was focused is read back from the store rather than kept in
  // a ref beside it. The store already holds that fact — `isWindowFocused` is what
  // the scheduler's `window-focus` reason is named for — and a second copy would be
  // the same value recorded twice, free to disagree.
  useEffect(() => {
    const onFocus = (): void => {
      if (frameStore.getState().isWindowFocused) {
        return;
      }
      frameStore.setWindowFocused(true);
      sessionStoreRegistry.requestRefreshOfEverySession("window-focus");
    };
    const onBlur = (): void => {
      frameStore.setWindowFocused(false);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [frameStore, sessionStoreRegistry]);

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
          railEntries={railEntries}
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
          shellChrome={<ShellChrome frameStore={frameStore} onRetry={startDaemon} />}
          banners={banners}
          onDismissBanner={(bannerId) => {
            frameStore.dismissBanner(bannerId);
          }}
          overlays={
            <>
              <PaletteOverlay
                registry={consoleCommands}
                context={commandSurface.whenContext}
                open={commandSurface.paletteOpen}
                onOpenChange={commandSurface.setPaletteOpen}
                platform={CONSOLE_CHORD_PLATFORM}
                bindings={commandSurface.keyBindings}
                scopeLabel={describeScope(route)}
                {...(shellBlock === undefined ? {} : { shellBlock })}
                revision={commandSurface.commandRevision}
              />
              {props.renderOverlays === undefined ? null : props.renderOverlays(surfaceContext)}
            </>
          }
        >
          <RouteSurface context={surfaceContext} />
        </AppFrame>,
      )}
    </>
  );
}
