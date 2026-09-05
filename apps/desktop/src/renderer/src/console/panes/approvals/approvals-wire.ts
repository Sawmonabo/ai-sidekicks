// The approvals surface's seam onto the daemon: the method names it quotes and the
// four calls it makes.
//
// Every name below is a row of a registry the corpus already publishes, quoted
// verbatim: `api-payload-contracts.md §Approval Method-Name Registry (Tier 6)`
// exposes five `approval.*` methods. WHICH FOUR THIS SURFACE CALLS IS ITS OWN
// DECISION, because no committed document assigns them; the fifth and one absence
// are the registry's own:
//
//   • `PermissionCheck` is NOT here and is reached from nowhere. That registry says
//     it "is deliberately **not** registered: it is the daemon-internal
//     pre-execution gate … no V1 client consumes a wire preflight, and exposing one
//     would invite stale-verdict (time-of-check/time-of-use) authorization against
//     the security gate". A preflight constant declared "for later" would be the
//     first half of exactly that mistake.
//   • `approval.requestCreate` is the fifth registered method and is daemon-raised.
//     The console never raises an approval, so it holds no constant for one.
//
// The two brand widenings are `console/bridge/daemon-calls.ts`'s, not a third copy.

import { callUnregisteredDaemonMethod, type ConsoleBridge } from "../../bridge/index.js";
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
 * neither. `Spec-023 §Signature Feature Composition Sketches`' Approvals View
 * renders "resolved approvals in history view" without a filter, and THIS SURFACE'S
 * OWN RULE, because no committed document states it, is that history renders every
 * record an unfiltered read returns and the client never filters by state itself.
 */
export const APPROVAL_PROJECTION_READ_METHOD = "approval.projectionRead";

/** The one resolve. Approve and reject are the same call with a different decision. */
export const APPROVAL_RESOLVE_METHOD = "approval.resolve";

/** The standing-permission list. Always read with revoked rules included — a
 * revoked rule that vanished would read as one that was never granted. */
export const APPROVAL_RULE_LIST_METHOD = "approval.ruleList";

/** The revoke. Fired only by the confirming click of the two-step control. */
export const APPROVAL_RULE_REVOKE_METHOD = "approval.ruleRevoke";

/**
 * The five lifecycle signals, as opaque re-read triggers.
 *
 * THIS SURFACE'S OWN RULE, because no committed document states it: these are
 * triggers whose payloads are never decoded — the projection read is the single
 * source of what is true, and a second reading taken from a signal would be a
 * second source. The surface matches an arrived event's wire-verbatim `kind` against this
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
 * The grant moment and the revocation moment are durable `approval_flow` events;
 * here they are re-read triggers for the standing-permission list and nothing more,
 * on the same never-decoded rule as the five above.
 */
export const APPROVAL_RULE_EVENT_KINDS = ["approval.remembered", "approval.rule_revoked"] as const;

/** What one resolve carries. Nothing on it edits the requested action: the
 * Approvals View sketch's interactions are approve / deny / remember and no fourth. */
export interface ApprovalResolveRequest {
  readonly approvalRequestId: string;
  readonly decision: ApprovalDecision;
  /**
   * Informational and routing only. The console never treats it as authoritative —
   * a mismatch is the daemon's `auth.principal_mismatch`.
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
    await callUnregisteredDaemonMethod(bridge, APPROVAL_PROJECTION_READ_METHOD, { sessionId }),
  );
}

/** Resolve one request. Exactly one call per answer. */
export async function resolveApproval(
  bridge: ConsoleBridge,
  request: ApprovalResolveRequest,
): Promise<void> {
  await callUnregisteredDaemonMethod(bridge, APPROVAL_RESOLVE_METHOD, request);
}

/** List standing permissions, revoked ones included, because this list IS the audit. */
export async function readRememberedRules(
  bridge: ConsoleBridge,
  sessionId: string,
): Promise<ParsedRows<RememberedRule>> {
  return readRememberedRuleList(
    await callUnregisteredDaemonMethod(bridge, APPROVAL_RULE_LIST_METHOD, {
      sessionId,
      includeRevoked: true,
    }),
  );
}

/** Revoke one standing permission. */
export async function revokeRememberedRule(bridge: ConsoleBridge, ruleId: string): Promise<void> {
  await callUnregisteredDaemonMethod(bridge, APPROVAL_RULE_REVOKE_METHOD, { ruleId });
}
