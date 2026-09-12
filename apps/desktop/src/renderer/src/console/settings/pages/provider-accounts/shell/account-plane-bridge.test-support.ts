/**
 * A bridge whose three account-plane verbs answer what a case asked for.
 *
 * AT THE ROOT OF THE SHELL RATHER THAN INSIDE ONE SUITE, because two suites drive the
 * same three ports: `signin-flow.test.ts` asserts what each call answers, and
 * `signin-plane.test.ts` asserts which of two overlapping starts is allowed to make
 * one. A second copy of this builder would be a second set of default answers, and a
 * case reading a default it did not write is the hardest kind of test to correct.
 *
 * EVERY UNSCRIPTED VERB REFUSES, through the shipped port's own `growthUnavailable`
 * builder — so a case that forgets to script an operation reads the code and sentence
 * a release build produces, rather than a hand-written envelope that resembles one.
 */

import { vi } from "vitest";

import type {
  ProviderAccountLoginCancelResponse,
  ProviderAccountLoginResponse,
  ProviderAccountRegisterResponse,
} from "@ai-sidekicks/contracts";

import {
  createFixtureBridge,
  growthUnavailable,
  type ConsoleBridge,
  type GrowthOutcome,
} from "../../../../bridge/index.js";

/** One brokered attempt, as the account plane answers a start with it. */
export const SIGN_IN_ATTEMPT: ProviderAccountLoginResponse = {
  attemptId: "attempt-1",
  verificationUri: "https://provider.example.test/device",
  userCode: "WXYZ-1234",
  expiresAt: "2026-01-01T08:15:00.000Z",
};

/** A scenario that scripts nothing: each case overrides the operation it drives. */
const EMPTY_SCENARIO: Parameters<typeof createFixtureBridge>[0]["scenario"] = {
  id: "accounts-test",
  label: "Accounts, with nothing scripted",
  purpose: "Drives the account-plane calls against overridden growth operations.",
  sessionId: "session-accounts",
  userIdsInJoinOrder: [],
  beats: [],
  replies: [],
  startedAtIso: "2026-01-01T08:00:00.000Z",
};

/** What one case wants the three account-plane verbs to answer with. */
export interface AccountPlaneScript {
  readonly login?: GrowthOutcome<ProviderAccountLoginResponse>;
  readonly cancel?: GrowthOutcome<ProviderAccountLoginCancelResponse>;
  readonly register?: GrowthOutcome<ProviderAccountRegisterResponse>;
}

/** The fixture bridge with the three account verbs answering what a case asked for. */
export function bridgeAnswering(script: AccountPlaneScript): ConsoleBridge {
  const fixture = createFixtureBridge({ scenario: EMPTY_SCENARIO });
  return {
    ...fixture,
    growth: {
      ...fixture.growth,
      providerAccountLogin: vi.fn(
        async () =>
          await Promise.resolve(script.login ?? growthUnavailable("providerAccountLogin")),
      ),
      providerAccountLoginCancel: vi.fn(
        async () =>
          await Promise.resolve(script.cancel ?? growthUnavailable("providerAccountLoginCancel")),
      ),
      providerAccountRegister: vi.fn(
        async () =>
          await Promise.resolve(script.register ?? growthUnavailable("providerAccountRegister")),
      ),
    },
  };
}
