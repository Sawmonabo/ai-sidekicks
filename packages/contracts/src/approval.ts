// The approval surface: the calls that answer an agent's ask, list the pending asks, list and
// revoke the remembered rules, and allow once an action the provider's own reviewer blocked,
// with the payloads of the `approval.*` events the daemon records for each.
//
// The daemon raises every ask itself from a provider's callback, so no client creates one. An
// ask is held with no timer until it is answered or its run ends, so nothing here names an
// expiry.
//
// A remembered rule is the daemon's, kept in its own store and evaluated before the permission
// level's default. It is never written into a provider's own rule files, so its scope is this
// session or this project and nothing narrower or wider.
//
// This file imports nothing from `event.ts`: that module imports the payload schemas below, and
// an import back would close an eager module cycle.
import { z } from "zod";

import { brandedUuidIdSchema, uuidTextFormSchema } from "./internal/branded.js";
import type { MethodDescriptor } from "./method-descriptor.js";
import { defineMethodDescriptors } from "./method-descriptor.js";
import { NodeIdSchema, type NodeId } from "./node-id.js";
import { RunIdSchema, type RunId } from "./provider-driver.js";
import {
  FILE_PATH_MAX_LEN,
  SessionIdSchema,
  UserIdSchema,
  wireFreeFormString,
  type SessionId,
  type UserId,
} from "./session.js";
import { ExecutionPostureModeSchema, type ExecutionPostureMode } from "./session-controls.js";

/**
 * An ask's target scope, free text such as a command or a path. Bounded by the longest wire
 * string, a file path, and refused empty, blank or with a NUL byte.
 */
const approvalScopeSchema = (fieldLabel: string): z.ZodString =>
  wireFreeFormString(FILE_PATH_MAX_LEN, fieldLabel);

// Ids

/** The daemon-minted id of one ask. */
export type ApprovalRequestId = string & { readonly __brand: "ApprovalRequestId" };
/** Parses an {@link ApprovalRequestId}. */
export const ApprovalRequestIdSchema: z.ZodType<ApprovalRequestId, ApprovalRequestId> =
  brandedUuidIdSchema<ApprovalRequestId>("ApprovalRequestId");

/** The daemon-minted id of one remembered rule. */
export type RememberedRuleId = string & { readonly __brand: "RememberedRuleId" };
/** Parses a {@link RememberedRuleId}. */
export const RememberedRuleIdSchema: z.ZodType<RememberedRuleId, RememberedRuleId> =
  brandedUuidIdSchema<RememberedRuleId>("RememberedRuleId");

/** The daemon-minted id of one block by a provider's own reviewer. */
export type ReviewerDenialId = string & { readonly __brand: "ReviewerDenialId" };
/** Parses a {@link ReviewerDenialId}. */
export const ReviewerDenialIdSchema: z.ZodType<ReviewerDenialId, ReviewerDenialId> =
  brandedUuidIdSchema<ReviewerDenialId>("ReviewerDenialId");

// Closed vocabularies

const APPROVAL_CATEGORY_VALUES = [
  "tool_execution",
  "file_write",
  "network_access",
  "destructive_git",
  "plan_approval",
  "gate",
  "human_phase_contribution",
] as const;

/**
 * What an ask is about. An agent's question and a tool server's question are not
 * asks: they are the one question record, so neither is a category here.
 */
export type ApprovalCategory = (typeof APPROVAL_CATEGORY_VALUES)[number];
/** Every {@link ApprovalCategory}. */
export const APPROVAL_CATEGORIES: readonly ApprovalCategory[] = APPROVAL_CATEGORY_VALUES;
/** Parses an {@link ApprovalCategory}. */
export const ApprovalCategorySchema: z.ZodType<ApprovalCategory, ApprovalCategory> =
  z.enum(APPROVAL_CATEGORY_VALUES);

const APPROVAL_STATE_VALUES = ["pending", "approved", "rejected", "canceled"] as const;

/**
 * Where an ask stands. There is no expired state: an ask waits until it is
 * answered, and the only ends besides an answer cancel it with its run.
 */
export type ApprovalState = (typeof APPROVAL_STATE_VALUES)[number];
/** Every {@link ApprovalState}. */
export const APPROVAL_STATES: readonly ApprovalState[] = APPROVAL_STATE_VALUES;
/** Parses an {@link ApprovalState}. */
export const ApprovalStateSchema: z.ZodType<ApprovalState, ApprovalState> =
  z.enum(APPROVAL_STATE_VALUES);

const APPROVAL_DECISION_VALUES = ["approved", "rejected"] as const;

/** The person's answer to an ask. */
export type ApprovalDecision = (typeof APPROVAL_DECISION_VALUES)[number];
/** Every {@link ApprovalDecision}. */
export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = APPROVAL_DECISION_VALUES;
/** Parses an {@link ApprovalDecision}. */
export const ApprovalDecisionSchema: z.ZodType<ApprovalDecision, ApprovalDecision> =
  z.enum(APPROVAL_DECISION_VALUES);

/**
 * The levels that raise an ask, and so the only levels a rule can be made at. A
 * rule never answers below the level it was made at.
 */
const ASKING_LEVELS: readonly ExecutionPostureMode[] = ["readonly", "ask", "reviewed"];
const RuleLevelSchema: z.ZodType<ExecutionPostureMode, ExecutionPostureMode> =
  ExecutionPostureModeSchema.refine((level) => ASKING_LEVELS.includes(level), {
    message: "a rule is made only at a level that asks: readonly, ask or reviewed",
  });

const REMEMBERED_SCOPE_KIND_VALUES = ["session", "project"] as const;

/**
 * A remembered rule's reach: this session, or every session on this project.
 * Both live in the daemon's rule store.
 */
export type RememberedScopeKind = (typeof REMEMBERED_SCOPE_KIND_VALUES)[number];
/** Every {@link RememberedScopeKind}. */
export const REMEMBERED_SCOPE_KINDS: readonly RememberedScopeKind[] = REMEMBERED_SCOPE_KIND_VALUES;
/** Parses a {@link RememberedScopeKind}. */
export const RememberedScopeKindSchema: z.ZodType<RememberedScopeKind, RememberedScopeKind> =
  z.enum(REMEMBERED_SCOPE_KIND_VALUES);

/**
 * Whether a rule allows its subject or blocks it. A block is the remembered form
 * of a network decline: that host is refused with no card until the rule is
 * replaced.
 */
export type RememberedRuleSense = "allow" | "block";
/** Parses a {@link RememberedRuleSense}. */
export const RememberedRuleSenseSchema: z.ZodType<RememberedRuleSense, RememberedRuleSense> =
  z.enum(["allow", "block"]);

const INVALIDATION_TRIGGER_VALUES = [
  "explicit",
  "session_end",
  "project_detached",
  "server_trust_withdrawn",
] as const;

/**
 * Why a rule ended: the person revoked it, its session ended, its project was
 * detached, or its tool server's trust was withdrawn or the server removed. No
 * rule outlives what scoped it.
 */
export type InvalidationTrigger = (typeof INVALIDATION_TRIGGER_VALUES)[number];
/** Every {@link InvalidationTrigger}. */
export const INVALIDATION_TRIGGERS: readonly InvalidationTrigger[] = INVALIDATION_TRIGGER_VALUES;
/** Parses an {@link InvalidationTrigger}. */
export const InvalidationTriggerSchema: z.ZodType<InvalidationTrigger, InvalidationTrigger> =
  z.enum(INVALIDATION_TRIGGER_VALUES);

/**
 * The rule a resolution mints. `pattern` is the subject the daemon derived from
 * the ask and the card's button showed: a command's program and first
 * subcommand, a network request's host, a written file's name. The client echoes
 * what it showed, and the daemon refuses an echo that differs from its own
 * derivation, so a rule never covers more than the words the person pressed.
 */
export interface RememberedScope {
  kind: RememberedScopeKind;
  pattern: string;
  sense: RememberedRuleSense;
}
/** Parses a {@link RememberedScope}. */
export const RememberedScopeSchema: z.ZodType<RememberedScope, RememberedScope> = z
  .object({
    kind: RememberedScopeKindSchema,
    pattern: z.string().min(1),
    sense: RememberedRuleSenseSchema,
  })
  .strict();

/** The sense a decision mints: an approval allows, a decline blocks. */
const SENSE_BY_DECISION: Readonly<Record<ApprovalDecision, RememberedRuleSense>> = {
  approved: "allow",
  rejected: "block",
};

// approval.resolve

/**
 * One answer to an ask.
 *
 * `declineReason` is the optional `why not` line a decline opens; the daemon
 * sends it to the agent through the provider's own refusal field. `editedAction`
 * is the command or path as the person changed it on the card before approving;
 * it is what goes back to the provider and what the row records as having run.
 * `clientResolutionId` is minted by the answering client and echoed on the
 * resolution event, so the device whose answer settled the ask draws nothing and
 * every other device showing the card draws that it was answered elsewhere.
 *
 * `approver` is informational: absent, the daemon records its own owner; present,
 * it is checked against the caller and never trusted.
 */
export interface ApprovalResolveRequest {
  approvalRequestId: ApprovalRequestId;
  decision: ApprovalDecision;
  clientResolutionId: string;
  approver?: UserId | undefined;
  declineReason?: string | undefined;
  editedAction?: string | undefined;
  /** Never broader than what was asked; defaults to the ask's own scope. */
  effectiveScope?: string | undefined;
  /** Absent for a one-time answer. Its sense agrees with the decision. */
  rememberedScope?: RememberedScope | undefined;
  auditMetadata?: Record<string, unknown> | undefined;
}
/**
 * Parses an {@link ApprovalResolveRequest}. Refused: a remembered sense that
 * disagrees with the decision, decline text on an approval, and an edited action
 * on a decline.
 */
export const ApprovalResolveRequestSchema: z.ZodType<
  ApprovalResolveRequest,
  ApprovalResolveRequest
> = z
  .object({
    approvalRequestId: ApprovalRequestIdSchema,
    decision: ApprovalDecisionSchema,
    clientResolutionId: z.uuid(),
    approver: UserIdSchema.optional(),
    declineReason: z.string().min(1).optional(),
    editedAction: z.string().min(1).optional(),
    effectiveScope: approvalScopeSchema("ApprovalResolveRequest.effectiveScope").optional(),
    rememberedScope: RememberedScopeSchema.optional(),
    auditMetadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.rememberedScope !== undefined &&
      request.rememberedScope.sense !== SENSE_BY_DECISION[request.decision]
    ) {
      context.addIssue({
        code: "custom",
        path: ["rememberedScope", "sense"],
        message: "an approval remembers an allow and a decline remembers a block",
      });
    }
    if (request.declineReason !== undefined && request.decision !== "rejected") {
      context.addIssue({
        code: "custom",
        path: ["declineReason"],
        message: "only a decline carries a reason",
      });
    }
    if (request.editedAction !== undefined && request.decision !== "approved") {
      context.addIssue({
        code: "custom",
        path: ["editedAction"],
        message: "only an approval carries an edited action",
      });
    }
  });

/** What an answer settled: the recorded approver, scope and time. */
export interface ApprovalResolveResponse {
  approvalRequestId: ApprovalRequestId;
  state: ApprovalState;
  effectiveScope: string;
  approverId: UserId;
  resolvedAt: string;
}
/** Parses an {@link ApprovalResolveResponse}. */
export const ApprovalResolveResponseSchema: z.ZodType<ApprovalResolveResponse> = z
  .object({
    approvalRequestId: ApprovalRequestIdSchema,
    state: ApprovalStateSchema,
    effectiveScope: approvalScopeSchema("ApprovalResolveResponse.effectiveScope"),
    approverId: UserIdSchema,
    resolvedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

// approval.projectionRead

/** The session's asks, optionally narrowed by state or category. */
export interface ApprovalProjectionReadRequest {
  sessionId: SessionId;
  state?: ApprovalState | undefined;
  category?: ApprovalCategory | undefined;
}
/** Parses an {@link ApprovalProjectionReadRequest}. */
export const ApprovalProjectionReadRequestSchema: z.ZodType<
  ApprovalProjectionReadRequest,
  ApprovalProjectionReadRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    state: ApprovalStateSchema.optional(),
    category: ApprovalCategorySchema.optional(),
  })
  .strict();

/**
 * One ask as the card draws it.
 *
 * `subject` is the subject the daemon derived from the ask, the words the
 * standing-allow button names. `reason` is the provider's own line saying why
 * this action stopped, with control characters and escape codes stripped; it is
 * absent where the provider sent none. `standingAllowOffered` is false where the
 * provider marks the ask as one that must not carry a standing allow, and the card
 * then draws only `Decline` and `Approve once`.
 *
 * The resolved members (`resolvedAt`, `decision`, `approverId`, `effectiveScope`)
 * are present exactly when the state is `approved` or `rejected`, and the decision
 * is the state. `rememberedScope` is present only where the resolution minted a
 * rule, and its sense agrees with the decision.
 */
export interface ApprovalProjectionRow {
  id: ApprovalRequestId;
  runId: RunId;
  requestedBy: string;
  category: ApprovalCategory;
  scope: string;
  resourceDescriptor: Record<string, unknown>;
  subject: string;
  reason?: string | undefined;
  standingAllowOffered: boolean;
  state: ApprovalState;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | undefined;
  decision?: ApprovalDecision | undefined;
  approverId?: UserId | undefined;
  effectiveScope?: string | undefined;
  rememberedScope?: RememberedScope | undefined;
}
/** Parses an {@link ApprovalProjectionRow}, holding the resolved-members rule. */
export const ApprovalProjectionRowSchema: z.ZodType<ApprovalProjectionRow> = z
  .object({
    id: ApprovalRequestIdSchema,
    runId: RunIdSchema,
    requestedBy: z.string().min(1),
    category: ApprovalCategorySchema,
    scope: approvalScopeSchema("ApprovalProjectionRow.scope"),
    resourceDescriptor: z.record(z.string(), z.unknown()),
    subject: z.string().min(1),
    reason: z.string().min(1).optional(),
    standingAllowOffered: z.boolean(),
    state: ApprovalStateSchema,
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    resolvedAt: z.iso.datetime({ offset: true }).optional(),
    decision: ApprovalDecisionSchema.optional(),
    approverId: UserIdSchema.optional(),
    effectiveScope: approvalScopeSchema("ApprovalProjectionRow.effectiveScope").optional(),
    rememberedScope: RememberedScopeSchema.optional(),
  })
  .strict()
  .superRefine((row, context) => {
    const resolved = row.state === "approved" || row.state === "rejected";
    for (const member of ["resolvedAt", "decision", "approverId", "effectiveScope"] as const) {
      if (resolved !== (row[member] !== undefined)) {
        context.addIssue({
          code: "custom",
          path: [member],
          message: resolved
            ? `a resolved ask carries ${member}`
            : `an ask that is not resolved carries no ${member}`,
        });
      }
    }
    if (resolved && row.decision !== row.state) {
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message: "the decision is the state the ask resolved to",
      });
    }
    const mintedSense = row.decision === undefined ? undefined : SENSE_BY_DECISION[row.decision];
    if (row.rememberedScope !== undefined && row.rememberedScope.sense !== mintedSense) {
      context.addIssue({
        code: "custom",
        path: ["rememberedScope"],
        message: "a rule is minted only by a resolution, with the sense its decision gives",
      });
    }
  });

/** The session's asks. */
export interface ApprovalProjectionReadResponse {
  approvals: ApprovalProjectionRow[];
}
/** Parses an {@link ApprovalProjectionReadResponse}. */
export const ApprovalProjectionReadResponseSchema: z.ZodType<ApprovalProjectionReadResponse> = z
  .object({ approvals: z.array(ApprovalProjectionRowSchema) })
  .strict();

// approval.ruleList and approval.ruleRevoke

/** The rules in force on one session: its own and its project's. */
export interface RememberedRuleListRequest {
  sessionId: SessionId;
}
/** Parses a {@link RememberedRuleListRequest}. */
export const RememberedRuleListRequestSchema: z.ZodType<
  RememberedRuleListRequest,
  RememberedRuleListRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

/**
 * One rule in force, as the inspector's row reads it: what it does, the derived
 * subject and the scope in words, and the level it was made at.
 */
export interface RememberedRule {
  ruleId: RememberedRuleId;
  category: ApprovalCategory;
  scope: RememberedScope;
  madeAtLevel: ExecutionPostureMode;
  grantedAt: string;
}
/** Parses a {@link RememberedRule}; a rule made at a level that never asks is refused. */
export const RememberedRuleSchema: z.ZodType<RememberedRule> = z
  .object({
    ruleId: RememberedRuleIdSchema,
    category: ApprovalCategorySchema,
    scope: RememberedScopeSchema,
    madeAtLevel: RuleLevelSchema,
    grantedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

/** The rules in force. */
export interface RememberedRuleListResponse {
  rules: RememberedRule[];
}
/** Parses a {@link RememberedRuleListResponse}. */
export const RememberedRuleListResponseSchema: z.ZodType<RememberedRuleListResponse> = z
  .object({ rules: z.array(RememberedRuleSchema) })
  .strict();

/** Revokes one rule; a project rule's revocation reaches every session on the project. */
export interface RememberedRuleRevokeRequest {
  ruleId: RememberedRuleId;
}
/** Parses a {@link RememberedRuleRevokeRequest}. */
export const RememberedRuleRevokeRequestSchema: z.ZodType<
  RememberedRuleRevokeRequest,
  RememberedRuleRevokeRequest
> = z.object({ ruleId: RememberedRuleIdSchema }).strict();

/** A revocation's receipt. A revocation through this call is always `explicit`. */
export interface RememberedRuleRevokeResponse {
  ruleId: RememberedRuleId;
  revokedAt: string;
  invalidationTrigger: "explicit";
}
/** Parses a {@link RememberedRuleRevokeResponse}. */
export const RememberedRuleRevokeResponseSchema: z.ZodType<RememberedRuleRevokeResponse> = z
  .object({
    ruleId: RememberedRuleIdSchema,
    revokedAt: z.iso.datetime({ offset: true }),
    invalidationTrigger: z.literal("explicit"),
  })
  .strict();

// approval.denialOverride

/**
 * Allows once an action the provider's own reviewer blocked. The daemon tells the
 * agent it may retry that one action, by each provider's own means; the agent
 * decides whether to retry. A press on a block already allowed is answered with
 * the settled override and sends nothing a second time.
 */
export interface ApprovalDenialOverrideRequest {
  sessionId: SessionId;
  denialId: ReviewerDenialId;
}
/** Parses an {@link ApprovalDenialOverrideRequest}. */
export const ApprovalDenialOverrideRequestSchema: z.ZodType<
  ApprovalDenialOverrideRequest,
  ApprovalDenialOverrideRequest
> = z.object({ sessionId: SessionIdSchema, denialId: ReviewerDenialIdSchema }).strict();

/** When the block was allowed once, the first time it was. */
export interface ApprovalDenialOverrideResponse {
  denialId: ReviewerDenialId;
  overriddenAt: string;
}
/** Parses an {@link ApprovalDenialOverrideResponse}. */
export const ApprovalDenialOverrideResponseSchema: z.ZodType<ApprovalDenialOverrideResponse> = z
  .object({
    denialId: ReviewerDenialIdSchema,
    overriddenAt: z.iso.datetime({ offset: true }),
  })
  .strict();

// The `approval.*` event payloads: one per event type, and a remembered rule rebuilds from
// them alone. Type aliases rather than interfaces, because an event payload narrows the
// envelope's `Record<string, unknown>`, which an interface cannot satisfy.

/**
 * `approval.requested`. `askId` is present when the request is a provider's
 * permission ask: the daemon's own durable id for the ask, which it mints and no
 * client can, so an answer reaches the right ask after a restart when several are
 * open on one run. The ask's tool name and the provider's prompt text ride
 * `resourceDescriptor`.
 */
export type ApprovalRequestedPayload = {
  sessionId: SessionId;
  runId: RunId;
  approvalRequestId: ApprovalRequestId;
  category: ApprovalCategory;
  scope: string;
  requestedBy: string;
  resourceDescriptor: Record<string, unknown>;
  askId?: string | undefined;
};
/** Parses an {@link ApprovalRequestedPayload}. */
export const ApprovalRequestedPayloadSchema: z.ZodType<ApprovalRequestedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    approvalRequestId: ApprovalRequestIdSchema,
    category: ApprovalCategorySchema,
    scope: approvalScopeSchema("ApprovalRequestedPayload.scope"),
    requestedBy: z.string().min(1),
    resourceDescriptor: z.record(z.string(), z.unknown()),
    askId: z.string().min(1).optional(),
  })
  .strict();

/** `approval.approved` and `approval.rejected`: who answered, and the answer's client id. */
export type ApprovalResolvedPayload = {
  sessionId: SessionId;
  runId: RunId;
  approvalRequestId: ApprovalRequestId;
  category: ApprovalCategory;
  scope: string;
  approver: UserId;
  effectiveScope: string;
  clientResolutionId: string;
};
/** Parses an {@link ApprovalResolvedPayload}. */
export const ApprovalResolvedPayloadSchema: z.ZodType<ApprovalResolvedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    approvalRequestId: ApprovalRequestIdSchema,
    category: ApprovalCategorySchema,
    scope: approvalScopeSchema("ApprovalResolvedPayload.scope"),
    approver: UserIdSchema,
    effectiveScope: approvalScopeSchema("ApprovalResolvedPayload.effectiveScope"),
    clientResolutionId: z.uuid(),
  })
  .strict();

/** `approval.canceled`: the ask ended with its run and can no longer be answered. */
export type ApprovalCanceledPayload = {
  sessionId: SessionId;
  runId: RunId;
  approvalRequestId: ApprovalRequestId;
  category: ApprovalCategory;
  scope: string;
};
/** Parses an {@link ApprovalCanceledPayload}. */
export const ApprovalCanceledPayloadSchema: z.ZodType<ApprovalCanceledPayload> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    approvalRequestId: ApprovalRequestIdSchema,
    category: ApprovalCategorySchema,
    scope: approvalScopeSchema("ApprovalCanceledPayload.scope"),
  })
  .strict();

/**
 * `approval.remembered`: the whole rule, so it rebuilds from the log. `approver`
 * is the rule's grantor and `nodeId` the machine it is bound to.
 */
export type ApprovalRememberedPayload = {
  sessionId: SessionId;
  runId: RunId;
  approvalRequestId: ApprovalRequestId;
  category: ApprovalCategory;
  scope: string;
  approver: UserId;
  nodeId: NodeId;
  ruleId: RememberedRuleId;
  rememberedScope: RememberedScope;
  madeAtLevel: ExecutionPostureMode;
};
/** Parses an {@link ApprovalRememberedPayload}; a level that never asks is refused. */
export const ApprovalRememberedPayloadSchema: z.ZodType<ApprovalRememberedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    approvalRequestId: ApprovalRequestIdSchema,
    category: ApprovalCategorySchema,
    scope: approvalScopeSchema("ApprovalRememberedPayload.scope"),
    approver: UserIdSchema,
    nodeId: NodeIdSchema,
    ruleId: RememberedRuleIdSchema,
    rememberedScope: RememberedScopeSchema,
    madeAtLevel: RuleLevelSchema,
  })
  .strict();

/**
 * `approval.rule_revoked`. The run and the ask are absent where no ask was in
 * flight, as when a project is detached or a server's trust is withdrawn.
 */
export type ApprovalRuleRevokedPayload = {
  sessionId: SessionId;
  category: ApprovalCategory;
  scope: string;
  ruleId: RememberedRuleId;
  invalidationTrigger: InvalidationTrigger;
  runId?: RunId | undefined;
  approvalRequestId?: ApprovalRequestId | undefined;
};
/** Parses an {@link ApprovalRuleRevokedPayload}. */
export const ApprovalRuleRevokedPayloadSchema: z.ZodType<ApprovalRuleRevokedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    category: ApprovalCategorySchema,
    scope: approvalScopeSchema("ApprovalRuleRevokedPayload.scope"),
    ruleId: RememberedRuleIdSchema,
    invalidationTrigger: InvalidationTriggerSchema,
    runId: RunIdSchema.optional(),
    approvalRequestId: ApprovalRequestIdSchema.optional(),
  })
  .strict();

/**
 * `approval.reviewer_denied`: a provider's own reviewer blocked an action. The
 * provider's denial is sealed in the row's content part, which is what lets the
 * override hold across a restart. `eventId` names the blocked call's own row,
 * whose reason line reads `Blocked · <reason>`. `overridable` is false where the
 * provider lets no person overrule the block, and no `Allow once` is drawn.
 */
export type ApprovalReviewerDeniedPayload = {
  sessionId: SessionId;
  runId: RunId;
  agentId: string;
  denialId: ReviewerDenialId;
  eventId: string;
  reason: string;
  overridable: boolean;
};
/** Parses an {@link ApprovalReviewerDeniedPayload}. */
export const ApprovalReviewerDeniedPayloadSchema: z.ZodType<ApprovalReviewerDeniedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    agentId: uuidTextFormSchema,
    denialId: ReviewerDenialIdSchema,
    eventId: z.string().min(1),
    reason: z.string().min(1),
    overridable: z.boolean(),
  })
  .strict();

/** `approval.denial_overridden`: the person allowed a blocked action once. */
export type ApprovalDenialOverriddenPayload = {
  sessionId: SessionId;
  denialId: ReviewerDenialId;
};
/** Parses an {@link ApprovalDenialOverriddenPayload}. */
export const ApprovalDenialOverriddenPayloadSchema: z.ZodType<ApprovalDenialOverriddenPayload> = z
  .object({ sessionId: SessionIdSchema, denialId: ReviewerDenialIdSchema })
  .strict();

// Methods

/** The `approval.*` methods a client calls. */
export interface ApprovalMethodDescriptors {
  readonly "approval.resolve": MethodDescriptor<
    "approval.resolve",
    ApprovalResolveRequest,
    ApprovalResolveResponse
  >;
  readonly "approval.projectionRead": MethodDescriptor<
    "approval.projectionRead",
    ApprovalProjectionReadRequest,
    ApprovalProjectionReadResponse
  >;
  readonly "approval.ruleList": MethodDescriptor<
    "approval.ruleList",
    RememberedRuleListRequest,
    RememberedRuleListResponse
  >;
  readonly "approval.ruleRevoke": MethodDescriptor<
    "approval.ruleRevoke",
    RememberedRuleRevokeRequest,
    RememberedRuleRevokeResponse
  >;
  readonly "approval.denialOverride": MethodDescriptor<
    "approval.denialOverride",
    ApprovalDenialOverrideRequest,
    ApprovalDenialOverrideResponse
  >;
}

/** The `approval.*` descriptor table. */
export const APPROVAL_METHOD_DESCRIPTORS: ApprovalMethodDescriptors = defineMethodDescriptors({
  "approval.resolve": {
    method: "approval.resolve",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ApprovalResolveRequestSchema,
    responseSchema: ApprovalResolveResponseSchema,
  },
  "approval.projectionRead": {
    method: "approval.projectionRead",
    procedureType: "query",
    mutating: false,
    requestSchema: ApprovalProjectionReadRequestSchema,
    responseSchema: ApprovalProjectionReadResponseSchema,
  },
  "approval.ruleList": {
    method: "approval.ruleList",
    procedureType: "query",
    mutating: false,
    requestSchema: RememberedRuleListRequestSchema,
    responseSchema: RememberedRuleListResponseSchema,
  },
  "approval.ruleRevoke": {
    method: "approval.ruleRevoke",
    procedureType: "mutation",
    mutating: true,
    requestSchema: RememberedRuleRevokeRequestSchema,
    responseSchema: RememberedRuleRevokeResponseSchema,
  },
  "approval.denialOverride": {
    method: "approval.denialOverride",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ApprovalDenialOverrideRequestSchema,
    responseSchema: ApprovalDenialOverrideResponseSchema,
  },
});
