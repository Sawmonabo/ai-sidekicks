// A child's own controls. A child here is a provider's own helper inside a run, named by
// `childHandle` from the daemon's parent-to-child index; a child the daemon bridges runs as its
// own run and takes that run's verbs. Each control but the subtree stop carries the parent run's
// version comparand and an idempotency key.
import { z } from "zod";

import {
  AgentTreeMemberSchema,
  ChildHandleSchema,
  type AgentTreeMember,
  type ChildHandle,
} from "../agent/agent.js";
import { countSchema } from "../internal/wire-scalars.js";
import { DRIVER_WIRE_REASON_MAX_LEN } from "../provider/driver/wire.js";
import { RunIdSchema, type RunId } from "../provider/driver/driver.js";
import { QueueItemIdSchema, type QueueItemId } from "./queue.js";
import { RunStateSchema, type RunState } from "./state.js";
import { wireFreeFormString, wireUncappedFreeFormString } from "../session/session.js";

/**
 * Sends a message onto one child's own queue, where it waits for the child's next
 * step as a pending row the lead's queue verbs reach with `childHandle`. It
 * answers as `run.queueCreate` does.
 */
export interface ChildSteerRequest {
  targetRunId: RunId;
  childHandle: ChildHandle;
  content: string;
  expectedRunVersion: number;
  clientIdempotencyKey: string;
}
/** Parses a {@link ChildSteerRequest}. */
export const ChildSteerRequestSchema: z.ZodType<ChildSteerRequest, ChildSteerRequest> = z
  .object({
    targetRunId: RunIdSchema,
    childHandle: ChildHandleSchema,
    content: wireUncappedFreeFormString("ChildSteerRequest.content"),
    expectedRunVersion: countSchema,
    clientIdempotencyKey: z.uuid(),
  })
  .strict();

/**
 * Interrupts one child, and only that child; its pending messages go as its next turn, with
 * `deliverFirst`, the row `Send now` was pressed on, ahead of the rest.
 */
export interface ChildInterruptRequest {
  targetRunId: RunId;
  childHandle: ChildHandle;
  expectedRunVersion: number;
  clientIdempotencyKey: string;
  deliverFirst?: QueueItemId | undefined;
}
/** Parses a {@link ChildInterruptRequest}. */
export const ChildInterruptRequestSchema: z.ZodType<ChildInterruptRequest, ChildInterruptRequest> =
  z
    .object({
      targetRunId: RunIdSchema,
      childHandle: ChildHandleSchema,
      expectedRunVersion: countSchema,
      clientIdempotencyKey: z.uuid(),
      deliverFirst: QueueItemIdSchema.optional(),
    })
    .strict();

/**
 * Where the child stands after the interrupt. A child that had already finished
 * answers the state it finished in.
 */
export interface ChildInterruptResponse {
  childHandle: ChildHandle;
  state: RunState;
}
/** Parses a {@link ChildInterruptResponse}. */
export const ChildInterruptResponseSchema: z.ZodType<ChildInterruptResponse> = z
  .object({ childHandle: ChildHandleSchema, state: RunStateSchema })
  .strict();

/** Pauses one child (`paused: true`) or continues it (`paused: false`). */
export interface ChildPauseSetRequest {
  targetRunId: RunId;
  childHandle: ChildHandle;
  paused: boolean;
  expectedRunVersion: number;
  clientIdempotencyKey: string;
}
/** Parses a {@link ChildPauseSetRequest}. */
export const ChildPauseSetRequestSchema: z.ZodType<ChildPauseSetRequest, ChildPauseSetRequest> = z
  .object({
    targetRunId: RunIdSchema,
    childHandle: ChildHandleSchema,
    paused: z.boolean(),
    expectedRunVersion: countSchema,
    clientIdempotencyKey: z.uuid(),
  })
  .strict();

/**
 * Where the child stands after the set. `holdLost` says the hold that paused it
 * was gone before the continue reached it (the provider canceled the held
 * call): the child is not paused, and it was not released by the person.
 */
export interface ChildPauseSetResponse {
  childHandle: ChildHandle;
  paused: boolean;
  holdLost?: true | undefined;
}
/** Parses a {@link ChildPauseSetResponse}; a lost hold never comes with `paused: true`. */
export const ChildPauseSetResponseSchema: z.ZodType<ChildPauseSetResponse> = z
  .object({
    childHandle: ChildHandleSchema,
    paused: z.boolean(),
    holdLost: z.literal(true).optional(),
  })
  .strict()
  .refine((response) => response.holdLost === undefined || !response.paused, {
    path: ["holdLost"],
    message: "A lost hold leaves the child not paused.",
  });

/**
 * Stops every running child of a run at every depth: the daemon walks its own
 * index, one stop per child, never relayed through the lead.
 */
export interface ChildrenStopRequest {
  runId: RunId;
}
/** Parses a {@link ChildrenStopRequest}. */
export const ChildrenStopRequestSchema: z.ZodType<ChildrenStopRequest, ChildrenStopRequest> = z
  .object({ runId: RunIdSchema })
  .strict();

/** One child's stop: stopped, already ended, or failed with the daemon's reason. */
export interface ChildStopOutcome {
  child: AgentTreeMember;
  outcome: "stopped" | "already_ended" | "failed";
  reason?: string | undefined;
}
/** Every child the stop reached, each with its own outcome; nothing is atomic. */
export interface ChildrenStopResponse {
  children: ChildStopOutcome[];
}
/** Parses a {@link ChildrenStopResponse}; only a failed stop carries a reason. */
export const ChildrenStopResponseSchema: z.ZodType<ChildrenStopResponse> = z
  .object({
    children: z.array(
      z
        .object({
          child: AgentTreeMemberSchema,
          outcome: z.enum(["stopped", "already_ended", "failed"]),
          reason: wireFreeFormString(
            DRIVER_WIRE_REASON_MAX_LEN,
            "ChildStopOutcome.reason",
          ).optional(),
        })
        .strict()
        .refine((row) => (row.outcome === "failed") === (row.reason !== undefined), {
          path: ["reason"],
          message: "A failed stop carries its reason, and only a failed one does.",
        }),
    ),
  })
  .strict();

/**
 * The refusal of a child control: the daemon's index names no such child, the
 * child has ended (an interrupt instead answers the state it finished in), or the
 * provider refused the act. A hold lost before a continue is a result, never this
 * refusal.
 */
export const RUN_CHILD_CONTROL_REFUSED_CODE = "run.child_control_refused" as const;
/**
 * The type of {@link RUN_CHILD_CONTROL_REFUSED_CODE}.
 *
 * @consumedBy the handler that returns the `run.child_control_refused` error
 */
export type RunChildControlRefusedCode = typeof RUN_CHILD_CONTROL_REFUSED_CODE;

/** Why a child control was refused. */
export type RunChildControlRefusedReason = "child_unknown" | "child_ended" | "provider_refused";
/** Every {@link RunChildControlRefusedReason}. */
export const RUN_CHILD_CONTROL_REFUSED_REASONS: readonly RunChildControlRefusedReason[] =
  Object.freeze(["child_unknown", "child_ended", "provider_refused"]);

/** The details a `run.child_control_refused` refusal carries. */
export interface RunChildControlRefusedDetails {
  reason: RunChildControlRefusedReason;
}
/**
 * Parses {@link RunChildControlRefusedDetails}.
 *
 * @consumedBy the handler that returns the `run.child_control_refused` error
 */
export const RunChildControlRefusedDetailsSchema: z.ZodType<RunChildControlRefusedDetails> = z
  .object({ reason: z.enum(RUN_CHILD_CONTROL_REFUSED_REASONS) })
  .strict();
