// What a family CONTRIBUTES to the palette: an act, and optionally a chord for it.
//
// Two declarations and nothing else — no store, no parser, no matcher. They live
// together and below everything because they are the family's two INPUT types, and
// every module here is either a consumer of them (`CommandRegistry`,
// `KeyBindingTable`) or a decision procedure over them (`command-ranking.ts`,
// `keybinding-conflicts.ts`).
//
// WHY THEY ARE NOT DECLARED BESIDE THEIR CONSUMERS. They were, and it closed two
// cycles: `command-registry.ts` reached down to `command-ranking.ts` for the order
// while `command-ranking.ts` reached back up for what a command IS, and the
// keybinding pair did the same over `KeyBinding`. Both back-edges were `import
// type` and therefore erased at runtime, which is exactly what makes the shape
// worth naming: it is invisible to a bundler and to every reader who assumes
// erasure settles it, and the layering gate counts type edges (`tsPreCompilationDeps`)
// precisely so a cycle cannot hide inside one. Hoisting the shared symbol into a
// module below both is what that gate's own message prescribes, and it is the same
// move `bridge/growth-port/growth-entry.ts` makes for the growth ledger.
//
// This module imports nothing from this family, which is the property that makes
// it a floor rather than one more node in the graph.

/** One act the console offers. */
export interface ConsoleCommand {
  /** Stable, unique, namespaced by owning family — `session.rename`, not `rename`. */
  readonly id: string;
  /** Sentence case, no trailing punctuation, names the act — console copy rules. */
  readonly title: string;
  /** The palette category this row sits under. Also a secondary match field. */
  readonly group: string;
  /** A `when-clause.ts` expression. Absent means unconditional. */
  readonly when?: string;
  /** Extra words a person might type for this command. Matched below the title. */
  readonly keywords?: readonly string[];
  /**
   * Perform the act. May be asynchronous; the registry never awaits it.
   *
   * A `run` MUST SETTLE. `invoke` hands its promise back and the palette drops it,
   * deliberately — the dialog must not stay open waiting on a command that opens
   * another surface — so a `run` that rejects reaches no surface at all and becomes
   * an unhandled rejection. A command that can fail catches its own failure and
   * renders it (`palette/bridge-commands.ts` is the worked example).
   */
  readonly run: () => void | Promise<void>;
  /**
   * Warm whatever `run` is about to open, while a person is still looking at the row.
   *
   * OPTIONAL, AND MOST COMMANDS DECLARE NONE. It exists for the one class of command
   * whose act mounts a loader-backed body: a destination, a pane. The palette calls it
   * when the row becomes the highlighted one — the moment a person's intent is legible
   * and the act has not happened — so the chunk is in flight before Enter rather than
   * after it.
   *
   * IT MUST BE IDEMPOTENT AND MUST NOT NAVIGATE. Highlight moves with every arrow key,
   * so this runs far more often than `run` does and on rows nobody chooses. Both boards'
   * `preload` satisfy that by construction: the loader's promise is memoised, so a
   * second call joins the first, and a body already loaded settles immediately.
   *
   * It returns nothing rather than a promise, on the same rule `run` follows: the
   * palette drops what it cannot wait for, and a speculative warm has nobody waiting.
   */
  readonly preload?: () => void;
}

/** One chord bound to one command, optionally scoped. */
export interface KeyBinding {
  /** tinykeys syntax, single press, `$mod` for Cmd on macOS and Ctrl elsewhere. */
  readonly chord: string;
  readonly commandId: string;
  /** A `when-clause.ts` expression. Absent means the binding is always live. */
  readonly when?: string;
  /**
   * Fire even while focus is in a text field. Default false.
   *
   * Opt-in rather than opt-out because the failure modes are asymmetric: a chord
   * that wrongly fires while someone is typing destroys their text, and a chord
   * that wrongly declines makes them reach for a menu.
   */
  readonly allowInTextInput?: boolean;
}
