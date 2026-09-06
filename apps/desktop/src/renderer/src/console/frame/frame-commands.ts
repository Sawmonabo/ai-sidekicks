// The frame's own commands, and the palette wiring that carries them.
//
// `command-surface.ts` next door is the DOOR — the registry, the `when` vocabulary,
// the chords the frame binds. This module is what the frame contributes THROUGH it,
// and it is a hook rather than a table for the same reason those commands cannot be
// declared at module scope: every one of them closes over this window's store, so
// they are built per window, registered from an effect, and removed on unmount.
//
// The palette's own bridge-backed acts ride the SAME registration. They are not the
// frame's commands — they belong to the family that declares them — but they are
// per-window and late in exactly the way the frame's are, and a second registration
// lifecycle beside this one would be a second place to get the unregister wrong:
// two effects registering into one module-scoped registry, whose duplicate-id
// refusal turns any ordering mistake into a raise at mount rather than a shadowed
// command. One effect, one list, one revision bump.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ConsoleRefusal } from "../core/index.js";
import {
  KeyBindingTable,
  useBridgeCommands,
  type ConsoleCommand,
  type WhenClauseContext,
} from "../palette/index.js";
import {
  RAIL_DESTINATIONS,
  isAuxiliaryRoute,
  routeSessionId,
  type ConsoleRoute,
} from "../routing/index.js";
import type { FrameStore } from "../store/index.js";
import type { SchemePreference } from "../tokens/index.js";
import {
  consoleCommands,
  registerConsoleCommands,
  type ConsoleWhenClauseContext,
} from "../palette/index.js";
import {
  FRAME_KEY_BINDINGS,
  RAIL_NAVIGATION_DETAILS,
  type FrameCommand,
} from "./command-surface.js";
import { RAIL_ENTRY_TEMPLATES } from "./IconRail.js";
import { routeForDestination } from "./rail-navigation.js";

/** What the frame's own commands are built against: this window's store and acts. */
export interface FrameCommandSurfaceInput {
  readonly route: ConsoleRoute;
  /**
   * The session this window has in hand, which OUTLIVES a route that names none —
   * see `FrameStore`'s own field. `sessionActive` is derived from it rather than
   * from the route, so "Go to Workspace" stays offered from Settings, which is
   * precisely where a person reaches for it.
   */
  readonly lastOpenedSessionId: string | undefined;
  readonly frameStore: FrameStore;
  readonly chooseScheme: (preference: SchemePreference) => void;
}

/** Everything the palette overlay is rendered with, and nothing else. */
export interface FrameCommandSurface {
  readonly whenContext: ConsoleWhenClauseContext;
  readonly keyBindings: KeyBindingTable;
  readonly commandRevision: number;
  readonly paletteOpen: boolean;
  readonly setPaletteOpen: (open: boolean) => void;
}

export function useFrameCommandSurface(input: FrameCommandSurfaceInput): FrameCommandSurface {
  const { route, lastOpenedSessionId, frameStore, chooseScheme } = input;

  // What a command's `when` clause is evaluated against. Derived from the route
  // rather than stored, so there is one answer to "where am I" and the palette
  // cannot disagree with the rail about it.
  const whenContext: ConsoleWhenClauseContext = useMemo(
    () => ({
      sessionActive: lastOpenedSessionId !== undefined,
      onSessions: route.kind === "sessions",
      onWorkspace: route.kind === "workspace",
      onWorkflows: route.kind === "workflows",
      onSettings: route.kind === "settings",
      inAuxiliaryWindow: isAuxiliaryRoute(route),
    }),
    [route, lastOpenedSessionId],
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

  // Where a bridge-backed command's refusal is rendered.
  //
  // A frame banner, which is the third of the three refusal renderings and the only
  // one available to an act with no surface of its own — "Check for updates" has no
  // pane to fail inline on. The banner is composed by the STORE rather than here:
  // this stopped being the only producer when a refused scheme write got a banner
  // too, and two producers writing the same four fields is exactly how the two
  // keying rules come apart.
  const raiseRefusalBanner = useCallback(
    (refusal: ConsoleRefusal) => {
      frameStore.raiseRefusalBanner(refusal);
    },
    [frameStore],
  );

  // Memoised on that stable sink, so the list keeps its identity across renders and
  // the registration effect below runs once rather than per pass.
  const bridgeCommands = useBridgeCommands(raiseRefusalBanner);

  const keyBindingsRef = useRef<KeyBindingTable>(undefined);
  keyBindingsRef.current ??= new KeyBindingTable({
    registry: consoleCommands,
    readContext: () => whenContextRef.current,
  });
  const keyBindings = keyBindingsRef.current;

  // This window's commands. Registered HERE rather than at module scope because
  // each one closes over this window's store or its bridge; removed on unmount so a
  // second mount in the same process (a test, a StrictMode double-render) does not
  // collide with the first registration.
  useEffect(() => {
    const windowCommands: readonly ConsoleCommand[] = [
      ...buildFrameCommands(frameStore, chooseScheme),
      ...bridgeCommands,
    ];
    // Through the family door rather than through the registry, so there is one
    // way to contribute a command and not two. These are late registrations like
    // any family's — the only difference is that they close over what only this
    // window has, which is why they are registered from an effect. `registerAll`
    // is atomic, so a duplicate anywhere in the list adds none of it and the
    // cleanup below cannot unregister a command another mount owns.
    registerConsoleCommands(windowCommands);
    keyBindings.setBindings(FRAME_KEY_BINDINGS);
    const uninstall = keyBindings.install(window);
    setCommandRevision((revision) => revision + 1);
    return () => {
      uninstall();
      for (const command of windowCommands) {
        consoleCommands.unregister(command.id);
      }
    };
  }, [bridgeCommands, chooseScheme, frameStore, keyBindings]);

  const changePaletteOpen = useCallback((open: boolean) => {
    setPaletteOpen(open);
  }, []);

  return {
    whenContext,
    keyBindings,
    commandRevision,
    paletteOpen,
    setPaletteOpen: changePaletteOpen,
  };
}

/**
 * The palette's scoped-context row — what a command would act on if run now.
 *
 * `Spec-023 §Console Design (Meridian)` §Layout grammar requires the row: a
 * palette that lists "Interrupt the run" without naming WHICH run is a palette
 * that invites a mistake.
 */
export function describeScope(route: ConsoleRoute): string {
  switch (route.kind) {
    case "sessions":
      return "All sessions";
    case "workspace":
      return `Session ${route.sessionId}`;
    case "workflows":
      return "Workflows";
    case "settings":
      return "Settings";
    case "auxiliary": {
      const sessionId = routeSessionId(route);
      return sessionId === undefined
        ? `${route.route} — no session chosen`
        : `${route.route} — session ${sessionId}`;
    }
    case "not-found":
      return "Nowhere";
  }
}

/**
 * Navigation and appearance: the two things the frame itself can do.
 *
 * The rail's destinations are WALKED rather than listed. The palette and the rail
 * offer the same three top-level contexts, and writing them out here made a second
 * closed set that agreed with the first only while someone kept it in step — so
 * when the spec's workflows destination was missing, it was missing from the rail,
 * the chord table, and this list at once, and each of the three read as confirming
 * the other two. Each command's title is the rail's own label, so the two surfaces
 * cannot end up calling one place two names.
 */
function buildFrameCommands(
  frameStore: FrameStore,
  chooseScheme: (preference: SchemePreference) => void,
): readonly FrameCommand[] {
  return [
    ...RAIL_DESTINATIONS.map((destination) => ({
      id: RAIL_NAVIGATION_DETAILS[destination].commandId,
      title: `Go to ${RAIL_ENTRY_TEMPLATES[destination].label}`,
      group: "Navigate",
      keywords: RAIL_NAVIGATION_DETAILS[destination].keywords,
      run: () => {
        frameStore.navigate(routeForDestination(destination));
      },
    })),
    {
      // Beside the destinations rather than among them: the session workspace is
      // reached from the sessions list, so it is an act on the session this window
      // has in hand and not a place the rail can send anyone. `sessionActive` is
      // read from the RETAINED session, which is why the command stays offered
      // from Settings — precisely where a person reaches for it.
      id: "frame.goToWorkspace",
      title: "Go to Workspace",
      group: "Navigate",
      when: "sessionActive",
      run: () => {
        // Read at RUN time, not closed over: this list is built once per window and
        // the session it returns to changes with every navigation.
        const sessionId = frameStore.lastOpenedSessionId;
        if (sessionId !== undefined) {
          frameStore.navigate({ kind: "workspace", sessionId });
        }
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
}
