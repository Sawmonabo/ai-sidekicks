// Which `/name` the composer may run, and the sentence it says when it may not. A registered id
// is executed by the client and never composes into a message or provider turn; provider
// commands are discovery only, except compaction, which has its own control. Whether a command
// applies here is `invoke`'s answer, not asked here, so an inapplicable command is never
// reported as unknown. The match is on the exact id, with no alias vocabulary.

import { refuse, type Refusal } from "@renderer/lib/refusal.js";

/** The subsystem name every refusal the composer's command zone raises carries. */
export const CLIENT_COMMAND_REFUSAL_ORIGIN = "composer-commands";

/**
 * Why the composer would not run a typed command; each code is a different remedy.
 * `command-argument-invalid` is a correctly named command handed arguments it cannot act on,
 * not `command-failed`, which says it ran. `command-unavailable-now` is a command its owner
 * has closed (for example the local runtime is not serving), not `command-unavailable-here`,
 * which is about scope; the owner supplies the sentence saying why.
 */
export const CLIENT_COMMAND_REFUSAL_CODES = [
  "unknown-command",
  "command-unavailable-here",
  "command-unavailable-now",
  "command-argument-invalid",
  "command-failed",
] as const;

/** One such code. Derived, so the vocabulary is declared exactly once. */
export type ClientCommandRefusalCode = (typeof CLIENT_COMMAND_REFUSAL_CODES)[number];

/** What the recognizer was given to decide against. */
export interface ClientCommandRecognitionInput {
  /**
   * Every console command this window has registered, visible or not. The wider set on
   * purpose: a command that exists but does not apply here must not read as an unknown name.
   */
  readonly registeredCommandIds: readonly string[];
}

/** The recognizer's answer. Recognized means "this console will run it". */
export type ClientCommandRecognition =
  | { readonly status: "recognized"; readonly commandId: string }
  | { readonly status: "refused"; readonly refusal: Refusal };

/** Mint one refusal in this zone's vocabulary. */
export function clientCommandRefusal(code: ClientCommandRefusalCode, detail: string): Refusal {
  return refuse(CLIENT_COMMAND_REFUSAL_ORIGIN, code, detail);
}

/**
 * Decide what one typed name is, without running anything. Takes the name alone because the
 * router's predicate does, so no line has to be fabricated. The refusal arm is reached only
 * when the command left the registry between the router's claim and this call.
 */
export function recognizeClientCommand(
  name: string,
  input: ClientCommandRecognitionInput,
): ClientCommandRecognition {
  if (input.registeredCommandIds.includes(name)) {
    return { status: "recognized", commandId: name };
  }
  return {
    status: "refused",
    refusal: clientCommandRefusal(
      "unknown-command",
      `${name} is not a command this console has registered, so there was nothing to run.`,
    ),
  };
}
