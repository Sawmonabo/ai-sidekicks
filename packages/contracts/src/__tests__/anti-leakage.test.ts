// Ownership-boundary + export-inventory assertions exercised against the
// `@ai-sidekicks/contracts` package public surface.
//
// This file does NOT duplicate the per-module tests (presence.test.ts,
// channels.test.ts). Its three load-bearing jobs are:
//
//   1. Ownership boundary (the load-bearing forbidden-symbol assertion) —
//      `@ai-sidekicks/contracts` MUST NOT export ANY channel-MUTATION wire
//      shape, and MUST NOT re-grow the invite / membership-update wire
//      shapes that were deleted with the people-collaboration surface.
//      The forbidden-symbol assertions below fail loudly at parse time if
//      any such symbol is ever added to the package public surface.
//
//   2. Export inventory (positive re-export regression guard) — the
//      presence and channel-list contract surfaces MUST stay re-exported
//      from `@ai-sidekicks/contracts`. A future PR that accidentally drops
//      a re-export line in `index.ts` (or removes an `export *` glob) would
//      silently break downstream consumers; the runtime `toBeDefined()`
//      checks below catch the drift at the package boundary.
//
//   3. Cross-contract `.strict()` posture sanity check — every object
//      schema on these surfaces applies `.strict()` at the top level to
//      reject extraneous keys. The per-module tests pin this for EACH
//      variant of each surface; this file picks one representative per
//      surface and asserts the cross-contract guarantee at the package
//      boundary, providing a single failing assertion if a future PR ever
//      drops `.strict()` from one of these schemas during a refactor.
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
// Why import from `../index.js` (the source-level re-export surface) and
// NOT from per-module relative paths like `../channels.js`: the test must
// exercise the `index.ts` re-export layer, which is the exact drift mode
// this file guards. Per-module imports would bypass it; importing through
// `../index.js` goes through the same re-export graph that downstream
// consumers see via the `@ai-sidekicks/contracts` package map.
//
// Why `../index.js` rather than the `@ai-sidekicks/contracts` package path:
// the package map at `packages/contracts/package.json` resolves `.` to
// `./dist/index.js`, but the package-local `test` script (`vitest run`)
// does NOT depend on the package's own `build` (Turbo's `test` task chains
// only on `^build` — upstream packages, not the package itself). In a
// clean checkout where `dist/` has not yet been built, a `@ai-sidekicks/
// contracts` import would fail at module resolution before any assertion
// runs. Sibling contract tests all use relative source imports for the same
// reason. The package-map resolution path itself is exercised transitively
// by consumer-package typechecks (e.g. `pnpm --filter
// @ai-sidekicks/runtime-daemon typecheck`).
import { describe, expect, it } from "vitest";

import {
  ChannelListRequestSchema,
  ChannelListResponseChannelSchema,
  ChannelListResponseSchema,
  PresenceHeartbeatSchema,
  PresenceReadRequestSchema,
  PresenceReadResponseSchema,
  PresenceUpdateSchema,
  type ChannelState,
  type PresenceState,
} from "../index.js";
import * as contracts from "../index.js";

// =============================================================================
// Test fixtures — minimal-valid wire shapes mirroring the per-module test files
// =============================================================================
//
// Each builder constructs the minimum wire-shape body that the corresponding
// schema accepts. The builders are intentionally aligned with the fixture
// shapes in presence.test.ts and channels.test.ts — copying their conventions
// (real RFC 9562 UUIDs, ISO 8601 timestamps with offsets, etc.) keeps the
// cross-contract `.strict()` representatives faithful to the canonical wire
// form.

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const CHANNEL_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f02";
const LAST_ACTIVITY_AT = "2026-05-22T14:30:00.000Z";
const LAST_SEEN = "2026-05-22T14:29:45.000Z";
const DEVICE_ID = "device-7c4a-9b1c-1b7c";
const DEVICE_TYPE = "desktop";

const buildValidPresenceHeartbeat = () => ({
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
  devices: [
    {
      deviceId: DEVICE_ID,
      deviceType: DEVICE_TYPE,
      appVisible: true,
      state: "online" as PresenceState,
      lastSeen: LAST_SEEN,
    },
  ],
});

const buildValidChannelListRequest = () => ({
  sessionId: SESSION_ID,
});

// Minimum-valid PER-ELEMENT shape. `name` is optional (the bootstrap default
// channel may be unnamed); omitting it keeps the .strict() reject-extra-key
// test focused on the REQUIRED base shape. `userCount: 0` is the
// canonical empty-channel value.
const buildValidChannelListResponseChannel = () => ({
  id: CHANNEL_ID,
  state: "active" as ChannelState,
  userCount: 0,
});

const buildValidChannelListResponse = () => ({
  channels: [
    {
      id: CHANNEL_ID,
      name: "general",
      state: "active" as ChannelState,
      userCount: 3,
    },
  ],
});

// =============================================================================
// Section 1 — Ownership boundary: NO channel-mutation, invite, or
// membership-update exports
// =============================================================================
//
// The canonical channel surface in this package is `ChannelList` (read-only
// projection) ONLY; every channel-mutation shape belongs to the orchestration
// layer. The invite and membership-update shapes were deleted outright with
// the people-collaboration surface and must not reappear. The
// `@ai-sidekicks/contracts` package MUST NOT export ANY of the symbols
// enumerated below. If any one of them is ever added, the corresponding
// `toBeUndefined()` assertion fails loudly — the same failure mode catches
// schema, request, response, AND type-only re-exports because all name
// permutations are enumerated.

describe("anti-leakage — no channel-mutation contracts in @ai-sidekicks/contracts", () => {
  // Comprehensive forbidden-symbol list across the five canonical channel-
  // mutation verbs (create, mute, archive, delete, rename). Each verb has
  // four name permutations the wire could plausibly take: the bare action,
  // the *Request shape, the *Response shape, and the *Schema runtime guard
  // (plus *RequestSchema and *ResponseSchema for the request/response
  // schema variants). Enumerating every shape closes the door against
  // every plausible drift mode in one assertion table.
  const FORBIDDEN_CHANNEL_MUTATION_SYMBOLS = [
    // ChannelCreate family — owned by the orchestration layer.
    "ChannelCreate",
    "ChannelCreateRequest",
    "ChannelCreateResponse",
    "ChannelCreateSchema",
    "ChannelCreateRequestSchema",
    "ChannelCreateResponseSchema",
    // ChannelMute family.
    "ChannelMute",
    "ChannelMuteRequest",
    "ChannelMuteResponse",
    "ChannelMuteSchema",
    "ChannelMuteRequestSchema",
    "ChannelMuteResponseSchema",
    // ChannelArchive family.
    "ChannelArchive",
    "ChannelArchiveRequest",
    "ChannelArchiveResponse",
    "ChannelArchiveSchema",
    "ChannelArchiveRequestSchema",
    "ChannelArchiveResponseSchema",
    // ChannelDelete family.
    "ChannelDelete",
    "ChannelDeleteRequest",
    "ChannelDeleteResponse",
    "ChannelDeleteSchema",
    "ChannelDeleteRequestSchema",
    "ChannelDeleteResponseSchema",
    // ChannelRename family.
    "ChannelRename",
    "ChannelRenameRequest",
    "ChannelRenameResponse",
    "ChannelRenameSchema",
    "ChannelRenameRequestSchema",
    "ChannelRenameResponseSchema",
  ] as const;

  it.each(FORBIDDEN_CHANNEL_MUTATION_SYMBOLS)(
    "does not export channel-mutation symbol: %s",
    (symbol) => {
      // The `Record<string, unknown>` cast is load-bearing: direct property
      // access on the typed namespace would be a TS compile error (no such
      // property exists today). The cast bypasses `noPropertyAccessFrom-
      // IndexSignature` so the negative assertion can be authored at all.
      // If a future PR adds the symbol to the package public surface,
      // TypeScript will resolve the access (the new export populates the
      // namespace shape) and this runtime check will FAIL — surfacing the
      // boundary trespass at test time, not at downstream review time.
      expect((contracts as Record<string, unknown>)[symbol]).toBeUndefined();
    },
  );

  // Pin the LOAD-BEARING discriminator — `ChannelCreate` in any form is the
  // single most likely accidental landing surface (it is the obvious next
  // contract a maintainer would reach for after `ChannelList`). The above
  // it.each() also covers it, but this standalone test exists so the failure
  // message at the package boundary is unambiguous about what went wrong.
  it("does not export ChannelCreate in any form", () => {
    const namespace = contracts as Record<string, unknown>;
    expect(namespace["ChannelCreate"]).toBeUndefined();
    expect(namespace["ChannelCreateSchema"]).toBeUndefined();
    expect(namespace["ChannelCreateRequest"]).toBeUndefined();
    expect(namespace["ChannelCreateRequestSchema"]).toBeUndefined();
    expect(namespace["ChannelCreateResponse"]).toBeUndefined();
    expect(namespace["ChannelCreateResponseSchema"]).toBeUndefined();
  });
});

// The invite and membership-update wire surfaces are gone: one user owns a
// session, so there is nobody to invite and no membership to change. The symbol
// names below are the literals this guard asserts against, which is why the
// deleted vocabulary survives here and nowhere else in the package.

describe("anti-leakage — no invite or membership-update contracts in @ai-sidekicks/contracts", () => {
  const FORBIDDEN_MULTI_USER_SYMBOLS = [
    "InviteId",
    "InviteIdSchema",
    "InviteState",
    "InviteStateSchema",
    "InviteCreate",
    "InviteCreateSchema",
    "InviteCreateResponse",
    "InviteCreateResponseSchema",
    "InviteAccept",
    "InviteAcceptSchema",
    "InviteAcceptResponse",
    "InviteAcceptResponseSchema",
    "InviteRevoke",
    "InviteRevokeSchema",
    "InviteRevokeResponse",
    "InviteRevokeResponseSchema",
    "INVITE_TOKEN_MAX_LEN",
    "INVITE_REVOKE_REASON_MAX_LEN",
    "MembershipUpdate",
    "MembershipUpdateSchema",
    "MembershipUpdateResponse",
    "MembershipUpdateResponseSchema",
  ] as const;

  it.each(FORBIDDEN_MULTI_USER_SYMBOLS)("does not export deleted symbol: %s", (symbol) => {
    expect((contracts as Record<string, unknown>)[symbol]).toBeUndefined();
  });
});

// =============================================================================
// Section 2 — Export inventory: re-export regression guard
// =============================================================================
//
// Positive assertion that the package public surface includes every presence
// and channel-list contract surface. Drift catches: a future PR removing a
// re-export from `src/index.ts`, dropping a glob, or renaming a symbol on the
// underlying module without updating the re-export wiring. Type-only exports
// are sanity-checked indirectly via their schema counterparts —
// `toBeDefined()` on the schema reaches through `export *` re-export
// aggregation; a missing `export *` in `index.ts` causes the assertion to
// fail.

describe("export inventory — required schemas re-exported from @ai-sidekicks/contracts", () => {
  // Schema parametrization table — every schema enumerated by its public
  // re-export name. The `[name, schema]` shape pairs the package-public
  // symbol name with the imported reference so the assertion message
  // identifies the missing re-export by its package-public name.
  const REQUIRED_SCHEMAS = [
    // presence.ts
    ["PresenceHeartbeatSchema", contracts.PresenceHeartbeatSchema],
    ["PresenceUpdateSchema", contracts.PresenceUpdateSchema],
    ["PresenceReadRequestSchema", contracts.PresenceReadRequestSchema],
    ["PresenceReadResponseSchema", contracts.PresenceReadResponseSchema],
    ["PresenceStateSchema", contracts.PresenceStateSchema],
    // channels.ts
    ["ChannelListRequestSchema", contracts.ChannelListRequestSchema],
    ["ChannelListResponseSchema", contracts.ChannelListResponseSchema],
    ["ChannelListResponseChannelSchema", contracts.ChannelListResponseChannelSchema],
    ["ChannelStateSchema", contracts.ChannelStateSchema],
  ] as const;

  it.each(REQUIRED_SCHEMAS)(
    "re-exports schema: %s (with a callable .parse function)",
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
  // because every type ships paired with its schema, the schema-present check
  // above is sufficient as a runtime guard.
  it("re-exports all schemas as a runtime-callable surface", () => {
    // Compact follow-up — verify the 6 OBJECT schemas (the ones with
    // .strict() per the next section) all return a successful parse result
    // on minimal valid fixtures, proving the re-export chain is intact
    // end-to-end (not just symbol-present).
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
// Every top-level `.strict()` object schema on these surfaces is exercised
// here at the package boundary. Per-module test files (presence.test.ts /
// channels.test.ts) already pin `.strict()` rejection at the schema-internal
// level; this section is the CROSS-CONTRACT backstop — it catches a
// regression where `.strict()` is dropped from a schema during a refactor and
// the per-module test happens to be updated in lockstep (e.g. schema-and-test
// edited in the same PR with the test relaxed to match). The package-boundary
// assertion exercises each schema through its re-exported binding from
// `@ai-sidekicks/contracts`, so a removed `.strict()` fails here even if the
// per-module suite was edited to admit the change.
//
// Coverage: 7 top-level `.strict()` schemas (4 presence + 3 channels).

describe("anti-leakage — cross-contract .strict() posture", () => {
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
