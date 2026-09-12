// The wire vocabulary a chapter is folded against: which run-lifecycle types end a
// run, which say it is not ended, which report a state at all, and where a run's
// paying account is named.
//
// ITS OWN MODULE BESIDE THE FOLD, because the two answer different questions and grow
// on different clocks. `chapters.ts` decides how a window partitions into chapters and
// what one carries; this decides what the DAEMON'S OWN WORDS mean, and every entry
// here is a claim about the registered event census rather than about this console.
// A type added to the census is an edit here and nowhere else.
//
// EVERY SET IS DECLARED AS A TUPLE AND EVERY PREDICATE IS DERIVED FROM ONE, so a
// claim about the SET is countable at runtime and a membership test cannot drift from
// the enumeration it is supposed to be about.

import type { TimelineRow } from "@ai-sidekicks/contracts";

import { readWireString } from "../../../core/index.js";

/**
 * The run-lifecycle event types that END a run, wire-verbatim.
 *
 * Declared once as a tuple with the membership test derived from it. All three
 * are registered in the `@ai-sidekicks/contracts` event census; `run.rolled_back`
 * is deliberately absent, because a rewind is not a terminal — the run continues
 * from the boundary, which is exactly why the rollback has its own non-state event.
 * It appears in {@link CHAPTER_REOPENING_EVENT_TYPES} instead,
 * where it CLEARS a terminal the run has come back from.
 */
export const CHAPTER_TERMINAL_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.interrupted",
] as const;

/** One terminal event type. Derived from the tuple, never restated. */
export type ChapterTerminalEventType = (typeof CHAPTER_TERMINAL_EVENT_TYPES)[number];

/**
 * The run-lifecycle event types that say a run is NOT ended, wire-verbatim.
 *
 * A terminal is not a one-way door. A rollback accepted from a finished run appends
 * a pause and a rewind for that same run before it can resume, so a chapter that
 * only ever ACQUIRED a terminal kept a completion the daemon had already undone: it
 * stayed folded by rule 7's default, its header went on reading the old ending, and
 * every row appended after the rewind sat behind a receipt for something that did
 * not happen.
 *
 * WHY THESE SEVEN AND NOT EVERY RUN ROW. `@ai-sidekicks/contracts` registers
 * thirteen `run_lifecycle` types: the nine run-state-machine states, the forward
 * non-terminal rollback event, and three rows that report no state at all
 * (`run.provider_initialized`, `run.turn_started`, `run.worker_shutdown`). These are
 * the six non-terminal STATES plus the rollback — every row that says the run is in
 * a state other than ended. The three non-state rows are deliberately absent: a
 * worker shutting down after a completion says nothing about the run, and reading it
 * as a reopening would unfold every finished chapter in the session.
 */
export const CHAPTER_REOPENING_EVENT_TYPES = [
  "run.queued",
  "run.starting",
  "run.running",
  "run.waiting_for_approval",
  "run.waiting_for_input",
  "run.paused",
  "run.rolled_back",
] as const;

/** One reopening event type. Derived from the tuple, never restated. */
export type ChapterReopeningEventType = (typeof CHAPTER_REOPENING_EVENT_TYPES)[number];

/**
 * The event type whose payload names the account a run is billed to, wire-verbatim.
 *
 * Read off the open projected payload rather than parsed: a timeline row carries its
 * originating event's payload through unre-validated, so asking for one member is the
 * honest read and an absent or wrongly-typed one is an absence. The row that carries
 * it is the run's admission, which is where the account is settled for the run's
 * lifetime — a later row naming a different one would be a run that changed who pays
 * mid-flight, which the account plane does not permit.
 */
const CHAPTER_PAYING_ACCOUNT_MEMBER = "admittedProviderAccountId";

/**
 * The run-lifecycle types that report a STATE, wire-verbatim and derived rather than
 * restated: the three that end a run, and the reopening types minus the one that is
 * not a state at all.
 *
 * `run.rolled_back` is the exclusion and it is the whole reason this is a derivation
 * and not a third list. A rewind says the run came back; it does not say what state it
 * came back INTO. Reading it as one would leave a chapter reporting `run.rolled_back`
 * as the run's state until the next transition, and treating it as a state that
 * PERSISTS would be worse — so it clears the state instead, and the header says
 * nothing until the daemon says something.
 */
export const CHAPTER_RUN_STATE_EVENT_TYPES: readonly string[] = [
  ...CHAPTER_TERMINAL_EVENT_TYPES,
  ...CHAPTER_REOPENING_EVENT_TYPES.filter((wireType) => wireType !== "run.rolled_back"),
];

export function isTerminalEventType(wireType: string): wireType is ChapterTerminalEventType {
  return CHAPTER_TERMINAL_EVENT_TYPES.some((terminal) => terminal === wireType);
}

export function isReopeningEventType(wireType: string): wireType is ChapterReopeningEventType {
  return CHAPTER_REOPENING_EVENT_TYPES.some((reopening) => reopening === wireType);
}

/** Whether this type reports a run state. Asked of the derived set, never re-listed. */
export function isRunStateEventType(wireType: string): boolean {
  return CHAPTER_RUN_STATE_EVENT_TYPES.includes(wireType);
}

/**
 * The account a row names as the run's payer, or `undefined`.
 *
 * Narrowed on `kind` before the payload is indexed, because the `rollback_boundary`
 * arm carries a TYPED payload rather than an open record — so reading it as a bag
 * would be the cast this console does not take.
 */
export function payingAccountIdOf(row: TimelineRow): string | undefined {
  return row.kind === "run"
    ? readWireString(row.payload[CHAPTER_PAYING_ACCOUNT_MEMBER])
    : undefined;
}
