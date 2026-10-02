// Which `/name` the composer runs, and the refusal it mints when a command it ran failed. A
// recognized id is executed by the client and never composes into a message or provider turn.
// A name it does not recognize, a registered command that does not run here included, is sent
// as typed and answered by the provider. The match is on the exact id, with no alias vocabulary.

import { refuse, type Refusal } from "@renderer/lib/refusal.js";

/** The subsystem name every refusal the composer's command zone raises carries. */
export const CONSOLE_COMMAND_REFUSAL_ORIGIN = "composer-commands";

/** The one refusal the command zone raises: a command it ran did not complete. */
export const CONSOLE_COMMAND_REFUSAL_CODES = ["command-failed"] as const;

/** One such code. Derived, so the vocabulary is declared exactly once. */
export type ConsoleCommandRefusalCode = (typeof CONSOLE_COMMAND_REFUSAL_CODES)[number];

/** What the recognizer was given to decide against. */
export interface ConsoleCommandRecognitionInput {
  /** Every command that would run where this composer is: offered here and not closed. */
  readonly runnableCommandIds: readonly string[];
}

/** Mint one refusal in this zone's vocabulary. */
export function consoleCommandRefusal(code: ConsoleCommandRefusalCode, detail: string): Refusal {
  return refuse(CONSOLE_COMMAND_REFUSAL_ORIGIN, code, detail);
}

/**
 * Whether this console runs one typed name here, without running anything. Takes the name alone
 * because the router's predicate does, so no line has to be fabricated.
 */
export function recognizeConsoleCommand(
  name: string,
  input: ConsoleCommandRecognitionInput,
): boolean {
  return input.runnableCommandIds.includes(name);
}
