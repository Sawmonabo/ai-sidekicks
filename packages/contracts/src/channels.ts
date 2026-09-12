// Channel contracts — request/response payload for the `ChannelList` read-only
// projection: the JSON-RPC client surface for reading the channels in a
// session, as a strict-shaped projection.
//
// The canonical wire form:
//
//   interface ChannelListRequest {
//     sessionId: SessionId;
//   }
//   interface ChannelListResponse {
//     channels: Array<{
//       id: ChannelId;
//       name?: string;                // OPTIONAL — bootstrap default channel
//                                     // may be unnamed (see rationale below)
//       state: ChannelState;
//       userCount: number;     // non-negative integer
//     }>;
//   }
//
// Cross-module ownership (intentional re-exports, NOT redeclarations):
//
//   `ChannelState`, `ChannelStateSchema`, `CHANNEL_NAME_MAX_LEN`, `ChannelId`,
//   `ChannelIdSchema`, `SessionId`, `SessionIdSchema` all live in
//   `./session.js`. This file re-exports them so that consumers can
//   `import { ... } from "@ai-sidekicks/contracts"` and pull the full
//   ChannelList surface in one shot. session.ts remains the single source of
//   truth — adding new wrapper schemas here would create a divergent surface
//   that consumers would have to choose between.
//
// Why `name?` is optional and what it encodes:
//
//   The bootstrap "main" channel is NOT born from a `ChannelCreated` event —
//   it is a projected structural invariant, derived deterministically from the
//   session (id = `deriveMainChannelId(sessionId)`, channel-id.ts), and the
//   projector always labels it "main" (never unnamed). The `name?` optionality
//   exists for user channels, which DO flow through the `ChannelCreated` event
//   payload (`channelCreatedPayloadSchema` in event.ts —
//   `name: wireFreeFormString(...).optional()`) and may legitimately have no
//   friendly label; for those, the wire signal for "this channel has no display
//   name" is KEY ABSENT (not `name: ""` and not `name: null`). This matches the
//   `ChannelSummary` shape in session.ts. Producers MUST omit the key when no
//   name is set; consumers MUST handle the absent-key case in UI rendering
//   ("Default channel" / "Main" / similar UI fallback, owned by the renderer,
//   not contracted here).
//
// Why `userCount: number` is integer + non-negative:
//
//   `userCount` is a count — semantically the cardinality of the set of
//   actors projected into the channel scope. Counts are
//   non-negative integers by definition; `number` in the wire-form gloss is
//   imprecise about the integer/float distinction (JSON has no integer
//   type), so the contract layer composes three guards: `z.number()`,
//   `.int()`, and `.nonnegative()`. Pinning the wire shape here forestalls
//   a class of consumer bugs where a stale projection underflow could ship
//   `-1` and confuse downstream UI counters.
//
//   Zod v4 number-guard attribution (anti-confusion):
//
//     * `z.number()` is the PRIMARY guard for NaN and ±Infinity — in Zod
//       v4, `z.number()` validates FINITE numbers only and rejects BOTH
//       `NaN` AND `±Infinity` by default. This is a behavior change from
//       Zod v3 (where `z.number()` admitted `NaN` and required `.finite()`
//       to reject `±Infinity`); maintainers carrying a Zod v3 mental model
//       repeatedly mis-attribute the rejection to `.int()` or `.finite()`.
//       Two independent code reviewers fell into this trap — the truth is
//       `z.number()` is the load-bearing guard for non-finite-number
//       rejection in Zod v4.
//     * `.int()` is defense-in-depth — it rejects non-integer floats like
//       `1.5`, AND would catch any non-finite that hypothetically slipped
//       past `z.number()` (NaN/Infinity are not integers).
//     * `.nonnegative()` is defense-in-depth — it rejects `-1` and other
//       negatives, AND rejects `-0` (which is a valid integer but not a
//       valid count cardinality).
//
//   Together: `z.number()` excludes NaN/±Infinity, `.int()` excludes
//   floats, `.nonnegative()` excludes negatives + `-0`. Dropping ANY of
//   the three weakens the "non-negative integer" semantic the canonical
//   wire form glosses as `userCount: number`. The triple is
//   belt-and-suspenders by design.
//
// No channel creation contracts here:
//
//   This file is the READ surface. `ChannelCreate` / `ChannelMute` /
//   `ChannelArchive` and similar mutation shapes belong to the
//   channel-mutation surface, not here; the anti-leakage assertion in
//   `anti-leakage.test.ts` backstops this boundary at the export-set level.
//
// `isolatedDeclarations: true` (from tsconfig.base.json) forbids inferred
// types on exported declarations — every NEW exported schema in this file
// is explicitly annotated with `z.ZodType<T, T>` (the double-T shape
// required for Standard-Schema-V1 input inference in tRPC v11). The existing
// single-T `ChannelStateSchema` re-exported from session.ts composes inside
// the double-T outer schemas without issue.
import { z } from "zod";

import {
  CHANNEL_NAME_MAX_LEN,
  ChannelIdSchema,
  ChannelStateSchema,
  SessionIdSchema,
  wireFreeFormString,
  type ChannelId,
  type ChannelState,
  type SessionId,
} from "./session.js";

// --------------------------------------------------------------------------
// Re-exports from session.ts
// --------------------------------------------------------------------------
//
// Consumers wiring up channel-list flows should `import { ... } from
// "@ai-sidekicks/contracts"` and get all the related symbols in one shot.
// session.ts remains the single source of truth; this file does NOT re-declare
// any of these symbols.
//
// Type-only re-exports MUST use `export type { ... }` (the `isolatedModules`
// + `verbatimModuleSyntax` posture from tsconfig.base.json forbids erased
// re-exports on the runtime form).

export type { ChannelId, ChannelState, SessionId } from "./session.js";
export {
  CHANNEL_NAME_MAX_LEN,
  ChannelIdSchema,
  ChannelStateSchema,
  SessionIdSchema,
} from "./session.js";

// --------------------------------------------------------------------------
// ChannelListRequest
// --------------------------------------------------------------------------
//
// Exact wire shape:
//   `{sessionId: SessionId}`
//
// Mirror of `SessionReadRequest` / `PresenceReadRequest` — a single
// `sessionId` field scoping the read-only projection to one session. The
// per-channel projection visibility is enforced by the service layer, NOT by
// the wire schema.

export interface ChannelListRequest {
  sessionId: SessionId;
}
// `z.ZodType<T, T>` — see SessionCreateRequestSchema in session.ts for
// rationale (preserves Standard-Schema-V1 input inference for tRPC v11
// consumers).
export const ChannelListRequestSchema: z.ZodType<ChannelListRequest, ChannelListRequest> = z
  .object({
    sessionId: SessionIdSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// ChannelListResponseChannel — per-element projection shape
// --------------------------------------------------------------------------
//
// One element per visible channel. Wire shape:
//   `{id: ChannelId, name?: string, state: ChannelState, userCount: number}`
//
// `name` is OPTIONAL — see file header for the bootstrap-unnamed-channel
// rationale. `userCount` is a non-negative integer (the wire-form
// gloss `number` is imprecise about JSON's integer vs float ambiguity;
// `.int().nonnegative()` enforces both the integer and the non-negative
// guards at the contract layer).
//
// `.strict()` rejects unknown keys at parse time, surfacing schema drift
// early — matches the convention used by every other projection-element
// schema in this package (`ChannelSummary`, `PresenceReadResponseDevice`).

export interface ChannelListResponseChannel {
  id: ChannelId;
  name?: string | undefined;
  state: ChannelState;
  userCount: number;
}
// `z.ZodType<T, T>` — see SessionCreateRequestSchema in session.ts for
// rationale (preserves Standard-Schema-V1 input inference for tRPC v11
// consumers).
//
// The `as unknown as z.ZodType<T, T>` cast bridges the underlying
// `z.ZodObject<...>` shape (whose `_input.state` resolves to `unknown`
// because `ChannelStateSchema` from session.ts is declared as the
// single-T `z.ZodType<ChannelState>`) to the double-T target type
// required for Standard-Schema-V1 input inference at tRPC v11 consumer
// sites. Same bridge pattern as `brandedUuidIdSchema` in
// `./internal/branded.ts`.
// Re-wrapping `ChannelStateSchema` locally would create a divergent
// surface from `session.ts` — the cast preserves the canonical
// single-source-of-truth posture per the file header.
export const ChannelListResponseChannelSchema: z.ZodType<
  ChannelListResponseChannel,
  ChannelListResponseChannel
> = z
  .object({
    id: ChannelIdSchema,
    // Matches `ChannelSummary.name` at session.ts:273 verbatim — same
    // length cap (`CHANNEL_NAME_MAX_LEN = 128`), same trust-boundary
    // guards (`wireFreeFormString` layers `.min(1)`, whitespace-only
    // rejection, and NUL-byte log-injection rejection on top of the
    // length cap). Two surfaces, one canonical shape.
    name: wireFreeFormString(CHANNEL_NAME_MAX_LEN, "ChannelListResponseChannel.name").optional(),
    state: ChannelStateSchema,
    // NaN and ±Infinity are rejected by `z.number()` itself — in Zod v4,
    // `z.number()` validates FINITE numbers only (rejecting both NaN and
    // ±Infinity by default). This differs from Zod v3, where `z.number()`
    // admitted NaN and required `.finite()` to reject ±Infinity; a Zod v3
    // mental model leads maintainers to wrongly attribute the rejection
    // to `.int()` or `.finite()`. The `.int()` and `.nonnegative()`
    // guards below are defense-in-depth: `.int()` rejects non-integer
    // floats (e.g. `1.5`) and would catch any non-finite that slipped
    // past `z.number()`; `.nonnegative()` rejects `-1` (and `-0`).
    // Together they enforce the "non-negative integer" semantic that the
    // canonical wire form glosses as `userCount: number`. See the
    // file header for the full Zod v4 attribution rationale.
    userCount: z.number().int().nonnegative(),
  })
  .strict() as unknown as z.ZodType<ChannelListResponseChannel, ChannelListResponseChannel>;

// --------------------------------------------------------------------------
// ChannelListResponse — outer projection envelope
// --------------------------------------------------------------------------
//
// Exact wire shape:
//   `{channels: Array<ChannelListResponseChannel>}`
//
// Empty list is valid — a session with no visible channels (or a session
// whose projection has not yet been populated) returns `{channels: []}`.
// The service layer is the authority on which channels are visible per
// caller; the wire schema makes no statement about minimum cardinality.
//
// `.strict()` on the outer envelope rejects unknown top-level keys —
// anti-leakage matching every other response schema in this package.

export interface ChannelListResponse {
  channels: ChannelListResponseChannel[];
}
// `z.ZodType<T, T>` — see SessionCreateRequestSchema in session.ts for
// rationale (preserves Standard-Schema-V1 input inference for tRPC v11
// consumers).
export const ChannelListResponseSchema: z.ZodType<ChannelListResponse, ChannelListResponse> = z
  .object({
    channels: z.array(ChannelListResponseChannelSchema),
  })
  .strict();
