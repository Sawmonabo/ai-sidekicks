// The approval tables as a rebuild writes them from the session's log: each ask from its
// `approval.requested`, with the daemon's own ask id that routes its answer back to the provider
// ask it was raised for; each answer from its `approval.approved` or `approval.rejected`; each
// cancellation from its `approval.canceled`; and the rule an answer made from its
// `approval.remembered`. Every row is written at the event's own instant with the columns its live
// write wrote, so the rows a rebuild writes are the rows the live writes wrote. An ask a workflow
// gate's answer names is kept through the clear and written over, since the gate's rows reference
// it and no rebuild writes them.

import type { SessionEvent } from "@ai-sidekicks/contracts/event/variant-types";

import type { WriteStatement } from "../../database/statement.js";
import type {
  SessionProjection,
  SessionProjectionFold,
} from "../../recovery/projection-rebuild.js";
import type { ApprovalResourceDescriptor } from "../request-create.js";
import {
  insertResolutionStatement,
  rememberedScopeStatement,
  rewriteRequestStatement,
  settlePendingStatement,
} from "../store.js";

const SESSION_REQUEST_IDS_SQL = "SELECT id FROM approval_requests WHERE session_id = ?";

function foldApprovals(): SessionProjectionFold {
  return {
    apply(event: SessionEvent): readonly WriteStatement[] {
      switch (event.type) {
        case "approval.requested": {
          const { payload } = event;
          return [
            rewriteRequestStatement({
              approvalRequestId: payload.approvalRequestId,
              sessionId: payload.sessionId,
              runId: payload.runId,
              requestedBy: payload.requestedBy,
              category: payload.category,
              scope: payload.scope,
              // Written by the create from a parsed descriptor, so the log holds one.
              resourceDescriptor: payload.resourceDescriptor as ApprovalResourceDescriptor,
              askId: payload.askId,
              createdAt: event.occurredAt,
            }),
          ];
        }
        case "approval.approved":
        case "approval.rejected": {
          const { payload } = event;
          const decision = event.type === "approval.approved" ? "approved" : "rejected";
          return [
            settlePendingStatement(payload.approvalRequestId, decision, event.occurredAt),
            insertResolutionStatement({
              approvalRequestId: payload.approvalRequestId,
              deviceId: payload.deviceId,
              clientResolutionId: payload.clientResolutionId,
              decision,
              effectiveScope: payload.effectiveScope,
              editedAction: payload.editedAction,
              resolvedAt: event.occurredAt,
            }),
          ];
        }
        case "approval.canceled":
          return [
            settlePendingStatement(event.payload.approvalRequestId, "canceled", event.occurredAt),
          ];
        case "approval.remembered":
          return [
            rememberedScopeStatement(
              event.payload.approvalRequestId,
              event.payload.rememberedScope,
            ),
          ];
        default:
          return [];
      }
    },
  };
}

/**
 * The `approval_requests` and `approval_resolutions` rows as a rebuild replaces them. The clear
 * leaves each ask a workflow gate's answer names, which the gate's row references, and the fold
 * writes it over; such an ask the rebuild does not reach keeps its row.
 */
export const APPROVALS_PROJECTION: SessionProjection = {
  name: "approvals",
  eventTypes: new Set([
    "approval.requested",
    "approval.approved",
    "approval.rejected",
    "approval.canceled",
    "approval.remembered",
  ]),
  clearStatements: (sessionId) => [
    {
      sql: `DELETE FROM approval_resolutions WHERE request_id IN (${SESSION_REQUEST_IDS_SQL})`,
      bindings: [sessionId],
    },
    {
      sql: `DELETE FROM approval_requests WHERE session_id = ?
              AND id NOT IN (SELECT approval_request_id FROM workflow_gate_resolutions)`,
      bindings: [sessionId],
    },
  ],
  createFold: foldApprovals,
};
