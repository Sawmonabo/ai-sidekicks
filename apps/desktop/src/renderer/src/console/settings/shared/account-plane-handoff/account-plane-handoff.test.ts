// The router is total over the codes it declares, and it composes no remedy.
//
// Driven as a table rather than through a render, because both claims are about a
// SET: that every registered account-plane code has a decision recorded for it, and
// that every decision routes into the contract's own remedy union rather than into a
// vocabulary this console invented.

import { PROVIDER_ACCOUNT_HEALTH_STATES } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_PLANE_HANDOFFS,
  ACCOUNT_PLANE_REFUSAL_CODES,
  accountPlaneHandoffFor,
  isAccountPlaneRefusalCode,
} from "./account-plane-handoff.js";
import { ACCOUNT_PLANE_ACT_SENTENCES } from "./account-plane-sentences.js";

describe("the account-plane router", () => {
  it("records a decision for every code it declares", () => {
    // The record's own keys against the tuple's, both directions — a code in one and
    // not the other is the hole a `switch` with a `default` would have swallowed.
    expect(Object.keys(ACCOUNT_PLANE_HANDOFFS).sort()).toStrictEqual(
      [...ACCOUNT_PLANE_REFUSAL_CODES].sort(),
    );
  });

  it("routes only into remedy kinds the contract declares", () => {
    const kinds = new Set(
      Object.values(ACCOUNT_PLANE_HANDOFFS)
        .filter((handoff) => handoff !== null)
        .map((handoff) => handoff.remedyKind),
    );
    for (const kind of kinds) {
      expect(ACCOUNT_PLANE_ACT_SENTENCES[kind]).toBeTypeOf("string");
    }
    // And every declared kind is reachable, so no sentence is written for a kind
    // nothing routes to.
    expect([...kinds].sort()).toStrictEqual(Object.keys(ACCOUNT_PLANE_ACT_SENTENCES).sort());
  });

  it("answers nothing for a code that is not the account plane's", () => {
    // The negative control: the router takes a bare wire string, so a neighbouring
    // namespace must not fall through into an accounts handoff.
    expect(isAccountPlaneRefusalCode("driver.capability_unsupported")).toBe(false);
    expect(accountPlaneHandoffFor("driver.capability_unsupported")).toBeUndefined();
    expect(accountPlaneHandoffFor("")).toBeUndefined();
  });

  it("answers nothing for a registered code no console act closes", () => {
    // A refusal about the caller's authority is not routed to a page that offers an
    // act which would change nothing.
    expect(accountPlaneHandoffFor("provideraccount.permission_denied")).toBeUndefined();
    expect(accountPlaneHandoffFor("provideraccount.provider_version_below_floor")).toBeUndefined();
  });

  it("routes the three admission refusals to the acts that close them", () => {
    expect(accountPlaneHandoffFor("provideraccount.not_registered")).toStrictEqual({
      section: "accounts",
      remedyKind: "register",
    });
    expect(accountPlaneHandoffFor("provideraccount.no_default")).toStrictEqual({
      section: "accounts",
      remedyKind: "choose_default",
    });
    expect(accountPlaneHandoffFor("provideraccount.not_authenticated")).toStrictEqual({
      section: "accounts",
      remedyKind: "sign_in",
    });
  });

  it("names no credential home, no invocation, and no path in any sentence", () => {
    // The rule the accounts page states in terms: the remedy's CONTENT is the
    // daemon's and travels on the readiness entry. A sentence here that named a
    // command or a home would be this console composing one.
    for (const sentence of Object.values(ACCOUNT_PLANE_ACT_SENTENCES)) {
      expect(sentence).not.toMatch(/\//u);
      expect(sentence).not.toMatch(/\b(?:claude|codex|npx|login|--)\b/iu);
    }
    // A control: the health vocabulary the daemon does send is not smuggled in here
    // either, so no sentence is a paraphrase of a state the wire already names.
    for (const state of PROVIDER_ACCOUNT_HEALTH_STATES) {
      for (const sentence of Object.values(ACCOUNT_PLANE_ACT_SENTENCES)) {
        expect(sentence).not.toContain(state);
      }
    }
  });
});
