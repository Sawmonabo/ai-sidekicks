// The port between recognizing a console command and running one.
//
// The router intercepts a leading slash whose name a recognizer knows, carrying the name and
// no request. The outcome is a value, not a void, so a controller never clears the line for
// work nothing performed: it clears on `applied` only, `refused` renders beside the input,
// and `not-run` leaves the line as typed.

import type { Refusal } from "@renderer/lib/refusal.js";

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
 * What running one console command settled as. There is no "not found" arm: whether a name is
 * registered is answered by the recognizer before this seam, and an executor that could
 * disagree would be a second registry. `not-run` leaves the line as typed and draws nothing.
 */
export type CommandOutcome =
  | { readonly status: "applied" }
  | { readonly status: "not-run" }
  | { readonly status: "refused"; readonly refusal: Refusal };

/** Run one recognized console command. Returns a settlement; never throws to report one. */
export type CommandExecutor = (line: ComposerCommandLine) => Promise<CommandOutcome>;
