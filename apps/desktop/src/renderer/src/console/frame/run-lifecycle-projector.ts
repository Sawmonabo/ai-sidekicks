// The `run` partition's projector: run-lifecycle events folded into run entities.
//
// `SessionStoreRegistry` has taken a projector registry since it was written and
// the composition root registered NONE, so `useSessionPartition(store, "run")`
// answered an empty map on every session however many `run.*` events had landed —
// a sidebar that renders a live session's runs as "no runs", indistinguishable
// from a session that has none.
//
// WHY IT LIVES IN `frame/` AND NOT IN `store/` OR IN A VIEW FAMILY
//
// Two constraints meet, and only one home satisfies both. It reads WIRE member
// names off an event payload, which `store/` deliberately does not do —
// `store/entities.ts` frames `ConsoleSessionEvent` as a renderer-local projection
// contract precisely so the store family holds no wire knowledge, the same reason
// `session-event-binder.ts` states for living here. And it is REGISTERED by the
// composition root, which puts it at or below `frame/` in the family DAG: a view
// family sits above the frame, so a projector owned there could not be handed to
// the registry the frame constructs. `frame/` is where those two meet.
//
// WHAT IT DERIVES RATHER THAN DECLARES
//
// The kinds it claims are read from `SESSION_EVENT_CATEGORY_BY_TYPE` filtered to
// `run_lifecycle`, never from a list written here. A hand list is how a console
// silently stops projecting the day the taxonomy grows a fourteenth run event: the
// new kind lands in the timeline, contributes no entity, and nothing fails.
//
// WHAT IT READS OFF A PAYLOAD, AND WHERE THAT LIST COMES FROM
//
// The body used to keep four members — `runVersion`, the two state strings, and
// `agentId` — while claiming every kind in the family. Everything else the
// registered payloads carry was dropped on the floor: `executionPosture` off
// `run.running`, the stop-condition `trigger`, the orchestration linkage, the
// admission stamps, and the rollback `targetPosition`. Those values stayed in the
// raw timeline and never reached the `run` partition, so a surface reading the
// run body — the composer's posture chip among them — found nothing and rendered
// as though the run had never carried one.
//
// So the member list is DERIVED rather than hand-kept. `RunStateChangeEvent` and
// `RunRolledBackEvent` (`packages/contracts/src/runControl.ts`) are the two
// registered run shapes, and `DurableRunMemberName` below is their key union
// minus the four members the durable row does not carry under those names, plus
// the two the durable payload carries alone. A member added to either registered
// shape lands in that union and fails the reader table's `satisfies` until
// someone classifies it, which is the whole point: a hand list is how a body
// silently stops carrying the member a surface was built to read.
//
// AND THE DERIVATION IS NOT THE WHOLE PAYLOAD, WHICH IS THE SECOND TABLE'S
// SUBJECT. Those two shapes are both `run.subscribeState` projections, and this
// projector folds the DURABLE rows off `session.subscribe`. Four of the thirteen
// kinds register per-type members that neither projection declares and that
// `packages/contracts` therefore holds no schema for at all — `SessionEventSchema`
// registers no run-lifecycle payload variant, so there is nothing to derive them
// from. Treating the two subscription shapes as exhaustive dropped every one of
// them: the run's creation lost its orchestration `linkType`, its admission-
// resolved `effectiveRunConfig`, and the account it was admitted against, and the
// three forward, non-state rows lost the whole of what they carry — the provider
// and model an initialization reports, the position a turn opened at, the reason a
// worker shut down. Each reached the timeline and none reached the `run` partition
// a pane reads. `UNDECLARED_RUN_BODY_MEMBER_READERS` is those four rows, keyed by
// the kind that registers them so the parse is PER TYPE — a member registered on
// one kind is never read off another — and typed against the census so a
// misspelled kind fails to compile rather than reading a payload no daemon sends.
// The day a contracts shape declares one of these members, it enters
// `DurableRunMemberName`, the base table classifies it, and the co-located test's
// no-second-spelling case fails until the entry here is deleted.
//
// THE TWO SHAPES ARE NOT ONE SHAPE, and the exclusions are where that is stated.
// That module says so itself: the `run.subscribeState` projection is
// "deliberately distinct from the durable `run_lifecycle` payload of `Spec-006
// §Run Lifecycle (run_lifecycle)` (`{sessionId, runId, runVersion,
// previousState, newState, channelId?, ...}`)", where "the canonical wire member
// is `currentState`" on the stream and `newState` on the durable row. `sessionId`
// and `timestamp` are excluded because the envelope already carries both —
// `event.sessionId` and `event.occurredAt`, the latter stored as `touchedAt` —
// and `runId` because it is the entity's own id. `agentId` is the one member no
// registered shape names, and it is `Spec-006`'s: `run.queued` carries it for
// orchestration-created runs.
//
// `state` is written only where the payload names `newState`: writing one for a
// non-state event would have a turn boundary silently rewrite the run's state,
// and writing `undefined` would be worse still — the store's entity merge is a
// spread, so a present-but-undefined key ERASES what the last transition
// established.
//
// A PROJECTOR IS PURE, AND THAT DECIDES THE MALFORMED CASE. It may read the event
// and nothing else — no store, no clock, no tripwire — because the apply path
// replays prefixes and a side effect there would fire twice. A run event whose
// payload names no `runId` therefore yields NO mutation rather than a throw or a
// report: it names no entity to key on, the event is still admitted, and the
// timeline is the ledger that records it arrived.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";
import type {
  RunRolledBackEvent,
  RunStateChangeEvent,
  SessionEventType,
} from "@ai-sidekicks/contracts";

import type {
  ConsoleSessionEvent,
  EntityMutation,
  EntityProjector,
  EntityProjectorRegistry,
} from "../store/index.js";

/**
 * The event kinds this projector claims, derived from the shipped taxonomy.
 *
 * Filtered from the census rather than restated, so the set is whatever the
 * contract says it is at build time.
 */
export const RUN_LIFECYCLE_EVENT_KINDS: readonly string[] = [...SESSION_EVENT_CATEGORY_BY_TYPE]
  .filter(([, category]) => category === "run_lifecycle")
  .map(([eventType]) => eventType);

/** Every member either registered run shape names. */
type RegisteredRunMemberName = keyof RunStateChangeEvent | keyof RunRolledBackEvent;

/**
 * Every member the DURABLE `run_lifecycle` payload carries.
 *
 * The registered key union minus the four the durable row does not carry under
 * those names, plus the two it carries alone. Each exclusion is named rather than
 * dropped silently, so a reader can check the subtraction: `runId` is the run
 * entity's own id, `sessionId` and `timestamp` ride the envelope, and
 * `currentState` is the stream's spelling of the durable `newState`.
 */
type DurableRunMemberName =
  | Exclude<RegisteredRunMemberName, "runId" | "sessionId" | "timestamp" | "currentState">
  | "newState"
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
  /** The run aggregate's progression counter, as `Spec-006` spells it. */
  runVersion: "number",
  /** The state the run left, absent on `run.queued` and on the non-state kinds. */
  previousState: "string",
  /** The state the run entered. Absent on the four forward, non-state kinds. */
  newState: "string",
  /** The agent the run was created for, carried by `run.queued`. */
  agentId: "string",
  channelId: "string",
  /** The turn-boundary anchor a rollback landed at, off `run.rolled_back`. */
  targetPosition: "number",
  failureCategory: "string",
  recoveryCondition: "string",
  recoverySpanClassification: "string",
  healthSignal: "string",
  providerFailureDetail: "string",
  completionKind: "string",
  intendedClose: "boolean",
  /** Stamped on `run.running`, where the resolved root and posture are final. */
  executionPosture: "object",
  /** The stop condition that ended the run — a budget exhaustion, an idle timeout. */
  trigger: "string",
  parentRunId: "string",
  internalHelper: "boolean",
  producingNodeId: "string",
  admittedUnpricedCapCents: "number",
  admittedModelFamily: "string",
} as const satisfies Readonly<Record<DurableRunMemberName, WireMemberReaderName>>;

/**
 * The registered kinds whose durable payload names members no contracts shape
 * declares.
 *
 * `Extract`ed from the census rather than typed `string`, so a kind misspelled
 * here fails against the taxonomy instead of quietly claiming members for an
 * event no daemon emits.
 */
type RunKindWithUndeclaredMembers = Extract<
  SessionEventType,
  "run.queued" | "run.provider_initialized" | "run.turn_started" | "run.worker_shutdown"
>;

/**
 * The per-type members those four kinds register, and the reader that carries
 * each onto the body.
 *
 * PER TYPE, not merged into the table above, because that is what the corpus
 * registers: `Spec-006 §Run Lifecycle (run_lifecycle)` gives each of these rows
 * its own payload shape, so `provider` is a member of an initialization report and
 * of nothing else, and `position` is a member of a turn boundary and of nothing
 * else. A single flat table would read either one off any run beat that happened
 * to spell it, which is a body member with no registration behind it.
 *
 * Every entry is a member the two `run.subscribeState` shapes do not declare — a
 * member either one DOES declare belongs in the derived table above and would be
 * a second spelling of it here, which the co-located test refuses.
 */
const UNDECLARED_RUN_BODY_MEMBER_READERS: Readonly<
  Record<RunKindWithUndeclaredMembers, Readonly<Record<string, WireMemberReaderName>>>
> = Object.freeze({
  // The creation row's orchestration linkage and the account it was admitted
  // against. `linkType` and `effectiveRunConfig` are typed by symbols no
  // TypeScript in this workspace declares — `runControl.ts` says so itself and
  // omits them for exactly that reason — and the account stamp rides the same row.
  "run.queued": Object.freeze({
    linkType: "string",
    effectiveRunConfig: "object",
    admittedProviderAccountId: "string",
  }),
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
const NO_UNDECLARED_MEMBERS: Readonly<Record<string, WireMemberReaderName>> = Object.freeze({});

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
  string: (value) => (typeof value === "string" && value.length > 0 ? value : undefined),
  number: (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined),
  boolean: (value) => (typeof value === "boolean" ? value : undefined),
  // Carried whole and unparsed — `executionPosture` is a registered object the
  // console renders through its own consumer, and re-validating it here would be
  // a second reading of a shape the contract already owns.
  object: (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined,
};

/**
 * Fold one run-lifecycle event into the run it names.
 *
 * Pure and total: it reads the event and answers with mutations, and every path
 * through it answers — a payload it cannot key on answers with none.
 */
export const projectRunLifecycleEvent: EntityProjector = (
  event: ConsoleSessionEvent,
): readonly EntityMutation[] => {
  const payload = event.payload;
  const runId = readWireString(payload, "runId");
  if (runId === undefined) {
    return [];
  }
  const newState = readWireString(payload, "newState");
  const body = readRunEntityBody(event.kind, payload);
  return [
    {
      operation: "upsert",
      entity: {
        kind: "run",
        id: runId,
        // Present only where the payload names one. A spread merge treats a
        // present `undefined` as an erasure, so absence has to be absence.
        ...(newState === undefined ? {} : { state: newState }),
        touchedAt: event.occurredAt,
        ...(event.actorId === undefined ? {} : { attributedTo: event.actorId }),
        ...(body === undefined ? {} : { body }),
      },
    },
  ];
};

/**
 * The projector registry the composition root hands `SessionStoreRegistry`.
 *
 * One function under every kind in the family rather than one function per kind:
 * the fold is the same for all thirteen, and thirteen near-copies is how the
 * fourteenth gets a subtly different one.
 */
export const RUN_LIFECYCLE_PROJECTORS: EntityProjectorRegistry = buildRunLifecycleProjectors();

function buildRunLifecycleProjectors(): EntityProjectorRegistry {
  const projectors: Record<string, EntityProjector> = {};
  for (const eventKind of RUN_LIFECYCLE_EVENT_KINDS) {
    projectors[eventKind] = projectRunLifecycleEvent;
  }
  return projectors;
}

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
function readRunEntityBody(
  eventKind: string,
  payload: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const body: Record<string, unknown> = {};
  for (const readers of [RUN_BODY_MEMBER_READERS, undeclaredMemberReadersFor(eventKind)]) {
    for (const [member, readerName] of Object.entries(readers)) {
      const value = WIRE_MEMBER_READERS[readerName](payload?.[member]);
      if (value !== undefined) {
        body[member] = value;
      }
    }
  }
  return Object.keys(body).length === 0 ? undefined : body;
}

/**
 * The per-type readers this kind registers, or none for a kind that registers
 * none.
 *
 * `Object.hasOwn` rather than an indexed read: the kind arrives wire-verbatim, so
 * `"constructor"` reaches this lookup exactly as a real kind does and an indexed
 * read would answer it with something off `Object.prototype`.
 */
function undeclaredMemberReadersFor(
  eventKind: string,
): Readonly<Record<string, WireMemberReaderName>> {
  return Object.hasOwn(UNDECLARED_RUN_BODY_MEMBER_READERS, eventKind)
    ? UNDECLARED_RUN_BODY_MEMBER_READERS[eventKind as RunKindWithUndeclaredMembers]
    : NO_UNDECLARED_MEMBERS;
}

/** One string member, read through the same reader the body walk uses. */
function readWireString(
  payload: Readonly<Record<string, unknown>> | undefined,
  member: string,
): string | undefined {
  const value = WIRE_MEMBER_READERS.string(payload?.[member]);
  return typeof value === "string" ? value : undefined;
}
