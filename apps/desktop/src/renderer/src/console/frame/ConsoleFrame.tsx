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
//   • **The frame's background is inert for exactly the palette's lifetime.** The
//     dialog family traps focus and leaves inerting the app root to the shell, and
//     this file is the shell: it owns the palette's open state, so it is the only
//     place that can hand `AppFrame` the flag.
//   • **The bridge is provided, never reached for.** No component below this one
//     touches `window.sidekicks`.

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import { type ConsoleBridge } from "../bridge/index.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "../core/index.js";
import { CONSOLE_CHORD_PLATFORM, PaletteOverlay, consoleCommands } from "../palette/index.js";
import { DraftStore } from "../persistence/index.js";
import { parseRoute, railDestinationFor } from "../routing/index.js";
import { consolePaneRegistry } from "../seats/index.js";
import {
  FrameStore,
  consoleEntityProjectorRegistry,
  useFrameStore,
  useLocationHash,
} from "../store/index.js";
import { AppFrame } from "./AppFrame.js";
import { DemoScenarioMark } from "./DemoScenarioMark.js";
import { playsTheDemonstrationScenario } from "./first-launch.js";
import { useFirstLaunchOpening } from "./first-launch-opening.js";
import { describeScope, useFrameCommandSurface } from "./frame-commands.js";
import { useHashRouteBinding } from "./hash-route-binding.js";
import { RAIL_ENTRIES, routeForDestination } from "./rail-navigation.js";
import { RouteSurface } from "./RouteSurface.js";
import { useSchemePreference } from "./scheme-preference.js";
import { VersionMark } from "./VersionMark.js";
import { useConsoleVersionReading } from "./version-mark.js";
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

  // The hash the window was BORN at, held for the one consumer that needs it after
  // the first render. `hash` above is a subscription and moves with every
  // navigation, and the first-launch rule turns on what the window was ASKED for
  // rather than on where it has since been.
  const openedAtHashRef = useRef(hash);

  // A hook rather than a ref, because this store owns a database connection and a
  // ref has nowhere to close one from. `ui-state-lifecycle.ts` says what an unclosed
  // one costs; `UiStateStore.opening` still returns immediately, so first paint
  // waits on no storage.
  const uiStateStore = useUiStateStore();

  // Which scripted composition this window is playing, or `undefined` where it plays
  // none — the release build's only answer, since `bridge.scenarioEngine` exists only
  // under the `define`-gated fixture. Read here and narrowed by the rule beside the
  // first-launch opening, so which composition counts as the demonstration is decided
  // in one module rather than restated by the component that marks it.
  const playingScenario = props.bridge.scenarioEngine?.scenario;
  const scenario = playsTheDemonstrationScenario(playingScenario?.id) ? playingScenario : undefined;

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

  // And the one opening that is not the hash's: the very first launch of an install
  // goes into the scripted session rather than to the sessions list. It navigates
  // through the same store, so the binding above publishes it like any other move.
  useFirstLaunchOpening({
    bridge: props.bridge,
    frameStore,
    uiStateStore,
    openedAtHash: openedAtHashRef.current,
  });

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

  // What this console and the local runtime agreed to speak. One read per bridge, put
  // through the console's growth-read chokepoint and followed by no timer — see
  // `version-mark.ts` for why a handshake has no session-event trigger to watch.
  const versionReading = useConsoleVersionReading(props.bridge.growth);

  const activeSessionId = frameStore.activeSessionId;

  const commandSurface = useFrameCommandSurface({
    route,
    lastOpenedSessionId,
    frameStore,
    uiStateStore,
    chooseScheme,
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

  return (
    <AppFrame
      route={route}
      railEntries={RAIL_ENTRIES}
      railDestination={railDestinationFor(route)}
      onSelectDestination={(destination) => {
        frameStore.navigate(routeForDestination(destination));
      }}
      modalOverlayOpen={commandSurface.paletteOpen}
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
            revision={commandSurface.commandRevision}
          />
          {props.renderOverlays === undefined ? null : props.renderOverlays(surfaceContext)}
        </>
      }
    >
      {/* The demonstration mark, above every surface rather than inside one: what it
          claims is true of the whole window, and a mark that lived in the workspace
          would vanish the moment somebody navigated to the sessions list and back.
          Under the live bridge there is no scenario engine, so this is `null` and the
          release build carries nothing. */}
      {/* The version pair, and the banner when the two builds did not meet. Above
          every surface for the reason the mark below it is: an incompatible handshake
          refuses every mutating dispatch in the window, not on one route. Rendered
          only on the settled arm — a window that has not heard back, or that could not
          reach the seam at all, shows no version pair rather than the last one it saw,
          which would be a claim about a runtime it is no longer talking to. */}
      {versionReading.phase === "read" ? (
        <VersionMark mark={versionReading.mark} mismatch={versionReading.mismatch} />
      ) : null}
      {scenario === undefined ? null : <DemoScenarioMark scenarioLabel={scenario.label} />}
      <RouteSurface context={surfaceContext} />
    </AppFrame>
  );
}
