// One window's palette and chord table over the app's commands. The table listens on the window's
// own document, since a key pressed in one window reaches only that window, and reads the window's
// own `when` context; the commands are registered once for the app (`useAppCommands.ts`).

import { useEffect, useMemo, useRef, useState } from "react";

import type { AppRoute } from "#renderer/routing/routes.js";
import type { WhenClauseContext } from "#renderer/registries/commands/when-clause/when-clause.js";
import {
  commandRegistry,
  type WindowWhenClauseContext,
} from "#renderer/registries/commands/window-command-registry.js";
import { useKeybindingSnapshot } from "#renderer/registries/keybindings/hooks/useKeybindingSnapshot.js";
import { keybindingOverrides } from "#renderer/registries/keybindings/keybinding-override-store.js";
import { KeybindingTable } from "#renderer/registries/keybindings/keybinding-table.js";
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

/**
 * Install this window's chord table and return its palette's props: its `when` context, its
 * bindings, its open state, its chord target and the app's command revision.
 */
export function useWindowCommands(
  input: WindowCommandsInput,
): Pick<CommandPaletteProps, "context" | "bindings" | "revision" | "open" | "onOpenChange"> {
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

  // Absent while a chord is recorded: it listens in the capture phase, so recording `$mod+1`
  // would navigate to Sessions instead of binding it.
  useEffect(() => {
    if (keybindingSnapshot.recording) {
      return undefined;
    }
    return keyBindings.install(ownerWindow);
  }, [keyBindings, keybindingSnapshot, ownerWindow]);

  return {
    context: whenContext,
    bindings: keyBindings,
    revision,
    open: paletteOpen,
    onOpenChange: setPaletteOpen,
  };
}
