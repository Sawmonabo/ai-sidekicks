// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The approval contract: answering an agent's ask, the pending asks, the remembered rules, allowing a reviewer's block once, and the `approval.*` event payloads.

import type { AgentId } from "./agent/definition.js";
import type { WireInstant } from "./internal/wire-scalars.js";
import type { MachineId } from "./machine/id.js";
import type { ToolCallId } from "./provider/tool-call.js";
import type { Sha256Hex } from "./release-manifest.js";
import type { RunId } from "./run/id.js";
import type { SessionId } from "./session/id.js";
import type { DeviceId } from "./trust-statement.js";
import type { WorkflowNodeId } from "./workflow/definition/document.js";
import type { WorkflowRunId } from "./workflow/run/id.js";

/** Every approval category, for the category each agent tool carries. */
export const APPROVAL_CATEGORIES = [
  "toolExecution",
  "fileWrite",
  "networkAccess",
  "destructiveGit",
  "gate",
] as const;

/**
 * The daemon-minted id of one ask.
 */
export type ApprovalRequestId = string & { readonly __brand: "ApprovalRequestId" };
/**
 * The id of one remembered rule: `approval.rule.list` names it and `approval.rule.revoke`
 * takes it.
 */
export type RememberedRuleId = string & { readonly __brand: "RememberedRuleId" };
/**
 * The daemon-minted id of one block by a provider's own reviewer.
 */
export type ReviewerDenialId = string & { readonly __brand: "ReviewerDenialId" };
/**
 * What holds an ask open: exactly one agent run or one workflow wait, by `kind`.
 */
export type ApprovalHolder =
  | {
      kind: "run";
      /**
       * The run.
       */
      runId: RunId;
    }
  | {
      kind: "wait";
      /**
       * The workflow run the wait belongs to.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The wait.
       */
      waitId: string;
      /**
       * The step's node; absent on a chain's question, which no step asks.
       */
      nodeId?: WorkflowNodeId;
    };
/**
 * What an ask is about. A plan, an agent's question and a tool server's question are not asks:
 * each is its own record, so none is a category here.
 */
export type ApprovalCategory =
  | "toolExecution"
  | "fileWrite"
  | "networkAccess"
  | "destructiveGit"
  | "gate";
/**
 * Where an ask stands. There is no expired state: an ask waits until it is answered, and the only
 * ends besides an answer cancel it with its run, its session or its provider process, or a
 * workflow wait's card with its wait.
 */
export type ApprovalState = "pending" | "approved" | "rejected" | "canceled";
/**
 * The person's answer to an ask.
 */
export type ApprovalDecision = "approved" | "rejected";
/**
 * A remembered rule's reach: this session, kept by the provider for the session, or every session
 * on this project, kept in the provider's own project rule file.
 */
export type RememberedScopeKind = "session" | "project";
/**
 * Whether a rule allows its subject or blocks it. A block is the remembered form of a network
 * decline: that host is refused with no card until the rule is replaced.
 */
export type RememberedRuleSense = "allow" | "block";
/**
 * Why `approval.resolutionInvalid` refused an answer: a block on an ask that is not a network
 * request, a rule the ask does not offer, a rule over other words than the subject the card named,
 * a scope other than the one asked, a correction on an ask whose command or path cannot be
 * corrected, or a correction and a rule together.
 */
export type ApprovalResolutionInvalidReason =
  | "blockOutsideNetworkAccess"
  | "ruleNotOffered"
  | "subjectMismatch"
  | "effectiveScopeBroader"
  | "editNotOffered"
  | "editWithRule";
/**
 * Why `approval.requestCanceled` refused a create: the run ended or the session closed.
 */
export type ApprovalLateCreateReason = "runEnded" | "sessionClosed";
/**
 * Why a rule ended: the person revoked it, its session ended, or its tool server was removed. A
 * project's rules live in the project's own folder and stay with it.
 */
export type InvalidationTrigger = "explicit" | "sessionEnd" | "serverRemoved";
/**
 * `approval.resolve`: one answer to an ask. A rule's sense agrees with the decision, only
 * a decline carries `declineReason`, and only an approval carries `editedAction`.
 */
export type ApprovalResolveRequest =
  | {
      decision: "approved";
      /**
       * The ask.
       */
      approvalRequestId: ApprovalRequestId;
      /**
       * Minted by the answering client and echoed on the resolution event, so the
       * device that settled the ask draws nothing and every other device draws that it
       * was answered elsewhere.
       */
      clientResolutionId: string;
      /**
       * Never broader than what was asked; defaults to the ask's own scope.
       */
      effectiveScope?: string;
      /**
       * Free-form audit members.
       */
      auditMetadata?: {
        [k: string]: unknown | undefined;
      };
      /**
       * The command or path as the person changed it on the card before approving: what goes
       * back to the provider and what the row records as having run.
       */
      editedAction?: string;
      /**
       * Never present: only a decline carries a reason.
       */
      declineReason?: never;
      /**
       * The rule to remember, an allow; absent for a one-time answer.
       */
      rememberedScope?: RememberedScope;
    }
  | {
      decision: "rejected";
      /**
       * The ask.
       */
      approvalRequestId: ApprovalRequestId;
      /**
       * Minted by the answering client and echoed on the resolution event, so the
       * device that settled the ask draws nothing and every other device draws that it
       * was answered elsewhere.
       */
      clientResolutionId: string;
      /**
       * Never broader than what was asked; defaults to the ask's own scope.
       */
      effectiveScope?: string;
      /**
       * Free-form audit members.
       */
      auditMetadata?: {
        [k: string]: unknown | undefined;
      };
      /**
       * The `why not` line, sent to the agent through the provider's own refusal field.
       */
      declineReason?: string;
      /**
       * Never present: only an approval carries an edited action.
       */
      editedAction?: never;
      /**
       * The rule to remember, a block; absent for a one-time answer.
       */
      rememberedScope?: RememberedScope;
    };
/**
 * One ask as the card draws it. A resolved ask carries `resolvedAt`, `decision`,
 * `deviceId` and `effectiveScope`, its decision is its state, and only it may carry a
 * minted rule, with the sense its decision gives; no other ask carries any of them. The
 * project scope is offered only beside a standing allow.
 */
export type ApprovalProjectionRow =
  | {
      state: "pending";
      /**
       * The ask.
       */
      id: ApprovalRequestId;
      /**
       * What holds it open: an agent run or a workflow wait.
       */
      holder: ApprovalHolder;
      /**
       * Who asked.
       */
      requestedBy: string;
      /**
       * What it is about.
       */
      category: ApprovalCategory;
      /**
       * Its target scope.
       */
      scope: string;
      /**
       * What it would touch, as the provider described it.
       */
      resourceDescriptor: {
        [k: string]: unknown | undefined;
      };
      /**
       * The subject the daemon derived from the ask: the words the standing-allow
       * button names.
       */
      subject: string;
      /**
       * The provider's own line saying why this action stopped, control characters and
       * escape codes stripped; absent where the provider sent none.
       */
      reason?: string;
      /**
       * False where the provider forbids a standing allow; the card then draws only
       * `Decline` and `Approve once`.
       */
      standingAllowOffered: boolean;
      /**
       * Whether that standing allow may also be written for the whole project: false
       * on a chat, which has no project, and on a workflow command step's ask, which no
       * provider relayed.
       */
      projectScopeOffered: boolean;
      /**
       * When it was raised.
       */
      createdAt: WireInstant;
      /**
       * When it last changed.
       */
      updatedAt: WireInstant;
      /**
       * Never present on an unresolved ask.
       */
      resolvedAt?: never;
      /**
       * Never present on an unresolved ask.
       */
      decision?: never;
      /**
       * Never present on an unresolved ask.
       */
      deviceId?: never;
      /**
       * Never present on an unresolved ask.
       */
      effectiveScope?: never;
      /**
       * Never present on an unresolved ask.
       */
      rememberedScope?: never;
    }
  | {
      state: "canceled";
      /**
       * The ask.
       */
      id: ApprovalRequestId;
      /**
       * What holds it open: an agent run or a workflow wait.
       */
      holder: ApprovalHolder;
      /**
       * Who asked.
       */
      requestedBy: string;
      /**
       * What it is about.
       */
      category: ApprovalCategory;
      /**
       * Its target scope.
       */
      scope: string;
      /**
       * What it would touch, as the provider described it.
       */
      resourceDescriptor: {
        [k: string]: unknown | undefined;
      };
      /**
       * The subject the daemon derived from the ask: the words the standing-allow
       * button names.
       */
      subject: string;
      /**
       * The provider's own line saying why this action stopped, control characters and
       * escape codes stripped; absent where the provider sent none.
       */
      reason?: string;
      /**
       * False where the provider forbids a standing allow; the card then draws only
       * `Decline` and `Approve once`.
       */
      standingAllowOffered: boolean;
      /**
       * Whether that standing allow may also be written for the whole project: false
       * on a chat, which has no project, and on a workflow command step's ask, which no
       * provider relayed.
       */
      projectScopeOffered: boolean;
      /**
       * When it was raised.
       */
      createdAt: WireInstant;
      /**
       * When it last changed.
       */
      updatedAt: WireInstant;
      /**
       * Never present on an unresolved ask.
       */
      resolvedAt?: never;
      /**
       * Never present on an unresolved ask.
       */
      decision?: never;
      /**
       * Never present on an unresolved ask.
       */
      deviceId?: never;
      /**
       * Never present on an unresolved ask.
       */
      effectiveScope?: never;
      /**
       * Never present on an unresolved ask.
       */
      rememberedScope?: never;
    }
  | {
      state: "approved";
      /**
       * The ask.
       */
      id: ApprovalRequestId;
      /**
       * What holds it open: an agent run or a workflow wait.
       */
      holder: ApprovalHolder;
      /**
       * Who asked.
       */
      requestedBy: string;
      /**
       * What it is about.
       */
      category: ApprovalCategory;
      /**
       * Its target scope.
       */
      scope: string;
      /**
       * What it would touch, as the provider described it.
       */
      resourceDescriptor: {
        [k: string]: unknown | undefined;
      };
      /**
       * The subject the daemon derived from the ask: the words the standing-allow
       * button names.
       */
      subject: string;
      /**
       * The provider's own line saying why this action stopped, control characters and
       * escape codes stripped; absent where the provider sent none.
       */
      reason?: string;
      /**
       * False where the provider forbids a standing allow; the card then draws only
       * `Decline` and `Approve once`.
       */
      standingAllowOffered: boolean;
      /**
       * Whether that standing allow may also be written for the whole project: false
       * on a chat, which has no project, and on a workflow command step's ask, which no
       * provider relayed.
       */
      projectScopeOffered: boolean;
      /**
       * When it was raised.
       */
      createdAt: WireInstant;
      /**
       * When it last changed.
       */
      updatedAt: WireInstant;
      /**
       * When it was answered.
       */
      resolvedAt: WireInstant;
      /**
       * Always `approved`.
       */
      decision: "approved";
      /**
       * The device that answered.
       */
      deviceId: DeviceId;
      /**
       * The recorded scope.
       */
      effectiveScope: string;
      /**
       * The rule the answer minted, an allow.
       */
      rememberedScope?: RememberedScope;
    }
  | {
      state: "rejected";
      /**
       * The ask.
       */
      id: ApprovalRequestId;
      /**
       * What holds it open: an agent run or a workflow wait.
       */
      holder: ApprovalHolder;
      /**
       * Who asked.
       */
      requestedBy: string;
      /**
       * What it is about.
       */
      category: ApprovalCategory;
      /**
       * Its target scope.
       */
      scope: string;
      /**
       * What it would touch, as the provider described it.
       */
      resourceDescriptor: {
        [k: string]: unknown | undefined;
      };
      /**
       * The subject the daemon derived from the ask: the words the standing-allow
       * button names.
       */
      subject: string;
      /**
       * The provider's own line saying why this action stopped, control characters and
       * escape codes stripped; absent where the provider sent none.
       */
      reason?: string;
      /**
       * False where the provider forbids a standing allow; the card then draws only
       * `Decline` and `Approve once`.
       */
      standingAllowOffered: boolean;
      /**
       * Whether that standing allow may also be written for the whole project: false
       * on a chat, which has no project, and on a workflow command step's ask, which no
       * provider relayed.
       */
      projectScopeOffered: boolean;
      /**
       * When it was raised.
       */
      createdAt: WireInstant;
      /**
       * When it last changed.
       */
      updatedAt: WireInstant;
      /**
       * When it was answered.
       */
      resolvedAt: WireInstant;
      /**
       * Always `rejected`.
       */
      decision: "rejected";
      /**
       * The device that answered.
       */
      deviceId: DeviceId;
      /**
       * The recorded scope.
       */
      effectiveScope: string;
      /**
       * The rule the answer minted, a block.
       */
      rememberedScope?: RememberedScope;
    };

/**
 * The rule a resolution mints. `pattern` is the subject the daemon derived from the ask and the
 * card's button showed: a command's program and first subcommand, a network request's host, a
 * written file's name. The client echoes what it showed, and the daemon refuses an echo that
 * differs from its own derivation, so a rule never covers more than the words the person pressed.
 */
export interface RememberedScope {
  /**
   * Its reach.
   */
  kind: RememberedScopeKind;
  /**
   * Its subject.
   */
  pattern: string;
  /**
   * Whether it allows or blocks.
   */
  sense: RememberedRuleSense;
}
/**
 * What an answer settled: the device that answered, the recorded scope and the time.
 */
export interface ApprovalResolveResponse {
  /**
   * The ask.
   */
  approvalRequestId: ApprovalRequestId;
  /**
   * Where it now stands.
   */
  state: ApprovalState;
  /**
   * The device that answered.
   */
  deviceId: DeviceId;
  /**
   * The recorded scope.
   */
  effectiveScope: string;
  /**
   * When.
   */
  resolvedAt: WireInstant;
}
/**
 * `approval.list`: the session's asks, optionally narrowed by state or category.
 */
export interface ApprovalListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Only asks in this state.
   */
  state?: ApprovalState;
  /**
   * Only asks of this category.
   */
  category?: ApprovalCategory;
}
/**
 * The session's asks.
 */
export interface ApprovalListResponse {
  /**
   * The asks.
   */
  approvals: ApprovalProjectionRow[];
}
/**
 * `approval.rule.list`: the rules in force on one session, its own and its project's.
 */
export interface ApprovalRuleListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One rule in force, as the inspector's row reads it: what it does, and the derived subject and
 * the scope in words.
 */
export interface RememberedRule {
  /**
   * The rule.
   */
  ruleId: RememberedRuleId;
  /**
   * What it is about.
   */
  category: ApprovalCategory;
  /**
   * Its reach, subject and sense.
   */
  scope: RememberedScope;
  /**
   * When it was granted.
   */
  grantedAt: WireInstant;
}
/**
 * The rules in force.
 */
export interface ApprovalRuleListResponse {
  /**
   * The rules.
   */
  rules: RememberedRule[];
}
/**
 * `approval.rule.revoke`: revokes one rule; a project rule's revoke removes it from the provider's
 * project rule file.
 */
export interface ApprovalRuleRevokeRequest {
  /**
   * The rule.
   */
  ruleId: RememberedRuleId;
}
/**
 * A revocation's receipt. A revocation through this call is always `explicit`.
 */
export interface ApprovalRuleRevokeResponse {
  /**
   * The rule.
   */
  ruleId: RememberedRuleId;
  /**
   * When.
   */
  revokedAt: WireInstant;
  /**
   * Always `explicit`.
   */
  invalidationTrigger: "explicit";
}
/**
 * `approval.denial.override`: allows once an action the provider's own reviewer blocked. The
 * daemon tells the agent it may retry that one action, by each provider's own means; the agent
 * decides whether to retry. A press on a block already allowed is answered with the settled
 * override and sends nothing a second time.
 */
export interface ApprovalDenialOverrideRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The block.
   */
  denialId: ReviewerDenialId;
}
/**
 * When the block was allowed once, the first time it was.
 */
export interface ApprovalDenialOverrideResponse {
  /**
   * The block.
   */
  denialId: ReviewerDenialId;
  /**
   * When it was allowed.
   */
  overriddenAt: WireInstant;
}
/**
 * The `approval.requested` payload. `holder` names the agent run whose action it gates or the
 * workflow wait that asks. `askId` is present when the request is a provider's
 * permission ask: the daemon's own durable id for the ask, so an answer reaches the right ask
 * after a restart when several are open on one run. `toolCallId` names the tool call the ask
 * holds, so that call's row draws its held mark and `Declined`; `inputDigest` fingerprints the
 * call's tool name and input. The ask's tool name and the provider's prompt text ride
 * `resourceDescriptor`.
 */
export interface ApprovalRequestedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * What holds it open: an agent run or a workflow wait.
   */
  holder: ApprovalHolder;
  /**
   * The ask.
   */
  approvalRequestId: ApprovalRequestId;
  /**
   * What it is about.
   */
  category: ApprovalCategory;
  /**
   * Its target scope.
   */
  scope: string;
  /**
   * Who asked.
   */
  requestedBy: string;
  /**
   * What it would touch.
   */
  resourceDescriptor: {
    [k: string]: unknown | undefined;
  };
  /**
   * The daemon's durable id for a provider's permission ask.
   */
  askId?: string;
  /**
   * The tool call the ask holds, bounded as the tool rows bound it.
   */
  toolCallId?: ToolCallId;
  /**
   * The SHA-256 of the asked call's tool name and input as canonical JSON, by which a call made
   * again after a restart finds this card; absent where the input has no canonical form or the
   * card has no call.
   */
  inputDigest?: Sha256Hex;
}
/**
 * The `approval.approved` and `approval.rejected` payload: the answer, the device it came from,
 * the id the answering client minted, on an approval the command or path as the person corrected
 * it, and on a decline the words the person gave.
 */
export interface ApprovalResolvedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * What held it open.
   */
  holder: ApprovalHolder;
  /**
   * The ask.
   */
  approvalRequestId: ApprovalRequestId;
  /**
   * What it is about.
   */
  category: ApprovalCategory;
  /**
   * Its target scope.
   */
  scope: string;
  /**
   * The recorded scope.
   */
  effectiveScope: string;
  /**
   * The device that answered.
   */
  deviceId: DeviceId;
  /**
   * The id the answering client minted.
   */
  clientResolutionId: string;
  /**
   * The rule the person asked to keep with the answer, so a rebuild and a resend record the
   * rule asked for even when its own event was never written.
   */
  rememberedScope?: RememberedScope;
  /**
   * The `why not` words, which go back to the agent; only on `approval.rejected`.
   */
  declineReason?: string;
  /**
   * The corrected command or path, which is what runs; only on `approval.approved`.
   */
  editedAction?: string;
}
/**
 * The `approval.canceled` payload: the ask ended unanswered with its run, its session, its
 * provider's take-back or its workflow wait, and can no longer be answered.
 */
export interface ApprovalCanceledPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * What held it open.
   */
  holder: ApprovalHolder;
  /**
   * The ask.
   */
  approvalRequestId: ApprovalRequestId;
  /**
   * What it was about.
   */
  category: ApprovalCategory;
  /**
   * Its target scope.
   */
  scope: string;
}
/**
 * The `approval.rule.remembered` payload: the whole rule, so it rebuilds from the log.
 * `machineId` is the machine whose provider keeps it.
 */
export interface ApprovalRuleRememberedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The ask.
   */
  approvalRequestId: ApprovalRequestId;
  /**
   * What it is about.
   */
  category: ApprovalCategory;
  /**
   * Its target scope.
   */
  scope: string;
  /**
   * The machine whose provider keeps the rule.
   */
  machineId: MachineId;
  /**
   * The rule.
   */
  ruleId: RememberedRuleId;
  /**
   * Its reach, subject and sense.
   */
  rememberedScope: RememberedScope;
}
/**
 * The `approval.rule.revoked` payload. The run and the ask are absent where no ask was in flight,
 * as when a project is detached or a tool server is removed.
 */
export interface ApprovalRuleRevokedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * What it was about.
   */
  category: ApprovalCategory;
  /**
   * Its target scope.
   */
  scope: string;
  /**
   * The rule.
   */
  ruleId: RememberedRuleId;
  /**
   * Why it ended.
   */
  invalidationTrigger: InvalidationTrigger;
  /**
   * The run, where an ask was in flight.
   */
  runId?: RunId;
  /**
   * The ask, where one was in flight.
   */
  approvalRequestId?: ApprovalRequestId;
}
/**
 * The `approval.reviewer.denied` payload: a provider's own reviewer blocked an action. The daemon
 * keeps the denial whole beside the row, which is what lets the override hold across a restart.
 * `eventId` names the blocked call's own row, whose reason line reads `Blocked · <reason>`, or
 * `Blocked` alone where the reviewer gave no reason; a block that names no call, such as a review
 * of a network request, has none and is a row of its own. `overridable` is false where the
 * provider lets no person overrule the block, and no `Allow once` is drawn.
 */
export interface ApprovalReviewerDeniedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The agent whose action was blocked.
   */
  agentId: AgentId;
  /**
   * The block.
   */
  denialId: ReviewerDenialId;
  /**
   * The blocked call's own row; absent on a block that names no call.
   */
  eventId?: string;
  /**
   * The reviewer's reason.
   */
  reason?: string;
  /**
   * Whether a person may overrule it.
   */
  overridable: boolean;
}
/**
 * The `approval.denial.overridden` payload: the person allowed a blocked action once.
 */
export interface ApprovalDenialOverriddenPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The block.
   */
  denialId: ReviewerDenialId;
}

export {
  validateApprovalCanceledPayload,
  validateApprovalCategory,
  validateApprovalDecision,
  validateApprovalDenialOverriddenPayload,
  validateApprovalHolder,
  validateApprovalProjectionRow,
  validateApprovalRequestId,
  validateApprovalRequestedPayload,
  validateApprovalResolveRequest,
  validateApprovalResolvedPayload,
  validateApprovalReviewerDeniedPayload,
  validateApprovalRuleRememberedPayload,
  validateApprovalRuleRevokedPayload,
  validateInvalidationTrigger,
  validateRememberedRule,
  validateRememberedRuleId,
  validateRememberedRuleSense,
  validateRememberedScope,
  validateRememberedScopeKind,
  validateReviewerDenialId,
} from "./checks/approval.js";

/** The methods of {@link APPROVAL_METHOD_DESCRIPTORS}, each with its kind. */
export interface ApprovalMethodDescriptors {
  readonly "approval.resolve": {
    readonly method: "approval.resolve";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "approval.list": {
    readonly method: "approval.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "approval.rule.list": {
    readonly method: "approval.rule.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "approval.rule.revoke": {
    readonly method: "approval.rule.revoke";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "approval.denial.override": {
    readonly method: "approval.denial.override";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link APPROVAL_METHOD_DESCRIPTORS}. */
export interface ApprovalMethodTypes {
  readonly "approval.resolve": {
    readonly params: ApprovalResolveRequest;
    readonly result: ApprovalResolveResponse;
  };
  readonly "approval.list": {
    readonly params: ApprovalListRequest;
    readonly result: ApprovalListResponse;
  };
  readonly "approval.rule.list": {
    readonly params: ApprovalRuleListRequest;
    readonly result: ApprovalRuleListResponse;
  };
  readonly "approval.rule.revoke": {
    readonly params: ApprovalRuleRevokeRequest;
    readonly result: ApprovalRuleRevokeResponse;
  };
  readonly "approval.denial.override": {
    readonly params: ApprovalDenialOverrideRequest;
    readonly result: ApprovalDenialOverrideResponse;
  };
}
/** The `approval.*` methods a client calls. */
export const APPROVAL_METHOD_DESCRIPTORS: ApprovalMethodDescriptors = /* @__PURE__ */ Object.freeze(
  {
    "approval.resolve": /* @__PURE__ */ Object.freeze({
      method: "approval.resolve",
      procedureType: "mutation",
      mutating: true,
    }),
    "approval.list": /* @__PURE__ */ Object.freeze({
      method: "approval.list",
      procedureType: "query",
      mutating: false,
    }),
    "approval.rule.list": /* @__PURE__ */ Object.freeze({
      method: "approval.rule.list",
      procedureType: "query",
      mutating: false,
    }),
    "approval.rule.revoke": /* @__PURE__ */ Object.freeze({
      method: "approval.rule.revoke",
      procedureType: "mutation",
      mutating: true,
    }),
    "approval.denial.override": /* @__PURE__ */ Object.freeze({
      method: "approval.denial.override",
      procedureType: "mutation",
      mutating: true,
    }),
  },
);
