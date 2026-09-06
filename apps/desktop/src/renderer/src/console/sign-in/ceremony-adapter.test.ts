// The one module that names the `webAuthn` bridge namespace, and what it refuses.
//
// TOTAL IN BOTH DIRECTIONS. A rejected call and a resolution this build cannot read
// both answer `unavailable` carrying a refusal, because a sign-in card whose promise
// rejects has nothing to render and a person looking at it learns nothing at all —
// and because reading an unrecognised value as success would sign somebody in on the
// strength of nothing.
//
// AND THE FAMILY IS HELD TO ITS OWN RULE BY READING ITS SOURCE. `deriveKeyMaterial`
// is main's, by the credential flow's own step 5 and by I-023-16, which leaves this
// renderer with no salt to derive against. A call to it from here would be this
// console choosing a PRF input — the exact trust-boundary inversion the invariant was
// minted to close — so no file in this family may name it, and no file but the
// adapter may name the namespace at all.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenarios/onboarding.js";
import { SignInCeremony } from "./ceremony-adapter.js";
import { FIRST_RUN_SCENARIO } from "../bridge/scenarios/first-run.js";

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ) => Record<string, string>;
  }
}

// `node:fs` is banned in renderer programs, so the source arrives inlined at
// transform time through Vite's raw glob — the form `panes/panes.test.ts`
// established for the console's source-text reads.
const FAMILY_SOURCES = import.meta.glob("./*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Every source file this family SHIPS, as `[path, text]`. Suites are excluded. */
function familySources(): readonly { name: string; text: string }[] {
  return Object.entries(FAMILY_SOURCES)
    .filter(([name]) => !name.includes(".test."))
    .map(([name, text]) => ({ name, text }));
}

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

describe("what this family may never name", () => {
  it("names the bridge namespace in the adapter and nowhere else", () => {
    const shipped = familySources();
    // Vacuity guard: an empty glob would make both cases assert nothing at all.
    expect(shipped.length).toBeGreaterThan(4);
    const namers = shipped
      .filter((source) => source.text.includes("webAuthn."))
      .map((source) => source.name);
    expect(namers).toStrictEqual(["./ceremony-adapter.ts"]);
  });

  it("calls the PRF derivation from nowhere at all", () => {
    // The adapter's own header explains why it names the method and never calls it,
    // so the check is on the CALL rather than on the word.
    for (const source of familySources()) {
      expect(source.text, source.name).not.toContain("deriveKeyMaterial(");
    }
  });
});
