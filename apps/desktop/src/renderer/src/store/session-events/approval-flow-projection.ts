// The `approval` partition's projector: approval-flow events folded into approval entities,
// including members that live only on the event, such as `askId` on a provider's own permission
// prompt. It sits beside the run fold because it reads wire member names, which the session
// store's entities do not.
//
// Each event is parsed with the strict payload schema of its type; the stream decoder only
// applies the tolerant envelope. A payload the schema refuses folds nothing, since a half-read
// ask would draw a card for an action nobody can see. A beat naming another session, and a rule
// revocation that names no ask, also fold nothing; the transcript still records that they arrived.
//
// State is marked, never deleted: a resolution or cancellation sets the entity's state and
// leaves the row.

import {
  ApprovalCanceledPayloadSchema,
  ApprovalRememberedPayloadSchema,
  ApprovalRequestedPayloadSchema,
  ApprovalResolvedPayloadSchema,
  ApprovalRuleRevokedPayloadSchema,
  type ApprovalRequestId,
  type ApprovalState,
} from "@ai-sidekicks/contracts/approval";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { SessionId } from "@ai-sidekicks/contracts/session/session";
import type { ZodType } from "@ai-sidekicks/contracts/jsonrpc/registry";

import { payloadNamesSession } from "@renderer/lib/wire/session-attribution.js";
import type {
  ProjectedSessionEvent,
  EntityMutation,
  EntityProjector,
  EntityProjectorTable,
} from "../session/entities/entities.js";

/**
 * The `approval_flow` events that are not an ask's and carry no `approvalRequestId`. Claiming
 * one here would take it from the feature that renders it. `Extract`ed from the event-type
 * union, so an upstream rename fails to compile.
 */
type NonRequestApprovalCategoryKind = Extract<
  SessionEventType,
  | "moderation.review_flagged"
  | "plan.proposed"
  | "plan.accepted"
  | "plan.handed_off"
  | "approval.reviewer_denied"
  | "approval.denial_overridden"
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

/** How one kind is read: the schema its payload parses with, and the state it announces. */
interface ApprovalEventReading {
  readonly schema: ZodType<ApprovalEventPayload>;
  readonly state: ApprovalState | undefined;
}

/**
 * Each kind's reading, total over the ask's kinds by `satisfies`.
 *
 * `approval.remembered` and `approval.rule_revoked` announce no state: one records the rule a
 * resolution minted after approval, the other is about the rule. The upsert then omits `state`
 * entirely, because the store's spread merge would read a present `undefined` as erasing the
 * last transition.
 */
const APPROVAL_EVENT_READINGS = {
  "approval.requested": { schema: ApprovalRequestedPayloadSchema, state: "pending" },
  "approval.approved": { schema: ApprovalResolvedPayloadSchema, state: "approved" },
  "approval.rejected": { schema: ApprovalResolvedPayloadSchema, state: "rejected" },
  "approval.canceled": { schema: ApprovalCanceledPayloadSchema, state: "canceled" },
  "approval.remembered": { schema: ApprovalRememberedPayloadSchema, state: undefined },
  "approval.rule_revoked": { schema: ApprovalRuleRevokedPayloadSchema, state: undefined },
} as const satisfies Readonly<Record<ApprovalEventKind, ApprovalEventReading>>;

/** The projector table the composer feature claims its kinds with, one fold per kind. */
export const APPROVAL_FLOW_PROJECTORS: EntityProjectorTable = Object.fromEntries(
  Object.entries(APPROVAL_EVENT_READINGS).map(([eventKind, reading]) => [
    eventKind,
    approvalFlowProjector(reading),
  ]),
);

/** The owner the approval-flow kinds are registered under, so a conflicting claim names it. */
export const APPROVAL_FLOW_PROJECTOR_OWNER = "composer";

/**
 * Fold one kind's events into the ask each names. The body is the parsed payload minus
 * `sessionId` (the envelope has it) and `approvalRequestId` (the entity's id).
 */
function approvalFlowProjector(reading: ApprovalEventReading): EntityProjector {
  return (event: ProjectedSessionEvent): readonly EntityMutation[] => {
    if (!payloadNamesSession(event.payload, event.sessionId)) {
      return [];
    }
    const parsed = reading.schema.safeParse(event.payload);
    if (!parsed.success) {
      return [];
    }
    const { sessionId: _sessionId, approvalRequestId, ...body } = parsed.data;
    if (approvalRequestId === undefined) {
      return [];
    }
    return [
      {
        operation: "upsert",
        entity: {
          kind: "approval",
          id: approvalRequestId,
          ...(reading.state === undefined ? {} : { state: reading.state }),
          touchedAt: event.occurredAt,
          ...(event.actorId === undefined ? {} : { attributedTo: event.actorId }),
          body,
        },
      },
    ];
  };
}
