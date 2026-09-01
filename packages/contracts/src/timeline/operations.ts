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
// exists to forbid. The request is `{ runId }` and its schema is `.strict()`,
// which makes the decision enforceable rather than merely stated: a caller
// that sends one is REFUSED, not silently stripped.
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
 * One read window. `hasMore` is REQUIRED and separate from `nextCursor`'s
 * presence: a caller must be able to tell "the window ended and there is more"
 * from "the window ended and there is not" without inferring it from an
 * optional member's absence.
 */
export interface TimelineReadResponse {
  entries: TimelineRow[];
  nextCursor?: EventCursor | undefined;
  hasMore: boolean;
}

export const TimelineReadResponseSchema: z.ZodType<TimelineReadResponse> = z
  .object({
    entries: z.array(TimelineRowSchema),
    nextCursor: EventCursorSchema.optional(),
    hasMore: z.boolean(),
  })
  .strict();

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
 * The read is run-scoped. See this file's header for why no principal member
 * is declared.
 */
export interface ReasoningSurfaceReadRequest {
  runId: RunId;
}

export const ReasoningSurfaceReadRequestSchema: z.ZodType<
  ReasoningSurfaceReadRequest,
  ReasoningSurfaceReadRequest
> = z.object({ runId: RunIdSchema }).strict();

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
 *   * `available` REQUIRES `reasoningEntries` and admits no `policyReason`.
 *   * `policy_redacted` REQUIRES `policyReason` and admits no entries — the
 *     redaction renders as an explicit surface, never as absence (I-013-7).
 *   * `unavailable` and `compacted` carry NEITHER; the client renders the
 *     placeholder from the state itself. `compacted` names WHY expansion is
 *     empty, and neither state erases the durable summary or the policy marker
 *     that remain canonical on the summary-first surface (I-013-8).
 *
 * No two states serialize identically, so a state-inconsistent field set is a
 * parse failure rather than a rendering ambiguity.
 */
export type ReasoningSurfaceReadResponse =
  | { availability: "available"; reasoningEntries: ReasoningEntry[] }
  | { availability: "unavailable" }
  | { availability: "compacted" }
  | { availability: "policy_redacted"; policyReason: string };

export const ReasoningSurfaceReadResponseSchema: z.ZodType<ReasoningSurfaceReadResponse> =
  z.discriminatedUnion("availability", [
    z
      .object({
        availability: z.literal("available"),
        reasoningEntries: z.array(ReasoningEntrySchema).max(REASONING_SURFACE_ENTRIES_MAX),
      })
      .strict(),
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
 */
export const REASONING_AVAILABILITY_STATES: readonly ReasoningSurfaceReadResponse["availability"][] =
  Object.freeze(["available", "unavailable", "compacted", "policy_redacted"] as const);

// ---------------------------------------------------------------------------
// ChildRunExpand
// ---------------------------------------------------------------------------

/** Expand one summarized child-run row into its own timeline rows. */
export interface ChildRunExpandRequest {
  runId: RunId;
}

export const ChildRunExpandRequestSchema: z.ZodType<ChildRunExpandRequest, ChildRunExpandRequest> =
  z.object({ runId: RunIdSchema }).strict();

/**
 * The expansion. `entries` is the SAME `TimelineRow` union the read window and
 * the live stream carry — a child run's rows are timeline rows, not a third
 * shape a consumer would have to translate.
 */
export interface ChildRunExpandResponse {
  runId: RunId;
  parentRunId: RunId;
  state: RunState;
  entries: TimelineRow[];
}

export const ChildRunExpandResponseSchema: z.ZodType<ChildRunExpandResponse> = z
  .object({
    runId: RunIdSchema,
    parentRunId: RunIdSchema,
    state: RunStateSchema,
    entries: z.array(TimelineRowSchema),
  })
  .strict();
