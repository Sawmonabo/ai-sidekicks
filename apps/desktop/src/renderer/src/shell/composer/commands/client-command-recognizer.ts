// Which `/name` the composer may run, and the sentence it says when it may not.
//
// Spec-017's C-18 reserves the slash prefix for CLIENT commands: a registered one is
// executed by the client and never composes into a message, a context, or a provider
// turn on any path. `Spec-023 §Signature Feature Composition Sketches` §The Session
// Composer then closes the other half — the provider's own commands are a DISCOVERY
// surface, and V1 sends exactly one enumerated entry, the compaction command, through
// its own control and never through a typed line.
//
// So this module answers exactly two things about a name, and both are about the
// CONSOLE's own registry: a registered id is this composer's to run, and anything
// else is not. Whether the command applies where the composer is standing is a third
// question and deliberately not asked here — that is `invoke`'s fail-closed answer a
// moment later, and a recognizer that pre-empted it would report a command that
// exists and does not apply here as a name nobody has heard of.
//
// WHY THERE IS NO PROVIDER-NAME ANSWER. It would be a good one to have: a person who
// typed a real provider command and read "no command by that name" would reasonably
// conclude the enumeration was wrong. But the recognizer's caller on the send path is
// `ComposerSendBar`, and the enumeration is the discovery popover's live read, held
// only while that surface is open — so the send bar has no honest set to check
// against, and giving it one would mean either a second read of the same wire or a
// cached copy of a list the spec keeps un-stored. Until those two zones share one
// holder, the popover is where a person learns that a provider entry is discovery
// only: it lists the entry and offers it no action.
//
// THE MATCH IS ON THE COMMAND ID, EXACTLY. Console command ids are the console's
// public vocabulary — `frame.goToSettings`, `bridge.copyBuildDetails` — and a person
// can bind one on the Keyboard page. A second, friendlier alias vocabulary resolved
// here would be a naming scheme only this surface knew, and the first collision
// between an alias and an id would be resolved by whichever branch was written first.
// The discovery popover lists the ids, so the exact string is something a person
// reads rather than guesses.

import { refuse, type ConsoleRefusal } from "../../../console/core/index.js";

/** The subsystem name every refusal this zone raises carries. */
export const CLIENT_COMMAND_REFUSAL_ORIGIN = "composer-commands";

/**
 * Why the composer would not run a typed command.
 *
 * Closed, and each member is a different remedy: type a different name, go where the
 * command applies, fix what follows the name, or read what the command itself
 * reported.
 *
 * The fourth was a decision and this is it. A command that reads arguments off its own
 * line — `workflow.start` is the first — can be named correctly and handed something
 * it cannot act on: no name at all, a name nothing matches, a name several things
 * match. None of those is `command-failed`, which says the command RAN and failed, and
 * saying so would send a person looking for a broken command rather than at the words
 * after it. A fifth is a decision on the same footing.
 */
export const CLIENT_COMMAND_REFUSAL_CODES = [
  "unknown-command",
  "command-unavailable-here",
  "command-argument-invalid",
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
}

/** The recognizer's answer. Recognised means "this console will run it". */
export type ClientCommandRecognition =
  | { readonly status: "recognized"; readonly commandId: string }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * Decide what one typed name is, without running anything.
 *
 * A NAME AND NOT A LINE. The router's own predicate is handed the name alone, and
 * this module reads nothing else, so taking the whole line here would have forced
 * that caller to compose one — a fabricated line built only to be taken apart again.
 *
 * The refusal names the name and not the literal-slash escape: `send-router.ts`
 * already says the escape to a person who TYPED an unrecognised name, and this arm is
 * only reached after that router claimed the name, so what happened here is that the
 * command left the registry between the claim and the call.
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
