// The account axis over one registry reading: five answers, and only one is a list.
//
// The rule this suite exists for is that the four non-list answers are DIFFERENT
// answers. The axis it replaced was a free-text input, so every one of them rendered
// identically — as a blank field — and the case that matters is the one where a
// person types an account under the wrong driver and the form composes a request the
// daemon can only refuse after the attach has been submitted.
//
// The model is a pure function over a reading, which is why every case here builds an
// object rather than standing up a bridge: a state a live reading reaches only through
// a particular sequence of pushes is one literal here.

import {
  PROVIDER_ACCOUNT_HEALTH_STATES,
  type ProviderAccount,
  type ProviderAccountId,
  type ProviderReadiness,
} from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { refuse } from "../../../core/index.js";
import { formatDateTime } from "../../../primitives/index.js";

import {
  accountAdvisoriesFor,
  attachAccountAxisReadingFor,
  chosenAccountIn,
  registryCarriesAccount,
  type AttachAccountRegistryReading,
} from "./account-axis.js";

const OBSERVED_AT = "2026-09-01T10:00:00.000Z";

/**
 * One registry account id, branded the way the contract brands one.
 *
 * The cast is this tree's established shape for a branded wire id in a fixture
 * (`settings/pages/provider-accounts/shell/quota-rows.test.ts`): the brand exists to
 * stop a caller passing any string on the wire, and a test that parsed one through
 * the schema would be asserting the schema rather than the model under test.
 */
function registryAccountId(value: string): ProviderAccountId {
  return value as ProviderAccountId;
}

/** The origin every refusal in this suite is attributed to. */
const ACCOUNT_PLANE = "account-plane";

/** One registry row, in the registered shape and nothing narrower. */
function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    accountId: registryAccountId("acct-team"),
    provider: "claude",
    displayLabel: "Team",
    credentialGeneration: 1,
    billingMode: "subscription",
    isDefault: true,
    healthState: "authenticated",
    healthObservedAt: OBSERVED_AT,
    observedAuthMode: "oauth_subscription",
    loggedInAt: null,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
    ...overrides,
  };
}

/** A served registry reading over the accounts a case cares about. */
function served(
  accounts: readonly ProviderAccount[],
  readiness: readonly ProviderReadiness[] = [],
): AttachAccountRegistryReading {
  return { phase: "read", readRefusal: undefined, accounts, readiness };
}

describe("the attach form's account axis — which accounts it may offer", () => {
  it("offers only the accounts belonging to the chosen driver's provider", () => {
    const reading = attachAccountAxisReadingFor(
      served([
        account({ accountId: registryAccountId("acct-claude"), provider: "claude" }),
        account({
          accountId: registryAccountId("acct-codex"),
          provider: "codex",
          isDefault: false,
        }),
      ]),
      "claude",
    );

    expect(reading.kind).toBe("served");
    expect(reading.kind === "served" ? reading.choices.map((one) => one.accountId) : []).toEqual([
      "acct-claude",
    ]);
  });

  it("keeps the registry's own order rather than hoisting the default", () => {
    const reading = attachAccountAxisReadingFor(
      served([
        account({
          accountId: registryAccountId("acct-personal"),
          isDefault: false,
          displayLabel: "Personal",
        }),
        account({
          accountId: registryAccountId("acct-team"),
          isDefault: true,
          displayLabel: "Team",
        }),
      ]),
      "claude",
    );

    expect(reading.kind === "served" ? reading.choices.map((one) => one.accountId) : []).toEqual([
      "acct-personal",
      "acct-team",
    ]);
  });

  it("names an unchosen driver rather than offering every account on the node", () => {
    const reading = attachAccountAxisReadingFor(served([account()]), undefined);

    expect(reading.kind).toBe("driver-unchosen");
  });

  it("refuses a driver it cannot match to a provider rather than offering another provider's accounts", () => {
    // The defect this arm exists for: `driverName` is a bare wire string and an
    // account's provider is a closed set, so a driver outside that set has no
    // accounts of its own — and falling through to a list would pin a run to an
    // account belonging to a provider nobody chose.
    const reading = attachAccountAxisReadingFor(served([account()]), "gemini");

    expect(reading).toEqual({ kind: "unknown-provider", driverName: "gemini" });
  });

  it("says the registry could not be read rather than saying it holds nothing", () => {
    const refusal = refuse(ACCOUNT_PLANE, "provideraccount.permission_denied", "not an operator");
    const reading = attachAccountAxisReadingFor(
      { phase: "refused", readRefusal: refusal, accounts: [], readiness: [] },
      "claude",
    );

    expect(reading).toEqual({ kind: "refused", refusal });
  });

  it("reports a healed reading as served even though it once refused", () => {
    // The phase-aware accessor is the whole point: the member survives the failure
    // and a reader that took it bare would render one refusal for the window's life.
    const reading = attachAccountAxisReadingFor(
      {
        phase: "read",
        readRefusal: refuse(ACCOUNT_PLANE, "provideraccount.permission_denied", "stale"),
        accounts: [account()],
        readiness: [],
      },
      "claude",
    );

    expect(reading.kind).toBe("served");
  });

  it("says the read is still in flight rather than saying the provider has no accounts", () => {
    const reading = attachAccountAxisReadingFor(
      { phase: "reading", readRefusal: undefined, accounts: [], readiness: [] },
      "claude",
    );

    expect(reading.kind).toBe("reading");
  });

  it("says a provider with no registered accounts holds none", () => {
    const reading = attachAccountAxisReadingFor(served([account({ provider: "codex" })]), "claude");

    expect(reading.kind === "served" ? reading.choices : ["unexpected"]).toEqual([]);
  });
});

describe("the attach form's account axis — what it says about one account", () => {
  it("attributes a readiness entry only to the account it resolved to", () => {
    const resolved: ProviderReadiness = {
      provider: "claude",
      state: "reauth_required",
      resolvedAccountId: registryAccountId("acct-team"),
      remedy: {
        kind: "sign_in",
        accountId: registryAccountId("acct-team"),
        signInInvocation: "claude login",
        credentialHomePath: "/homes/team",
      },
    };
    const reading = attachAccountAxisReadingFor(
      served(
        [
          account({ accountId: registryAccountId("acct-team") }),
          account({ accountId: registryAccountId("acct-other"), isDefault: false }),
        ],
        [resolved],
      ),
      "claude",
    );

    expect(chosenAccountIn(reading, "acct-team")?.readiness).toEqual(resolved);
    expect(chosenAccountIn(reading, "acct-other")?.readiness).toBeUndefined();
  });

  it("names the act a remedy calls for and never the provider's own sign-in command", () => {
    const reading = attachAccountAxisReadingFor(
      served(
        [account({ healthState: "reauth_required" })],
        [
          {
            provider: "claude",
            state: "reauth_required",
            resolvedAccountId: registryAccountId("acct-team"),
            remedy: {
              kind: "sign_in",
              accountId: registryAccountId("acct-team"),
              signInInvocation: "claude setup-token",
              credentialHomePath: "/homes/team",
            },
          },
        ],
      ),
      "claude",
    );
    const chosen = chosenAccountIn(reading, "acct-team");
    const advisories = chosen === undefined ? [] : accountAdvisoriesFor(chosen);

    expect(advisories).toHaveLength(3);
    expect(advisories.join(" ")).not.toContain("claude setup-token");
    expect(advisories.join(" ")).not.toContain("/homes/team");
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

describe("the attach form's account axis — what the stored reading is allowed to claim", () => {
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
    expect(readAdvisory() ?? "").toContain("\u2014");
    expect(readAdvisory() ?? "").toContain("found a credential in this account's home");
  });
});

describe("the attach form's account axis — a value the registry does not carry", () => {
  it("reports a pinned account the served registry lacks", () => {
    const reading = attachAccountAxisReadingFor(
      served([account({ accountId: registryAccountId("acct-team") })]),
      "claude",
    );

    expect(registryCarriesAccount(reading, "acct-gone")).toBe(false);
  });

  it("answers yes wherever nothing could tell, so an unread registry never disowns a caller's value", () => {
    const unread = attachAccountAxisReadingFor(
      { phase: "reading", readRefusal: undefined, accounts: [], readiness: [] },
      "claude",
    );
    const unknownProvider = attachAccountAxisReadingFor(served([account()]), "gemini");

    expect(registryCarriesAccount(unread, "acct-team")).toBe(true);
    expect(registryCarriesAccount(unknownProvider, "acct-team")).toBe(true);
  });
});
