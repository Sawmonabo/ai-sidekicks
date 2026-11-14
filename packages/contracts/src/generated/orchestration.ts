// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The session's agent tree as a client reads it, run admission under an agent and its refusal record, and their two methods, `agent.run.create` and `agent.childRunLink.list`.

import type { SchemaCheck } from "../schema-check.js";
import type { AgentDefinitionId, AgentId } from "./agent/definition.js";
import type { AgentTreeMember, ChildHandle } from "./agent/tree.js";
import {
  validateAgentChildRunLinkListRequest,
  validateAgentChildRunLinkListResponse,
  validateAgentRunCreateRequest,
  validateAgentRunCreateResponse,
} from "./checks/orchestration.js";
import {
  validateSessionBudgetReadRequest,
  validateSessionBudgetState,
  validateSessionCostReceipt,
  validateSessionCostReceiptReadRequest,
} from "./checks/session/cost.js";
import type { WireInstant } from "./internal/wire-scalars.js";
import type { RunId } from "./run/id.js";
import type { RunState } from "./run/state.js";
import type {
  SessionBudgetReadRequest,
  SessionBudgetState,
  SessionCostReceipt,
  SessionCostReceiptReadRequest,
  TokensPerRun,
  UsdMicros,
} from "./session/cost.js";
import type { SessionId } from "./session/id.js";

/**
 * Why the daemon itself interrupted a run: a step or spend limit the person set was reached, the
 * run's workflow phase was canceled, the daemon restarted under the run, or the person stopped the
 * service while the run was live. The person's own interrupt has none.
 */
export type InterruptReason =
  | "stepLimit"
  | "spendLimit"
  | "workflowPhaseCanceled"
  | "daemonRestart"
  | "daemonStop";
/**
 * `agent.run.create`: admits a run under an agent, called by the daemon's own paths and
 * the SDK, never by a screen control. No count limits admission or depth: a refusal is the
 * provider's own or an unresolved target. It names exactly one target.
 */
export type AgentRunCreateRequest =
  | {
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The agent.
       */
      targetAgentId: AgentId;
      /**
       * The key that makes a repeated create one run.
       */
      clientIdempotencyKey: string;
      /**
       * The run the new run is a child of.
       */
      parentRunId?: RunId;
      /**
       * The run's limits, over the session's defaults.
       */
      config?: OrchestrationRunConfig;
    }
  | {
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The definition.
       */
      targetDefinitionId: AgentDefinitionId;
      /**
       * The key that makes a repeated create one run.
       */
      clientIdempotencyKey: string;
      /**
       * The run the new run is a child of.
       */
      parentRunId?: RunId;
      /**
       * The run's limits, over the session's defaults.
       */
      config?: OrchestrationRunConfig;
    };
/**
 * One child in the tree: a run of its own under an agent, linked to exactly one parent run, or a
 * provider's own helper inside its parent's run, addressed by its handle. No run is its own
 * parent.
 */
export type ChildRunLink =
  | {
      kind: "run";
      /**
       * The child run.
       */
      childRunId: RunId;
      /**
       * Its parent run; never the child itself.
       */
      parentRunId: RunId;
      /**
       * The agent it runs under.
       */
      agentId: AgentId;
      /**
       * Its state.
       */
      state: RunState;
      /**
       * Its head.
       */
      head: ChildRunHead;
    }
  | {
      kind: "providerChild";
      /**
       * The run it runs in.
       */
      runId: RunId;
      /**
       * Its handle.
       */
      childHandle: ChildHandle;
      /**
       * The helper it is a child of, when it is not the run's own.
       */
      parentChildHandle?: ChildHandle;
      /**
       * Its state.
       */
      state: RunState;
      /**
       * Its head.
       */
      head: ChildRunHead;
    };

/**
 * A run's own limits: `tokenLimit` is its `Tokens per run`, input and output together, absent
 * meaning unlimited. A request's override, and the value admission resolves and keeps on the
 * run's creation record.
 */
export interface OrchestrationRunConfig {
  /**
   * The run's token limit.
   */
  tokenLimit?: TokensPerRun;
}
/**
 * The admitted run.
 */
export interface AgentRunCreateResponse {
  /**
   * The run.
   */
  runId: RunId;
  /**
   * Its state.
   */
  state: RunState;
  /**
   * Its parent run.
   */
  parentRunId?: RunId;
}
/**
 * The `agent.run.rejected` payload: a run create admission refused. It names no run, because
 * a refusal leaves none. `reason` is the refusing error code, and `detail` its words.
 */
export interface AgentRunRejectedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The agent the run was aimed at.
   */
  targetAgentId?: AgentId;
  /**
   * The run it would have been a child of.
   */
  parentRunId?: RunId;
  /**
   * The refusing error code.
   */
  reason: string;
  /**
   * Its words.
   */
  detail?: string;
}
/**
 * `agent.childRunLink.list`: the session whose whole tree is read.
 */
export interface AgentChildRunLinkListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * What a child's head reads after its name: the model, the effort as one word, the agent that
 * was asked where the child was a peer call, its tokens and spend, when it started, and its
 * ancestry from the lead down to its parent.
 */
export interface ChildRunHead {
  /**
   * The model.
   */
  modelId: string;
  /**
   * The effort, as one word.
   */
  effort?: string;
  /**
   * The agent that was asked, where the child was a peer call.
   */
  viaAgentName?: string;
  /**
   * Its tokens.
   */
  tokens: number;
  /**
   * Its spend.
   */
  spendUsdMicros: UsdMicros;
  /**
   * When it started.
   */
  startedAt: WireInstant;
  /**
   * Its ancestry, from the lead down to its parent.
   *
   * @minItems 1
   */
  ancestry: [AgentTreeMember, ...AgentTreeMember[]];
}
/**
 * A child run the daemon refused to create, folded from the session's refusal events. A refusal
 * leaves no run, queue item or link, so this fold is the only record of work that was asked for
 * and denied. `reason` is the refusing error code.
 */
export interface ChildRunRejection {
  /**
   * The run it would have been a child of.
   */
  parentRunId: RunId;
  /**
   * The agent it was aimed at.
   */
  targetAgentId?: AgentId;
  /**
   * The refusing error code.
   */
  reason: string;
  /**
   * Its words.
   */
  detail?: string;
  /**
   * When it was refused.
   */
  occurredAt: WireInstant;
}
/**
 * The agents badge's figures, supplied by the daemon because the screen may hold only part of
 * the list: the children running now, the children dispatched in all, and the children waiting
 * on an approval. Neither the live nor the waiting count exceeds the total.
 */
export interface ChildRunCounts {
  /**
   * The children running now.
   */
  live: number;
  /**
   * The children dispatched in all.
   */
  total: number;
  /**
   * The children waiting on an approval.
   */
  waiting: number;
}
/**
 * The whole tree, the badge's figures, and the refused creates.
 */
export interface AgentChildRunLinkListResponse {
  /**
   * The tree.
   */
  children: ChildRunLink[];
  /**
   * The badge's figures.
   */
  counts: ChildRunCounts;
  /**
   * The refused creates.
   */
  rejectedCreates: ChildRunRejection[];
}

export {
  validateAgentChildRunLinkListRequest,
  validateAgentChildRunLinkListResponse,
  validateAgentRunCreateRequest,
  validateAgentRunCreateResponse,
  validateAgentRunRejectedPayload,
  validateChildRunCounts,
  validateChildRunHead,
  validateChildRunLink,
  validateChildRunRejection,
  validateInterruptReason,
  validateOrchestrationRunConfig,
} from "./checks/orchestration.js";

/** The methods of {@link ORCHESTRATION_METHOD_DESCRIPTORS}, each with its checks. */
export interface OrchestrationMethodDescriptors {
  readonly "agent.run.create": {
    readonly method: "agent.run.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AgentRunCreateRequest>;
    readonly responseCheck: SchemaCheck<AgentRunCreateResponse>;
  };
  readonly "agent.childRunLink.list": {
    readonly method: "agent.childRunLink.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<AgentChildRunLinkListRequest>;
    readonly responseCheck: SchemaCheck<AgentChildRunLinkListResponse>;
  };
  readonly "session.budget.read": {
    readonly method: "session.budget.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionBudgetReadRequest>;
    readonly responseCheck: SchemaCheck<SessionBudgetState>;
  };
  readonly "session.costReceipt.read": {
    readonly method: "session.costReceipt.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionCostReceiptReadRequest>;
    readonly responseCheck: SchemaCheck<SessionCostReceipt>;
  };
}
/**
 * The agent tree's read and run admission. The client re-reads the tree on each child
 * started or completed, run queued, create refused and run state change.
 */
export const ORCHESTRATION_METHOD_DESCRIPTORS: OrchestrationMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "agent.run.create": /* @__PURE__ */ Object.freeze({
      method: "agent.run.create",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateAgentRunCreateRequest,
      responseCheck: validateAgentRunCreateResponse,
    }),
    "agent.childRunLink.list": /* @__PURE__ */ Object.freeze({
      method: "agent.childRunLink.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateAgentChildRunLinkListRequest,
      responseCheck: validateAgentChildRunLinkListResponse,
    }),
    "session.budget.read": /* @__PURE__ */ Object.freeze({
      method: "session.budget.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateSessionBudgetReadRequest,
      responseCheck: validateSessionBudgetState,
    }),
    "session.costReceipt.read": /* @__PURE__ */ Object.freeze({
      method: "session.costReceipt.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateSessionCostReceiptReadRequest,
      responseCheck: validateSessionCostReceipt,
    }),
  });
