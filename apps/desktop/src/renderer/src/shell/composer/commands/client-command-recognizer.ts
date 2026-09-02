// Which `/name` the composer may run, and the sentence it says when it may not.
//
// Spec-017's C-18 reserves the slash prefix for CLIENT commands: a registered one is
// executed by the client and never composes into a message, a context, or a provider
// turn on any path. `Spec-023 §Signature Feature Composition Sketches` §The Session
// Composer then closes the other half — the provider's own commands are a DISCOVERY
// surface, and V1 sends exactly one enumerated entry, the compaction command, through
// its own control and never through a typed line.
//
// So there are exactly three answers to "what is this line", and the recognizer is
// where they are decided:
//
//   1. A registered CONSOLE command — the only kind this composer may execute.
//   2. A name the bound provider published — refused, naming the rule rather than
//      pretending the name is unknown. A person who typed a real provider command
//      and got "no command by that name" would reasonably conclude the enumeration
//      was wrong; they typed a real name and this console will not send it.
//   3. Anything else — refused as unknown, with the literal-slash escape named.
//
// THE MATCH IS ON THE COMMAND ID, EXACTLY. Console command ids are the console's
// public vocabulary — `frame.goToSettings`, `bridge.copyBuildDetails` — and a person
// can bind one on the Keyboard page. A second, friendlier alias vocabulary resolved
// here would be a naming scheme only this surface knew, and the first collision
// between an alias and an id would be resolved by whichever branch was written first.
// The discovery popover lists the ids, so the exact string is something a person
// reads rather than guesses.

import { refuse, type ConsoleRefusal } from "../../../console/core/index.js";

/**
 * One intercepted line, split at the name.
 *
 * Declared here for now and matched to the send controller's own seam: that
 * controller hands its executor the line it recognised, and the fold unifies the two
 * declarations onto the router's export. Nothing here reads more than the name — the
 * argument text travels so a command that grows one has it, and no V1 command does.
 */
export interface DirectiveLine {
  /** The word after the leading slash, without it. Never empty. */
  readonly commandName: string;
  /** Everything after the name, trimmed. Empty when the line carried none. */
  readonly argumentText: string;
}

/**
 * What running one line settled as. Closed at two.
 *
 * `applied` carries nothing: the act happened, and what it did is the command's own
 * business — a member naming it here would be a second record of a thing the
 * registry's recents already hold. `refused` carries the refusal the send bar
 * renders beside the control that produced it, so a person is never told a command
 * ran when it did not.
 */
export type CommandOutcome =
  | { readonly status: "applied" }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/** The subsystem name every refusal this zone raises carries. */
export const CLIENT_COMMAND_REFUSAL_ORIGIN = "composer-commands";

/**
 * Why the composer would not run a typed command.
 *
 * Closed, and each member is a different remedy: type a different name, use the
 * provider's own surface, go where the command applies, or read what the command
 * itself reported. A fifth is a decision.
 */
export const CLIENT_COMMAND_REFUSAL_CODES = [
  "unknown-command",
  "provider-command-not-executable",
  "command-unavailable-here",
  "command-failed",
] as const;

/** One such code. Derived, so the vocabulary is declared exactly once. */
export type ClientCommandRefusalCode = (typeof CLIENT_COMMAND_REFUSAL_CODES)[number];

/** Mint one refusal in this zone's vocabulary. */
export function clientCommandRefusal(
  code: ClientCommandRefusalCode,
  detail: string,
): ConsoleRefusal {
  return refuse(CLIENT_COMMAND_REFUSAL_ORIGIN, code, detail);
}

/** What the recognizer was given to decide against. */
export interface ClientCommandRecognitionInput {
  /**
   * Every console command this window has registered, by id, visible or not.
   *
   * The WIDER set on purpose. Recognition answers "is this a name this console
   * knows"; whether the command applies where the composer is, is `invoke`'s
   * fail-closed answer a moment later. Recognising against the visible set instead
   * would report a command that exists and does not apply here as a name nobody has
   * heard of — two different remedies collapsed into the wrong one.
   */
  readonly registeredCommandIds: readonly string[];
  /**
   * Every command and skill name the bound provider published, as enumerated.
   *
   * Wire-verbatim and never composed: it is what separates "you typed a provider
   * command" from "you typed nothing anybody has heard of", and an empty set is the
   * honest answer where no enumeration has been read.
   */
  readonly providerCommandNames: readonly string[];
}

/** The recognizer's answer. Recognised means "this console will run it". */
export type ClientCommandRecognition =
  | { readonly status: "recognized"; readonly commandId: string }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/** The escape a person types to send a message that really begins with a slash. */
const LITERAL_SLASH_ESCAPE = "//";

/** Decide what one intercepted line is, without running anything. */
export function recognizeClientCommand(
  line: DirectiveLine,
  input: ClientCommandRecognitionInput,
): ClientCommandRecognition {
  const name = line.commandName;
  if (input.registeredCommandIds.includes(name)) {
    return { status: "recognized", commandId: name };
  }
  if (input.providerCommandNames.includes(name)) {
    return {
      status: "refused",
      refusal: clientCommandRefusal(
        "provider-command-not-executable",
        `${name} is one of the bound provider's own commands. This console lists what the provider offers so you can see it; it does not send provider commands from the message line.`,
      ),
    };
  }
  return {
    status: "refused",
    refusal: clientCommandRefusal(
      "unknown-command",
      `No command by that name is registered. Type ${LITERAL_SLASH_ESCAPE} to send a message that really starts with a slash.`,
    ),
  };
}
