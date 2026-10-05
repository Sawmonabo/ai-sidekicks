// What a run event's payload puts on the run entity's body: the member vocabulary, a reader per
// shape, and the walk that composes a body from an untyped payload. `run-lifecycle-projector.ts`
// decides which run a beat mutates; this changes when the wire's members do. It imports nothing
// of the session store or the event envelope.

import type { RunQueuedPayload } from "@ai-sidekicks/contracts/run/queued";
import type { RunRolledBackEvent, RunStateChangeEvent } from "@ai-sidekicks/contracts/run/control";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";

import { isWireRecord } from "@renderer/lib/wire-record.js";
import { readWireNumber, readWireString } from "@renderer/lib/wire-strings.js";
import { RUN_QUEUED_EVENT_KIND } from "./run-state-kinds.js";

/** Every member either registered run shape names. */
type RegisteredRunMemberName = keyof RunStateChangeEvent | keyof RunRolledBackEvent;

/**
 * Every member the durable `run_lifecycle` payload carries: the registered keys minus `runId`
 * (the entity's id), `sessionId` and `timestamp` (envelope), plus `agentId`.
 */
type DurableRunMemberName =
  | Exclude<RegisteredRunMemberName, "runId" | "sessionId" | "timestamp">
  | "agentId";

/** How one member is read out of an untyped payload. */
type WireMemberReaderName = "string" | "number" | "boolean" | "object";

/**
 * Every durable member and the reader that carries it onto the body, total over the derived
 * union by `satisfies`: an unclassified registered member, or one no registered shape names,
 * fails to compile. Values are carried wire-verbatim; a reader checks only the value's shape.
 */
const RUN_BODY_MEMBER_READERS = {
  /** The run aggregate's progression counter. */
  runVersion: "number",
  /** The state the run left, absent on `run.queued` and on the non-state kinds. */
  previousState: "string",
  /** The state the run entered. Absent on the four forward, non-state kinds. */
  newState: "string",
  /** The agent the run was created for, carried by `run.queued`. */
  agentId: "string",
  /** The turn-boundary anchor a rollback landed at, off `run.rolled_back`. */
  targetPosition: "number",
  failureCategory: "string",
  /** Why a provider refused the run, carried whole on a failed run's beat. */
  failureCause: "object",
  recoveryCondition: "string",
  providerFailureDetail: "string",
  /** How a provider process that ended on its own exited, carried whole on a failed run's beat. */
  processExit: "object",
  completionKind: "string",
  intendedClose: "boolean",
  /** Stamped on `run.running`, where the resolved root and posture are final. */
  executionPosture: "object",
  /** The stop reason that ended the run, such as a step or spend limit. */
  trigger: "string",
} as const satisfies Readonly<Record<DurableRunMemberName, WireMemberReaderName>>;

/**
 * The members `run.queued` declares beyond the two stream shapes. `resolvedAgent` is the
 * agent's record, not the run's; only its id reaches the body, as `agentId`.
 */
type RunQueuedOwnMemberName = Exclude<
  keyof RunQueuedPayload,
  RegisteredRunMemberName | "sessionId" | "agentId" | "resolvedAgent"
>;

/**
 * The registered kinds whose durable payload names members of its own. `Extract`ed from the
 * event types, so a misspelled kind fails to compile.
 */
type RunKindWithPerTypeMembers = Extract<
  SessionEventType,
  "run.queued" | "run.provider_initialized" | "run.turn_started" | "run.worker_shutdown"
>;

/**
 * The per-type members those four kinds register, and the reader for each.
 *
 * Per type rather than merged into the table above: each row has its own payload shape, so a
 * flat table would read `provider` or `position` off any run beat that spelled it. A member
 * either `run.subscribeState` shape declares belongs in the derived table, and the co-located
 * test refuses a second spelling here.
 */
const PER_TYPE_RUN_BODY_MEMBER_READERS: Readonly<
  Record<RunKindWithPerTypeMembers, Readonly<Record<string, WireMemberReaderName>>>
> = Object.freeze({
  // Keyed by the contract's own payload, so a member it gains or loses fails to compile.
  "run.queued": Object.freeze({
    parentRunId: "string",
    admittedModelFamily: "string",
    reachedBy: "string",
    effectiveRunConfig: "object",
    admittedProviderAccountId: "string",
  } satisfies Record<RunQueuedOwnMemberName, WireMemberReaderName>),
  // The provider's initialization report, which names the provider and model the run uses.
  "run.provider_initialized": Object.freeze({ provider: "string", model: "string" }),
  // The normalized session position, absent where the provider wire supplies none.
  "run.turn_started": Object.freeze({ position: "number" }),
  // The sanitized shutdown reason a mid-run worker signal carries.
  "run.worker_shutdown": Object.freeze({ reason: "string" }),
});

/** The reader table for a kind that registers no members of its own. */
const NO_PER_TYPE_MEMBERS: Readonly<Record<string, WireMemberReaderName>> = Object.freeze({});

/**
 * One reader per shape, and the only place a payload member is type-checked. A wrong-typed
 * member reads as absent, and an absent member stays off the body, because the store's spread
 * merge would let a present `undefined` erase what an earlier event established.
 */
const WIRE_MEMBER_READERS: Readonly<Record<WireMemberReaderName, (value: unknown) => unknown>> = {
  // The string and number arms are the shared `wire-strings` predicates.
  string: readWireString,
  number: readWireNumber,
  boolean: (value) => (typeof value === "boolean" ? value : undefined),
  // Carried whole and unparsed: the console renders `executionPosture` through its own consumer,
  // and the contract owns its shape. `isWireRecord` decides whether it is a body.
  object: (value) => (isWireRecord(value) ? value : undefined),
};

/**
 * The body members this payload names, or `undefined` when it names none.
 *
 * Walks the two reader tables rather than reading members by name, so a member neither table
 * names never reaches the body. The derived table holds what every run row may carry; the
 * per-type one holds what this kind alone registers.
 */
export function readRunEntityBody(
  eventKind: string,
  payload: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const body: Record<string, unknown> = {};
  for (const readers of [RUN_BODY_MEMBER_READERS, perTypeMemberReadersFor(eventKind)]) {
    for (const [member, readerName] of Object.entries(readers)) {
      const value = WIRE_MEMBER_READERS[readerName](payload?.[member]);
      if (value !== undefined) {
        body[member] = value;
      }
    }
  }
  const resolvedAgentId =
    eventKind === RUN_QUEUED_EVENT_KIND ? readResolvedAgentId(payload) : undefined;
  if (resolvedAgentId !== undefined) {
    body["agentId"] = resolvedAgentId;
  }
  return Object.keys(body).length === 0 ? undefined : body;
}

/**
 * The agent id of a run's creation row. The row names it as `agentId` when the agent is already
 * in the session and inside `resolvedAgent` when the run brings it in, never both.
 */
function readResolvedAgentId(
  payload: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const resolvedAgent = payload?.["resolvedAgent"];
  return isWireRecord(resolvedAgent) ? readWireString(resolvedAgent["agentId"]) : undefined;
}

/**
 * The per-type readers this kind registers, or none. `Object.hasOwn` because the kind arrives
 * wire-verbatim: an indexed read would answer `"constructor"` from `Object.prototype`.
 */
function perTypeMemberReadersFor(
  eventKind: string,
): Readonly<Record<string, WireMemberReaderName>> {
  return Object.hasOwn(PER_TYPE_RUN_BODY_MEMBER_READERS, eventKind)
    ? PER_TYPE_RUN_BODY_MEMBER_READERS[eventKind as RunKindWithPerTypeMembers]
    : NO_PER_TYPE_MEMBERS;
}
