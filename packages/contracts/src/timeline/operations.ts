// Plan-013 T1.3 + T1.4 — the four timeline operations' request/response pairs:
// `TimelineRead`, `TimelineSubscribe`, `ReasoningSurfaceRead`, `ChildRunExpand`.
//
// PROVENANCE. The canonical shapes are
// `docs/architecture/contracts/api-payload-contracts.md` §"Plan-013 — Live
// Timeline Visibility And Reasoning Surfaces" and its §"Timeline Method-Name
// Registry (Tier 8, Plan-013 T1.4)"; the behavior they serve is
// `Spec-013 §Interfaces And Contracts`, `Spec-013 §Required Behavior`, and
// `Spec-013 §Fallback Behavior`. This module APPLIES them; it decides nothing.
//
// ----------------------------------------------------------------------------
// ONE ROW SCHEMA, TWO CARRIERS
// ----------------------------------------------------------------------------
//
// `TimelineReadResponse.entries`, the `timeline.subscribe` stream, and
// `ChildRunExpandResponse.entries` are all `TimelineRow` — the SAME
// `TimelineRowSchema` instance, not three structurally-equal copies. That is
// the whole of `Plan-013 §API And Transport Changes`' "live subscription
// payloads and replay windows use the same row schema so reconnect recovery
// does not require projection translation": a replay row and a live row are
// indistinguishable to a parser because there is only one parser.
//
// ----------------------------------------------------------------------------
// EVERY PAGED REPLY IS BOUNDED BY THE FRAME IT WILL BECOME
// ----------------------------------------------------------------------------
//
// A reply leaves the daemon inside ONE `Content-Length`-framed JSON-RPC body,
// and a body over `MAX_MESSAGE_BYTES` is not a failed request — the framer
// refuses to emit it and the CONNECTION CLOSES (`Spec-007 §Wire Format`,
// F-007p-2-05). So an oversized page does not degrade one read; it drops the
// live subscription, the pending calls, and the client's session with it.
//
// A row-count ceiling alone does not bound that, and the arithmetic says so
// rather than the intuition: a `TimelineRow` carries three free-form fields at
// `EVENT_FIELD_MAX_LEN` (`id`, `type`, `actor`) plus a 4 KiB `summary`, and
// `JSON.stringify` expands a control character to a six-byte `\uXXXX` escape,
// so ONE contract-valid row can exceed 30 KB and {@link TIMELINE_READ_LIMIT_MAX}
// of them exceed the frame cap several times over — before `payload`, which is
// an open record this contract does not bound at all.
//
// Hence {@link TIMELINE_PAGE_MAX_BYTES}: each paged member is measured against
// the frame it will occupy, by the same function
// ({@link countEntriesFittingOneFrame}) a producer uses to decide where to
// stop. The producer stops at whichever of the row limit and the byte budget
// trips first and sets `hasMore` accordingly; the schema is what makes that
// obligation enforceable rather than merely documented.
//
// SCOPE. This bounds the three PAGED replies. It does not bound one
// `timeline.subscribe` emission, which is a single row on its own
// `$/subscription/notify` frame: a row large enough to blow a frame by itself
// is an oversized projected event payload, and `session.subscribe` has carried
// that exposure since it shipped. Bounding it is a decision about the event
// envelope (Plan-006) and the framer (Plan-007), not one a Plan-013 page
// budget may make on their behalf.
//
// ----------------------------------------------------------------------------
// The `ReasoningSurfaceReadRequest` principal: no wire member, by design
// ----------------------------------------------------------------------------
//
// SETTLED, not omitted. The Tier-8 plan-readiness audit (§6 node NS-20) left
// this request's authorization principal recorded as unshaped; it is shaped
// here as the decision that it carries none.
//
// The principal is resolved by the class rule in `api-payload-contracts.md
// §Authenticated Principal And Authorization Model`: that section scopes every
// endpoint to the authenticated caller implicitly, and its
// informational-body-fields rule makes any participant-naming body field
// routing and audit metadata Cedar does not read. So a principal member would
// be inert at best, and at worst the second source of identity truth that rule
// exists to forbid. The request is `{ runId, afterCursor? }` and its schema is
// `.strict()`, which makes the decision enforceable rather than merely stated:
// a caller that sends a principal is REFUSED, not silently stripped.
//
// This is not a sixth instance of that section's numbered admitting-write list.
// Instances (1)-(5) each name where a resolved principal is RETAINED on a
// durable carrier; this read admits nothing and writes no row, so it has
// nothing to retain and sits under the resolution rules instead.
//
// The transport carrier is `HandlerContext` (`../jsonrpc-registry.ts`), which
// every registered handler receives beside its parsed params. It carries
// `transportId` alone today and is documented as widening additively — so the
// principal reaches a handler through that context when Plan-007 widens it,
// and never through this request type. Phase 1 registers no handler, so there
// is no reader to point at yet; what Phase 1 fixes is that there is no wire
// member for a later reader to be tempted by.
import { z } from "zod";

import { MAX_MESSAGE_BYTES, jsonUtf8ByteLength } from "../jsonrpc.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "../jsonrpc-streaming.js";
import { RunIdSchema, type RunId } from "../provider-driver.js";
import { RunStateSchema, type RunState } from "../runControl.js";
import {
  ChannelIdSchema,
  EventCursorSchema,
  SessionIdSchema,
  wireFreeFormString,
  type ChannelId,
  type EventCursor,
  type SessionId,
} from "../session.js";

import { TimelineRowSchema, type TimelineRow } from "./row.js";

// ---------------------------------------------------------------------------
// Frame budget — shared by all three paged replies
// ---------------------------------------------------------------------------

/**
 * Bytes held back from {@link MAX_MESSAGE_BYTES} for everything in the frame
 * body that is NOT the paged member.
 *
 * Derivation, all figures worst case in bytes:
 *
 *   * JSON-RPC response envelope `{"jsonrpc":"2.0","id":…,"result":…}` —
 *     33 bytes of punctuation and keys.
 *   * The echoed request `id` — 256 bytes allowed. JSON-RPC 2.0 §4 permits a
 *     string id and the substrate echoes it verbatim without interpreting it,
 *     so this is an allowance rather than a bound: a caller that mints a
 *     megabyte-long id displaces the page, and no RESPONSE schema can bound a
 *     member the response does not choose. That is the framer's concern
 *     (`local-ipc-gateway.ts`), which sees the whole body; it is named here so
 *     the omission is a decision rather than an oversight.
 *   * The widest non-paged result member set, `ChildRunExpandResponse` on its
 *     continuing arm — `runId` 46, `parentRunId` 53, `state` 41, the
 *     `"entries":[…]` key 11, `"hasMore":true` 15, and `nextCursor` 1552
 *     (`EVENT_CURSOR_MAX_LEN` = 256 characters, each able to escape to six
 *     bytes, plus quotes and key), plus 2 for the braces — 1720 bytes.
 *
 * Total 2009. Reserved at 8192, roughly fourfold headroom, because the cost of
 * over-reserving is a marginally earlier page break and the cost of
 * under-reserving is a closed connection.
 */
export const TIMELINE_PAGE_FRAME_RESERVE_BYTES = 8192;

/**
 * The byte ceiling on ONE paged member — `TimelineReadResponse.entries`,
 * `ChildRunExpandResponse.entries`, or
 * `ReasoningSurfaceReadResponse.reasoningEntries` — measured as
 * {@link jsonUtf8ByteLength} of the array itself.
 *
 * Shared across the three operations rather than split per-operation: the
 * quantity being bounded is the same one in all three cases (the frame the
 * reply becomes), and three constants would invite three different answers to
 * one question.
 */
export const TIMELINE_PAGE_MAX_BYTES: number =
  MAX_MESSAGE_BYTES - TIMELINE_PAGE_FRAME_RESERVE_BYTES;

/**
 * How many LEADING entries of `candidates` fit one frame, capped at
 * `maxCount` — the producer's half of {@link TIMELINE_PAGE_MAX_BYTES}.
 *
 * The count is exact rather than estimated, because the arithmetic of a JSON
 * array is exact: `JSON.stringify([a, b])` is the two element encodings, one
 * comma, and two brackets. Accumulating per element therefore yields the same
 * number {@link jsonUtf8ByteLength} would return for the resulting slice, so a
 * page built with this function is accepted by the schema that enforces the
 * same budget — the producer and the validator agree by construction and not
 * by two authors keeping two estimates in step.
 *
 * A caller stops at `min(count, maxCount)` and sets `hasMore` from whether any
 * candidate was left behind.
 *
 * RETURNING ZERO IS A REAL OUTCOME, not a page break. It means the FIRST
 * candidate alone cannot fit a frame, and a caller that treats it as an empty
 * page with `hasMore: true` has built a cursor that never advances. The honest
 * response is to fail the read: the row exists, it cannot be delivered under
 * this transport, and saying so is the only answer that does not loop.
 */
export function countEntriesFittingOneFrame(
  candidates: readonly unknown[],
  maxCount: number,
): number {
  // The two brackets are charged up front; every element past the first also
  // charges its separating comma.
  let usedBytes = 2;
  let fittedCount = 0;
  const ceiling = Math.min(maxCount, candidates.length);
  for (let index = 0; index < ceiling; index += 1) {
    const entryBytes = jsonUtf8ByteLength(candidates[index]);
    const separatorBytes = fittedCount === 0 ? 0 : 1;
    if (usedBytes + separatorBytes + entryBytes > TIMELINE_PAGE_MAX_BYTES) {
      break;
    }
    usedBytes += separatorBytes + entryBytes;
    fittedCount += 1;
  }
  return fittedCount;
}

/**
 * Refuse a paged member that cannot ride one frame.
 *
 * `path` names the member rather than the response, so a client that logs the
 * issue path learns WHICH array overflowed on a response carrying more than
 * one.
 */
const requirePageToRideOneFrame = (
  pagedMember: readonly unknown[],
  memberName: string,
  issueContext: z.RefinementCtx,
): void => {
  const measuredBytes = jsonUtf8ByteLength(pagedMember);
  if (measuredBytes > TIMELINE_PAGE_MAX_BYTES) {
    issueContext.addIssue({
      code: "custom",
      path: [memberName],
      message:
        `${memberName} measures ${String(measuredBytes)} JSON bytes, over the ` +
        `${String(TIMELINE_PAGE_MAX_BYTES)}-byte page budget: the reply would exceed the ` +
        "single-frame limit, which closes the connection rather than failing the request — " +
        "the producer must page instead, stopping at whichever of the row limit and the byte " +
        "budget trips first",
    });
  }
};

/**
 * Adjacent entries must not go backwards in sequence.
 *
 * `Spec-013 §Default Behavior`: "Timeline rows default to chronological order
 * from oldest to newest within the current view." A page that arrives out of
 * order forces every consumer to re-sort a window the producer already had in
 * order, and a consumer that does not re-sort renders the session's history
 * scrambled.
 *
 * NONDECREASING and deliberately not strictly increasing. Session sequence is
 * unique per event, so a strict check would hold today — but it would also
 * make it a parse failure for a projection to emit two rows from one event,
 * and no section of Spec-013 forbids that. The rule here is the one the spec
 * states: the order never reverses.
 */
const requireNondecreasingSequence = (
  entries: readonly { sequence: number }[],
  issueContext: z.RefinementCtx,
): void => {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (current.sequence < previous.sequence) {
      issueContext.addIssue({
        code: "custom",
        path: ["entries", index, "sequence"],
        message:
          `timeline entries run oldest-to-newest: sequence ${String(current.sequence)} follows ` +
          `${String(previous.sequence)}, so this window is out of order`,
      });
    }
  }
};

// ---------------------------------------------------------------------------
// TimelineRead
// ---------------------------------------------------------------------------

/**
 * Ceiling on a single `timeline.read` window.
 *
 * `Spec-013 §Interfaces And Contracts` requires `TimelineRead` to "support
 * bounded windows"; an uncapped `limit` would make the window bounded only by
 * whatever the caller asked for, which is the opposite. Sized to match this
 * package's other capped-count wire members (`DRIVER_WIRE_CATALOG_ENTRIES_MAX`)
 * rather than picking a fresh magnitude — the cursor-based continuation
 * `TimelineReadResponse.nextCursor` carries is how a caller reads more, so a
 * higher cap buys nothing a second call does not.
 *
 * A COUNT CEILING, NOT A SIZE ONE. Reaching it is not what usually ends a
 * page; {@link TIMELINE_PAGE_MAX_BYTES} typically trips first, and must, since
 * this many worst-case rows do not fit one frame.
 */
export const TIMELINE_READ_LIMIT_MAX = 256;

/**
 * A bounded read window over one session's timeline.
 *
 * `afterCursor` and `beforeCursor` are independently optional — the pair spans
 * forward paging, backward paging, and a bounded range — and both are the
 * opaque `EventCursor` Plan-006 owns. `channelId` filters to one channel's
 * rows; per I-013-6 that filter NEVER suppresses a `run.rolled_back` boundary
 * for a run whose rows the filter admits, which is a delivery rule the daemon
 * enforces and not something this request shape can express.
 */
export interface TimelineReadRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor | undefined;
  beforeCursor?: EventCursor | undefined;
  limit?: number | undefined;
  channelId?: ChannelId | undefined;
}

/**
 * `z.ZodType<T, T>` — the double-T request form this package uses so
 * Standard-Schema-V1 input inference survives (see `session.ts`).
 */
export const TimelineReadRequestSchema: z.ZodType<TimelineReadRequest, TimelineReadRequest> = z
  .object({
    sessionId: SessionIdSchema,
    afterCursor: EventCursorSchema.optional(),
    beforeCursor: EventCursorSchema.optional(),
    limit: z.number().int().positive().max(TIMELINE_READ_LIMIT_MAX).optional(),
    channelId: ChannelIdSchema.optional(),
  })
  .strict();

/**
 * One read window, discriminated on `hasMore`.
 *
 * `hasMore` is REQUIRED and separate from `nextCursor`'s presence: a caller
 * must be able to tell "the window ended and there is more" from "the window
 * ended and there is not" without inferring it from an optional member's
 * absence.
 *
 * THE CURSOR IS REQUIRED ON THE CONTINUING ARM. `Spec-013 §Interfaces And
 * Contracts` requires `TimelineRead` to "support bounded windows and
 * cursor-based continuation". A response saying `hasMore: true` while carrying
 * no cursor promises more and supplies no way to ask for it — the caller's only
 * recoveries are to re-read the same window forever or to give up, and both
 * lose timeline rows the session actually holds. A union rather than a
 * refinement so the guarantee is a TYPE: a consumer that narrows on
 * `hasMore === true` reaches a `nextCursor` that is present, with no non-null
 * assertion and no optional chain.
 *
 * THE CURSOR IS PERMITTED, NOT FORBIDDEN, ON THE TERMINAL ARM. The two members
 * answer different questions — `hasMore` says whether unread rows remain,
 * `nextCursor` says where this window ended — and they are not contradictory
 * on a final page. `Spec-013 §Interfaces And Contracts` also requires
 * `TimelineSubscribe` to "support live append plus replay recovery", and a
 * client that has just read to the end and now wants to subscribe from exactly
 * there needs precisely that position. Forbidding it would make a caller
 * re-derive the position from the last row, or re-read the final window, to
 * recover something the producer already held.
 */
export type TimelineReadResponse =
  | { entries: TimelineRow[]; hasMore: true; nextCursor: EventCursor }
  | { entries: TimelineRow[]; hasMore: false; nextCursor?: EventCursor | undefined };

const timelineReadEntriesSchema = z.array(TimelineRowSchema).max(TIMELINE_READ_LIMIT_MAX);

/**
 * `entries` is capped at the same {@link TIMELINE_READ_LIMIT_MAX} the request's
 * `limit` is, and deliberately shares the one constant: a response cap looser
 * than the request cap would let a producer answer a bounded ask with an
 * unbounded window, which is the bound the request cap exists to impose read
 * from the other side. The byte budget and the ordering rule apply to both
 * arms, so they are refined on the union rather than duplicated per arm.
 */
export const TimelineReadResponseSchema: z.ZodType<TimelineReadResponse> = z
  .discriminatedUnion("hasMore", [
    z
      .object({
        entries: timelineReadEntriesSchema,
        hasMore: z.literal(true),
        nextCursor: EventCursorSchema,
      })
      .strict(),
    z
      .object({
        entries: timelineReadEntriesSchema,
        hasMore: z.literal(false),
        nextCursor: EventCursorSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((response, issueContext) => {
    requirePageToRideOneFrame(response.entries, "entries", issueContext);
    requireNondecreasingSequence(response.entries, issueContext);
  });

// ---------------------------------------------------------------------------
// TimelineSubscribe
// ---------------------------------------------------------------------------

/**
 * A live subscription with replay catch-up from `afterCursor`
 * (`Spec-013 §Fallback Behavior`: "if live delivery gaps occur, the client must
 * request replay from the canonical event source").
 *
 * Deliberately carries no `lastEventId`: that member exists on
 * `SessionSubscribeRequest` because tRPC's HTTP substrate injects the
 * `Last-Event-ID` resumption header into the input object pre-validation. The
 * timeline surface rides the daemon JSON-RPC transport ONLY — the canonical
 * Timeline Method-Name Registry says so, and ADR-017 is why — so no such
 * injection reaches this shape and declaring the member would be inventing a
 * second resumption channel beside `afterCursor`.
 */
export interface TimelineSubscribeRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor | undefined;
  channelId?: ChannelId | undefined;
}

export const TimelineSubscribeRequestSchema: z.ZodType<
  TimelineSubscribeRequest,
  TimelineSubscribeRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    afterCursor: EventCursorSchema.optional(),
    channelId: ChannelIdSchema.optional(),
  })
  .strict();

/**
 * `timeline.subscribe`'s init ack — an ALIAS SEAM over the canonical generic
 * `SubscribeAckResponse`, the same shape `SessionSubscribeResponse` takes and
 * for the same reason: today the ack is exactly `{ subscriptionId }`, and the
 * seam exists so a future timeline-specific divergence stays localized here.
 *
 * The ack is what the method's registered result schema validates; the ROW
 * union is what each emission carries. The canonical registry table's response
 * column names the emission type (`TimelineRow`) because that is the wire fact
 * a client cares about — see `TIMELINE_METHOD_DESCRIPTORS` in `./methods.js`,
 * where both are bound to the method side by side.
 */
export type TimelineSubscribeResponse = SubscribeAckResponse;
export const TimelineSubscribeResponseSchema: z.ZodType<TimelineSubscribeResponse> =
  SubscribeAckResponseSchema;

// ---------------------------------------------------------------------------
// ReasoningSurfaceRead
// ---------------------------------------------------------------------------

/**
 * Cap on `reasoningEntries` — the "bounded" in T1.3's "`available` requires the
 * bounded `reasoningEntries`". `Spec-013 §Default Behavior` makes durable
 * reasoning summary-first, so a reply needing more than this many normalized
 * entries has stopped being a summary.
 */
export const REASONING_SURFACE_ENTRIES_MAX = 256;

/** Cap on one normalized reasoning entry's `content`. */
export const REASONING_ENTRY_CONTENT_MAX_LEN = 16384;

/** Cap on `policyReason`, the operator-facing redaction explanation. */
export const REASONING_POLICY_REASON_MAX_LEN = 512;

/**
 * The read is run-scoped, with the same cursor continuation the timeline
 * window carries. See this file's header for why no principal member is
 * declared.
 *
 * `afterCursor` is the SAME opaque `EventCursor` the other two reads take, and
 * not a `sequence` offset of its own: a reasoning entry is projected from the
 * run's events, so its continuation position is an event position, and giving
 * one namespace two continuation vocabularies would make a client hold two
 * kinds of bookmark for one surface.
 */
export interface ReasoningSurfaceReadRequest {
  runId: RunId;
  afterCursor?: EventCursor | undefined;
}

export const ReasoningSurfaceReadRequestSchema: z.ZodType<
  ReasoningSurfaceReadRequest,
  ReasoningSurfaceReadRequest
> = z.object({ runId: RunIdSchema, afterCursor: EventCursorSchema.optional() }).strict();

/** One normalized reasoning entry, ordered by its originating `sequence`. */
export interface ReasoningEntry {
  sequence: number;
  content: string;
  timestamp: string;
}

export const ReasoningEntrySchema: z.ZodType<ReasoningEntry> = z
  .object({
    sequence: z.number().int().nonnegative(),
    content: wireFreeFormString(REASONING_ENTRY_CONTENT_MAX_LEN, "ReasoningEntry.content"),
    timestamp: z.iso.datetime({ offset: true }),
  })
  .strict();

/**
 * The closed four-state reasoning-availability reply.
 *
 * The prior shape was `available: boolean` with two free optionals, which
 * serialized the available / unavailable / compacted / policy-redacted cases
 * IDENTICALLY and left `Spec-013 §Acceptance Criteria`'s distinguish-the-cases
 * requirement unrepresentable. The Tier-8 audit's Codex round replaced it in
 * place rather than compatibility-extending it: the shape predated that PR as
 * canonical-doc text only, with no shipped emitter or parser, so ADR-018's
 * deployed-skew rules — which guard from the first shipped parser onward —
 * impose no legacy boolean arm. This module is that first shipped parser, and
 * it ships with NO tolerant fallback arm: the legacy boolean shape fails parse.
 *
 * Per-state field rules, each enforced by `.strict()` on its own arm rather
 * than narrated:
 *   * `available` REQUIRES `reasoningEntries` and admits no `policyReason`. It
 *     is the one paged state, so it is the one that carries `hasMore` — and,
 *     on the continuing arm, the `nextCursor` to continue from.
 *   * `policy_redacted` REQUIRES `policyReason` and admits no entries — the
 *     redaction renders as an explicit surface, never as absence (I-013-7).
 *   * `unavailable` and `compacted` carry NEITHER; the client renders the
 *     placeholder from the state itself. `compacted` names WHY expansion is
 *     empty, and neither state erases the durable summary or the policy marker
 *     that remain canonical on the summary-first surface (I-013-8).
 *
 * No two states serialize identically, so a state-inconsistent field set is a
 * parse failure rather than a rendering ambiguity.
 *
 * `available` SPLITS ON `hasMore` exactly as `TimelineReadResponse` does, and
 * for the same reason: a bounded surface that cannot say where it stopped has
 * no continuation. The union nests — outer on `availability`, inner on
 * `hasMore` — rather than flattening, so `availability` keeps selecting one
 * option and the four states stay four.
 */
export type ReasoningSurfaceReadResponse =
  | {
      availability: "available";
      reasoningEntries: ReasoningEntry[];
      hasMore: true;
      nextCursor: EventCursor;
    }
  | {
      availability: "available";
      reasoningEntries: ReasoningEntry[];
      hasMore: false;
      nextCursor?: EventCursor | undefined;
    }
  | { availability: "unavailable" }
  | { availability: "compacted" }
  | { availability: "policy_redacted"; policyReason: string };

// NON-EMPTY. An `available` arm carrying zero entries claims a reasoning
// surface exists and then shows nothing, which renders identically to
// `unavailable` while asserting the opposite — the collapse
// `Spec-013 §Acceptance Criteria`'s distinguish-the-cases requirement forbids,
// and which I-013-7 ("redaction never renders as absence") forbids in the
// redaction direction. A producer with no entries to serve has three honest
// arms to choose from and must pick one.
const reasoningEntriesSchema = z
  .array(ReasoningEntrySchema)
  .min(1)
  .max(REASONING_SURFACE_ENTRIES_MAX);

const reasoningAvailableArmSchema = z
  .discriminatedUnion("hasMore", [
    z
      .object({
        availability: z.literal("available"),
        reasoningEntries: reasoningEntriesSchema,
        hasMore: z.literal(true),
        nextCursor: EventCursorSchema,
      })
      .strict(),
    z
      .object({
        availability: z.literal("available"),
        reasoningEntries: reasoningEntriesSchema,
        hasMore: z.literal(false),
        nextCursor: EventCursorSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((availableResponse, issueContext) => {
    requirePageToRideOneFrame(availableResponse.reasoningEntries, "reasoningEntries", issueContext);
  });

export const ReasoningSurfaceReadResponseSchema: z.ZodType<ReasoningSurfaceReadResponse> =
  z.discriminatedUnion("availability", [
    reasoningAvailableArmSchema,
    z.object({ availability: z.literal("unavailable") }).strict(),
    z.object({ availability: z.literal("compacted") }).strict(),
    z
      .object({
        availability: z.literal("policy_redacted"),
        policyReason: wireFreeFormString(
          REASONING_POLICY_REASON_MAX_LEN,
          "ReasoningSurfaceReadResponse.policyReason",
        ),
      })
      .strict(),
  ]);

/**
 * The closed `availability` vocabulary, in the union's own arm order. Exported
 * so a renderer switching on the state asserts exhaustiveness against the
 * contract — the mechanism behind I-013-7's "every non-`available` state
 * produces a visible explanation surface".
 *
 * FOUR VALUES, FIVE TYPE ARMS: `available` splits on `hasMore` for its
 * continuation, which is a paging distinction and not a fifth state, so it
 * contributes one entry here.
 */
export const REASONING_AVAILABILITY_STATES: readonly ReasoningSurfaceReadResponse["availability"][] =
  Object.freeze(["available", "unavailable", "compacted", "policy_redacted"] as const);

// ---------------------------------------------------------------------------
// ChildRunExpand
// ---------------------------------------------------------------------------

/**
 * Expand one summarized child-run row into its own timeline rows, continuing
 * from `afterCursor` when the previous expansion did not reach the end.
 *
 * Named `afterCursor` to match the sibling reads rather than a bare `cursor`:
 * one namespace, one name for the position a caller resumes from.
 */
export interface ChildRunExpandRequest {
  runId: RunId;
  afterCursor?: EventCursor | undefined;
}

export const ChildRunExpandRequestSchema: z.ZodType<ChildRunExpandRequest, ChildRunExpandRequest> =
  z.object({ runId: RunIdSchema, afterCursor: EventCursorSchema.optional() }).strict();

/**
 * The members every expansion carries, whichever continuation arm it takes.
 */
export interface ChildRunExpandResponseBase {
  runId: RunId;
  parentRunId: RunId;
  state: RunState;
  /**
   * The SAME `TimelineRow` union the read window and the live stream carry — a
   * child run's rows are timeline rows, not a third shape a consumer would
   * have to translate.
   */
  entries: TimelineRow[];
}

/**
 * The expansion, discriminated on `hasMore` exactly as the read window is.
 *
 * A child run is not inherently smaller than a session window — a long-running
 * subagent can produce more rows than fit one frame — so the expansion needs
 * the same continuation, on the same two arms, with the same rule about which
 * of them may carry a cursor.
 */
export type ChildRunExpandResponse =
  | (ChildRunExpandResponseBase & { hasMore: true; nextCursor: EventCursor })
  | (ChildRunExpandResponseBase & { hasMore: false; nextCursor?: EventCursor | undefined });

const childRunExpandCommonShape = () => ({
  runId: RunIdSchema,
  parentRunId: RunIdSchema,
  state: RunStateSchema,
  // Same cap as the read window, same reason: this is a bounded window over a
  // child run's rows, not an unbounded dump.
  entries: z.array(TimelineRowSchema).max(TIMELINE_READ_LIMIT_MAX),
});

/**
 * Every expanded row that carries a run identity must carry THIS run's.
 *
 * An expansion is answering "what did child run X do", so a row attributed to
 * a different run is either a projection defect or a cross-run leak, and both
 * render as X's activity once the row is inside X's expansion. The `general`
 * arm is exempt because it structurally carries no `runId` — a session-scoped
 * row inside a child run's window is context, not misattribution.
 */
const requireEntriesToBelongToRun = (
  expandedRunId: RunId,
  entries: readonly TimelineRow[],
  issueContext: z.RefinementCtx,
): void => {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.kind === "general") {
      continue;
    }
    if (entry.runId !== expandedRunId) {
      issueContext.addIssue({
        code: "custom",
        path: ["entries", index, "runId"],
        message:
          "a child-run expansion carries only that run's rows: this entry is attributed to a " +
          "different run, so rendering it inside this expansion would report another run's " +
          "activity as this one's",
      });
    }
  }
};

export const ChildRunExpandResponseSchema: z.ZodType<ChildRunExpandResponse> = z
  .discriminatedUnion("hasMore", [
    z
      .object({
        ...childRunExpandCommonShape(),
        hasMore: z.literal(true),
        nextCursor: EventCursorSchema,
      })
      .strict(),
    z
      .object({
        ...childRunExpandCommonShape(),
        hasMore: z.literal(false),
        nextCursor: EventCursorSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((response, issueContext) => {
    requirePageToRideOneFrame(response.entries, "entries", issueContext);
    requireNondecreasingSequence(response.entries, issueContext);
    requireEntriesToBelongToRun(response.runId, response.entries, issueContext);
    // The same self-parenting refusal `ChildRunSummary` carries, applied to
    // the expansion's own identity pair — the two shapes state the same
    // relationship and a row that is its own parent is a cycle in either.
    if (response.runId === response.parentRunId) {
      issueContext.addIssue({
        code: "custom",
        path: ["parentRunId"],
        message:
          "a child run cannot be its own parent: runId and parentRunId are equal, which makes " +
          "the run-lineage graph cyclic and any walk of it non-terminating",
      });
    }
  });
