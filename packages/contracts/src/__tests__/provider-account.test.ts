// Plan-029 T1.1 + T1.4 — `providerAccount.*` contract coverage.
//
// Three groups, and the third is the one that has to keep working after this PR
// is forgotten:
//
//   1. Per-pair acceptance and rejection rows, plus the unknown-key refusal that
//      `.strict()` buys on every shape.
//   2. The tolerant observation boundary, with the closed wire union proved
//      closed beside it — the tolerance must not have leaked onto the wire.
//   3. The I-029-11 CENSUS. It DERIVES its subject set from
//      `PROVIDER_ACCOUNT_WIRE_SHAPES` and cross-checks that registry against the
//      module's own exports, so a shape added later is either censused or
//      caught. It carries a negative control, because a checker that has never
//      been shown to fail proves nothing about a clean result.
//
// Refs: Plan-029 T1.1, T1.4, I-029-1, I-029-2, I-029-11, I-029-13; ADR-028
// (bounded non-interactive token custody).

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import * as providerAccountModule from "../provider-account.js";
import {
  BILLING_MODES,
  CREDENTIAL_GENERATION_MIN,
  CredentialGenerationSchema,
  normalizeObservedProviderAuthMode,
  PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS,
  PROVIDER_ACCOUNT_WIRE_SHAPES,
  PROVIDER_AUTH_MODES,
  PROVIDER_NAMES,
  PROVIDER_QUOTA_DEFAULT_LIMIT_ID,
  ProviderAccountListRequestSchema,
  ProviderAccountListResponseSchema,
  ProviderAccountLoginCancelRequestSchema,
  ProviderAccountLoginCancelResponseSchema,
  ProviderAccountLoginRequestSchema,
  ProviderAccountLoginResponseSchema,
  ProviderAccountNotificationSchema,
  ProviderAccountProbeRequestSchema,
  ProviderAccountProbeResponseSchema,
  ProviderAccountRegisterRequestSchema,
  ProviderAccountRegisterResponseSchema,
  ProviderAccountRemoveRequestSchema,
  ProviderAccountRemoveResponseSchema,
  ProviderAccountResetCredentialHomeRequestSchema,
  ProviderAccountResetCredentialHomeResponseSchema,
  ProviderAccountSchema,
  ProviderAccountSetDefaultRequestSchema,
  ProviderAccountSetDefaultResponseSchema,
  ProviderAccountSubscribeRequestSchema,
  ProviderAccountUpdateRequestSchema,
  ProviderAccountUpdateResponseSchema,
  ProviderAccountUsageWindowSchema,
  ProviderAuthModeSchema,
  ProviderNameSchema,
  ProviderReadinessSchema,
  ProviderRemedySchema,
} from "../provider-account.js";

const ACCOUNT_ID = "acct_01J8XYZ";
const OTHER_ACCOUNT_ID = "acct_01J8ABC";
const TIMESTAMP = "2026-08-31T00:00:00.000Z";

function validAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: ACCOUNT_ID,
    provider: "claude",
    displayLabel: "Personal",
    credentialGeneration: 1,
    billingMode: "subscription",
    isDefault: true,
    healthState: "authenticated",
    observedAuthMode: "oauth_subscription",
    loggedInAt: TIMESTAMP,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
    ...overrides,
  };
}

function validUsageWindow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: ACCOUNT_ID,
    limitId: PROVIDER_QUOTA_DEFAULT_LIMIT_ID,
    windowMins: 10080,
    usedPercent: 41.5,
    observedAt: TIMESTAMP,
    observedCredentialGeneration: 1,
    source: "probe",
    ...overrides,
  };
}

describe("provider-account enums", () => {
  it("declares the provider set closed at exactly the two pinned providers", () => {
    expect([...PROVIDER_NAMES]).toEqual(["claude", "codex"]);
    expect(ProviderNameSchema.safeParse("claude").success).toBe(true);
    expect(ProviderNameSchema.safeParse("codex").success).toBe(true);
    // An account's provider selects the driver, the credential-home layout, and
    // the quota vocabulary, so an unrecognized value has no safe reading.
    expect(ProviderNameSchema.safeParse("gemini").success).toBe(false);
    expect(ProviderNameSchema.safeParse("Claude").success).toBe(false);
  });

  it("discriminates all three billing modes and keeps `unknown` distinct", () => {
    expect([...BILLING_MODES]).toEqual(["subscription", "metered", "unknown"]);
    for (const billingMode of BILLING_MODES) {
      expect(ProviderAccountSchema.safeParse(validAccount({ billingMode })).success).toBe(true);
    }
    // `unknown` is the honest-absence arm — a distinct value, never elided into
    // `metered` and never expressible as an omission.
    expect(ProviderAccountSchema.safeParse(validAccount({ billingMode: "free" })).success).toBe(
      false,
    );
    const withoutBillingMode = validAccount();
    delete withoutBillingMode["billingMode"];
    expect(ProviderAccountSchema.safeParse(withoutBillingMode).success).toBe(false);
  });
});

describe("ProviderAuthMode — closed on the wire, tolerant at the observation boundary", () => {
  it("keeps the wire union closed", () => {
    for (const authMode of PROVIDER_AUTH_MODES) {
      expect(ProviderAuthModeSchema.safeParse(authMode).success).toBe(true);
    }
    // The negative control that proves the tolerance did not leak onto the wire:
    // the daemon is the producer on every surface this type appears on, so a
    // value outside the union is a composition defect and must fail loudly.
    expect(ProviderAuthModeSchema.safeParse("magic_link").success).toBe(false);
    expect(ProviderAuthModeSchema.safeParse(null).success).toBe(false);
  });

  it("maps an unrecognized provider-reported mode onto `unknown` rather than throwing", () => {
    // The whole point: a vendor adding a mode must degrade an observation's
    // precision, not fail the observation closed.
    expect(normalizeObservedProviderAuthMode("device_grant")).toBe("unknown");
    expect(normalizeObservedProviderAuthMode("OAUTH_SUBSCRIPTION")).toBe("unknown");
    expect(normalizeObservedProviderAuthMode(42)).toBe("unknown");
    expect(normalizeObservedProviderAuthMode({ mode: "oauth_token" })).toBe("unknown");
    expect(() => normalizeObservedProviderAuthMode(Symbol("x"))).not.toThrow();
  });

  it("recognizes every union member, trimming the provider's own whitespace", () => {
    for (const authMode of PROVIDER_AUTH_MODES) {
      expect(normalizeObservedProviderAuthMode(authMode)).toBe(authMode);
      expect(normalizeObservedProviderAuthMode(`  ${authMode}\n`)).toBe(authMode);
    }
  });

  it("distinguishes NOT OBSERVED from OBSERVED-BUT-UNRECOGNIZED", () => {
    // `null` is not `unknown`. Recording an absent report as `unknown` would
    // claim the provider named something it did not.
    expect(normalizeObservedProviderAuthMode(null)).toBeNull();
    expect(normalizeObservedProviderAuthMode(undefined)).toBeNull();
    // A field present but empty names no mode, which is indistinguishable from
    // having supplied no field.
    expect(normalizeObservedProviderAuthMode("")).toBeNull();
    expect(normalizeObservedProviderAuthMode("   ")).toBeNull();
  });
});

describe("CredentialGeneration", () => {
  it("floors at the generation an account is born at and rejects everything below it", () => {
    expect(CREDENTIAL_GENERATION_MIN).toBe(1);
    expect(CredentialGenerationSchema.safeParse(1).success).toBe(true);
    expect(CredentialGenerationSchema.safeParse(9001).success).toBe(true);
    // Generation 0 would order BEFORE a freshly registered account and let a
    // fabricated reading read as newer than the account it describes.
    expect(CredentialGenerationSchema.safeParse(0).success).toBe(false);
    expect(CredentialGenerationSchema.safeParse(-1).success).toBe(false);
    // A fractional generation compares unequal to every stored value.
    expect(CredentialGenerationSchema.safeParse(1.5).success).toBe(false);
    expect(CredentialGenerationSchema.safeParse(Number.NaN).success).toBe(false);
    expect(CredentialGenerationSchema.safeParse("1").success).toBe(false);
  });
});

describe("ProviderAccount record", () => {
  it("accepts the full record and the subset-reported identity trio", () => {
    expect(ProviderAccountSchema.safeParse(validAccount()).success).toBe(true);
    // Each provider-reported member is INDEPENDENTLY optional: a provider may
    // report any subset, and an absent value stays absent rather than defaulting.
    expect(
      ProviderAccountSchema.safeParse(validAccount({ observedAccountEmail: "a@example.test" }))
        .success,
    ).toBe(true);
    expect(
      ProviderAccountSchema.safeParse(
        validAccount({ observedAccountOrgId: "org_1", observedAccountOrgName: "Acme" }),
      ).success,
    ).toBe(true);
  });

  it("spells an unobserved fact as an explicit null rather than an omission", () => {
    // `.nullable()` and not `.optional()`: an optional member would make
    // "unobserved" and "the producer forgot" the same value on the wire.
    expect(
      ProviderAccountSchema.safeParse(
        validAccount({ observedAuthMode: null, loggedInAt: null, expectedReloginAtEstimate: null }),
      ).success,
    ).toBe(true);
    const withoutAuthMode = validAccount();
    delete withoutAuthMode["observedAuthMode"];
    expect(ProviderAccountSchema.safeParse(withoutAuthMode).success).toBe(false);
    const withoutEstimate = validAccount();
    delete withoutEstimate["expectedReloginAtEstimate"];
    expect(ProviderAccountSchema.safeParse(withoutEstimate).success).toBe(false);
  });

  it("rejects a whitespace-only or NUL-bearing display label", () => {
    expect(ProviderAccountSchema.safeParse(validAccount({ displayLabel: "" })).success).toBe(false);
    expect(ProviderAccountSchema.safeParse(validAccount({ displayLabel: "   " })).success).toBe(
      false,
    );
    expect(ProviderAccountSchema.safeParse(validAccount({ displayLabel: "a\0b" })).success).toBe(
      false,
    );
  });

  it("requires offset-bearing RFC 3339 timestamps", () => {
    expect(
      ProviderAccountSchema.safeParse(validAccount({ loggedInAt: "2026-08-31" })).success,
    ).toBe(false);
    expect(
      ProviderAccountSchema.safeParse(validAccount({ loggedInAt: "2026-08-31T00:00:00+02:00" }))
        .success,
    ).toBe(true);
  });

  it("carries no credential-home path", () => {
    // The prohibition, asserted rather than trusted to the header: on every
    // surface a session participant can reach, a credential home names a column
    // and nothing else. The one wire member that carries a home is the readiness
    // remedy's sign-in arm.
    expect(
      ProviderAccountSchema.safeParse(
        validAccount({ credentialHomePath: "/var/lib/sidekicks/homes/acct" }),
      ).success,
    ).toBe(false);
  });
});

describe("readiness and its remedy union", () => {
  it("accepts an authenticated entry with no remedy and a refused entry with one", () => {
    expect(
      ProviderReadinessSchema.safeParse({
        provider: "claude",
        state: "authenticated",
        resolvedAccountId: ACCOUNT_ID,
        observedAt: TIMESTAMP,
      }).success,
    ).toBe(true);
    expect(
      ProviderReadinessSchema.safeParse({
        provider: "codex",
        state: "no_account",
        remedy: { kind: "register", provider: "codex" },
      }).success,
    ).toBe(true);
  });

  it("refuses a remedy whose discriminant names no arm", () => {
    expect(ProviderRemedySchema.safeParse({ kind: "sign_up", provider: "claude" }).success).toBe(
      false,
    );
  });

  it("requires the resolved account on the sign-in arm and candidates on the choose arm", () => {
    expect(
      ProviderRemedySchema.safeParse({
        kind: "sign_in",
        accountId: ACCOUNT_ID,
        signInInvocation: "claude setup-token",
        credentialHomePath: "/var/lib/sidekicks/homes/acct",
      }).success,
    ).toBe(true);
    // The sign-in arm is the arm where an account resolved, so its id is not
    // optional there.
    expect(
      ProviderRemedySchema.safeParse({
        kind: "sign_in",
        signInInvocation: "claude setup-token",
        credentialHomePath: "/var/lib/sidekicks/homes/acct",
      }).success,
    ).toBe(false);
    expect(
      ProviderRemedySchema.safeParse({
        kind: "choose_default",
        candidateAccountIds: [ACCOUNT_ID, OTHER_ACCOUNT_ID],
      }).success,
    ).toBe(true);
    expect(
      ProviderRemedySchema.safeParse({ kind: "choose_default", candidateAccountIds: [] }).success,
    ).toBe(false);
  });

  it("requires the home path to be non-empty, NUL-free, and bounded", () => {
    const signInRemedy = (credentialHomePath: string): unknown => ({
      kind: "sign_in",
      accountId: ACCOUNT_ID,
      signInInvocation: "claude setup-token",
      credentialHomePath,
    });
    expect(ProviderRemedySchema.safeParse(signInRemedy("")).success).toBe(false);
    expect(ProviderRemedySchema.safeParse(signInRemedy("   ")).success).toBe(false);
    expect(ProviderRemedySchema.safeParse(signInRemedy("/homes/a\0b")).success).toBe(false);
    expect(ProviderRemedySchema.safeParse(signInRemedy("/".repeat(9000))).success).toBe(false);
    // ABSOLUTENESS IS DELIBERATELY NOT ENFORCED HERE, on the standing
    // `RepoAttachRequest.localPath` precedent: a `startsWith("/")` rule would
    // refuse every Windows home, and Windows is a V1 tier. The filesystem rules
    // belong to the daemon's credential-home service, which owns the only
    // context in which they are decidable.
    expect(ProviderRemedySchema.safeParse(signInRemedy("C:\\Users\\op\\.claude")).success).toBe(
      true,
    );
  });
});

describe("quota-window shape (I-029-13)", () => {
  it("accepts a reading and treats the window length as an attribute of it", () => {
    expect(ProviderAccountUsageWindowSchema.safeParse(validUsageWindow()).success).toBe(true);
    // Three limits sharing one window length is the case the key exists for.
    for (const limitId of ["weekly_opus", "weekly_all", "weekly_code"]) {
      expect(
        ProviderAccountUsageWindowSchema.safeParse(validUsageWindow({ limitId, windowMins: 10080 }))
          .success,
      ).toBe(true);
    }
  });

  it("accepts over-consumption and refuses a negative reading", () => {
    // NOT clamped on the wire: a provider may report over-consumption against a
    // soft limit, and clamping would silently misreport it.
    expect(
      ProviderAccountUsageWindowSchema.safeParse(validUsageWindow({ usedPercent: 143.2 })).success,
    ).toBe(true);
    expect(
      ProviderAccountUsageWindowSchema.safeParse(validUsageWindow({ usedPercent: -0.1 })).success,
    ).toBe(false);
  });

  it("refuses a non-positive window length and an unsourced reading", () => {
    expect(
      ProviderAccountUsageWindowSchema.safeParse(validUsageWindow({ windowMins: 0 })).success,
    ).toBe(false);
    expect(
      ProviderAccountUsageWindowSchema.safeParse(validUsageWindow({ windowMins: 1.5 })).success,
    ).toBe(false);
    // The background health observer is NOT a source and no third value exists.
    expect(
      ProviderAccountUsageWindowSchema.safeParse(validUsageWindow({ source: "observer" })).success,
    ).toBe(false);
  });

  it("keeps the limit vocabulary open", () => {
    // A closed union would fail a reading closed the moment a vendor added a
    // window — the opposite of the degrade-honestly posture this plane takes.
    expect(
      ProviderAccountUsageWindowSchema.safeParse(validUsageWindow({ limitId: "brand_new_window" }))
        .success,
    ).toBe(true);
  });
});

describe("request/response pairs", () => {
  it("accepts each read and mutation pair at its canonical shape", () => {
    expect(ProviderAccountListRequestSchema.safeParse({}).success).toBe(true);
    expect(ProviderAccountListRequestSchema.safeParse({ provider: "claude" }).success).toBe(true);
    expect(
      ProviderAccountListResponseSchema.safeParse({
        accounts: [validAccount()],
        usageWindows: [validUsageWindow()],
        readiness: [{ provider: "claude", state: "authenticated", resolvedAccountId: ACCOUNT_ID }],
      }).success,
    ).toBe(true);

    expect(
      ProviderAccountRegisterRequestSchema.safeParse({
        provider: "codex",
        displayLabel: "Work",
        billingMode: "metered",
      }).success,
    ).toBe(true);
    expect(
      ProviderAccountRegisterResponseSchema.safeParse({ account: validAccount() }).success,
    ).toBe(true);

    expect(
      ProviderAccountUpdateRequestSchema.safeParse({ accountId: ACCOUNT_ID, probeEnabled: false })
        .success,
    ).toBe(true);
    expect(ProviderAccountUpdateResponseSchema.safeParse({ account: validAccount() }).success).toBe(
      true,
    );

    expect(ProviderAccountRemoveRequestSchema.safeParse({ accountId: ACCOUNT_ID }).success).toBe(
      true,
    );
    expect(
      ProviderAccountRemoveResponseSchema.safeParse({ accountId: ACCOUNT_ID, removed: true })
        .success,
    ).toBe(true);

    expect(
      ProviderAccountSetDefaultRequestSchema.safeParse({ accountId: ACCOUNT_ID }).success,
    ).toBe(true);
    expect(
      ProviderAccountSetDefaultResponseSchema.safeParse({ account: validAccount() }).success,
    ).toBe(true);

    expect(
      ProviderAccountResetCredentialHomeRequestSchema.safeParse({ accountId: ACCOUNT_ID }).success,
    ).toBe(true);
    expect(
      ProviderAccountResetCredentialHomeResponseSchema.safeParse({
        accountId: ACCOUNT_ID,
        credentialGeneration: 2,
        healthState: "reauth_required",
      }).success,
    ).toBe(true);

    expect(ProviderAccountProbeRequestSchema.safeParse({ accountId: ACCOUNT_ID }).success).toBe(
      true,
    );
    expect(
      ProviderAccountProbeResponseSchema.safeParse({
        accountId: ACCOUNT_ID,
        healthState: "indeterminate",
        credentialGeneration: 1,
      }).success,
    ).toBe(true);

    expect(ProviderAccountLoginRequestSchema.safeParse({ accountId: ACCOUNT_ID }).success).toBe(
      true,
    );
    expect(
      ProviderAccountLoginResponseSchema.safeParse({
        attemptId: "attempt_1",
        verificationUri: "https://provider.example/device",
        userCode: "ABCD-EFGH",
        expiresAt: TIMESTAMP,
      }).success,
    ).toBe(true);
    // The authorization-URL arm carries no code: the shape mirrors the
    // provider's own, and one pinned leg emits a URL alone.
    expect(
      ProviderAccountLoginResponseSchema.safeParse({
        attemptId: "attempt_2",
        verificationUri: "https://provider.example/oauth/authorize?state=x",
      }).success,
    ).toBe(true);
    expect(
      ProviderAccountLoginResponseSchema.safeParse({
        attemptId: "attempt_3",
        verificationUri: "open your browser",
      }).success,
    ).toBe(false);

    expect(
      ProviderAccountLoginCancelRequestSchema.safeParse({ attemptId: "attempt_1" }).success,
    ).toBe(true);
    for (const status of ["cancelled", "notFound"]) {
      expect(ProviderAccountLoginCancelResponseSchema.safeParse({ status }).success).toBe(true);
    }
    // `notFound` is an outcome, not an error, so there is no third arm standing
    // in for "the attempt failed".
    expect(ProviderAccountLoginCancelResponseSchema.safeParse({ status: "failed" }).success).toBe(
      false,
    );

    expect(ProviderAccountSubscribeRequestSchema.safeParse({}).success).toBe(true);
  });

  it("refuses an unknown key on every request, response, and notification shape", () => {
    // `.strict()` everywhere, asserted over the derived registry rather than
    // shape by shape, so a later shape cannot be added non-strict unnoticed.
    for (const wireShape of PROVIDER_ACCOUNT_WIRE_SHAPES) {
      const probe = wireShape.schema.safeParse({ smuggledMember: "x" });
      expect(probe.success, `\`${wireShape.name}\` accepted an unknown key`).toBe(false);
    }
  });

  it("refuses a caller-asserted credential generation on the register request", () => {
    // `credentialGeneration` is daemon-owned and appears on NO request: a caller
    // that could assert one could assert that a stale quota reading or a
    // superseded attention epoch is current.
    expect(
      ProviderAccountRegisterRequestSchema.safeParse({
        provider: "claude",
        displayLabel: "Personal",
        billingMode: "subscription",
        credentialGeneration: 7,
      }).success,
    ).toBe(false);
    // Nor on any other request shape in the module.
    for (const wireShape of PROVIDER_ACCOUNT_WIRE_SHAPES) {
      if (wireShape.direction !== "request") {
        continue;
      }
      expect(
        collectMemberNames(wireShape.schema),
        `\`${wireShape.name}\` exposes a caller-settable credential generation`,
      ).not.toContain("credentialGeneration");
    }
  });

  it("admits `accountId` on the register request only as the re-supply selector", () => {
    // A SELECTOR, not an identity assertion: supplied, it means "replace the
    // sealed token on THIS account", and a supplied id naming no registered
    // account is refused by the daemon rather than created. The alternative —
    // deregister and re-register — would daemon-mint a NEW immutable identity
    // and discard the spend, quota, and attention history keyed to the account
    // the operator is trying to repair.
    expect(
      ProviderAccountRegisterRequestSchema.safeParse({
        provider: "claude",
        displayLabel: "Personal",
        billingMode: "subscription",
        accountId: ACCOUNT_ID,
        nonInteractiveToken: "sk-example-token",
      }).success,
    ).toBe(true);
    expect(
      ProviderAccountRegisterRequestSchema.safeParse({
        provider: "claude",
        displayLabel: "Personal",
        billingMode: "subscription",
        accountId: "",
      }).success,
    ).toBe(false);
  });

  it("refuses a partial success on the remove response", () => {
    // `removed: false` would be a refusal wearing a success envelope; every
    // refusal on this verb is a typed error instead.
    expect(
      ProviderAccountRemoveResponseSchema.safeParse({ accountId: ACCOUNT_ID, removed: false })
        .success,
    ).toBe(false);
  });

  it("accepts every notification arm and refuses an unknown kind", () => {
    expect(
      ProviderAccountNotificationSchema.safeParse({
        kind: "account_changed",
        account: validAccount(),
      }).success,
    ).toBe(true);
    expect(
      ProviderAccountNotificationSchema.safeParse({
        kind: "account_removed",
        accountId: ACCOUNT_ID,
      }).success,
    ).toBe(true);
    for (const outcome of ["succeeded", "failed", "cancelled"]) {
      expect(
        ProviderAccountNotificationSchema.safeParse({
          kind: "login_completed",
          attemptId: "attempt_1",
          accountId: ACCOUNT_ID,
          outcome,
        }).success,
      ).toBe(true);
    }
    expect(
      ProviderAccountNotificationSchema.safeParse({
        kind: "usage_window_updated",
        accountId: ACCOUNT_ID,
        window: validUsageWindow(),
      }).success,
    ).toBe(true);
    expect(
      ProviderAccountNotificationSchema.safeParse({ kind: "account_probed", accountId: ACCOUNT_ID })
        .success,
    ).toBe(false);
  });
});

// --------------------------------------------------------------------------
// The I-029-11 census
// --------------------------------------------------------------------------

/**
 * Every member name reachable from a schema, at any nesting depth.
 *
 * Walking the runtime `def` rather than the exported TypeScript type is what
 * makes this a census of the WIRE and not of a hand-maintained list: a member
 * nested inside an array element, a union arm, or an optional wrapper is
 * reachable by a producer and is therefore reachable here.
 */
function collectMemberNames(schema: z.ZodType<unknown>): readonly string[] {
  const memberNames: string[] = [];
  const seen = new Set<unknown>();

  function walk(node: unknown): void {
    if (node === null || typeof node !== "object" || seen.has(node)) {
      return;
    }
    seen.add(node);
    const definition = (node as { def?: Record<string, unknown> }).def;
    if (definition === undefined) {
      return;
    }
    const shape = definition["shape"];
    if (shape !== undefined && typeof shape === "object" && shape !== null) {
      for (const [memberName, memberSchema] of Object.entries(shape)) {
        memberNames.push(memberName);
        walk(memberSchema);
      }
    }
    for (const wrapperKey of ["innerType", "element", "valueType", "keyType", "in", "out"]) {
      walk(definition[wrapperKey]);
    }
    const options = definition["options"];
    if (Array.isArray(options)) {
      for (const option of options) {
        walk(option);
      }
    }
  }

  walk(schema);
  return memberNames;
}

/**
 * Member names that could carry credential MATERIAL. Deliberately narrower than
 * "anything mentioning credentials": `credentialHomePath` and
 * `credentialGeneration` are legitimate non-secret members, so matching the bare
 * word `credential` would make the census cry wolf and be relaxed into
 * uselessness the first time it did.
 */
const CREDENTIAL_SHAPED_MEMBER =
  /(token|secret|password|passphrase|api_?key|private_?key|cookie|bearer)/i;

function credentialShapedMembersOf(schema: z.ZodType<unknown>): readonly string[] {
  return collectMemberNames(schema).filter((memberName) =>
    CREDENTIAL_SHAPED_MEMBER.test(memberName),
  );
}

describe("I-029-11 — one credential-accepting input, zero credential-bearing outputs", () => {
  it("registers every request, response, and notification schema the module exports", () => {
    // The completeness check that keeps the census from going vacuous: a shape
    // added later without a registry entry fails HERE rather than silently
    // escaping every count below.
    const exportedWireSchemaNames = Object.keys(providerAccountModule)
      .filter((exportName) => /(Request|Response|Notification)Schema$/.test(exportName))
      .map((exportName) => exportName.replace(/Schema$/, ""))
      .sort();
    const registeredNames = PROVIDER_ACCOUNT_WIRE_SHAPES.map((wireShape) => wireShape.name).sort();
    expect(registeredNames).toEqual(exportedWireSchemaNames);
    // And each entry points at the schema it names, so a copy-paste that
    // registered one shape twice cannot pass.
    for (const wireShape of PROVIDER_ACCOUNT_WIRE_SHAPES) {
      expect(
        (providerAccountModule as unknown as Record<string, unknown>)[`${wireShape.name}Schema`],
        `\`${wireShape.name}\` registry entry does not point at its own schema`,
      ).toBe(wireShape.schema);
    }
    expect(new Set(registeredNames).size).toBe(registeredNames.length);
  });

  it("counts exactly one credential-accepting input, and names it", () => {
    const credentialInputs = PROVIDER_ACCOUNT_WIRE_SHAPES.filter(
      (wireShape) => wireShape.direction === "request",
    ).flatMap((wireShape) =>
      credentialShapedMembersOf(wireShape.schema).map(
        (memberName) => `${wireShape.name}.${memberName}`,
      ),
    );
    expect(credentialInputs).toEqual(["ProviderAccountRegisterRequest.nonInteractiveToken"]);
    // And the count is taken over a shape that DOES carry the re-supply
    // selector, so "exactly one" is proven insensitive to `accountId` rather
    // than only measured on a request that happens not to accept it.
    expect(collectMemberNames(ProviderAccountRegisterRequestSchema)).toContain("accountId");
  });

  it("counts zero credential-bearing outputs across every response and notification", () => {
    const credentialOutputs = PROVIDER_ACCOUNT_WIRE_SHAPES.filter(
      (wireShape) => wireShape.direction !== "request",
    ).flatMap((wireShape) =>
      credentialShapedMembersOf(wireShape.schema).map(
        (memberName) => `${wireShape.name}.${memberName}`,
      ),
    );
    expect(credentialOutputs).toEqual([]);
  });

  it("detects a credential-shaped member at any depth (negative control)", () => {
    // Without this, both counts above would be equally consistent with a walker
    // that never descended past the top level. Each fixture hides the member one
    // layer deeper than the last.
    const nestedInAnObject = ProviderAccountRegisterResponseSchema;
    expect(credentialShapedMembersOf(nestedInAnObject)).toEqual([]);
    expect(collectMemberNames(nestedInAnObject)).toContain("displayLabel");

    // A member nested inside an ARRAY element — the shape `accounts` uses.
    expect(collectMemberNames(ProviderAccountListResponseSchema)).toContain("usedPercent");
    // A member nested inside a UNION arm — the shape the readiness remedy uses.
    expect(collectMemberNames(ProviderAccountListResponseSchema)).toContain("signInInvocation");
    // A member nested inside a DISCRIMINATED union arm — the notification shape.
    expect(collectMemberNames(ProviderAccountNotificationSchema)).toContain("failureReason");

    // And the detector itself fires on each of the names it is meant to catch.
    for (const forbidden of [
      "refreshToken",
      "clientSecret",
      "password",
      "apiKey",
      "api_key",
      "privateKey",
      "sessionCookie",
      "bearerToken",
    ]) {
      expect(CREDENTIAL_SHAPED_MEMBER.test(forbidden), `\`${forbidden}\` was not flagged`).toBe(
        true,
      );
    }
    // While the legitimate non-secret members are NOT flagged — the
    // discrimination that keeps this census from being relaxed away.
    // `accountId` earns its place here: it is the one other member the register
    // request accepts, so the count of one below has to be insensitive to it.
    for (const permitted of [
      "credentialHomePath",
      "credentialGeneration",
      "attemptId",
      "accountId",
    ]) {
      expect(CREDENTIAL_SHAPED_MEMBER.test(permitted), `\`${permitted}\` was wrongly flagged`).toBe(
        false,
      );
    }
  });

  it("marks exactly the credential-accepting member for transport redaction", () => {
    expect([...PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS]).toEqual(["nonInteractiveToken"]);
    // The marking and the census must name the same member: a redaction list
    // that drifted from the wire would leave a new credential member logged.
    const censusedInputMembers = PROVIDER_ACCOUNT_WIRE_SHAPES.filter(
      (wireShape) => wireShape.direction === "request",
    ).flatMap((wireShape) => credentialShapedMembersOf(wireShape.schema));
    expect([...PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS].sort()).toEqual(
      [...new Set(censusedInputMembers)].sort(),
    );
  });

  it("keeps the token member off every response and notification shape by name", () => {
    for (const wireShape of PROVIDER_ACCOUNT_WIRE_SHAPES) {
      if (wireShape.direction === "request") {
        continue;
      }
      for (const redactedMember of PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS) {
        expect(
          collectMemberNames(wireShape.schema),
          `\`${wireShape.name}\` carries the write-only member \`${redactedMember}\``,
        ).not.toContain(redactedMember);
      }
    }
  });

  it("carries the credential input on exactly one request shape", () => {
    const carryingShapes = PROVIDER_ACCOUNT_WIRE_SHAPES.filter((wireShape) =>
      collectMemberNames(wireShape.schema).includes("nonInteractiveToken"),
    ).map((wireShape) => wireShape.name);
    expect(carryingShapes).toEqual(["ProviderAccountRegisterRequest"]);
  });
});
