// The account axis over one registry reading: it offers only the chosen provider's accounts,
// speaks for the account resolution reached, and never disowns or replaces a pinned value.
// Cases build plain objects, since the model is a pure function over a reading.

import type { ProviderReadiness } from "@ai-sidekicks/contracts/provider/account/record";
import { describe, expect, it } from "vitest";

import {
  advisoryChoiceIn,
  accountAxisReadingFor,
  chosenAccountIn,
  registryCarriesAccount,
} from "./axis.js";
import { account, registryAccountId, resolvedTo, served } from "./reading.test-support.js";

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

  it(
    "refuses a driver it cannot match to a provider rather than " +
      "offering another provider's accounts",
    () => {
      // The form's `driverName` is a free string and provider is a closed set; falling through to a
      // list would pin a run to an account of a provider nobody chose.
      const reading = accountAxisReadingFor(served([account()]), "gemini");

      expect(reading).toEqual({ kind: "unknown-provider", driverName: "gemini" });
    },
  );
});

describe("the account axis — which account a readiness entry is about", () => {
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
      },
    };
    const reading = accountAxisReadingFor(
      served([account({ accountId: registryAccountId("acct-team") })], [crossProvider]),
      "claude",
    );

    expect(reading.kind === "served" ? reading.providerReadiness : "unexpected").toBeUndefined();
    expect(chosenAccountIn(reading, "acct-team")?.readiness).toBeUndefined();
  });
});

describe("the account axis — the account an unpinned run resolves to", () => {
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

  it("negative control: a pinned value the registry lacks never falls to the default", () => {
    // Otherwise the pinned arm could answer the default, showing one account's readings under
    // a value naming another.
    const reading = accountAxisReadingFor(
      served([account({ accountId: registryAccountId("acct-team") })], [resolvedTo("acct-team")]),
      "claude",
    );

    expect(advisoryChoiceIn(reading, "acct-gone")).toBeUndefined();
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

  it(
    "answers yes wherever nothing could tell, so an unread registry " +
      "never disowns a caller's value",
    () => {
      const unread = accountAxisReadingFor(
        { phase: "reading", readRefusal: undefined, accounts: [], readiness: [] },
        "claude",
      );
      const unknownProvider = accountAxisReadingFor(served([account()]), "gemini");

      expect(registryCarriesAccount(unread, "acct-team")).toBe(true);
      expect(registryCarriesAccount(unknownProvider, "acct-team")).toBe(true);
    },
  );
});
