// The wire vocabulary a run group is folded against: which run-lifecycle types end a run, which
// say it is not ended, which report a state, and where the paying account is named. Each set is a
// tuple with its predicate derived from it, so the two cannot drift; a type added to the
// registered event types is an edit here and nowhere else.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { readWireString } from "@renderer/lib/wire-strings.js";

/**
 * The run-lifecycle event types that end a run, wire-verbatim.
 *
 * `run.rolled_back` is absent because a rewind is not a terminal: the run continues from the
 * boundary. It is in {@link RUN_REOPENING_EVENT_TYPES}, where it clears a terminal.
 */
export const RUN_TERMINAL_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.interrupted",
  "run.stopped",
] as const;

/** One terminal event type. Derived from the tuple, never restated. */
export type RunTerminalEventType = (typeof RUN_TERMINAL_EVENT_TYPES)[number];

/**
 * The run-lifecycle event types that say a run is not ended, wire-verbatim.
 *
 * A terminal is not final: a rollback accepted from a finished run appends a pause and a rewind
 * before it resumes, so a run group that only acquired terminals would keep a completion the
 * daemon had undone. These are the non-terminal states (`run.pausing` included, since a run
 * finishing its step has not ended) plus the rollback. Rows that report no state
 * (`run.worker_shutdown`, `run.turn_started` and the rest) are absent: a worker shutting down
 * after a completion says nothing about the run and would unfold every finished run group.
 */
export const RUN_REOPENING_EVENT_TYPES = [
  "run.queued",
  "run.starting",
  "run.running",
  "run.waiting_for_approval",
  "run.waiting_for_input",
  "run.pausing",
  "run.paused",
  "run.rolled_back",
] as const;

/** One reopening event type. Derived from the tuple, never restated. */
export type RunReopeningEventType = (typeof RUN_REOPENING_EVENT_TYPES)[number];

/**
 * The event type whose payload names the account a run is billed to, wire-verbatim.
 *
 * Read off the open projected payload without parsing; an absent or wrongly typed member is an
 * absence. It is carried by the run's admission, where the account is settled for the run.
 */
const RUN_GROUP_PAYING_ACCOUNT_MEMBER = "admittedProviderAccountId";

/**
 * The run-lifecycle types that report a state, derived: the terminals plus the reopening types
 * minus `run.rolled_back`, which says the run came back but not what state it came back into.
 * The fold clears the state on a rollback instead of reporting the rollback as one.
 */
export const RUN_STATE_EVENT_TYPES: readonly string[] = [
  ...RUN_TERMINAL_EVENT_TYPES,
  ...RUN_REOPENING_EVENT_TYPES.filter((wireType) => wireType !== "run.rolled_back"),
];

/** Whether this type ends a run. */
export function isTerminalEventType(wireType: string): wireType is RunTerminalEventType {
  return RUN_TERMINAL_EVENT_TYPES.some((terminal) => terminal === wireType);
}

/** Whether this type says a run is not ended. */
export function isReopeningEventType(wireType: string): wireType is RunReopeningEventType {
  return RUN_REOPENING_EVENT_TYPES.some((reopening) => reopening === wireType);
}

/** Whether this type reports a run state. Asked of the derived set, never re-listed. */
export function isRunStateEventType(wireType: string): boolean {
  return RUN_STATE_EVENT_TYPES.includes(wireType);
}

/**
 * The account a row names as the run's payer, or `undefined`.
 *
 * Narrowed on `kind` first, since the `rollback_boundary` arm carries a typed payload rather
 * than an open record.
 */
export function payingAccountIdOf(row: TranscriptEventRow): string | undefined {
  return row.kind === "run"
    ? readWireString(row.payload[RUN_GROUP_PAYING_ACCOUNT_MEMBER])
    : undefined;
}
