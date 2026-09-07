// The post-refusal trigger fires on the five account-plane codes and on nothing else.
//
// FAIL-CLOSED IN THE DIRECTION THAT MATTERS. A walkthrough opened over a failure it
// has no remedy for is worse than no walkthrough, so an unrecognised code raises
// nothing at all. The five it does fire on are exactly the codes a provider run can
// meet at admission — the ones whose remedy IS this step.

import { describe, expect, it } from "vitest";

import {
  ACCOUNT_PLANE_RUN_REFUSAL_CODES,
  activationForRunRefusal,
  onboardingActivation,
} from "./onboarding-activation.js";

/** A refusal shaped the way the console's one refusal shape is shaped. */
function refusalWith(code: string): { code: string; detail: string; origin: string } {
  return { code, detail: "The run was refused.", origin: "daemon" };
}

describe("which refusals offer the provider step", () => {
  it("offers it on every account-plane run refusal, at the providers step", () => {
    expect(ACCOUNT_PLANE_RUN_REFUSAL_CODES.length).toBe(5);
    for (const code of ACCOUNT_PLANE_RUN_REFUSAL_CODES) {
      expect(activationForRunRefusal(refusalWith(code), undefined)).toStrictEqual({
        openAtStep: "providers",
        accountScope: undefined,
      });
    }
  });

  it.each([
    "provideraccount.permission_denied",
    "provideraccount.default_conflict",
    "provideraccount.credential_seal_refused",
    "session.not_found",
    "",
  ])("raises nothing for %s, whose remedy is elsewhere", (code) => {
    expect(activationForRunRefusal(refusalWith(code), undefined)).toBeUndefined();
  });
});

describe("the account the step is scoped to", () => {
  it("carries an account the wire admits, so the remedy names the account that failed", () => {
    const activation = activationForRunRefusal(
      refusalWith("provideraccount.not_authenticated"),
      "019b78c9-0a80-7c31-8110-cca0117a3302",
    );
    expect(activation?.accountScope).toBe("019b78c9-0a80-7c31-8110-cca0117a3302");
  });

  it("falls back to an unscoped read rather than refusing when the id does not read", () => {
    // The step is still worth opening; it just describes the provider's default
    // account. Refusing the activation would leave a refused run with no remedy at
    // all, which is strictly worse than a remedy about the wrong account.
    const activation = activationForRunRefusal(refusalWith("provideraccount.unknown"), "");
    expect(activation).toStrictEqual({ openAtStep: "providers", accountScope: undefined });
  });
});

describe("the activation signal", () => {
  it("delivers to a subscriber and stops on unsubscribe", () => {
    const seen: string[] = [];
    const stop = onboardingActivation.subscribe((activation) => {
      seen.push(activation.openAtStep);
    });
    onboardingActivation.request({ openAtStep: "providers", accountScope: undefined });
    stop();
    onboardingActivation.request({ openAtStep: "relay", accountScope: undefined });
    expect(seen).toStrictEqual(["providers"]);
  });
});
