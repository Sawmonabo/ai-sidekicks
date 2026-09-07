// The seam between recognising a client command and running one.
//
// The router INTERCEPTS: a leading slash whose name a recogniser knows resolves to
// `client-command`, carrying the name and no request, because Spec-017's C-18
// reserves the prefix and such a line never composes into a message on any path.
// Interception is where the send path ends — and it is not where the act happens.
//
// SO THE OUTCOME IS A VALUE AND NOT A VOID. A controller that cleared the line on
// interception alone would report success for work nothing performed: the person's
// text is gone, no command ran, and no refusal says so. The executor answers with
// one of two arms, the line is cleared on `applied` only, and `refused` renders the
// refusal beside the input like every other refusal the composer meets.
//
// ONE MODULE FOR BOTH SIDES OF THE SEAM, per this package's structure rules — the
// controller that awaits an outcome and the command family that produces one name
// the same shapes rather than two copies that drift.

import type { ConsoleRefusal } from "../../../console/core/index.js";

/**
 * The line an executor is handed.
 *
 * Both halves, because they answer different questions: the name is what a registry
 * is keyed by, and the text is what an executor parses its own arguments out of.
 * The text is the trimmed line as typed, leading slash included — the router
 * strips nothing on this arm, so an executor reads exactly what the person wrote.
 */
export interface DirectiveLine {
  /** The command name, without its leading slash. Wire-verbatim as typed. */
  readonly commandName: string;
  /** The whole trimmed line, leading slash included. */
  readonly text: string;
}

/**
 * What running one client command settled as. Closed at two.
 *
 * There is deliberately no third "not found" arm: whether a name is registered is
 * the recogniser's question and is answered before this seam is reached, and an
 * executor that could disagree with the recogniser would be a second registry.
 */
export type CommandOutcome =
  | { readonly status: "applied" }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/** Run one recognised client command. Returns a settlement; never throws to report one. */
export type CommandExecutor = (line: DirectiveLine) => Promise<CommandOutcome>;
