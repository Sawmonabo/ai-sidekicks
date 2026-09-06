// What the three account-plane calls answer with, and what they never answer with.
//
// EVERY CASE DRIVES THE REAL FUNCTIONS through a bridge whose growth port answers.
// The refusal arms take the shipped port's own builder, so a case asserting on a
// refusal is asserting on the code and sentence a release build produces rather than
// on an envelope written here.

import { describe, expect, it, vi } from "vitest";

import type {
  ProviderAccountId,
  ProviderAccountLoginCancelResponse,
  ProviderAccountLoginResponse,
  ProviderAccountRegisterResponse,
} from "@ai-sidekicks/contracts";

import {
  createFixtureBridge,
  growthUnavailable,
  type ConsoleBridge,
  type GrowthOutcome,
} from "../../../../bridge/index.js";
import {
  cancelSignIn,
  startSignIn,
  submitTokenRegistration,
  type SignInFlowState,
} from "./signin-flow.js";

const ACCOUNT_ID = "pa-0001" as ProviderAccountId;

const ATTEMPT: ProviderAccountLoginResponse = {
  attemptId: "attempt-1",
  verificationUri: "https://provider.example.test/device",
  userCode: "WXYZ-1234",
  expiresAt: "2026-01-01T08:15:00.000Z",
};

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
  },
};

/** A scenario that scripts nothing: each case overrides the operation it drives. */
const EMPTY_SCENARIO: Parameters<typeof createFixtureBridge>[0]["scenario"] = {
  id: "collaboration-accounts-test",
  label: "Accounts, with nothing scripted",
  purpose: "Drives the account-plane calls against overridden growth operations.",
  sessionId: "session-accounts",
  participantIdsInJoinOrder: [],
  beats: [],
  replies: [],
  startedAtIso: "2026-01-01T08:00:00.000Z",
};

/** The fixture bridge with the three account verbs answering what a case asked for. */
function bridgeAnswering(script: {
  readonly login?: GrowthOutcome<ProviderAccountLoginResponse>;
  readonly cancel?: GrowthOutcome<ProviderAccountLoginCancelResponse>;
  readonly register?: GrowthOutcome<ProviderAccountRegisterResponse>;
}): ConsoleBridge {
  const fixture = createFixtureBridge({ scenario: EMPTY_SCENARIO });
  return {
    ...fixture,
    growth: {
      ...fixture.growth,
      providerAccountLogin: vi.fn(
        async () =>
          await Promise.resolve(script.login ?? growthUnavailable("providerAccountLogin")),
      ),
      providerAccountLoginCancel: vi.fn(
        async () =>
          await Promise.resolve(script.cancel ?? growthUnavailable("providerAccountLoginCancel")),
      ),
      providerAccountRegister: vi.fn(
        async () =>
          await Promise.resolve(script.register ?? growthUnavailable("providerAccountRegister")),
      ),
    },
  };
}

/** The sentence one settled flow state carries, or the empty string where it has none. */
function endedBecause(state: SignInFlowState): string {
  return state.kind === "ended" ? state.because : "";
}

describe("startSignIn", () => {
  it("answers a live flow carrying the provider's own attempt", async () => {
    const state = await startSignIn(
      bridgeAnswering({ login: { status: "served", value: ATTEMPT } }),
      ACCOUNT_ID,
    );
    expect(state).toEqual({ kind: "live", attempt: ATTEMPT });
  });

  it("answers a refusal rather than throwing", async () => {
    const state = await startSignIn(bridgeAnswering({}), ACCOUNT_ID);
    expect(state.kind).toBe("refused");
  });

  // The negative control for the case above: the refusal is a STATE and not a
  // rejection, so a caller that only awaits it never sees an unhandled promise.
  it("never rejects on the refusal arm", async () => {
    await expect(startSignIn(bridgeAnswering({}), ACCOUNT_ID)).resolves.toBeDefined();
  });
});

describe("cancelSignIn", () => {
  it("says the sign-in was cancelled when the daemon cancelled one", async () => {
    const state = await cancelSignIn(
      bridgeAnswering({ cancel: { status: "served", value: { status: "cancelled" } } }),
      ATTEMPT,
    );
    expect(endedBecause(state)).toContain("was cancelled");
  });

  it("says there was nothing to cancel when the daemon found none", async () => {
    const state = await cancelSignIn(
      bridgeAnswering({ cancel: { status: "served", value: { status: "notFound" } } }),
      ATTEMPT,
    );
    expect(endedBecause(state)).toContain("no sign-in left to cancel");
  });

  // The two statuses are kept apart, which is the whole point of the arm: reporting
  // a `notFound` as a cancellation would tell an operator the console stopped
  // something it did not.
  it("does not report a notFound as a cancellation", async () => {
    const state = await cancelSignIn(
      bridgeAnswering({ cancel: { status: "served", value: { status: "notFound" } } }),
      ATTEMPT,
    );
    expect(endedBecause(state)).not.toContain("was cancelled");
  });

  it("never claims the account is authenticated", async () => {
    const state = await cancelSignIn(
      bridgeAnswering({ cancel: { status: "served", value: { status: "cancelled" } } }),
      ATTEMPT,
    );
    expect(endedBecause(state)).not.toMatch(/authenticated/iu);
  });
});

describe("submitTokenRegistration", () => {
  it("answers with the account the daemon created", async () => {
    const outcome = await submitTokenRegistration(
      bridgeAnswering({ register: { status: "served", value: REGISTERED } }),
      {
        provider: "codex",
        displayLabel: "Metered",
        billingMode: "metered",
        nonInteractiveToken: "a-vendor-minted-token",
      },
    );
    expect(outcome).toEqual({ kind: "registered", account: REGISTERED.account });
  });

  // The reply carries no token member at all, so there is nothing for the settled arm
  // to echo even if a surface tried. Asserted over the whole serialized outcome
  // because that is the shape a devtools inspection would read.
  it("carries no token anywhere in the outcome it answers with", async () => {
    const outcome = await submitTokenRegistration(
      bridgeAnswering({ register: { status: "served", value: REGISTERED } }),
      {
        provider: "codex",
        displayLabel: "Metered",
        billingMode: "metered",
        nonInteractiveToken: "a-vendor-minted-token",
      },
    );
    expect(JSON.stringify(outcome)).not.toContain("a-vendor-minted-token");
  });

  it("answers a refusal rather than throwing", async () => {
    const outcome = await submitTokenRegistration(bridgeAnswering({}), {
      provider: "codex",
      displayLabel: "Metered",
      billingMode: "metered",
    });
    expect(outcome.kind).toBe("refused");
  });
});
