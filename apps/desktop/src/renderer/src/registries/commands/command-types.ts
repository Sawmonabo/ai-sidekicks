// What a feature contributes to the palette: a command and optionally a chord for it.
//
// These are the registry's input types, kept in a module that imports nothing from this
// folder so `command-registry.ts`, `command-ranking.ts` and `keybinding-conflicts.ts` do not
// form an import cycle (type-only cycles count in the layering check).

/** One act the console offers. */
export interface CommandDefinition {
  /** Stable, unique, namespaced by owning feature — `session.rename`, not `rename`. */
  readonly id: string;
  /** Sentence case, no trailing punctuation, names the act. */
  readonly title: string;
  /** The palette category this row sits under. Also a secondary match field. */
  readonly group: string;
  /** A `when-clause/when-clause.ts` expression. Absent means unconditional. */
  readonly when?: string;
  /** Extra words a person might type for this command. Matched below the title. */
  readonly keywords?: readonly string[];
  /**
   * Performs the act. The registry never awaits it and the palette drops the promise, so a
   * rejection becomes an unhandled rejection: a command that can fail must catch and render
   * its own failure (see `raiseCommandRefusal`).
   */
  readonly run: () => void | Promise<void>;
  /**
   * Warms whatever `run` will open (a loader-backed destination or pane body); the palette
   * calls it when the row is highlighted. It runs on every arrow key, so it must be
   * idempotent and must not navigate. Returns nothing because nobody waits on it.
   */
  readonly preload?: () => void;
  /**
   * Why this row cannot run now, in the owning feature's words; absent where it can. The row
   * still lists and shows the reason beside it and in the refusal a press earns. Use `when`
   * for an act that does not exist in this scope.
   */
  readonly unavailable?: string;
}

/** One chord bound to one command, optionally scoped. */
export interface Keybinding {
  /** tinykeys syntax, single press, `$mod` for Cmd on macOS and Ctrl elsewhere. */
  readonly chord: string;
  readonly commandId: string;
  /** A `when-clause/when-clause.ts` expression. Absent means the binding is always live. */
  readonly when?: string;
  /**
   * Fire even while focus is in a text field. Default false: a chord that wrongly fires
   * while typing destroys text, while one that wrongly declines only sends a person to a menu.
   */
  readonly allowInTextInput?: boolean;
}
