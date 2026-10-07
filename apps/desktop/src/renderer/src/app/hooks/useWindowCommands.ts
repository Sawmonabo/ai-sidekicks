// One window's palette and chord table over the app's commands. The table listens on the window's
// own document, since a key pressed in one window reaches only that window, and reads the window's
// own `when` context; the commands are registered once for the app (`useAppCommands.ts`).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AppRoute } from "#renderer/routing/routes.js";
import type { WhenClauseContext } from "#renderer/registries/commands/when-clause/semantics.js";
import { type WindowWhenClauseContext } from "#renderer/registries/commands/when-clause/vocabulary.js";
import { commandRegistry } from "#renderer/registries/commands/registry.js";
import { useKeybindingSnapshot } from "#renderer/registries/keybindings/hooks/useKeybindingSnapshot.js";
import { keybindingOverrides } from "#renderer/registries/keybindings/overrides/store.js";
import { KeybindingTable } from "#renderer/registries/keybindings/table.js";
import type { CommandPaletteProps } from "#renderer/layout/CommandPalette/hooks/useCommandPalette.js";

/** What one window's palette and chords are built against. */
export interface WindowCommandsInput {
  readonly route: AppRoute;
  /**
   * The session this window has in hand, which outlives a route that names none;
   * `sessionActive` is derived from it rather than from the route.
   */
  readonly lastOpenedSessionId: string | undefined;
  /** The window the chords are pressed in. */
  readonly ownerWindow: Window;
  /** The app's command revision, bumped when the command set changed. */
  readonly revision: number;
}

/** One window's palette props and its reading of the chords bound now. */
export interface WindowCommands {
  /** The palette's props: its `when` context, its bindings, its open state and the revision. */
  readonly palette: Pick<
    CommandPaletteProps,
    "context" | "bindings" | "revision" | "open" | "onOpenChange"
  >;
  /**
   * The chord a command holds now, as its Keyboard row shows it, or `undefined` while it holds
   * none. Read off the override store's snapshot, so it is current in the render a rebinding
   * causes.
   */
  readonly readBoundChord: (commandId: string) => string | undefined;
}

/**
 * Install this window's chord table and return its palette's props and its reading of the chords
 * bound now.
 */
export function useWindowCommands(input: WindowCommandsInput): WindowCommands {
  const { route, lastOpenedSessionId, ownerWindow, revision } = input;

  // Derived from the route, so the palette cannot disagree with the rail about where it is.
  const whenContext: WindowWhenClauseContext = useMemo(
    () => ({
      sessionActive: lastOpenedSessionId !== undefined,
      onSessions: route.kind === "sessions",
      onSession: route.kind === "session",
      onWorkflows: route.kind === "workflows",
      onSettings: route.kind === "settings",
    }),
    [route, lastOpenedSessionId],
  );

  // Read through a ref: a closure captured at construction would evaluate every chord against
  // the opening route.
  const whenContextRef = useRef<WhenClauseContext>(whenContext);
  whenContextRef.current = whenContext;

  const [paletteOpen, setPaletteOpen] = useState(false);

  // The shipped chords with this person's overrides, and whether a recording suspends them.
  const keybindingSnapshot = useKeybindingSnapshot(keybindingOverrides);

  const keyBindingsRef = useRef<KeybindingTable>(undefined);
  keyBindingsRef.current ??= new KeybindingTable({
    registry: commandRegistry,
    readContext: () => whenContextRef.current,
  });
  const keyBindings = keyBindingsRef.current;

  // Swapped in place, so a rebinding never detaches and re-attaches the listener.
  useEffect(() => {
    keyBindings.setBindings(keybindingSnapshot.bindings);
  }, [keyBindings, keybindingSnapshot]);

  // Absent while a chord is recorded: it listens in the capture phase, so recording `$mod+b`
  // would navigate to Sessions instead of binding it.
  useEffect(() => {
    if (keybindingSnapshot.recording) {
      return undefined;
    }
    return keyBindings.install(ownerWindow);
  }, [keyBindings, keybindingSnapshot, ownerWindow]);

  // Off the snapshot rather than the table: the table takes a rebinding in an effect, after the
  // render that draws the new chord.
  const readBoundChord = useCallback(
    (commandId: string) =>
      keybindingSnapshot.bindings.find((binding) => binding.commandId === commandId)?.chord,
    [keybindingSnapshot],
  );

  return {
    palette: {
      context: whenContext,
      bindings: keyBindings,
      revision,
      open: paletteOpen,
      onOpenChange: setPaletteOpen,
    },
    readBoundChord,
  };
}
