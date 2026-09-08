// The account axis over one registry reading: five answers, and only one is a list.
//
// The rule this suite exists for is that the four non-list answers are DIFFERENT
// answers. The axis it replaced was a free-text input, so every one of them rendered
// identically — as a blank field — and the case that matters is the one where a
// person types an account under the wrong driver and the form composes a request the
// daemon can only refuse after the attach has been submitted.
//
// AND WHICH ACCOUNT A SENTENCE IS ABOUT IS ASKED HERE TOO, because it is a selection
// over the same reading rather than a wording question. What those sentences SAY is
// `account-advisories.test.ts`'s, beside the module that composes them.
//
// The model is a pure function over a reading, which is why every case here builds an
// object rather than standing up a bridge: a state a live reading reaches only through
// a particular sequence of pushes is one literal here.

import type { ProviderReadiness } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { refuse } from "../../../core/index.js";

import {
  advisoryChoiceIn,
  attachAccountAxisReadingFor,
  chosenAccountIn,
  registryCarriesAccount,
} from "./account-axis.js";
import { account, registryAccountId, resolvedTo, served } from "./account-reading.test-support.js";

/** The origin every refusal in this suite is attributed to. */
const ACCOUNT_PLANE = "account-plane";

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

describe("the attach form's account axis — which account a readiness entry is about", () => {
  it("attributes a readiness entry only to the account it resolved to", () => {
    const resolved = resolvedTo("acct-team");
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

  it("carries the entry belonging to this provider and no other provider's", () => {
    // The projection is per provider, so a row is only ever spoken for by ITS
    // provider's entry. An entry read off the array by resolved id alone would let
    // another provider's verdict land on this row — a state nobody computed for it.
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
    const reading = attachAccountAxisReadingFor(
      served([account({ accountId: registryAccountId("acct-team") })], [crossProvider]),
      "claude",
    );

    expect(reading.kind === "served" ? reading.providerReadiness : "unexpected").toBeUndefined();
    expect(chosenAccountIn(reading, "acct-team")?.readiness).toBeUndefined();
  });

  it("derives the provider's entry once, on the reading itself", () => {
    // Named on the served arm so no component re-finds it: two readers matching the
    // projection by hand are two answers to which entry this axis is about.
    const resolved = resolvedTo("acct-team");
    const reading = attachAccountAxisReadingFor(served([account()], [resolved]), "claude");

    expect(reading.kind === "served" ? reading.providerReadiness : undefined).toEqual(resolved);
  });
});

describe("the attach form's account axis — the account an unpinned attach resolves to", () => {
  it("speaks for the entry's resolved account where the form pins nothing", () => {
    // The defect this exists for: pinning nothing is the state a person meets the
    // field in and it is a REQUEST for the provider's default, so an axis that
    // answered `undefined` here left a known-unhealthy default unmentioned until the
    // daemon refused the attach.
    const reading = attachAccountAxisReadingFor(
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
    // The flag is what the registry MARKS default; the entry is what resolution
    // REACHED, computed by the same resolution the spawn path performs. Where they
    // disagree the entry is the spawn path's answer, so a field keyed on the flag
    // would report the health of an account this attach is not going to use.
    const reading = attachAccountAxisReadingFor(
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
    const reading = attachAccountAxisReadingFor(
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
    // Without this the pinned arm could answer the default, and the field would show
    // one account's readings under a value naming another.
    const reading = attachAccountAxisReadingFor(
      served([account({ accountId: registryAccountId("acct-team") })], [resolvedTo("acct-team")]),
      "claude",
    );

    expect(advisoryChoiceIn(reading, "acct-gone")).toBeUndefined();
  });

  it("answers nothing where the entry resolved no account at all", () => {
    const reading = attachAccountAxisReadingFor(
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
    const unread = attachAccountAxisReadingFor(
      { phase: "reading", readRefusal: undefined, accounts: [], readiness: [] },
      "claude",
    );

    expect(advisoryChoiceIn(unread, undefined)).toBeUndefined();
    expect(advisoryChoiceIn(unread, "acct-team")).toBeUndefined();
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
