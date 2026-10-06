// The `when` vocabulary this window publishes: the keys its clauses are written against, and the
// command and chord shapes the window contributes in that vocabulary.

import type { CommandDefinition } from "../definition.js";
import type { Keybinding } from "../keybinding.js";

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
