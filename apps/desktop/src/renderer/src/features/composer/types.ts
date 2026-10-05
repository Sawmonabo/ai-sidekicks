// The port between recognizing a console command and running one.
//
// The router intercepts a leading slash whose name a recognizer knows, carrying the name and
// no request. The outcome is a value, not a void, so a controller never clears the line for
// work nothing performed: it clears on `applied` only, `refused` renders beside the input,
// `not-run` leaves the line as typed, and `send-as-typed` sends the line to the provider.

import type { Refusal } from "#renderer/lib/refusal/refusal.js";

/**
 * The line an executor is handed. The name is what a registry is keyed by; the text is what
 * an executor parses its arguments from, trimmed, leading slash included.
 */
export interface ComposerCommandLine {
  /** The command name, without its leading slash. Wire-verbatim as typed. */
  readonly commandName: string;
  /** The whole trimmed line, leading slash included. */
  readonly text: string;
}

/**
 * What running one console command settled as. `not-run` leaves the line as typed and draws
 * nothing. `send-as-typed` is a line the console does not act on: a command that does not run
 * here, or an argument its control cannot take. It goes to the provider exactly as typed, so
 * the provider's own answer shows and the console adds none.
 */
export type CommandOutcome =
  | { readonly status: "applied" }
  | { readonly status: "not-run" }
  | { readonly status: "send-as-typed" }
  | { readonly status: "refused"; readonly refusal: Refusal };

/** Run one recognized console command. Returns a settlement; never throws to report one. */
export type CommandExecutor = (line: ComposerCommandLine) => Promise<CommandOutcome>;
