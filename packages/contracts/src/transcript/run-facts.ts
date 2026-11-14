// The facts a run's header and controls read: who acts for it, the account it is billed to, the
// state it last entered and whether a rewind came after that state. One fold over the run's own
// events in log order: the daemon folds the whole log and serves the result with every window that
// names the run, and a client folds what its stream delivers onto what it was served, so a run
// whose naming row lies outside the window still reads whole.
//
// A run's own events are the ones whose payload names it as `runId`. An intervention names the run
// it targets as `targetRunId` and is not the run's own, and neither is a person's message steering
// it: neither names who acts for the run.
import type { ProviderAccountId } from "../generated/provider/account/record.js";
import { RUN_INITIAL_STATE, RUN_TERMINAL_STATES, type RunState } from "../generated/run/state.js";
import { START_OF_LOG_POSITION } from "../generated/session/id.js";
import {
  USER_MESSAGE_EVENT_TYPE,
  type RunStateEventType,
  type TranscriptRunFacts,
} from "../generated/transcript/operations.js";
import { TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE } from "../generated/transcript/row.js";

/**
 * The state each `agent.run.<state>` event type announces, total over the types by `satisfies`,
 * so a type the contracts add fails to compile here.
 */
const RUN_STATE_BY_EVENT_TYPE: Readonly<Record<RunStateEventType, RunState>> = Object.freeze({
  "agent.run.queued": "queued",
  "agent.run.starting": "starting",
  "agent.run.running": "running",
  "agent.run.waitingForApproval": "waitingForApproval",
  "agent.run.waitingForInput": "waitingForInput",
  "agent.run.pausing": "pausing",
  "agent.run.paused": "paused",
  "agent.run.completed": "completed",
  "agent.run.interrupted": "interrupted",
  "agent.run.stopped": "stopped",
  "agent.run.failed": "failed",
} satisfies Record<RunStateEventType, RunState>);

/** The payload member naming the account a run was admitted under, carried by its creation. */
const ADMITTED_PROVIDER_ACCOUNT_MEMBER = "admittedProviderAccountId";

/** The state an `agent.run.<state>` event type announces, or `undefined` for any other type. */
export function runStateOfEventType(eventType: string): RunState | undefined {
  return Object.hasOwn(RUN_STATE_BY_EVENT_TYPE, eventType)
    ? RUN_STATE_BY_EVENT_TYPE[eventType as RunStateEventType]
    : undefined;
}

/** A run's facts while a fold holds them, keyed by the run outside them. */
export type TranscriptRunFactsFold = Omit<TranscriptRunFacts, "runId">;

/** The facts of a run no event has been folded into yet. */
export const UNFOLDED_TRANSCRIPT_RUN_FACTS: TranscriptRunFactsFold = Object.freeze({
  isRewound: false,
  foldedThroughSequence: START_OF_LOG_POSITION,
});

/** One event as the fold reads it: what the daemon's log and a client's stream both carry. */
export interface TranscriptRunBeat {
  readonly type: string;
  readonly sequence: number;
  readonly actor?: string | null | undefined;
  readonly payload?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Whether a beat is a state change whose payload names another state than its type announces, or
 * none. An `agent.run.running` naming `newState: "failed"` arrives well-formed; the fold takes no
 * state from it, and a client takes nothing else from it either.
 */
export function isMisstatedStateChange(beat: Pick<TranscriptRunBeat, "type" | "payload">): boolean {
  const announcedState = runStateOfEventType(beat.type);
  return (
    announcedState !== undefined &&
    announcedState !== RUN_INITIAL_STATE &&
    beat.payload?.["newState"] !== announcedState
  );
}

/**
 * Fold one of the run's own events into its facts. An event at or below `foldedThroughSequence`, or
 * one that changes no fact, answers the same facts object, so a holder keyed on identity sees no
 * change. The first actor wins, and the account is the one the run's creation names. An
 * `agent.run.<state>` event sets the state and ends a rewind, unless its payload misstates the
 * state; an `agent.run.rolledBack` marks the state rewound.
 */
export function foldTranscriptRunFacts(
  facts: TranscriptRunFactsFold,
  beat: TranscriptRunBeat,
): TranscriptRunFactsFold {
  if (beat.sequence <= facts.foldedThroughSequence || beat.type === USER_MESSAGE_EVENT_TYPE) {
    return facts;
  }
  const actor = facts.actor ?? beat.actor ?? undefined;
  const admittedProviderAccountId =
    facts.admittedProviderAccountId ??
    (runStateOfEventType(beat.type) === RUN_INITIAL_STATE
      ? admittedProviderAccountIdOf(beat.payload)
      : undefined);
  let { stateEventType, isRewound } = facts;
  if (beat.type === TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE) {
    isRewound = true;
  } else if (runStateOfEventType(beat.type) !== undefined && !isMisstatedStateChange(beat)) {
    stateEventType = beat.type as RunStateEventType;
    isRewound = false;
  }
  if (
    actor === facts.actor &&
    admittedProviderAccountId === facts.admittedProviderAccountId &&
    stateEventType === facts.stateEventType &&
    isRewound === facts.isRewound
  ) {
    return facts;
  }
  return {
    ...(actor === undefined ? {} : { actor }),
    ...(admittedProviderAccountId === undefined ? {} : { admittedProviderAccountId }),
    ...(stateEventType === undefined ? {} : { stateEventType }),
    isRewound,
    foldedThroughSequence: beat.sequence,
  };
}

/** The state the run's controls read: the state it last entered, a rewind notwithstanding. */
export function transcriptRunStateOf(facts: TranscriptRunFactsFold): RunState | undefined {
  return facts.stateEventType === undefined
    ? undefined
    : RUN_STATE_BY_EVENT_TYPE[facts.stateEventType];
}

/** The state word the run's header shows: its newest state type, none after a rewind. */
export function transcriptRunHeaderStateOf(
  facts: TranscriptRunFactsFold,
): RunStateEventType | undefined {
  return facts.isRewound ? undefined : facts.stateEventType;
}

/** Whether the run has ended: its newest state is a terminal one and no rewind came after it. */
export function isTranscriptRunEnded(facts: TranscriptRunFactsFold): boolean {
  const state = transcriptRunStateOf(facts);
  return (
    !facts.isRewound &&
    state !== undefined &&
    (RUN_TERMINAL_STATES as readonly RunState[]).includes(state)
  );
}

/** The account a run's creation names, if it names one. */
function admittedProviderAccountIdOf(
  payload: Readonly<Record<string, unknown>> | undefined,
): TranscriptRunFacts["admittedProviderAccountId"] {
  // The payload is its event's contract type, held as an open record.
  return payload?.[ADMITTED_PROVIDER_ACCOUNT_MEMBER] as ProviderAccountId | undefined;
}
