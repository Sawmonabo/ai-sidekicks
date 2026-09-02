// Where the console starts.
//
// The window's entry point: it composes the surface families, creates the stores
// this window keeps, and hands what it built to `AppFrame`. The pieces it used to
// hold inline are siblings now — `RouteSurface.tsx` resolves a route to a surface,
// `frame-commands.ts` carries the frame's own commands and chords,
// `rail-navigation.ts` builds the rail, `session-lifecycle.ts` owns the session
// registry, `ui-state-lifecycle.ts` owns the durable store's life, and
// `scheme-preference.ts` owns the colour scheme end to end — and every decision
// below is one the rest of the substrate depends on:
//
//   • **Tokens before paint, and ABOVE the bridge gate.** The sheet is installed in
//     a layout effect, which runs before the browser paints, so no frame renders
//     against an unstyled cascade. It is installed by `ConsoleFrameHost` rather
//     than by the frame under it, because the host has a state the frame never
//     reaches: a window whose preload never ran renders the missing-bridge card and
//     mounts no frame at all. Installed one level down, that exact recovery state —
//     the one a person is most likely to be reading when something has gone wrong —
//     came up in browser defaults, without the custom properties or the
//     full-height rules the card is laid out against. One installer, one call site;
//     the failure branch gets no copy of its own.
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
import {
  SidekicksBridgeProvider,
  useBridgeResolution,
  type ConsoleBridge,
} from "../bridge/index.js";
import { PaletteOverlay } from "../palette/index.js";
import { DraftStore } from "../persistence/index.js";
import { Nothing } from "../primitives/index.js";
import { CONSOLE_CHORD_PLATFORM, consoleCommands } from "./command-surface.js";
import { registerConsoleFamilies } from "../families.js";
import { FrameStore, useFrameStore, useLocationHash } from "../store/index.js";
import { applyConsoleScheme, installMeridianTokens } from "./token-installation.js";
import { AppFrame } from "./AppFrame.js";
import { describeScope, useFrameCommandSurface } from "./frame-commands.js";
import { useHashRouteBinding } from "./hash-route-binding.js";
import { RAIL_ENTRIES, routeForDestination } from "./rail-navigation.js";
import { RouteSurface } from "./RouteSurface.js";
import { useSchemePreference } from "./scheme-preference.js";
import { useActiveSessionStore, useSessionStoreRegistry } from "./session-lifecycle.js";
import { useUiStateStore } from "./ui-state-lifecycle.js";
import { parseRoute, railDestinationFor } from "../routing/index.js";
import { consoleSurfaceRegistry, type ConsoleSurfaceContext } from "./surface-registry.js";
import { consolePaneRegistry } from "../workspace/index.js";

// Composition, at module scope, before any window renders.
//
// It happens HERE rather than in the renderer entry point because "a console
// window exists" and "its families are composed" have to be the same fact. Every
// window — the main one, an auxiliary one, a test's — mounts through
// `ConsoleRoot`; composed one level up in whatever component the entry point
// happened to render, a window that mounted `ConsoleRoot` by any other path would
// come up against an empty registry and report every route as reserved-not-built,
// which is a wrong answer that looks exactly like a correct one.
//
// Module scope rather than an effect because `RouteSurface` resolves the registry
// during render: an effect runs after the first paint has already said the
// surface does not exist. Registration is idempotent per module graph, and the
// registry refuses a second OWNER on one slot, so a hot reload replaces and a
// collision raises.
//
// Both process-wide registries are named HERE rather than reached for inside the
// composition, which is what makes this the composition site: a test or an
// auxiliary window calls the same function with registries of its own and touches
// neither of these.
registerConsoleFamilies(consoleSurfaceRegistry, consolePaneRegistry);

export interface ConsoleRootProps {
  /** Which fixture scenario to play. Ignored when fixtures are compiled out. */
  readonly scenarioId?: string;
  /** Window-scoped overlays — the command palette, dialogs. */
  readonly renderOverlays?: (context: ConsoleSurfaceContext) => ReactNode;
}

/** The console's mount point. `App.tsx` renders exactly this. */
export function ConsoleRoot(props: ConsoleRootProps): React.JSX.Element {
  return (
    <SidekicksBridgeProvider
      {...(props.scenarioId === undefined ? {} : { scenarioId: props.scenarioId })}
    >
      <ConsoleFrameHost
        {...(props.renderOverlays === undefined ? {} : { renderOverlays: props.renderOverlays })}
      />
    </SidekicksBridgeProvider>
  );
}

interface ConsoleFrameHostProps {
  readonly renderOverlays?: (context: ConsoleSurfaceContext) => ReactNode;
}

/**
 * The bridge gate, and nothing else.
 *
 * The failure arm is rendered HERE rather than inside the frame so that everything
 * below it holds a resolved `ConsoleBridge` by construction. That is what lets the
 * frame's own command surface contribute the palette's bridge-backed acts: those
 * are built by a hook that throws when the bridge is unavailable — correctly, since
 * a component reaching for a missing bridge is a wiring bug — and a hook cannot be
 * called conditionally, so the guard has to be a component boundary rather than an
 * `if` further down.
 *
 * The resolution is decided once per provider and does not change afterwards, so
 * this boundary never remounts the frame under a running window.
 */
function ConsoleFrameHost(props: ConsoleFrameHostProps): React.JSX.Element {
  useMeridianTokenSheet();
  const resolution = useBridgeResolution();
  if (resolution.status === "unavailable") {
    return (
      <div className="meridian-frame meridian-frame--bare">
        <Nothing
          kind="error"
          title="This window cannot reach the app."
          detail={resolution.unavailable.detail}
        />
      </div>
    );
  }
  return (
    <ConsoleFrame
      bridge={resolution.bridge}
      {...(props.renderOverlays === undefined ? {} : { renderOverlays: props.renderOverlays })}
    />
  );
}

/**
 * Put the Meridian token sheet on the document, before the first paint.
 *
 * A hook rather than a call in a render body: installing it is a document
 * mutation, and a layout effect is the one place a mutation runs after React has
 * committed and before the browser paints. `installMeridianTokens` is idempotent
 * by element id, so a second window — or a hot reload — re-enters this and writes
 * nothing.
 *
 * The scheme ATTRIBUTE deliberately does not ride here. It is a projection of a
 * preference read back from the durable store, which only a window with a bridge
 * has; and `applyConsoleScheme` writes the attribute for an explicit choice and
 * REMOVES it for `"system"`, so applying a default here would be a no-op on the
 * one arm this hoist exists for and a clobber of the frame's own value on the
 * other — React runs a child's layout effect before its parent's, so the parent
 * would win. A window with no bridge renders under no attribute, which is the
 * sheet's `prefers-color-scheme` layer deciding: correct in both schemes.
 */
function useMeridianTokenSheet(): void {
  useLayoutEffect(() => {
    installMeridianTokens(document);
  }, []);
}

interface ConsoleFrameProps {
  readonly bridge: ConsoleBridge;
  readonly renderOverlays?: (context: ConsoleSurfaceContext) => ReactNode;
}

function ConsoleFrame(props: ConsoleFrameProps): React.JSX.Element {
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
  draftStoreRef.current ??= new DraftStore();
  const draftStore = draftStoreRef.current;

  const sessionStoreRegistry = useSessionStoreRegistry();

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
    chooseScheme,
  });

  const sessionStore = useActiveSessionStore(sessionStoreRegistry, activeSessionId);

  const surfaceContext: ConsoleSurfaceContext = {
    route,
    bridge: props.bridge,
    frameStore,
    sessionStore,
    sessionStoreRegistry,
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
      <RouteSurface context={surfaceContext} />
    </AppFrame>
  );
}
