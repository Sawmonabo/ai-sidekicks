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
//      caught. It closes with the fourth direction the schema registry cannot
//      reach — the ERROR channel, whose `fields` is `Record<string, unknown>` —
//      by censusing representative refusal envelopes both by member name and by
//      value against the token fixture. Every part of it carries a negative
//      control, because a checker that has never been shown to fail proves
//      nothing about a clean result.
//
// Refs: Plan-029 T1.1, T1.4, I-029-1, I-029-2, I-029-11, I-029-13; ADR-028
// (bounded non-interactive token custody).

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import type { JsonRpcErrorData } from "../jsonrpc.js";

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
/**
 * The one credential value this plane accepts, named once so the error-envelope
 * census below can scan for it BY VALUE and not only by member name.
 */
const TOKEN_FIXTURE = "sk-example-token";

function validAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: ACCOUNT_ID,
    provider: "claude",
    displayLabel: "Personal",
    credentialGeneration: 1,
    billingMode: "subscription",
    isDefault: true,
    healthState: "authenticated",
    healthObservedAt: TIMESTAMP,
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

  it("carries the stored observation as a PAIR, so a fresh indeterminate is not a never-observed one", () => {
    // The defect this member closes: with `healthState` alone, an account that
    // has never been observed and one whose probe genuinely could not decide are
    // the same value on the wire, and every non-default account in a list reply
    // carries a state with no age at all (readiness is derived per PROVIDER from
    // the resolved account, so its `observedAt` covers one account per provider).
    const neverObserved = validAccount({
      healthState: "indeterminate",
      healthObservedAt: null,
    });
    const probedAndUndecided = validAccount({
      healthState: "indeterminate",
      healthObservedAt: TIMESTAMP,
    });
    expect(ProviderAccountSchema.safeParse(neverObserved).success).toBe(true);
    expect(ProviderAccountSchema.safeParse(probedAndUndecided).success).toBe(true);
    expect(neverObserved["healthObservedAt"]).not.toEqual(probedAndUndecided["healthObservedAt"]);

    // Required-shape and nullable, matching the DDL pair and the four members
    // beside it: an omitted member would make "never observed" and "the producer
    // forgot" the same wire value, which is the collapse this member undoes.
    const withoutObservedAt = validAccount();
    delete withoutObservedAt["healthObservedAt"];
    expect(ProviderAccountSchema.safeParse(withoutObservedAt).success).toBe(false);

    // The same offset-bearing RFC 3339 rule the module's other timestamps take.
    expect(
      ProviderAccountSchema.safeParse(validAccount({ healthObservedAt: "2026-08-31" })).success,
    ).toBe(false);
    expect(
      ProviderAccountSchema.safeParse(
        validAccount({ healthObservedAt: "2026-08-31T00:00:00+02:00" }),
      ).success,
    ).toBe(true);
  });

  it("refuses an observed health state carrying no observation time", () => {
    // `healthObservedAt === null` means NO observation has ever been taken, so
    // only `indeterminate` is reachable there. The other three arms are outcomes
    // OF an observation: an `authenticated` account whose authentication has no
    // age is a reading no probe could have produced, and a client rendering it
    // would show a freshness the daemon never measured.
    for (const observedOnlyState of ["authenticated", "reauth_required", "home_missing"] as const) {
      const parsed = ProviderAccountSchema.safeParse(
        validAccount({ healthState: observedOnlyState, healthObservedAt: null }),
      );
      expect(parsed.success, `\`${observedOnlyState}\` was admitted with a null observation`).toBe(
        false,
      );
      // Pathed at the timestamp: the durable pair CHECK means a stored
      // `authenticated` implies a stored observation time, so the member that
      // went missing between the row and the wire is the timestamp.
      expect(
        parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join(".")),
      ).toEqual(["healthObservedAt"]);
    }
    // The discriminating control: the rule is about the STATE, not about null
    // being disallowed, and `indeterminate` keeps both readings.
    expect(
      ProviderAccountSchema.safeParse(
        validAccount({ healthState: "indeterminate", healthObservedAt: null }),
      ).success,
    ).toBe(true);
    for (const observedOnlyState of ["authenticated", "reauth_required", "home_missing"] as const) {
      expect(
        ProviderAccountSchema.safeParse(
          validAccount({ healthState: observedOnlyState, healthObservedAt: TIMESTAMP }),
        ).success,
      ).toBe(true);
    }
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

  it("binds each readiness state to the one remedy its state calls for", () => {
    // The mapping `Spec-029 §Node provider readiness and the sign-in handoff`
    // states as "three different actions, not one". Before this refinement the
    // union's discriminant was free of the state beside it, so a `no_account`
    // entry could carry a `sign_in` remedy and disclose a credential-home path
    // for a resolution that reached no account at all.
    const signIn = {
      kind: "sign_in",
      accountId: ACCOUNT_ID,
      signInInvocation: "claude setup-token",
      credentialHomePath: "/var/lib/sidekicks/homes/acct",
    };
    const register = { kind: "register", provider: "claude" };
    const chooseDefault = { kind: "choose_default", candidateAccountIds: [ACCOUNT_ID] };
    // `resolvedAccountId` rides only the three states that resolved one, which
    // is the shape a producer actually emits.
    const legal: ReadonlyArray<readonly [string, unknown, boolean]> = [
      ["reauth_required", signIn, true],
      ["home_missing", signIn, true],
      ["indeterminate", signIn, true],
      ["no_account", register, false],
      ["no_default", chooseDefault, false],
    ];
    for (const [state, remedy, resolved] of legal) {
      expect(
        ProviderReadinessSchema.safeParse({
          provider: "claude",
          state,
          ...(resolved ? { resolvedAccountId: ACCOUNT_ID } : {}),
          remedy,
        }).success,
        `\`${state}\` refused its own remedy`,
      ).toBe(true);
    }
    // Every OTHER pairing is refused, so this is a census of the mapping and not
    // five happy paths: the many-to-one `sign_in` arms are proved not to accept
    // the two account-plane remedies, and neither account-plane state accepts
    // the sign-in shape whose path names a home it never resolved. Every case
    // here supplies `resolvedAccountId`, and the issue path is asserted, so a
    // refusal is attributable to the KIND mismatch and never to the separate
    // account-agreement rule below.
    for (const [state, expected] of legal) {
      for (const remedy of [signIn, register, chooseDefault]) {
        if (remedy === expected) {
          continue;
        }
        const parsed = ProviderReadinessSchema.safeParse({
          provider: "claude",
          state,
          resolvedAccountId: ACCOUNT_ID,
          remedy,
        });
        expect(parsed.success, `\`${state}\` admitted a remedy it does not call for`).toBe(false);
        expect(
          parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join(".")),
        ).toEqual(["remedy.kind"]);
      }
    }
  });

  it("carries no remedy on the authenticated arm", () => {
    // `authenticated` is the one state with nothing to do, so a remedy there is
    // not redundant but wrong: it would put a sign-in invocation and a
    // credential-home path on the entry whose account already needs neither.
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
        provider: "claude",
        state: "authenticated",
        resolvedAccountId: ACCOUNT_ID,
        observedAt: TIMESTAMP,
        remedy: {
          kind: "sign_in",
          accountId: ACCOUNT_ID,
          signInInvocation: "claude setup-token",
          credentialHomePath: "/var/lib/sidekicks/homes/acct",
        },
      }).success,
    ).toBe(false);
  });

  it("keeps requiredness with the producer while checking presence", () => {
    // The member stays `.optional()` on every arm: `Spec-029` settles it
    // schema-optional and PRODUCER-obligated, and a strict parser cannot express
    // per-arm requiredness without splitting the interface. What the parser now
    // enforces is the other half — a remedy that IS present must be the right
    // one. Absence still parses on a state that owes one.
    expect(
      ProviderReadinessSchema.safeParse({ provider: "codex", state: "no_account" }).success,
    ).toBe(true);
  });

  it("binds the sign-in remedy's account to the entry that resolved it", () => {
    const signInFor = (accountId: string): unknown => ({
      kind: "sign_in",
      accountId,
      signInInvocation: "claude setup-token",
      credentialHomePath: "/var/lib/sidekicks/homes/acct",
    });
    // A remedy naming a DIFFERENT account points the operator at one account's
    // credential home to repair another's — the arbitrary cross-account election
    // I-029-5 refuses, arriving as guidance instead of as a binding.
    expect(
      ProviderReadinessSchema.safeParse({
        provider: "claude",
        state: "reauth_required",
        resolvedAccountId: ACCOUNT_ID,
        remedy: signInFor(OTHER_ACCOUNT_ID),
      }).success,
    ).toBe(false);
    // And an entry that resolved NO account cannot carry a home path at all:
    // `resolvedAccountId` is present iff resolution reached exactly one account,
    // so a sign-in remedy without one names a home belonging to no entry.
    expect(
      ProviderReadinessSchema.safeParse({
        provider: "claude",
        state: "reauth_required",
        remedy: signInFor(ACCOUNT_ID),
      }).success,
    ).toBe(false);
    expect(
      ProviderReadinessSchema.safeParse({
        provider: "claude",
        state: "reauth_required",
        resolvedAccountId: ACCOUNT_ID,
        remedy: signInFor(ACCOUNT_ID),
      }).success,
    ).toBe(true);
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
    // The verb's whole effect is on this member, and it has no partial success:
    // `isDefault: false` on a SUCCESS reply would be a refusal wearing a success
    // envelope, while every real refusal on this verb is a typed error
    // (`provideraccount.unknown`, `permission_denied`, `default_conflict`). The
    // sibling `ProviderAccountRemoveResponse.removed` makes the same argument
    // with `z.literal(true)`; this one is a refinement because the account
    // projection is shared and narrowing the type here would fork it.
    expect(
      ProviderAccountSetDefaultResponseSchema.safeParse({
        account: validAccount({ isDefault: false }),
      }).success,
    ).toBe(false);
    // And the shared projection is NOT narrowed by that pin: every other reply
    // returning an account still admits a non-default one, which is the reading
    // a list of accounts is made of.
    expect(
      ProviderAccountUpdateResponseSchema.safeParse({ account: validAccount({ isDefault: false }) })
        .success,
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
        nonInteractiveToken: TOKEN_FIXTURE,
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

    // NEITHER member is required on its own: an ordinary registration carries
    // no token, and a token with no `accountId` is the ordinary token-mode
    // registration of a NEW account. Only the combination is constrained, so
    // both of these stay admissible.
    expect(
      ProviderAccountRegisterRequestSchema.safeParse({
        provider: "claude",
        displayLabel: "Personal",
        billingMode: "subscription",
      }).success,
    ).toBe(true);
    expect(
      ProviderAccountRegisterRequestSchema.safeParse({
        provider: "claude",
        displayLabel: "Personal",
        billingMode: "subscription",
        nonInteractiveToken: TOKEN_FIXTURE,
      }).success,
    ).toBe(true);

    // ...but the selector alone is REFUSED. A re-supply with nothing to supply
    // is neither a registration nor a replacement, and admitting it would leave
    // the intent to be guessed by a handler — the cheap guess being a silent
    // no-op reported as a successful registration.
    const selectorAlone = ProviderAccountRegisterRequestSchema.safeParse({
      provider: "claude",
      displayLabel: "Personal",
      billingMode: "subscription",
      accountId: ACCOUNT_ID,
    });
    expect(selectorAlone.success).toBe(false);
    if (selectorAlone.success) {
      throw new Error("unreachable — the selector-alone request must not parse");
    }
    // Refused against the member the caller must ADD, not against the id, which
    // is not the mistake.
    expect(selectorAlone.error.issues.map((issue) => issue.path.join("."))).toContain(
      "nonInteractiveToken",
    );
    expect(
      selectorAlone.error.issues.some((issue) =>
        issue.message.includes("must also carry nonInteractiveToken"),
      ),
    ).toBe(true);
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

  it("refuses a usage-window notification whose reading contradicts its routing key", () => {
    // The outer `accountId` routes; `window.accountId` is part of the reading.
    // Both are registered members and both are carried deliberately, so the
    // constraint is EQUALITY rather than the removal of either: a consumer
    // keying off the outer member would file this reading under an account it
    // does not describe, and one keying off the inner member would ignore the
    // routing the daemon performed.
    const mismatched = ProviderAccountNotificationSchema.safeParse({
      kind: "usage_window_updated",
      accountId: ACCOUNT_ID,
      window: validUsageWindow({ accountId: OTHER_ACCOUNT_ID }),
    });
    expect(mismatched.success).toBe(false);
    if (mismatched.success) {
      throw new Error("unreachable — a contradictory usage-window notification must not parse");
    }
    // Refused against the half that contradicts the envelope it arrived in.
    expect(mismatched.error.issues.map((issue) => issue.path.join("."))).toContain(
      "window.accountId",
    );

    // The negative control for the assertion above: the same notification with
    // the two halves agreeing parses, so the refusal is the mismatch and not the
    // shape.
    expect(
      ProviderAccountNotificationSchema.safeParse({
        kind: "usage_window_updated",
        accountId: OTHER_ACCOUNT_ID,
        window: validUsageWindow({ accountId: OTHER_ACCOUNT_ID }),
      }).success,
    ).toBe(true);
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

/**
 * The same two questions the schema walker asks, asked of a plain JSON value —
 * which is what an error envelope is. `JsonRpcErrorData.fields` is
 * `Record<string, unknown>`, so there is no `def` to walk and no schema to
 * census: the subject has to be the value itself.
 *
 * Both go to any DEPTH, because a mapper that spread a whole request object into
 * `fields` would bury the member one level down, which is the accident most
 * likely to happen and the one a top-level key check would miss.
 */
function credentialShapedKeysDeep(value: unknown): readonly string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object") {
      return;
    }
    for (const [key, nested] of Object.entries(node)) {
      if (CREDENTIAL_SHAPED_MEMBER.test(key)) {
        found.push(key);
      }
      visit(nested);
    }
  };
  visit(value);
  return found;
}

function stringValuesDeep(value: unknown): readonly string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node !== null && typeof node === "object") {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return found;
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

    // And a member reachable ONLY THROUGH a shape carrying a cross-field
    // refinement. FIVE shapes in this module refuse a contradictory combination
    // with `.superRefine`, which returns the object schema itself rather than
    // wrapping it; were that ever to change, the walker would stop at the
    // wrapper and every count above would silently go vacuous for exactly those
    // shapes. Each of the five is covered, and this is the enumeration:
    //   * `ProviderAccountRegisterRequestSchema` — covered by the
    //     `accountId` assertion in the exactly-one-input test above.
    //   * `ProviderAccountSchema` — reached THROUGH the refinement here, since
    //     `displayLabel` lives on the refined account nested in the register
    //     reply asserted at the top of this test.
    //   * `ProviderReadinessSchema` — `signInInvocation` is reachable only
    //     through the refined readiness entry inside the list reply, asserted
    //     above.
    //   * `ProviderAccountSetDefaultResponseSchema` — a refined shape wrapping
    //     another refined shape, so it is the case that fails first if either
    //     level ever starts wrapping.
    //   * the `usage_window_updated` notification arm — `usedPercent` lives
    //     inside it.
    expect(collectMemberNames(ProviderAccountSetDefaultResponseSchema)).toContain("displayLabel");
    expect(collectMemberNames(ProviderAccountNotificationSchema)).toContain("usedPercent");

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

  // --------------------------------------------------------------------------
  // The fourth direction: the error channel
  // --------------------------------------------------------------------------
  //
  // The census above walks requests, responses, and notifications, which is
  // every SCHEMA this module declares — and a `provideraccount.*` refusal is not
  // one of them. It travels as `JsonRpcErrorData`, whose `fields` is
  // `Record<string, unknown>`: an untyped hole no schema census can close,
  // because there is no schema to walk. A mapper that spread the register
  // request into `fields` would therefore pass every count above unchanged while
  // logging the token.
  //
  // What is censused instead is REPRESENTATIVE mapped envelopes: each code is
  // transcribed from `docs/architecture/contracts/error-contracts.md`
  // §"Provider Account", and each `fields` shape is composed to be consistent
  // with that row's prose rather than copied from it, because the doc declares
  // the permitted contents and does not exhibit an envelope. They are scanned
  // two ways: by member NAME with the same detector the wire census uses, and
  // by VALUE against the one token fixture this suite registers. The value scan
  // is the one that matters for `provideraccount.token_class_refused`, whose
  // normative rule is about the VALUE and not the name — "names which condition
  // failed and never quotes, echoes, or excerpts the supplied value" — so a
  // field innocently called `supplied` or `observed` carrying the token is
  // caught here and would not be caught by any name-based rule.
  //
  // Two limits, stated rather than papered over. The fixture set is ENUMERATED
  // BY HAND, so a code added to that doc without a fixture here is not caught;
  // and the binding enforcement is the daemon's error mapper, a later phase —
  // this pins the contract the mapper will be held to. Declaring the field names
  // as an exported registry is deliberately NOT done yet: its only consumer
  // would be this test, and a declaration minted ahead of its reader is the
  // vacuity this whole block exists to prevent.
  const PROVIDER_ACCOUNT_REFUSAL_ENVELOPES: ReadonlyArray<JsonRpcErrorData> = [
    { type: "provideraccount.not_registered", fields: { provider: "claude" } },
    { type: "provideraccount.no_default", fields: { provider: "claude" } },
    { type: "provideraccount.unknown", fields: { providerAccountId: ACCOUNT_ID } },
    {
      type: "provideraccount.credential_home_unavailable",
      fields: { providerAccountId: ACCOUNT_ID },
    },
    {
      type: "provideraccount.not_authenticated",
      fields: { providerAccountId: ACCOUNT_ID, healthState: "indeterminate" },
    },
    { type: "provideraccount.permission_denied", fields: { providerAccountId: ACCOUNT_ID } },
    {
      type: "provideraccount.default_conflict",
      fields: { provider: "claude", providerAccountId: ACCOUNT_ID },
    },
    { type: "provideraccount.signin_unsupported", fields: { provider: "codex" } },
    {
      type: "provideraccount.signin_in_flight",
      fields: { providerAccountId: ACCOUNT_ID, attemptId: "att_01J8" },
    },
    // The condition is NAMED; the value that failed it is not carried, quoted,
    // or excerpted — the one row in that table whose text is a rule about the
    // payload rather than a description of it.
    {
      type: "provideraccount.token_class_refused",
      fields: { provider: "claude", failedCondition: "not_a_vendor_minted_non_interactive_token" },
    },
    { type: "provideraccount.credential_seal_refused", fields: { provider: "claude" } },
    {
      type: "provideraccount.provider_version_below_floor",
      fields: { provider: "codex", observedVersion: "0.140.0", requiredVersion: "0.149.1" },
    },
  ];

  it("carries no credential-shaped member on any provider-account refusal envelope", () => {
    for (const envelope of PROVIDER_ACCOUNT_REFUSAL_ENVELOPES) {
      expect(
        credentialShapedKeysDeep(envelope.fields),
        `\`${envelope.type}\` carries a credential-shaped member`,
      ).toEqual([]);
    }
  });

  it("never echoes the supplied token value back through the error channel", () => {
    for (const envelope of PROVIDER_ACCOUNT_REFUSAL_ENVELOPES) {
      for (const value of stringValuesDeep(envelope.fields)) {
        expect(
          value.includes(TOKEN_FIXTURE),
          `\`${envelope.type}\` echoes the supplied token value`,
        ).toBe(false);
      }
    }
  });

  it("catches a forced error that carries the token, by name and by value", () => {
    // Without this, both counts above would be equally consistent with walkers
    // that never descended and a fixture set that never contained a token.
    //
    // Case 1: the accident — the whole request spread into `fields`, so the
    // member sits one level down under its own name.
    const spreadRequest: JsonRpcErrorData = {
      type: "provideraccount.token_class_refused",
      fields: {
        provider: "claude",
        request: { accountId: ACCOUNT_ID, nonInteractiveToken: TOKEN_FIXTURE },
      },
    };
    expect(credentialShapedKeysDeep(spreadRequest.fields)).toEqual(["nonInteractiveToken"]);

    // Case 2: the accident NAME-based detection cannot catch — the refusal
    // quoting what it refused, under a member whose name is innocent. This is
    // exactly what the `token_class_refused` row forbids, and only the value
    // scan sees it.
    const quotedValue: JsonRpcErrorData = {
      type: "provideraccount.token_class_refused",
      fields: { provider: "claude", supplied: [`rejected: ${TOKEN_FIXTURE}`] },
    };
    expect(credentialShapedKeysDeep(quotedValue.fields)).toEqual([]);
    expect(
      stringValuesDeep(quotedValue.fields).some((value) => value.includes(TOKEN_FIXTURE)),
    ).toBe(true);

    // And the value scan does not fire on an envelope that merely mentions the
    // member name in prose, which is legitimate: naming the input is not
    // echoing it.
    const namesTheMember: JsonRpcErrorData = {
      type: "provideraccount.token_class_refused",
      fields: { provider: "claude", failedCondition: "nonInteractiveToken must be vendor-minted" },
    };
    expect(
      stringValuesDeep(namesTheMember.fields).some((value) => value.includes(TOKEN_FIXTURE)),
    ).toBe(false);
  });

  it("covers every provider-account refusal code exactly once", () => {
    const codes = PROVIDER_ACCOUNT_REFUSAL_ENVELOPES.map((envelope) => envelope.type);
    // Transcribed from `error-contracts.md` §"Provider Account". The count is
    // asserted so a row added there and mirrored here cannot be half-done, and
    // uniqueness so a copy-paste cannot make the coverage look wider than it is.
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toHaveLength(12);
    for (const code of codes) {
      expect(code.startsWith("provideraccount."), `\`${code}\` is not on this plane`).toBe(true);
    }
    // The one member this plane may never put in an envelope, checked against
    // the same marking the wire census uses rather than a second literal.
    for (const redactedMember of PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS) {
      for (const envelope of PROVIDER_ACCOUNT_REFUSAL_ENVELOPES) {
        expect(
          Object.keys(envelope.fields ?? {}),
          `\`${envelope.type}\` carries the write-only member \`${redactedMember}\``,
        ).not.toContain(redactedMember);
      }
    }
  });
});
