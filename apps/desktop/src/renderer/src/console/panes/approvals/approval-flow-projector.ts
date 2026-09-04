// The `approval` partition's projector: approval-flow events folded into approval
// entities.
//
// WHY IT EXISTS. `store/entities.ts` has declared an `approval` partition since it
// was written and no family projected into it, so `session.subscribe` carried every
// `approval.*` beat into the timeline and none of them reached the partition a pane
// reads. The members that live on the EVENT and on no read went nowhere at all —
// `askId` above all, which `Spec-006 §Approval Flow (approval_flow)` registers on
// `approval.requested` exactly when the request originates from a provider
// permission ask. The projection read carries no marker of that origin, so a
// console with no fold here cannot tell a provider's mid-run permission ask from a
// request some caller made directly, and renders both as the same card.
//
// WHY IT LIVES BESIDE THE PANE. `frame/run-lifecycle-projector.ts` states the two
// constraints that decide a projector's home: it reads WIRE member names, which
// `store/` deliberately does not, and it is REGISTERED by a composition, which puts
// it at or below the composing family. Both are satisfied here — the approvals
// family already narrows this wire at one boundary (`approval-records.ts`) and the
// composer family composes it — and the frame is not this fold's owner, because the
// surface that reads the result is this pane.
//
// WHAT IT DERIVES RATHER THAN DECLARES
//
// The kinds it claims are read from `SESSION_EVENT_CATEGORY_BY_TYPE`, never from a
// list written here: a hand list is how a console silently stops projecting the day
// the taxonomy grows a ninth approval event. The category is not quite the claim,
// though, and the subtraction is named rather than silent — see
// `APPROVAL_FLOW_EVENT_KINDS` below.
//
// WHAT IT READS OFF A PAYLOAD, AND WHERE THAT LIST COMES FROM
//
// `packages/contracts` registers no approval payload variant at all —
// `SessionEventSchema` carries none, which `approval-vocabulary.ts` says in as many
// words — so there is no registered shape to derive a member union from. The list
// comes from where the corpus puts it: `Spec-006 §Approval Flow (approval_flow)`
// fixes the payload at `{sessionId, runId?, approvalRequestId?, askId?, category,
// scope, requestedBy?, resourceDescriptor?, expiryAt?, approver?, effectiveScope?,
// nodeId?, rememberedScope?, ruleId?, invalidationTrigger?}` and
// `api-payload-contracts.md §Plan-012` says which of them each variant carries. So
// the tables below are PER TYPE, on `run-lifecycle-projector.ts`'s precedent and for
// its reason: `approver` is a member of a resolution and of nothing else, and
// `invalidationTrigger` is a member of a revocation and of nothing else, so one flat
// table would read either off whichever beat happened to spell it — a body member
// with no registration behind it.
//
// PARSED THROUGH ZOD, which is this family's own boundary idiom rather than a second
// one: `approval-records.ts` narrows the two READS through zod schemas, and a member
// reader table written here would be a second implementation of "did the payload
// supply a value of the right shape" for the same wire. A wrong-typed member reads
// as ABSENT rather than as itself, and an absent member is left off the body
// entirely, because the store's merge is a spread and a present-but-`undefined` key
// erases what an earlier event established.
//
// STATE IS MARKED, NEVER DELETED. A resolution, an expiry, and a cancellation set
// the entity's state and leave the row where it is: history is a read, and what the
// pane lists is the pane's decision. The state values come from
// `approval-vocabulary.ts`'s closed five, so this module mints no sixth spelling of
// a vocabulary the surface already declares once.
//
// A PROJECTOR IS PURE, and that decides the malformed case exactly as it does for
// the run fold: an approval beat whose payload names no `approvalRequestId` yields
// NO mutation rather than a throw or a report. It names no entity to key on, the
// event is still admitted, and the timeline is the ledger that records it arrived.
// `approval.rule_revoked` reaches that path on purpose — a trust-triggered
// revocation carries no in-flight request.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";
import type { SessionEventType } from "@ai-sidekicks/contracts";
import { z } from "zod";

import type { ConsoleEntityProjectorRegistry } from "../../store/index.js";
import type {
  ConsoleSessionEvent,
  EntityMutation,
  EntityProjector,
  EntityProjectorRegistry,
} from "../../store/index.js";
import { type ApprovalState } from "./approval-vocabulary.js";

/**
 * The category's one event that is not an approval request's, named rather than
 * quietly filtered.
 *
 * `moderation.review_flagged` is registered under `approval_flow` and carries a
 * DISTINCT payload — `{sessionId, channelId, runId, agentId, eventId}` — with no
 * `approvalRequestId` anywhere in it. Claiming it here would take the kind off the
 * board for the family that renders moderation, and this fold would answer nothing
 * for it anyway, since it names no approval to key on. `Extract`ed from the census
 * rather than typed `string`, so a rename upstream fails to compile here instead of
 * silently widening the claim by one kind.
 */
const NON_REQUEST_APPROVAL_CATEGORY_KIND: Extract<SessionEventType, "moderation.review_flagged"> =
  "moderation.review_flagged";

/**
 * The event kinds this projector claims, derived from the shipped taxonomy.
 *
 * Filtered from the census by CATEGORY and then by the `approval.` namespace, so the
 * set is whatever the contract says it is at build time and the one subtraction is
 * the kind named above. The co-located test holds the difference to exactly that
 * one, so a ninth kind landing in the category under some other namespace fails
 * there rather than being dropped by a prefix nobody re-read.
 */
export const APPROVAL_FLOW_EVENT_KINDS: readonly string[] = [...SESSION_EVENT_CATEGORY_BY_TYPE]
  .filter(
    ([eventType, category]) =>
      category === "approval_flow" && eventType !== NON_REQUEST_APPROVAL_CATEGORY_KIND,
  )
  .map(([eventType]) => eventType);

/**
 * The seven `approval.*` kinds, as a type.
 *
 * Extracted from the census union by namespace rather than written out, so the type
 * and the runtime set above are two readings of one source: an eighth `approval.*`
 * kind added to the taxonomy lands in this union and fails the `satisfies` on both
 * tables below until someone classifies it.
 */
type ApprovalEventKind = Extract<SessionEventType, `approval.${string}`>;

/**
 * The state each kind announces, or `undefined` for a kind that announces none.
 *
 * Total over the seven by `satisfies`, and typed against
 * `approval-vocabulary.ts`'s closed five so a state invented here fails to compile
 * rather than reaching a card that renders it as an unrecognized token.
 *
 * The two `undefined` arms are decisions rather than gaps. `approval.remembered`
 * records that a resolution minted a standing rule — the request was already
 * approved, and writing a state for it would restate one transition as two — and
 * `approval.rule_revoked` is about the rule rather than about the request, so it
 * never moves the request's own state. Writing `undefined` for either is what keeps
 * the state a projector NAMES equal to the state its kind announces: the entity
 * upsert omits the member entirely rather than carrying a present `undefined`, which
 * the store's spread merge would read as an erasure of the last transition.
 */
const APPROVAL_STATE_BY_EVENT_KIND = {
  "approval.requested": "pending",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
  "approval.expired": "expired",
  "approval.canceled": "canceled",
  "approval.remembered": undefined,
  "approval.rule_revoked": undefined,
} as const satisfies Readonly<Record<ApprovalEventKind, ApprovalState | undefined>>;

/** How one member is read out of an untyped payload. */
type WireMemberSchema = z.ZodType<string> | z.ZodType<Readonly<Record<string, unknown>>>;

/** One member's schema: a non-empty wire string, carried verbatim. */
const wireStringMember: z.ZodType<string> = z.string().min(1);

/**
 * One member's schema: a structured wire value, carried WHOLE and unparsed.
 *
 * `resourceDescriptor` and `rememberedScope` are registered objects the console
 * renders through its own consumers — `formatWireDescriptor` and the vocabulary's
 * scope classifier — and re-validating their interiors here would be a second
 * reading of shapes those consumers already own.
 */
const wireObjectMember: z.ZodType<Readonly<Record<string, unknown>>> = z.record(
  z.string(),
  z.unknown(),
);

/**
 * The members any `approval.*` payload may carry, whatever its kind.
 *
 * Three, and the subtraction from the registered shape is worth reading: `sessionId`
 * rides the envelope and is checked against it rather than carried, and
 * `approvalRequestId` is the entity's own id. Carrying either onto the body would be
 * a second spelling of something the entity already holds, which the co-located test
 * refuses.
 */
const SHARED_APPROVAL_BODY_MEMBERS: Readonly<Record<string, WireMemberSchema>> = Object.freeze({
  /** The canonical category, wire-verbatim. Classified at render, never here. */
  category: wireStringMember,
  /** What was ASKED for. The reply's second scope, `effectiveScope`, is per-type. */
  scope: wireStringMember,
  /** The run that raised it, absent on a trust-triggered revocation. */
  runId: wireStringMember,
});

/**
 * The members each kind registers ALONE, and the schema that carries each one.
 *
 * Total over the seven by `satisfies`. Every entry is a member
 * `api-payload-contracts.md §Plan-012`'s per-variant refinement names for that
 * variant and for no other, and a member the shared table already carries would be a
 * second spelling of it — which the co-located test refuses outright rather than
 * leaving to review.
 */
const APPROVAL_BODY_MEMBERS_BY_EVENT_KIND = {
  // The request quad, plus the two members that make a provider permission ask
  // legible as one. `askId` is the originating `driver_ask` identifier and reaches
  // the console on this payload and on no read; `expiryAt` is required beside it by
  // the emission-seam pairing, so a body carrying the first without the second is a
  // contract violation rather than a terser request.
  "approval.requested": {
    requestedBy: wireStringMember,
    resourceDescriptor: wireObjectMember,
    askId: wireStringMember,
    expiryAt: wireStringMember,
  },
  // The resolution pair: who answered, and the scope that took effect — never
  // broader than what was requested.
  "approval.approved": { approver: wireStringMember, effectiveScope: wireStringMember },
  "approval.rejected": { approver: wireStringMember, effectiveScope: wireStringMember },
  // Neither settlement carries anything the request did not already establish. The
  // empty table is the registration, not an omission.
  "approval.expired": {},
  "approval.canceled": {},
  // The full rule projection, so a peer or a replay rebuilds the standing grant:
  // the grantor, the node the grant is bound to, the binding itself, and the rule's
  // own id.
  "approval.remembered": {
    approver: wireStringMember,
    nodeId: wireStringMember,
    rememberedScope: wireObjectMember,
    ruleId: wireStringMember,
  },
  // A revocation names the rule and why it died. It reaches an approval entity only
  // where the payload also names the request the rule was minted from.
  "approval.rule_revoked": { ruleId: wireStringMember, invalidationTrigger: wireStringMember },
} as const satisfies Readonly<
  Record<ApprovalEventKind, Readonly<Record<string, WireMemberSchema>>>
>;

/** The per-type table for a kind that registers no members of its own. */
const NO_KIND_MEMBERS: Readonly<Record<string, WireMemberSchema>> = Object.freeze({});

/**
 * Fold one approval-flow event into the approval it names.
 *
 * Pure and total: it reads the event and answers with mutations, and every path
 * through it answers — a payload naming another session and a payload it cannot key
 * on each answer with none.
 */
export const projectApprovalFlowEvent: EntityProjector = (
  event: ConsoleSessionEvent,
): readonly EntityMutation[] => {
  const payload = event.payload;
  // First, and for every kind at once: the beat is folded into the store it was
  // delivered into, so a payload that names another session names an entity this
  // store must not hold. `sessionId` is a REQUIRED member of the registered shape,
  // so an omission is malformed rather than terse, and the comparison is against the
  // raw member so a non-string one fails here instead of reading as absence.
  if (payload?.["sessionId"] !== event.sessionId) {
    return [];
  }
  const approvalRequestId = wireStringMember.safeParse(payload["approvalRequestId"]);
  if (!approvalRequestId.success) {
    return [];
  }
  const announcedState = approvalStateFor(event.kind);
  const body = readApprovalEntityBody(event.kind, payload);
  return [
    {
      operation: "upsert",
      entity: {
        kind: "approval",
        id: approvalRequestId.data,
        // Present only where the kind announces one. A spread merge treats a present
        // `undefined` as an erasure, so a rule beat must not clear the state the
        // request's own transition established.
        ...(announcedState === undefined ? {} : { state: announcedState }),
        touchedAt: event.occurredAt,
        ...(event.actorId === undefined ? {} : { attributedTo: event.actorId }),
        ...(body === undefined ? {} : { body }),
      },
    },
  ];
};

/**
 * The projector registry the composer family claims its kinds with.
 *
 * One function under every kind rather than one per kind: the fold is the same for
 * all seven, and seven near-copies is how the eighth gets a subtly different one.
 */
export const APPROVAL_FLOW_PROJECTORS: EntityProjectorRegistry = buildApprovalFlowProjectors();

/** The name this family claims its event kinds under, so a conflict names it. */
const APPROVAL_FLOW_PROJECTOR_OWNER = "composer";

/**
 * The composer family's claim on the approval-flow kinds.
 *
 * Registration rather than a table handed downstream, for the reason the seam exists:
 * the fold a store is opened with decides which family can own which partition, and
 * a family that cannot project its own category reads the wire twice and keeps the
 * result beside the store rather than in it.
 */
export function registerApprovalFlowProjectors(registry: ConsoleEntityProjectorRegistry): void {
  registry.registerAll(APPROVAL_FLOW_PROJECTORS, APPROVAL_FLOW_PROJECTOR_OWNER);
}

function buildApprovalFlowProjectors(): EntityProjectorRegistry {
  const projectors: Record<string, EntityProjector> = {};
  for (const eventKind of APPROVAL_FLOW_EVENT_KINDS) {
    projectors[eventKind] = projectApprovalFlowEvent;
  }
  return projectors;
}

/**
 * The state this kind announces, or `undefined` for one that announces none.
 *
 * `Object.hasOwn` rather than an indexed read: the kind arrives wire-verbatim, so
 * `"constructor"` reaches this lookup exactly as a real kind does and an indexed
 * read would answer it with something off `Object.prototype`.
 */
function approvalStateFor(eventKind: string): ApprovalState | undefined {
  return Object.hasOwn(APPROVAL_STATE_BY_EVENT_KIND, eventKind)
    ? APPROVAL_STATE_BY_EVENT_KIND[eventKind as ApprovalEventKind]
    : undefined;
}

/**
 * The body members this payload names, or `undefined` when it names none.
 *
 * Walks the two tables rather than reading members by name, so the set the body
 * carries and the set the corpus registers cannot come apart. A member neither table
 * names is not read at all — it is absent from both, so it never reaches the body
 * however the payload spells it.
 */
function readApprovalEntityBody(
  eventKind: string,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const body: Record<string, unknown> = {};
  for (const members of [SHARED_APPROVAL_BODY_MEMBERS, kindMembersFor(eventKind)]) {
    for (const [member, schema] of Object.entries(members)) {
      const parsed = schema.safeParse(payload[member]);
      if (parsed.success) {
        body[member] = parsed.data;
      }
    }
  }
  return Object.keys(body).length === 0 ? undefined : body;
}

/** The per-type members this kind registers, or none for a kind that registers none. */
function kindMembersFor(eventKind: string): Readonly<Record<string, WireMemberSchema>> {
  return Object.hasOwn(APPROVAL_BODY_MEMBERS_BY_EVENT_KIND, eventKind)
    ? APPROVAL_BODY_MEMBERS_BY_EVENT_KIND[eventKind as ApprovalEventKind]
    : NO_KIND_MEMBERS;
}

/**
 * The member tables, as data, so a test can hold the claims they make.
 *
 * Exported as one value rather than two, because every claim about them is a claim
 * about the PAIR — that no member is spelled in both, that the entity's own identity
 * is in neither, and that the per-type table is total over the claimed kinds.
 */
export const APPROVAL_BODY_MEMBER_TABLES: {
  readonly shared: Readonly<Record<string, WireMemberSchema>>;
  readonly byEventKind: Readonly<Record<string, Readonly<Record<string, WireMemberSchema>>>>;
} = Object.freeze({
  shared: SHARED_APPROVAL_BODY_MEMBERS,
  byEventKind: APPROVAL_BODY_MEMBERS_BY_EVENT_KIND,
});
