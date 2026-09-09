// The one module that names the `webAuthn` bridge namespace, and what it refuses.
//
// TOTAL IN BOTH DIRECTIONS. A rejected call and a resolution this build cannot read
// both answer `unavailable` carrying a refusal, because a sign-in card whose promise
// rejects has nothing to render and a person looking at it learns nothing at all —
// and because reading an unrecognised value as success would sign somebody in on the
// strength of nothing.
//
// THE TREE-WIDE HALF OF THIS CLAIM LIVES IN THE ARCHITECTURE TIER, at
// `test/console/architecture/ceremony-adapter-sites.test.ts`: which modules may name
// the namespace, what they may hand it, and that nothing calls the PRF derivation. It
// was written here, reading the console through a raw `import.meta.glob` over
// `../**/*.{ts,tsx}` — and a directory glob in a suite is a set of dependency EDGES
// rather than a read, so that one file made the whole console reachable and the
// dead-code gate stopped reporting orphans anywhere under it. A source-text claim
// belongs where the shared walk and the shared parse are; what stays here is what this
// file is for, which is the adapter's own behaviour against a fixture bridge.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenarios/onboarding.js";
import { SignInCeremony } from "./ceremony-adapter.js";
import { FIRST_RUN_SCENARIO } from "../bridge/scenarios/first-run.js";

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
