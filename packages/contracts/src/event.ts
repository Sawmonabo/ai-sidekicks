// Session event contracts — V1 subset of the canonical EventEnvelope shape
// per docs/architecture/contracts/api-payload-contracts.md § Tier 4 Plan-006.
//
// Plan-001 PR #2 ships only the three event types its vertical slice needs:
//   • session.created    — emitted on `SessionCreate` admit
//   • membership.joined  — emitted on `SessionJoin` admit
//   • channel.created    — emitted when a session's main channel materializes
//
// The discriminated-union `SessionEvent` discriminates on the wire `type`
// string. Adding a new variant later is additive per ADR-018 §Decision #8
// (new event types allowed under a MINOR version bump). The full taxonomy
// lives in Spec-006 §Event Type Enumeration; this file is intentionally a
// strict subset.
//
// IMPORTANT (one open spec gap surfaced by this PR): Spec-006 currently
// enumerates `session.created` and `channel.created` under
// `session_lifecycle`, but does not yet enumerate `membership.joined` under
// `membership_change`. The wire string is registered here per the namespace
// convention (`<category>.<verb>`); a follow-up doc PR should register it
// in Spec-006 § Event Type Enumeration.
//
// Versioning: `version` is an `EventEnvelopeVersion` — a semver
// `"MAJOR.MINOR"` STRING per ADR-018 §Decision #1. It is NEVER numeric on
// the wire (lexical compare on strings like "1.10" vs "1.9" is unsafe; the
// reader parses MAJOR/MINOR as integers). The format check below enforces
// the regex from api-payload-contracts.md line 468.
//
// Refs: Spec-001 §Interfaces, Spec-006 §Event Type Enumeration, ADR-017
// (event sourcing), ADR-018 (cross-version compatibility).
import { z } from "zod";

import {
  ChannelIdSchema,
  MembershipIdSchema,
  MembershipRoleSchema,
  ParticipantIdSchema,
  SessionIdSchema,
  type ChannelId,
  type MembershipId,
  type MembershipRole,
  type ParticipantId,
  type SessionId,
} from "./session.js";

// --------------------------------------------------------------------------
// EventEnvelopeVersion — branded "MAJOR.MINOR" semver string.
// --------------------------------------------------------------------------
//
// Regex from api-payload-contracts.md § Plan-006:
//   /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/
// Rejects leading zeros on either segment ("01.0", "1.01") and pure
// numeric/single-segment forms ("1", "1.0.0").

export const EVENT_ENVELOPE_VERSION_PATTERN: RegExp = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type EventEnvelopeVersion = string & {
  readonly __brand: "EventEnvelopeVersion";
};
export const EventEnvelopeVersionSchema: z.ZodType<EventEnvelopeVersion> = z
  .string()
  .regex(EVENT_ENVELOPE_VERSION_PATTERN, {
    message:
      'EventEnvelopeVersion must be a "MAJOR.MINOR" semver string per ADR-018 §Decision #1 (e.g. "1.0", "2.5"; not numeric, not three-segment, no leading zeros).',
  })
  .brand<"EventEnvelopeVersion">() as unknown as z.ZodType<EventEnvelopeVersion>;

// --------------------------------------------------------------------------
// Common envelope fields shared by every SessionEvent variant.
// --------------------------------------------------------------------------
//
// Defined as a shape factory (not a schema) so each variant can spread
// it while supplying its own `type` literal + `payload`. Per Spec-001
// § Data And Storage Changes the `id` field is the persisted event id
// (UUID v7 daemon-assigned); `sequence` is the canonical replay key per
// ADR-017.
//
// The factory pattern is for stylistic consistency: the per-variant schema
// declarations also need to be reproduced in the `discriminatedUnion` block
// below (because `z.ZodType<T>` erases the literal-typed discriminator),
// and reusing the same factory in both places keeps the two surfaces in
// lockstep — divergence would surface as a TypeScript error at the
// `z.ZodType<...Event>` annotation. (Zod 4 check chains are immutable and
// safe to share, so a shared `const` would also be correct; the factory
// just makes accidental drift between the variant schemas and the union
// branch schemas harder.)

interface SessionEventCommonFields {
  id: string;
  sessionId: SessionId;
  sequence: number;
  occurredAt: string;
  // `actor` is `string | null` per api-payload-contracts.md §EventEnvelope
  // (line 478); the zod schema also makes it optional (key may be absent),
  // so we match the inferred output: `actor?: string | null | undefined`.
  actor?: string | null | undefined;
  correlationId?: string | undefined;
  causationId?: string | undefined;
  version: EventEnvelopeVersion;
}

const buildCommonShape = () => ({
  id: z.string().min(1),
  sessionId: SessionIdSchema,
  // `sequence` is a non-negative integer. The daemon assigns a strictly
  // monotonic per-session sequence on append; gaps are an integrity bug.
  sequence: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime(),
  // `actor` is a participant_id, agent_id, or null/absent for system-emitted
  // events (api-payload-contracts.md line 478 — "or null for system").
  actor: z.string().nullable().optional(),
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
  version: EventEnvelopeVersionSchema,
});

// --------------------------------------------------------------------------
// session.created — emitted on session admit.
// --------------------------------------------------------------------------
//
// Payload mirrors the session-bootstrap projection: the new session id
// (redundant with the envelope's `sessionId`, kept for projector convenience)
// plus the resolved config + metadata. The owner participant is conveyed via
// the membership.joined event that follows.

export interface SessionCreatedEvent extends SessionEventCommonFields {
  type: "session.created";
  payload: {
    sessionId: SessionId;
    config: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };
}
export const SessionCreatedEventSchema: z.ZodType<SessionCreatedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("session.created"),
    payload: z
      .object({
        sessionId: SessionIdSchema,
        config: z.record(z.string(), z.unknown()),
        metadata: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict();

// --------------------------------------------------------------------------
// membership.joined — emitted when a participant is admitted to a session.
// --------------------------------------------------------------------------

export interface MembershipJoinedEvent extends SessionEventCommonFields {
  type: "membership.joined";
  payload: {
    membershipId: MembershipId;
    participantId: ParticipantId;
    role: MembershipRole;
    identityHandle: string;
  };
}
export const MembershipJoinedEventSchema: z.ZodType<MembershipJoinedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("membership.joined"),
    payload: z
      .object({
        membershipId: MembershipIdSchema,
        participantId: ParticipantIdSchema,
        role: MembershipRoleSchema,
        identityHandle: z.string().min(1),
      })
      .strict(),
  })
  .strict();

// --------------------------------------------------------------------------
// channel.created — emitted when a session channel materializes.
// --------------------------------------------------------------------------

export interface ChannelCreatedEvent extends SessionEventCommonFields {
  type: "channel.created";
  payload: {
    channelId: ChannelId;
    name?: string | undefined;
  };
}
export const ChannelCreatedEventSchema: z.ZodType<ChannelCreatedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("channel.created"),
    payload: z
      .object({
        channelId: ChannelIdSchema,
        // `name` is optional; the implicit `main` channel is unnamed on the
        // wire (matches ChannelSummary.name optionality in session.ts).
        name: z.string().optional(),
      })
      .strict(),
  })
  .strict();

// --------------------------------------------------------------------------
// SessionEvent — discriminated union over `type`.
// --------------------------------------------------------------------------
//
// `z.discriminatedUnion` requires every variant to be a literal-typed
// ZodObject sharing the same discriminator key. This gives O(1) parse-time
// dispatch and narrowed inferred types at the consumption site
// (e.g. `if (e.type === "session.created") e.payload.config // typed`).
//
// We rebuild the variant schemas here (not the exported `*EventSchema`
// values) because `z.ZodType<T>` erases the literal-typed `type` field
// that `discriminatedUnion` needs to discriminate. This duplication is
// load-bearing: it lets the public API surface stay `isolatedDeclarations`-
// friendly while preserving Zod's discriminator dispatch internally.

export type SessionEvent = SessionCreatedEvent | MembershipJoinedEvent | ChannelCreatedEvent;
export const SessionEventSchema: z.ZodType<SessionEvent> = z.discriminatedUnion("type", [
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("session.created"),
      payload: z
        .object({
          sessionId: SessionIdSchema,
          config: z.record(z.string(), z.unknown()),
          metadata: z.record(z.string(), z.unknown()),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("membership.joined"),
      payload: z
        .object({
          membershipId: MembershipIdSchema,
          participantId: ParticipantIdSchema,
          role: MembershipRoleSchema,
          identityHandle: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("channel.created"),
      payload: z
        .object({
          channelId: ChannelIdSchema,
          name: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
]);

// Re-export the wire-type literals as a const tuple so consumers can iterate
// the registered V1 subset without re-parsing the schemas. Matches the
// pattern other contract packages will use as the union grows in later PRs.
export type SessionEventType = "session.created" | "membership.joined" | "channel.created";
export const SESSION_EVENT_TYPES: readonly SessionEventType[] = [
  "session.created",
  "membership.joined",
  "channel.created",
] as const;

// Note: cross-file ID types (`SessionId`, `MembershipId`, …) are not re-
// exported here — they are surfaced from `session.ts` and reach the public
// API via `index.ts`'s `export * from "./session.js"`. Re-exporting them
// from this file too would create a duplicate-export conflict at the
// package barrel.
