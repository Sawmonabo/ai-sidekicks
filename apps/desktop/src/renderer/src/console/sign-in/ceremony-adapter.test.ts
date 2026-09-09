// The one module that names the `webAuthn` bridge namespace, and what it refuses.
//
// TOTAL IN BOTH DIRECTIONS. A rejected call and a resolution this build cannot read
// both answer `unavailable` carrying a refusal, because a sign-in card whose promise
// rejects has nothing to render and a person looking at it learns nothing at all —
// and because reading an unrecognised value as success would sign somebody in on the
// strength of nothing.
//
// WHAT THIS FILE IS FOR is the adapter's own behaviour against a fixture bridge, and
// nothing in it reads source text. Which modules may name the `webAuthn` namespace,
// what they may hand it, and that nothing calls the PRF derivation are STRUCTURAL
// rules, whose home is a lint or layering config rather than a suite that reads the
// tree.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenario/onboarding.js";
import { SignInCeremony } from "./ceremony-adapter.js";
import { FIRST_RUN_SCENARIO } from "../bridge/scenario/first-run.js";

describe("the adapter's answers", () => {
  it("reads the host the running scenario states", async () => {
    const ceremony = new SignInCeremony(createFixtureBridge({ scenario: ONBOARDING_SCENARIO }));
    expect(await ceremony.signIn()).toStrictEqual({
      kind: "fallback-required",
      probeResult: "no-prf",
      handoff: { verificationUri: "http://127.0.0.1:8419/callback", userCode: "JQPD-4KTM" },
    });
  });

  it("answers unavailable — never authenticated — where no host was stated", async () => {
    // The scenario states no ceremony, so the fixture refuses by name. Reading that
    // as a signed-in session is the failure this case exists to make impossible.
    const ceremony = new SignInCeremony(createFixtureBridge({ scenario: FIRST_RUN_SCENARIO }));
    const outcome = await ceremony.signIn();
    expect(outcome.kind).toBe("unavailable");
  });

  it("answers unavailable for a resolution shaped like nothing this build reads", async () => {
    const fixture = createFixtureBridge({ scenario: ONBOARDING_SCENARIO });
    const strange: ConsoleBridge = {
      ...fixture,
      sidekicks: {
        ...fixture.sidekicks,
        webAuthn: {
          ...fixture.sidekicks.webAuthn,
          getAssertion: async () => ({ signedIn: true }),
        },
      },
    };
    const outcome = await new SignInCeremony(strange).signIn();
    expect(outcome).toStrictEqual({
      kind: "unavailable",
      refusal: {
        origin: "sign-in",
        code: "ceremony-unreadable",
        detail:
          "The ceremony answered something this build cannot read as an outcome, so nothing was read from it.",
      },
    });
  });

  it("answers unavailable for a call that rejected, carrying what it was told", async () => {
    const fixture = createFixtureBridge({ scenario: ONBOARDING_SCENARIO });
    const throwing: ConsoleBridge = {
      ...fixture,
      sidekicks: {
        ...fixture.sidekicks,
        webAuthn: {
          ...fixture.sidekicks.webAuthn,
          getAssertion: () => Promise.reject(new Error("the platform binding did not load")),
        },
      },
    };
    const outcome = await new SignInCeremony(throwing).signIn();
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") {
      return;
    }
    expect(outcome.refusal.detail).toContain("the platform binding did not load");
  });
});
