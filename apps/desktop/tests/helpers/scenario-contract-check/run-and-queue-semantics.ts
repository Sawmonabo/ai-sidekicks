// The rules the shipped schemas do not carry, each read off the module that owns it.
//
// `SessionEventSchema` registers no payload variant for a run's state transitions after creation,
// for the forward run rows, or for any queue kind. Where a module in this tree owns a rule it is
// read, not restated; where none does, the rule is written here once.
//
// - The run state machine's transition table. A beat whose members are each registered but whose
//   combination is not, such as `previousState` equal to `newState`, passes every schema layer;
//   the table defines a self-transition for no state.
// - The queue payload's required member. The `queue_item.*` kinds are census-only in the strict
//   layer, so a beat that omits `state` passes all three schema legs.
// - The registered payload of a run-lifecycle kind no stream projects. Some run rows reach a
//   subscriber only through `session.subscribe`: the creation row `run.queued`, the forward rows
//   (`run.provider_initialized`, `run.turn_started`, `run.worker_shutdown`), the step bound and the
//   recovery answer. `run.provider_initialized` with no `provider` passed every other leg and was
//   folded into a run entity built from half a payload. The table is keyed by the census's `run.`
//   root less the kinds `session-event-stream-kinds.ts` puts on a narrowed stream, so a newly
//   excluded kind is a compile error here.
// - The projection the run-lifecycle stream delivers. `run-stream-projection.fixture.ts` builds
//   the `RunStateChangeEvent` or `RunRolledBackEvent` a `run.subscribeState` subscriber receives,
//   and this leg calls it and reports its refusal. A beat carrying only `{newState: "starting"}`
//   names a registered kind and passes every other leg, yet the fixture refuses it at delivery for
//   want of `sessionId`, `runId`, `runVersion` and `previousState`, and the run-lifecycle projector
//   drops it for naming no `runId`. Partial copies of that rule would let a scenario pass this
//   predicate and fail at delivery.
//
// The queue leg is not the same call: the queue arm of that projection yields a `QueueItemSummary`
// with `priority` and `createdAt`, which no queue event carries and the queue rows' own read
// supplies. Routing queue kinds through it would refuse every scenario that scripts a queue beat
// without that read, a claim about replies rather than about a beat.

import {
  RunIdSchema,
  RunQueuedPayloadSchema,
  RunRecoveryResolvedPayloadSchema,
  RunStepLimitReachedPayloadSchema,
  SessionIdSchema,
} from "@ai-sidekicks/contracts";
import type { SessionEventType } from "@ai-sidekicks/contracts";
import { z } from "zod";
import type { ZodType } from "zod";

import { describeSchemaIssue } from "./scenario-contract-defect.js";
import { projectRunStreamDelivery } from "@renderer/services/run-streams/run-stream-projection.fixture.js";
import type { ScenarioBeat } from "../../../fixtures/scenario.js";
import { RUN_STATE_EVENT_STREAM } from "@renderer/services/daemon/session-event-streams.js";
import {
  runQueueStreamStateFor,
  runStateStreamArmFor,
  type RunStateStreamKind,
} from "@renderer/services/daemon/session-event-stream-kinds.js";

/**
 * What one beat gets wrong about the run or queue rule its kind is under, or `undefined`.
 *
 * Four legs in the order the defects compound: a self-transition, a missing queue state, an
 * unprojected run payload, and the stream projection. Each answers `undefined` for a kind it does
 * not claim. The last two partition the `run.` root by construction, since one claims exactly the
 * kinds `runStateStreamArmFor` names and the other exactly the rest.
 */
export function describeRunAndQueueSemanticsDefect(beat: ScenarioBeat): string | undefined {
  return (
    describeSelfTransitionDefect(beat) ??
    describeQueueStateDefect(beat) ??
    describeUnprojectedRunPayloadDefect(beat) ??
    describeRunStreamProjectionDefect(beat)
  );
}

/**
 * One kind of the census's run-lifecycle root.
 *
 * `Extract`ed from the census rather than listed, so a kind added under `run.` has to be decided
 * here.
 */
type RunLifecycleKind = Extract<SessionEventType, `run.${string}`>;

/**
 * The run kinds no narrowed stream projects, taken as a type.
 *
 * The routing table read backwards, which makes the payload table below total: a kind that leaves
 * `run.subscribeState` fails to compile until its payload is written, and one that joins fails
 * until its row is removed.
 */
type UnprojectedRunLifecycleKind = Exclude<RunLifecycleKind, RunStateStreamKind>;

/**
 * The run identity every run-lifecycle payload carries: `{sessionId, runId, runVersion}`.
 *
 * The id schemas are the contract's own; `runVersion` takes the same
 * `z.number().int().nonnegative()` the contracts package applies to every run-progression counter.
 */
const runIdentityShape = {
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  runVersion: z.number().int().nonnegative(),
};

/**
 * The registered payload of each run kind no stream projects.
 *
 * The forward rows are the only place those shapes exist, and `RunStateChangeEventSchema` is the
 * `run.subscribeState` wire projection rather than the durable payload. Not `.strict()`: what is
 * fixed for these kinds is which members are required, and refusing an invented member is
 * `beat-shape.ts`'s strict-layer leg, which reaches only kinds with a registered variant. The
 * creation row, the step bound and the recovery answer are registered, so their rows are the
 * contract's own schemas.
 */
const REGISTERED_UNPROJECTED_RUN_PAYLOADS: Readonly<Record<UnprojectedRunLifecycleKind, ZodType>> =
  Object.freeze({
    "run.queued": RunQueuedPayloadSchema,
    // `{sessionId, runId, runVersion, provider, model?}`.
    "run.provider_initialized": z.object({
      ...runIdentityShape,
      provider: z.string().min(1),
      model: z.string().optional(),
    }),
    // `{sessionId, runId, runVersion, position?}`, `position` a non-negative session position.
    "run.turn_started": z.object({
      ...runIdentityShape,
      position: z.number().int().nonnegative().optional(),
    }),
    // `{sessionId, runId, runVersion, reason?}`, the sanitized provider-supplied shutdown reason.
    "run.worker_shutdown": z.object({ ...runIdentityShape, reason: z.string().optional() }),
    "run.step_limit_reached": RunStepLimitReachedPayloadSchema,
    "run.recovery_resolved": RunRecoveryResolvedPayloadSchema,
  } satisfies Record<UnprojectedRunLifecycleKind, ZodType>);

/**
 * A run beat whose registered payload rejects it, or `undefined` for every other kind.
 *
 * The half of the run root the projection leg cannot reach. A `run.queued` beat with only
 * `{sessionId, runId}` composes into a carrier the envelope accepts and takes the strict layer's
 * discriminator escape, and the run-lifecycle projector folds it into a run entity with no
 * progression counter and no state. Nothing else refuses it.
 */
function describeUnprojectedRunPayloadDefect(beat: ScenarioBeat): string | undefined {
  const registeredPayload = Object.hasOwn(REGISTERED_UNPROJECTED_RUN_PAYLOADS, beat.event.kind)
    ? REGISTERED_UNPROJECTED_RUN_PAYLOADS[beat.event.kind as UnprojectedRunLifecycleKind]
    : undefined;
  if (registeredPayload === undefined) {
    return undefined;
  }
  const parsed = registeredPayload.safeParse(beat.event.payload ?? {});
  if (parsed.success) {
    return undefined;
  }
  return (
    `the registered "${beat.event.kind}" payload rejects this beat, and no narrowed stream ` +
    "projects this kind — so nothing downstream would refuse it either, and a view would " +
    `read a run built out of half a payload: ${parsed.error.issues.map(describeSchemaIssue).join("; ")}.`
  );
}

/**
 * A beat claiming a run moved from a state to itself, or `undefined` when it claims no such thing.
 *
 * The run state machine has no row whose `From` and `To` are the same state, so no daemon emits
 * one, yet it reads as real: both values are registered and no payload variant catches it. A view
 * built against it learns to render a transition that never happens. Keyed on the two payload
 * members rather than the kind, so it holds for any run row a later taxonomy registers.
 */
function describeSelfTransitionDefect(beat: ScenarioBeat): string | undefined {
  const payload = beat.event.payload;
  if (payload === undefined) {
    return undefined;
  }
  const previousState = payload["previousState"];
  if (previousState === undefined || previousState !== payload["newState"]) {
    return undefined;
  }
  return (
    `this beat names "${String(previousState)}" as both \`previousState\` and \`newState\`, ` +
    "so it claims a run transitioned to the state it was already in. The run state " +
    "machine's transition table has no such row, so no daemon emits one — script the " +
    "transition this beat means, or, for a run being created, name the state it is in " +
    "and no state it came from."
  );
}

/**
 * A queue beat that names no state, or names one its kind contradicts.
 *
 * The queue payload is `{sessionId, queueItemId, state}` and no `queue_item.*` kind has a
 * registered variant, so `state` is required by the wire and enforced by nothing else. Without it
 * the projection would take the row's state from the kind alone. The kind-to-state mapping is
 * `session-event-stream-kinds.ts`'s, read here so a second copy cannot let a scenario pass this
 * leg and fail the projection. A kind it does not claim is not a queue beat.
 */
function describeQueueStateDefect(beat: ScenarioBeat): string | undefined {
  const announcedState = runQueueStreamStateFor(beat.event.kind);
  if (announcedState === undefined) {
    return undefined;
  }
  const statedState = beat.event.payload?.["state"];
  if (statedState === undefined) {
    return (
      "this beat names no `state`, which is a required member of every queue payload " +
      "the daemon emits. Name the state this row moved to — " +
      `\`"${announcedState}"\`, which is what its kind announces.`
    );
  }
  if (statedState !== announcedState) {
    return (
      `this beat announces "${announcedState}" by its kind and ` +
      `${JSON.stringify(statedState)} in its payload, so it reports two queue states at ` +
      "once. One of the two is the row this beat means; script that one."
    );
  }
  return undefined;
}

/**
 * A run-lifecycle beat the stream that carries it cannot project, or `undefined` when the
 * projection builds a delivery out of it.
 *
 * `run-stream-projection.fixture.ts` owns the complete registered shape: it parses the candidate
 * through the schema for the arm (`RunStateChangeEventSchema` or `RunRolledBackEventSchema`) and
 * cross-checks the kind against the announced state and the envelope's session against the
 * payload's. Calling it rather than copying a fragment keeps a scenario from passing here and
 * failing one stream later; its refusal is reported in its own words.
 *
 * Scoped by `runStateStreamArmFor` rather than a kind list: `run.queued` (delivered by
 * `session.subscribe`) and the forward rows have no registered projection.
 */
function describeRunStreamProjectionDefect(beat: ScenarioBeat): string | undefined {
  if (runStateStreamArmFor(beat.event.kind) === undefined) {
    return undefined;
  }
  // The `undefined` arm ("this subscription registers no projection") is reachable only if the
  // two readings of the subscription name drift apart; it is reported rather than asserted so it
  // stays a reported defect like every other.
  const projected = projectRunStreamDelivery(RUN_STATE_EVENT_STREAM, beat.event);
  if (projected === undefined || projected.status === "projected") {
    return undefined;
  }
  return (
    `the \`${RUN_STATE_EVENT_STREAM}\` projection refuses this beat, so the stream that ` +
    `carries it would deliver nothing for it: ${projected.detail}`
  );
}
