// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What the working line reads about one turn: the tokens received so far and the agent's own task list.

import type { SchemaCheck } from "../schema-check.js";
import { validateSubscribeAcknowledgmentResponse } from "./checks/jsonrpc/streaming.js";
import {
  validateAgentTurnSubscribeRequest,
  validateTurnTasksUpdate,
  validateTurnUsageUpdate,
} from "./checks/turn.js";
import type { SubscribeAcknowledgmentResponse } from "./jsonrpc/streaming.js";
import type { RunId } from "./run/id.js";
import type { SessionId } from "./session/id.js";

/**
 * A provider's id of one turn.
 */
export type ProviderTurnId = string & { readonly __brand: "ProviderTurnId" };
/**
 * Where one task on the agent's list stands.
 */
export type TurnTaskState = "notStarted" | "inProgress" | "done";

/**
 * The run whose current turn an `agent.turn.usage.subscribe` or `agent.turn.task.subscribe`
 * subscription follows.
 */
export interface AgentTurnSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
}
/**
 * The tokens received this turn: the provider's own output count for each model round, summed
 * across the turn, with reasoning already inside it. Cumulative rather than a delta, so a
 * subscriber that joins mid-turn reads the true figure.
 */
export interface TurnUsageUpdate {
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The turn.
   */
  turnId: ProviderTurnId;
  /**
   * Tokens received so far.
   */
  tokensReceived: number;
}
/**
 * One task on the agent's list, in the agent's own words.
 */
export interface TurnTask {
  /**
   * The task.
   */
  text: string;
  /**
   * Where it stands.
   */
  state: TurnTaskState;
}
/**
 * The turn's whole task list in the agent's order, sent whole on every change, because a provider
 * replaces its list rather than patching it. The list goes when the turn is interrupted and
 * returns with the next turn's list.
 */
export interface TurnTasksUpdate {
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The turn.
   */
  turnId: ProviderTurnId;
  /**
   * The tasks.
   */
  tasks: TurnTask[];
}

export {
  validateAgentTurnSubscribeRequest,
  validateProviderTurnId,
  validateTurnTask,
  validateTurnTaskState,
  validateTurnTasksUpdate,
  validateTurnUsageUpdate,
} from "./checks/turn.js";

/** The methods of {@link TURN_METHOD_DESCRIPTORS}, each with its checks. */
export interface TurnMethodDescriptors {
  readonly "agent.turn.usage.subscribe": {
    readonly method: "agent.turn.usage.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<AgentTurnSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<TurnUsageUpdate>;
  };
  readonly "agent.turn.task.subscribe": {
    readonly method: "agent.turn.task.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<AgentTurnSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<TurnTasksUpdate>;
  };
}
/** The running turn's two subscriptions, which follow one run's current turn. */
export const TURN_METHOD_DESCRIPTORS: TurnMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "agent.turn.usage.subscribe": /* @__PURE__ */ Object.freeze({
    method: "agent.turn.usage.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateAgentTurnSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateTurnUsageUpdate,
  }),
  "agent.turn.task.subscribe": /* @__PURE__ */ Object.freeze({
    method: "agent.turn.task.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateAgentTurnSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateTurnTasksUpdate,
  }),
});
