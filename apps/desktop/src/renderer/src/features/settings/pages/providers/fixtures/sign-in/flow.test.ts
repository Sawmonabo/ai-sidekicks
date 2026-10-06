// What the three account-plane calls answer with, and what they never answer with.

import { describe, expect, it } from "vitest";

import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import {
  PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE,
  type ProviderAccountRegisterResponse,
} from "@ai-sidekicks/contracts/provider/account/sign-in";

import type { Refusal } from "#renderer/lib/refusal/contract.js";

import {
  accountPlaneCalls,
  PROVIDER_SIGN_IN_ATTEMPT,
} from "../account-plane-bridge.test-support.js";
import {
  readRegistrationFields,
  startProviderSignIn,
  submitTokenRegistration,
  TOKEN_REGISTRATION_REFUSAL_ORIGIN,
  type RegistrationFieldReading,
} from "./flow.js";

const ACCOUNT_ID = "pa-0001" as ProviderAccountId;

const REGISTERED: ProviderAccountRegisterResponse = {
  account: {
    accountId: "pa-0003" as ProviderAccountId,
    provider: "codex",
    displayLabel: "Metered",
    credentialGeneration: 1,
    billingMode: "metered",
    isDefault: false,
    healthState: "indeterminate",
    healthObservedAt: null,
    observedAuthMode: null,
    loggedInAt: null,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
    lastRefreshObservedAt: null,
    windowStartEnabled: true,
    wakeForWindowStartEnabled: false,
    memoryImport: null,
  },
};

describe("startProviderSignIn", () => {
  it("answers a live flow carrying the attempt and the account it is for", async () => {
    const state = await startProviderSignIn(
      accountPlaneCalls({ login: PROVIDER_SIGN_IN_ATTEMPT }).login,
      ACCOUNT_ID,
    );
    // The account rides the outcome so the one-at-a-time rule can say which account is
    // running when it disables the other rows.
    expect(state).toEqual({
      kind: "live",
      accountId: ACCOUNT_ID,
      attempt: PROVIDER_SIGN_IN_ATTEMPT,
    });
  });
});

describe("submitTokenRegistration", () => {
  const REQUEST = {
    provider: "codex",
    displayLabel: "Metered",
    billingMode: "metered",
    nonInteractiveToken: "a-vendor-minted-token",
  } as const;

  // The reply has no token member, so nothing can echo one; asserted over the serialized
  // outcome because that is what a devtools inspection would read.
  it("answers with the account the daemon created, carrying no token anywhere", async () => {
    const outcome = await submitTokenRegistration(
      accountPlaneCalls({ register: REGISTERED }).register,
      REQUEST,
    );
    expect(outcome).toEqual({ kind: "registered", account: REGISTERED.account });
    expect(JSON.stringify(outcome)).not.toContain("a-vendor-minted-token");
  });
});

describe("readRegistrationFields", () => {
  /** The ordinary fields, as the form hands them over. */
  function typed(displayLabel: string): Parameters<typeof readRegistrationFields>[0] {
    return { displayLabel, provider: "codex" };
  }

  /** The refusal one reading carries, or `undefined` where it admitted the fields. */
  function refusalOf(reading: RegistrationFieldReading): Refusal | undefined {
    return reading.kind === "refused" ? reading.refusal : undefined;
  }

  it("admits a trimmed name that only another provider's account carries", () => {
    const claudeAccount = { ...REGISTERED.account, provider: "claude" } as const;
    expect(
      readRegistrationFields(typed("  Metered  "), [claudeAccount]),
    ).toStrictEqual<RegistrationFieldReading>({
      kind: "admitted",
      fields: { provider: "codex", displayLabel: "Metered", billingMode: "unknown" },
    });
  });

  it("refuses a blank name and a name that provider's other account has", () => {
    // `required` accepts any non-empty value, so this blank passes the markup and the
    // reading has to catch it.
    const blank = refusalOf(readRegistrationFields(typed("   "), []));
    expect(blank?.code).toBe("registration-label-blank");
    expect(blank?.origin).toBe(TOKEN_REGISTRATION_REFUSAL_ORIGIN);
    expect(blank?.detail).toBe("Name this account.");
    // Compared without case or surrounding spaces, so two rows can never read alike.
    const taken = refusalOf(readRegistrationFields(typed(" metered "), [REGISTERED.account]));
    expect(taken?.code).toBe(PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE);
    expect(taken?.detail).toBe("Another Codex account already has this name.");
    // Folded beyond ASCII, as the service's table folds it, so the two never disagree; a plain
    // lowering would let `STRASSE` beside `Straße`.
    for (const [registered, typedName] of [
      ["Ärzte", "ärzte "],
      ["Straße", "STRASSE"],
    ] as const) {
      const folded = refusalOf(
        readRegistrationFields(typed(typedName), [
          { ...REGISTERED.account, displayLabel: registered },
        ]),
      );
      expect(folded?.code).toBe(PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE);
    }
  });
});
