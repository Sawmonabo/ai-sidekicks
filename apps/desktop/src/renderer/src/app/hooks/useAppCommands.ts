// The commands every window offers, registered once for the app. A chord or a palette row runs in
// the window a person is using, so each command acts on the window used last: the one holding
// focus whenever a key is pressed or a row picked. A command with no view of its own states its
// refusal on that window's banner.

import { useCallback, useEffect, useState } from "react";

import { RefusalError, type Refusal } from "#renderer/lib/refusal/contract.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { AppearanceClient } from "#renderer/services/window/appearance-client.js";
import type { LastSettingsPage } from "#renderer/store/last-settings-page.js";
import type { WindowStore } from "#renderer/store/window/store.js";
import { subscribeToCommandContributions } from "#renderer/registries/commands/contributions.js";
import { publishCommandRefusalSink } from "#renderer/registries/commands/refusal.js";
import { publishCommandWindow } from "#renderer/registries/commands/command-window.js";
import type { CommandDefinition } from "#renderer/registries/commands/definition.js";
import { commandRegistry, registerCommands } from "#renderer/registries/commands/registry.js";
import { keybindingOverrides } from "#renderer/registries/keybindings/overrides/store.js";
import type { ScreenRegistry } from "#renderer/registries/screens/registry.js";
import {
  buildNavigationCommands,
  buildRailControlCommands,
} from "#renderer/layout/NavigationRail/commands.js";
import { useBridgeCommands } from "#renderer/features/settings/index.js";
import { discloseUnkeptScheme } from "../unkept-scheme.js";

/** What the app's commands act through. */
export interface AppCommandsInput {
  /** The store of the window used last; `undefined` while no window is open. */
  readonly windowStoreUsedLast: () => WindowStore | undefined;
  /** The document of the window used last, where a feature's command finds its mounted target. */
  readonly documentUsedLast: () => Document | undefined;
  /**
   * This machine's keyboard map, for the keybinding overrides: a rebound chord is
   * installed whether or not anybody opens the Keyboard page.
   */
  readonly keyboardMap: PlatformBridge["keyboardMap"];
  readonly appearance: AppearanceClient;
  /** The screen registry the windows mount through, for the destinations' own warm-up. */
  readonly screenRegistry: ScreenRegistry;
  /** The settings page last open, which the Settings command opens again. */
  readonly lastSettingsPage: LastSettingsPage;
}

/**
 * Register the app's own commands and hydrate the keyboard map, and return the revision that tells
 * every window's palette the command set changed.
 */
export function useAppCommands(input: AppCommandsInput): number {
  const {
    windowStoreUsedLast,
    documentUsedLast,
    keyboardMap,
    appearance,
    screenRegistry,
    lastSettingsPage,
  } = input;

  // The palette reads the registry once per revision, so a late registration bumps it.
  const [commandRevision, setCommandRevision] = useState(0);

  // A command runs only from a window, so a refusal with none open has nobody to read it.
  const raiseRefusalBanner = useCallback(
    (refusal: Refusal) => {
      const windowStore = windowStoreUsedLast();
      if (windowStore === undefined) {
        throw new RefusalError(refusal);
      }
      windowStore.raiseRefusalBanner(refusal);
    },
    [windowStoreUsedLast],
  );

  // Memoized on the stable sink, so the registration effect runs once.
  const bridgeCommands = useBridgeCommands(raiseRefusalBanner);

  // Removed on unmount so a second mount in one process (a test) does not collide with the
  // first. `registerAll` is atomic, so a duplicate adds none and cleanup cannot remove another
  // mount's command.
  useEffect(() => {
    const appCommands: readonly CommandDefinition[] = [
      ...buildNavigationCommands(
        (route) => {
          windowStoreUsedLast()?.navigate(route);
        },
        screenRegistry,
        lastSettingsPage,
      ),
      ...buildRailControlCommands({
        toggleNotificationsList: () => {
          windowStoreUsedLast()?.toggleNotificationsList();
        },
        chooseNextColorScheme: () => {
          const windowStore = windowStoreUsedLast();
          if (windowStore !== undefined) {
            discloseUnkeptScheme(appearance.chooseNextScheme(), windowStore);
          }
        },
      }),
      ...bridgeCommands,
    ];
    registerCommands(appCommands);
    // A later contribution adds commands the palettes must list; its chords reach the tables
    // through the override store, which republishes on the same signal.
    const stopWatchingContributions = subscribeToCommandContributions(() => {
      setCommandRevision((revision) => revision + 1);
    });
    // Published for as long as the commands are registered.
    const withdrawRefusalSink = publishCommandRefusalSink(raiseRefusalBanner);
    const withdrawCommandWindow = publishCommandWindow(documentUsedLast);
    setCommandRevision((revision) => revision + 1);
    return () => {
      withdrawCommandWindow();
      withdrawRefusalSink();
      stopWatchingContributions();
      for (const command of appCommands) {
        commandRegistry.unregister(command.id);
      }
    };
  }, [
    bridgeCommands,
    windowStoreUsedLast,
    documentUsedLast,
    raiseRefusalBanner,
    screenRegistry,
    appearance,
    lastSettingsPage,
  ]);

  // Not awaited: `hydrateFrom` turns a failed read into a read refusal, so a rejection is a
  // defect.
  useEffect(() => {
    void keybindingOverrides.hydrateFrom(keyboardMap);
  }, [keyboardMap]);

  return commandRevision;
}
