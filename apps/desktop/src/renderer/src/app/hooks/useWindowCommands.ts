// The window's own commands, and the palette and chord-table wiring that carries them.
//
// A hook, not a table: every command closes over this window's store or bridge. Registration,
// the installed binding set and the key listener change on different signals, so they are three
// effects; one effect would re-register every command on each press into the recorder.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Refusal } from "@renderer/lib/refusal.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { AppRoute } from "@renderer/routing/routes.js";
import type { WindowStore } from "@renderer/store/window/window-store.js";
import { subscribeToCommandContributions } from "@renderer/registries/commands/command-contributions.js";
import { publishCommandRefusalSink } from "@renderer/registries/commands/command-refusal.js";
import type { CommandDefinition } from "@renderer/registries/commands/command-types.js";
import type { WhenClauseContext } from "@renderer/registries/commands/when-clause/when-clause.js";
import {
  commandRegistry,
  registerCommands,
  type WindowWhenClauseContext,
} from "@renderer/registries/commands/window-command-registry.js";
import { useKeybindingSnapshot } from "@renderer/registries/keybindings/hooks/useKeybindingSnapshot.js";
import { keybindingOverrides } from "@renderer/registries/keybindings/keybinding-override-store.js";
import { KeybindingTable } from "@renderer/registries/keybindings/keybinding-table.js";
import type { ScreenRegistry } from "@renderer/registries/screens/screen-registry.js";
import type { CommandPaletteProps } from "@renderer/layout/CommandPalette/hooks/useCommandPalette.js";
import { buildNavigationCommands } from "@renderer/layout/NavigationRail/navigation-commands.js";
import { buildColorSchemeCommand, useBridgeCommands } from "@renderer/features/settings/index.js";

/** What the window's own commands are built against: this window's route, stores and screens. */
export interface WindowCommandsInput {
  readonly route: AppRoute;
  /**
   * The session this window has in hand, which outlives a route that names none;
   * `sessionActive` is derived from it rather than from the route.
   */
  readonly lastOpenedSessionId: string | undefined;
  readonly windowStore: WindowStore;
  /**
   * This machine's keyboard map, for the keybinding overrides: a rebound chord is
   * installed whether or not anybody opens the Keyboard page.
   */
  readonly keyboardMap: PlatformBridge["keyboardMap"];
  /** This window's act for the next color scheme in the cycle, which the `Color scheme` row runs. */
  readonly chooseNextScheme: () => void;
  /** The screen registry this window mounts through, for the destinations' own warm-up. */
  readonly screenRegistry: ScreenRegistry;
}

/**
 * Register the window's own commands, install its chord table, and return the palette's
 * props for this window: its `when` context, its bindings, its open state and the
 * revision that tells it the command set changed.
 */
export function useWindowCommands(
  input: WindowCommandsInput,
): Pick<CommandPaletteProps, "context" | "bindings" | "revision" | "open" | "onOpenChange"> {
  const { route, lastOpenedSessionId, windowStore, keyboardMap, chooseNextScheme, screenRegistry } =
    input;

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
  // The palette reads the registry once per revision, so a late registration bumps it.
  const [commandRevision, setCommandRevision] = useState(0);

  // A bridge-backed command with no view of its own refuses on a window banner.
  const raiseRefusalBanner = useCallback(
    (refusal: Refusal) => {
      windowStore.raiseRefusalBanner(refusal);
    },
    [windowStore],
  );

  // Memoized on the stable sink, so the registration effect runs once.
  const bridgeCommands = useBridgeCommands(raiseRefusalBanner);

  // The shipped chords with this person's overrides, and whether a recording suspends them.
  const keybindingSnapshot = useKeybindingSnapshot(keybindingOverrides);

  const keyBindingsRef = useRef<KeybindingTable>(undefined);
  keyBindingsRef.current ??= new KeybindingTable({
    registry: commandRegistry,
    readContext: () => whenContextRef.current,
  });
  const keyBindings = keyBindingsRef.current;

  // Removed on unmount so a second mount in one process (a test) does not collide with the
  // first. `registerAll` is atomic, so a duplicate adds none and cleanup cannot remove another
  // mount's command.
  useEffect(() => {
    const windowCommands: readonly CommandDefinition[] = [
      ...buildNavigationCommands(windowStore, screenRegistry),
      buildColorSchemeCommand(chooseNextScheme),
      ...bridgeCommands,
    ];
    registerCommands(windowCommands);
    // A later contribution adds commands the palette must list; its chords reach the table
    // through the override store, which republishes on the same signal.
    const stopWatchingContributions = subscribeToCommandContributions(() => {
      setCommandRevision((revision) => revision + 1);
    });
    // Published for as long as the commands are registered.
    const withdrawRefusalSink = publishCommandRefusalSink(raiseRefusalBanner);
    setCommandRevision((revision) => revision + 1);
    return () => {
      withdrawRefusalSink();
      stopWatchingContributions();
      for (const command of windowCommands) {
        commandRegistry.unregister(command.id);
      }
    };
  }, [bridgeCommands, windowStore, raiseRefusalBanner, screenRegistry, chooseNextScheme]);

  // Not awaited: `hydrateFrom` turns a failed read into a read refusal, so a rejection is a
  // defect.
  useEffect(() => {
    void keybindingOverrides.hydrateFrom(keyboardMap);
  }, [keyboardMap]);

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
    return keyBindings.install(window);
  }, [keyBindings, keybindingSnapshot]);

  return {
    context: whenContext,
    bindings: keyBindings,
    revision: commandRevision,
    open: paletteOpen,
    onOpenChange: setPaletteOpen,
  };
}
