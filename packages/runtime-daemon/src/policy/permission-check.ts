// The permission check: the one in-process gate a sensitive action passes before it runs. What
// decides depends on what asks.
//
//   * A provider's permission ask takes no rule evaluation. The daemon's own designed answer
//     settles it first; then a rule in force on its subject: a block refuses it whatever it
//     offers; then the level's own allow of an ask its added ask rule sent; then the person's
//     approval of the card whose corrected command or path the ask carries out, taken once and
//     only on that card's run; then an allow in force, only where a standing allow may stand, so
//     a destructive git command or an ask the provider's own check flagged always reaches the
//     card. Every other ask raises a card, recorded before the check returns.
//   * A call of the app's own tools that its provider did not ask about is gated by the calling
//     session's level alone: at a level that asks it raises the ordinary card, and at Sandboxed
//     and YOLO it runs; a call whose run has no level to read is refused.
//   * A workflow start an agent or a trigger asks for is decided by the built-in rules, for the
//     machine's owning user, with the asking run's posture among what the rules read; an agent's
//     start whose run has no posture to read is refused, never judged as a trigger's.
//
// No method registers the check, since a check made over the wire ahead of the action could be
// stale by the time the action runs. Nothing is cached between checks: each one reads the rules,
// the posture and the owner afresh.

import type { ApprovalRequestId } from "@ai-sidekicks/contracts/approval";
import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId, UserId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";

import {
  deriveRuleSubject,
  describeProviderAsk,
  mayAllowStand,
} from "../approvals/ask-description.js";
import type { ApprovalRules } from "../approvals/rules.js";
import type { ApprovalService } from "../approvals/service.js";
import type {
  ProviderAskAction,
  ProviderAskRule,
  ProviderPermissionAsk,
} from "../provider/port/permission-ask.js";
import type { Authorizer } from "./authorizer.js";
import { answerProviderAsk } from "./provider-ask-answers.js";
import { checkWorkflowStart } from "./workflow-start.js";

/**
 * A provider's permission ask, under the id the daemon minted for it. `signal` aborts once the
 * provider takes the ask back, and an ask taken back before its card is raised raises none.
 */
export interface ProviderAskCheck {
  readonly kind: "provider_ask";
  readonly ask: ProviderPermissionAsk;
  readonly askId: string;
  readonly signal: AbortSignal;
}

/**
 * A workflow start an agent's workflow tool or a trigger asks for. `askingRunId` is the run of the
 * agent that called the tool, whose posture the rules read; a trigger's start names none.
 */
export interface WorkflowStartCheck {
  readonly kind: "workflow_start";
  readonly workflowId: WorkflowDefinitionId;
  readonly askingRunId: RunId | undefined;
}

/**
 * A call of one of the app's own tools its provider runs without asking first, as Codex runs the
 * daemon's tool server's, so the session's level is applied here.
 */
export interface ToolCallCheck {
  readonly kind: "tool_call";
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly toolName: string;
  /** The held call's id, which the card names so the call's row draws it held. */
  readonly toolCallId: string;
}

/** One action to decide, described by what asks for it. */
export type PermissionCheckRequest = ProviderAskCheck | ToolCallCheck | WorkflowStartCheck;

/**
 * What the check decided. The action runs on `policy_allow` (the daemon's own designed answer, or
 * a permit of the built-in rules), `remembered_rule` (an allow the session's own answers made,
 * named as `rule`) or `approved` (a person's recorded approval of the card whose corrected command
 * or path the ask carries out). It waits on `pending_approval`, naming the one request it raised,
 * and never runs on `denied`, whose `refusal` is the line the agent reads.
 */
export type PermissionCheckResponse =
  | { readonly allowed: true; readonly reason: "policy_allow" }
  | { readonly allowed: true; readonly reason: "approved" }
  | { readonly allowed: true; readonly reason: "remembered_rule"; readonly rule: ProviderAskRule }
  | {
      readonly allowed: false;
      readonly reason: "pending_approval";
      readonly approvalRequestId: ApprovalRequestId;
    }
  | { readonly allowed: false; readonly reason: "denied"; readonly refusal: string };

/** What a workflow start's check can answer: no start waits on a card. */
export type WorkflowStartCheckResponse = Extract<
  PermissionCheckResponse,
  { readonly reason: "policy_allow" | "denied" }
>;

/** What a tool call's check can answer: it runs, waits on its card, or is refused. */
export type ToolCallCheckResponse = Extract<
  PermissionCheckResponse,
  { readonly reason: "policy_allow" | "pending_approval" | "denied" }
>;

// The levels at which a call asks first; at Sandboxed and YOLO the level's posture answers it.
const ASKING_LEVELS: ReadonlySet<ExecutionPosture["mode"]> = new Set([
  "readonly",
  "ask",
  "reviewed",
]);

/** What the check reads its answers from and raises cards through. */
export interface PermissionCheckDeps {
  readonly authorizer: Authorizer;
  readonly approvals: Pick<ApprovalService, "create" | "takeCorrection">;
  readonly rules: Pick<ApprovalRules, "findRule">;
  /** The one all-projects agent-memory folder, whose notes an agent reads and writes unasked. */
  readonly agentMemoryFolder: string;
  /** The agent whose run holds an ask, which its card names as its asker. */
  readonly readRunAgent: (sessionId: SessionId, runId: RunId) => string;
  /** The machine's local owner, or `undefined` when it is registered under another user. */
  readonly readOwner: () => UserId | undefined;
  /** The posture a live run runs at, or `undefined` for a run past its end or never started. */
  readonly readPosture: (runId: RunId) => ExecutionPosture | undefined;
}

// What the agent reads when a rule in force blocks the subject its call names.
const BLOCKED_BY_RULE_REFUSAL = "A rule in force on this session blocks this.";

// What the agent reads when its call's run has no level to judge it by.
const NO_LEVEL_REFUSAL = "This call's run is not running, so it did not run.";

// What the agent reads when the built-in rules refuse its workflow start.
const WORKFLOW_START_REFUSAL = "The workflow rules on this machine refuse this start.";

/** The one gate every sensitive action passes before it runs. */
export class PermissionCheckService {
  readonly #deps: PermissionCheckDeps;

  constructor(deps: PermissionCheckDeps) {
    this.#deps = deps;
  }

  /**
   * Decides one action. A provider ask no answer settles raises its card, and the check resolves
   * once the card is recorded. Rejects with the signal's reason for an ask taken back before its
   * card was raised; with `approval.request_canceled` when its run or session has ended; with
   * `approval.persistence_unavailable` when the card, or a correction's one use, could not be
   * recorded, so the action does not proceed; and when a path the designed answers read cannot be
   * resolved.
   */
  async check(request: WorkflowStartCheck): Promise<WorkflowStartCheckResponse>;
  async check(request: ToolCallCheck): Promise<ToolCallCheckResponse>;
  async check(request: PermissionCheckRequest): Promise<PermissionCheckResponse>;
  async check(request: PermissionCheckRequest): Promise<PermissionCheckResponse> {
    switch (request.kind) {
      case "provider_ask":
        return await this.#checkProviderAsk(request);
      case "tool_call":
        return await this.#checkToolCall(request);
      case "workflow_start":
        return this.#checkWorkflowStart(request);
    }
  }

  async #checkToolCall(request: ToolCallCheck): Promise<ToolCallCheckResponse> {
    const posture = this.#deps.readPosture(request.runId);
    if (posture === undefined) {
      return { allowed: false, reason: "denied", refusal: NO_LEVEL_REFUSAL };
    }
    if (!ASKING_LEVELS.has(posture.mode)) {
      return { allowed: true, reason: "policy_allow" };
    }
    const action = { kind: "tool", toolName: request.toolName } as const;
    const { approvalRequestId } = await this.#deps.approvals.create(
      {
        sessionId: request.sessionId,
        runId: request.runId,
        requestedBy: this.#deps.readRunAgent(request.sessionId, request.runId),
        category: "tool_execution",
        scope: request.toolName,
        resourceDescriptor: {
          subject: request.toolName,
          standingAllowOffered: false,
          projectScopeOffered: false,
          editable: false,
          action,
          toolName: request.toolName,
        },
      },
      { toolCallId: request.toolCallId },
    );
    return { allowed: false, reason: "pending_approval", approvalRequestId };
  }

  async #checkProviderAsk(request: ProviderAskCheck): Promise<PermissionCheckResponse> {
    const { ask } = request;
    const designed = await answerProviderAsk(ask.action, this.#deps.agentMemoryFolder);
    if (designed !== undefined) {
      return designed.decision === "allow"
        ? { allowed: true, reason: "policy_allow" }
        : { allowed: false, reason: "denied", refusal: designed.reason };
    }
    const subject = deriveRuleSubject(ask.action);
    const rule =
      subject === undefined
        ? undefined
        : this.#deps.rules.findRule(ask.sessionId, ask.action.kind, subject);
    if (rule?.sense === "block") {
      return { allowed: false, reason: "denied", refusal: BLOCKED_BY_RULE_REFUSAL };
    }
    if (ask.isSentByLevelRule === true) {
      return { allowed: true, reason: "policy_allow" };
    }
    const correctedSubject = correctedSubjectOf(ask.action);
    if (
      ask.correctionOf !== undefined &&
      correctedSubject !== undefined &&
      (await this.#deps.approvals.takeCorrection(ask.correctionOf, {
        runId: ask.runId,
        correctedSubject,
      }))
    ) {
      return { allowed: true, reason: "approved" };
    }
    if (rule !== undefined && mayAllowStand(ask)) {
      return { allowed: true, reason: "remembered_rule", rule };
    }
    request.signal.throwIfAborted();
    const { approvalRequestId } = await this.#deps.approvals.create(
      {
        sessionId: ask.sessionId,
        runId: ask.runId,
        requestedBy: this.#deps.readRunAgent(ask.sessionId, ask.runId),
        ...describeProviderAsk(ask),
      },
      { askId: request.askId, toolCallId: ask.toolCallId },
    );
    return { allowed: false, reason: "pending_approval", approvalRequestId };
  }

  #checkWorkflowStart(request: WorkflowStartCheck): WorkflowStartCheckResponse {
    const posture =
      request.askingRunId === undefined ? undefined : this.#deps.readPosture(request.askingRunId);
    if (request.askingRunId !== undefined && posture === undefined) {
      return { allowed: false, reason: "denied", refusal: NO_LEVEL_REFUSAL };
    }
    const decision = checkWorkflowStart(this.#deps.authorizer, {
      owner: this.#deps.readOwner(),
      workflowId: request.workflowId,
      posture,
    });
    return decision.decision === "allow"
      ? { allowed: true, reason: "policy_allow" }
      : { allowed: false, reason: "denied", refusal: WORKFLOW_START_REFUSAL };
  }
}

// The command or path a corrected ask carries out, which its card's correction must name exactly.
function correctedSubjectOf(action: ProviderAskAction): string | undefined {
  switch (action.kind) {
    case "command":
      return action.command;
    case "file_read":
      return action.path;
    case "file_change":
      return action.paths.length === 1 ? action.paths[0] : undefined;
    default:
      return undefined;
  }
}
