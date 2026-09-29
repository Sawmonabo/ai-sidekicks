// The window's own commands, and the palette and chord-table wiring that carries them.
//
// A hook rather than a table: every command here closes over this window's store or
// bridge, so they are built per window, registered from an effect and removed on
// unmount. Registration, the installed binding set and the key listener move on three
// clocks (the commands when the store or bridge acts change, the set when somebody
// rebinds, the listener while a chord is being recorded), so they are three effects;
// one effect would re-register every command on each press into the recorder.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useBridgeCommands } from "@renderer/console/palette/commands/bridge-commands.js";
import type { ConsoleRefusal } from "@renderer/lib/refusal.js";
import type { ConsoleRoute } from "@renderer/routing/routes.js";
import type { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import type { FrameStore } from "@renderer/store/window/window-store.js";
import { subscribeToConsoleFamilyContributions } from "@renderer/registries/commands/command-contributions.js";
import { publishConsoleActRefusalSink } from "@renderer/registries/commands/command-refusal.js";
import type { ConsoleCommand } from "@renderer/registries/commands/command-types.js";
import type { WhenClauseContext } from "@renderer/registries/commands/when-clause/when-clause.js";
import {
  consoleCommands,
  registerConsoleCommands,
  type ConsoleWhenClauseContext,
} from "@renderer/registries/commands/window-command-registry.js";
import { useKeybindingSurface } from "@renderer/registries/keybindings/hooks/useKeybindingSnapshot.js";
import { consoleKeybindingOverrides } from "@renderer/registries/keybindings/keybinding-override-store.js";
import { KeyBindingTable } from "@renderer/registries/keybindings/keybinding-table.js";
import type { ConsoleSurfaceRegistry } from "@renderer/registries/screens/screen-registry.js";
import type { PaletteOverlayProps } from "@renderer/layout/CommandPalette/hooks/useCommandPalette.js";
import { buildNavigationCommands } from "@renderer/layout/NavigationRail/navigation-commands.js";

/** What the window's own commands are built against: this window's route, stores and screens. */
export interface FrameCommandSurfaceInput {
  readonly route: ConsoleRoute;
  /**
   * The session this window has in hand, which outlives a route that names none;
   * `sessionActive` is derived from it rather than from the route.
   */
  readonly lastOpenedSessionId: string | undefined;
  readonly frameStore: FrameStore;
  /**
   * This window's durable store, for the keybinding overrides: a rebound chord is
   * installed whether or not anybody opens the Keyboard page.
   */
  readonly uiStateStore: UiStateStore;
  /** The screen registry this window mounts through, for the destinations' own warm-up. */
  readonly surfaceRegistry: ConsoleSurfaceRegistry;
}

/**
 * Register the window's own commands, install its chord table, and return the palette's
 * props for this window: its `when` context, its bindings, its open state and the
 * revision that tells it the command set changed.
 */
export function useFrameCommandSurface(
  input: FrameCommandSurfaceInput,
): Pick<PaletteOverlayProps, "context" | "bindings" | "revision" | "open" | "onOpenChange"> {
  const { route, lastOpenedSessionId, frameStore, uiStateStore, surfaceRegistry } = input;

  // Derived from the route rather than stored, so the palette cannot disagree with the
  // rail about where the window is.
  const whenContext: ConsoleWhenClauseContext = useMemo(
    () => ({
      sessionActive: lastOpenedSessionId !== undefined,
      onSessions: route.kind === "sessions",
      onWorkspace: route.kind === "workspace",
      onWorkflows: route.kind === "workflows",
      onSettings: route.kind === "settings",
    }),
    [route, lastOpenedSessionId],
  );

  // Read through a ref: the table is built once with one listener, and a closure
  // captured at construction would evaluate every chord against the opening route.
  const whenContextRef = useRef<WhenClauseContext>(whenContext);
  whenContextRef.current = whenContext;

  const [paletteOpen, setPaletteOpen] = useState(false);
  // The palette reads the registry once per revision, so a registration that lands
  // after the first render needs the revision bumped.
  const [commandRevision, setCommandRevision] = useState(0);

  // A bridge-backed command with no surface of its own refuses on a window banner,
  // which the store composes.
  const raiseRefusalBanner = useCallback(
    (refusal: ConsoleRefusal) => {
      frameStore.raiseRefusalBanner(refusal);
    },
    [frameStore],
  );

  // Memoized on that stable sink, so the registration effect below runs once.
  const bridgeCommands = useBridgeCommands(raiseRefusalBanner);

  // The shipped chords with this person's overrides composed onto them, and whether
  // the keyboard is suspended for a recording.
  const keybindingSurface = useKeybindingSurface(consoleKeybindingOverrides);

  const keyBindingsRef = useRef<KeyBindingTable>(undefined);
  keyBindingsRef.current ??= new KeyBindingTable({
    registry: consoleCommands,
    readContext: () => whenContextRef.current,
  });
  const keyBindings = keyBindingsRef.current;

  // Removed on unmount, so a second mount in one process (a test, a StrictMode
  // double-render) does not collide with the first. `registerAll` is atomic, so a
  // duplicate adds none of the list and the cleanup cannot remove another mount's command.
  useEffect(() => {
    const windowCommands: readonly ConsoleCommand[] = [
      ...buildNavigationCommands(frameStore, surfaceRegistry),
      ...bridgeCommands,
    ];
    registerConsoleCommands(windowCommands);
    // A feature that contributes later adds commands the palette must list, so the
    // revision moves with every contribution. Its chords reach the table through the
    // override store, which republishes on the same signal.
    const stopWatchingContributions = subscribeToConsoleFamilyContributions(() => {
      setCommandRevision((revision) => revision + 1);
    });
    // Published for as long as the commands are registered: the same lifetime.
    const withdrawRefusalSink = publishConsoleActRefusalSink(raiseRefusalBanner);
    setCommandRevision((revision) => revision + 1);
    return () => {
      withdrawRefusalSink();
      stopWatchingContributions();
      for (const command of windowCommands) {
        consoleCommands.unregister(command.id);
      }
    };
  }, [bridgeCommands, frameStore, raiseRefusalBanner, surfaceRegistry]);

  // The overrides a person authored, read back once per window. Not awaited:
  // `hydrateFrom` absorbs a failed read, so a rejection escaping here is a defect.
  useEffect(() => {
    void consoleKeybindingOverrides.hydrateFrom(uiStateStore);
  }, [uiStateStore]);

  // Swapped in place, so a rebinding never detaches and re-attaches the listener.
  useEffect(() => {
    keyBindings.setBindings(keybindingSurface.bindings);
  }, [keyBindings, keybindingSurface]);

  // The listener is absent while a chord is recorded: it listens in the capture phase,
  // so recording `$mod+1` would otherwise navigate to Sessions instead of binding it.
  useEffect(() => {
    if (keybindingSurface.recording) {
      return undefined;
    }
    return keyBindings.install(window);
  }, [keyBindings, keybindingSurface]);

  const changePaletteOpen = useCallback((open: boolean) => {
    setPaletteOpen(open);
  }, []);

  return {
    context: whenContext,
    bindings: keyBindings,
    revision: commandRevision,
    open: paletteOpen,
    onOpenChange: changePaletteOpen,
  };
}
