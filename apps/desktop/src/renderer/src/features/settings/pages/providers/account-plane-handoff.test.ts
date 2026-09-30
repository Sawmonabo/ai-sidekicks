// The router is total over the codes it declares and composes no remedy. Driven as a table
// because both claims are about a set: every registered code has a decision, and every decision
// routes into the contract's remedy union.

import { PROVIDER_ACCOUNT_HEALTH_STATES } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_PLANE_HANDOFFS,
  ACCOUNT_PLANE_REFUSAL_CODES,
  accountPlaneHandoffFor,
  isAccountPlaneRefusalCode,
} from "./account-plane-handoff.js";
import { ACCOUNT_PLANE_HANDOFF_SENTENCES } from "./account-plane-sentences.js";

describe("the account-plane router", () => {
  it("records a decision for every code it declares", () => {
    // The record's keys against the tuple's, both directions: a code in one and not the other
    // is the hole a `switch` with a `default` would swallow.
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
      expect(ACCOUNT_PLANE_HANDOFF_SENTENCES[kind]).toBeTypeOf("string");
    }
    // And every declared kind is reachable, so no sentence is written for a kind nothing
    // routes to.
    expect([...kinds].sort()).toStrictEqual(Object.keys(ACCOUNT_PLANE_HANDOFF_SENTENCES).sort());
  });

  it("answers nothing for a code that is not the account plane's", () => {
    // Negative control: the router takes a bare wire string, so a neighboring namespace must not
    // fall through into a Providers handoff.
    expect(isAccountPlaneRefusalCode("driver.capability_unsupported")).toBe(false);
    expect(accountPlaneHandoffFor("driver.capability_unsupported")).toBeUndefined();
    expect(accountPlaneHandoffFor("")).toBeUndefined();
  });

  it("answers nothing for a registered code no console act closes", () => {
    // A refusal about the caller's authority is not routed to a page that would change nothing.
    expect(accountPlaneHandoffFor("provideraccount.permission_denied")).toBeUndefined();
    expect(accountPlaneHandoffFor("provideraccount.provider_version_below_floor")).toBeUndefined();
  });

  it("routes the three admission refusals to the acts that close them", () => {
    expect(accountPlaneHandoffFor("provideraccount.not_registered")).toStrictEqual({
      section: "providers",
      remedyKind: "register",
    });
    expect(accountPlaneHandoffFor("provideraccount.no_default")).toStrictEqual({
      section: "providers",
      remedyKind: "choose_default",
    });
    expect(accountPlaneHandoffFor("provideraccount.not_authenticated")).toStrictEqual({
      section: "providers",
      remedyKind: "sign_in",
    });
  });

  it("names no credential home, no invocation, and no path in any sentence", () => {
    // The remedy's content is the daemon's and travels on the readiness entry; a sentence naming
    // a command or a home would be this console composing one.
    for (const sentence of Object.values(ACCOUNT_PLANE_HANDOFF_SENTENCES)) {
      expect(sentence).not.toMatch(/\//u);
      expect(sentence).not.toMatch(/\b(?:claude|codex|npx|login|--)\b/iu);
    }
    // The health vocabulary the daemon sends is not smuggled in, so no sentence paraphrases a
    // state the wire already names.
    for (const state of PROVIDER_ACCOUNT_HEALTH_STATES) {
      for (const sentence of Object.values(ACCOUNT_PLANE_HANDOFF_SENTENCES)) {
        expect(sentence).not.toContain(state);
      }
    }
  });
});
