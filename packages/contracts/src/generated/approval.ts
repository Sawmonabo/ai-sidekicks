// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The approval contract: answering an agent's ask, the pending asks, the remembered rules, allowing a reviewer's block once, and the `approval.*` event payloads.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../schema-check.js";
import { type AgentId, validateAgentId } from "./agent/definition.js";
import { type WireInstant, validateWireInstant } from "./internal/wire-scalars.js";
import { type MachineId, validateMachineId } from "./machine/id.js";
import { type ToolCallId, validateToolCallId } from "./provider/tool-call.js";
import { type Sha256Hex, validateSha256Hex } from "./release-manifest.js";
import { type RunId, validateRunId } from "./run/id.js";
import { type SessionId, validateSessionId } from "./session/id.js";
import { type DeviceId, validateDeviceId } from "./trust-statement.js";
import { type WorkflowNodeId, validateWorkflowNodeId } from "./workflow/definition/document.js";
import { type WorkflowRunId, validateWorkflowRunId } from "./workflow/run/id.js";

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

// prettier-ignore
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link ApprovalRequestId}. */
// prettier-ignore
export const validateApprovalRequestId: CompiledSchemaCheck<ApprovalRequestId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalRequestId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalRequestId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateApprovalRequestId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateApprovalRequestId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateApprovalRequestId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalRequestId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RememberedRuleId}. */
// prettier-ignore
export const validateRememberedRuleId: CompiledSchemaCheck<RememberedRuleId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RememberedRuleId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRememberedRuleId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateRememberedRuleId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateRememberedRuleId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateRememberedRuleId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRememberedRuleId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ReviewerDenialId}. */
// prettier-ignore
export const validateReviewerDenialId: CompiledSchemaCheck<ReviewerDenialId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ReviewerDenialId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateReviewerDenialId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateReviewerDenialId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateReviewerDenialId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateReviewerDenialId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateReviewerDenialId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link ApprovalHolder}. */
// prettier-ignore
export const validateApprovalHolder: CompiledSchemaCheck<ApprovalHolder> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalHolder {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalHolder.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "run"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.runId === undefined) && (missing0 = "runId"))){validateApprovalHolder.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "kind") || (key0 === "runId"))){validateApprovalHolder.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validateApprovalHolder.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("run" !== data0){validateApprovalHolder.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "run"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.runId !== undefined){const _errs7: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validateApprovalHolder.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "wait"){const _errs8: any = errors;if(errors === _errs8){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.kind === undefined) && (missing1 = "kind")) || ((data.workflowRunId === undefined) && (missing1 = "workflowRunId"))) || ((data.waitId === undefined) && (missing1 = "waitId"))){validateApprovalHolder.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs10: any = errors;for(const key1 in data){if(!((((key1 === "kind") || (key1 === "workflowRunId")) || (key1 === "waitId")) || (key1 === "nodeId"))){validateApprovalHolder.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs10 === errors){if(data.kind !== undefined){let data2: any = data.kind;const _errs11: any = errors;if(typeof data2 !== "string"){validateApprovalHolder.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("wait" !== data2){validateApprovalHolder.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "wait"}}];return false;}var valid4: any = _errs11 === errors;}else {var valid4: any = true;}if(valid4){if(data.workflowRunId !== undefined){const _errs13: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}if(valid4){if(data.waitId !== undefined){let data4: any = data.waitId;const _errs14: any = errors;if(errors === _errs14){if(typeof data4 === "string"){if(!pattern3.test(data4)){validateApprovalHolder.errors = [{instancePath:instancePath+"/waitId",schemaPath:"#/oneOf/1/properties/waitId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateApprovalHolder.errors = [{instancePath:instancePath+"/waitId",schemaPath:"#/oneOf/1/properties/waitId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}if(valid4){if(data.nodeId !== undefined){const _errs16: any = errors;if(!(validateWorkflowNodeId.call(this, data.nodeId, {instancePath:instancePath+"/nodeId",parentData:data,parentDataProperty:"nodeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid4: any = _errs16 === errors;}else {var valid4: any = true;}}}}}}}else {validateApprovalHolder.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs8 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateApprovalHolder.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateApprovalHolder.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateApprovalHolder.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateApprovalHolder.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalHolder.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalHolder.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema92: any = {"description":"What an ask is about. A plan, an agent's question and a tool server's question are not asks:\neach is its own record, so none is a category here.","type":"string","enum":["toolExecution","fileWrite","networkAccess","destructiveGit","gate"]};
/** Checks that a value is a {@link ApprovalCategory}. */
// prettier-ignore
export const validateApprovalCategory: CompiledSchemaCheck<ApprovalCategory> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalCategory {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalCategory.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateApprovalCategory.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data === "toolExecution") || (data === "fileWrite")) || (data === "networkAccess")) || (data === "destructiveGit")) || (data === "gate"))){validateApprovalCategory.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema92.enum}}];return false;}validateApprovalCategory.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalCategory.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema99: any = {"description":"Where an ask stands. There is no expired state: an ask waits until it is answered, and the only\nends besides an answer cancel it with its run, its session or its provider process, or a\nworkflow wait's card with its wait.","type":"string","enum":["pending","approved","rejected","canceled"]};
/** Checks that a value is a {@link ApprovalState}. */
// prettier-ignore
export const validateApprovalState: CompiledSchemaCheck<ApprovalState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateApprovalState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "pending") || (data === "approved")) || (data === "rejected")) || (data === "canceled"))){validateApprovalState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema99.enum}}];return false;}validateApprovalState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema93: any = {"description":"The person's answer to an ask.","type":"string","enum":["approved","rejected"]};
/** Checks that a value is a {@link ApprovalDecision}. */
// prettier-ignore
export const validateApprovalDecision: CompiledSchemaCheck<ApprovalDecision> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalDecision {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalDecision.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateApprovalDecision.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "approved") || (data === "rejected"))){validateApprovalDecision.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema93.enum}}];return false;}validateApprovalDecision.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalDecision.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema103: any = {"description":"A remembered rule's reach: this session, kept by the provider for the session, or every session\non this project, kept in the provider's own project rule file.","type":"string","enum":["session","project"]};
/** Checks that a value is a {@link RememberedScopeKind}. */
// prettier-ignore
export const validateRememberedScopeKind: CompiledSchemaCheck<RememberedScopeKind> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RememberedScopeKind {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRememberedScopeKind.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateRememberedScopeKind.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "session") || (data === "project"))){validateRememberedScopeKind.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema103.enum}}];return false;}validateRememberedScopeKind.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRememberedScopeKind.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema104: any = {"description":"Whether a rule allows its subject or blocks it. A block is the remembered form of a network\ndecline: that host is refused with no card until the rule is replaced.","type":"string","enum":["allow","block"]};
/** Checks that a value is a {@link RememberedRuleSense}. */
// prettier-ignore
export const validateRememberedRuleSense: CompiledSchemaCheck<RememberedRuleSense> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RememberedRuleSense {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRememberedRuleSense.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateRememberedRuleSense.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "allow") || (data === "block"))){validateRememberedRuleSense.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema104.enum}}];return false;}validateRememberedRuleSense.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRememberedRuleSense.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema120: any = {"description":"Why a rule ended: the person revoked it, its session ended, or its tool server was removed. A\nproject's rules live in the project's own folder and stay with it.","type":"string","enum":["explicit","sessionEnd","serverRemoved"]};
/** Checks that a value is a {@link InvalidationTrigger}. */
// prettier-ignore
export const validateInvalidationTrigger: CompiledSchemaCheck<InvalidationTrigger> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is InvalidationTrigger {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateInvalidationTrigger.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateInvalidationTrigger.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "explicit") || (data === "sessionEnd")) || (data === "serverRemoved"))){validateInvalidationTrigger.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema120.enum}}];return false;}validateInvalidationTrigger.errors = vErrors;return errors === 0;};
// prettier-ignore
validateInvalidationTrigger.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RememberedScope}. */
// prettier-ignore
export const validateRememberedScope: CompiledSchemaCheck<RememberedScope> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RememberedScope {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRememberedScope.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.kind === undefined) && (missing0 = "kind")) || ((data.pattern === undefined) && (missing0 = "pattern"))) || ((data.sense === undefined) && (missing0 = "sense"))){validateRememberedScope.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "kind") || (key0 === "pattern")) || (key0 === "sense"))){validateRememberedScope.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.kind !== undefined){const _errs2: any = errors;if(!(validateRememberedScopeKind.call(this, data.kind, {instancePath:instancePath+"/kind",parentData:data,parentDataProperty:"kind",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRememberedScopeKind.errors : vErrors.concat(validateRememberedScopeKind.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pattern !== undefined){let data1: any = data.pattern;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) < 1){validateRememberedScope.errors = [{instancePath:instancePath+"/pattern",schemaPath:"#/properties/pattern/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateRememberedScope.errors = [{instancePath:instancePath+"/pattern",schemaPath:"#/properties/pattern/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.sense !== undefined){const _errs5: any = errors;if(!(validateRememberedRuleSense.call(this, data.sense, {instancePath:instancePath+"/sense",parentData:data,parentDataProperty:"sense",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRememberedRuleSense.errors : vErrors.concat(validateRememberedRuleSense.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateRememberedScope.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateRememberedScope.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRememberedScope.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern88 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link ApprovalResolveRequest}. */
// prettier-ignore
export const validateApprovalResolveRequest: CompiledSchemaCheck<ApprovalResolveRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalResolveRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalResolveRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.decision;if(typeof tag0 == "string"){if(tag0 === "approved"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.decision === undefined) && (missing0 = "decision")) || ((data.approvalRequestId === undefined) && (missing0 = "approvalRequestId"))) || ((data.clientResolutionId === undefined) && (missing0 = "clientResolutionId"))){validateApprovalResolveRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((((((key0 === "decision") || (key0 === "approvalRequestId")) || (key0 === "clientResolutionId")) || (key0 === "effectiveScope")) || (key0 === "auditMetadata")) || (key0 === "editedAction")) || (key0 === "declineReason")) || (key0 === "rememberedScope"))){validateApprovalResolveRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.decision !== undefined){let data0: any = data.decision;const _errs5: any = errors;if(typeof data0 !== "string"){validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/decision",schemaPath:"#/oneOf/0/properties/decision/type",keyword:"type",params:{type: "string"}}];return false;}if("approved" !== data0){validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/decision",schemaPath:"#/oneOf/0/properties/decision/const",keyword:"const",params:{allowedValue: "approved"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.approvalRequestId !== undefined){const _errs7: any = errors;if(!(validateApprovalRequestId.call(this, data.approvalRequestId, {instancePath:instancePath+"/approvalRequestId",parentData:data,parentDataProperty:"approvalRequestId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalRequestId.errors : vErrors.concat(validateApprovalRequestId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.clientResolutionId !== undefined){let data2: any = data.clientResolutionId;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(!pattern88.test(data2)){validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/clientResolutionId",schemaPath:"#/oneOf/0/properties/clientResolutionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/clientResolutionId",schemaPath:"#/oneOf/0/properties/clientResolutionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.effectiveScope !== undefined){let data3: any = data.effectiveScope;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) > 4096){validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/0/properties/effectiveScope/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/0/properties/effectiveScope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/0/properties/effectiveScope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/0/properties/effectiveScope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data.auditMetadata !== undefined){let data4: any = data.auditMetadata;const _errs12: any = errors;if(errors === _errs12){if(data4 && typeof data4 == "object" && !Array.isArray(data4)){for(const key1 in data4){const _errs14: any = errors;const _errs15: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/auditMetadata",schemaPath:"#/oneOf/0/properties/auditMetadata/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid4: any = _errs15 === errors;if(valid4){const _errs17: any = errors;const _errs18: any = errors;const _errs19: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid5: any = _errs19 === errors;if(valid5){const err2: any = {instancePath:instancePath+"/auditMetadata",schemaPath:"#/oneOf/0/properties/auditMetadata/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs18;if(vErrors !== null){if(_errs18){vErrors.length = _errs18;}else {vErrors = null;}}}var valid4: any = _errs17 === errors;}var valid3: any = _errs14 === errors;if(!valid3){const err3: any = {instancePath:instancePath+"/auditMetadata",schemaPath:"#/oneOf/0/properties/auditMetadata/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateApprovalResolveRequest.errors = vErrors;return false;break;}}if(valid3){for(const key2 in data4){const _errs21: any = errors;var valid6: any = _errs21 === errors;if(!valid6){break;}}}}else {validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/auditMetadata",schemaPath:"#/oneOf/0/properties/auditMetadata/type",keyword:"type",params:{type: "object"}}];return false;}}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.editedAction !== undefined){let data6: any = data.editedAction;const _errs23: any = errors;if(errors === _errs23){if(typeof data6 === "string"){if(func1(data6) < 1){validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/editedAction",schemaPath:"#/oneOf/0/properties/editedAction/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/editedAction",schemaPath:"#/oneOf/0/properties/editedAction/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs23 === errors;}else {var valid2: any = true;}if(valid2){if(data.declineReason !== undefined){const _errs25: any = errors;validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/declineReason",schemaPath:"#/oneOf/0/properties/declineReason/not",keyword:"not",params:{}}];return false;var valid2: any = _errs25 === errors;}else {var valid2: any = true;}if(valid2){if(data.rememberedScope !== undefined){let data8: any = data.rememberedScope;const _errs28: any = errors;if(!(validateRememberedScope.call(this, data8, {instancePath:instancePath+"/rememberedScope",parentData:data,parentDataProperty:"rememberedScope",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRememberedScope.errors : vErrors.concat(validateRememberedScope.errors);errors = vErrors.length;}if(errors === _errs28){if(data8 && typeof data8 == "object" && !Array.isArray(data8)){if(data8.sense !== undefined){if("allow" !== data8.sense){validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/rememberedScope/sense",schemaPath:"#/oneOf/0/properties/rememberedScope/properties/sense/const",keyword:"const",params:{allowedValue: "allow"}}];return false;}}}else {validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/rememberedScope",schemaPath:"#/oneOf/0/properties/rememberedScope/type",keyword:"type",params:{type: "object"}}];return false;}}var valid2: any = _errs28 === errors;}else {var valid2: any = true;}}}}}}}}}}}else {validateApprovalResolveRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "rejected"){const _errs31: any = errors;if(errors === _errs31){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.decision === undefined) && (missing1 = "decision")) || ((data.approvalRequestId === undefined) && (missing1 = "approvalRequestId"))) || ((data.clientResolutionId === undefined) && (missing1 = "clientResolutionId"))){validateApprovalResolveRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs33: any = errors;for(const key3 in data){if(!((((((((key3 === "decision") || (key3 === "approvalRequestId")) || (key3 === "clientResolutionId")) || (key3 === "effectiveScope")) || (key3 === "auditMetadata")) || (key3 === "declineReason")) || (key3 === "editedAction")) || (key3 === "rememberedScope"))){validateApprovalResolveRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs33 === errors){if(data.decision !== undefined){let data10: any = data.decision;const _errs34: any = errors;if(typeof data10 !== "string"){validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/decision",schemaPath:"#/oneOf/1/properties/decision/type",keyword:"type",params:{type: "string"}}];return false;}if("rejected" !== data10){validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/decision",schemaPath:"#/oneOf/1/properties/decision/const",keyword:"const",params:{allowedValue: "rejected"}}];return false;}var valid9: any = _errs34 === errors;}else {var valid9: any = true;}if(valid9){if(data.approvalRequestId !== undefined){const _errs36: any = errors;if(!(validateApprovalRequestId.call(this, data.approvalRequestId, {instancePath:instancePath+"/approvalRequestId",parentData:data,parentDataProperty:"approvalRequestId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalRequestId.errors : vErrors.concat(validateApprovalRequestId.errors);errors = vErrors.length;}var valid9: any = _errs36 === errors;}else {var valid9: any = true;}if(valid9){if(data.clientResolutionId !== undefined){let data12: any = data.clientResolutionId;const _errs37: any = errors;if(errors === _errs37){if(typeof data12 === "string"){if(!pattern88.test(data12)){validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/clientResolutionId",schemaPath:"#/oneOf/1/properties/clientResolutionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/clientResolutionId",schemaPath:"#/oneOf/1/properties/clientResolutionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs37 === errors;}else {var valid9: any = true;}if(valid9){if(data.effectiveScope !== undefined){let data13: any = data.effectiveScope;const _errs39: any = errors;if(errors === _errs39){if(typeof data13 === "string"){if(func1(data13) > 4096){validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/1/properties/effectiveScope/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data13) < 1){validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/1/properties/effectiveScope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data13)){validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/1/properties/effectiveScope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/1/properties/effectiveScope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs39 === errors;}else {var valid9: any = true;}if(valid9){if(data.auditMetadata !== undefined){let data14: any = data.auditMetadata;const _errs41: any = errors;if(errors === _errs41){if(data14 && typeof data14 == "object" && !Array.isArray(data14)){for(const key4 in data14){const _errs43: any = errors;const _errs44: any = errors;if(typeof key4 !== "string"){const err4: any = {instancePath:instancePath+"/auditMetadata",schemaPath:"#/oneOf/1/properties/auditMetadata/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key4};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}var valid11: any = _errs44 === errors;if(valid11){const _errs46: any = errors;const _errs47: any = errors;const _errs48: any = errors;if("__proto__" !== key4){const err5: any = {};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}var valid12: any = _errs48 === errors;if(valid12){const err6: any = {instancePath:instancePath+"/auditMetadata",schemaPath:"#/oneOf/1/properties/auditMetadata/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key4};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}else {errors = _errs47;if(vErrors !== null){if(_errs47){vErrors.length = _errs47;}else {vErrors = null;}}}var valid11: any = _errs46 === errors;}var valid10: any = _errs43 === errors;if(!valid10){const err7: any = {instancePath:instancePath+"/auditMetadata",schemaPath:"#/oneOf/1/properties/auditMetadata/propertyNames",keyword:"propertyNames",params:{propertyName: key4}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;validateApprovalResolveRequest.errors = vErrors;return false;break;}}if(valid10){for(const key5 in data14){const _errs50: any = errors;var valid13: any = _errs50 === errors;if(!valid13){break;}}}}else {validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/auditMetadata",schemaPath:"#/oneOf/1/properties/auditMetadata/type",keyword:"type",params:{type: "object"}}];return false;}}var valid9: any = _errs41 === errors;}else {var valid9: any = true;}if(valid9){if(data.declineReason !== undefined){let data16: any = data.declineReason;const _errs52: any = errors;if(errors === _errs52){if(typeof data16 === "string"){if(func1(data16) < 1){validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/declineReason",schemaPath:"#/oneOf/1/properties/declineReason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/declineReason",schemaPath:"#/oneOf/1/properties/declineReason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs52 === errors;}else {var valid9: any = true;}if(valid9){if(data.editedAction !== undefined){const _errs54: any = errors;validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/editedAction",schemaPath:"#/oneOf/1/properties/editedAction/not",keyword:"not",params:{}}];return false;var valid9: any = _errs54 === errors;}else {var valid9: any = true;}if(valid9){if(data.rememberedScope !== undefined){let data18: any = data.rememberedScope;const _errs57: any = errors;if(!(validateRememberedScope.call(this, data18, {instancePath:instancePath+"/rememberedScope",parentData:data,parentDataProperty:"rememberedScope",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRememberedScope.errors : vErrors.concat(validateRememberedScope.errors);errors = vErrors.length;}if(errors === _errs57){if(data18 && typeof data18 == "object" && !Array.isArray(data18)){if(data18.sense !== undefined){if("block" !== data18.sense){validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/rememberedScope/sense",schemaPath:"#/oneOf/1/properties/rememberedScope/properties/sense/const",keyword:"const",params:{allowedValue: "block"}}];return false;}}}else {validateApprovalResolveRequest.errors = [{instancePath:instancePath+"/rememberedScope",schemaPath:"#/oneOf/1/properties/rememberedScope/type",keyword:"type",params:{type: "object"}}];return false;}}var valid9: any = _errs57 === errors;}else {var valid9: any = true;}}}}}}}}}}}else {validateApprovalResolveRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid8: any = _errs31 === errors;if(props0 !== true){props0 = true;}valid0 = valid8;}else {validateApprovalResolveRequest.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "decision", tagValue: tag0}}];return false;}}else {validateApprovalResolveRequest.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "decision", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key6 in data){if(!props0 || !props0[key6]){validateApprovalResolveRequest.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key6}}];return false;break;}}}}}else {validateApprovalResolveRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalResolveRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalResolveRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ApprovalResolveResponse}. */
// prettier-ignore
export const validateApprovalResolveResponse: CompiledSchemaCheck<ApprovalResolveResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalResolveResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalResolveResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.approvalRequestId === undefined) && (missing0 = "approvalRequestId")) || ((data.state === undefined) && (missing0 = "state"))) || ((data.deviceId === undefined) && (missing0 = "deviceId"))) || ((data.effectiveScope === undefined) && (missing0 = "effectiveScope"))) || ((data.resolvedAt === undefined) && (missing0 = "resolvedAt"))){validateApprovalResolveResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "approvalRequestId") || (key0 === "state")) || (key0 === "deviceId")) || (key0 === "effectiveScope")) || (key0 === "resolvedAt"))){validateApprovalResolveResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.approvalRequestId !== undefined){const _errs2: any = errors;if(!(validateApprovalRequestId.call(this, data.approvalRequestId, {instancePath:instancePath+"/approvalRequestId",parentData:data,parentDataProperty:"approvalRequestId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalRequestId.errors : vErrors.concat(validateApprovalRequestId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs3: any = errors;if(!(validateApprovalState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalState.errors : vErrors.concat(validateApprovalState.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){const _errs4: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.effectiveScope !== undefined){let data3: any = data.effectiveScope;const _errs5: any = errors;if(errors === _errs5){if(typeof data3 === "string"){if(func1(data3) > 4096){validateApprovalResolveResponse.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/properties/effectiveScope/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validateApprovalResolveResponse.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/properties/effectiveScope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validateApprovalResolveResponse.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/properties/effectiveScope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateApprovalResolveResponse.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/properties/effectiveScope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.resolvedAt !== undefined){const _errs7: any = errors;if(!(validateWireInstant.call(this, data.resolvedAt, {instancePath:instancePath+"/resolvedAt",parentData:data,parentDataProperty:"resolvedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}}else {validateApprovalResolveResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalResolveResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalResolveResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ApprovalListRequest}. */
// prettier-ignore
export const validateApprovalListRequest: CompiledSchemaCheck<ApprovalListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateApprovalListRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "state")) || (key0 === "category"))){validateApprovalListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs3: any = errors;if(!(validateApprovalState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalState.errors : vErrors.concat(validateApprovalState.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.category !== undefined){const _errs4: any = errors;if(!(validateApprovalCategory.call(this, data.category, {instancePath:instancePath+"/category",parentData:data,parentDataProperty:"category",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalCategory.errors : vErrors.concat(validateApprovalCategory.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateApprovalListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema101: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"state":{"type":"string","const":"pending"},"id":{"$ref":"#/$defs/ApprovalRequestId","description":"The ask."},"holder":{"$ref":"#/$defs/ApprovalHolder","description":"What holds it open: an agent run or a workflow wait."},"requestedBy":{"type":"string","minLength":1,"description":"Who asked."},"category":{"$ref":"#/$defs/ApprovalCategory","description":"What it is about."},"scope":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":4096,"description":"Its target scope."},"resourceDescriptor":{"type":"object","propertyNames":{"allOf":[{"type":"string"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"tsType":"unknown"},"description":"What it would touch, as the provider described it."},"subject":{"type":"string","minLength":1,"description":"The subject the daemon derived from the ask: the words the standing-allow\nbutton names."},"reason":{"type":"string","minLength":1,"description":"The provider's own line saying why this action stopped, control characters and\nescape codes stripped; absent where the provider sent none."},"standingAllowOffered":{"type":"boolean","description":"False where the provider forbids a standing allow; the card then draws only\n`Decline` and `Approve once`."},"projectScopeOffered":{"type":"boolean","description":"Whether that standing allow may also be written for the whole project: false\non a chat, which has no project, and on a workflow command step's ask, which no\nprovider relayed."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was raised."},"updatedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it last changed."},"resolvedAt":{"not":{},"tsType":"never","description":"Never present on an unresolved ask."},"decision":{"not":{},"tsType":"never","description":"Never present on an unresolved ask."},"deviceId":{"not":{},"tsType":"never","description":"Never present on an unresolved ask."},"effectiveScope":{"not":{},"tsType":"never","description":"Never present on an unresolved ask."},"rememberedScope":{"not":{},"tsType":"never","description":"Never present on an unresolved ask."}},"required":["state","id","holder","requestedBy","category","scope","resourceDescriptor","subject","standingAllowOffered","projectScopeOffered","createdAt","updatedAt"],"description":"Waiting on an answer."},{"type":"object","additionalProperties":false,"properties":{"state":{"type":"string","const":"canceled"},"id":{"$ref":"#/$defs/ApprovalRequestId","description":"The ask."},"holder":{"$ref":"#/$defs/ApprovalHolder","description":"What holds it open: an agent run or a workflow wait."},"requestedBy":{"type":"string","minLength":1,"description":"Who asked."},"category":{"$ref":"#/$defs/ApprovalCategory","description":"What it is about."},"scope":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":4096,"description":"Its target scope."},"resourceDescriptor":{"type":"object","propertyNames":{"allOf":[{"type":"string"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"tsType":"unknown"},"description":"What it would touch, as the provider described it."},"subject":{"type":"string","minLength":1,"description":"The subject the daemon derived from the ask: the words the standing-allow\nbutton names."},"reason":{"type":"string","minLength":1,"description":"The provider's own line saying why this action stopped, control characters and\nescape codes stripped; absent where the provider sent none."},"standingAllowOffered":{"type":"boolean","description":"False where the provider forbids a standing allow; the card then draws only\n`Decline` and `Approve once`."},"projectScopeOffered":{"type":"boolean","description":"Whether that standing allow may also be written for the whole project: false\non a chat, which has no project, and on a workflow command step's ask, which no\nprovider relayed."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was raised."},"updatedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it last changed."},"resolvedAt":{"not":{},"tsType":"never","description":"Never present on an unresolved ask."},"decision":{"not":{},"tsType":"never","description":"Never present on an unresolved ask."},"deviceId":{"not":{},"tsType":"never","description":"Never present on an unresolved ask."},"effectiveScope":{"not":{},"tsType":"never","description":"Never present on an unresolved ask."},"rememberedScope":{"not":{},"tsType":"never","description":"Never present on an unresolved ask."}},"required":["state","id","holder","requestedBy","category","scope","resourceDescriptor","subject","standingAllowOffered","projectScopeOffered","createdAt","updatedAt"],"description":"Ended with its run."},{"type":"object","additionalProperties":false,"properties":{"state":{"type":"string","const":"approved"},"id":{"$ref":"#/$defs/ApprovalRequestId","description":"The ask."},"holder":{"$ref":"#/$defs/ApprovalHolder","description":"What holds it open: an agent run or a workflow wait."},"requestedBy":{"type":"string","minLength":1,"description":"Who asked."},"category":{"$ref":"#/$defs/ApprovalCategory","description":"What it is about."},"scope":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":4096,"description":"Its target scope."},"resourceDescriptor":{"type":"object","propertyNames":{"allOf":[{"type":"string"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"tsType":"unknown"},"description":"What it would touch, as the provider described it."},"subject":{"type":"string","minLength":1,"description":"The subject the daemon derived from the ask: the words the standing-allow\nbutton names."},"reason":{"type":"string","minLength":1,"description":"The provider's own line saying why this action stopped, control characters and\nescape codes stripped; absent where the provider sent none."},"standingAllowOffered":{"type":"boolean","description":"False where the provider forbids a standing allow; the card then draws only\n`Decline` and `Approve once`."},"projectScopeOffered":{"type":"boolean","description":"Whether that standing allow may also be written for the whole project: false\non a chat, which has no project, and on a workflow command step's ask, which no\nprovider relayed."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was raised."},"updatedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it last changed."},"resolvedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was answered."},"decision":{"description":"Always `approved`.","type":"string","enum":["approved"]},"deviceId":{"$ref":"sidekicks-contracts:trust-statement#/$defs/DeviceId","description":"The device that answered."},"effectiveScope":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":4096,"description":"The recorded scope."},"rememberedScope":{"$ref":"#/$defs/RememberedScope","description":"The rule the answer minted, an allow.","type":"object","properties":{"sense":{"const":"allow"}}}},"required":["state","id","holder","requestedBy","category","scope","resourceDescriptor","subject","standingAllowOffered","projectScopeOffered","createdAt","updatedAt","resolvedAt","decision","deviceId","effectiveScope"],"description":"Approved."},{"type":"object","additionalProperties":false,"properties":{"state":{"type":"string","const":"rejected"},"id":{"$ref":"#/$defs/ApprovalRequestId","description":"The ask."},"holder":{"$ref":"#/$defs/ApprovalHolder","description":"What holds it open: an agent run or a workflow wait."},"requestedBy":{"type":"string","minLength":1,"description":"Who asked."},"category":{"$ref":"#/$defs/ApprovalCategory","description":"What it is about."},"scope":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":4096,"description":"Its target scope."},"resourceDescriptor":{"type":"object","propertyNames":{"allOf":[{"type":"string"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"tsType":"unknown"},"description":"What it would touch, as the provider described it."},"subject":{"type":"string","minLength":1,"description":"The subject the daemon derived from the ask: the words the standing-allow\nbutton names."},"reason":{"type":"string","minLength":1,"description":"The provider's own line saying why this action stopped, control characters and\nescape codes stripped; absent where the provider sent none."},"standingAllowOffered":{"type":"boolean","description":"False where the provider forbids a standing allow; the card then draws only\n`Decline` and `Approve once`."},"projectScopeOffered":{"type":"boolean","description":"Whether that standing allow may also be written for the whole project: false\non a chat, which has no project, and on a workflow command step's ask, which no\nprovider relayed."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was raised."},"updatedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it last changed."},"resolvedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was answered."},"decision":{"description":"Always `rejected`.","type":"string","enum":["rejected"]},"deviceId":{"$ref":"sidekicks-contracts:trust-statement#/$defs/DeviceId","description":"The device that answered."},"effectiveScope":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":4096,"description":"The recorded scope."},"rememberedScope":{"$ref":"#/$defs/RememberedScope","description":"The rule the answer minted, a block.","type":"object","properties":{"sense":{"const":"block"}}}},"required":["state","id","holder","requestedBy","category","scope","resourceDescriptor","subject","standingAllowOffered","projectScopeOffered","createdAt","updatedAt","resolvedAt","decision","deviceId","effectiveScope"],"description":"Declined."}],"description":"One ask as the card draws it. A resolved ask carries `resolvedAt`, `decision`,\n`deviceId` and `effectiveScope`, its decision is its state, and only it may carry a\nminted rule, with the sense its decision gives; no other ask carries any of them. The\nproject scope is offered only beside a standing allow.","type":"object","if":{"type":"object","properties":{"projectScopeOffered":{"const":true}},"required":["projectScopeOffered"]},"then":{"type":"object","properties":{"standingAllowOffered":{"const":true}}},"discriminator":{"propertyName":"state"},"unevaluatedProperties":false};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
/** Checks that a value is a {@link ApprovalProjectionRow}. */
// prettier-ignore
export const validateApprovalProjectionRow: CompiledSchemaCheck<ApprovalProjectionRow> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalProjectionRow {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalProjectionRow.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs2: any = errors;let valid0: any = true;const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.projectScopeOffered === undefined) && (missing0 = "projectScopeOffered")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(data.projectScopeOffered !== undefined){if(true !== data.projectScopeOffered){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}}else {const err2: any = {};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs3 === errors;errors = _errs2;if(vErrors !== null){if(_errs2){vErrors.length = _errs2;}else {vErrors = null;}}if(_valid0){const _errs6: any = errors;if(errors === _errs6){if(data && typeof data == "object" && !Array.isArray(data)){if(data.standingAllowOffered !== undefined){if(true !== data.standingAllowOffered){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/standingAllowOffered",schemaPath:"#/then/properties/standingAllowOffered/const",keyword:"const",params:{allowedValue: true}}];return false;}}}else {validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid0: any = _errs6 === errors;valid0 = _valid0;if(valid0){var props0: any = {};props0.standingAllowOffered = true;props0.projectScopeOffered = true;}}if(!valid0){const err3: any = {instancePath,schemaPath:"#/if",keyword:"if",params:{failingKeyword: "then"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateApprovalProjectionRow.errors = vErrors;return false;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid3: any = false;const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "pending"){const _errs9: any = errors;if(errors === _errs9){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((((((((((data.state === undefined) && (missing1 = "state")) || ((data.id === undefined) && (missing1 = "id"))) || ((data.holder === undefined) && (missing1 = "holder"))) || ((data.requestedBy === undefined) && (missing1 = "requestedBy"))) || ((data.category === undefined) && (missing1 = "category"))) || ((data.scope === undefined) && (missing1 = "scope"))) || ((data.resourceDescriptor === undefined) && (missing1 = "resourceDescriptor"))) || ((data.subject === undefined) && (missing1 = "subject"))) || ((data.standingAllowOffered === undefined) && (missing1 = "standingAllowOffered"))) || ((data.projectScopeOffered === undefined) && (missing1 = "projectScopeOffered"))) || ((data.createdAt === undefined) && (missing1 = "createdAt"))) || ((data.updatedAt === undefined) && (missing1 = "updatedAt"))){validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs11: any = errors;for(const key0 in data){if(!(func2.call(schema101.oneOf[0].properties, key0))){validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs11 === errors){if(data.state !== undefined){let data2: any = data.state;const _errs12: any = errors;if(typeof data2 !== "string"){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("pending" !== data2){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "pending"}}];return false;}var valid5: any = _errs12 === errors;}else {var valid5: any = true;}if(valid5){if(data.id !== undefined){const _errs14: any = errors;if(!(validateApprovalRequestId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalRequestId.errors : vErrors.concat(validateApprovalRequestId.errors);errors = vErrors.length;}var valid5: any = _errs14 === errors;}else {var valid5: any = true;}if(valid5){if(data.holder !== undefined){const _errs15: any = errors;if(!(validateApprovalHolder.call(this, data.holder, {instancePath:instancePath+"/holder",parentData:data,parentDataProperty:"holder",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalHolder.errors : vErrors.concat(validateApprovalHolder.errors);errors = vErrors.length;}var valid5: any = _errs15 === errors;}else {var valid5: any = true;}if(valid5){if(data.requestedBy !== undefined){let data5: any = data.requestedBy;const _errs16: any = errors;if(errors === _errs16){if(typeof data5 === "string"){if(func1(data5) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/requestedBy",schemaPath:"#/oneOf/0/properties/requestedBy/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/requestedBy",schemaPath:"#/oneOf/0/properties/requestedBy/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs16 === errors;}else {var valid5: any = true;}if(valid5){if(data.category !== undefined){const _errs18: any = errors;if(!(validateApprovalCategory.call(this, data.category, {instancePath:instancePath+"/category",parentData:data,parentDataProperty:"category",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalCategory.errors : vErrors.concat(validateApprovalCategory.errors);errors = vErrors.length;}var valid5: any = _errs18 === errors;}else {var valid5: any = true;}if(valid5){if(data.scope !== undefined){let data7: any = data.scope;const _errs19: any = errors;if(errors === _errs19){if(typeof data7 === "string"){if(func1(data7) > 4096){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/0/properties/scope/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data7) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/0/properties/scope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data7)){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/0/properties/scope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/0/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs19 === errors;}else {var valid5: any = true;}if(valid5){if(data.resourceDescriptor !== undefined){let data8: any = data.resourceDescriptor;const _errs21: any = errors;if(errors === _errs21){if(data8 && typeof data8 == "object" && !Array.isArray(data8)){for(const key1 in data8){const _errs23: any = errors;const _errs24: any = errors;if(typeof key1 !== "string"){const err4: any = {instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/oneOf/0/properties/resourceDescriptor/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}var valid7: any = _errs24 === errors;if(valid7){const _errs26: any = errors;const _errs27: any = errors;const _errs28: any = errors;if("__proto__" !== key1){const err5: any = {};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}var valid8: any = _errs28 === errors;if(valid8){const err6: any = {instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/oneOf/0/properties/resourceDescriptor/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}else {errors = _errs27;if(vErrors !== null){if(_errs27){vErrors.length = _errs27;}else {vErrors = null;}}}var valid7: any = _errs26 === errors;}var valid6: any = _errs23 === errors;if(!valid6){const err7: any = {instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/oneOf/0/properties/resourceDescriptor/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;validateApprovalProjectionRow.errors = vErrors;return false;break;}}if(valid6){for(const key2 in data8){const _errs30: any = errors;var valid9: any = _errs30 === errors;if(!valid9){break;}}}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/oneOf/0/properties/resourceDescriptor/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs21 === errors;}else {var valid5: any = true;}if(valid5){if(data.subject !== undefined){let data10: any = data.subject;const _errs32: any = errors;if(errors === _errs32){if(typeof data10 === "string"){if(func1(data10) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/subject",schemaPath:"#/oneOf/0/properties/subject/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/subject",schemaPath:"#/oneOf/0/properties/subject/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs32 === errors;}else {var valid5: any = true;}if(valid5){if(data.reason !== undefined){let data11: any = data.reason;const _errs34: any = errors;if(errors === _errs34){if(typeof data11 === "string"){if(func1(data11) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs34 === errors;}else {var valid5: any = true;}if(valid5){if(data.standingAllowOffered !== undefined){const _errs36: any = errors;if(typeof data.standingAllowOffered !== "boolean"){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/standingAllowOffered",schemaPath:"#/oneOf/0/properties/standingAllowOffered/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid5: any = _errs36 === errors;}else {var valid5: any = true;}if(valid5){if(data.projectScopeOffered !== undefined){const _errs38: any = errors;if(typeof data.projectScopeOffered !== "boolean"){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/projectScopeOffered",schemaPath:"#/oneOf/0/properties/projectScopeOffered/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid5: any = _errs38 === errors;}else {var valid5: any = true;}if(valid5){if(data.createdAt !== undefined){const _errs40: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid5: any = _errs40 === errors;}else {var valid5: any = true;}if(valid5){if(data.updatedAt !== undefined){const _errs41: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid5: any = _errs41 === errors;}else {var valid5: any = true;}if(valid5){if(data.resolvedAt !== undefined){const _errs42: any = errors;validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/resolvedAt",schemaPath:"#/oneOf/0/properties/resolvedAt/not",keyword:"not",params:{}}];return false;var valid5: any = _errs42 === errors;}else {var valid5: any = true;}if(valid5){if(data.decision !== undefined){const _errs45: any = errors;validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/decision",schemaPath:"#/oneOf/0/properties/decision/not",keyword:"not",params:{}}];return false;var valid5: any = _errs45 === errors;}else {var valid5: any = true;}if(valid5){if(data.deviceId !== undefined){const _errs48: any = errors;validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/oneOf/0/properties/deviceId/not",keyword:"not",params:{}}];return false;var valid5: any = _errs48 === errors;}else {var valid5: any = true;}if(valid5){if(data.effectiveScope !== undefined){const _errs51: any = errors;validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/0/properties/effectiveScope/not",keyword:"not",params:{}}];return false;var valid5: any = _errs51 === errors;}else {var valid5: any = true;}if(valid5){if(data.rememberedScope !== undefined){const _errs54: any = errors;validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/rememberedScope",schemaPath:"#/oneOf/0/properties/rememberedScope/not",keyword:"not",params:{}}];return false;var valid5: any = _errs54 === errors;}else {var valid5: any = true;}}}}}}}}}}}}}}}}}}}}}else {validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs9 === errors;if(props0 !== true){props0 = true;}valid3 = valid4;}else if(tag0 === "canceled"){const _errs57: any = errors;if(errors === _errs57){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((((((((((data.state === undefined) && (missing2 = "state")) || ((data.id === undefined) && (missing2 = "id"))) || ((data.holder === undefined) && (missing2 = "holder"))) || ((data.requestedBy === undefined) && (missing2 = "requestedBy"))) || ((data.category === undefined) && (missing2 = "category"))) || ((data.scope === undefined) && (missing2 = "scope"))) || ((data.resourceDescriptor === undefined) && (missing2 = "resourceDescriptor"))) || ((data.subject === undefined) && (missing2 = "subject"))) || ((data.standingAllowOffered === undefined) && (missing2 = "standingAllowOffered"))) || ((data.projectScopeOffered === undefined) && (missing2 = "projectScopeOffered"))) || ((data.createdAt === undefined) && (missing2 = "createdAt"))) || ((data.updatedAt === undefined) && (missing2 = "updatedAt"))){validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs59: any = errors;for(const key3 in data){if(!(func2.call(schema101.oneOf[1].properties, key3))){validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs59 === errors){if(data.state !== undefined){let data21: any = data.state;const _errs60: any = errors;if(typeof data21 !== "string"){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("canceled" !== data21){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "canceled"}}];return false;}var valid11: any = _errs60 === errors;}else {var valid11: any = true;}if(valid11){if(data.id !== undefined){const _errs62: any = errors;if(!(validateApprovalRequestId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalRequestId.errors : vErrors.concat(validateApprovalRequestId.errors);errors = vErrors.length;}var valid11: any = _errs62 === errors;}else {var valid11: any = true;}if(valid11){if(data.holder !== undefined){const _errs63: any = errors;if(!(validateApprovalHolder.call(this, data.holder, {instancePath:instancePath+"/holder",parentData:data,parentDataProperty:"holder",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalHolder.errors : vErrors.concat(validateApprovalHolder.errors);errors = vErrors.length;}var valid11: any = _errs63 === errors;}else {var valid11: any = true;}if(valid11){if(data.requestedBy !== undefined){let data24: any = data.requestedBy;const _errs64: any = errors;if(errors === _errs64){if(typeof data24 === "string"){if(func1(data24) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/requestedBy",schemaPath:"#/oneOf/1/properties/requestedBy/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/requestedBy",schemaPath:"#/oneOf/1/properties/requestedBy/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs64 === errors;}else {var valid11: any = true;}if(valid11){if(data.category !== undefined){const _errs66: any = errors;if(!(validateApprovalCategory.call(this, data.category, {instancePath:instancePath+"/category",parentData:data,parentDataProperty:"category",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalCategory.errors : vErrors.concat(validateApprovalCategory.errors);errors = vErrors.length;}var valid11: any = _errs66 === errors;}else {var valid11: any = true;}if(valid11){if(data.scope !== undefined){let data26: any = data.scope;const _errs67: any = errors;if(errors === _errs67){if(typeof data26 === "string"){if(func1(data26) > 4096){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/1/properties/scope/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data26) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/1/properties/scope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data26)){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/1/properties/scope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/1/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs67 === errors;}else {var valid11: any = true;}if(valid11){if(data.resourceDescriptor !== undefined){let data27: any = data.resourceDescriptor;const _errs69: any = errors;if(errors === _errs69){if(data27 && typeof data27 == "object" && !Array.isArray(data27)){for(const key4 in data27){const _errs71: any = errors;const _errs72: any = errors;if(typeof key4 !== "string"){const err8: any = {instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/oneOf/1/properties/resourceDescriptor/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key4};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}var valid13: any = _errs72 === errors;if(valid13){const _errs74: any = errors;const _errs75: any = errors;const _errs76: any = errors;if("__proto__" !== key4){const err9: any = {};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}var valid14: any = _errs76 === errors;if(valid14){const err10: any = {instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/oneOf/1/properties/resourceDescriptor/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key4};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}else {errors = _errs75;if(vErrors !== null){if(_errs75){vErrors.length = _errs75;}else {vErrors = null;}}}var valid13: any = _errs74 === errors;}var valid12: any = _errs71 === errors;if(!valid12){const err11: any = {instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/oneOf/1/properties/resourceDescriptor/propertyNames",keyword:"propertyNames",params:{propertyName: key4}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;validateApprovalProjectionRow.errors = vErrors;return false;break;}}if(valid12){for(const key5 in data27){const _errs78: any = errors;var valid15: any = _errs78 === errors;if(!valid15){break;}}}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/oneOf/1/properties/resourceDescriptor/type",keyword:"type",params:{type: "object"}}];return false;}}var valid11: any = _errs69 === errors;}else {var valid11: any = true;}if(valid11){if(data.subject !== undefined){let data29: any = data.subject;const _errs80: any = errors;if(errors === _errs80){if(typeof data29 === "string"){if(func1(data29) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/subject",schemaPath:"#/oneOf/1/properties/subject/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/subject",schemaPath:"#/oneOf/1/properties/subject/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs80 === errors;}else {var valid11: any = true;}if(valid11){if(data.reason !== undefined){let data30: any = data.reason;const _errs82: any = errors;if(errors === _errs82){if(typeof data30 === "string"){if(func1(data30) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs82 === errors;}else {var valid11: any = true;}if(valid11){if(data.standingAllowOffered !== undefined){const _errs84: any = errors;if(typeof data.standingAllowOffered !== "boolean"){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/standingAllowOffered",schemaPath:"#/oneOf/1/properties/standingAllowOffered/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid11: any = _errs84 === errors;}else {var valid11: any = true;}if(valid11){if(data.projectScopeOffered !== undefined){const _errs86: any = errors;if(typeof data.projectScopeOffered !== "boolean"){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/projectScopeOffered",schemaPath:"#/oneOf/1/properties/projectScopeOffered/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid11: any = _errs86 === errors;}else {var valid11: any = true;}if(valid11){if(data.createdAt !== undefined){const _errs88: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid11: any = _errs88 === errors;}else {var valid11: any = true;}if(valid11){if(data.updatedAt !== undefined){const _errs89: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid11: any = _errs89 === errors;}else {var valid11: any = true;}if(valid11){if(data.resolvedAt !== undefined){const _errs90: any = errors;validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/resolvedAt",schemaPath:"#/oneOf/1/properties/resolvedAt/not",keyword:"not",params:{}}];return false;var valid11: any = _errs90 === errors;}else {var valid11: any = true;}if(valid11){if(data.decision !== undefined){const _errs93: any = errors;validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/decision",schemaPath:"#/oneOf/1/properties/decision/not",keyword:"not",params:{}}];return false;var valid11: any = _errs93 === errors;}else {var valid11: any = true;}if(valid11){if(data.deviceId !== undefined){const _errs96: any = errors;validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/oneOf/1/properties/deviceId/not",keyword:"not",params:{}}];return false;var valid11: any = _errs96 === errors;}else {var valid11: any = true;}if(valid11){if(data.effectiveScope !== undefined){const _errs99: any = errors;validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/1/properties/effectiveScope/not",keyword:"not",params:{}}];return false;var valid11: any = _errs99 === errors;}else {var valid11: any = true;}if(valid11){if(data.rememberedScope !== undefined){const _errs102: any = errors;validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/rememberedScope",schemaPath:"#/oneOf/1/properties/rememberedScope/not",keyword:"not",params:{}}];return false;var valid11: any = _errs102 === errors;}else {var valid11: any = true;}}}}}}}}}}}}}}}}}}}}}else {validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid10: any = _errs57 === errors;if(props0 !== true){props0 = true;}valid3 = valid10;}else if(tag0 === "approved"){const _errs105: any = errors;if(errors === _errs105){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((((((((((((((((data.state === undefined) && (missing3 = "state")) || ((data.id === undefined) && (missing3 = "id"))) || ((data.holder === undefined) && (missing3 = "holder"))) || ((data.requestedBy === undefined) && (missing3 = "requestedBy"))) || ((data.category === undefined) && (missing3 = "category"))) || ((data.scope === undefined) && (missing3 = "scope"))) || ((data.resourceDescriptor === undefined) && (missing3 = "resourceDescriptor"))) || ((data.subject === undefined) && (missing3 = "subject"))) || ((data.standingAllowOffered === undefined) && (missing3 = "standingAllowOffered"))) || ((data.projectScopeOffered === undefined) && (missing3 = "projectScopeOffered"))) || ((data.createdAt === undefined) && (missing3 = "createdAt"))) || ((data.updatedAt === undefined) && (missing3 = "updatedAt"))) || ((data.resolvedAt === undefined) && (missing3 = "resolvedAt"))) || ((data.decision === undefined) && (missing3 = "decision"))) || ((data.deviceId === undefined) && (missing3 = "deviceId"))) || ((data.effectiveScope === undefined) && (missing3 = "effectiveScope"))){validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs107: any = errors;for(const key6 in data){if(!(func2.call(schema101.oneOf[2].properties, key6))){validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}}];return false;break;}}if(_errs107 === errors){if(data.state !== undefined){let data40: any = data.state;const _errs108: any = errors;if(typeof data40 !== "string"){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("approved" !== data40){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "approved"}}];return false;}var valid17: any = _errs108 === errors;}else {var valid17: any = true;}if(valid17){if(data.id !== undefined){const _errs110: any = errors;if(!(validateApprovalRequestId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalRequestId.errors : vErrors.concat(validateApprovalRequestId.errors);errors = vErrors.length;}var valid17: any = _errs110 === errors;}else {var valid17: any = true;}if(valid17){if(data.holder !== undefined){const _errs111: any = errors;if(!(validateApprovalHolder.call(this, data.holder, {instancePath:instancePath+"/holder",parentData:data,parentDataProperty:"holder",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalHolder.errors : vErrors.concat(validateApprovalHolder.errors);errors = vErrors.length;}var valid17: any = _errs111 === errors;}else {var valid17: any = true;}if(valid17){if(data.requestedBy !== undefined){let data43: any = data.requestedBy;const _errs112: any = errors;if(errors === _errs112){if(typeof data43 === "string"){if(func1(data43) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/requestedBy",schemaPath:"#/oneOf/2/properties/requestedBy/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/requestedBy",schemaPath:"#/oneOf/2/properties/requestedBy/type",keyword:"type",params:{type: "string"}}];return false;}}var valid17: any = _errs112 === errors;}else {var valid17: any = true;}if(valid17){if(data.category !== undefined){const _errs114: any = errors;if(!(validateApprovalCategory.call(this, data.category, {instancePath:instancePath+"/category",parentData:data,parentDataProperty:"category",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalCategory.errors : vErrors.concat(validateApprovalCategory.errors);errors = vErrors.length;}var valid17: any = _errs114 === errors;}else {var valid17: any = true;}if(valid17){if(data.scope !== undefined){let data45: any = data.scope;const _errs115: any = errors;if(errors === _errs115){if(typeof data45 === "string"){if(func1(data45) > 4096){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/2/properties/scope/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data45) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/2/properties/scope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data45)){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/2/properties/scope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/2/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid17: any = _errs115 === errors;}else {var valid17: any = true;}if(valid17){if(data.resourceDescriptor !== undefined){let data46: any = data.resourceDescriptor;const _errs117: any = errors;if(errors === _errs117){if(data46 && typeof data46 == "object" && !Array.isArray(data46)){for(const key7 in data46){const _errs119: any = errors;const _errs120: any = errors;if(typeof key7 !== "string"){const err12: any = {instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/oneOf/2/properties/resourceDescriptor/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key7};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}var valid19: any = _errs120 === errors;if(valid19){const _errs122: any = errors;const _errs123: any = errors;const _errs124: any = errors;if("__proto__" !== key7){const err13: any = {};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}var valid20: any = _errs124 === errors;if(valid20){const err14: any = {instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/oneOf/2/properties/resourceDescriptor/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key7};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}else {errors = _errs123;if(vErrors !== null){if(_errs123){vErrors.length = _errs123;}else {vErrors = null;}}}var valid19: any = _errs122 === errors;}var valid18: any = _errs119 === errors;if(!valid18){const err15: any = {instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/oneOf/2/properties/resourceDescriptor/propertyNames",keyword:"propertyNames",params:{propertyName: key7}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;validateApprovalProjectionRow.errors = vErrors;return false;break;}}if(valid18){for(const key8 in data46){const _errs126: any = errors;var valid21: any = _errs126 === errors;if(!valid21){break;}}}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/oneOf/2/properties/resourceDescriptor/type",keyword:"type",params:{type: "object"}}];return false;}}var valid17: any = _errs117 === errors;}else {var valid17: any = true;}if(valid17){if(data.subject !== undefined){let data48: any = data.subject;const _errs128: any = errors;if(errors === _errs128){if(typeof data48 === "string"){if(func1(data48) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/subject",schemaPath:"#/oneOf/2/properties/subject/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/subject",schemaPath:"#/oneOf/2/properties/subject/type",keyword:"type",params:{type: "string"}}];return false;}}var valid17: any = _errs128 === errors;}else {var valid17: any = true;}if(valid17){if(data.reason !== undefined){let data49: any = data.reason;const _errs130: any = errors;if(errors === _errs130){if(typeof data49 === "string"){if(func1(data49) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid17: any = _errs130 === errors;}else {var valid17: any = true;}if(valid17){if(data.standingAllowOffered !== undefined){const _errs132: any = errors;if(typeof data.standingAllowOffered !== "boolean"){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/standingAllowOffered",schemaPath:"#/oneOf/2/properties/standingAllowOffered/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid17: any = _errs132 === errors;}else {var valid17: any = true;}if(valid17){if(data.projectScopeOffered !== undefined){const _errs134: any = errors;if(typeof data.projectScopeOffered !== "boolean"){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/projectScopeOffered",schemaPath:"#/oneOf/2/properties/projectScopeOffered/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid17: any = _errs134 === errors;}else {var valid17: any = true;}if(valid17){if(data.createdAt !== undefined){const _errs136: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid17: any = _errs136 === errors;}else {var valid17: any = true;}if(valid17){if(data.updatedAt !== undefined){const _errs137: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid17: any = _errs137 === errors;}else {var valid17: any = true;}if(valid17){if(data.resolvedAt !== undefined){const _errs138: any = errors;if(!(validateWireInstant.call(this, data.resolvedAt, {instancePath:instancePath+"/resolvedAt",parentData:data,parentDataProperty:"resolvedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid17: any = _errs138 === errors;}else {var valid17: any = true;}if(valid17){if(data.decision !== undefined){let data55: any = data.decision;const _errs139: any = errors;if(typeof data55 !== "string"){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/decision",schemaPath:"#/oneOf/2/properties/decision/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data55 === "approved")){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/decision",schemaPath:"#/oneOf/2/properties/decision/enum",keyword:"enum",params:{allowedValues: schema101.oneOf[2].properties.decision.enum}}];return false;}var valid17: any = _errs139 === errors;}else {var valid17: any = true;}if(valid17){if(data.deviceId !== undefined){const _errs141: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid17: any = _errs141 === errors;}else {var valid17: any = true;}if(valid17){if(data.effectiveScope !== undefined){let data57: any = data.effectiveScope;const _errs142: any = errors;if(errors === _errs142){if(typeof data57 === "string"){if(func1(data57) > 4096){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/2/properties/effectiveScope/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data57) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/2/properties/effectiveScope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data57)){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/2/properties/effectiveScope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/2/properties/effectiveScope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid17: any = _errs142 === errors;}else {var valid17: any = true;}if(valid17){if(data.rememberedScope !== undefined){let data58: any = data.rememberedScope;const _errs144: any = errors;if(!(validateRememberedScope.call(this, data58, {instancePath:instancePath+"/rememberedScope",parentData:data,parentDataProperty:"rememberedScope",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRememberedScope.errors : vErrors.concat(validateRememberedScope.errors);errors = vErrors.length;}if(errors === _errs144){if(data58 && typeof data58 == "object" && !Array.isArray(data58)){if(data58.sense !== undefined){if("allow" !== data58.sense){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/rememberedScope/sense",schemaPath:"#/oneOf/2/properties/rememberedScope/properties/sense/const",keyword:"const",params:{allowedValue: "allow"}}];return false;}}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/rememberedScope",schemaPath:"#/oneOf/2/properties/rememberedScope/type",keyword:"type",params:{type: "object"}}];return false;}}var valid17: any = _errs144 === errors;}else {var valid17: any = true;}}}}}}}}}}}}}}}}}}}}}else {validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid16: any = _errs105 === errors;if(props0 !== true){props0 = true;}valid3 = valid16;}else if(tag0 === "rejected"){const _errs147: any = errors;if(errors === _errs147){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if(((((((((((((((((data.state === undefined) && (missing4 = "state")) || ((data.id === undefined) && (missing4 = "id"))) || ((data.holder === undefined) && (missing4 = "holder"))) || ((data.requestedBy === undefined) && (missing4 = "requestedBy"))) || ((data.category === undefined) && (missing4 = "category"))) || ((data.scope === undefined) && (missing4 = "scope"))) || ((data.resourceDescriptor === undefined) && (missing4 = "resourceDescriptor"))) || ((data.subject === undefined) && (missing4 = "subject"))) || ((data.standingAllowOffered === undefined) && (missing4 = "standingAllowOffered"))) || ((data.projectScopeOffered === undefined) && (missing4 = "projectScopeOffered"))) || ((data.createdAt === undefined) && (missing4 = "createdAt"))) || ((data.updatedAt === undefined) && (missing4 = "updatedAt"))) || ((data.resolvedAt === undefined) && (missing4 = "resolvedAt"))) || ((data.decision === undefined) && (missing4 = "decision"))) || ((data.deviceId === undefined) && (missing4 = "deviceId"))) || ((data.effectiveScope === undefined) && (missing4 = "effectiveScope"))){validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs149: any = errors;for(const key9 in data){if(!(func2.call(schema101.oneOf[3].properties, key9))){validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key9}}];return false;break;}}if(_errs149 === errors){if(data.state !== undefined){let data60: any = data.state;const _errs150: any = errors;if(typeof data60 !== "string"){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("rejected" !== data60){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/const",keyword:"const",params:{allowedValue: "rejected"}}];return false;}var valid24: any = _errs150 === errors;}else {var valid24: any = true;}if(valid24){if(data.id !== undefined){const _errs152: any = errors;if(!(validateApprovalRequestId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalRequestId.errors : vErrors.concat(validateApprovalRequestId.errors);errors = vErrors.length;}var valid24: any = _errs152 === errors;}else {var valid24: any = true;}if(valid24){if(data.holder !== undefined){const _errs153: any = errors;if(!(validateApprovalHolder.call(this, data.holder, {instancePath:instancePath+"/holder",parentData:data,parentDataProperty:"holder",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalHolder.errors : vErrors.concat(validateApprovalHolder.errors);errors = vErrors.length;}var valid24: any = _errs153 === errors;}else {var valid24: any = true;}if(valid24){if(data.requestedBy !== undefined){let data63: any = data.requestedBy;const _errs154: any = errors;if(errors === _errs154){if(typeof data63 === "string"){if(func1(data63) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/requestedBy",schemaPath:"#/oneOf/3/properties/requestedBy/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/requestedBy",schemaPath:"#/oneOf/3/properties/requestedBy/type",keyword:"type",params:{type: "string"}}];return false;}}var valid24: any = _errs154 === errors;}else {var valid24: any = true;}if(valid24){if(data.category !== undefined){const _errs156: any = errors;if(!(validateApprovalCategory.call(this, data.category, {instancePath:instancePath+"/category",parentData:data,parentDataProperty:"category",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalCategory.errors : vErrors.concat(validateApprovalCategory.errors);errors = vErrors.length;}var valid24: any = _errs156 === errors;}else {var valid24: any = true;}if(valid24){if(data.scope !== undefined){let data65: any = data.scope;const _errs157: any = errors;if(errors === _errs157){if(typeof data65 === "string"){if(func1(data65) > 4096){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/3/properties/scope/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data65) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/3/properties/scope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data65)){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/3/properties/scope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/3/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid24: any = _errs157 === errors;}else {var valid24: any = true;}if(valid24){if(data.resourceDescriptor !== undefined){let data66: any = data.resourceDescriptor;const _errs159: any = errors;if(errors === _errs159){if(data66 && typeof data66 == "object" && !Array.isArray(data66)){for(const key10 in data66){const _errs161: any = errors;const _errs162: any = errors;if(typeof key10 !== "string"){const err16: any = {instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/oneOf/3/properties/resourceDescriptor/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key10};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}var valid26: any = _errs162 === errors;if(valid26){const _errs164: any = errors;const _errs165: any = errors;const _errs166: any = errors;if("__proto__" !== key10){const err17: any = {};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}var valid27: any = _errs166 === errors;if(valid27){const err18: any = {instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/oneOf/3/properties/resourceDescriptor/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key10};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}else {errors = _errs165;if(vErrors !== null){if(_errs165){vErrors.length = _errs165;}else {vErrors = null;}}}var valid26: any = _errs164 === errors;}var valid25: any = _errs161 === errors;if(!valid25){const err19: any = {instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/oneOf/3/properties/resourceDescriptor/propertyNames",keyword:"propertyNames",params:{propertyName: key10}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;validateApprovalProjectionRow.errors = vErrors;return false;break;}}if(valid25){for(const key11 in data66){const _errs168: any = errors;var valid28: any = _errs168 === errors;if(!valid28){break;}}}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/oneOf/3/properties/resourceDescriptor/type",keyword:"type",params:{type: "object"}}];return false;}}var valid24: any = _errs159 === errors;}else {var valid24: any = true;}if(valid24){if(data.subject !== undefined){let data68: any = data.subject;const _errs170: any = errors;if(errors === _errs170){if(typeof data68 === "string"){if(func1(data68) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/subject",schemaPath:"#/oneOf/3/properties/subject/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/subject",schemaPath:"#/oneOf/3/properties/subject/type",keyword:"type",params:{type: "string"}}];return false;}}var valid24: any = _errs170 === errors;}else {var valid24: any = true;}if(valid24){if(data.reason !== undefined){let data69: any = data.reason;const _errs172: any = errors;if(errors === _errs172){if(typeof data69 === "string"){if(func1(data69) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid24: any = _errs172 === errors;}else {var valid24: any = true;}if(valid24){if(data.standingAllowOffered !== undefined){const _errs174: any = errors;if(typeof data.standingAllowOffered !== "boolean"){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/standingAllowOffered",schemaPath:"#/oneOf/3/properties/standingAllowOffered/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid24: any = _errs174 === errors;}else {var valid24: any = true;}if(valid24){if(data.projectScopeOffered !== undefined){const _errs176: any = errors;if(typeof data.projectScopeOffered !== "boolean"){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/projectScopeOffered",schemaPath:"#/oneOf/3/properties/projectScopeOffered/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid24: any = _errs176 === errors;}else {var valid24: any = true;}if(valid24){if(data.createdAt !== undefined){const _errs178: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid24: any = _errs178 === errors;}else {var valid24: any = true;}if(valid24){if(data.updatedAt !== undefined){const _errs179: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid24: any = _errs179 === errors;}else {var valid24: any = true;}if(valid24){if(data.resolvedAt !== undefined){const _errs180: any = errors;if(!(validateWireInstant.call(this, data.resolvedAt, {instancePath:instancePath+"/resolvedAt",parentData:data,parentDataProperty:"resolvedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid24: any = _errs180 === errors;}else {var valid24: any = true;}if(valid24){if(data.decision !== undefined){let data75: any = data.decision;const _errs181: any = errors;if(typeof data75 !== "string"){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/decision",schemaPath:"#/oneOf/3/properties/decision/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data75 === "rejected")){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/decision",schemaPath:"#/oneOf/3/properties/decision/enum",keyword:"enum",params:{allowedValues: schema101.oneOf[3].properties.decision.enum}}];return false;}var valid24: any = _errs181 === errors;}else {var valid24: any = true;}if(valid24){if(data.deviceId !== undefined){const _errs183: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid24: any = _errs183 === errors;}else {var valid24: any = true;}if(valid24){if(data.effectiveScope !== undefined){let data77: any = data.effectiveScope;const _errs184: any = errors;if(errors === _errs184){if(typeof data77 === "string"){if(func1(data77) > 4096){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/3/properties/effectiveScope/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data77) < 1){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/3/properties/effectiveScope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data77)){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/3/properties/effectiveScope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/oneOf/3/properties/effectiveScope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid24: any = _errs184 === errors;}else {var valid24: any = true;}if(valid24){if(data.rememberedScope !== undefined){let data78: any = data.rememberedScope;const _errs186: any = errors;if(!(validateRememberedScope.call(this, data78, {instancePath:instancePath+"/rememberedScope",parentData:data,parentDataProperty:"rememberedScope",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRememberedScope.errors : vErrors.concat(validateRememberedScope.errors);errors = vErrors.length;}if(errors === _errs186){if(data78 && typeof data78 == "object" && !Array.isArray(data78)){if(data78.sense !== undefined){if("block" !== data78.sense){validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/rememberedScope/sense",schemaPath:"#/oneOf/3/properties/rememberedScope/properties/sense/const",keyword:"const",params:{allowedValue: "block"}}];return false;}}}else {validateApprovalProjectionRow.errors = [{instancePath:instancePath+"/rememberedScope",schemaPath:"#/oneOf/3/properties/rememberedScope/type",keyword:"type",params:{type: "object"}}];return false;}}var valid24: any = _errs186 === errors;}else {var valid24: any = true;}}}}}}}}}}}}}}}}}}}}}else {validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid23: any = _errs147 === errors;if(props0 !== true){props0 = true;}valid3 = valid23;}else {validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}if(valid3){if(props0 !== true){for(const key12 in data){if(!props0 || !props0[key12]){validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key12}}];return false;break;}}}}}else {validateApprovalProjectionRow.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalProjectionRow.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalProjectionRow.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ApprovalListResponse}. */
// prettier-ignore
export const validateApprovalListResponse: CompiledSchemaCheck<ApprovalListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.approvals === undefined) && (missing0 = "approvals")){validateApprovalListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "approvals")){validateApprovalListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.approvals !== undefined){let data0: any = data.approvals;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateApprovalProjectionRow.call(this, data0[i0], {instancePath:instancePath+"/approvals/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalProjectionRow.errors : vErrors.concat(validateApprovalProjectionRow.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateApprovalListResponse.errors = [{instancePath:instancePath+"/approvals",schemaPath:"#/properties/approvals/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateApprovalListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ApprovalRuleListRequest}. */
// prettier-ignore
export const validateApprovalRuleListRequest: CompiledSchemaCheck<ApprovalRuleListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalRuleListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalRuleListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateApprovalRuleListRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateApprovalRuleListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateApprovalRuleListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalRuleListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalRuleListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RememberedRule}. */
// prettier-ignore
export const validateRememberedRule: CompiledSchemaCheck<RememberedRule> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RememberedRule {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRememberedRule.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.ruleId === undefined) && (missing0 = "ruleId")) || ((data.category === undefined) && (missing0 = "category"))) || ((data.scope === undefined) && (missing0 = "scope"))) || ((data.grantedAt === undefined) && (missing0 = "grantedAt"))){validateRememberedRule.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "ruleId") || (key0 === "category")) || (key0 === "scope")) || (key0 === "grantedAt"))){validateRememberedRule.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.ruleId !== undefined){const _errs2: any = errors;if(!(validateRememberedRuleId.call(this, data.ruleId, {instancePath:instancePath+"/ruleId",parentData:data,parentDataProperty:"ruleId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRememberedRuleId.errors : vErrors.concat(validateRememberedRuleId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.category !== undefined){const _errs3: any = errors;if(!(validateApprovalCategory.call(this, data.category, {instancePath:instancePath+"/category",parentData:data,parentDataProperty:"category",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalCategory.errors : vErrors.concat(validateApprovalCategory.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.scope !== undefined){const _errs4: any = errors;if(!(validateRememberedScope.call(this, data.scope, {instancePath:instancePath+"/scope",parentData:data,parentDataProperty:"scope",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRememberedScope.errors : vErrors.concat(validateRememberedScope.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.grantedAt !== undefined){const _errs5: any = errors;if(!(validateWireInstant.call(this, data.grantedAt, {instancePath:instancePath+"/grantedAt",parentData:data,parentDataProperty:"grantedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}}else {validateRememberedRule.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateRememberedRule.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRememberedRule.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ApprovalRuleListResponse}. */
// prettier-ignore
export const validateApprovalRuleListResponse: CompiledSchemaCheck<ApprovalRuleListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalRuleListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalRuleListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.rules === undefined) && (missing0 = "rules")){validateApprovalRuleListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "rules")){validateApprovalRuleListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.rules !== undefined){let data0: any = data.rules;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateRememberedRule.call(this, data0[i0], {instancePath:instancePath+"/rules/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRememberedRule.errors : vErrors.concat(validateRememberedRule.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateApprovalRuleListResponse.errors = [{instancePath:instancePath+"/rules",schemaPath:"#/properties/rules/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateApprovalRuleListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalRuleListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalRuleListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ApprovalRuleRevokeRequest}. */
// prettier-ignore
export const validateApprovalRuleRevokeRequest: CompiledSchemaCheck<ApprovalRuleRevokeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalRuleRevokeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalRuleRevokeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.ruleId === undefined) && (missing0 = "ruleId")){validateApprovalRuleRevokeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "ruleId")){validateApprovalRuleRevokeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.ruleId !== undefined){if(!(validateRememberedRuleId.call(this, data.ruleId, {instancePath:instancePath+"/ruleId",parentData:data,parentDataProperty:"ruleId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRememberedRuleId.errors : vErrors.concat(validateRememberedRuleId.errors);errors = vErrors.length;}}}}}else {validateApprovalRuleRevokeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalRuleRevokeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalRuleRevokeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema118: any = {"type":"object","additionalProperties":false,"properties":{"ruleId":{"$ref":"#/$defs/RememberedRuleId","description":"The rule."},"revokedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When."},"invalidationTrigger":{"description":"Always `explicit`.","type":"string","enum":["explicit"]}},"required":["ruleId","revokedAt","invalidationTrigger"],"description":"A revocation's receipt. A revocation through this call is always `explicit`."};
/** Checks that a value is a {@link ApprovalRuleRevokeResponse}. */
// prettier-ignore
export const validateApprovalRuleRevokeResponse: CompiledSchemaCheck<ApprovalRuleRevokeResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalRuleRevokeResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalRuleRevokeResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.ruleId === undefined) && (missing0 = "ruleId")) || ((data.revokedAt === undefined) && (missing0 = "revokedAt"))) || ((data.invalidationTrigger === undefined) && (missing0 = "invalidationTrigger"))){validateApprovalRuleRevokeResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "ruleId") || (key0 === "revokedAt")) || (key0 === "invalidationTrigger"))){validateApprovalRuleRevokeResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.ruleId !== undefined){const _errs2: any = errors;if(!(validateRememberedRuleId.call(this, data.ruleId, {instancePath:instancePath+"/ruleId",parentData:data,parentDataProperty:"ruleId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRememberedRuleId.errors : vErrors.concat(validateRememberedRuleId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.revokedAt !== undefined){const _errs3: any = errors;if(!(validateWireInstant.call(this, data.revokedAt, {instancePath:instancePath+"/revokedAt",parentData:data,parentDataProperty:"revokedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.invalidationTrigger !== undefined){let data2: any = data.invalidationTrigger;const _errs4: any = errors;if(typeof data2 !== "string"){validateApprovalRuleRevokeResponse.errors = [{instancePath:instancePath+"/invalidationTrigger",schemaPath:"#/properties/invalidationTrigger/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data2 === "explicit")){validateApprovalRuleRevokeResponse.errors = [{instancePath:instancePath+"/invalidationTrigger",schemaPath:"#/properties/invalidationTrigger/enum",keyword:"enum",params:{allowedValues: schema118.properties.invalidationTrigger.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateApprovalRuleRevokeResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalRuleRevokeResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalRuleRevokeResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ApprovalDenialOverrideRequest}. */
// prettier-ignore
export const validateApprovalDenialOverrideRequest: CompiledSchemaCheck<ApprovalDenialOverrideRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalDenialOverrideRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalDenialOverrideRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.denialId === undefined) && (missing0 = "denialId"))){validateApprovalDenialOverrideRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "denialId"))){validateApprovalDenialOverrideRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.denialId !== undefined){const _errs3: any = errors;if(!(validateReviewerDenialId.call(this, data.denialId, {instancePath:instancePath+"/denialId",parentData:data,parentDataProperty:"denialId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewerDenialId.errors : vErrors.concat(validateReviewerDenialId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateApprovalDenialOverrideRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalDenialOverrideRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalDenialOverrideRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ApprovalDenialOverrideResponse}. */
// prettier-ignore
export const validateApprovalDenialOverrideResponse: CompiledSchemaCheck<ApprovalDenialOverrideResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalDenialOverrideResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalDenialOverrideResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.denialId === undefined) && (missing0 = "denialId")) || ((data.overriddenAt === undefined) && (missing0 = "overriddenAt"))){validateApprovalDenialOverrideResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "denialId") || (key0 === "overriddenAt"))){validateApprovalDenialOverrideResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.denialId !== undefined){const _errs2: any = errors;if(!(validateReviewerDenialId.call(this, data.denialId, {instancePath:instancePath+"/denialId",parentData:data,parentDataProperty:"denialId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewerDenialId.errors : vErrors.concat(validateReviewerDenialId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.overriddenAt !== undefined){const _errs3: any = errors;if(!(validateWireInstant.call(this, data.overriddenAt, {instancePath:instancePath+"/overriddenAt",parentData:data,parentDataProperty:"overriddenAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateApprovalDenialOverrideResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalDenialOverrideResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalDenialOverrideResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema105: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"holder":{"$ref":"#/$defs/ApprovalHolder","description":"What holds it open: an agent run or a workflow wait."},"approvalRequestId":{"$ref":"#/$defs/ApprovalRequestId","description":"The ask."},"category":{"$ref":"#/$defs/ApprovalCategory","description":"What it is about."},"scope":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":4096,"description":"Its target scope."},"requestedBy":{"type":"string","minLength":1,"description":"Who asked."},"resourceDescriptor":{"type":"object","propertyNames":{"allOf":[{"type":"string"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"tsType":"unknown"},"description":"What it would touch."},"askId":{"type":"string","minLength":1,"description":"The daemon's durable id for a provider's permission ask."},"toolCallId":{"$ref":"sidekicks-contracts:provider/tool-call#/$defs/ToolCallId","description":"The tool call the ask holds, bounded as the tool rows bound it."},"inputDigest":{"$ref":"sidekicks-contracts:release-manifest#/$defs/Sha256Hex","description":"The SHA-256 of the asked call's tool name and input as canonical JSON, by which a call made\nagain after a restart finds this card; absent where the input has no canonical form or the\ncard has no call."}},"required":["sessionId","holder","approvalRequestId","category","scope","requestedBy","resourceDescriptor"],"description":"The `approval.requested` payload. `holder` names the agent run whose action it gates or the\nworkflow wait that asks. `askId` is present when the request is a provider's\npermission ask: the daemon's own durable id for the ask, so an answer reaches the right ask\nafter a restart when several are open on one run. `toolCallId` names the tool call the ask\nholds, so that call's row draws its held mark and `Declined`; `inputDigest` fingerprints the\ncall's tool name and input. The ask's tool name and the provider's prompt text ride\n`resourceDescriptor`."};
/** Checks that a value is a {@link ApprovalRequestedPayload}. */
// prettier-ignore
export const validateApprovalRequestedPayload: CompiledSchemaCheck<ApprovalRequestedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalRequestedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalRequestedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.holder === undefined) && (missing0 = "holder"))) || ((data.approvalRequestId === undefined) && (missing0 = "approvalRequestId"))) || ((data.category === undefined) && (missing0 = "category"))) || ((data.scope === undefined) && (missing0 = "scope"))) || ((data.requestedBy === undefined) && (missing0 = "requestedBy"))) || ((data.resourceDescriptor === undefined) && (missing0 = "resourceDescriptor"))){validateApprovalRequestedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema105.properties, key0))){validateApprovalRequestedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.holder !== undefined){const _errs3: any = errors;if(!(validateApprovalHolder.call(this, data.holder, {instancePath:instancePath+"/holder",parentData:data,parentDataProperty:"holder",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalHolder.errors : vErrors.concat(validateApprovalHolder.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.approvalRequestId !== undefined){const _errs4: any = errors;if(!(validateApprovalRequestId.call(this, data.approvalRequestId, {instancePath:instancePath+"/approvalRequestId",parentData:data,parentDataProperty:"approvalRequestId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalRequestId.errors : vErrors.concat(validateApprovalRequestId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.category !== undefined){const _errs5: any = errors;if(!(validateApprovalCategory.call(this, data.category, {instancePath:instancePath+"/category",parentData:data,parentDataProperty:"category",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalCategory.errors : vErrors.concat(validateApprovalCategory.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.scope !== undefined){let data4: any = data.scope;const _errs6: any = errors;if(errors === _errs6){if(typeof data4 === "string"){if(func1(data4) > 4096){validateApprovalRequestedPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data4) < 1){validateApprovalRequestedPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data4)){validateApprovalRequestedPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateApprovalRequestedPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.requestedBy !== undefined){let data5: any = data.requestedBy;const _errs8: any = errors;if(errors === _errs8){if(typeof data5 === "string"){if(func1(data5) < 1){validateApprovalRequestedPayload.errors = [{instancePath:instancePath+"/requestedBy",schemaPath:"#/properties/requestedBy/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalRequestedPayload.errors = [{instancePath:instancePath+"/requestedBy",schemaPath:"#/properties/requestedBy/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.resourceDescriptor !== undefined){let data6: any = data.resourceDescriptor;const _errs10: any = errors;if(errors === _errs10){if(data6 && typeof data6 == "object" && !Array.isArray(data6)){for(const key1 in data6){const _errs12: any = errors;const _errs13: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/properties/resourceDescriptor/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid2: any = _errs13 === errors;if(valid2){const _errs15: any = errors;const _errs16: any = errors;const _errs17: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid3: any = _errs17 === errors;if(valid3){const err2: any = {instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/properties/resourceDescriptor/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs16;if(vErrors !== null){if(_errs16){vErrors.length = _errs16;}else {vErrors = null;}}}var valid2: any = _errs15 === errors;}var valid1: any = _errs12 === errors;if(!valid1){const err3: any = {instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/properties/resourceDescriptor/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateApprovalRequestedPayload.errors = vErrors;return false;break;}}if(valid1){for(const key2 in data6){const _errs19: any = errors;var valid4: any = _errs19 === errors;if(!valid4){break;}}}}else {validateApprovalRequestedPayload.errors = [{instancePath:instancePath+"/resourceDescriptor",schemaPath:"#/properties/resourceDescriptor/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.askId !== undefined){let data8: any = data.askId;const _errs21: any = errors;if(errors === _errs21){if(typeof data8 === "string"){if(func1(data8) < 1){validateApprovalRequestedPayload.errors = [{instancePath:instancePath+"/askId",schemaPath:"#/properties/askId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalRequestedPayload.errors = [{instancePath:instancePath+"/askId",schemaPath:"#/properties/askId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs21 === errors;}else {var valid0: any = true;}if(valid0){if(data.toolCallId !== undefined){const _errs23: any = errors;if(!(validateToolCallId.call(this, data.toolCallId, {instancePath:instancePath+"/toolCallId",parentData:data,parentDataProperty:"toolCallId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateToolCallId.errors : vErrors.concat(validateToolCallId.errors);errors = vErrors.length;}var valid0: any = _errs23 === errors;}else {var valid0: any = true;}if(valid0){if(data.inputDigest !== undefined){const _errs24: any = errors;if(!(validateSha256Hex.call(this, data.inputDigest, {instancePath:instancePath+"/inputDigest",parentData:data,parentDataProperty:"inputDigest",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSha256Hex.errors : vErrors.concat(validateSha256Hex.errors);errors = vErrors.length;}var valid0: any = _errs24 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}else {validateApprovalRequestedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalRequestedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalRequestedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema110: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"holder":{"$ref":"#/$defs/ApprovalHolder","description":"What held it open."},"approvalRequestId":{"$ref":"#/$defs/ApprovalRequestId","description":"The ask."},"category":{"$ref":"#/$defs/ApprovalCategory","description":"What it is about."},"scope":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":4096,"description":"Its target scope."},"effectiveScope":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":4096,"description":"The recorded scope."},"deviceId":{"$ref":"sidekicks-contracts:trust-statement#/$defs/DeviceId","description":"The device that answered."},"clientResolutionId":{"type":"string","pattern":"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$","description":"The id the answering client minted."},"rememberedScope":{"$ref":"#/$defs/RememberedScope","description":"The rule the person asked to keep with the answer, so a rebuild and a resend record the\nrule asked for even when its own event was never written."},"declineReason":{"type":"string","minLength":1,"description":"The `why not` words, which go back to the agent; only on `approval.rejected`."},"editedAction":{"type":"string","minLength":1,"description":"The corrected command or path, which is what runs; only on `approval.approved`."}},"required":["sessionId","holder","approvalRequestId","category","scope","effectiveScope","deviceId","clientResolutionId"],"description":"The `approval.approved` and `approval.rejected` payload: the answer, the device it came from,\nthe id the answering client minted, on an approval the command or path as the person corrected\nit, and on a decline the words the person gave."};
/** Checks that a value is a {@link ApprovalResolvedPayload}. */
// prettier-ignore
export const validateApprovalResolvedPayload: CompiledSchemaCheck<ApprovalResolvedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalResolvedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalResolvedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.holder === undefined) && (missing0 = "holder"))) || ((data.approvalRequestId === undefined) && (missing0 = "approvalRequestId"))) || ((data.category === undefined) && (missing0 = "category"))) || ((data.scope === undefined) && (missing0 = "scope"))) || ((data.effectiveScope === undefined) && (missing0 = "effectiveScope"))) || ((data.deviceId === undefined) && (missing0 = "deviceId"))) || ((data.clientResolutionId === undefined) && (missing0 = "clientResolutionId"))){validateApprovalResolvedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema110.properties, key0))){validateApprovalResolvedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.holder !== undefined){const _errs3: any = errors;if(!(validateApprovalHolder.call(this, data.holder, {instancePath:instancePath+"/holder",parentData:data,parentDataProperty:"holder",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalHolder.errors : vErrors.concat(validateApprovalHolder.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.approvalRequestId !== undefined){const _errs4: any = errors;if(!(validateApprovalRequestId.call(this, data.approvalRequestId, {instancePath:instancePath+"/approvalRequestId",parentData:data,parentDataProperty:"approvalRequestId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalRequestId.errors : vErrors.concat(validateApprovalRequestId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.category !== undefined){const _errs5: any = errors;if(!(validateApprovalCategory.call(this, data.category, {instancePath:instancePath+"/category",parentData:data,parentDataProperty:"category",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalCategory.errors : vErrors.concat(validateApprovalCategory.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.scope !== undefined){let data4: any = data.scope;const _errs6: any = errors;if(errors === _errs6){if(typeof data4 === "string"){if(func1(data4) > 4096){validateApprovalResolvedPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data4) < 1){validateApprovalResolvedPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data4)){validateApprovalResolvedPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateApprovalResolvedPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.effectiveScope !== undefined){let data5: any = data.effectiveScope;const _errs8: any = errors;if(errors === _errs8){if(typeof data5 === "string"){if(func1(data5) > 4096){validateApprovalResolvedPayload.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/properties/effectiveScope/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data5) < 1){validateApprovalResolvedPayload.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/properties/effectiveScope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data5)){validateApprovalResolvedPayload.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/properties/effectiveScope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateApprovalResolvedPayload.errors = [{instancePath:instancePath+"/effectiveScope",schemaPath:"#/properties/effectiveScope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){const _errs10: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientResolutionId !== undefined){let data7: any = data.clientResolutionId;const _errs11: any = errors;if(errors === _errs11){if(typeof data7 === "string"){if(!pattern88.test(data7)){validateApprovalResolvedPayload.errors = [{instancePath:instancePath+"/clientResolutionId",schemaPath:"#/properties/clientResolutionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateApprovalResolvedPayload.errors = [{instancePath:instancePath+"/clientResolutionId",schemaPath:"#/properties/clientResolutionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.rememberedScope !== undefined){const _errs13: any = errors;if(!(validateRememberedScope.call(this, data.rememberedScope, {instancePath:instancePath+"/rememberedScope",parentData:data,parentDataProperty:"rememberedScope",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRememberedScope.errors : vErrors.concat(validateRememberedScope.errors);errors = vErrors.length;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.declineReason !== undefined){let data9: any = data.declineReason;const _errs14: any = errors;if(errors === _errs14){if(typeof data9 === "string"){if(func1(data9) < 1){validateApprovalResolvedPayload.errors = [{instancePath:instancePath+"/declineReason",schemaPath:"#/properties/declineReason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalResolvedPayload.errors = [{instancePath:instancePath+"/declineReason",schemaPath:"#/properties/declineReason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.editedAction !== undefined){let data10: any = data.editedAction;const _errs16: any = errors;if(errors === _errs16){if(typeof data10 === "string"){if(func1(data10) < 1){validateApprovalResolvedPayload.errors = [{instancePath:instancePath+"/editedAction",schemaPath:"#/properties/editedAction/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalResolvedPayload.errors = [{instancePath:instancePath+"/editedAction",schemaPath:"#/properties/editedAction/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}else {validateApprovalResolvedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalResolvedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalResolvedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ApprovalCanceledPayload}. */
// prettier-ignore
export const validateApprovalCanceledPayload: CompiledSchemaCheck<ApprovalCanceledPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalCanceledPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalCanceledPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.holder === undefined) && (missing0 = "holder"))) || ((data.approvalRequestId === undefined) && (missing0 = "approvalRequestId"))) || ((data.category === undefined) && (missing0 = "category"))) || ((data.scope === undefined) && (missing0 = "scope"))){validateApprovalCanceledPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "sessionId") || (key0 === "holder")) || (key0 === "approvalRequestId")) || (key0 === "category")) || (key0 === "scope"))){validateApprovalCanceledPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.holder !== undefined){const _errs3: any = errors;if(!(validateApprovalHolder.call(this, data.holder, {instancePath:instancePath+"/holder",parentData:data,parentDataProperty:"holder",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalHolder.errors : vErrors.concat(validateApprovalHolder.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.approvalRequestId !== undefined){const _errs4: any = errors;if(!(validateApprovalRequestId.call(this, data.approvalRequestId, {instancePath:instancePath+"/approvalRequestId",parentData:data,parentDataProperty:"approvalRequestId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalRequestId.errors : vErrors.concat(validateApprovalRequestId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.category !== undefined){const _errs5: any = errors;if(!(validateApprovalCategory.call(this, data.category, {instancePath:instancePath+"/category",parentData:data,parentDataProperty:"category",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalCategory.errors : vErrors.concat(validateApprovalCategory.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.scope !== undefined){let data4: any = data.scope;const _errs6: any = errors;if(errors === _errs6){if(typeof data4 === "string"){if(func1(data4) > 4096){validateApprovalCanceledPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data4) < 1){validateApprovalCanceledPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data4)){validateApprovalCanceledPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateApprovalCanceledPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}}else {validateApprovalCanceledPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalCanceledPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalCanceledPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ApprovalRuleRememberedPayload}. */
// prettier-ignore
export const validateApprovalRuleRememberedPayload: CompiledSchemaCheck<ApprovalRuleRememberedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalRuleRememberedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalRuleRememberedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.approvalRequestId === undefined) && (missing0 = "approvalRequestId"))) || ((data.category === undefined) && (missing0 = "category"))) || ((data.scope === undefined) && (missing0 = "scope"))) || ((data.machineId === undefined) && (missing0 = "machineId"))) || ((data.ruleId === undefined) && (missing0 = "ruleId"))) || ((data.rememberedScope === undefined) && (missing0 = "rememberedScope"))){validateApprovalRuleRememberedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "approvalRequestId")) || (key0 === "category")) || (key0 === "scope")) || (key0 === "machineId")) || (key0 === "ruleId")) || (key0 === "rememberedScope"))){validateApprovalRuleRememberedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.approvalRequestId !== undefined){const _errs4: any = errors;if(!(validateApprovalRequestId.call(this, data.approvalRequestId, {instancePath:instancePath+"/approvalRequestId",parentData:data,parentDataProperty:"approvalRequestId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalRequestId.errors : vErrors.concat(validateApprovalRequestId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.category !== undefined){const _errs5: any = errors;if(!(validateApprovalCategory.call(this, data.category, {instancePath:instancePath+"/category",parentData:data,parentDataProperty:"category",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalCategory.errors : vErrors.concat(validateApprovalCategory.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.scope !== undefined){let data4: any = data.scope;const _errs6: any = errors;if(errors === _errs6){if(typeof data4 === "string"){if(func1(data4) > 4096){validateApprovalRuleRememberedPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data4) < 1){validateApprovalRuleRememberedPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data4)){validateApprovalRuleRememberedPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateApprovalRuleRememberedPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.machineId !== undefined){const _errs8: any = errors;if(!(validateMachineId.call(this, data.machineId, {instancePath:instancePath+"/machineId",parentData:data,parentDataProperty:"machineId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineId.errors : vErrors.concat(validateMachineId.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.ruleId !== undefined){const _errs9: any = errors;if(!(validateRememberedRuleId.call(this, data.ruleId, {instancePath:instancePath+"/ruleId",parentData:data,parentDataProperty:"ruleId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRememberedRuleId.errors : vErrors.concat(validateRememberedRuleId.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.rememberedScope !== undefined){const _errs10: any = errors;if(!(validateRememberedScope.call(this, data.rememberedScope, {instancePath:instancePath+"/rememberedScope",parentData:data,parentDataProperty:"rememberedScope",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRememberedScope.errors : vErrors.concat(validateRememberedScope.errors);errors = vErrors.length;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}}}}}else {validateApprovalRuleRememberedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalRuleRememberedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalRuleRememberedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ApprovalRuleRevokedPayload}. */
// prettier-ignore
export const validateApprovalRuleRevokedPayload: CompiledSchemaCheck<ApprovalRuleRevokedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalRuleRevokedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalRuleRevokedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.category === undefined) && (missing0 = "category"))) || ((data.scope === undefined) && (missing0 = "scope"))) || ((data.ruleId === undefined) && (missing0 = "ruleId"))) || ((data.invalidationTrigger === undefined) && (missing0 = "invalidationTrigger"))){validateApprovalRuleRevokedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "sessionId") || (key0 === "category")) || (key0 === "scope")) || (key0 === "ruleId")) || (key0 === "invalidationTrigger")) || (key0 === "runId")) || (key0 === "approvalRequestId"))){validateApprovalRuleRevokedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.category !== undefined){const _errs3: any = errors;if(!(validateApprovalCategory.call(this, data.category, {instancePath:instancePath+"/category",parentData:data,parentDataProperty:"category",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalCategory.errors : vErrors.concat(validateApprovalCategory.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.scope !== undefined){let data2: any = data.scope;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) > 4096){validateApprovalRuleRevokedPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validateApprovalRuleRevokedPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateApprovalRuleRevokedPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateApprovalRuleRevokedPayload.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.ruleId !== undefined){const _errs6: any = errors;if(!(validateRememberedRuleId.call(this, data.ruleId, {instancePath:instancePath+"/ruleId",parentData:data,parentDataProperty:"ruleId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRememberedRuleId.errors : vErrors.concat(validateRememberedRuleId.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.invalidationTrigger !== undefined){const _errs7: any = errors;if(!(validateInvalidationTrigger.call(this, data.invalidationTrigger, {instancePath:instancePath+"/invalidationTrigger",parentData:data,parentDataProperty:"invalidationTrigger",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateInvalidationTrigger.errors : vErrors.concat(validateInvalidationTrigger.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs8: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.approvalRequestId !== undefined){const _errs9: any = errors;if(!(validateApprovalRequestId.call(this, data.approvalRequestId, {instancePath:instancePath+"/approvalRequestId",parentData:data,parentDataProperty:"approvalRequestId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateApprovalRequestId.errors : vErrors.concat(validateApprovalRequestId.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validateApprovalRuleRevokedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalRuleRevokedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalRuleRevokedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ApprovalReviewerDeniedPayload}. */
// prettier-ignore
export const validateApprovalReviewerDeniedPayload: CompiledSchemaCheck<ApprovalReviewerDeniedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalReviewerDeniedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalReviewerDeniedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.agentId === undefined) && (missing0 = "agentId"))) || ((data.denialId === undefined) && (missing0 = "denialId"))) || ((data.overridable === undefined) && (missing0 = "overridable"))){validateApprovalReviewerDeniedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "agentId")) || (key0 === "denialId")) || (key0 === "eventId")) || (key0 === "reason")) || (key0 === "overridable"))){validateApprovalReviewerDeniedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.agentId !== undefined){const _errs4: any = errors;if(!(validateAgentId.call(this, data.agentId, {instancePath:instancePath+"/agentId",parentData:data,parentDataProperty:"agentId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAgentId.errors : vErrors.concat(validateAgentId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.denialId !== undefined){const _errs5: any = errors;if(!(validateReviewerDenialId.call(this, data.denialId, {instancePath:instancePath+"/denialId",parentData:data,parentDataProperty:"denialId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewerDenialId.errors : vErrors.concat(validateReviewerDenialId.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.eventId !== undefined){let data4: any = data.eventId;const _errs6: any = errors;if(errors === _errs6){if(typeof data4 === "string"){if(func1(data4) < 1){validateApprovalReviewerDeniedPayload.errors = [{instancePath:instancePath+"/eventId",schemaPath:"#/properties/eventId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalReviewerDeniedPayload.errors = [{instancePath:instancePath+"/eventId",schemaPath:"#/properties/eventId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){let data5: any = data.reason;const _errs8: any = errors;if(errors === _errs8){if(typeof data5 === "string"){if(func1(data5) < 1){validateApprovalReviewerDeniedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateApprovalReviewerDeniedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.overridable !== undefined){const _errs10: any = errors;if(typeof data.overridable !== "boolean"){validateApprovalReviewerDeniedPayload.errors = [{instancePath:instancePath+"/overridable",schemaPath:"#/properties/overridable/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validateApprovalReviewerDeniedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalReviewerDeniedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalReviewerDeniedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ApprovalDenialOverriddenPayload}. */
// prettier-ignore
export const validateApprovalDenialOverriddenPayload: CompiledSchemaCheck<ApprovalDenialOverriddenPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ApprovalDenialOverriddenPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateApprovalDenialOverriddenPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.denialId === undefined) && (missing0 = "denialId"))){validateApprovalDenialOverriddenPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "denialId"))){validateApprovalDenialOverriddenPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.denialId !== undefined){const _errs3: any = errors;if(!(validateReviewerDenialId.call(this, data.denialId, {instancePath:instancePath+"/denialId",parentData:data,parentDataProperty:"denialId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateReviewerDenialId.errors : vErrors.concat(validateReviewerDenialId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateApprovalDenialOverriddenPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateApprovalDenialOverriddenPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateApprovalDenialOverriddenPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link APPROVAL_METHOD_DESCRIPTORS}, each with its checks. */
export interface ApprovalMethodDescriptors {
  readonly "approval.resolve": {
    readonly method: "approval.resolve";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ApprovalResolveRequest>;
    readonly responseCheck: SchemaCheck<ApprovalResolveResponse>;
  };
  readonly "approval.list": {
    readonly method: "approval.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ApprovalListRequest>;
    readonly responseCheck: SchemaCheck<ApprovalListResponse>;
  };
  readonly "approval.rule.list": {
    readonly method: "approval.rule.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ApprovalRuleListRequest>;
    readonly responseCheck: SchemaCheck<ApprovalRuleListResponse>;
  };
  readonly "approval.rule.revoke": {
    readonly method: "approval.rule.revoke";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ApprovalRuleRevokeRequest>;
    readonly responseCheck: SchemaCheck<ApprovalRuleRevokeResponse>;
  };
  readonly "approval.denial.override": {
    readonly method: "approval.denial.override";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ApprovalDenialOverrideRequest>;
    readonly responseCheck: SchemaCheck<ApprovalDenialOverrideResponse>;
  };
}
/** The `approval.*` methods a client calls. */
export const APPROVAL_METHOD_DESCRIPTORS: ApprovalMethodDescriptors = Object.freeze({
  "approval.resolve": Object.freeze({
    method: "approval.resolve",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateApprovalResolveRequest,
    responseCheck: validateApprovalResolveResponse,
  }),
  "approval.list": Object.freeze({
    method: "approval.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateApprovalListRequest,
    responseCheck: validateApprovalListResponse,
  }),
  "approval.rule.list": Object.freeze({
    method: "approval.rule.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateApprovalRuleListRequest,
    responseCheck: validateApprovalRuleListResponse,
  }),
  "approval.rule.revoke": Object.freeze({
    method: "approval.rule.revoke",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateApprovalRuleRevokeRequest,
    responseCheck: validateApprovalRuleRevokeResponse,
  }),
  "approval.denial.override": Object.freeze({
    method: "approval.denial.override",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateApprovalDenialOverrideRequest,
    responseCheck: validateApprovalDenialOverrideResponse,
  }),
});
