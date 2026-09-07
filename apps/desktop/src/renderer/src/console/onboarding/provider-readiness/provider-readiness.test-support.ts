// What the provider step's four suites build their cases out of.
//
// The step's own suite and the three beside it each drive this model over the shipped
// fixture, and this is what they share: the two method names, how a case gets a model
// and an arrival, the bridge that records what left the window, and the scripted
// two-account projection.
// Written once so the four files cannot drift into disagreeing about what a registry
// reply looks like, which is the drift a second copy of a fixture always ends in.

import type { ProviderAccount } from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import {
  withDaemonCall,
  type RecordedDaemonCall,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import { ONBOARDING_SCENARIO } from "../../bridge/scenarios/onboarding.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { FrameStore, UNREPORTED_SHELL_STATE, type ShellConnection } from "../../store/index.js";
import { ProviderReadinessModel } from "./provider-readiness.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/index.js";

/** The registry read every case here measures, named once for both suites. */
export const READINESS_CALL = "providerAccount.list";

/**
 * The mutating probe a re-check dispatches, named once for the four suites over this
 * family: the model's own, the multi-account one, the no-sign-in one, and the
 * shell-block one that counts how many of them left the window.
 */
export const PROBE_CALL = "providerAccount.probe";

/**
 * A model over a bridge that records what it was asked, answering from the scenario.
 *
 * The record is what every coalescing and disposal case asserts on, and the
 * pass-through is why they can: each case still reads the scenario's own projection,
 * so an assertion about the number of calls sits beside one about what they answered
 * rather than replacing it.
 */
export function recordingModel(bridge: ConsoleBridge = fixture()): {
  readonly model: ProviderReadinessModel;
  readonly bridge: ConsoleBridge;
  readonly calls: readonly RecordedDaemonCall[];
} {
  const held = withDaemonCall(bridge, async (_call, passThrough) => passThrough());
  return { model: modelOver(held.bridge), bridge: held.bridge, calls: held.calls };
}

/**
 * How many readiness reads actually left this window.
 *
 * Here rather than in a suite because three of them count the same method, and the
 * two copies this replaced were one role with two homes — the drift this module
 * exists to stop. In the blocked cases next door it is also the per-method negative
 * control: the read leaves under the identical condition that stops the probe.
 */
export function readCount(calls: readonly RecordedDaemonCall[]): number {
  return calls.filter((call) => call.method === READINESS_CALL).length;
}

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

/**
 * A model over a bridge and a real window store.
 *
 * THE REAL `FrameStore` and never a stub of it: the model reads the shell state
 * through the store's own per-method seam and subscribes for changes, so a hand-built
 * object would be a second answer to "what does this window hold" — and the one
 * property every block case turns on, that a report is published only when it actually
 * moved, lives in the store rather than in the shape. A case that does not care about
 * the shell gets a fresh store reporting nothing, which is what a window holds before
 * its first supervisor report and therefore blocks nothing.
 */
export function modelOver(
  bridge: ConsoleBridge,
  frameStore: FrameStore = new FrameStore(),
): ProviderReadinessModel {
  return new ProviderReadinessModel(bridge, frameStore);
}

/**
 * Put one supervisor condition on a window store, through the store's own writer.
 *
 * The whole report and not the connection alone, because that is the shape the
 * supervisor subscription publishes — a partial value would be one the real store
 * never receives.
 */
export function reportShellConnection(frameStore: FrameStore, connection: ShellConnection): void {
  frameStore.publishShellReport({
    connection,
    negotiation: UNREPORTED_SHELL_STATE.negotiation,
    lastHeartbeatAt: UNREPORTED_SHELL_STATE.lastHeartbeatAt,
    transport: UNREPORTED_SHELL_STATE.transport,
    keystore: UNREPORTED_SHELL_STATE.keystore,
  });
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

/** The four members a rendering case actually varies. The rest are held fixed. */
export interface ScriptedProviderAccountFields {
  readonly accountId: string;
  readonly displayLabel: string;
  readonly isDefault: boolean;
  /** Which provider holds this account. `codex`, where a case does not care. */
  readonly provider?: string;
}

/**
 * One registry record, built for the two RENDERING suites over this family.
 *
 * Here rather than in either suite because both the row's cases and the step's need
 * one and a second literal would be the registry projection written twice — the drift
 * this module already exists to stop for the scripted reply above. The branded
 * members are cast for the reason every console module casts them: a console module
 * never parses a wire value, and these cases render a record rather than earning one
 * back through the daemon door.
 */
export function providerAccountRecord(fields: ScriptedProviderAccountFields): ProviderAccount {
  return {
    accountId: fields.accountId as ProviderAccount["accountId"],
    provider: (fields.provider ?? "codex") as ProviderAccount["provider"],
    displayLabel: fields.displayLabel,
    credentialGeneration: 1 as ProviderAccount["credentialGeneration"],
    billingMode: "metered",
    isDefault: fields.isDefault,
    healthState: "authenticated",
    healthObservedAt: OBSERVED_AT,
    observedAuthMode: "oauth_token",
    loggedInAt: null,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
  };
}
