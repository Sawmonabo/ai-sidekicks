// A scripted WRITE, and the refusal a scenario that scripts none takes.
//
// Split out of `fixture-growth-port.ts` when a second module needed it, on this
// package's hoist-on-second-use rule. It is a decision rather than a mapping — which
// is what separates it from `fixture-scripted-answer.ts` beside it: that module
// translates a settlement the engine already reported, and this one decides, BEFORE
// the seam is reached, that a write with no scripted answer has no honest arm to take
// at all.

import { growthUnscriptedReply, type GrowthOutcome } from "../growth-port/index.js";
import type { GrowthOperationId } from "../growth-port/growth-entry.js";
import type { GrowthOperationSignatures } from "../growth-signatures/index.js";
import { answerFromScriptedReply } from "./fixture-scripted-answer.js";
import type { ScenarioEngine } from "../scenario-runtime/index.js";

/**
 * Answer one WRITE from the script, and refuse where the scenario scripts none.
 *
 * A read has an empty state and a write does not: "this session has no agents" is a
 * state the console draws, and there is no such thing as "the attach that happened
 * and produced nothing". So a write that no scenario answers cannot take the served
 * arm with a synthesized receipt — that would tell a surface the daemon did
 * something no author ever said it did, and for an attach it would mint an identity
 * every later read is keyed by.
 *
 * The precondition is checked here rather than inside the seam because it is a fact
 * about the SCENARIO rather than about the settlement — `callerParticipantRead` reads
 * its own precondition off `engine.scenario` for the same reason. What is left after
 * the check is exactly the settlement the seam reports, so the parked, abandoned, and
 * over-cap arms all keep their own answers.
 */
export async function answerScriptedWrite<TOperationId extends GrowthOperationId>(
  engine: ScenarioEngine,
  call: string,
  operationId: TOperationId,
  request: unknown,
): Promise<GrowthOutcome<GrowthOperationSignatures[TOperationId]["value"]>> {
  if (engine.replyFor(call) === undefined) {
    // The SCENARIO's gap and never the build's. `growthUnavailable` would compose
    // "this build does not carry the wire", which is false for an operation this
    // fixture serves and would send a reader to the document that owes a wire the
    // fixture already stands in for — the distinction `growthUnscriptedReply`'s own
    // header draws, and the one `fixture-growth-port.test.ts` holds every served
    // operation to.
    return growthUnscriptedReply(operationId, call);
  }
  return await answerFromScriptedReply<TOperationId>(engine, call, operationId, request, () => {
    // Unreachable: the guard above already refused every unscripted call, and the
    // seam reports `unscripted` only for exactly that. Named rather than cast, so a
    // later change that moves the guard fails here loudly instead of serving a value
    // that was never scripted.
    throw new Error(`${call} reached the unscripted arm behind its own scripted guard`);
  });
}
