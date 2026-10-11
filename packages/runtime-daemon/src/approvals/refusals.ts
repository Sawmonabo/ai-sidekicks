// The approval service's refusals, each projected onto the wire by its code: an ask the daemon
// holds no row for, one already answered or canceled, an answer that does not fit its ask, an ask
// raised after its run or its session ended, a record that could not be kept, an `Allow once` on a
// block the daemon holds no record of or no person may overrule, and a revoke of a rule never made
// or no longer in force.

import type {
  ApprovalRequestId,
  RememberedRuleId,
  ReviewerDenialId,
} from "@ai-sidekicks/contracts/approval";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { DaemonDomainError } from "../ipc/domain-error.js";

/** Why an ask could not be raised: its run had ended, or its session had closed. */
type LateCreateReason = "run_ended" | "session_closed";

/**
 * Why an answer does not fit its ask: a block on an ask that is not a network request, a rule the
 * ask does not offer, a rule over other words than the subject the card named, a scope other than
 * the one asked, a correction on an ask whose command or path cannot be corrected, or a correction
 * and a rule together, since the rule's subject was derived from what was asked and not from the
 * correction.
 */
type ResolutionInvalidReason =
  | "block_outside_network_access"
  | "rule_not_offered"
  | "subject_mismatch"
  | "effective_scope_broader"
  | "edit_not_offered"
  | "edit_with_rule";

/** `approval.not_found`: the daemon holds no ask under the id. */
export class ApprovalNotFoundError extends DaemonDomainError {
  constructor(approvalRequestId: ApprovalRequestId) {
    super("This session holds no such approval request", {
      code: "approval.not_found",
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { approvalRequestId },
    });
  }
}

/** `approval.already_resolved`: another answer settled the ask first, and it stands. */
export class ApprovalAlreadyResolvedError extends DaemonDomainError {
  constructor(approvalRequestId: ApprovalRequestId) {
    super("The approval request was already answered", {
      code: "approval.already_resolved",
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      detail: { approvalRequestId },
    });
  }
}

/** `approval.request_canceled` on an answer: the ask was canceled and can no longer be answered. */
export class ApprovalRequestCanceledError extends DaemonDomainError {
  constructor(approvalRequestId: ApprovalRequestId) {
    super("The approval request was canceled and can no longer be answered", {
      code: "approval.request_canceled",
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      detail: { approvalRequestId },
    });
  }
}

/**
 * `approval.request_canceled` on a create: the run had ended or the session had closed, so no ask
 * was raised. `reason` names which, read from their state when the create was refused.
 */
export class ApprovalLateCreateError extends DaemonDomainError {
  constructor(sessionId: SessionId, runId: RunId, reason: LateCreateReason) {
    super(
      reason === "run_ended"
        ? "The run has ended, so it raises no approval request"
        : "The session is closed, so it raises no approval request",
      {
        code: "approval.request_canceled",
        jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
        detail: { sessionId, runId, reason },
      },
    );
  }
}

/**
 * `approval.resolution_invalid`: the answer does not fit the ask it names, so nothing was recorded.
 * `reason` names how.
 */
export class ApprovalResolutionInvalidError extends DaemonDomainError {
  constructor(approvalRequestId: ApprovalRequestId, reason: ResolutionInvalidReason) {
    super("The answer does not fit the approval request it names", {
      code: "approval.resolution_invalid",
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { approvalRequestId, reason },
    });
  }
}

/**
 * `approval.persistence_unavailable`: the approval record could not be written, so the action it
 * gates does not proceed. The write's own failure is the cause.
 */
export class ApprovalPersistenceUnavailableError extends DaemonDomainError {
  constructor(cause: unknown) {
    super("The approval record could not be kept, so the action does not proceed", {
      code: "approval.persistence_unavailable",
      cause,
    });
  }
}

/** `approval.denial_not_found`: the daemon holds no block by a reviewer under the id. */
export class ReviewerDenialNotFoundError extends DaemonDomainError {
  constructor(sessionId: SessionId, denialId: ReviewerDenialId) {
    super("This session holds no such blocked action", {
      code: "approval.denial_not_found",
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { sessionId, denialId },
    });
  }
}

/** `approval.denial_not_overridable`: the provider lets no person overrule this block. */
export class ReviewerDenialNotOverridableError extends DaemonDomainError {
  constructor(sessionId: SessionId, denialId: ReviewerDenialId) {
    super("The provider lets no one allow this blocked action", {
      code: "approval.denial_not_overridable",
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      detail: { sessionId, denialId },
    });
  }
}

/** `approval.rule_not_found`: no rule was ever made under the id. */
export class ApprovalRuleNotFoundError extends DaemonDomainError {
  constructor(ruleId: RememberedRuleId) {
    super("No such rule was made", {
      code: "approval.rule_not_found",
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { ruleId },
    });
  }
}

/** `approval.rule_already_revoked`: the rule is no longer in force. */
export class ApprovalRuleAlreadyRevokedError extends DaemonDomainError {
  constructor(ruleId: RememberedRuleId) {
    super("The rule was already revoked", {
      code: "approval.rule_already_revoked",
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      detail: { ruleId },
    });
  }
}
