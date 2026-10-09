// The stored payloads of a run's state changes, of the markers its provider reports, and of its
// interventions, one per event type. The event contract imports this file at load, so it never
// imports that contract.
import { z } from "zod";

import { SourcePositionSchema, type SourcePosition } from "../event/envelope.js";
import { wireFreeFormString } from "../free-form-string.js";
import { countSchema } from "../internal/wire-scalars.js";
import { InterruptReasonSchema, type InterruptReason } from "../orchestration.js";
import { type ExecutionPosture } from "../provider/driver/capabilities.js";
import { InterventionTypeSchema, type InterventionType } from "../provider/driver/intervention.js";
import { DRIVER_FAILURE_DETAIL_MAX_LEN } from "../provider/driver/length-limits.js";
import { DRIVER_WIRE_TOKEN_MAX_LEN } from "../provider/driver/methods.js";
import { ProviderNameSchema, type ProviderName } from "../provider/name.js";
import { RecoveryConditionSchema, type RecoveryCondition } from "../provider/driver/recovery.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";
import { DeviceIdSchema, type DeviceId } from "../trust-statement.js";
import {
  ExecutionPostureSchema,
  InterventionIdSchema,
  ProcessExitSchema,
  RunCompletionKindSchema,
  RunFailureCategorySchema,
  type InterventionId,
  type InterventionState,
  type ProcessExit,
  type RunCompletionKind,
  type RunFailureCategory,
} from "./control.js";
import { RunFailureCauseSchema, type RunFailureCause } from "./failure-cause.js";
import { RunIdSchema, type RunId } from "./id.js";
import { RunStateSchema, type RunState } from "./state.js";

/** A run state with a state-change event of its own: every state but `queued`, the run's birth. */
export type RunStateChangeState = Exclude<RunState, "queued">;

// A daemon-initiated close marks its terminal so a reader never takes it for a crash.
interface RunTerminalMembers {
  intendedClose?: true | undefined;
}

// What each state's change carries beyond the members every change has.
interface RunStateChangeMembersByState {
  starting: Record<never, never>;
  // Stamped here because the workspace root and effective posture are final only once running.
  running: { executionPosture?: ExecutionPosture | undefined };
  waiting_for_approval: Record<never, never>;
  waiting_for_input: Record<never, never>;
  pausing: Record<never, never>;
  paused: Record<never, never>;
  completed: RunTerminalMembers & { completionKind: RunCompletionKind };
  // Present only when the daemon itself interrupted the run; the person's own interrupt has none.
  interrupted: RunTerminalMembers & { trigger?: InterruptReason | undefined };
  stopped: RunTerminalMembers;
  failed: RunTerminalMembers & {
    failureCause?: RunFailureCause | undefined;
    providerFailureDetail?: string | undefined;
    processExit?: ProcessExit | undefined;
  };
}

/**
 * The stored payload of `run.<state>`: the transition with its new run version, the members its own
 * state carries, and `failureCategory` and `recoveryCondition`, which any change may carry.
 */
export type RunStateChangePayload<TState extends RunStateChangeState> = {
  sessionId: SessionId;
  runId: RunId;
  runVersion: number;
  previousState: RunState;
  newState: TState;
  failureCategory?: RunFailureCategory | undefined;
  recoveryCondition?: RecoveryCondition | undefined;
} & RunStateChangeMembersByState[TState];

const runStateChangeShape = {
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  runVersion: countSchema,
  previousState: RunStateSchema,
  failureCategory: RunFailureCategorySchema.optional(),
  recoveryCondition: RecoveryConditionSchema.optional(),
};
const runTerminalShape = { intendedClose: z.literal(true).optional() };

const buildRunStateChangePayloadSchema = <
  TState extends RunStateChangeState,
  TStateShape extends z.ZodRawShape,
>(
  state: TState,
  stateShape: TStateShape,
) => z.object({ ...runStateChangeShape, newState: z.literal(state), ...stateShape }).strict();

/**
 * Parses each stored run state change, keyed by its state. Each refuses another state's
 * `newState` and every member only another state carries.
 */
export const RUN_STATE_CHANGE_PAYLOAD_SCHEMAS: {
  readonly [TState in RunStateChangeState]: z.ZodType<RunStateChangePayload<TState>>;
} = {
  starting: buildRunStateChangePayloadSchema("starting", {}),
  running: buildRunStateChangePayloadSchema("running", {
    executionPosture: ExecutionPostureSchema.optional(),
  }),
  waiting_for_approval: buildRunStateChangePayloadSchema("waiting_for_approval", {}),
  waiting_for_input: buildRunStateChangePayloadSchema("waiting_for_input", {}),
  pausing: buildRunStateChangePayloadSchema("pausing", {}),
  paused: buildRunStateChangePayloadSchema("paused", {}),
  completed: buildRunStateChangePayloadSchema("completed", {
    ...runTerminalShape,
    completionKind: RunCompletionKindSchema,
  }),
  interrupted: buildRunStateChangePayloadSchema("interrupted", {
    ...runTerminalShape,
    trigger: InterruptReasonSchema.optional(),
  }),
  stopped: buildRunStateChangePayloadSchema("stopped", runTerminalShape),
  failed: buildRunStateChangePayloadSchema("failed", {
    ...runTerminalShape,
    failureCause: RunFailureCauseSchema.optional(),
    providerFailureDetail: wireFreeFormString(
      DRIVER_FAILURE_DETAIL_MAX_LEN,
      "RunStateChangePayload.providerFailureDetail",
    ).optional(),
    processExit: ProcessExitSchema.optional(),
  }),
};

// What every provider marker carries: the run and its version when the marker was recorded, which
// the marker leaves as it is, since it changes no state.
interface RunMarkerMembers {
  sessionId: SessionId;
  runId: RunId;
  runVersion: number;
}
const runMarkerShape = { sessionId: SessionIdSchema, runId: RunIdSchema, runVersion: countSchema };

/**
 * The `run.provider_initialized` payload: the provider process reported its start for the run,
 * with the model it runs where it named one.
 */
export type RunProviderInitializedPayload = RunMarkerMembers & {
  provider: ProviderName;
  model?: string | undefined;
};
/** Parses a {@link RunProviderInitializedPayload}. */
export const RunProviderInitializedPayloadSchema: z.ZodType<RunProviderInitializedPayload> = z
  .object({
    ...runMarkerShape,
    provider: ProviderNameSchema,
    model: wireFreeFormString(
      DRIVER_WIRE_TOKEN_MAX_LEN,
      "RunProviderInitializedPayload.model",
    ).optional(),
  })
  .strict();

/**
 * The `run.turn_started` payload: a turn opened within the run, at the session position the
 * provider named where it named one.
 */
export type RunTurnStartedPayload = RunMarkerMembers & { position?: SourcePosition | undefined };
/** Parses a {@link RunTurnStartedPayload}. */
export const RunTurnStartedPayloadSchema: z.ZodType<RunTurnStartedPayload> = z
  .object({ ...runMarkerShape, position: SourcePositionSchema.optional() })
  .strict();

/**
 * The `run.worker_shutdown` payload: the provider said its worker is shutting down mid-run, with
 * its own reason where it sent one. An early warning, never the run's end.
 */
export type RunWorkerShutdownPayload = RunMarkerMembers & { reason?: string | undefined };
/** Parses a {@link RunWorkerShutdownPayload}. */
export const RunWorkerShutdownPayloadSchema: z.ZodType<RunWorkerShutdownPayload> = z
  .object({
    ...runMarkerShape,
    reason: wireFreeFormString(
      DRIVER_FAILURE_DETAIL_MAX_LEN,
      "RunWorkerShutdownPayload.reason",
    ).optional(),
  })
  .strict();

/** The actor of an intervention the daemon made itself, such as a stop at a spend limit. */
export const DAEMON_INTERVENTION_ACTOR = "daemon";

/**
 * Who an intervention is from: the device whose connection carried it, or
 * {@link DAEMON_INTERVENTION_ACTOR} for the daemon's own. Never a person.
 */
export type InterventionActor = DeviceId | typeof DAEMON_INTERVENTION_ACTOR;

const InterventionActorSchema: z.ZodType<InterventionActor, InterventionActor> = z.union([
  z.literal(DAEMON_INTERVENTION_ACTOR),
  DeviceIdSchema,
]);

// What each state's intervention event carries beyond the members every one has: a failed one
// says why, in the words its reply and its stored row carry, and an applied steer whose message
// went to a run other than its target names that run, as its stored row does.
interface InterventionEventMembersByState {
  requested: Record<never, never>;
  accepted: Record<never, never>;
  applied: { deliveredRunId?: RunId | undefined };
  rejected: Record<never, never>;
  degraded: Record<never, never>;
  expired: Record<never, never>;
  failed: { failureReason: string };
}

/**
 * The stored payload of `intervention.<state>`, whose `state` is its own type's state, and whose
 * `actor` the envelope repeats. A `failed` one carries its `failureReason`.
 */
export type InterventionEventPayload<TState extends InterventionState> = {
  sessionId: SessionId;
  interventionId: InterventionId;
  targetRunId: RunId;
  type: InterventionType;
  state: TState;
  actor: InterventionActor;
} & InterventionEventMembersByState[TState];

const buildInterventionEventPayloadSchema = <
  TState extends InterventionState,
  TStateShape extends z.ZodRawShape,
>(
  state: TState,
  stateShape: TStateShape,
) =>
  z
    .object({
      sessionId: SessionIdSchema,
      interventionId: InterventionIdSchema,
      targetRunId: RunIdSchema,
      type: InterventionTypeSchema,
      state: z.literal(state),
      actor: InterventionActorSchema,
      ...stateShape,
    })
    .strict();

/**
 * Parses each stored intervention event, keyed by its state; each refuses another `state` and a
 * `failureReason` on any state but `failed`.
 */
export const INTERVENTION_EVENT_PAYLOAD_SCHEMAS: {
  readonly [TState in InterventionState]: z.ZodType<
    InterventionEventPayload<TState>,
    InterventionEventPayload<TState>
  >;
} = {
  requested: buildInterventionEventPayloadSchema("requested", {}),
  accepted: buildInterventionEventPayloadSchema("accepted", {}),
  applied: buildInterventionEventPayloadSchema("applied", {
    deliveredRunId: RunIdSchema.optional(),
  }),
  rejected: buildInterventionEventPayloadSchema("rejected", {}),
  degraded: buildInterventionEventPayloadSchema("degraded", {}),
  expired: buildInterventionEventPayloadSchema("expired", {}),
  failed: buildInterventionEventPayloadSchema("failed", {
    failureReason: wireFreeFormString(
      DRIVER_FAILURE_DETAIL_MAX_LEN,
      "InterventionEventPayload.failureReason",
    ),
  }),
};
