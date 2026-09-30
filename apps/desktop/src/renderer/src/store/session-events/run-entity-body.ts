// What a run event's payload puts on the run entity's body.
//
// `run-lifecycle-projector.ts` beside it answers WHICH run a beat mutates and whether
// the beat may be folded at all. This answers what the fold then carries: the member
// vocabulary, the reader per shape, and the walk that composes a body out of an
// untyped payload. The two were one file until the seam between them was drawn: one
// changes when the FOLD's rules change and this one changes when the wire's members do.
//
// Nothing here reads the store or the event envelope — a member name, a payload, and
// a reader are the whole subject — which is why the split is clean in one direction:
// the projector imports the body walk and this module imports nothing of the fold.

import type {
  RunQueuedPayload,
  RunRolledBackEvent,
  RunStateChangeEvent,
  SessionEventType,
} from "@ai-sidekicks/contracts";

import { isWireRecord } from "@renderer/lib/wire-record.js";
import { readWireString } from "@renderer/lib/wire-strings.js";

/** Every member either registered run shape names. */
type RegisteredRunMemberName = keyof RunStateChangeEvent | keyof RunRolledBackEvent;

/**
 * Every member the DURABLE `run_lifecycle` payload carries.
 *
 * The registered key union minus the three the durable row does not carry under
 * those names, plus the one it carries alone. Each exclusion is named rather than
 * dropped silently, so a reader can check the subtraction: `runId` is the run
 * entity's own id, and `sessionId` and `timestamp` ride the envelope.
 */
type DurableRunMemberName =
  | Exclude<RegisteredRunMemberName, "runId" | "sessionId" | "timestamp">
  | "agentId";

/** How one member is read out of an untyped payload. */
type WireMemberReaderName = "string" | "number" | "boolean" | "object";

/**
 * Every durable member and the reader that carries it onto the body, TOTAL over
 * the derived union.
 *
 * The `satisfies` is the gate: a member added to `RunStateChangeEvent` or
 * `RunRolledBackEvent` fails to compile here until it is classified, and a member
 * this table invents — one no registered shape names — fails too. Values are
 * carried wire-verbatim; the reader decides only whether the payload supplied a
 * value of the right shape, never what the value means.
 */
const RUN_BODY_MEMBER_READERS = {
  /** The run aggregate's progression counter, as the taxonomy spells it. */
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
  recoverySpanClassification: "string",
  providerFailureDetail: "string",
  completionKind: "string",
  intendedClose: "boolean",
  /** Stamped on `run.running`, where the resolved root and posture are final. */
  executionPosture: "object",
  /** The stop condition that ended the run — a budget exhaustion, an idle timeout. */
  trigger: "string",
} as const satisfies Readonly<Record<DurableRunMemberName, WireMemberReaderName>>;

/**
 * The members the creation row's own payload declares beyond the two stream shapes:
 * its linkage, its admission-resolved limits and its admission stamps. `agentId` is
 * already in the base table, and `resolvedAgent` is the agent's record rather than the
 * run's: only its id reaches the body, as the run's `agentId`.
 */
type RunQueuedOwnMemberName = Exclude<
  keyof RunQueuedPayload,
  RegisteredRunMemberName | "sessionId" | "agentId" | "resolvedAgent"
>;

/** The run's creation, the one kind that can bring its agent into the session. */
const RUN_QUEUED_EVENT_KIND: Extract<SessionEventType, "run.queued"> = "run.queued";

/**
 * The registered kinds whose durable payload names members of its own.
 *
 * `Extract`ed from the census rather than typed `string`, so a kind misspelled
 * here fails against the taxonomy instead of quietly claiming members for an
 * event no daemon emits.
 */
type RunKindWithPerTypeMembers = Extract<
  SessionEventType,
  "run.queued" | "run.provider_initialized" | "run.turn_started" | "run.worker_shutdown"
>;

/**
 * The per-type members those four kinds register, and the reader that carries
 * each onto the body.
 *
 * PER TYPE, not merged into the table above, because that is what the corpus registers:
 * each of these rows has its own payload shape, so `provider` is a member of an
 * initialization report and of nothing else, and `position` is a member of a turn
 * boundary and of nothing else. A single flat table would read either one off any run
 * beat that happened to spell it, which is a body member with no registration behind
 * it.
 *
 * Every entry is a member the two `run.subscribeState` shapes do not declare — a
 * member either one DOES declare belongs in the derived table above and would be
 * a second spelling of it here, which the co-located test refuses.
 */
const PER_TYPE_RUN_BODY_MEMBER_READERS: Readonly<
  Record<RunKindWithPerTypeMembers, Readonly<Record<string, WireMemberReaderName>>>
> = Object.freeze({
  // The creation row's linkage, its admission-resolved limits and its admission
  // stamps, keyed by the contract's own payload so a member it gains or loses fails to
  // compile here.
  "run.queued": Object.freeze({
    parentRunId: "string",
    internalHelper: "boolean",
    admittedUnpricedCapUsdMicros: "number",
    admittedModelFamily: "string",
    reachedBy: "string",
    effectiveRunConfig: "object",
    admittedProviderAccountId: "string",
  } satisfies Record<RunQueuedOwnMemberName, WireMemberReaderName>),
  // The provider's own initialization report, which is what names the provider and
  // the model a run is actually running against.
  "run.provider_initialized": Object.freeze({ provider: "string", model: "string" }),
  // The turn boundary's normalized session position, absent where the provider
  // wire supplies none.
  "run.turn_started": Object.freeze({ position: "number" }),
  // The sanitized shutdown reason a mid-run worker signal carries.
  "run.worker_shutdown": Object.freeze({ reason: "string" }),
});

/** The reader table for a kind that registers no members of its own. */
const NO_PER_TYPE_MEMBERS: Readonly<Record<string, WireMemberReaderName>> = Object.freeze({});

/**
 * One reader per shape, and the only place a payload member is type-checked.
 *
 * A wrong-typed member reads as ABSENT rather than as itself: the payload is
 * `unknown` until something checks it, and a number rendered where a state string
 * belongs looks exactly as confident as the real thing. An absent member is left
 * off the body entirely, because the store's merge is a spread and a
 * present-but-`undefined` key erases what an earlier event established.
 */
const WIRE_MEMBER_READERS: Readonly<Record<WireMemberReaderName, (value: unknown) => unknown>> = {
  // The string arm is `core/wire-strings.ts` itself rather than a fourth spelling of
  // it: this table's rule for a string member and that predicate's rule are the same
  // sentence, and two copies of one sentence are how they come to disagree.
  string: readWireString,
  number: (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined),
  boolean: (value) => (typeof value === "boolean" ? value : undefined),
  // Carried whole and unparsed — `executionPosture` is a registered object the
  // console renders through its own consumer, and re-validating it here would be
  // a second reading of a shape the contract already owns. The arm that decides
  // whether it IS a body is `core/wire-record.ts`, for the reason the string arm
  // above takes `readWireString`: this table's rule and that predicate's rule are
  // the same sentence, and two copies of one sentence are how they come to disagree.
  object: (value) => (isWireRecord(value) ? value : undefined),
};

/**
 * The body members this payload names, or `undefined` when it names none.
 *
 * Walks the two tables rather than reading members by name, so the set the body
 * carries and the set the corpus registers cannot come apart. A member neither
 * table names is not read at all — it is absent from both, so it never reaches
 * the body however the payload spells it.
 *
 * Two tables and not one because the registrations differ in scope: the derived
 * one holds what every run row may carry, and the per-type one holds what THIS
 * kind alone registers. A kind that registers nothing of its own walks the first
 * and an empty second.
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
 * The agent a run's creation starts from a saved definition, by id.
 *
 * A creation row names its agent by `agentId` where the agent is already in the
 * session, and inside `resolvedAgent` where the run brings it in, never both. The
 * body's `agentId` is the agent the run belongs to either way, so a run of a
 * definition-started agent is bound to that agent like any other.
 */
function readResolvedAgentId(
  payload: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const resolvedAgent = payload?.["resolvedAgent"];
  return isWireRecord(resolvedAgent) ? readWireString(resolvedAgent["agentId"]) : undefined;
}

/**
 * The per-type readers this kind registers, or none for a kind that registers
 * none.
 *
 * `Object.hasOwn` rather than an indexed read: the kind arrives wire-verbatim, so
 * `"constructor"` reaches this lookup exactly as a real kind does and an indexed
 * read would answer it with something off `Object.prototype`.
 */
function perTypeMemberReadersFor(
  eventKind: string,
): Readonly<Record<string, WireMemberReaderName>> {
  return Object.hasOwn(PER_TYPE_RUN_BODY_MEMBER_READERS, eventKind)
    ? PER_TYPE_RUN_BODY_MEMBER_READERS[eventKind as RunKindWithPerTypeMembers]
    : NO_PER_TYPE_MEMBERS;
}
