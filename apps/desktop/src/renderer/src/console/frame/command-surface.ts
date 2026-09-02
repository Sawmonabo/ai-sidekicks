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
 * The tuple is the declaration and every type below is derived from it. A second
 * hand-written union would be a closed set the compiler could not keep closed:
 * the frame would publish five keys and evaluate six, and the extra one would be
 * silently false at every call site rather than a compile error at one.
 */
export const FRAME_WHEN_CLAUSE_KEYS = [
  "sessionActive",
  "onSessions",
  "onWorkspace",
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

/** Chords the frame itself binds. A family's chords ride its own registration. */
export const FRAME_KEY_BINDINGS: readonly FrameKeyBinding[] = [
  { chord: "$mod+1", commandId: "frame.goToSessions" },
  { chord: "$mod+2", commandId: "frame.goToWorkspace", when: "sessionActive" },
  { chord: "$mod+,", commandId: "frame.goToSettings" },
];
