// This window's command registry, and the `when` vocabulary the console evaluates
// clauses against.
//
// One registry per window, held at module scope for the same reason
// `consoleSurfaceRegistry` and `consoleRouteRegistry` are: an auxiliary window is
// its own renderer process, so module scope IS window scope here, and a family can
// register its commands where it declares them rather than threading a registry
// through props it has no other use for. I-023-12's "auxiliary windows share no
// store" holds by construction — there is no channel between two processes' module
// graphs.
//
// WHY IT IS HERE AND NOT IN `frame/`, WHERE IT WAS WRITTEN. The frame was its first
// consumer, not its owner: every input is this family's or below it — `CommandRegistry`
// and `ConsoleCommand` beside this file, the host's chord platform from `primitives/`
// — and nothing below the frame reads the frame. Leaving it there made `frame/index.ts`
// the only door that could publish it, and that door is unreachable from both of the
// consumers this hoist is for. A VIEW family reaching it closes a cycle, measured on
// this tree with a planted family:
//
//   families.ts → <family>/index.ts → frame/index.ts → ConsoleRoot.tsx → families.ts
//
// and the console's other consumer — the composer's shell half, which sits ABOVE the
// console entirely — closes the same one, because `families.ts` composes its registrar
// in. So both wrote a deep specifier into the frame module that held it instead, which
// `console-cross-family-deep-import` and `renderer-reaches-console-through-doors`
// report; and a second registry built to avoid the import would be a second answer to
// which commands this window holds. Hoisting to the lowest family that owns the inputs
// is the remedy those rules name, and this is it.
//
// The frame's OWN commands are not registered here. They close over a live store,
// which module scope cannot reach, so `ConsoleRoot` registers them in an effect and
// removes them on unmount. Its own vocabulary — its command and binding shapes, its
// rail navigation table, and the chords it binds itself — is `command-surface.ts`
// beside this file, which followed the same rule here for the same reason.

import { HOST_CHORD_PLATFORM, type ChordPlatform } from "../primitives/index.js";
import { CommandRegistry } from "./command-registry.js";
import type { ConsoleCommand } from "./contributions.js";

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
 * The `when`-clause identifiers the console publishes.
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
 * the console would publish six keys and evaluate seven, and the extra one would
 * be silently false at every call site rather than a compile error at one.
 */
export const CONSOLE_WHEN_CLAUSE_KEYS = [
  "sessionActive",
  "onSessions",
  "onWorkspace",
  "onWorkflows",
  "onSettings",
  "inAuxiliaryWindow",
] as const;

export type ConsoleWhenClauseKey = (typeof CONSOLE_WHEN_CLAUSE_KEYS)[number];

/**
 * What the console evaluates a `when` clause against.
 *
 * Narrower than `WhenClauseContext` beside it, which is `Record<string, boolean>`
 * because a family may publish keys the console has never heard of. The console's
 * OWN context is exactly the vocabulary above — every key present, no key invented
 * — so a key added to the tuple is a compile error until every builder derives it,
 * and a key derived but never published is a compile error too.
 */
export type ConsoleWhenClauseContext = Readonly<Record<ConsoleWhenClauseKey, boolean>>;
