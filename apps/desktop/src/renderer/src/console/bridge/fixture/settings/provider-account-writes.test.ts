// The account plane's three writes, driven through the real fixture bridge.
//
// The suite beside `provider-account-writes.ts`, and it earns its place on the
// property lifting the plane out of the port could silently break: all three verbs are
// script-only, so each answers from the scenario that states it and refuses by name for
// one that does not. The sweep in `growth/growth-port.test.ts` holds each to the served
// tuple, which says only that they answer at all — it cannot tell a scripted attempt
// from a synthesized one, and a synthesized sign-in puts a URL on screen that leads
// nowhere.
//
// The two cases are each other's negative control: a plane routing no script would
// refuse under the settings scenario, and one that had grown an unscripted fallback
// would serve under the flagship. Neither case alone reports it.

import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { createFixture } from "../call-plane/bridge.test-support.js";
import { servedValueOf } from "../growth/growth-port.test-support.js";
import { FLAGSHIP_SCENARIO } from "../../scenarios/flagship.js";
import { SCRIPT_ABSENT_REFUSAL_CODE } from "../../scenario-runtime/index.js";
import {
  SETTINGS_PROVIDER_ACCOUNT_LOGIN,
  SETTINGS_PROVIDER_ACCOUNT_LOGIN_CANCEL,
  SETTINGS_PROVIDER_ACCOUNT_REGISTER,
} from "../../scenarios/settings/account-plane.js";
import { SETTINGS_SCENARIO } from "../../scenarios/settings.js";

/** The scripted latency on the sign-in and the registration. */
const ACCOUNT_WRITE_LATENCY_MS = 80;
/** The scripted latency on the cancel, which the scenario answers a little sooner. */
const ACCOUNT_CANCEL_LATENCY_MS = 60;

/**
 * The requests the three verbs are addressed by.
 *
 * Each carries what its registered request requires and nothing more. The sign-in
 * names the scenario's own Codex account so the probe asks the question a person's
 * press asks, and the cancel names the attempt that sign-in answers with.
 */
const SIGN_IN_REQUEST = { accountId: SETTINGS_PROVIDER_ACCOUNT_REGISTER.account.accountId };
const CANCEL_REQUEST = { attemptId: SETTINGS_PROVIDER_ACCOUNT_LOGIN.attemptId };
const REGISTER_REQUEST = {
  provider: "codex",
  displayLabel: "Codex — CI",
  billingMode: "metered",
} as const;

describe("the fixture's provider-account plane", () => {
  it("serves each of the three verbs from the scenario that scripts it", async () => {
    const fixture = createFixture(SETTINGS_SCENARIO);

    const signIn = fixture.bridge.growth.providerAccountLogin(SIGN_IN_REQUEST);
    const registration = fixture.bridge.growth.providerAccountRegister(REGISTER_REQUEST);
    await crossMacrotaskBoundary();
    fixture.engine.advance(ACCOUNT_WRITE_LATENCY_MS);
    expect(servedValueOf(await signIn)).toStrictEqual(SETTINGS_PROVIDER_ACCOUNT_LOGIN);
    expect(servedValueOf(await registration)).toStrictEqual(SETTINGS_PROVIDER_ACCOUNT_REGISTER);

    const cancel = fixture.bridge.growth.providerAccountLoginCancel(CANCEL_REQUEST);
    await crossMacrotaskBoundary();
    fixture.engine.advance(ACCOUNT_CANCEL_LATENCY_MS);
    expect(servedValueOf(await cancel)).toStrictEqual(SETTINGS_PROVIDER_ACCOUNT_LOGIN_CANCEL);
  });

  it("refuses all three by name for a scenario that scripts none", async () => {
    // None of the three has an empty form. A synthesized attempt would put a
    // verification URL on screen that leads nowhere, and a synthesized registration
    // would mint an identity every later registry read is keyed by.
    const fixture = createFixture(FLAGSHIP_SCENARIO);

    const outcomes = await Promise.all([
      fixture.bridge.growth.providerAccountLogin(SIGN_IN_REQUEST),
      fixture.bridge.growth.providerAccountLoginCancel(CANCEL_REQUEST),
      fixture.bridge.growth.providerAccountRegister(REGISTER_REQUEST),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toStrictEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    for (const outcome of outcomes) {
      expect(outcome.status === "unavailable" && outcome.code).toBe(SCRIPT_ABSENT_REFUSAL_CODE);
    }
  });
});
