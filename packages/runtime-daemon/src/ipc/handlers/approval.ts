// The `approval.*` methods: a card's answer, attributed to the device whose connection carried it,
// the session's cards, the rules in force on a session and their revoke, and `Allow once` on a
// block by the provider's own reviewer.

import { APPROVAL_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/approval";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";

import type { PermissionAsks } from "../../approvals/permission-asks.js";
import type { ApprovalProjectionService } from "../../approvals/projection/read.js";
import type { ReviewerDenials } from "../../approvals/reviewer-denials.js";
import type { ApprovalRules } from "../../approvals/rules.js";
import { callingDeviceOf } from "../registry.js";
import { registerDescribedMethod } from "./register-described-method.js";

/** What the `approval.*` handlers answer through. */
export interface ApprovalHandlerDeps {
  readonly asks: Pick<PermissionAsks, "resolve">;
  readonly projection: Pick<ApprovalProjectionService, "read">;
  readonly rules: Pick<ApprovalRules, "list" | "revoke">;
  readonly reviewerDenials: Pick<ReviewerDenials, "overrideDenial">;
}

/** Binds the five `approval.*` methods onto the registry; a second binding throws. */
export function registerApprovalMethods(registry: MethodRegistry, deps: ApprovalHandlerDeps): void {
  registerDescribedMethod(
    registry,
    APPROVAL_METHOD_DESCRIPTORS["approval.resolve"],
    async (request, context) =>
      await deps.asks.resolve(request, callingDeviceOf(context, "approval.resolve")),
  );
  registerDescribedMethod(
    registry,
    APPROVAL_METHOD_DESCRIPTORS["approval.projectionRead"],
    (request) => Promise.resolve(deps.projection.read(request)),
  );
  registerDescribedMethod(registry, APPROVAL_METHOD_DESCRIPTORS["approval.ruleList"], (request) =>
    Promise.resolve(deps.rules.list(request.sessionId)),
  );
  registerDescribedMethod(
    registry,
    APPROVAL_METHOD_DESCRIPTORS["approval.ruleRevoke"],
    async (request) => await deps.rules.revoke(request.ruleId),
  );
  registerDescribedMethod(
    registry,
    APPROVAL_METHOD_DESCRIPTORS["approval.denialOverride"],
    async (request) => await deps.reviewerDenials.overrideDenial(request),
  );
}
