// What both halves of the derivation's suite build: a wheel, an event, an event
// carrying the run identity an ask correlates on, and the model over a real store.
//
// One module rather than a copy in each, because the two suites derive the SAME model
// from two directions — what one chip says, and what the bar as a whole is — and two
// spellings of "a session with these participants and this log" would let one file pass
// against a derivation the other never builds.
//
// THE MODEL IS BUILT OVER A REAL `SessionStore` rather than over a ledger a case types
// out. What is outstanding is the store's to answer — it holds the register across the
// window replacements and the cap that made a fold over the timeline wrong — so a suite
// that handed `deriveCastBar` a literal would be asserting against a ledger no session
// produces, which is exactly the seam these cases exist to cover.

import type { ConsoleSessionEvent, OutstandingAskLedger } from "../../../store/index.js";
import { SessionStore } from "../../../store/index.js";
import { eventOfKind } from "../../../store/session-event.test-support.js";
import { ParticipantHueAllocator } from "../../../tokens/index.js";
import { deriveCastBar, type CastBarInput, type CastBarModel } from "./cast-bar-model.js";

/** The session every event in this family is built under. */
const MODEL_SESSION_ID = "session-1";

/** The join-log order every chip roster is derived in, as the allocator's own output. */
export function wheelFor(participantIds: readonly string[]): ParticipantHueAllocator {
  const allocator = new ParticipantHueAllocator();
  for (const participantId of participantIds) {
    allocator.admit(participantId);
  }
  return allocator;
}

/** One admitted event with the actor a chip is derived from, over the shared builder. */
export function castEvent(sequence: number, actorId: string, kind: string): ConsoleSessionEvent {
  return { ...eventOfKind(MODEL_SESSION_ID, kind, sequence), actorId };
}

/** The same event, carrying the run identity an ask's lifecycle correlates on. */
export function withRun(base: ConsoleSessionEvent, runId: string): ConsoleSessionEvent {
  return { ...base, payload: { runId } };
}

/** What a case says about the read that established the store the ledger comes from. */
export interface LedgerOverOptions {
  /**
   * The position the read was performed FROM, where it submitted one.
   *
   * Present, the window opened partway through the log and the requests below its head
   * were never delivered — which is the `earlier-unread` standing. Absent, the read
   * opened at the beginning of the log, which is what every other case here assumes.
   */
  readonly readFromCursor?: string;
}

/**
 * The outstanding-ask ledger a real store holds after this log was applied to it.
 *
 * Through `applyBatch` rather than through `initialise`'s own timeline, because that is
 * the door every live row comes in by: a case that seeded the base state instead would
 * be exercising the seed and calling it the fold.
 */
export function ledgerOver(
  timeline: readonly ConsoleSessionEvent[],
  options: LedgerOverOptions = {},
): OutstandingAskLedger {
  const store = new SessionStore({ sessionId: MODEL_SESSION_ID });
  store.initialise({
    cursor: 0,
    entities: [],
    participantJoinLog: [],
    ...(options.readFromCursor === undefined ? {} : { readFromCursor: options.readFromCursor }),
  });
  store.applyBatch(timeline);
  return store.outstandingAskLedger;
}

/**
 * The model, over a ledger a real store built from the same log.
 *
 * The one member every case would otherwise spell identically, composed once. It calls
 * the real derivation and adds no rule of its own — what it removes is the chance of a
 * case passing a ledger that disagrees with the timeline beside it.
 */
export function castBarOver(input: Omit<CastBarInput, "outstandingAsks">): CastBarModel {
  return deriveCastBar({ ...input, outstandingAsks: ledgerOver(input.timeline) });
}
