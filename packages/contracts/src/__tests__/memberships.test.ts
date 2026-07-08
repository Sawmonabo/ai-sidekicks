// Plan-002 Phase 1 T1.2 — membership-update contract schema tests.
//
// Backstops the C3 acceptance criterion (Plan-002 §C3, Spec-002 line 83):
// `MembershipUpdate.action` discriminated union covers role change,
// suspension, revocation, and reactivation per the canonical wire form
// at docs/architecture/contracts/api-payload-contracts.md lines 417-422.
//
// Test surface enumerated (the "what" each block pins):
//   * Action discriminant pin — exactly 4 canonical snake_case literals
//     (`change_role`, `suspend`, `revoke`, `reactivate`); kebab-case and
//     camelCase variants rejected. Regression backstop — kebab-case
//     `role-change` is NOT the canonical wire form; the canonical 4-action
//     snake_case set per api-payload-contracts.md:419 is
//     `{change_role, suspend, revoke, reactivate}`. Tests below fail
//     loudly if a future edit silently widens or renames the discriminant
//     set.
//   * MembershipUpdateSchema happy paths — one `it()` per action variant.
//   * Change-role variant — `newRole` required; admits `owner` (owner-
//     elevation guard is service-layer per I-002-1, not schema).
//   * Discriminated-union exhaustivity — missing action, unknown action,
//     malformed action, missing `newRole` on change_role, extraneous
//     `newRole` on non-change_role variants.
//   * MembershipRole / MembershipState wire-form pins — re-exported enums
//     accept exactly the canonical set (including the SPACED literal
//     `"runtime contributor"` — preserving that space is a hard contract
//     break, see session.ts:150-159).
//   * `.strict()` anti-leakage — unknown keys rejected on each variant.
//
// Coverage shape mirrors invites.test.ts (parametrized rejection +
// composability spot-checks + .strict() guard).
import { describe, expect, it } from "vitest";

import {
  MembershipIdSchema,
  MembershipRoleSchema,
  MembershipStateSchema,
  MembershipUpdateSchema,
  type MembershipId,
  type MembershipRole,
  type MembershipState,
  type NonOwnerMembershipRole,
} from "../memberships.js";

// Real RFC 9562 UUIDs (one v4, one v7). z.uuid() validates version nibble +
// variant bits in canonical positions; mismatch is rejected at the
// MembershipIdSchema layer before the variant body ever sees it.
const MEMBERSHIP_ID = "770e8400-e29b-41d4-a716-446655440002";
const SECOND_MEMBERSHIP_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f01";

const buildChangeRolePayload = (newRole: MembershipRole = "collaborator") => ({
  membershipId: MEMBERSHIP_ID,
  action: "change_role" as const,
  newRole,
});

const buildSuspendPayload = () => ({
  membershipId: MEMBERSHIP_ID,
  action: "suspend" as const,
});

const buildRevokePayload = () => ({
  membershipId: MEMBERSHIP_ID,
  action: "revoke" as const,
});

const buildReactivatePayload = () => ({
  membershipId: MEMBERSHIP_ID,
  action: "reactivate" as const,
});

// =============================================================================
// MembershipIdSchema re-export — branded UUID guard re-exported from session.ts
// =============================================================================
//
// This block exists to assert the re-export wiring (anti-cosmetic: a typo in
// the `export type { MembershipId }` line would otherwise only surface as a
// downstream consumer typecheck failure at PR review).

describe("MembershipIdSchema (re-exported from session.ts)", () => {
  it("accepts a valid RFC 9562 UUID", () => {
    const parsed = MembershipIdSchema.parse(MEMBERSHIP_ID);
    expect(parsed).toBe(MEMBERSHIP_ID);
  });

  it("returns a branded MembershipId at the type level", () => {
    const parsed: MembershipId = MembershipIdSchema.parse(MEMBERSHIP_ID);
    expect(typeof parsed).toBe("string");
  });

  it.each([
    ["empty string", ""],
    ["plain word", "not-a-uuid"],
    ["wrong segment lengths", "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f0"],
    ["trailing suffix", `${MEMBERSHIP_ID}-extra`],
  ])("rejects malformed UUID string: %s", (_label, value) => {
    expect(MembershipIdSchema.safeParse(value).success).toBe(false);
  });
});

// =============================================================================
// MembershipRoleSchema — canonical wire form (SPACED "runtime contributor")
// =============================================================================
//
// Spec-002 line 45 + api-payload-contracts.md line 121 bind the wire form to
// EXACTLY four spaced literals. The space in "runtime contributor" is part of
// the contract — collapsing it to "runtime_contributor" or "runtimeContributor"
// is a contract break that requires the spec edit FIRST per doc-first ordering
// (see session.ts:150-159 for the load-bearing rationale).

describe("MembershipRoleSchema (re-exported; SPACED wire form per session.ts:150-159)", () => {
  const EXPECTED_ROLES = ["owner", "viewer", "collaborator", "runtime contributor"] as const;

  it("enumerates exactly four canonical roles (no more, no less)", () => {
    const schemaInternals = MembershipRoleSchema as unknown as { options: readonly string[] };
    expect(schemaInternals.options).toHaveLength(4);
    expect([...schemaInternals.options].sort()).toEqual([...EXPECTED_ROLES].sort());
  });

  it.each(EXPECTED_ROLES)("accepts canonical role: %s", (role) => {
    expect(MembershipRoleSchema.safeParse(role).success).toBe(true);
  });

  it("accepts the SPACED 'runtime contributor' form (the space is load-bearing)", () => {
    const parsed = MembershipRoleSchema.parse("runtime contributor");
    expect(parsed).toBe("runtime contributor");
  });

  it("rejects snake_case 'runtime_contributor' (contract break — wire is SPACED)", () => {
    expect(MembershipRoleSchema.safeParse("runtime_contributor").success).toBe(false);
  });

  it("rejects camelCase 'runtimeContributor' (contract break — wire is SPACED)", () => {
    expect(MembershipRoleSchema.safeParse("runtimeContributor").success).toBe(false);
  });

  it.each([
    ["unknown role", "admin"],
    ["empty string", ""],
    ["null", null],
    ["number", 1],
  ])("rejects non-canonical value: %s", (_label, value) => {
    expect(MembershipRoleSchema.safeParse(value).success).toBe(false);
  });
});

// =============================================================================
// MembershipStateSchema — canonical lifecycle states
// =============================================================================

describe("MembershipStateSchema (re-exported; lifecycle states per session.ts:181-187)", () => {
  const EXPECTED_STATES = ["pending", "active", "suspended", "revoked"] as const;

  it("enumerates exactly four canonical states (no more, no less)", () => {
    const schemaInternals = MembershipStateSchema as unknown as { options: readonly string[] };
    expect(schemaInternals.options).toHaveLength(4);
    expect([...schemaInternals.options].sort()).toEqual([...EXPECTED_STATES].sort());
  });

  it.each(EXPECTED_STATES)("accepts canonical state: %s", (state) => {
    expect(MembershipStateSchema.safeParse(state).success).toBe(true);
  });

  it.each([
    ["invite-only state", "expired"],
    ["unknown state", "deactivated"],
    ["empty string", ""],
    ["null", null],
  ])("rejects non-canonical value: %s", (_label, value) => {
    expect(MembershipStateSchema.safeParse(value).success).toBe(false);
  });

  it("compile-time pin — MembershipState type matches the schema's runtime set", () => {
    // If MembershipState ever drifts from the schema, this assignment fails
    // to typecheck. The cast-via-unknown matches the test's runtime check
    // above; the TYPE assertion is the load-bearing piece.
    const states: MembershipState[] = ["pending", "active", "suspended", "revoked"];
    expect(states).toHaveLength(4);
  });
});

// =============================================================================
// C3 — MembershipUpdateSchema discriminated union (Spec-002 line 83)
// =============================================================================
//
// Canonical wire form per api-payload-contracts.md lines 417-422:
//
//   interface MembershipUpdateRequest {
//     membershipId: MembershipId;
//     action: "change_role" | "suspend" | "revoke" | "reactivate";
//     newRole?: MembershipRole; // required for change_role
//   }
//
// Four-action union. NO `sessionId` (membershipId is globally-unique). NO
// `reason` (`Spec-002 §Required Behavior` routes audit detail to session events, not the
// request body). `newRole` is REQUIRED on `change_role`, FORBIDDEN on the
// other three variants (the `.strict()` guard on each enforces).
//
// Regression backstop — pin canonical four-action snake_case set; rejects
// kebab-case `role-change` and camelCase `changeRole` shapes. If a future
// edit ever silently re-introduces kebab-case or drops `reactivate`, the
// explicit literal-rejection tests below fail loudly.

describe("MembershipUpdateSchema (C3: discriminated union per Spec-002 line 83)", () => {
  // ----------------------------------------------------------------------
  // Happy paths — one `it()` per canonical action variant.
  // ----------------------------------------------------------------------

  it("accepts change_role payload with a non-owner newRole (collaborator)", () => {
    const parsed = MembershipUpdateSchema.parse(buildChangeRolePayload("collaborator"));
    expect(parsed.action).toBe("change_role");
    expect(parsed.membershipId).toBe(MEMBERSHIP_ID);
    if (parsed.action === "change_role") {
      expect(parsed.newRole).toBe("collaborator");
    }
  });

  it("accepts change_role payload with newRole='owner' (Spec-002 §Required Behavior owner-elevation path)", () => {
    // Owner elevation is an EXPLICIT spec-permitted path (`Spec-002 §Required Behavior`):
    // an existing owner CAN promote another active member to owner.
    // Schema admits it; the "only existing owners may promote" guard is
    // a service-layer check owned by Plan-002 Phase 2 T2.3 P6, NOT a
    // schema constraint. Using `NonOwnerMembershipRoleSchema` here would
    // break I-002-1 entirely.
    const parsed = MembershipUpdateSchema.parse(buildChangeRolePayload("owner"));
    expect(parsed.action).toBe("change_role");
    if (parsed.action === "change_role") {
      expect(parsed.newRole).toBe("owner");
    }
  });

  it.each(["viewer", "collaborator", "runtime contributor", "owner"] as const)(
    "accepts change_role with every canonical MembershipRole: %s",
    (role) => {
      const result = MembershipUpdateSchema.safeParse(buildChangeRolePayload(role));
      expect(result.success).toBe(true);
    },
  );

  it("accepts suspend payload (no newRole field, no extra fields)", () => {
    const parsed = MembershipUpdateSchema.parse(buildSuspendPayload());
    expect(parsed.action).toBe("suspend");
    expect(parsed.membershipId).toBe(MEMBERSHIP_ID);
  });

  it("accepts revoke payload (no newRole field, no extra fields)", () => {
    const parsed = MembershipUpdateSchema.parse(buildRevokePayload());
    expect(parsed.action).toBe("revoke");
    expect(parsed.membershipId).toBe(MEMBERSHIP_ID);
  });

  it("accepts reactivate payload (no newRole field, no extra fields)", () => {
    // `reactivate` lifts a suspended/revoked membership back to active.
    // Service layer governs admissibility (Plan-002 Phase 2).
    const parsed = MembershipUpdateSchema.parse(buildReactivatePayload());
    expect(parsed.action).toBe("reactivate");
    expect(parsed.membershipId).toBe(MEMBERSHIP_ID);
  });

  // ----------------------------------------------------------------------
  // Action-discriminant pin — exactly the four snake_case literals.
  // ----------------------------------------------------------------------
  //
  // Regression backstop — the canonical wire form per
  // api-payload-contracts.md:419 uses snake_case `change_role` (NOT
  // kebab-case `role-change` or camelCase `changeRole`), and the union
  // has FOUR variants (not three — `reactivate` is canonical). The
  // explicit literal-rejection tests below fail loudly if a future edit
  // ever silently widens, narrows, or renames the discriminant set.

  it.each(["change_role", "suspend", "revoke", "reactivate"] as const)(
    "accepts canonical snake_case action literal: %s",
    (action) => {
      const payload =
        action === "change_role"
          ? buildChangeRolePayload()
          : { membershipId: MEMBERSHIP_ID, action };
      expect(MembershipUpdateSchema.safeParse(payload).success).toBe(true);
    },
  );

  it("rejects kebab-case 'role-change' (canonical wire is snake_case 'change_role')", () => {
    // Regression backstop — kebab-case `role-change` is NOT the wire
    // form per api-payload-contracts.md:419. This test fails loudly if a
    // future edit silently widens the discriminant set.
    const broken = { membershipId: MEMBERSHIP_ID, action: "role-change", newRole: "collaborator" };
    expect(MembershipUpdateSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects camelCase 'changeRole' (canonical wire is snake_case 'change_role')", () => {
    const broken = { membershipId: MEMBERSHIP_ID, action: "changeRole", newRole: "collaborator" };
    expect(MembershipUpdateSchema.safeParse(broken).success).toBe(false);
  });

  it.each([
    ["unknown action", "delete"],
    ["typo'd canonical", "change_roles"],
    ["empty string", ""],
    ["null", null],
    ["number", 1],
  ])("rejects non-canonical action: %s", (_label, action) => {
    const broken = { membershipId: MEMBERSHIP_ID, action };
    expect(MembershipUpdateSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects payload missing the action discriminator entirely", () => {
    const broken = { membershipId: MEMBERSHIP_ID };
    expect(MembershipUpdateSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects payload missing membershipId on every action variant", () => {
    const actions = ["change_role", "suspend", "revoke", "reactivate"] as const;
    for (const action of actions) {
      const broken: Record<string, unknown> =
        action === "change_role" ? { action, newRole: "collaborator" } : { action };
      const result = MembershipUpdateSchema.safeParse(broken);
      expect(result.success).toBe(false);
    }
  });

  // ----------------------------------------------------------------------
  // Conditional shape — newRole is REQUIRED on change_role only.
  // ----------------------------------------------------------------------

  it("rejects change_role payload missing required newRole field", () => {
    const broken = { membershipId: MEMBERSHIP_ID, action: "change_role" };
    const result = MembershipUpdateSchema.safeParse(broken);
    expect(result.success).toBe(false);
    if (!result.success) {
      // The issue path identifies the missing field — defense in depth so
      // error messages remain actionable for callers.
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("newRole");
    }
  });

  it("rejects change_role with an unknown newRole value (composes from MembershipRoleSchema)", () => {
    const broken = { membershipId: MEMBERSHIP_ID, action: "change_role", newRole: "admin" };
    expect(MembershipUpdateSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects change_role with snake_case 'runtime_contributor' (wire is SPACED)", () => {
    // Composability spot-check: the change_role variant inherits the
    // SPACED wire-form contract from MembershipRoleSchema.
    const broken = {
      membershipId: MEMBERSHIP_ID,
      action: "change_role",
      newRole: "runtime_contributor",
    };
    expect(MembershipUpdateSchema.safeParse(broken).success).toBe(false);
  });

  it.each(["suspend", "revoke", "reactivate"] as const)(
    "rejects %s payload with extraneous newRole field (.strict() rejects)",
    (action) => {
      // The conditional shape ("newRole iff change_role") is enforced by
      // the per-variant .strict() guard: passing newRole on suspend /
      // revoke / reactivate is unknown-key rejection at parse time.
      const broken = { membershipId: MEMBERSHIP_ID, action, newRole: "collaborator" };
      expect(MembershipUpdateSchema.safeParse(broken).success).toBe(false);
    },
  );

  // ----------------------------------------------------------------------
  // Absent-from-wire field guards — sessionId and reason.
  // ----------------------------------------------------------------------
  //
  // The canonical wire form per api-payload-contracts.md:417-427 omits both
  // `sessionId` (membershipId is globally unique) and `reason` (`Spec-002 §Required Behavior`
  // routes audit detail to session-event payloads owned by Plan-006). The
  // `.strict()` guard on each variant rejects them at parse time. These
  // tests pin the canonical surface — if a future edit ever drops
  // `.strict()` or expands the wire body, they fail loudly.

  it.each([
    ["change_role", buildChangeRolePayload()],
    ["suspend", buildSuspendPayload()],
    ["revoke", buildRevokePayload()],
    ["reactivate", buildReactivatePayload()],
  ] as const)("rejects extraneous sessionId on %s variant (.strict() guard)", (_label, valid) => {
    const broken = { ...valid, sessionId: "550e8400-e29b-41d4-a716-446655440000" };
    expect(MembershipUpdateSchema.safeParse(broken).success).toBe(false);
  });

  it.each([
    ["suspend", buildSuspendPayload()],
    ["revoke", buildRevokePayload()],
    ["reactivate", buildReactivatePayload()],
  ] as const)(
    "rejects extraneous reason field on %s variant (audit detail belongs in session event payload, not request)",
    (_label, valid) => {
      const broken = { ...valid, reason: "contractor offboarded" };
      expect(MembershipUpdateSchema.safeParse(broken).success).toBe(false);
    },
  );

  // ----------------------------------------------------------------------
  // .strict() anti-leakage — unknown keys rejected on every variant.
  // ----------------------------------------------------------------------

  it.each([
    ["change_role", buildChangeRolePayload()],
    ["suspend", buildSuspendPayload()],
    ["revoke", buildRevokePayload()],
    ["reactivate", buildReactivatePayload()],
  ] as const)(
    "rejects arbitrary unknown keys on %s variant (.strict() guard matches session.ts convention)",
    (_label, valid) => {
      const broken = { ...valid, unexpected: "field" };
      expect(MembershipUpdateSchema.safeParse(broken).success).toBe(false);
    },
  );

  it("rejects malformed membershipId on every variant (UUID guard composes)", () => {
    const variants = [
      { ...buildChangeRolePayload(), membershipId: "not-a-uuid" },
      { ...buildSuspendPayload(), membershipId: "not-a-uuid" },
      { ...buildRevokePayload(), membershipId: "not-a-uuid" },
      { ...buildReactivatePayload(), membershipId: "not-a-uuid" },
    ];
    for (const broken of variants) {
      expect(MembershipUpdateSchema.safeParse(broken).success).toBe(false);
    }
  });

  // ----------------------------------------------------------------------
  // Composability spot-check — schema parses through a real UUID v7.
  // ----------------------------------------------------------------------

  it("accepts a UUID v7 membershipId (daemon-emitted IDs are sortable v7)", () => {
    const parsed = MembershipUpdateSchema.parse({
      membershipId: SECOND_MEMBERSHIP_ID,
      action: "suspend",
    });
    expect(parsed.membershipId).toBe(SECOND_MEMBERSHIP_ID);
  });
});

// =============================================================================
// NonOwnerMembershipRole re-export — type-level only
// =============================================================================
//
// `NonOwnerMembershipRole` has no accompanying Zod schema in session.ts
// (the type alias narrows internal TypeScript service boundaries; no wire
// surface consumes it today — see session.ts:170-178). This block asserts
// the re-export wiring at the TYPE level. Compile-time only — if the
// re-export is broken, the assignment fails to typecheck.

describe("NonOwnerMembershipRole type re-export (compile-time pin)", () => {
  it("admits the three non-owner roles and excludes 'owner'", () => {
    const nonOwnerRoles: NonOwnerMembershipRole[] = [
      "viewer",
      "collaborator",
      "runtime contributor",
    ];
    expect(nonOwnerRoles).toHaveLength(3);

    // Compile-time proof: the next line would NOT typecheck if uncommented.
    // const bad: NonOwnerMembershipRole = "owner"; // <- expected ts(2322)
  });
});
