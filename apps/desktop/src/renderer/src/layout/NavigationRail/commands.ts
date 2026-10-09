// The rail's own acts: one command per rail destination, walked from `RAIL_DESTINATIONS` so the
// palette, the chord table and the rail share one closed set, a chord for those that hold one, the
// rows of the rail's two controls, and the Sessions button's own act, which shows or hides the
// sessions list. Every row but that act sits in the palette's `Console` group; it sits in
// `Sessions`, the group the Keyboard page lists it under.

import { RAIL_DESTINATIONS, type RailDestination } from "#renderer/routing/readers.js";
import type { AppRoute } from "#renderer/routing/routes.js";
import type { CommandContributionRegistry } from "#renderer/registries/commands/contributions.js";
import type {
  FrameCommand,
  FrameKeybinding,
} from "#renderer/registries/commands/when-clause/vocabulary.js";
import type { ScreenRegistry } from "#renderer/registries/screens/registry.js";
import type { LastSettingsPage } from "#renderer/store/last-settings-page.js";
import { RAIL_CONTROL_LABELS } from "./control-labels.js";
import { RAIL_ENTRY_TEMPLATES } from "./NavigationRail.js";
import { routeForDestination, warmDestination } from "./destinations.js";

/** What the rail's control rows do, each on the window used last. */
export interface RailControlActs {
  readonly toggleSessionsList: () => void;
  readonly toggleNotificationsList: () => void;
  readonly chooseNextColorScheme: () => void;
}

/**
 * What the palette and the chord table need to offer one rail destination; its command ids are
 * written out because a person can rebind them on the Keyboard page, and Settings takes the
 * platform's own `$mod+,`. A command's title is the act's own name, or the rail label for a
 * destination with no act of its own.
 */
export const RAIL_NAVIGATION_DETAILS: Readonly<Record<RailDestination, RailNavigationDetail>> = {
  sessions: {
    commandId: "frame.goToSessions",
    title: RAIL_ENTRY_TEMPLATES.sessions.label,
    keywords: ["home"],
  },
  sidekicks: {
    commandId: "frame.goToSidekicks",
    title: RAIL_ENTRY_TEMPLATES.sidekicks.label,
    keywords: ["agents", "definitions", "plugins"],
  },
  skills: {
    commandId: "frame.goToSkills",
    title: RAIL_ENTRY_TEMPLATES.skills.label,
    keywords: ["instructions", "folders"],
  },
  workflows: {
    commandId: "frame.goToWorkflows",
    title: "Open Workflows",
    chord: "$mod+Shift+w",
    keywords: ["builder", "automation", "graph"],
  },
  settings: {
    commandId: "frame.goToSettings",
    title: "Open Settings",
    chord: "$mod+,",
    keywords: ["preferences", "options"],
  },
};

/** The Sessions button's act: it shows or hides the sessions list beside the rail. */
export const SESSIONS_LIST_COMMAND = {
  commandId: "frame.toggleSessionsList",
  title: "Sessions list",
  chord: "$mod+b",
} as const;

/**
 * The rail's chords: the sessions list's, then the destinations' that hold one, in rail order.
 *
 * The sessions list's fires in a text input too, since it leaves the screen and what was typed
 * where they are. No destination's does: navigating away mid-sentence loses what was typed.
 */
export const RAIL_KEYBINDINGS: readonly FrameKeybinding[] = [
  {
    chord: SESSIONS_LIST_COMMAND.chord,
    commandId: SESSIONS_LIST_COMMAND.commandId,
    allowInTextInput: true,
  },
  ...RAIL_DESTINATIONS.flatMap((destination) => {
    const { chord, commandId } = RAIL_NAVIGATION_DETAILS[destination];
    return chord === undefined ? [] : [{ chord, commandId }];
  }),
];

/**
 * Contributes the rail's chords ahead of every feature's, since the table listens in the capture
 * phase and the first match wins. The commands navigate the window a chord or palette row ran
 * in, so the app registers those once its windows are open.
 */
export function registerNavigationKeybindings(contributions: CommandContributionRegistry): void {
  contributions.contribute({
    owner: NAVIGATION_COMMAND_OWNER,
    commands: [],
    keyBindings: RAIL_KEYBINDINGS,
  });
}

/**
 * One command per rail destination, titled with its act's name. Each warms the screen before
 * handing `navigate` the destination's route, and again while its palette row is highlighted;
 * Settings opens on the page last open.
 */
export function buildNavigationCommands(
  navigate: (route: AppRoute) => void,
  screenRegistry: ScreenRegistry,
  lastSettingsPage: LastSettingsPage,
): readonly FrameCommand[] {
  return RAIL_DESTINATIONS.map((destination) => ({
    id: RAIL_NAVIGATION_DETAILS[destination].commandId,
    title: RAIL_NAVIGATION_DETAILS[destination].title,
    group: CONSOLE_COMMAND_GROUP,
    keywords: RAIL_NAVIGATION_DETAILS[destination].keywords,
    run: () => {
      warmDestination(screenRegistry, destination);
      navigate(routeForDestination(destination, lastSettingsPage.pageId));
    },
    preload: () => {
      warmDestination(screenRegistry, destination);
    },
  }));
}

/**
 * The rows of the rail's controls: the Sessions button's act, which shows or hides the sessions
 * list, then the two controls titled with the rail's labels, one opening or shutting the
 * notifications list, the other stepping the color scheme. The caller's acts pick the window.
 */
export function buildRailControlCommands(acts: RailControlActs): readonly FrameCommand[] {
  return [
    {
      id: SESSIONS_LIST_COMMAND.commandId,
      title: SESSIONS_LIST_COMMAND.title,
      group: SESSIONS_COMMAND_GROUP,
      keywords: ["sidebar", "flyout"],
      run: acts.toggleSessionsList,
    },
    {
      id: "frame.toggleNotifications",
      title: RAIL_CONTROL_LABELS.notifications,
      group: CONSOLE_COMMAND_GROUP,
      keywords: ["attention", "waiting", "bell"],
      run: acts.toggleNotificationsList,
    },
    {
      id: "frame.cycleColorScheme",
      title: RAIL_CONTROL_LABELS.colorScheme,
      group: CONSOLE_COMMAND_GROUP,
      keywords: ["dark", "light", "system"],
      run: acts.chooseNextColorScheme,
    },
  ];
}

interface RailNavigationDetail {
  readonly commandId: string;
  readonly title: string;
  /** tinykeys syntax, single press; absent while the destination ships with no chord. */
  readonly chord?: string;
  /** Extra words a person might type for this destination in the palette. */
  readonly keywords: readonly string[];
}

const NAVIGATION_COMMAND_OWNER = "navigation";

/** The palette group every rail row but the sessions list's sits in. */
const CONSOLE_COMMAND_GROUP = "Console";

/** The palette and Keyboard group the sessions list's act sits in. */
const SESSIONS_COMMAND_GROUP = "Sessions";
