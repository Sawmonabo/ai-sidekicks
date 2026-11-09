// The account picker names one account's state and the one remedy that applies to it, in the
// Providers page's words. A remedy for another way back would send a person down a path that
// cannot work for that account.

import type {
  ProviderReadiness,
  ProviderRemedy,
} from "@ai-sidekicks/contracts/provider/account/record";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import { describe, expect, it } from "vitest";

import { ACCOUNT_PLANE_REMEDY_SENTENCES } from "#renderer/lib/provider-accounts/sentences.js";
import { joinFigureSentence } from "#renderer/lib/figure-sentence.js";
import { accountAdvisoriesFor } from "./advisories.js";
import type { AccountChoice } from "./axis.js";
import { OBSERVED_AT, registryAccountId } from "./reading.test-support.js";

const ACCOUNT_ID = registryAccountId("acct-team");

/** The default account, resolved by a readiness entry in the given state with its remedy. */
function resolvedChoice(
  state: Exclude<ProviderReadiness["state"], "authenticated">,
  remedy: ProviderRemedy,
): AccountChoice {
  return {
    accountId: ACCOUNT_ID,
    providerName: "Claude Code",
    label: "sam@example.com · Team",
    isProviderDefault: true,
    healthState: "indeterminate",
    healthObservedAt: OBSERVED_AT,
    // Each case pairs a state with a remedy its arm takes.
    readiness: {
      provider: "claude" as ProviderId,
      state,
      resolvedAccountId: ACCOUNT_ID,
      observedAt: OBSERVED_AT,
      remedy,
    } as ProviderReadiness,
  };
}

/** The advisories as the words they read. */
function advisoryWords(...args: Parameters<typeof accountAdvisoriesFor>): string[] {
  return accountAdvisoriesFor(...args).map(joinFigureSentence);
}

describe("the account picker's advisories", () => {
  it("names the token remedy on an expired token account, and never the sign-in", () => {
    const advisories = advisoryWords(
      resolvedChoice("reauthRequired", { kind: "pasteToken", accountId: ACCOUNT_ID }),
      "en-US",
    );
    expect(advisories).toContain("Login expired · Sign in again");
    expect(advisories).toContain(ACCOUNT_PLANE_REMEDY_SENTENCES.pasteToken("Claude Code"));
    expect(advisories).not.toContain(ACCOUNT_PLANE_REMEDY_SENTENCES.signIn("Claude Code"));
    expect(advisories.join(" ")).not.toContain("reauthRequired");
  });

  it("words a sign-in into an empty folder apart from renewing a login", () => {
    const emptyFolder = advisoryWords(
      resolvedChoice("homeMissing", { kind: "signIn", accountId: ACCOUNT_ID }),
      "en-US",
    );
    expect(emptyFolder).toContain(
      ACCOUNT_PLANE_REMEDY_SENTENCES.signInToEmptyFolder("Claude Code"),
    );
    expect(emptyFolder).not.toContain(ACCOUNT_PLANE_REMEDY_SENTENCES.signIn("Claude Code"));

    const expired = advisoryWords(
      resolvedChoice("reauthRequired", { kind: "signIn", accountId: ACCOUNT_ID }),
      "en-US",
    );
    expect(expired).toContain(ACCOUNT_PLANE_REMEDY_SENTENCES.signIn("Claude Code"));
  });

  it("never collapses an undecided reading into an expired login", () => {
    const advisories = advisoryWords(
      resolvedChoice("indeterminate", { kind: "lookAgain", accountId: ACCOUNT_ID }),
      "en-US",
    );
    expect(advisories).toContain("Cannot tell right now");
    expect(advisories).toContain(ACCOUNT_PLANE_REMEDY_SENTENCES.lookAgain("Claude Code"));
    expect(advisories).not.toContain("Login expired · Sign in again");
  });
});
