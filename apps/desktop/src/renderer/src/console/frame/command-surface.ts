// The command registry, and the door a family contributes to it through.
//
// One registry per window, held at module scope for the same reason
// `consoleSurfaceRegistry` and `consoleRouteRegistry` are: an auxiliary window is
// its own renderer process, so module scope IS window scope here, and a family can
// register its commands where it declares them rather than threading a registry
// through props it has no other use for. I-023-12's "auxiliary windows share no
// store" holds by construction — there is no channel between two processes' module
// graphs.
//
// The frame's OWN commands are not registered here. They close over a live store,
// which module scope cannot reach, so `ConsoleRoot` registers them in an effect and
// removes them on unmount.

import { CommandRegistry, type ConsoleCommand, type KeyBinding } from "../palette/index.js";
import { HOST_CHORD_PLATFORM, type ChordPlatform } from "../primitives/index.js";
import { RAIL_DESTINATIONS, type RailDestination } from "../routing/index.js";

/** This window's command registry. */
export const consoleCommands: CommandRegistry = new CommandRegistry();

/**
 * Contribute one command.
 *
 * Refuses a duplicate id rather than replacing: two families that both register
 * `session.open` have a real conflict, and silently keeping the last one would make
 * which command runs depend on module import order.
 */
export function registerConsoleCommand(command: ConsoleCommand): void {
  consoleCommands.register(command);
}

/** Contribute several. Atomic — every id is validated before any is added. */
export function registerConsoleCommands(commands: readonly ConsoleCommand[]): void {
  consoleCommands.registerAll(commands);
}

/**
 * The platform the chord printer formats for.
 *
 * Re-exported from the chord vocabulary's single host reading rather than detected
 * again here. A second detection is how the printed and spoken forms of a chord
 * came apart once already; one reading is why they cannot.
 */
export const CONSOLE_CHORD_PLATFORM: ChordPlatform = HOST_CHORD_PLATFORM;

/**
 * The `when`-clause identifiers the frame publishes.
 *
 * Named here rather than as free strings at each call site so a family writing
 * `when: "sessionActive"` can see the vocabulary it is writing against, and so a
 * typo is a missing key (the clause evaluates false, the command is hidden)
 * rather than an invented one.
 *
 * There is one key per main-window route kind, `workspace` included: the workspace
 * is not a rail destination but it IS somewhere a person can be, and a "where am
 * I" vocabulary that skipped it would leave a family no way to scope a command to
 * the surface that has the most of them.
 *
 * The tuple is the declaration and every type below is derived from it. A second
 * hand-written union would be a closed set the compiler could not keep closed:
 * the frame would publish six keys and evaluate seven, and the extra one would be
 * silently false at every call site rather than a compile error at one.
 */
export const FRAME_WHEN_CLAUSE_KEYS = [
  "sessionActive",
  "onSessions",
  "onWorkspace",
  "onWorkflows",
  "onSettings",
  "inAuxiliaryWindow",
] as const;

export type FrameWhenClauseKey = (typeof FRAME_WHEN_CLAUSE_KEYS)[number];

/**
 * What the frame evaluates a `when` clause against.
 *
 * Narrower than the palette's `WhenClauseContext`, which is `Record<string,
 * boolean>` because a family may publish keys the frame has never heard of. The
 * frame's OWN context is exactly the vocabulary above — every key present, no key
 * invented — so a key added to the tuple is a compile error until the frame
 * derives it, and a key derived but never published is a compile error too.
 */
export type FrameWhenClauseContext = Readonly<Record<FrameWhenClauseKey, boolean>>;

/** A command the frame itself contributes: its `when` is the frame's vocabulary. */
export type FrameCommand = Omit<ConsoleCommand, "when"> & {
  readonly when?: FrameWhenClauseKey;
};

/** A chord the frame itself binds, scoped to the same vocabulary. */
export type FrameKeyBinding = Omit<KeyBinding, "when"> & {
  readonly when?: FrameWhenClauseKey;
};

/**
 * What the palette and the chord table need to offer one rail destination.
 *
 * Module-private: it names the shape of the table below and nothing consumes it
 * apart from that table, so exporting it would publish a type no caller can use
 * for anything the record does not already answer.
 */
interface RailNavigationDetail {
  readonly commandId: string;
  /** tinykeys syntax, single press. */
  readonly chord: string;
  /** Extra words a person might type for this destination in the palette. */
  readonly keywords: readonly string[];
}

/**
 * Going to a destination, as data — one row per destination, and the compiler
 * holds it total.
 *
 * A table rather than three hand-written commands beside three hand-written
 * bindings. Those were three lists over one closed set (`RAIL_DESTINATIONS`), and
 * the way they came apart is on record: the rail declared `workspace` where the
 * spec names `workflows`, and the palette and the chord table agreed with the rail
 * because each had been written to match the other rather than the set.
 *
 * The ids are written out rather than composed from the destination name. They are
 * the console's public command vocabulary — a person can bind one on the Keyboard
 * page — so they read as the console's other ids read (`family.verbNoun`), and
 * totality over the union is what makes the membership uncheatable regardless.
 *
 * The chords are positional for the first two and conventional for the third:
 * `$mod+,` is the platform's settings chord on every desktop the console targets,
 * and giving Settings a `$mod+3` to make the row tidy would cost a person the one
 * chord they already know.
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
 * Chords the frame itself binds. A family's chords ride its own registration.
 *
 * Walked from `RAIL_DESTINATIONS` so the bound set and the rendered set are one
 * set. Nothing else is bound here: `frame.goToWorkspace` is offered in the palette
 * and carries no chord, because the three chords a person builds muscle memory for
 * are the three icons in front of them, and a fourth binding on a destination the
 * rail does not draw is a keystroke with nothing to point at.
 */
export const FRAME_KEY_BINDINGS: readonly FrameKeyBinding[] = RAIL_DESTINATIONS.map(
  (destination) => ({
    chord: RAIL_NAVIGATION_DETAILS[destination].chord,
    commandId: RAIL_NAVIGATION_DETAILS[destination].commandId,
  }),
);
