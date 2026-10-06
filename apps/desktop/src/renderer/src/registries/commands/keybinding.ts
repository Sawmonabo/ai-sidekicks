// A chord a feature binds to one of its commands. It imports nothing from this folder, so the
// registry and the keybinding table form no import cycle (type-only cycles count in the layering
// check).

/** One chord bound to one command, optionally scoped. */
export interface Keybinding {
  /** tinykeys syntax, single press, `$mod` for Cmd on macOS and Ctrl elsewhere. */
  readonly chord: string;
  readonly commandId: string;
  /** A `when-clause/semantics.ts` expression. Absent means the binding is always live. */
  readonly when?: string;
  /**
   * Fire even while focus is in a text field. Default false: a chord that wrongly fires
   * while typing destroys text, while one that wrongly declines only sends a person to a menu.
   */
  readonly allowInTextInput?: boolean;
}
