// What every surface names an account by: the identity its provider reported, the plan in the
// provider's own word, or for a pasted token or API key the name the person gave it beside the
// credential's kind. One email can hold two accounts, so the plan and organization are part of it.
// An account still signing in that its provider has not named has no label.
import { describe, expect, it } from "vitest";

import { accountLabel } from "../label.js";
import { ProviderAccountSchema } from "../record.js";
import { validProviderAccount } from "./record.test-support.js";

function labelOf(overrides: Record<string, unknown>): string | undefined {
  return accountLabel(ProviderAccountSchema.parse(validProviderAccount(overrides)));
}

describe("accountLabel", () => {
  it("names a signed-in account by its reported email, plan word and organization", () => {
    const signedIn = { observedAccountEmail: "sam@example.org" };
    expect(labelOf({ ...signedIn, observedAccountPlan: "max" })).toBe("sam@example.org · Max");
    expect(
      labelOf({
        ...signedIn,
        provider: "codex",
        observedAccountPlan: "team",
        observedAccountOrgName: "Example Inc",
      }),
    ).toBe("sam@example.org · Business · Example Inc");
    // Codex's `pro` is not Claude Code's: each provider's own word for its own plan.
    expect(labelOf({ ...signedIn, provider: "codex", observedAccountPlan: "pro" })).toBe(
      "sam@example.org · Pro (More)",
    );
    expect(labelOf({ ...signedIn, observedAccountPlan: "pro" })).toBe("sam@example.org · Pro");
    // A plan the table does not name reads as its own words, never through a code's screen words.
    expect(labelOf({ ...signedIn, provider: "codex", observedAccountPlan: "edu_max" })).toBe(
      "sam@example.org · Edu max",
    );
    expect(labelOf({ ...signedIn, observedAccountPlan: "agent" })).toBe("sam@example.org · Agent");
    expect(labelOf({ ...signedIn, observedAccountPlan: "unknown" })).toBe("sam@example.org");
  });

  it("gives no label to an account still signing in that its provider has not named yet", () => {
    expect(labelOf({ observedAccountPlan: "unknown" })).toBeUndefined();
    expect(labelOf({})).toBeUndefined();
  });

  it("names a pasted token or API-key account by its typed name and credential kind", () => {
    expect(labelOf({ provider: "codex", displayLabel: "Work", observedAuthMode: "api_key" })).toBe(
      "Work · Codex API key",
    );
    expect(labelOf({ displayLabel: "Personal", observedAuthMode: "oauth_token" })).toBe(
      "Personal · Claude Code token",
    );
  });
});
