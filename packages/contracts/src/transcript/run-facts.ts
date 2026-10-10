// The facts a run's header and controls read: who acts for it, the account it is billed to, the
// state it last entered and whether a rewind came after that state. One fold over the run's own
// events in log order: the daemon folds the whole log and serves the result with every window that
// names the run, and a client folds what its stream delivers onto what it was served, so a run
// whose naming row lies outside the window still reads whole.
//
// A run's own events are the ones whose payload names it as `runId`. An intervention names the run
// it targets as `targetRunId` and is not the run's own, and neither is a person's message steering
// it: neither names who acts for the run.

import { z } from "zod";

import type { SessionEventType } from "../event/registry.js";
import { EVENT_FIELD_MAX_LEN } from "../event/version.js";
import { wireFreeFormString } from "../free-form-string.js";
import { ProviderAccountIdSchema, type ProviderAccountId } from "../provider/account/record.js";
import { RunIdSchema, type RunId } from "../run/id.js";
import { RUN_INITIAL_STATE, isTerminalState, type RunState } from "../run/state.js";
import { START_OF_LOG_POSITION } from "../session/event-cursor.js";

import { TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE } from "./row.js";

/** An event type that moves a run into a state: `run.<state>`, one per state. */
export type RunStateEventType = Extract<SessionEventType, `run.${RunState}`>;

/**
 * The state each `run.<state>` event type announces, total over the states by `satisfies`, so a
 * newly registered state or a type the registry does not hold fails to compile.
 */
const RUN_STATE_BY_EVENT_TYPE: Readonly<Record<RunStateEventType, RunState>> = Object.freeze({
  "run.queued": "queued",
  "run.starting": "starting",
  "run.running": "running",
  "run.waiting_for_approval": "waiting_for_approval",
  "run.waiting_for_input": "waiting_for_input",
  "run.pausing": "pausing",
  "run.paused": "paused",
  "run.completed": "completed",
  "run.interrupted": "interrupted",
  "run.stopped": "stopped",
  "run.failed": "failed",
} satisfies Record<RunStateEventType, RunState>);

/** Every `run.<state>` event type, in the order the contract declares the states. */
export const RUN_STATE_EVENT_TYPES: readonly RunStateEventType[] = Object.freeze(
  Object.keys(RUN_STATE_BY_EVENT_TYPE) as RunStateEventType[],
);

/** The type of a person's message, which is never a run's own event even when it steers one. */
const USER_MESSAGE_EVENT_TYPE: Extract<SessionEventType, "user.message"> = "user.message";

/** The payload member naming the account a run was admitted under, carried by its creation. */
const ADMITTED_PROVIDER_ACCOUNT_MEMBER = "admittedProviderAccountId";

/** The type of the event that creates a run, the one beat naming the account it is billed to. */
const RUN_CREATION_EVENT_TYPE: RunStateEventType = `run.${RUN_INITIAL_STATE}`;

/** The state a `run.<state>` event type announces, or `undefined` for any other type. */
export function runStateOfEventType(eventType: string): RunState | undefined {
  return Object.hasOwn(RUN_STATE_BY_EVENT_TYPE, eventType)
    ? RUN_STATE_BY_EVENT_TYPE[eventType as RunStateEventType]
    : undefined;
}

/**
 * One run's facts as a `transcript.read` window serves them, folded over the log through
 * `foldedThroughSequence`. The header's state word is `stateEventType` unless a rewind came after
 * it; the run has ended when that state is a terminal one and no rewind came after it.
 */
export interface TranscriptRunFacts {
  runId: RunId;
  /** Who the run's first event naming anyone names, wire-verbatim. */
  actor?: string | undefined;
  /** The account the run was admitted under, as its creation named it. */
  admittedProviderAccountId?: ProviderAccountId | undefined;
  /** The newest `run.<state>` type the run entered, kept across a rewind. */
  stateEventType?: RunStateEventType | undefined;
  /** Whether a `run.rolled_back` came after `stateEventType`. */
  isRewound: boolean;
  /** The sequence the facts hold through: an event at or below it is already in them. */
  foldedThroughSequence: number;
}

/** Parses a {@link TranscriptRunFacts}. */
export const TranscriptRunFactsSchema: z.ZodType<TranscriptRunFacts> = z
  .object({
    runId: RunIdSchema,
    actor: wireFreeFormString(EVENT_FIELD_MAX_LEN, "TranscriptRunFacts.actor").optional(),
    admittedProviderAccountId: ProviderAccountIdSchema.optional(),
    stateEventType: z.enum(RUN_STATE_EVENT_TYPES as [RunStateEventType]).optional(),
    isRewound: z.boolean(),
    foldedThroughSequence: z.number().int().min(START_OF_LOG_POSITION),
  })
  .strict();

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
 * none. The payload schemas are tolerant, so a `run.running` naming `newState: "failed"` arrives
 * well-formed; the fold takes no state from it, and a client takes nothing else from it either.
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
 * change. The first actor wins, and the account is the one the run's creation names. A
 * `run.<state>` event sets the state and ends a rewind, unless it is a state change whose payload
 * does not name the state its type announces; a `run.rolled_back` marks the state rewound.
 */
export function foldTranscriptRunFacts(
  facts: TranscriptRunFactsFold,
  beat: TranscriptRunBeat,
): TranscriptRunFactsFold {
  if (beat.sequence <= facts.foldedThroughSequence || beat.type === USER_MESSAGE_EVENT_TYPE) {
    return facts;
  }
  // An empty actor names no one.
  const actor = facts.actor ?? (beat.actor === null || beat.actor === "" ? undefined : beat.actor);
  const admittedProviderAccountId =
    facts.admittedProviderAccountId ??
    (beat.type === RUN_CREATION_EVENT_TYPE ? admittedProviderAccountIdOf(beat.payload) : undefined);
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
  return !facts.isRewound && state !== undefined && isTerminalState(state);
}

function admittedProviderAccountIdOf(
  payload: Readonly<Record<string, unknown>> | undefined,
): ProviderAccountId | undefined {
  const value = payload?.[ADMITTED_PROVIDER_ACCOUNT_MEMBER];
  if (value === undefined) {
    return undefined;
  }
  const parsed = ProviderAccountIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
