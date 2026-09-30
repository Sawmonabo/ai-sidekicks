// Ownership-boundary + export-inventory assertions exercised against the
// `@ai-sidekicks/contracts` package public surface.
//
// This file does NOT duplicate the per-module tests (presence.test.ts). Its
// three load-bearing jobs are:
//
//   1. Ownership boundary (the load-bearing forbidden-symbol assertion) —
//      `@ai-sidekicks/contracts` MUST NOT re-grow the invite /
//      membership-update wire shapes: one user owns a session. The
//      forbidden-symbol assertions below fail loudly at parse time if any
//      such symbol is ever added to the package public surface.
//
//   2. Export inventory (positive re-export regression guard) — the
//      presence contract surface MUST stay re-exported
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
// NOT from per-module relative paths like `../presence.js`: the test must
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
  MachinePresenceSchema,
  PresenceHeartbeatSchema,
  PresenceReadRequestSchema,
  type PresenceState,
} from "../index.js";
import * as contracts from "../index.js";

// =============================================================================
// Test fixtures — minimal-valid wire shapes mirroring the per-module test files
// =============================================================================
//
// Each builder constructs the minimum wire-shape body that the corresponding
// schema accepts. The builders are intentionally aligned with the fixture
// shapes in presence.test.ts — copying its conventions
// (real RFC 9562 UUIDs, ISO 8601 timestamps with offsets, etc.) keeps the
// cross-contract `.strict()` representatives faithful to the canonical wire
// form.

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
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
    lastActivityAt: LAST_ACTIVITY_AT,
    appVisible: true,
  },
});

const buildValidPresenceReadRequest = () => ({});

const buildValidMachinePresence = () => ({
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

// =============================================================================
// Section 1 — Ownership boundary: NO invite or membership-update exports
// =============================================================================
//
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
// contract surface. Drift catches: a future PR removing a
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
    ["PresenceReadRequestSchema", contracts.PresenceReadRequestSchema],
    ["MachinePresenceSchema", contracts.MachinePresenceSchema],
    ["PresenceStateSchema", contracts.PresenceStateSchema],
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
    // Compact follow-up — verify the 3 OBJECT schemas (the ones with
    // .strict() per the next section) all return a successful parse result
    // on minimal valid fixtures, proving the re-export chain is intact
    // end-to-end (not just symbol-present).
    expect(PresenceHeartbeatSchema.safeParse(buildValidPresenceHeartbeat()).success).toBe(true);
    expect(PresenceReadRequestSchema.safeParse(buildValidPresenceReadRequest()).success).toBe(true);
    expect(MachinePresenceSchema.safeParse(buildValidMachinePresence()).success).toBe(true);
  });
});

// =============================================================================
// SECTION 3 — Cross-contract `.strict()` posture sanity check
// =============================================================================
//
// Every top-level `.strict()` object schema on these surfaces is exercised
// here at the package boundary. The per-module test file (presence.test.ts)
// already pins `.strict()` rejection at the schema-internal
// level; this section is the CROSS-CONTRACT backstop — it catches a
// regression where `.strict()` is dropped from a schema during a refactor and
// the per-module test happens to be updated in lockstep (e.g. schema-and-test
// edited in the same PR with the test relaxed to match). The package-boundary
// assertion exercises each schema through its re-exported binding from
// `@ai-sidekicks/contracts`, so a removed `.strict()` fails here even if the
// per-module suite was edited to admit the change.
//
// Coverage: the 3 top-level presence `.strict()` schemas.

describe("anti-leakage — cross-contract .strict() posture", () => {
  it("PresenceHeartbeatSchema rejects extraneous TOP-LEVEL keys (.strict() outer guard)", () => {
    const broken = { ...buildValidPresenceHeartbeat(), extra: "leak" };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  it("PresenceReadRequestSchema rejects extraneous keys (.strict() guard)", () => {
    const broken = { ...buildValidPresenceReadRequest(), extra: "leak" };
    expect(PresenceReadRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("MachinePresenceSchema rejects extraneous TOP-LEVEL keys (.strict() outer guard)", () => {
    const broken = { ...buildValidMachinePresence(), extra: "leak" };
    expect(MachinePresenceSchema.safeParse(broken).success).toBe(false);
  });
});
