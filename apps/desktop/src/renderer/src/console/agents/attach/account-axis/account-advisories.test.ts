// What the account axis is allowed to SAY about an account, over one registry reading.
//
// WHICH ACCOUNT a sentence speaks for is `account-axis.test.ts`'s question, beside the
// selection that answers it. What is asked here is the other half: whether the words
// are true of the weakest thing that could have produced the state they report, and
// whether the two facts a stored reading can hold — what was found, and when — stay
// distinguishable.
//
// The model is a pure function over a reading, which is why every case here builds an
// object rather than standing up a bridge.

import { PROVIDER_ACCOUNT_HEALTH_STATES, type ProviderAccount } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { formatDateTime } from "../../../primitives/index.js";

import { accountAdvisoriesFor, unresolvedDefaultAdvisoryIn } from "./account-advisories.js";
import { attachAccountAxisReadingFor, chosenAccountIn } from "./account-axis.js";
import {
  OBSERVED_AT,
  account,
  registryAccountId,
  resolvedTo,
  served,
} from "./account-reading.test-support.js";

describe("the account axis's advisories — what it says about one account", () => {
  it("names the act a remedy calls for and never the provider's own sign-in command", () => {
    const reading = attachAccountAxisReadingFor(
      served([account({ healthState: "reauth_required" })], [resolvedTo("acct-team")]),
      "claude",
    );
    const chosen = chosenAccountIn(reading, "acct-team");
    const advisories = chosen === undefined ? [] : accountAdvisoriesFor(chosen);

    expect(advisories).toHaveLength(3);
    expect(advisories.join(" ")).not.toContain("claude login");
    expect(advisories.join(" ")).not.toContain("/homes/acct-team");
  });

  it("says what was stored even where no readiness entry resolved to the account", () => {
    const reading = attachAccountAxisReadingFor(
      served([account({ healthState: "indeterminate", healthObservedAt: null })]),
      "claude",
    );
    const chosen = chosenAccountIn(reading, "acct-team");

    expect(chosen === undefined ? [] : accountAdvisoriesFor(chosen)).toEqual([
      "This account has never been observed.",
    ]);
  });
});

describe("the account axis's advisories — what the stored reading is allowed to claim", () => {
  /** The stored-health sentence for one account, which is always the first line. */
  function storedReadingFor(
    overrides: Partial<ProviderAccount> = {},
    locale?: string,
  ): string | undefined {
    const reading = attachAccountAxisReadingFor(served([account(overrides)]), "claude");
    const chosen = chosenAccountIn(reading, "acct-team");
    return chosen === undefined ? undefined : accountAdvisoriesFor(chosen, locale)[0];
  }

  it("claims credential presence and local health, never that the provider is accepting it", () => {
    // The defect this case exists for: four things write this state and the weakest of
    // them — the background observer — reads LOCAL credential state and never asks the
    // provider anything, so a server-revoked credential sits in this arm untouched. A
    // sentence saying the account was "found signed in" reports that observer's reading
    // as a confirmation nobody obtained.
    const stored = storedReadingFor({ healthState: "authenticated" }) ?? "";

    expect(stored).toContain("found a credential in this account's home");
    expect(stored).toContain("nothing local reporting it dead");
    expect(stored).toContain("decided when a run starts");
    expect(stored).not.toContain("signed in.");
  });

  it("names what a reauth-required account needs rather than who asked for it", () => {
    // A terminal authentication refusal on a token-mode account lands in this arm and
    // the provider asked for nothing there — the remedy is a token minted at the
    // provider and re-supplied, so wording it as a request the provider made would be
    // false of one of its producers.
    const stored = storedReadingFor({ healthState: "reauth_required" }) ?? "";

    expect(stored).toContain("needing a fresh sign-in");
    expect(stored).not.toContain("The provider asked");
  });

  it("says when the observation was taken, in every arm that has one", () => {
    const instant = formatDateTime(OBSERVED_AT);

    for (const healthState of PROVIDER_ACCOUNT_HEALTH_STATES) {
      expect(storedReadingFor({ healthState, healthObservedAt: OBSERVED_AT }) ?? "").toContain(
        instant,
      );
    }
  });

  it("tells a never-observed account apart from one an observation could not decide", () => {
    // The two facts the timestamp exists to separate: both project `indeterminate`, so
    // a sentence keyed on the state alone reports "we looked and could not tell" over
    // an account nothing has ever looked at.
    const neverObserved = storedReadingFor({
      healthState: "indeterminate",
      healthObservedAt: null,
    });
    const undecided = storedReadingFor({
      healthState: "indeterminate",
      healthObservedAt: OBSERVED_AT,
    });

    expect(neverObserved).toBe("This account has never been observed.");
    expect(undecided).toContain("did not decide about this account");
    expect(undecided).not.toBe(neverObserved);
  });

  it("renders the instant through the console's one date formatter and no second one", () => {
    // Asserted against the chokepoint's own output rather than against a spelling this
    // file writes out: a second `Intl.DateTimeFormat` here would agree with the field
    // today and drift from it the moment the chokepoint's field list moves.
    const britishInstant = formatDateTime(OBSERVED_AT, "en-GB");
    const germanInstant = formatDateTime(OBSERVED_AT, "de-DE");

    // The two readings differ, so a `locale` this model accepted and then dropped could
    // not pass both of the assertions below.
    expect(germanInstant).not.toBe(britishInstant);
    expect(storedReadingFor({}, "en-GB") ?? "").toContain(britishInstant);
    expect(storedReadingFor({}, "de-DE") ?? "").toContain(germanInstant);
  });

  it("costs the sentence its reading and never the field when the stamp is unreadable", () => {
    // `healthObservedAt` is parsed at the bridge door, so this is the belt: the
    // formatter answers an em dash for a stamp it cannot read, and the advisory still
    // says which state was stored.
    const readAdvisory = (): string | undefined =>
      storedReadingFor({ healthObservedAt: "the day before yesterday" });

    expect(readAdvisory).not.toThrow();
    expect(readAdvisory() ?? "").toContain("—");
    expect(readAdvisory() ?? "").toContain("found a credential in this account's home");
  });
});

describe("the account axis's advisories — where resolution reached no account", () => {
  /** A served `claude` reading whose entry resolved nothing and asks for a default. */
  function withNoDefault(): ReturnType<typeof attachAccountAxisReadingFor> {
    return attachAccountAxisReadingFor(
      served(
        [
          account({ accountId: registryAccountId("acct-team"), isDefault: false }),
          account({ accountId: registryAccountId("acct-personal"), isDefault: false }),
        ],
        [
          {
            provider: "claude",
            state: "no_default",
            remedy: {
              kind: "choose_default",
              candidateAccountIds: [
                registryAccountId("acct-team"),
                registryAccountId("acct-personal"),
              ],
            },
          },
        ],
      ),
      "claude",
    );
  }

  it("names the remedy where an unpinned attach asks for a default that does not exist", () => {
    // The state that rendered NOTHING before this rule: there is no resolved row whose
    // readings could carry the remedy, so the form went on asking for a default the
    // daemon would refuse and the refusal was the first thing that said so.
    expect(unresolvedDefaultAdvisoryIn(withNoDefault(), undefined)).toBe(
      "Accounts are registered for this provider and none of them is the default.",
    );
  });

  it("takes the wording from the one remedy vocabulary and composes no second sentence", () => {
    // Both readers reach the same table — the per-account list where an entry resolved
    // a row, and this rule where it resolved none — so which sentence a person meets
    // never depends on whether an account happened to resolve.
    const resolvedReading = attachAccountAxisReadingFor(
      served([account({ healthState: "reauth_required" })], [resolvedTo("acct-team")]),
      "claude",
    );
    const chosen = chosenAccountIn(resolvedReading, "acct-team");
    const registerReading = attachAccountAxisReadingFor(
      served(
        [],
        [
          {
            provider: "claude",
            state: "no_account",
            remedy: { kind: "register", provider: "claude" },
          },
        ],
      ),
      "claude",
    );

    expect(chosen === undefined ? [] : accountAdvisoriesFor(chosen)).toContain(
      "Signing this account in again is what run admission is waiting for.",
    );
    expect(unresolvedDefaultAdvisoryIn(registerReading, undefined)).toBe(
      "No account is registered for this provider.",
    );
  });

  it("negative control: says nothing where the entry did resolve an account", () => {
    // Without this the rule would speak over every reading, and the remedy would
    // render twice — once on the resolved row's own list and once beside it.
    const resolvedReading = attachAccountAxisReadingFor(
      served([account()], [resolvedTo("acct-team")]),
      "claude",
    );

    expect(unresolvedDefaultAdvisoryIn(resolvedReading, undefined)).toBeUndefined();
  });

  it("negative control: says nothing where the form pins an account", () => {
    // A pinned axis is not asking for a default, so the default's condition is not
    // this field's subject and saying it beside a pinned account's readings would
    // invite exactly the confusion the leading sentence exists to prevent.
    expect(unresolvedDefaultAdvisoryIn(withNoDefault(), "acct-team")).toBeUndefined();
  });

  it("negative control: says nothing where the read carried no entry for this provider", () => {
    // An absent entry and an entry that resolved no account are different facts, and
    // only the second is a default that does not exist.
    const noEntry = attachAccountAxisReadingFor(served([account()]), "claude");

    expect(unresolvedDefaultAdvisoryIn(noEntry, undefined)).toBeUndefined();
  });
});
