// What the working line reads about one turn: the tokens received so far and the
// agent's own task list. Both are live readings of one turn that end with it, not
// projections of the session log, and both are folded from frames the provider
// already sends: neither adds a provider request and neither is polled.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import type { SubscriptionMethodDescriptor } from "./method-descriptor.js";
import { defineMethodDescriptors } from "./method-descriptor.js";
import { RunIdSchema, type RunId } from "./provider-driver.js";
import { SessionIdSchema, type SessionId } from "./session.js";

/** The run whose current turn a `turn.*` subscription follows. */
export interface TurnSubscribeRequest {
  sessionId: SessionId;
  runId: RunId;
}
/** Parses a {@link TurnSubscribeRequest}. */
export const TurnSubscribeRequestSchema: z.ZodType<TurnSubscribeRequest, TurnSubscribeRequest> = z
  .object({ sessionId: SessionIdSchema, runId: RunIdSchema })
  .strict();

/**
 * The tokens received this turn: the provider's own output count for each model
 * round, summed across the turn, with reasoning already inside it. Cumulative
 * rather than a delta, so a subscriber that joins mid-turn reads the true figure.
 * It starts at zero with the turn and steps up once per model round.
 */
export interface TurnUsageUpdate {
  runId: RunId;
  turnId: string;
  tokensReceived: number;
}
/** Parses a {@link TurnUsageUpdate}. */
export const TurnUsageUpdateSchema: z.ZodType<TurnUsageUpdate> = z
  .object({
    runId: RunIdSchema,
    turnId: z.string().min(1),
    tokensReceived: z.number().int().nonnegative(),
  })
  .strict();

/** Where one task on the agent's list stands. */
export type TurnTaskState = "not_started" | "in_progress" | "done";

/** One task on the agent's list, in the agent's own words. */
export interface TurnTask {
  text: string;
  state: TurnTaskState;
}
const TurnTaskSchema: z.ZodType<TurnTask> = z
  .object({
    text: z.string().min(1),
    state: z.enum(["not_started", "in_progress", "done"]),
  })
  .strict();

/**
 * The turn's whole task list in the agent's order, sent whole on every change,
 * because a provider replaces its list rather than patching it. The list goes when
 * the turn is interrupted and returns with the next turn's list.
 */
export interface TurnTasksUpdate {
  runId: RunId;
  turnId: string;
  tasks: TurnTask[];
}
/** Parses a {@link TurnTasksUpdate}. */
export const TurnTasksUpdateSchema: z.ZodType<TurnTasksUpdate> = z
  .object({ runId: RunIdSchema, turnId: z.string().min(1), tasks: z.array(TurnTaskSchema) })
  .strict();

/** The `turn.*` methods, keyed by name. */
export interface TurnMethodDescriptors {
  readonly "turn.usage": SubscriptionMethodDescriptor<
    "turn.usage",
    TurnSubscribeRequest,
    SubscribeAckResponse,
    TurnUsageUpdate
  >;
  readonly "turn.tasks": SubscriptionMethodDescriptor<
    "turn.tasks",
    TurnSubscribeRequest,
    SubscribeAckResponse,
    TurnTasksUpdate
  >;
}
export const TURN_METHOD_DESCRIPTORS: TurnMethodDescriptors = defineMethodDescriptors({
  "turn.usage": {
    method: "turn.usage",
    procedureType: "subscription",
    mutating: false,
    requestSchema: TurnSubscribeRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: TurnUsageUpdateSchema,
  },
  "turn.tasks": {
    method: "turn.tasks",
    procedureType: "subscription",
    mutating: false,
    requestSchema: TurnSubscribeRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: TurnTasksUpdateSchema,
  },
});
