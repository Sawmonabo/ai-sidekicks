// The frame's own commands, and the palette wiring that carries them.
//
// `command-surface.ts` next door is the DOOR — the registry, the `when` vocabulary,
// the chords the frame binds. This module is what the frame contributes THROUGH it,
// and it is a hook rather than a table for the same reason those commands cannot be
// declared at module scope: every one of them closes over this window's store, so
// they are built per window, registered from an effect, and removed on unmount.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { KeyBindingTable, type WhenClauseContext } from "../palette/index.js";
import { isAuxiliaryRoute, type ConsoleRoute } from "../routing/index.js";
import type { FrameStore } from "../store/index.js";
import type { SchemePreference } from "../tokens/index.js";
import {
  FRAME_KEY_BINDINGS,
  consoleCommands,
  registerConsoleCommands,
  type FrameCommand,
  type FrameWhenClauseContext,
} from "./command-surface.js";

/** What the frame's own commands are built against: this window's store and acts. */
export interface FrameCommandSurfaceInput {
  readonly route: ConsoleRoute;
  readonly activeSessionId: string | undefined;
  readonly frameStore: FrameStore;
  readonly chooseScheme: (preference: SchemePreference) => void;
}

/** Everything the palette overlay is rendered with, and nothing else. */
export interface FrameCommandSurface {
  readonly whenContext: FrameWhenClauseContext;
  readonly keyBindings: KeyBindingTable;
  readonly commandRevision: number;
  readonly paletteOpen: boolean;
  readonly setPaletteOpen: (open: boolean) => void;
}

export function useFrameCommandSurface(input: FrameCommandSurfaceInput): FrameCommandSurface {
  const { route, activeSessionId, frameStore, chooseScheme } = input;

  // What a command's `when` clause is evaluated against. Derived from the route
  // rather than stored, so there is one answer to "where am I" and the palette
  // cannot disagree with the rail about it.
  const whenContext: FrameWhenClauseContext = useMemo(
    () => ({
      sessionActive: activeSessionId !== undefined,
      onSessions: route.kind === "sessions",
      onWorkspace: route.kind === "workspace",
      onSettings: route.kind === "settings",
      inAuxiliaryWindow: isAuxiliaryRoute(route),
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
    const frameCommands = buildFrameCommands(frameStore, chooseScheme);
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

/** Navigation and appearance: the two things the frame itself can do. */
function buildFrameCommands(
  frameStore: FrameStore,
  chooseScheme: (preference: SchemePreference) => void,
): readonly FrameCommand[] {
  return [
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
}
