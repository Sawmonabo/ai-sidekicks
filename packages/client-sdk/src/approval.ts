// The `approval.*` client over the local daemon: a card's answer, the session's cards, the rules
// in force on a session and their revoke, and `Allow once` on a block by the provider's own
// reviewer. Every verb validates its request before the wire write and the daemon's reply before
// resolving; a daemon refusal arrives as `JsonRpcRemoteError` carrying its registered code.

import {
  APPROVAL_METHOD_DESCRIPTORS,
  type ApprovalDenialOverrideRequest,
  type ApprovalDenialOverrideResponse,
  type ApprovalProjectionReadRequest,
  type ApprovalProjectionReadResponse,
  type ApprovalResolveRequest,
  type ApprovalResolveResponse,
  type RememberedRuleListRequest,
  type RememberedRuleListResponse,
  type RememberedRuleRevokeRequest,
  type RememberedRuleRevokeResponse,
} from "@ai-sidekicks/contracts/approval";

import { callMethod, type JsonRpcClient } from "./transport/json-rpc.js";

/** The client-facing approval surface: five request/response verbs. */
export interface ApprovalClient {
  /**
   * Answers one card. The same answer sent again under its `clientResolutionId` is answered with
   * what was saved; another answer to a settled card is refused `approval.already_resolved`.
   */
  resolve(request: ApprovalResolveRequest): Promise<ApprovalResolveResponse>;
  /** Reads a session's cards, pending and answered, oldest first. */
  readProjection(request: ApprovalProjectionReadRequest): Promise<ApprovalProjectionReadResponse>;
  /** Lists the rules in force on a session, its own and its project's. */
  listRules(request: RememberedRuleListRequest): Promise<RememberedRuleListResponse>;
  /** Revokes one rule where its provider keeps it, before it resolves. */
  revokeRule(request: RememberedRuleRevokeRequest): Promise<RememberedRuleRevokeResponse>;
  /** Allows once an action the provider's own reviewer blocked. */
  overrideDenial(request: ApprovalDenialOverrideRequest): Promise<ApprovalDenialOverrideResponse>;
}

/**
 * Builds an `ApprovalClient` over a daemon transport. The caller owns the `JsonRpcClient` and
 * completes the `daemon.hello` handshake before the first mutating call.
 */
export function createDaemonApprovalClient(client: JsonRpcClient): ApprovalClient {
  return {
    resolve: (request) =>
      callMethod(client, APPROVAL_METHOD_DESCRIPTORS["approval.resolve"], request),
    readProjection: (request) =>
      callMethod(client, APPROVAL_METHOD_DESCRIPTORS["approval.projectionRead"], request),
    listRules: (request) =>
      callMethod(client, APPROVAL_METHOD_DESCRIPTORS["approval.ruleList"], request),
    revokeRule: (request) =>
      callMethod(client, APPROVAL_METHOD_DESCRIPTORS["approval.ruleRevoke"], request),
    overrideDenial: (request) =>
      callMethod(client, APPROVAL_METHOD_DESCRIPTORS["approval.denialOverride"], request),
  };
}
