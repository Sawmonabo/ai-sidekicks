// Plan-002 Phase 1 T1.6 — cross-plan ownership boundary + Plan-002 export
// inventory assertions exercised against the `@ai-sidekicks/contracts`
// package public surface.
//
// This file does NOT duplicate the per-task tests (C1+C2 → invites.test.ts,
// C3 → memberships.test.ts, C4 → presence.test.ts, C5 → channels.test.ts).
// Its three load-bearing jobs are:
//
//   1. Cross-plan ownership boundary (the load-bearing forbidden-symbol
//      assertion) — `@ai-sidekicks/contracts` MUST NOT export ANY channel-
//      MUTATION wire shape. Channel creation, muting, archiving, deletion,
//      and renaming are explicitly handled by Plan-016 (multi-agent-channels
//      -and-orchestration) per Spec-002:87 ("`ChannelList` is the only
//      channel surface contracted in Spec-002; channel creation is handled
//      by Plan-016"). A future PR that accidentally lands a `ChannelCreate*`
//      or peer mutation shape in this package would cross-plan trespass on
//      Plan-016's wire-contract ownership. The forbidden-symbol assertions
//      below fail loudly at parse time if any such symbol is ever added to
//      the package public surface.
//
//   2. Plan-002 export inventory (positive re-export regression guard) —
//      the 5 Plan-002 Phase 1 contract surfaces (`InviteCreate`,
//      `MembershipUpdate`, `PresenceHeartbeat`, `PresenceUpdate`,
//      `PresenceRead`, `ChannelList` request + response) MUST stay
//      re-exported from `@ai-sidekicks/contracts`. A future PR that
//      accidentally drops a re-export line in `index.ts` (or removes an
//      `export *` glob) would silently break downstream consumers; the
//      runtime `toBeDefined()` checks below catch the drift at the
//      package boundary.
//
//   3. Cross-contract `.strict()` posture sanity check — every Plan-002
//      object schema applies `.strict()` at the top level to reject
//      extraneous keys. The per-task tests pin this for EACH variant of
//      each surface; this file picks one representative per surface and
//      asserts the cross-contract guarantee at the package boundary,
//      providing a single failing assertion if a future PR ever drops
//      `.strict()` from a Plan-002 schema during a refactor.
//
// Why the `(contracts as Record<string, unknown>)[...]` cast on forbidden-
// symbol checks: direct property access on the typed namespace would be a
// TypeScript compile error (no such property exists), which is precisely
// what makes the test load-bearing — if a future PR adds the symbol,
// TypeScript would resolve the access and the test would compile, then
// FAIL at runtime because the symbol IS defined. The cast bypasses
// `noPropertyAccessFromIndexSignature` so the negative assertion can be
// authored at all. Removing the cast would silently neuter the guard.
//
// Why import from `@ai-sidekicks/contracts` (the package public path) and
// NOT relative paths like `../channels.js`: the test must exercise the
// package public surface as a downstream consumer would see it. A missing
// re-export in `src/index.ts` is the exact drift mode this file guards;
// importing from relative module paths would bypass the `index.ts` re-export
// layer that the assertion is designed to backstop.
//
// Refs: Spec-002 §Interfaces And Contracts (line 87 — `ChannelList` is the
// only channel surface contracted in Spec-002; channel creation belongs to
// Plan-016), Plan-002 §Phase 1 (T1.6 anti-leakage row at lines 230-232),
// ADR-001 (session-as-primary-domain-object), ADR-014 (tRPC v11 / Standard
// Schema V1 — informs the cross-contract `.strict()` posture).
import { describe, expect, it } from "vitest";

import {
  ChannelListRequestSchema,
  ChannelListResponseChannelSchema,
  ChannelListResponseSchema,
  InviteAcceptSchema,
  InviteCreateSchema,
  InviteRevokeSchema,
  MembershipUpdateSchema,
  PresenceHeartbeatSchema,
  PresenceReadRequestSchema,
  PresenceReadResponseSchema,
  PresenceUpdateSchema,
  type ChannelState,
  type PresenceState,
} from "@ai-sidekicks/contracts";
import * as contracts from "@ai-sidekicks/contracts";

// =============================================================================
// Test fixtures — minimal-valid wire shapes mirroring the per-task test files
// =============================================================================
//
// Each builder constructs the minimum wire-shape body that the corresponding
// schema accepts. The builders are intentionally aligned with the fixture
// shapes in invites.test.ts, memberships.test.ts, presence.test.ts, and
// channels.test.ts — copying their conventions (real RFC 9562 UUIDs, ISO
// 8601 timestamps with offsets, etc.) keeps the cross-contract `.strict()`
// representatives faithful to the canonical wire form.

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const INVITER_PARTICIPANT_ID = "660e8400-e29b-41d4-a716-446655440001";
const MEMBERSHIP_ID = "770e8400-e29b-41d4-a716-446655440002";
const PARTICIPANT_ID = "660e8400-e29b-41d4-a716-446655440003";
const CHANNEL_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f02";
const INVITE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const EXPIRES_AT = "2026-06-15T12:30:00.000Z";
const LAST_ACTIVITY_AT = "2026-05-22T14:30:00.000Z";
const LAST_SEEN = "2026-05-22T14:29:45.000Z";
const DEVICE_ID = "device-7c4a-9b1c-1b7c";
const DEVICE_TYPE = "desktop";

const buildValidInviteCreate = () => ({
  sessionId: SESSION_ID,
  inviter: INVITER_PARTICIPANT_ID,
  joinMode: "collaborator" as const,
  expiresAt: EXPIRES_AT,
});

// InviteAcceptSchema accepts an opaque token string (1..INVITE_TOKEN_MAX_LEN
// chars) per invites.ts:167-171. A representative PASETO v4.local prefix is
// the natural minimum-valid wire value — the contract layer does NOT decode
// the token (Spec-002:107-113 routes signature verification to the service
// layer); a non-empty string is all the schema asks for.
const buildValidInviteAccept = () => ({
  token: "v4.local.opaque-token-payload",
});

// InviteRevokeSchema requires `{sessionId, inviteId}` and admits an
// optional `reason` (Spec-002:82 verbatim). The minimum-valid fixture
// omits `reason` to keep the .strict() reject-extra-key test focused on
// the BASE shape rather than a populated-optional shape — extraneous-key
// rejection is the only property under test in Section 3.
const buildValidInviteRevoke = () => ({
  sessionId: SESSION_ID,
  inviteId: INVITE_ID,
});

const buildValidMembershipUpdate = () => ({
  membershipId: MEMBERSHIP_ID,
  action: "suspend" as const,
});

const buildValidPresenceHeartbeat = () => ({
  participantId: PARTICIPANT_ID,
  deviceId: DEVICE_ID,
  activityState: "online" as PresenceState,
  metadata: {
    deviceType: DEVICE_TYPE,
    focusedSessionId: SESSION_ID,
    focusedChannelId: CHANNEL_ID,
    lastActivityAt: LAST_ACTIVITY_AT,
    appVisible: true,
  },
});

const buildValidPresenceUpdate = () => ({
  sessionId: SESSION_ID,
  awarenessState: new Uint8Array([1, 2, 3]),
});

const buildValidPresenceReadRequest = () => ({
  sessionId: SESSION_ID,
});

const buildValidPresenceReadResponse = () => ({
  participants: [
    {
      participantId: PARTICIPANT_ID,
      state: "online" as PresenceState,
      lastSeen: LAST_SEEN,
    },
  ],
});

const buildValidChannelListRequest = () => ({
  sessionId: SESSION_ID,
});

// Minimum-valid PER-ELEMENT shape per channels.ts:185-232. `name` is
// optional (Spec-002:87 verbatim — the bootstrap default channel may be
// unnamed); omitting it keeps the .strict() reject-extra-key test focused
// on the REQUIRED base shape, matching the pattern used for the other
// optional-bearing fixtures (buildValidInviteRevoke omits `reason`).
// `participantCount: 0` is the canonical empty-channel value (per
// channels.test.ts:259-262).
const buildValidChannelListResponseChannel = () => ({
  id: CHANNEL_ID,
  state: "active" as ChannelState,
  participantCount: 0,
});

const buildValidChannelListResponse = () => ({
  channels: [
    {
      id: CHANNEL_ID,
      name: "general",
      state: "active" as ChannelState,
      participantCount: 3,
    },
  ],
});

// =============================================================================
// Section 1 — Cross-plan ownership boundary: NO channel-MUTATION exports
// =============================================================================
//
// Spec-002:87 binds the canonical Spec-002 channel surface to `ChannelList`
// (read-only projection) ONLY; the spec defers ALL channel-mutation shapes to
// Plan-016. The `@ai-sidekicks/contracts` package MUST NOT export ANY of the
// following symbols. If any one of them is ever added, the corresponding
// `toBeUndefined()` assertion fails loudly — the same failure mode catches
// schema, request, response, AND type-only re-exports because all four name
// permutations (`X`, `XRequest`, `XResponse`, `XSchema` + their *Request/
// *Response schemas) are enumerated below.

describe("Plan-002 anti-leakage — NO channel-mutation contracts in @ai-sidekicks/contracts", () => {
  // Comprehensive forbidden-symbol list across the five canonical channel-
  // mutation verbs (create, mute, archive, delete, rename). Each verb has
  // four name permutations the wire could plausibly take: the bare action,
  // the *Request shape, the *Response shape, and the *Schema runtime guard
  // (plus *RequestSchema and *ResponseSchema for the request/response
  // schema variants). Enumerating every shape closes the door against
  // every plausible drift mode in one assertion table.
  const FORBIDDEN_CHANNEL_MUTATION_SYMBOLS = [
    // ChannelCreate family — owned by Plan-016 per Spec-002:87.
    "ChannelCreate",
    "ChannelCreateRequest",
    "ChannelCreateResponse",
    "ChannelCreateSchema",
    "ChannelCreateRequestSchema",
    "ChannelCreateResponseSchema",
    // ChannelMute family — owned by Plan-016.
    "ChannelMute",
    "ChannelMuteRequest",
    "ChannelMuteResponse",
    "ChannelMuteSchema",
    "ChannelMuteRequestSchema",
    "ChannelMuteResponseSchema",
    // ChannelArchive family — owned by Plan-016.
    "ChannelArchive",
    "ChannelArchiveRequest",
    "ChannelArchiveResponse",
    "ChannelArchiveSchema",
    "ChannelArchiveRequestSchema",
    "ChannelArchiveResponseSchema",
    // ChannelDelete family — owned by Plan-016.
    "ChannelDelete",
    "ChannelDeleteRequest",
    "ChannelDeleteResponse",
    "ChannelDeleteSchema",
    "ChannelDeleteRequestSchema",
    "ChannelDeleteResponseSchema",
    // ChannelRename family — owned by Plan-016.
    "ChannelRename",
    "ChannelRenameRequest",
    "ChannelRenameResponse",
    "ChannelRenameSchema",
    "ChannelRenameRequestSchema",
    "ChannelRenameResponseSchema",
  ] as const;

  it.each(FORBIDDEN_CHANNEL_MUTATION_SYMBOLS)(
    "does not export channel-mutation symbol: %s (owned by Plan-016 per Spec-002:87)",
    (symbol) => {
      // The `Record<string, unknown>` cast is load-bearing: direct property
      // access on the typed namespace would be a TS compile error (no such
      // property exists today). The cast bypasses `noPropertyAccessFrom-
      // IndexSignature` so the negative assertion can be authored at all.
      // If a future PR adds the symbol to the package public surface,
      // TypeScript will resolve the access (the new export populates the
      // namespace shape) and this runtime check will FAIL — surfacing the
      // cross-plan trespass at test time, not at downstream review time.
      expect((contracts as Record<string, unknown>)[symbol]).toBeUndefined();
    },
  );

  // Pin the LOAD-BEARING discriminator — `ChannelCreate` in any form is the
  // single most likely accidental landing surface (it is the obvious next
  // contract a maintainer would reach for after `ChannelList`). The above
  // it.each() also covers it, but this standalone test exists so the failure
  // message at the package boundary is unambiguous about what went wrong.
  it("does not export ChannelCreate in any form (the canonical Plan-016 entry point)", () => {
    const namespace = contracts as Record<string, unknown>;
    expect(namespace["ChannelCreate"]).toBeUndefined();
    expect(namespace["ChannelCreateSchema"]).toBeUndefined();
    expect(namespace["ChannelCreateRequest"]).toBeUndefined();
    expect(namespace["ChannelCreateRequestSchema"]).toBeUndefined();
    expect(namespace["ChannelCreateResponse"]).toBeUndefined();
    expect(namespace["ChannelCreateResponseSchema"]).toBeUndefined();
  });
});

// =============================================================================
// Section 2 — Plan-002 export inventory: re-export regression guard
// =============================================================================
//
// Positive assertion that the package public surface includes EVERY contract
// surface shipped in T1.1-T1.4. Drift catches: a future PR removing a re-
// export from `src/index.ts`, dropping a glob, or renaming a symbol on the
// underlying module without updating the re-export wiring. Type-only exports
// are sanity-checked indirectly via their schema counterparts — `toBeDefined()`
// on the schema reaches through `export *` re-export aggregation; a missing
// `export *` in `index.ts` causes the assertion to fail.

describe("Plan-002 export inventory — required schemas re-exported from @ai-sidekicks/contracts", () => {
  // Schema parametrization table — every Plan-002 Phase 1 schema enumerated
  // by its public re-export name. The `[name, schema]` shape pairs the
  // package-public symbol name with the imported reference so the assertion
  // message identifies the missing re-export by its package-public name.
  const REQUIRED_PLAN_002_SCHEMAS = [
    // T1.1 — invites.ts (C1 + C2)
    ["InviteCreateSchema", contracts.InviteCreateSchema],
    ["InviteAcceptSchema", contracts.InviteAcceptSchema],
    ["InviteRevokeSchema", contracts.InviteRevokeSchema],
    ["InviteStateSchema", contracts.InviteStateSchema],
    ["InviteIdSchema", contracts.InviteIdSchema],
    // T1.2 — memberships.ts (C3)
    ["MembershipUpdateSchema", contracts.MembershipUpdateSchema],
    ["MembershipIdSchema", contracts.MembershipIdSchema],
    ["MembershipRoleSchema", contracts.MembershipRoleSchema],
    ["MembershipStateSchema", contracts.MembershipStateSchema],
    // T1.3 — presence.ts (C4)
    ["PresenceHeartbeatSchema", contracts.PresenceHeartbeatSchema],
    ["PresenceUpdateSchema", contracts.PresenceUpdateSchema],
    ["PresenceReadRequestSchema", contracts.PresenceReadRequestSchema],
    ["PresenceReadResponseSchema", contracts.PresenceReadResponseSchema],
    ["PresenceStateSchema", contracts.PresenceStateSchema],
    ["JoinModeSchema", contracts.JoinModeSchema],
    // T1.4 — channels.ts (C5)
    ["ChannelListRequestSchema", contracts.ChannelListRequestSchema],
    ["ChannelListResponseSchema", contracts.ChannelListResponseSchema],
    ["ChannelListResponseChannelSchema", contracts.ChannelListResponseChannelSchema],
    ["ChannelStateSchema", contracts.ChannelStateSchema],
  ] as const;

  it.each(REQUIRED_PLAN_002_SCHEMAS)(
    "re-exports Plan-002 schema: %s (with a callable .parse function)",
    (_name, schema) => {
      // Two-stage check: (a) the symbol is defined (catches a missing re-
      // export entirely), AND (b) the symbol has a callable `.parse` method
      // (catches the edge case where a non-Zod value is accidentally bound
      // to the export name — e.g. an inadvertent `export const X = null`).
      // The optional chain on `?.parse` keeps the second assertion from
      // crashing before the first failure message is produced.
      expect(schema).toBeDefined();
      expect(typeof (schema as { parse?: unknown })?.parse).toBe("function");
    },
  );

  // Spot-check the type-only re-exports indirectly — assert the corresponding
  // schemas parse a representative value through. A missing TYPE re-export
  // would not change runtime behavior (TypeScript erases the import), but
  // because every Plan-002 type ships paired with its schema, the schema-
  // present check above is sufficient as a runtime guard. The .strict()
  // section below additionally exercises every Plan-002 OBJECT schema's
  // parse path, providing a second-order check that the schemas are wired
  // through end-to-end.
  it("re-exports all Plan-002 schemas as a runtime-callable surface", () => {
    // Compact follow-up — verify the 8 OBJECT schemas (the ones with
    // .strict() per the next section) all return a successful parse result
    // on minimal valid fixtures, proving the re-export chain is intact
    // end-to-end (not just symbol-present).
    expect(InviteCreateSchema.safeParse(buildValidInviteCreate()).success).toBe(true);
    expect(MembershipUpdateSchema.safeParse(buildValidMembershipUpdate()).success).toBe(true);
    expect(PresenceHeartbeatSchema.safeParse(buildValidPresenceHeartbeat()).success).toBe(true);
    expect(PresenceUpdateSchema.safeParse(buildValidPresenceUpdate()).success).toBe(true);
    expect(PresenceReadRequestSchema.safeParse(buildValidPresenceReadRequest()).success).toBe(true);
    expect(PresenceReadResponseSchema.safeParse(buildValidPresenceReadResponse()).success).toBe(
      true,
    );
    expect(ChannelListRequestSchema.safeParse(buildValidChannelListRequest()).success).toBe(true);
    expect(ChannelListResponseSchema.safeParse(buildValidChannelListResponse()).success).toBe(true);
  });
});

// =============================================================================
// SECTION 3 — Cross-contract `.strict()` posture sanity check
// =============================================================================
//
// Every Plan-002 top-level `.strict()` object schema is exercised here at the
// package boundary. Per-task test files (invites.test.ts / memberships.test.ts
// / presence.test.ts / channels.test.ts) already pin `.strict()` rejection at
// the schema-internal level; this section is the CROSS-CONTRACT backstop —
// catches a regression where `.strict()` is dropped from a Plan-002 schema
// during a refactor and the per-task test happens to be updated in lockstep
// (e.g., schema-and-test edited in the same PR with the test relaxed to
// match). The package-boundary assertion exercises each schema through its
// re-exported binding from `@ai-sidekicks/contracts`, so a removed `.strict()`
// fails here even if the per-task suite was edited to admit the change.
//
// Coverage: 11 Plan-002 top-level `.strict()` schemas (3 invites + 1
// MembershipUpdate union + 4 presence + 3 channels).
//
// MembershipUpdate is a `z.discriminatedUnion`; the union dispatches a
// single parse to ONE variant by `action`, so exercising the union as a
// whole (with the representative `suspend` variant fixture) suffices —
// per-variant `.strict()` exhaustivity is covered by memberships.test.ts.

describe("Plan-002 anti-leakage — cross-contract .strict() posture", () => {
  it("InviteCreateSchema rejects extraneous keys (.strict() guard)", () => {
    const broken = { ...buildValidInviteCreate(), extra: "leak" };
    expect(InviteCreateSchema.safeParse(broken).success).toBe(false);
  });

  it("InviteAcceptSchema rejects extra wire keys via .strict()", () => {
    const broken = { ...buildValidInviteAccept(), extra: "leak" };
    expect(InviteAcceptSchema.safeParse(broken).success).toBe(false);
  });

  it("InviteRevokeSchema rejects extra wire keys via .strict()", () => {
    const broken = { ...buildValidInviteRevoke(), extra: "leak" };
    expect(InviteRevokeSchema.safeParse(broken).success).toBe(false);
  });

  it("MembershipUpdateSchema rejects extraneous keys on its representative variant (.strict() guard)", () => {
    // Picks the `suspend` variant as representative; the other three are
    // covered exhaustively by memberships.test.ts:400-411 (.strict() guard
    // is per-variant on a `z.discriminatedUnion`).
    const broken = { ...buildValidMembershipUpdate(), extra: "leak" };
    expect(MembershipUpdateSchema.safeParse(broken).success).toBe(false);
  });

  it("PresenceHeartbeatSchema rejects extraneous TOP-LEVEL keys (.strict() outer guard)", () => {
    const broken = { ...buildValidPresenceHeartbeat(), extra: "leak" };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  it("PresenceUpdateSchema rejects extraneous keys (.strict() guard)", () => {
    const broken = { ...buildValidPresenceUpdate(), extra: "leak" };
    expect(PresenceUpdateSchema.safeParse(broken).success).toBe(false);
  });

  it("PresenceReadRequestSchema rejects extraneous keys (.strict() guard)", () => {
    const broken = { ...buildValidPresenceReadRequest(), extra: "leak" };
    expect(PresenceReadRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("PresenceReadResponseSchema rejects extraneous TOP-LEVEL keys (.strict() outer guard)", () => {
    const broken = { ...buildValidPresenceReadResponse(), extra: "leak" };
    expect(PresenceReadResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("ChannelListRequestSchema rejects extraneous keys (.strict() guard)", () => {
    const broken = { ...buildValidChannelListRequest(), extra: "leak" };
    expect(ChannelListRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("ChannelListResponseSchema rejects extraneous TOP-LEVEL keys (.strict() outer guard)", () => {
    const broken = { ...buildValidChannelListResponse(), extra: "leak" };
    expect(ChannelListResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("ChannelListResponseChannelSchema rejects extra wire keys via .strict()", () => {
    const broken = { ...buildValidChannelListResponseChannel(), extra: "leak" };
    expect(ChannelListResponseChannelSchema.safeParse(broken).success).toBe(false);
  });
});
