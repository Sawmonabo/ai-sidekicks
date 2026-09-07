// What the provider step's two suites build their cases out of.
//
// The step's own suite and the multi-account suite beside it each drive this model
// over the shipped fixture, and this is what they share: the readiness method's name,
// how a case gets a model and an arrival, and the scripted two-account projection.
// Written once so the two files cannot drift into disagreeing about what a registry
// reply looks like, which is the drift a second copy of a fixture always ends in.

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { ONBOARDING_SCENARIO } from "../../bridge/scenarios/onboarding.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { ProviderReadinessModel } from "./provider-readiness.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/index.js";

/** The registry read every case here measures, named once for both suites. */
export const READINESS_CALL = "providerAccount.list";

/**
 * The two accounts one provider holds below, and the observation they share.
 *
 * Plain strings because they are only ever written INTO a scripted reply, which is
 * untyped by design. Every case that needs one as a value reads it back off the
 * projection the daemon door parsed, so no case restates a wire id as a literal and
 * none reaches for the contracts schema — a console module never parses a wire value.
 */
const CODEX_DEFAULT_ACCOUNT_ID = "acct-codex-personal";
const CODEX_SECOND_ACCOUNT_ID = "acct-codex-work";
const OBSERVED_AT = "2026-01-01T08:40:00.000Z";

export function modelOver(bridge: ConsoleBridge): ProviderReadinessModel {
  return new ProviderReadinessModel(bridge);
}

/** The shipped onboarding scenario, which is one ready provider and one signed out. */
export function fixture(): ConsoleBridge {
  return createFixtureBridge({ scenario: ONBOARDING_SCENARIO });
}

/**
 * The arrival, driven through the entry the walkthrough drives.
 *
 * `subscribe` is the one reason this model performs immediately rather than behind
 * the scheduler's window, on `onboarding-flow.ts`' rule, so crossing a macrotask
 * boundary is the whole of the wait.
 */
export async function arrive(model: ProviderReadinessModel): Promise<void> {
  model.requestRead("subscribe");
  await crossMacrotaskBoundary();
}

/**
 * The same scenario with `codex` holding TWO accounts, resolved to the NON-default.
 *
 * Two defects are only reachable where a provider has more than one credential home:
 * with one account, the account a hand-off would elect for itself and the account
 * whose remedy is on screen are the same id, and both a request that names none and a
 * scope that never changes still pass. The non-default account is the one readiness
 * resolves here because that is what a SCOPED read answers — the post-refusal path
 * this model's scope exists for — so "the account the remedy named" and "the account
 * a surface would pick" are two different values.
 *
 * A whole reply rather than a patch of the shipped one, on `refusingFixture`'s shape:
 * the reply is schema-parsed on the way back through the daemon door, so a projection
 * assembled here is held to the registered contract exactly as the fixture's own is.
 */
export function twoAccountScenario(): ConsoleScenario {
  return {
    ...ONBOARDING_SCENARIO,
    replies: [
      ...ONBOARDING_SCENARIO.replies.filter((reply) => reply.call !== READINESS_CALL),
      {
        call: READINESS_CALL,
        result: {
          accounts: [
            {
              accountId: CODEX_DEFAULT_ACCOUNT_ID,
              provider: "codex",
              displayLabel: "Personal",
              credentialGeneration: 1,
              billingMode: "metered",
              isDefault: true,
              healthState: "authenticated",
              healthObservedAt: OBSERVED_AT,
              observedAuthMode: "oauth_token",
              loggedInAt: null,
              expectedReloginAtEstimate: null,
              probeEnabled: true,
            },
            {
              accountId: CODEX_SECOND_ACCOUNT_ID,
              provider: "codex",
              displayLabel: "Work",
              credentialGeneration: 4,
              billingMode: "metered",
              isDefault: false,
              healthState: "reauth_required",
              healthObservedAt: OBSERVED_AT,
              observedAuthMode: "oauth_token",
              loggedInAt: null,
              expectedReloginAtEstimate: null,
              probeEnabled: true,
            },
          ],
          usageWindows: [],
          readiness: [
            {
              provider: "codex",
              state: "reauth_required",
              resolvedAccountId: CODEX_SECOND_ACCOUNT_ID,
              observedAt: OBSERVED_AT,
              remedy: {
                kind: "sign_in",
                accountId: CODEX_SECOND_ACCOUNT_ID,
                signInInvocation: "codex login",
                credentialHomePath: "/Users/you/Library/Application Support/sidekicks/codex/work",
              },
            },
          ],
        },
      },
    ],
  };
}
