// What a feature contributes to the palette. It imports nothing from this folder, so
// `registry.ts`, `ranking.ts` and `../keybindings/conflicts.ts` form no import cycle (type-only
// cycles count in the layering check).

/** One act the app offers. */
export interface CommandDefinition {
  /** Stable, unique, namespaced by owning feature — `session.rename`, not `rename`. */
  readonly id: string;
  /** Sentence case, no trailing punctuation, names the act. */
  readonly title: string;
  /** The palette category this row sits under. Also a secondary match field. */
  readonly group: string;
  /** A `when-clause/semantics.ts` expression. Absent means unconditional. */
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
   * Why this row cannot run now, in the owning feature's words; `undefined` where it can, and a
   * getter where the reason moves with what is on screen. The palette still lists it and shows the
   * reason beside it and in the refusal a press earns; a chord pressed on it does nothing; the
   * composer's command list leaves it out, and typed there the word is sent to the provider as
   * typed. Use `when` for an act that does not exist in this scope.
   */
  readonly unavailable?: string | undefined;
  /**
   * `false` for a palette-only act no chord may claim: Settings › Keyboard lists no row for it.
   * Absent for every other command.
   */
  readonly takesChord?: false;
}
