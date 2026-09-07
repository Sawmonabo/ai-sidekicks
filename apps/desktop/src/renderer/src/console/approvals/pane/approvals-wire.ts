// The approvals surface's seam onto the daemon: the four operations it drives and
// the resolve request they carry.
//
// EVERY NAME BELOW IS A ROW OF A REGISTRY THE CORPUS ALREADY PUBLISHES, quoted
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
//     The console never raises an approval, so it holds no operation for one.
//
// THE FOUR GO THROUGH THE GROWTH PORT AND NOT THROUGH `callDaemon`. The method
// STRINGS are registered; `@ai-sidekicks/contracts` publishes neither half of any of
// their request/response pairs, so there is no shape for the call door to parse
// against and the registry next door admits none of them. The port is the console's
// answer for exactly that: it is typed by the console's own signature table, every
// operation refuses by name under the live bridge, and the refusal says which
// document owes the wire. When Plan-012 ships the pairs, the four rows leave the
// slate, join `daemon-reply-registry.ts`, and these four calls become `callDaemon`.
//
// WHAT IS LEFT IN THIS FILE. The four thin calls and the lifecycle kinds the pane
// re-reads on. The reply narrowings moved down to `bridge/approvals/`, which is where
// a validator lives, and the resolve request went with them — a request shape and the
// reply it is answered with are two sides of one seam.

import type {
  ApprovalRecord,
  ApprovalResolveRequest,
  ConsoleBridge,
  GrowthOutcome,
  ParsedRows,
  RememberedRule,
} from "../../bridge/index.js";

export type { ApprovalResolveRequest } from "../../bridge/index.js";

/**
 * The five lifecycle signals, as opaque re-read triggers.
 *
 * THIS SURFACE'S OWN RULE, because no committed document states it: these are
 * triggers whose payloads are never decoded — the projection read is the single
 * source of what is true, and a second reading taken from a signal would be a
 * second source. The surface matches an arrived event's wire-verbatim `kind` against
 * this set and re-reads; it reads no payload member, so no decision can be taken
 * from a signal and the projection read stays the single source of what is true.
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

/** Read the projection, unfiltered.
 *
 * The server-side filters `state?` and `category?` exist and this surface passes
 * neither. `Spec-023 §Signature Feature Composition Sketches`' Approvals View renders
 * "resolved approvals in history view" without a filter, and THIS SURFACE'S OWN RULE,
 * because no committed document states it, is that history renders every record an
 * unfiltered read returns and the client never filters by state itself.
 */
export function readApprovals(
  bridge: ConsoleBridge,
  sessionId: string,
): Promise<GrowthOutcome<ParsedRows<ApprovalRecord>>> {
  return bridge.growth.approvalProjectionRead({ sessionId });
}

/** Resolve one request. Exactly one call per answer. */
export function resolveApproval(
  bridge: ConsoleBridge,
  request: ApprovalResolveRequest,
): Promise<GrowthOutcome<undefined>> {
  return bridge.growth.approvalResolve(request);
}

/** List standing permissions, revoked ones included, because this list IS the audit. */
export function readRememberedRules(
  bridge: ConsoleBridge,
  sessionId: string,
): Promise<GrowthOutcome<ParsedRows<RememberedRule>>> {
  return bridge.growth.approvalRuleList({ sessionId, includeRevoked: true });
}

/** Revoke one standing permission. Fired only by the confirming click of the two-step control. */
export function revokeRememberedRule(
  bridge: ConsoleBridge,
  ruleId: string,
): Promise<GrowthOutcome<undefined>> {
  return bridge.growth.approvalRuleRevoke({ ruleId });
}
