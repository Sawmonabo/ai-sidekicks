// The account picker names one account's state and the one remedy that applies to it, in the
// Providers page's words. A remedy for another way back would send a person down a path that
// cannot work for that account.

import type { ProviderReadiness } from "@ai-sidekicks/contracts/provider/account/record";
import { describe, expect, it } from "vitest";

import { ACCOUNT_PLANE_REMEDY_SENTENCES } from "#renderer/lib/provider-accounts/sentences.js";
import { accountAdvisoriesFor } from "./advisories.js";
import type { AccountChoice } from "./axis.js";
import { OBSERVED_AT, registryAccountId } from "./reading.test-support.js";

const ACCOUNT_ID = registryAccountId("acct-team");

/** The default account, resolved by a readiness entry in the given state with its remedy. */
function resolvedChoice(
  state: ProviderReadiness["state"],
  remedy: ProviderReadiness["remedy"],
): AccountChoice {
  return {
    accountId: ACCOUNT_ID,
    label: "sam@example.com · Team",
    isProviderDefault: true,
    healthState: "indeterminate",
    healthObservedAt: OBSERVED_AT,
    readiness: {
      provider: "claude",
      state,
      resolvedAccountId: ACCOUNT_ID,
      observedAt: OBSERVED_AT,
      remedy,
    },
  };
}

describe("the account picker's advisories", () => {
  it("names the token remedy on an expired token account, and never the sign-in", () => {
    const advisories = accountAdvisoriesFor(
      resolvedChoice("reauth_required", { kind: "paste_token", accountId: ACCOUNT_ID }),
      "en-US",
    );
    expect(advisories).toContain("Login expired · Sign in again");
    expect(advisories).toContain(ACCOUNT_PLANE_REMEDY_SENTENCES.paste_token("claude"));
    expect(advisories).not.toContain(ACCOUNT_PLANE_REMEDY_SENTENCES.sign_in("claude"));
    expect(advisories.join(" ")).not.toContain("reauth_required");
  });

  it("words a sign-in into an empty folder apart from renewing a login", () => {
    const emptyFolder = accountAdvisoriesFor(
      resolvedChoice("home_missing", { kind: "sign_in", accountId: ACCOUNT_ID }),
      "en-US",
    );
    expect(emptyFolder).toContain(ACCOUNT_PLANE_REMEDY_SENTENCES.sign_in_to_empty_folder("claude"));
    expect(emptyFolder).not.toContain(ACCOUNT_PLANE_REMEDY_SENTENCES.sign_in("claude"));

    const expired = accountAdvisoriesFor(
      resolvedChoice("reauth_required", { kind: "sign_in", accountId: ACCOUNT_ID }),
      "en-US",
    );
    expect(expired).toContain(ACCOUNT_PLANE_REMEDY_SENTENCES.sign_in("claude"));
  });

  it("never collapses an undecided reading into an expired login", () => {
    const advisories = accountAdvisoriesFor(
      resolvedChoice("indeterminate", { kind: "look_again", accountId: ACCOUNT_ID }),
      "en-US",
    );
    expect(advisories).toContain("Cannot tell right now");
    expect(advisories).toContain(ACCOUNT_PLANE_REMEDY_SENTENCES.look_again("claude"));
    expect(advisories).not.toContain("Login expired · Sign in again");
  });
});
