// Session contracts — request/response payloads and shared projection types
// for the Plan-001 vertical slice (SessionCreate / SessionRead / SessionJoin /
// SessionSubscribe). Exact field set mirrors the canonical TypeScript shapes in
// docs/architecture/contracts/api-payload-contracts.md § Tier 1 — Plan-001
// (verbatim — adding/removing/renaming a field here is a contract break and
// requires the spec edit first).
//
// ID format: `z.uuid()` accepts any RFC 9562 UUID. Daemon-assigned IDs are
// UUID v7 (sortable timestamp); admin-provisioned control-plane rows fall
// through PostgreSQL's `gen_random_uuid()` which emits v4. Contracts must
// accept both, so we deliberately do NOT pin to `z.uuidv7()`.
//
// Branded types (`SessionId`, `MembershipId`, …) provide compile-time
// nominal typing per api-payload-contracts.md §Branded ID Types — they
// prevent accidentally passing a `ParticipantId` where a `SessionId` was
// expected, even though both are strings at runtime.
//
// Refs: Spec-001 §Interfaces And Contracts, ADR-018 (versioning), ADR-022
// (toolchain — Zod 4.x).
import { z } from "zod";

// --------------------------------------------------------------------------
// Branded ID schemas
// --------------------------------------------------------------------------
//
// Brand declarations match docs/architecture/contracts/api-payload-contracts.md
// § Branded ID Types verbatim:
//   `type SessionId = string & { readonly __brand: "SessionId" };`
// This is a TypeScript-only nominal type — runtime is a plain UUID string.
// Two reasons we keep our own brand symbol rather than using `z.core.$brand`:
//
//   1. The spec's documented brand symbol is the structural shape we want
//      cross-package consumers to see (`packages/runtime-daemon`, `packages/
//      control-plane`, etc. read api-payload-contracts.md to verify their
//      type imports — making the consuming type structurally identical to
//      the doc's declaration eliminates a foot-gun).
//   2. Zod's `.brand<>()` produces a `$ZodBranded<>` schema whose `_output`
//      is the bare base type plus an internal symbol marker. That marker is
//      not structurally compatible with our `__brand` field, so we cast the
//      constructed schema to the public `z.ZodType<OurBrand>` shape — the
//      runtime parser remains correct, the public type stays nominal.
//
// All exported schemas are annotated to satisfy `isolatedDeclarations: true`
// from tsconfig.base.json (TS9010 — exported values must have explicit type
// annotations so downstream packages can type-emit without re-running
// whole-program inference).

export type SessionId = string & { readonly __brand: "SessionId" };
export const SessionIdSchema: z.ZodType<SessionId> = z
  .uuid()
  .brand<"SessionId">() as unknown as z.ZodType<SessionId>;

export type ParticipantId = string & { readonly __brand: "ParticipantId" };
export const ParticipantIdSchema: z.ZodType<ParticipantId> = z
  .uuid()
  .brand<"ParticipantId">() as unknown as z.ZodType<ParticipantId>;

export type MembershipId = string & { readonly __brand: "MembershipId" };
export const MembershipIdSchema: z.ZodType<MembershipId> = z
  .uuid()
  .brand<"MembershipId">() as unknown as z.ZodType<MembershipId>;

export type ChannelId = string & { readonly __brand: "ChannelId" };
export const ChannelIdSchema: z.ZodType<ChannelId> = z
  .uuid()
  .brand<"ChannelId">() as unknown as z.ZodType<ChannelId>;

// EventCursor is opaque — wire form is a string but its internal structure
// (sequence + monotonic_ns) is owned by Plan-006. Plan-001 only needs to
// pass it through unchanged on `SessionRead.timelineCursors` and
// `SessionSubscribe.afterCursor`.
export type EventCursor = string & { readonly __brand: "EventCursor" };
export const EventCursorSchema: z.ZodType<EventCursor> = z
  .string()
  .min(1)
  .brand<"EventCursor">() as unknown as z.ZodType<EventCursor>;

// --------------------------------------------------------------------------
// Shared enums (api-payload-contracts.md § Shared Enums)
// --------------------------------------------------------------------------

export type SessionState =
  | "provisioning"
  | "active"
  | "archived"
  | "closed"
  | "purge_requested"
  | "purged";
export const SessionStateSchema: z.ZodType<SessionState> = z.enum([
  "provisioning",
  "active",
  "archived",
  "closed",
  "purge_requested",
  "purged",
]);

// "runtime contributor" includes the space — preserved verbatim from the
// canonical enum (api-payload-contracts.md line 99). This is the wire form;
// editing to "runtime_contributor" or similar is a contract break.
export type MembershipRole = "owner" | "viewer" | "collaborator" | "runtime contributor";
export const MembershipRoleSchema: z.ZodType<MembershipRole> = z.enum([
  "owner",
  "viewer",
  "collaborator",
  "runtime contributor",
]);

export type MembershipState = "pending" | "active" | "suspended" | "revoked";
export const MembershipStateSchema: z.ZodType<MembershipState> = z.enum([
  "pending",
  "active",
  "suspended",
  "revoked",
]);

export type ChannelState = "active" | "muted" | "archived";
export const ChannelStateSchema: z.ZodType<ChannelState> = z.enum(["active", "muted", "archived"]);

// --------------------------------------------------------------------------
// Shared projection types
// --------------------------------------------------------------------------
//
// These are the read-side projections referenced from `SessionCreateResponse`
// and `SessionReadResponse`. Per the canonical spec they are strict shapes
// (the `.strict()` modifier rejects unknown keys at parse time, surfacing
// schema drift early).

const RecordOfUnknownSchema: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown());

export interface SessionSnapshot {
  id: SessionId;
  state: SessionState;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export const SessionSnapshotSchema: z.ZodType<SessionSnapshot> = z
  .object({
    id: SessionIdSchema,
    state: SessionStateSchema,
    config: RecordOfUnknownSchema,
    metadata: RecordOfUnknownSchema,
    // ISO 8601 timestamps. Validated as RFC 3339 by `z.iso.datetime()`.
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export interface MembershipSummary {
  id: MembershipId;
  participantId: ParticipantId;
  role: MembershipRole;
  state: MembershipState;
}
export const MembershipSummarySchema: z.ZodType<MembershipSummary> = z
  .object({
    id: MembershipIdSchema,
    participantId: ParticipantIdSchema,
    role: MembershipRoleSchema,
    state: MembershipStateSchema,
  })
  .strict();

// `name` is optional in the canonical interface (`name?: string`). Per
// api-payload-contracts.md line 224, omission is the wire signal for a
// channel without a friendly label (e.g. the implicit `main` channel).
//
// Note on `exactOptionalPropertyTypes: true`: the spec's wire form is
// "key absent" rather than "key present with value undefined" — but Zod's
// `.optional()` produces `T | undefined`. We type the interface as
// `name?: string | undefined` so the schema's inferred output matches
// our exported interface; consumers who care about the absent-vs-undefined
// distinction can still test `"name" in obj`.
export interface ChannelSummary {
  id: ChannelId;
  name?: string | undefined;
  state: ChannelState;
}
export const ChannelSummarySchema: z.ZodType<ChannelSummary> = z
  .object({
    id: ChannelIdSchema,
    name: z.string().optional(),
    state: ChannelStateSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// SessionCreate
// --------------------------------------------------------------------------
//
// Both request fields are optional; an empty `{}` body is valid (the daemon
// fills defaults from session config, see Spec-001 §Resource Limits).

export interface SessionCreateRequest {
  config?: Record<string, unknown> | undefined;
  metadata?: Record<string, unknown> | undefined;
}
export const SessionCreateRequestSchema: z.ZodType<SessionCreateRequest> = z
  .object({
    config: RecordOfUnknownSchema.optional(),
    metadata: RecordOfUnknownSchema.optional(),
  })
  .strict();

export interface SessionCreateResponse {
  sessionId: SessionId;
  state: SessionState;
  memberships: MembershipSummary[];
  channels: ChannelSummary[];
}
export const SessionCreateResponseSchema: z.ZodType<SessionCreateResponse> = z
  .object({
    sessionId: SessionIdSchema,
    state: SessionStateSchema,
    memberships: z.array(MembershipSummarySchema),
    channels: z.array(ChannelSummarySchema),
  })
  .strict();

// --------------------------------------------------------------------------
// SessionRead
// --------------------------------------------------------------------------

export interface SessionReadRequest {
  sessionId: SessionId;
}
export const SessionReadRequestSchema: z.ZodType<SessionReadRequest> = z
  .object({
    sessionId: SessionIdSchema,
  })
  .strict();

// `timelineCursors.acknowledged` is optional per the canonical interface
// (api-payload-contracts.md line 182).
export interface SessionReadResponse {
  session: SessionSnapshot;
  timelineCursors: {
    latest: EventCursor;
    acknowledged?: EventCursor | undefined;
  };
}
export const SessionReadResponseSchema: z.ZodType<SessionReadResponse> = z
  .object({
    session: SessionSnapshotSchema,
    timelineCursors: z
      .object({
        latest: EventCursorSchema,
        acknowledged: EventCursorSchema.optional(),
      })
      .strict(),
  })
  .strict();

// --------------------------------------------------------------------------
// SessionJoin
// --------------------------------------------------------------------------

export interface SessionJoinRequest {
  sessionId: SessionId;
  identityHandle: string;
}
export const SessionJoinRequestSchema: z.ZodType<SessionJoinRequest> = z
  .object({
    sessionId: SessionIdSchema,
    identityHandle: z.string().min(1),
  })
  .strict();

export interface SessionJoinResponse {
  sessionId: SessionId;
  participantId: ParticipantId;
  membershipId: MembershipId;
  sharedMetadata: Record<string, unknown>;
}
export const SessionJoinResponseSchema: z.ZodType<SessionJoinResponse> = z
  .object({
    sessionId: SessionIdSchema,
    participantId: ParticipantIdSchema,
    membershipId: MembershipIdSchema,
    sharedMetadata: RecordOfUnknownSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// SessionSubscribe
// --------------------------------------------------------------------------
//
// Subscribe is request-only on the wire — the response is an SSE stream of
// EventEnvelope values (typed as `AsyncIterable<EventEnvelope>` in the
// canonical spec). The envelope schema is owned by `event.ts`.

export interface SessionSubscribeRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor | undefined;
}
export const SessionSubscribeRequestSchema: z.ZodType<SessionSubscribeRequest> = z
  .object({
    sessionId: SessionIdSchema,
    afterCursor: EventCursorSchema.optional(),
  })
  .strict();
