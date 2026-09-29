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

/** Contribute several commands. Atomic: every id is validated before any is added. */
export function registerCommands(commands: readonly CommandDefinition[]): void {
  commandRegistry.registerAll(commands);
}

/**
 * The `when`-clause keys the window publishes, one per main-window route kind plus
 * `sessionActive`.
 *
 * The tuple is the declaration and every type below derives from it, so a key added
 * here is a compile error until every context builder supplies it; a typo at a call
 * site is a missing key (the command hides) rather than an invented one.
 */
export const WHEN_CLAUSE_KEYS = [
  "sessionActive",
  "onSessions",
  "onWorkspace",
  "onWorkflows",
  "onSettings",
] as const;

/** One key of the window's `when` vocabulary. */
export type WhenClauseKey = (typeof WHEN_CLAUSE_KEYS)[number];

/**
 * What the window evaluates a `when` clause against: every published key, none invented.
 *
 * Narrower than `WhenClauseContext`, which admits keys a feature publishes on its own.
 */
export type WindowWhenClauseContext = Readonly<Record<WhenClauseKey, boolean>>;

/** A command the window itself contributes; its `when` is the window's vocabulary. */
export type FrameCommand = Omit<CommandDefinition, "when"> & {
  readonly when?: WhenClauseKey;
};

/** A chord the window itself binds, scoped to the same vocabulary. */
export type FrameKeybinding = Omit<Keybinding, "when"> & {
  readonly when?: WhenClauseKey;
};
