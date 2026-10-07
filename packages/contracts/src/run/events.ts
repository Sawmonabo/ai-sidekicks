// The stored payloads of a run's state changes and of its interventions, one per event type. The
// event contract imports this file at load, so it never imports that contract.
import { z } from "zod";

import { wireFreeFormString } from "../free-form-string.js";
import { countSchema } from "../internal/wire-scalars.js";
import { InterruptReasonSchema, type InterruptReason } from "../orchestration.js";
import { type ExecutionPosture } from "../provider/driver/capabilities.js";
import { InterventionTypeSchema, type InterventionType } from "../provider/driver/intervention.js";
import { DRIVER_FAILURE_DETAIL_MAX_LEN } from "../provider/driver/length-limits.js";
import { RecoveryConditionSchema, type RecoveryCondition } from "../provider/driver/recovery.js";
import { SessionIdSchema, UserIdSchema, type SessionId, type UserId } from "../session/id.js";
import {
  ExecutionPostureSchema,
  InterventionIdSchema,
  ProcessExitSchema,
  RunCompletionKindSchema,
  RunFailureCategorySchema,
  RunFailureCauseSchema,
  type InterventionId,
  type InterventionState,
  type ProcessExit,
  type RunCompletionKind,
  type RunFailureCategory,
  type RunFailureCause,
} from "./control.js";
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

/**
 * The stored payload of `intervention.<state>`, whose `state` is its own type's state. `actor` is
 * the person who asked, absent when the daemon acted; the device is on the intervention's record.
 */
export interface InterventionEventPayload<TState extends InterventionState> {
  sessionId: SessionId;
  interventionId: InterventionId;
  targetRunId: RunId;
  type: InterventionType;
  state: TState;
  actor?: UserId | undefined;
}

const buildInterventionEventPayloadSchema = <TState extends InterventionState>(state: TState) =>
  z
    .object({
      sessionId: SessionIdSchema,
      interventionId: InterventionIdSchema,
      targetRunId: RunIdSchema,
      type: InterventionTypeSchema,
      state: z.literal(state),
      actor: UserIdSchema.optional(),
    })
    .strict();

/** Parses each stored intervention event, keyed by its state; each refuses another `state`. */
export const INTERVENTION_EVENT_PAYLOAD_SCHEMAS: {
  readonly [TState in InterventionState]: z.ZodType<
    InterventionEventPayload<TState>,
    InterventionEventPayload<TState>
  >;
} = {
  requested: buildInterventionEventPayloadSchema("requested"),
  accepted: buildInterventionEventPayloadSchema("accepted"),
  applied: buildInterventionEventPayloadSchema("applied"),
  rejected: buildInterventionEventPayloadSchema("rejected"),
  degraded: buildInterventionEventPayloadSchema("degraded"),
  expired: buildInterventionEventPayloadSchema("expired"),
};
