// The rail's own acts: one command and one chord per rail destination.
//
// The destinations are walked from `RAIL_DESTINATIONS`, so the palette, the chord table
// and the rail offer one closed set; a destination added to the rail gets its command,
// its chord and its warm-up with it.

import { RAIL_DESTINATIONS, type RailDestination } from "@renderer/routing/route-readers.js";
import type { FrameStore } from "@renderer/store/window/window-store.js";
import type { CommandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import type {
  FrameCommand,
  FrameKeybinding,
} from "@renderer/registries/commands/window-command-registry.js";
import type { ScreenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { RAIL_ENTRY_TEMPLATES } from "./NavigationRail.js";
import { routeForDestination, warmDestination } from "./rail-navigation.js";

/**
 * What the palette and the chord table need to offer one rail destination.
 *
 * The ids are written out (`frame.goToSessions`) because a person can rebind them on
 * the Keyboard page. The first two chords are positional; Settings takes `$mod+,`, the
 * platform's settings chord on every desktop the app targets.
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
 * Contribute the rail's chords, ahead of every feature's.
 *
 * The chords are the window's first rows because the table listens in the capture
 * phase and the first match wins. The commands they run close over a window's store,
 * so the window registers those when it mounts.
 */
export function registerNavigationKeybindings(contributions: CommandContributionRegistry): void {
  contributions.contribute({
    owner: NAVIGATION_COMMAND_OWNER,
    commands: [],
    keyBindings: RAIL_KEYBINDINGS,
  });
}

/**
 * One `Go to` command per rail destination, titled with the rail's own label.
 *
 * Each warms the destination's screen before navigating, so a chord that never
 * highlights a palette row still has the chunk in flight when the screen mounts, and
 * warms it again while its palette row is highlighted.
 */
export function buildNavigationCommands(
  frameStore: FrameStore,
  surfaceRegistry: ScreenRegistry,
): readonly FrameCommand[] {
  return RAIL_DESTINATIONS.map((destination) => ({
    id: RAIL_NAVIGATION_DETAILS[destination].commandId,
    title: `Go to ${RAIL_ENTRY_TEMPLATES[destination].label}`,
    group: "Navigate",
    keywords: RAIL_NAVIGATION_DETAILS[destination].keywords,
    run: () => {
      warmDestination(surfaceRegistry, destination);
      frameStore.navigate(routeForDestination(destination));
    },
    preload: () => {
      warmDestination(surfaceRegistry, destination);
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
