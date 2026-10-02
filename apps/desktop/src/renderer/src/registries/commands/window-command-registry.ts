// This window's command registry and the `when` vocabulary its clauses are written against.
//
// Module scope is window scope: every window is its own renderer process, so a feature
// registers its commands where it declares them instead of threading a registry through
// props. A window's own commands close over its store, so they are registered from an
// effect and removed on unmount.

import { CommandRegistry } from "./command-registry.js";
import type { CommandDefinition, Keybinding } from "./command-types.js";

/** This window's command registry. */
export const commandRegistry: CommandRegistry = new CommandRegistry();

/** Registers several commands atomically: every id is validated before any is added. */
export function registerCommands(commands: readonly CommandDefinition[]): void {
  commandRegistry.registerAll(commands);
}

/**
 * The `when`-clause keys the window publishes: one per main-window route kind plus
 * `sessionActive`. The types below derive from it, so a new key is a compile error until every
 * context builder supplies it.
 */
export const WHEN_CLAUSE_KEYS = [
  "sessionActive",
  "onSessions",
  "onSession",
  "onWorkflows",
  "onSettings",
] as const;

/** One key of the window's `when` vocabulary. */
export type WhenClauseKey = (typeof WHEN_CLAUSE_KEYS)[number];

/**
 * The clause a session-scoped command or chord is offered under: true while the window has a
 * session open. Imported rather than spelled, since a mistyped clause silently hides a command.
 */
export const WHEN_SESSION_ACTIVE: WhenClauseKey = "sessionActive";

/** What the window evaluates a `when` clause against; narrower than `WhenClauseContext`. */
export type WindowWhenClauseContext = Readonly<Record<WhenClauseKey, boolean>>;

/** A command the window itself contributes; its `when` is the window's vocabulary. */
export type FrameCommand = Omit<CommandDefinition, "when"> & {
  readonly when?: WhenClauseKey;
};

/** A chord the window itself binds, scoped to the same vocabulary. */
export type FrameKeybinding = Omit<Keybinding, "when"> & {
  readonly when?: WhenClauseKey;
};
