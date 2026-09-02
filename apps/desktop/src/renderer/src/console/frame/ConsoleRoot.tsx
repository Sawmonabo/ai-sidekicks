// Where the console starts.
//
// The window's entry point: it composes the surface families, creates the stores
// this window keeps, and hands what it built to `AppFrame`. The pieces it used to
// hold inline are siblings now — `RouteSurface.tsx` resolves a route to a surface,
// `frame-commands.ts` carries the frame's own commands and chords,
// `rail-navigation.ts` builds the rail, `session-lifecycle.ts` owns the session
// registry — and every decision below is one the rest of the substrate depends on:
//
//   • **Tokens before paint.** The sheet is installed in a layout effect, which runs
//     before the browser paints, so no frame renders against an unstyled cascade.
//   • **One store per window, created once.** `useRef` rather than `useMemo`: a
//     memo may be discarded and recomputed, and a recreated `SessionStore` would
//     silently drop every event applied so far. React documents `useMemo` as a
//     performance hint; store identity is correctness.
//   • **The route follows the hash, and the hash follows the route.** Both
//     directions, because the Window menu opens auxiliary windows by URL and the
//     rail navigates in-window. `adoptHash` is idempotent so the loop settles, and
//     the store is BORN on the hash the window opened with rather than adopting it
//     one commit later: the two directions are both effects, and a store that
//     started on the default route left the route-to-hash direction closing over
//     that default on the very first pass — long enough to overwrite the address an
//     auxiliary window was opened at with `#/sessions`.
//   • **The scheme is hydrated on a read and persisted on an act.** Never on a
//     state-change effect, which cannot tell the person's choice from the
//     hydration that just applied a stored one.
//   • **The bridge is provided, never reached for.** No component below this one
//     touches `window.sidekicks`.

import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import {
  SidekicksBridgeProvider,
  useBridgeResolution,
  type ConsoleBridge,
} from "../bridge/index.js";
import { PaletteOverlay } from "../palette/index.js";
import { DraftStore, SCHEME_PREFERENCE_KEY, UiStateStore } from "../persistence/index.js";
import { Nothing } from "../primitives/index.js";
import { CONSOLE_CHORD_PLATFORM, consoleCommands } from "./command-surface.js";
import { registerConsoleFamilies } from "../families.js";
import { FrameStore, useFrameStore, useLocationHash } from "../store/index.js";
import { isSchemePreference, type SchemePreference } from "../tokens/index.js";
import { applyConsoleScheme, installMeridianTokens } from "./token-installation.js";
import { AppFrame } from "./AppFrame.js";
import { describeScope, useFrameCommandSurface } from "./frame-commands.js";
import { buildRailEntries, routeForDestination } from "./rail-navigation.js";
import { RouteSurface } from "./RouteSurface.js";
import { useActiveSessionStore, useSessionStoreRegistry } from "./session-lifecycle.js";
import { formatRoute, parseRoute, railDestinationFor } from "../routing/index.js";
import { consoleSurfaceRegistry, type ConsoleSurfaceContext } from "./surface-registry.js";

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
registerConsoleFamilies(consoleSurfaceRegistry);

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

interface ConsoleFrameProps {
  readonly bridge: ConsoleBridge;
  readonly renderOverlays?: (context: ConsoleSurfaceContext) => ReactNode;
}

function ConsoleFrame(props: ConsoleFrameProps): React.JSX.Element {
  // Read first, because the store is born on it. `useLocationHash` is a
  // subscription rather than a read, so this same value keeps the hash-to-route
  // direction live for every later navigation.
  const hash = useLocationHash();

  // Stores are per window and created exactly once. `UiStateStore.opening` starts
  // the database open and returns immediately, so first paint never waits on
  // storage while every persisted read and write awaits the same open — one store
  // identity, and no window in which a write would land somewhere it will not be
  // read back from.
  //
  // The frame store is seeded with the route the window OPENED at. The ref
  // initializer runs on the first render only, so this reads the opening hash and
  // never a later one — every later hash reaches the store through `adoptHash`.
  const frameStoreRef = useRef<FrameStore>(undefined);
  frameStoreRef.current ??= new FrameStore({ initialRoute: parseRoute(hash) });
  const frameStore = frameStoreRef.current;

  const uiStateStoreRef = useRef<UiStateStore>(undefined);
  uiStateStoreRef.current ??= UiStateStore.opening();
  const uiStateStore = uiStateStoreRef.current;

  const draftStoreRef = useRef<DraftStore>(undefined);
  draftStoreRef.current ??= new DraftStore();
  const draftStore = draftStoreRef.current;

  const sessionStoreRegistry = useSessionStoreRegistry();

  const route = useFrameStore(frameStore, (state) => state.route);
  const banners = useFrameStore(frameStore, (state) => state.banners);
  const schemePreference = useFrameStore(frameStore, (state) => state.schemePreference);

  // Tokens land before the first paint; the scheme attribute follows the setting.
  useLayoutEffect(() => {
    installMeridianTokens(document);
  }, []);
  useLayoutEffect(() => {
    applyConsoleScheme(document, schemePreference);
  }, [schemePreference]);

  // The colour scheme is the one window preference that has to survive a reload,
  // so it is read back once at mount and written at the moment a person changes
  // it.
  //
  // The write deliberately does NOT ride a `schemePreference` effect. Such an
  // effect cannot tell a person's choice from the hydration that just applied a
  // stored one, so in the window before the read settles it writes the default
  // back over the stored preference — a preference that survives every reload
  // except the ones where the disk was slow. Persisting at the ACT instead makes
  // that unrepresentable, and leaves the hydration free to be a pure read.
  const schemeWasChosenRef = useRef(false);
  const chooseScheme = useCallback(
    (preference: SchemePreference) => {
      schemeWasChosenRef.current = true;
      frameStore.setSchemePreference(preference);
      void uiStateStore.writeGlobal(SCHEME_PREFERENCE_KEY, "scheme", preference);
    },
    [frameStore, uiStateStore],
  );

  useEffect(() => {
    let abandoned = false;
    void uiStateStore.readGlobal(SCHEME_PREFERENCE_KEY).then((record) => {
      // A choice made while the read was in flight is the newer fact and stands.
      if (abandoned || schemeWasChosenRef.current || record === undefined) {
        return;
      }
      const stored = record.value;
      if (isSchemePreference(stored)) {
        frameStore.setSchemePreference(stored);
      }
    });
    return () => {
      abandoned = true;
    };
  }, [frameStore, uiStateStore]);

  // Hash → route.
  useEffect(() => {
    frameStore.adoptHash(hash);
  }, [frameStore, hash]);

  // Route → hash. Guarded so the two directions cannot ping-pong.
  useEffect(() => {
    const desired = formatRoute(route);
    if (window.location.hash !== desired && route.kind !== "not-found") {
      window.location.hash = desired;
    }
  }, [route]);

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
    activeSessionId,
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
      railEntries={buildRailEntries(route)}
      railDestination={railDestinationFor(route)}
      onSelectDestination={(destination) => {
        frameStore.navigate(routeForDestination(destination, activeSessionId));
      }}
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
