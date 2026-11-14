// Which `/name` the composer runs, and the origin a failure of a command it ran carries. A
// recognized id is executed by the client and never composes into a message or provider turn.
// A name it does not recognize, a registered command that does not run here included, is sent
// as typed and answered by the provider. The match is on the exact id, with no alias vocabulary.

/** The subsystem name a failure of a command the composer's command zone ran carries. */
export const CONSOLE_COMMAND_REFUSAL_ORIGIN = "composer-commands";

/** What the recognizer was given to decide against. */
export interface ConsoleCommandRecognitionInput {
  /** Every command that would run where this composer is: offered here and not closed. */
  readonly runnableCommandIds: readonly string[];
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
