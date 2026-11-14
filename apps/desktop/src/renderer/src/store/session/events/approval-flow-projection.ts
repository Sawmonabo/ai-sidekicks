// The `approval` partition's projector: approval-flow events folded into approval entities,
// including members that live only on the event, such as `askId` on a provider's own permission
// prompt. It sits beside the run fold because it reads wire member names, which the session
// store's entities do not.
//
// Each payload is read as its type's contract states it. A beat naming another session, and a rule
// revocation that names no ask, fold nothing; the transcript still records that they arrived.
//
// State is marked, never deleted: a resolution or cancellation sets the entity's state and
// leaves the row.

import type { ApprovalRequestId, ApprovalState } from "@ai-sidekicks/contracts/approval";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { payloadNamesSession } from "#renderer/lib/wire/session-attribution.js";
import type {
  ProjectedSessionEvent,
  EntityMutation,
  EntityProjector,
  EntityProjectorTable,
} from "../entities/vocabulary.js";

/**
 * The `approval.*` events that are not an ask's and carry no `approvalRequestId`. Claiming
 * one here would take it from the feature that renders it. `Extract`ed from the event-type
 * union, so an upstream rename fails to compile.
 */
type NonRequestApprovalCategoryKind = Extract<
  SessionEventType,
  "approval.reviewer.flagged" | "approval.reviewer.denied" | "approval.denial.overridden"
>;

/** The ask's `approval.*` kinds; a new one fails the `satisfies` below until classified. */
type ApprovalEventKind = Exclude<
  Extract<SessionEventType, `approval.${string}`>,
  NonRequestApprovalCategoryKind
>;

/** The members every ask payload shares: the session it belongs to and, mostly, the ask. */
type ApprovalEventPayload = {
  readonly sessionId: SessionId;
  readonly approvalRequestId?: ApprovalRequestId | undefined;
};

/**
 * The state each kind announces, total over the ask's kinds by `satisfies`.
 *
 * `approval.rule.remembered` and `approval.rule.revoked` announce no state: one records the rule a
 * resolution minted after approval, the other is about the rule. The upsert then omits `state`
 * entirely, because the store's spread merge would read a present `undefined` as erasing the
 * last transition.
 */
const APPROVAL_EVENT_STATES = {
  "approval.requested": "pending",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
  "approval.canceled": "canceled",
  "approval.rule.remembered": undefined,
  "approval.rule.revoked": undefined,
} as const satisfies Readonly<Record<ApprovalEventKind, ApprovalState | undefined>>;

/** The projector table the composer feature claims its kinds with, one fold per kind. */
export const APPROVAL_FLOW_PROJECTORS: EntityProjectorTable = Object.fromEntries(
  Object.entries(APPROVAL_EVENT_STATES).map(([eventKind, state]) => [
    eventKind,
    approvalFlowProjector(state),
  ]),
);

/** The owner the approval-flow kinds are registered under, so a conflicting claim names it. */
export const APPROVAL_FLOW_PROJECTOR_OWNER = "composer";

/**
 * Fold one kind's events into the ask each names. The body is the payload minus `sessionId` (the
 * envelope has it) and `approvalRequestId` (the entity's id).
 */
function approvalFlowProjector(state: ApprovalState | undefined): EntityProjector {
  return (event: ProjectedSessionEvent): readonly EntityMutation[] => {
    if (!payloadNamesSession(event.payload, event.sessionId)) {
      return [];
    }
    const {
      sessionId: _sessionId,
      approvalRequestId,
      ...body
    } = event.payload as ApprovalEventPayload;
    if (approvalRequestId === undefined) {
      return [];
    }
    return [
      {
        operation: "upsert",
        entity: {
          kind: "approval",
          id: approvalRequestId,
          ...(state === undefined ? {} : { state }),
          touchedAt: event.occurredAt,
          ...(event.actorId === undefined ? {} : { attributedTo: event.actorId }),
          body,
        },
      },
    ];
  };
}
