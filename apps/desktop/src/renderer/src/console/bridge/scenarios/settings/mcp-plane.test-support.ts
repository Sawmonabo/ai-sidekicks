// The settings deck's governance answers, read the way the fixture reads them.
//
// One home for a reader two suites take. `mcp-plane.test.ts` asserts WHICH
// binding each press answers for, and `fixture/fixture-mcp-inventory.test.ts` needs one
// of those answers to drive the inventory ledger with — and a second copy would drift on
// exactly the half that matters, whether the reply is read through its computed arm or
// its constant one: a suite still reading `result` would go green against a plane that
// had stopped answering per binding.
//
// IT READS AND NEVER SETTLES. The frozen clock, the held-reply queue, and the port's
// outcome union are all `scripted-reply.ts`' and the fixture's; this module asks the
// reply table what it would answer, which is the question a suite about the SCENARIO
// has. A suite about the wiring drives the real port instead.

import type { GrowthMcpMutationResult } from "../../growth-values/index.js";
import { SETTINGS_MCP_PLANE_REPLIES } from "./mcp-plane.js";

/**
 * What the scenario answers one call with, through whichever arm its entry carries.
 *
 * Arm-agnostic on purpose. A computed reply reaches its answer through `resultFor` and
 * a constant one through `result`, and a reader that knew which to expect would be
 * asserting the reply's SHAPE where its callers care about the ANSWER — so a plane that
 * regressed to a constant would fail its suite on a missing member rather than on the
 * binding it answered for.
 *
 * A refusal leaves as itself, unwrapped: a computed reply refuses by throwing the wire's
 * own envelope, and catching it here would make every caller ask twice.
 */
export function settingsMcpAnswerFor(call: string, request: unknown): unknown {
  const reply = SETTINGS_MCP_PLANE_REPLIES.find((candidate) => candidate.call === call);
  if (reply === undefined) {
    throw new Error(`the settings scenario scripts no ${call} reply`);
  }
  return reply.resultFor === undefined ? reply.result : reply.resultFor(request);
}

/**
 * One served mutation result, or a failure naming the press that answered nothing.
 *
 * The cast is the reply table's own property rather than a shortcut: a `ScenarioReply`
 * carries `unknown` because no code package publishes this namespace, so there is no
 * registered schema to narrow against until the wire lands.
 */
export function settingsMcpMutationResult(call: string, request: unknown): GrowthMcpMutationResult {
  const answer = settingsMcpAnswerFor(call, request);
  if (answer === undefined) {
    throw new Error(`${call} answered nothing for that request`);
  }
  return answer as GrowthMcpMutationResult;
}
