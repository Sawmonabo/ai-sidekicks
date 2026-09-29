// Which `/name` the composer may run, and the sentence it says when it may not.
//
// The slash prefix is reserved for CLIENT commands: a registered one is executed by
// the client and never composes into a message, a context, or a provider turn on any
// path. The other half is closed the same way — the provider's own commands are
// DISCOVERY only, and exactly one enumerated entry, the compaction command, is
// sent through its own control and never through a typed line.
//
// So this module answers exactly two things about a name, and both are about the
// CONSOLE's own registry: a registered id is this composer's to run, and anything
// else is not. Whether the command applies where the composer is standing is a third
// question and deliberately not asked here — that is `invoke`'s fail-closed answer a
// moment later, and a recognizer that pre-empted it would report a command that
// exists and does not apply here as a name nobody has heard of.
//
// WHY THERE IS NO PROVIDER-NAME ANSWER HERE. A person who typed a real provider command
// and read "no command by that name" would reasonably conclude the enumeration was
// wrong, so that question is asked elsewhere: `useCommandHandling` answers it off
// the enumeration holder the discovery popover opens, one live read and never a cached
// copy. This module stays about the console's own registry.
//
// THE MATCH IS ON THE COMMAND ID, EXACTLY. Console command ids are the console's
// public vocabulary — `frame.goToSettings`, `bridge.copyBuildDetails` — and a person
// can bind one on the Keyboard page. A second, friendlier alias vocabulary resolved
// here would be a naming scheme only this composer knew, and the first collision
// between an alias and an id would be resolved by whichever branch was written first.
// The discovery popover lists the ids, so the exact string is something a person
// reads rather than guesses.

import { refuse, type Refusal } from "@renderer/lib/refusal.js";

/** The subsystem name every refusal this zone raises carries. */
export const CLIENT_COMMAND_REFUSAL_ORIGIN = "composer-commands";

/**
 * Why the composer would not run a typed command.
 *
 * Closed, and each member is a different remedy: type a different name, go where the
 * command applies, fix what follows the name, or read what the command itself
 * reported.
 *
 * `command-argument-invalid` covers a command that reads arguments off its own
 * line — `/workflow start <name>` is the first — can be named correctly and handed
 * something it cannot act on: no name at all, a name nothing matches, a name several
 * things match. None of those is `command-failed`, which says the command RAN and
 * failed, and saying so would send a person looking for a broken command rather than
 * at the words after it.
 *
 * `command-unavailable-now` covers a command whose OWNER has closed it — the local runtime
 * is not serving, so the write it sends cannot be sent — is not `command-failed`, which
 * says it ran, and not `command-unavailable-here`, which is a claim about SCOPE and
 * would send a person to a different pane to try the same closed act again. It exists
 * here, it applies here, and it cannot be sent right now; the owner supplies the
 * sentence saying why, and this zone carries it rather than composing one.
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
   * Every console command this window has registered, by id, visible or not.
   *
   * The WIDER set on purpose. Recognition answers "is this a name this console
   * knows"; whether the command applies where the composer is, is `invoke`'s
   * fail-closed answer a moment later. Recognizing against the visible set instead
   * would report a command that exists and does not apply here as a name nobody has
   * heard of — two different remedies collapsed into the wrong one.
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
 * Decide what one typed name is, without running anything.
 *
 * A NAME AND NOT A LINE. The router's own predicate is handed the name alone, and
 * this module reads nothing else, so taking the whole line here would have forced
 * that caller to compose one — a fabricated line built only to be taken apart again.
 *
 * This arm is only reached after the router claimed the name, so what happened here
 * is that the command left the registry between the claim and the call.
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
