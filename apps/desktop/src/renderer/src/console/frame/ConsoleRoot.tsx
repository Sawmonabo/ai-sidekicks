// Where the console starts.
//
// One component, and everything it does is a decision the rest of the substrate
// depends on:
//
//   • **Tokens before paint.** The sheet is installed in a layout effect, which runs
//     before the browser paints, so no frame renders against an unstyled cascade.
//   • **One store per window, created once.** `useRef` rather than `useMemo`: a
//     memo may be discarded and recomputed, and a recreated `SessionStore` would
//     silently drop every event applied so far. React documents `useMemo` as a
//     performance hint; store identity is correctness.
//   • **The route follows the hash, and the hash follows the route.** Both
//     directions, because the Window menu opens auxiliary windows by URL and the
//     rail navigates in-window. `adoptHash` is idempotent so the loop settles.
//   • **The scheme is hydrated on a read and persisted on an act.** Never on a
//     state-change effect, which cannot tell the person's choice from the
//     hydration that just applied a stored one.
//   • **The bridge is provided, never reached for.** No component below this one
//     touches `window.sidekicks`.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SidekicksBridgeProvider, useBridgeResolution } from "../bridge/index.js";
import {
  COMMAND_PALETTE_OPEN_CHORD,
  KeyBindingTable,
  PaletteOverlay,
  type WhenClauseContext,
} from "../palette/index.js";
import { DraftStore, SCHEME_PREFERENCE_KEY, UiStateStore } from "../persistence/index.js";
import { ChordHint, Nothing } from "../primitives/index.js";
import {
  CONSOLE_CHORD_PLATFORM,
  FRAME_KEY_BINDINGS,
  consoleCommands,
  registerConsoleCommands,
  type FrameCommand,
  type FrameWhenClauseContext,
} from "./command-surface.js";
import { registerConsoleFamilies } from "../families.js";
import { FrameStore, SessionStore, useFrameStore, useLocationHash } from "../store/index.js";
import { isSchemePreference, type SchemePreference } from "../tokens/index.js";
import { applyConsoleScheme, installMeridianTokens } from "./token-installation.js";
import { AppFrame } from "./AppFrame.js";
import { ContextPicker, type ContextCandidate } from "./ContextPicker.js";
import { RAIL_ENTRY_TEMPLATE, type RailEntry } from "./IconRail.js";
import {
  formatRoute,
  railDestinationFor,
  type ConsoleRoute,
  type RailDestination,
} from "../routing/index.js";
import {
  consoleSurfaceRegistry,
  surfaceSlotFor,
  type ConsoleSurfaceContext,
} from "./surface-registry.js";

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

function ConsoleFrameHost(props: ConsoleFrameHostProps): React.JSX.Element {
  const resolution = useBridgeResolution();

  // Stores are per window and created exactly once. `UiStateStore.opening` starts
  // the database open and returns immediately, so first paint never waits on
  // storage while every persisted read and write awaits the same open — one store
  // identity, and no window in which a write would land somewhere it will not be
  // read back from.
  const frameStoreRef = useRef<FrameStore>(undefined);
  frameStoreRef.current ??= new FrameStore();
  const frameStore = frameStoreRef.current;

  const uiStateStoreRef = useRef<UiStateStore>(undefined);
  uiStateStoreRef.current ??= UiStateStore.opening();
  const uiStateStore = uiStateStoreRef.current;

  const draftStoreRef = useRef<DraftStore>(undefined);
  draftStoreRef.current ??= new DraftStore();
  const draftStore = draftStoreRef.current;

  const hash = useLocationHash();
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
  useEffect(() => {
    const onFocus = (): void => {
      frameStore.setWindowFocused(true);
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
  }, [frameStore]);

  const bridge = resolution.status === "ready" ? resolution.bridge : undefined;

  const activeSessionId = frameStore.activeSessionId;

  // What a command's `when` clause is evaluated against. Derived from the route
  // rather than stored, so there is one answer to "where am I" and the palette
  // cannot disagree with the rail about it.
  const whenContext: FrameWhenClauseContext = useMemo(
    () => ({
      sessionActive: activeSessionId !== undefined,
      onSessions: route.kind === "sessions",
      onWorkspace: route.kind === "workspace",
      onSettings: route.kind === "settings",
      inAuxiliaryWindow: route.kind === "auxiliary",
    }),
    [route, activeSessionId],
  );

  // The key-binding table reads the context through a ref rather than closing over
  // it: the table is built once and installs ONE listener, so a closure captured at
  // construction would evaluate every later chord against the route the window
  // opened on.
  const whenContextRef = useRef<WhenClauseContext>(whenContext);
  whenContextRef.current = whenContext;

  const [paletteOpen, setPaletteOpen] = useState(false);
  // The palette reads the registry once per revision, so a registration that
  // lands after the first render — which the frame's own commands do, and every
  // family's late registration will — needs the revision bumped or the palette
  // renders "no commands apply here" over a registry that has them.
  const [commandRevision, setCommandRevision] = useState(0);

  const keyBindingsRef = useRef<KeyBindingTable>(undefined);
  keyBindingsRef.current ??= new KeyBindingTable({
    registry: consoleCommands,
    readContext: () => whenContextRef.current,
  });
  const keyBindings = keyBindingsRef.current;

  // The frame's own commands. Registered HERE rather than at module scope because
  // each one closes over this window's store; removed on unmount so a second mount
  // in the same process (a test, a StrictMode double-render) does not collide with
  // the first registration.
  useEffect(() => {
    const frameCommands: readonly FrameCommand[] = [
      {
        id: "frame.goToSessions",
        title: "Go to Sessions",
        group: "Navigate",
        keywords: ["list", "home"],
        run: () => {
          frameStore.navigate({ kind: "sessions" });
        },
      },
      {
        id: "frame.goToWorkspace",
        title: "Go to Workspace",
        group: "Navigate",
        when: "sessionActive",
        run: () => {
          if (frameStore.activeSessionId !== undefined) {
            frameStore.navigate({ kind: "workspace", sessionId: frameStore.activeSessionId });
          }
        },
      },
      {
        id: "frame.goToSettings",
        title: "Go to Settings",
        group: "Navigate",
        keywords: ["preferences", "options"],
        run: () => {
          frameStore.navigate({ kind: "settings", page: undefined });
        },
      },
      {
        id: "frame.useLightScheme",
        title: "Use the light colour scheme",
        group: "Appearance",
        run: () => {
          chooseScheme("light");
        },
      },
      {
        id: "frame.useDarkScheme",
        title: "Use the dark colour scheme",
        group: "Appearance",
        run: () => {
          chooseScheme("dark");
        },
      },
      {
        id: "frame.useSystemScheme",
        title: "Follow the system colour scheme",
        group: "Appearance",
        run: () => {
          chooseScheme("system");
        },
      },
    ];
    // Through the family door rather than through the registry, so there is one
    // way to contribute a command and not two. The frame's commands are late
    // registrations like any family's — the only difference is that they close
    // over this window's store, which is why they are registered from an effect.
    registerConsoleCommands(frameCommands);
    keyBindings.setBindings(FRAME_KEY_BINDINGS);
    const uninstall = keyBindings.install(window);
    setCommandRevision((revision) => revision + 1);
    return () => {
      uninstall();
      for (const command of frameCommands) {
        consoleCommands.unregister(command.id);
      }
    };
  }, [chooseScheme, frameStore, keyBindings]);

  const closePalette = useCallback((open: boolean) => {
    setPaletteOpen(open);
  }, []);

  const sessionStoresBySessionId = useRef(new Map<string, SessionStore>());
  let sessionStore: SessionStore | undefined;
  if (activeSessionId !== undefined) {
    const existing = sessionStoresBySessionId.current.get(activeSessionId);
    if (existing === undefined) {
      sessionStore = new SessionStore({ sessionId: activeSessionId });
      sessionStoresBySessionId.current.set(activeSessionId, sessionStore);
    } else {
      sessionStore = existing;
    }
  }

  if (resolution.status === "unavailable" || bridge === undefined) {
    return (
      <div className="meridian-frame meridian-frame--bare">
        <Nothing
          kind="error"
          title="This window cannot reach the app."
          detail={
            resolution.status === "unavailable"
              ? resolution.unavailable.detail
              : "The bridge is missing."
          }
        />
      </div>
    );
  }

  const surfaceContext: ConsoleSurfaceContext = {
    route,
    bridge,
    frameStore,
    sessionStore,
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
            context={whenContext}
            open={paletteOpen}
            onOpenChange={closePalette}
            platform={CONSOLE_CHORD_PLATFORM}
            bindings={keyBindings}
            scopeLabel={describeScope(route)}
            revision={commandRevision}
          />
          {props.renderOverlays === undefined ? null : props.renderOverlays(surfaceContext)}
        </>
      }
    >
      <RouteSurface context={surfaceContext} />
    </AppFrame>
  );
}

interface RouteSurfaceProps {
  readonly context: ConsoleSurfaceContext;
}

/**
 * A whole-surface absence, composed rather than left in flow.
 *
 * The `Nothing` primitive's `empty` arm is a quiet line, which is right where it
 * belongs — inside a list that came back with no rows. A route that resolves to no
 * surface is a different scale of absence: the same quiet line pinned to the
 * top-left of a 1440 px window reads as a page that failed to finish painting. So
 * the frame centres it on a measure and pairs it with the one control that
 * definitely works, which keeps "there is nothing here" from also meaning "and
 * there is nothing you can do".
 */
function SurfaceAbsence(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="meridian-frame__absence">
      <div className="meridian-frame__absence-body">{props.children}</div>
      <p className="meridian-frame__absence-hint">
        <ChordHint chord={COMMAND_PALETTE_OPEN_CHORD} /> opens the command palette.
      </p>
    </div>
  );
}

/**
 * Resolve a route to a surface.
 *
 * The two "we cannot show this" arms are deliberately different. A bare auxiliary
 * route is a WORKING window awaiting a subject, so it gets the picker. A slot with
 * no registered renderer is reserved-not-stubbed: the console says the surface has
 * not been built, which is true, rather than rendering an empty pane that reads as a
 * broken feature.
 */
function RouteSurface(props: RouteSurfaceProps): React.JSX.Element {
  const { context } = props;
  const { route } = context;

  if (route.kind === "not-found") {
    return (
      <SurfaceAbsence>
        <Nothing
          kind="error"
          title="That address does not name anything in the console."
          detail={`Nothing is registered for ${route.attempted}. The Sessions list is the way back.`}
        />
      </SurfaceAbsence>
    );
  }

  if (route.kind === "auxiliary" && route.sessionId === undefined) {
    return (
      <ContextPicker
        route={route.route}
        candidates={readContextCandidates(context)}
        onChoose={(sessionId) => {
          context.frameStore.navigate({ ...route, sessionId });
        }}
      />
    );
  }

  const slot = surfaceSlotFor(route);
  const descriptor = slot === undefined ? undefined : consoleSurfaceRegistry.descriptorFor(slot);
  if (descriptor === undefined) {
    return (
      <SurfaceAbsence>
        <Nothing
          kind="empty"
          title="This surface has not been built yet."
          detail={
            slot === undefined
              ? "The route resolves to no surface."
              : `Nothing is registered for the "${slot}" surface. It is reserved, not missing — the family that owns it has not shipped.`
          }
        />
      </SurfaceAbsence>
    );
  }
  return <>{descriptor.render(context)}</>;
}

/**
 * Sessions the picker can offer.
 *
 * `undefined` until the session store has been initialised, so the picker renders
 * "not loaded" rather than "none" — the distinction the five kinds of nothing exist
 * for. An auxiliary window has no session store until a session is chosen, which is
 * exactly the not-loaded case.
 */
function readContextCandidates(
  context: ConsoleSurfaceContext,
): readonly ContextCandidate[] | undefined {
  const { sessionStore } = context;
  if (sessionStore === undefined) {
    return undefined;
  }
  const state = sessionStore.snapshot();
  if (!state.initialised) {
    return undefined;
  }
  return Object.values(state.partitions.session).map((entity) => ({
    sessionId: entity.id,
    title:
      typeof entity.body?.["title"] === "string" ? (entity.body["title"] as string) : entity.id,
    detail: entity.state ?? "",
  }));
}

/**
 * The palette's scoped-context row — what a command would act on if run now.
 *
 * `Spec-023 §Console Design (Meridian)` §Layout grammar requires the row: a
 * palette that lists "Interrupt the run" without naming WHICH run is a palette
 * that invites a mistake.
 */
function describeScope(route: ConsoleRoute): string {
  switch (route.kind) {
    case "sessions":
      return "All sessions";
    case "workspace":
      return `Session ${route.sessionId}`;
    case "settings":
      return "Settings";
    case "auxiliary":
      return route.sessionId === undefined
        ? `${route.route} — no session chosen`
        : `${route.route} — session ${route.sessionId}`;
    case "not-found":
      return "Nowhere";
  }
}

/** The rail's contents for a route. Workspace is absent with no session open. */
function buildRailEntries(route: ConsoleRoute): readonly RailEntry[] {
  const hasSession =
    route.kind === "workspace" || (route.kind === "auxiliary" && route.sessionId !== undefined);
  return RAIL_ENTRY_TEMPLATE.map((entry) => ({
    ...entry,
    isAvailable: entry.destination === "workspace" ? hasSession : true,
  }));
}

function routeForDestination(
  destination: RailDestination,
  activeSessionId: string | undefined,
): ConsoleRoute {
  switch (destination) {
    case "sessions":
      return { kind: "sessions" };
    case "settings":
      return { kind: "settings", page: undefined };
    case "workspace":
      return activeSessionId === undefined
        ? { kind: "sessions" }
        : { kind: "workspace", sessionId: activeSessionId };
  }
}
