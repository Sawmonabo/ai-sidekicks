// Who holds this session's one shared-terminal write lease.
//
// A WIRE FIELD, WHICH IS THE WHOLE RULE. `Spec-023 §Console Design (Meridian)` 8.8
// forbids deriving the holder from the last observed claim: a lease is taken,
// released, and auto-released for three different reasons, and a surface that folded
// whichever transition it happened to have seen would state a holder nobody sent it.
// So the holder is read, and the read is the registered `controlHolder` member.
//
// AND `null` IS AN ANSWER. The registered member resolves to null both when the lease
// is free and when the holding node reads offline, and the surface draws that state
// distinctly from "not read yet" — a lease nobody holds is a fact about the session,
// and a console that rendered it as an absence would leave a person unable to tell
// whether they may claim the shell.
//
// WHY THE ROSTER READS IT AT ALL. 8.8 puts the holder "wherever presence renders, so
// the holder is visible from the roster without opening the pane". The terminal pane
// is a different view family and its own surface; nothing here reaches into it, and
// nothing here offers a claim — the two lease verbs are the pane's, and a second
// place to press them would be a second place to be refused.

import type { ConsoleBridge, GrowthOutcome, GrowthReading } from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { useGrowthReadOnMount } from "../../seats/index.js";

/** Names this read in a refusal the call itself did not name. */
export const TERMINAL_CONTROL_HOLDER_ORIGIN = "terminal-control-holder";

/** What one `terminalControlHolderRead` call answers. */
export type TerminalControlHolderOutcome = GrowthOutcome<{ readonly controlHolder: string | null }>;

/** What the roster holds for one holder call. */
export type TerminalControlHolderReading = GrowthReading<TerminalControlHolderOutcome>;

/**
 * Read the session's lease holder once, and hold it against that session.
 *
 * One read for the whole roster rather than one per row: the lease is session-scoped,
 * so a per-row read would ask the same question once per person and answer every one
 * of them the same way.
 */
export function useTerminalControlHolder(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
): TerminalControlHolderReading | undefined {
  return useGrowthReadOnMount({
    bridge,
    subject: sessionId,
    request: sessionId === undefined ? undefined : { sessionId },
    origin: TERMINAL_CONTROL_HOLDER_ORIGIN,
    ask: (readBridge, request) => readBridge.growth.terminalControlHolderRead(request),
  });
}

/**
 * What the read said about the lease.
 *
 * Three values and not two, because the states are three: a participant holds it, the
 * read said nobody holds it, or nothing has been read. `unheld` is what makes the
 * middle one renderable at all — `null` and `undefined` would otherwise both arrive
 * at a row as "no holder" and the row could not tell a free lease from an unasked
 * question.
 */
export type TerminalControlHolding =
  | { readonly kind: "held"; readonly participantId: string }
  | { readonly kind: "unheld" }
  | { readonly kind: "unread" };

/**
 * The holding, read off one answer.
 *
 * A refused read and a call that produced no outcome are both `unread`: neither says
 * anything about who holds the lease, and rendering either as an unheld lease would
 * be the console asserting a session state on the strength of its own failure.
 */
export function terminalControlHolding(
  reading: TerminalControlHolderReading | undefined,
): TerminalControlHolding {
  if (reading?.kind !== "answered" || reading.outcome.status !== "served") {
    return { kind: "unread" };
  }
  const { controlHolder } = reading.outcome.value;
  return controlHolder === null
    ? { kind: "unheld" }
    : { kind: "held", participantId: controlHolder };
}

/** Why the holder is not here, or `undefined` where it is or is still coming. */
export function terminalControlHolderRefusal(
  reading: TerminalControlHolderReading | undefined,
): ConsoleRefusal | undefined {
  if (reading === undefined) {
    return undefined;
  }
  if (reading.kind === "unreadable") {
    return reading.refusal;
  }
  return reading.outcome.status === "served" ? undefined : reading.outcome;
}
