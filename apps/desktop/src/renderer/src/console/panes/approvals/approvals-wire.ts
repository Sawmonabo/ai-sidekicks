// The approvals surface's seam onto the daemon: the method names it quotes and the
// four calls it makes.
//
// Every name below is a row of a registry the corpus already publishes, quoted
// verbatim. `Spec-023 §Console Design (Meridian)` §7.6 and §7.7 give this surface
// exactly four callables and one deliberate absence, and the absence is the point
// of the last constant in this header rather than of a method that is missing:
//
//   • `PermissionCheck` is NOT here and is reached from nowhere. §7.6 states it is
//     deliberately unregistered, because no V1 client consumes a wire preflight and
//     exposing one would invite time-of-check/time-of-use authorization against the
//     security gate. A preflight constant declared "for later" would be the first
//     half of exactly that mistake.
//   • `approval.requestCreate` is daemon-internal. The console never raises an
//     approval, so it holds no constant for one either.
//
// The two brand widenings are `console/bridge/daemon-call.ts`'s, not a third copy.

import { callDaemon, type ConsoleBridge } from "../../bridge/index.js";
import {
  readApprovalProjection,
  readRememberedRuleList,
  type ApprovalRecord,
  type ParsedRows,
  type RememberedRule,
} from "./approval-records.js";
import { type ApprovalDecision, type RememberedScopeKind } from "./approval-vocabulary.js";

/**
 * The unfiltered projection read.
 *
 * The server-side filters `state?` and `category?` exist and this surface passes
 * neither: §7.6 requires history to render every record an unfiltered read returns,
 * and the client never filters by state itself.
 */
export const APPROVAL_PROJECTION_READ_METHOD = "approval.projectionRead";

/** The one resolve. Approve and reject are the same call with a different decision. */
export const APPROVAL_RESOLVE_METHOD = "approval.resolve";

/** The standing-permission list. Always read with revoked rules included (§7.7). */
export const APPROVAL_RULE_LIST_METHOD = "approval.ruleList";

/** The revoke. Fired only by the confirming click of the two-step control. */
export const APPROVAL_RULE_REVOKE_METHOD = "approval.ruleRevoke";

/**
 * The five lifecycle signals, as opaque re-read triggers.
 *
 * §7.6's leverage note fixes the rule: these are triggers whose payloads are never
 * decoded. The surface matches an arrived event's wire-verbatim `kind` against this
 * set and re-reads; it reads no payload member, so no decision can be taken from a
 * signal and the projection read stays the single source of what is true.
 */
export const APPROVAL_LIFECYCLE_EVENT_KINDS = [
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.expired",
  "approval.canceled",
] as const;

/**
 * The two rule-lifecycle signals, on the same terms.
 *
 * §7.7 puts the grant moment and the revocation moment in the ledger; here they are
 * re-read triggers for the standing-permission list and nothing more.
 */
export const APPROVAL_RULE_EVENT_KINDS = ["approval.remembered", "approval.rule_revoked"] as const;

/** What one resolve carries. Nothing on it edits the requested action (§7.6). */
export interface ApprovalResolveRequest {
  readonly approvalRequestId: string;
  readonly decision: ApprovalDecision;
  /**
   * Informational and routing only. §7.6: the console never treats it as
   * authoritative — a mismatch is the daemon's `auth.principal_mismatch`.
   */
  readonly approver?: string;
  /** Never broader than requested. The surface offers no scope-widening control. */
  readonly effectiveScope?: string;
  /**
   * Present only where the participant opted in, and only on an `approved`
   * decision. An untouched control omits the member entirely rather than sending a
   * falsy one, because a remembered scope is valid only on the approve path.
   */
  readonly rememberedScope?: { readonly kind: RememberedScopeKind; readonly pattern?: string };
}

/** Read the projection, unfiltered. */
export async function readApprovals(
  bridge: ConsoleBridge,
  sessionId: string,
): Promise<ParsedRows<ApprovalRecord>> {
  return readApprovalProjection(
    await callDaemon(bridge, APPROVAL_PROJECTION_READ_METHOD, { sessionId }),
  );
}

/** Resolve one request. Exactly one call per answer. */
export async function resolveApproval(
  bridge: ConsoleBridge,
  request: ApprovalResolveRequest,
): Promise<void> {
  await callDaemon(bridge, APPROVAL_RESOLVE_METHOD, request);
}

/** List standing permissions, revoked ones included, because this list IS the audit. */
export async function readRememberedRules(
  bridge: ConsoleBridge,
  sessionId: string,
): Promise<ParsedRows<RememberedRule>> {
  return readRememberedRuleList(
    await callDaemon(bridge, APPROVAL_RULE_LIST_METHOD, { sessionId, includeRevoked: true }),
  );
}

/** Revoke one standing permission. */
export async function revokeRememberedRule(bridge: ConsoleBridge, ruleId: string): Promise<void> {
  await callDaemon(bridge, APPROVAL_RULE_REVOKE_METHOD, { ruleId });
}
