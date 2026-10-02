// The rail's own acts: one command and one chord per rail destination, walked from
// `RAIL_DESTINATIONS` so the palette, the chord table and the rail share one closed set.

import { RAIL_DESTINATIONS, type RailDestination } from "@renderer/routing/route-readers.js";
import type { WindowStore } from "@renderer/store/window/window-store.js";
import type { CommandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import type {
  FrameCommand,
  FrameKeybinding,
} from "@renderer/registries/commands/window-command-registry.js";
import type { ScreenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { RAIL_ENTRY_TEMPLATES } from "./NavigationRail.js";
import { routeForDestination, warmDestination } from "./rail-navigation.js";

/**
 * What the palette and the chord table need to offer one rail destination. Command ids are written
 * out because a person can rebind them on the Keyboard page; Settings takes `$mod+,`.
 */
export const RAIL_NAVIGATION_DETAILS: Readonly<Record<RailDestination, RailNavigationDetail>> = {
  sessions: {
    commandId: "frame.goToSessions",
    chord: "$mod+1",
    keywords: ["list", "home"],
  },
  workflows: {
    commandId: "frame.goToWorkflows",
    chord: "$mod+2",
    keywords: ["builder", "automation", "graph"],
  },
  settings: {
    commandId: "frame.goToSettings",
    chord: "$mod+,",
    keywords: ["preferences", "options"],
  },
};

/**
 * The rail's chords, one per destination in rail order.
 *
 * None fires in a text input: navigating away mid-sentence loses what was typed.
 */
export const RAIL_KEYBINDINGS: readonly FrameKeybinding[] = RAIL_DESTINATIONS.map(
  (destination) => ({
    chord: RAIL_NAVIGATION_DETAILS[destination].chord,
    commandId: RAIL_NAVIGATION_DETAILS[destination].commandId,
  }),
);

/**
 * Contributes the rail's chords ahead of every feature's, since the table listens in the capture
 * phase and the first match wins. The commands close over a window's store, so the window
 * registers those on mount.
 */
export function registerNavigationKeybindings(contributions: CommandContributionRegistry): void {
  contributions.contribute({
    owner: NAVIGATION_COMMAND_OWNER,
    commands: [],
    keyBindings: RAIL_KEYBINDINGS,
  });
}

/**
 * One command per rail destination, titled with the rail's label. Each warms the screen before
 * navigating, and again while its palette row is highlighted.
 */
export function buildNavigationCommands(
  frameStore: WindowStore,
  screenRegistry: ScreenRegistry,
): readonly FrameCommand[] {
  return RAIL_DESTINATIONS.map((destination) => ({
    id: RAIL_NAVIGATION_DETAILS[destination].commandId,
    title: RAIL_ENTRY_TEMPLATES[destination].label,
    group: "Console",
    keywords: RAIL_NAVIGATION_DETAILS[destination].keywords,
    run: () => {
      warmDestination(screenRegistry, destination);
      frameStore.navigate(routeForDestination(destination));
    },
    preload: () => {
      warmDestination(screenRegistry, destination);
    },
  }));
}

interface RailNavigationDetail {
  readonly commandId: string;
  /** tinykeys syntax, single press. */
  readonly chord: string;
  /** Extra words a person might type for this destination in the palette. */
  readonly keywords: readonly string[];
}

const NAVIGATION_COMMAND_OWNER = "navigation";
