// The account axis over one registry reading: five answers, only one a list, and the four
// non-list ones must stay distinct rather than all rendering as a blank field. Which account
// a sentence is about is asked here; what it says is `account-advisories.test.ts`. Cases
// build plain objects, since the model is a pure function over a reading.

import type { ProviderReadiness } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { refuse } from "@renderer/lib/refusal.js";

import {
  advisoryChoiceIn,
  accountAxisReadingFor,
  chosenAccountIn,
  registryCarriesAccount,
} from "./account-axis.js";
import { account, registryAccountId, resolvedTo, served } from "./account-reading.test-support.js";

/** The origin every refusal in this suite is attributed to. */
const ACCOUNT_PLANE = "account-plane";

describe("the account axis — which accounts it may offer", () => {
  it("offers only the accounts belonging to the chosen driver's provider", () => {
    const reading = accountAxisReadingFor(
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
    const reading = accountAxisReadingFor(
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
    const reading = accountAxisReadingFor(served([account()]), undefined);

    expect(reading.kind).toBe("driver-unchosen");
  });

  it("refuses a driver it cannot match to a provider rather than offering another provider's accounts", () => {
    // `driverName` is a bare wire string and provider is a closed set; falling through to a
    // list would pin a run to an account of a provider nobody chose.
    const reading = accountAxisReadingFor(served([account()]), "gemini");

    expect(reading).toEqual({ kind: "unknown-provider", driverName: "gemini" });
  });

  it("says the registry could not be read rather than saying it holds nothing", () => {
    const refusal = refuse(ACCOUNT_PLANE, "provideraccount.permission_denied", "not an operator");
    const reading = accountAxisReadingFor(
      { phase: "refused", readRefusal: refusal, accounts: [], readiness: [] },
      "claude",
    );

    expect(reading).toEqual({ kind: "refused", refusal });
  });

  it("reports a healed reading as served even though it once refused", () => {
    // The phase-aware accessor matters: the member survives the failure, and a bare read
    // would show one refusal for the window's life.
    const reading = accountAxisReadingFor(
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
    const reading = accountAxisReadingFor(
      { phase: "reading", readRefusal: undefined, accounts: [], readiness: [] },
      "claude",
    );

    expect(reading.kind).toBe("reading");
  });

  it("says a provider with no registered accounts holds none", () => {
    const reading = accountAxisReadingFor(served([account({ provider: "codex" })]), "claude");

    expect(reading.kind === "served" ? reading.choices : ["unexpected"]).toEqual([]);
  });
});

describe("the account axis — which account a readiness entry is about", () => {
  it("attributes a readiness entry only to the account it resolved to", () => {
    const resolved = resolvedTo("acct-team");
    const reading = accountAxisReadingFor(
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

  it("carries the entry belonging to this provider and no other provider's", () => {
    // The projection is per provider, so an entry matched by resolved id alone could land
    // another provider's verdict on this row.
    const crossProvider: ProviderReadiness = {
      provider: "codex",
      state: "reauth_required",
      resolvedAccountId: registryAccountId("acct-team"),
      remedy: {
        kind: "sign_in",
        accountId: registryAccountId("acct-team"),
        signInInvocation: "codex login",
        credentialHomePath: "/homes/team",
      },
    };
    const reading = accountAxisReadingFor(
      served([account({ accountId: registryAccountId("acct-team") })], [crossProvider]),
      "claude",
    );

    expect(reading.kind === "served" ? reading.providerReadiness : "unexpected").toBeUndefined();
    expect(chosenAccountIn(reading, "acct-team")?.readiness).toBeUndefined();
  });

  it("derives the provider's entry once, on the reading itself", () => {
    // Named on the served arm so no component re-finds the entry.
    const resolved = resolvedTo("acct-team");
    const reading = accountAxisReadingFor(served([account()], [resolved]), "claude");

    expect(reading.kind === "served" ? reading.providerReadiness : undefined).toEqual(resolved);
  });
});

describe("the account axis — the account an unpinned run resolves to", () => {
  it("speaks for the entry's resolved account where the form pins nothing", () => {
    // Pinning nothing is a request for the provider's default, so answering `undefined` here
    // left an unhealthy default unmentioned until the daemon refused.
    const reading = accountAxisReadingFor(
      served(
        [
          account({ accountId: registryAccountId("acct-team") }),
          account({
            accountId: registryAccountId("acct-personal"),
            isDefault: false,
            displayLabel: "Personal",
            healthState: "reauth_required",
          }),
        ],
        [resolvedTo("acct-personal")],
      ),
      "claude",
    );

    expect(advisoryChoiceIn(reading, undefined)?.accountId).toBe("acct-personal");
  });

  it("takes the entry's account and never the row the registry marks default", () => {
    // The flag is what the registry marks default; the entry is what resolution reached, as
    // the spawn path does. Where they disagree the entry wins.
    const reading = accountAxisReadingFor(
      served(
        [
          account({ accountId: registryAccountId("acct-team"), isDefault: true }),
          account({
            accountId: registryAccountId("acct-personal"),
            isDefault: false,
            healthState: "reauth_required",
          }),
        ],
        [resolvedTo("acct-personal")],
      ),
      "claude",
    );

    expect(advisoryChoiceIn(reading, undefined)?.accountId).toBe("acct-personal");
    expect(advisoryChoiceIn(reading, undefined)?.isProviderDefault).toBe(false);
  });

  it("keeps the pinned account where the form pins one", () => {
    const reading = accountAxisReadingFor(
      served(
        [
          account({ accountId: registryAccountId("acct-team") }),
          account({ accountId: registryAccountId("acct-personal"), isDefault: false }),
        ],
        [resolvedTo("acct-personal")],
      ),
      "claude",
    );

    expect(advisoryChoiceIn(reading, "acct-team")?.accountId).toBe("acct-team");
  });

  it("negative control: a pinned value the registry lacks never falls through to the default", () => {
    // Otherwise the pinned arm could answer the default, showing one account's readings under
    // a value naming another.
    const reading = accountAxisReadingFor(
      served([account({ accountId: registryAccountId("acct-team") })], [resolvedTo("acct-team")]),
      "claude",
    );

    expect(advisoryChoiceIn(reading, "acct-gone")).toBeUndefined();
  });

  it("answers nothing where the entry resolved no account at all", () => {
    const reading = accountAxisReadingFor(
      served(
        [account({ isDefault: false })],
        [
          {
            provider: "claude",
            state: "no_default",
            remedy: {
              kind: "choose_default",
              candidateAccountIds: [registryAccountId("acct-team")],
            },
          },
        ],
      ),
      "claude",
    );

    expect(advisoryChoiceIn(reading, undefined)).toBeUndefined();
  });

  it("negative control: an unserved reading resolves nothing to speak for", () => {
    const unread = accountAxisReadingFor(
      { phase: "reading", readRefusal: undefined, accounts: [], readiness: [] },
      "claude",
    );

    expect(advisoryChoiceIn(unread, undefined)).toBeUndefined();
    expect(advisoryChoiceIn(unread, "acct-team")).toBeUndefined();
  });
});

describe("the account axis — a value the registry does not carry", () => {
  it("reports a pinned account the served registry lacks", () => {
    const reading = accountAxisReadingFor(
      served([account({ accountId: registryAccountId("acct-team") })]),
      "claude",
    );

    expect(registryCarriesAccount(reading, "acct-gone")).toBe(false);
  });

  it("answers yes wherever nothing could tell, so an unread registry never disowns a caller's value", () => {
    const unread = accountAxisReadingFor(
      { phase: "reading", readRefusal: undefined, accounts: [], readiness: [] },
      "claude",
    );
    const unknownProvider = accountAxisReadingFor(served([account()]), "gemini");

    expect(registryCarriesAccount(unread, "acct-team")).toBe(true);
    expect(registryCarriesAccount(unknownProvider, "acct-team")).toBe(true);
  });
});
