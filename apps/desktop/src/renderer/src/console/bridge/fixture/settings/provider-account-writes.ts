// The PROVIDER-ACCOUNT plane: the brokered sign-in handoff, its cancel, and the
// registration — three writes and no read.
//
// WHY THIS PLANE HAS A MODULE. `workflows/workflow-reads.ts` and
// `diagnostics-reads.ts` beside it state the shape — a plane whose answers need
// reasoning of their own leaves the port and takes its served ids with it, so the ids
// and the handlers stay one set with one home. This plane earns it on the reasoning
// below rather than on its size: what it does NOT serve is as load-bearing as what it
// does, and that sentence has nowhere else to live. Holding it in the port also took
// that file past the package's split threshold.
//
// WHY THE THREE ACCOUNT-PLANE WRITES ARE SERVED, AND ALL THREE SCRIPT-ONLY
//
// The accounts page reads the registry over the BOUND call door and follows its tail
// over the bound subscription, so the read half of that surface needs nothing from this
// port. What it could not reach at all was the handoff: a brokered sign-in card with a
// verification URI and a deadline, its cancel, and the registration that carries the one
// write-only token member. Every one of those states was unreachable from any scenario
// while the three verbs refused, which means nobody had drawn them.
//
// All three are `FIXTURE_SCRIPT_ONLY` and none of them has an empty form. A sign-in
// answers with a daemon-minted attempt and a URL the operator visits — synthesize one
// and the page puts a link on screen that leads nowhere. A cancel answers what became of
// a named attempt. A registration answers with the account it created, which mints an
// identity every later registry read is keyed by.
//
// WHAT IS NOT HERE. The registry READ the three act on: `providerAccount.list` travels
// over the BOUND call door, answered from the scenario's own scripted reply and parsed
// against the registered schema, so there is no growth operation for it to serve.

import { answerScriptOnly } from "../growth/scripted-answer.js";
import type { GrowthPort } from "../../growth-port/index.js";
import type { ScenarioEngine } from "../../scenario-runtime/scenario-engine.js";

/**
 * The three account-plane operations the fixture answers.
 *
 * Declared here and spread into `FIXTURE_SERVED_GROWTH_OPERATION_IDS` next door, on
 * `FIXTURE_SERVED_WORKFLOW_OPERATION_IDS`' rule: the ids and the implementations below
 * are one set with one home, and a second tuple in the served module would agree with
 * this one until a verb landed in only one of them.
 */
export const FIXTURE_SERVED_PROVIDER_ACCOUNT_OPERATION_IDS = [
  "providerAccountLogin",
  "providerAccountLoginCancel",
  "providerAccountRegister",
] as const;

/** One account-plane operation the fixture serves. Derived, so the set has one home. */
export type FixtureServedProviderAccountOperationId =
  (typeof FIXTURE_SERVED_PROVIDER_ACCOUNT_OPERATION_IDS)[number];

/**
 * The fixture's three account-plane answers for one running scenario.
 *
 * `Pick` over the port rather than a shape of its own, on `fixtureWorkflowReads`'
 * reason: a handler whose signature drifts from the operation it serves is a compile
 * error here rather than a surface rendering a value no daemon sends.
 */
export function fixtureProviderAccountWrites(
  engine: ScenarioEngine,
): Pick<GrowthPort, FixtureServedProviderAccountOperationId> {
  return {
    providerAccountLogin: async (request) =>
      await answerScriptOnly(engine, "providerAccount.login", "providerAccountLogin", request),
    providerAccountLoginCancel: async (request) =>
      await answerScriptOnly(
        engine,
        "providerAccount.loginCancel",
        "providerAccountLoginCancel",
        request,
      ),
    providerAccountRegister: async (request) =>
      await answerScriptOnly(
        engine,
        "providerAccount.register",
        "providerAccountRegister",
        request,
      ),
  };
}
