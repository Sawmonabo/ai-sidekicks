// The `approval` partition's projector: approval-flow events folded into approval
// entities.
//
// WHY IT EXISTS. `store/session/entities/entities.ts` declares an `approval` partition,
// and `session.subscribe` carries every `approval.*` event into the timeline. This fold
// is what puts each ask into the partition a pane reads, together with the members that
// live on the event and on no read: `askId` above all, which `approval.requested` carries
// when the ask came from a provider's own permission prompt.
//
// WHY IT LIVES BESIDE THE RUN FOLD. It reads wire member names, which the session
// store's entities deliberately do not, and the composition root registers it under the
// composer's name, because the pane that reads the result is the composer's.
//
// EACH EVENT IS READ THROUGH ITS OWN CONTRACT SCHEMA. The stream decoder parses every
// event through the tolerant envelope, so a payload reaches this fold unexamined. Each
// `approval.*` type has one strict payload schema in `@ai-sidekicks/contracts`, and the
// fold parses the payload with the schema its type names. A payload that schema refuses
// is not folded at all: a half-read ask would draw a card for an action nobody can see.
//
// STATE IS MARKED, NEVER DELETED. A resolution and a cancellation set the entity's state
// and leave the row where it is: history is a read, and what the pane lists is the
// pane's decision.
//
// A PROJECTOR IS PURE. A beat that names another session, one whose payload its schema
// refuses, and a rule revocation that names no ask (a project detached, a server's trust
// withdrawn) each yield no mutation rather than a throw. The event is still admitted,
// and the timeline is the ledger that records it arrived.

import {
  ApprovalCanceledPayloadSchema,
  ApprovalRememberedPayloadSchema,
  ApprovalRequestedPayloadSchema,
  ApprovalResolvedPayloadSchema,
  ApprovalRuleRevokedPayloadSchema,
  type ApprovalRequestId,
  type ApprovalState,
  type SessionEventType,
  type SessionId,
  type ZodType,
} from "@ai-sidekicks/contracts";

import { payloadNamesSession } from "@renderer/lib/wire-session-attribution.js";
import type {
  ProjectedSessionEvent,
  EntityMutation,
  EntityProjector,
  EntityProjectorTable,
} from "../session/entities/entities.js";

/**
 * The category's events that are not an ask's, named rather than quietly filtered.
 *
 * `moderation.review_flagged`, the three `plan.*` kinds, and the reviewer's block and
 * its one-time allowance (`approval.reviewer_denied`, `approval.denial_overridden`,
 * keyed on the denial) are registered under `approval_flow` and carry no
 * `approvalRequestId`. Claiming one here would take the kind off the board for the
 * feature that renders it. `Extract`ed from the census rather than typed `string`, so a
 * rename upstream fails to compile here.
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

/**
 * The ask's `approval.*` kinds, as a type. Extracted from the census union, so a new
 * `approval.*` kind fails the `satisfies` on the table below until it is classified.
 */
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
 * Each kind's reading. Total over the ask's kinds by `satisfies`.
 *
 * `approval.remembered` and `approval.rule_revoked` announce no state: the first records
 * the rule a resolution minted, after the ask was already approved, and the second is
 * about the rule rather than the ask. The entity upsert then omits `state` entirely,
 * because the store's spread merge would read a present `undefined` as an erasure of the
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

/** The event kinds this projector claims: the ask's `approval.*` kinds. */
export const APPROVAL_FLOW_EVENT_KINDS: readonly string[] = Object.keys(APPROVAL_EVENT_READINGS);

/**
 * The projector registry the composer feature claims its kinds with, one fold per kind
 * over that kind's reading.
 */
export const APPROVAL_FLOW_PROJECTORS: EntityProjectorTable = Object.fromEntries(
  Object.entries(APPROVAL_EVENT_READINGS).map(([eventKind, reading]) => [
    eventKind,
    approvalFlowProjector(reading),
  ]),
);

/**
 * The owner the approval-flow kinds are registered under, so a conflicting claim names
 * it. The composition registers {@link APPROVAL_FLOW_PROJECTORS} under it.
 */
export const APPROVAL_FLOW_PROJECTOR_OWNER = "composer";

/**
 * Fold one kind's events into the ask each names.
 *
 * The body carries the parsed payload minus `sessionId`, which the envelope already
 * states, and `approvalRequestId`, which is the entity's own id.
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
