// The join between a scenario's scripted reply and a growth outcome.
//
// Split out of `fixture-growth-port.ts` because it is a mapping rather than a
// decision: `scripted-reply.ts` settles a call on the frozen clock and reports one
// of four settlements, and every served operation that consults the script needs the
// same four-arm translation into the port's outcome union. The port is wrong when an
// operation is served that should refuse; this module is wrong when a settlement is
// translated into the wrong kind of answer — a never-released reply reaching a
// surface as an absent value, say — and the two are separate failures with separate
// evidence.

import {
  growthScriptedReplyUnavailable,
  type GrowthOperationId,
  type GrowthOutcome,
} from "../growth-port/index.js";
import type { GrowthOperationSignatures } from "../growth-signatures/index.js";
import { settleScriptedReply, type ScenarioEngine } from "../scenario-runtime/index.js";

/**
 * Answer one served operation from the scenario's script, or from its own absence.
 *
 * The four settlements `scripted-reply.ts` reports land here as three different kinds
 * of answer, and the mapping is the whole reason this helper exists rather than four
 * inline arms per operation:
 *
 * THE REQUEST TRAVELS WITH THE CALL, and it is a parameter rather than an option
 * because forgetting it is not a degraded answer but a wrong one. `settleScriptedReply`
 * hands the request to a scenario's `resultFor`, which is how a scenario answers an
 * ENTITY-scoped operation per entity; a helper that accepted none called it with
 * `undefined`, so a session holding two worktrees asked for both branch contexts and
 * every scripted reply was computed about no worktree at all — answering the
 * unscripted fallback for both, or throwing while reading a request that was not
 * there. Required and positional, so a handler that serves an entity-scoped operation
 * cannot quietly omit it: the compiler asks for it at every call site.
 *
 *   • **Unscripted** is not a failure on this port, and it is not automatically a
 *     served absence either. It is whatever the OPERATION's own honest answer is for a
 *     scenario that has said nothing, so the caller hands back the whole outcome: the
 *     branch-context read serves the absence, because "this workspace has no branch
 *     context" is a state a repos surface has to draw, while the workflow run read
 *     refuses, because a run snapshot has no empty form and an invented one is a run a
 *     pane would offer operator controls on. `reply-unscripted` therefore stays what it
 *     has always been: `fixture-bridge.ts`'s authoring error, raised where a call really
 *     has no answer at all.
 *   • **Resolved** is served verbatim. The cast is the seam's own property rather than
 *     a shortcut: a `ScenarioReply` carries `unknown`, exactly as it does for the
 *     bridge's `daemon.call`, and there is no registered reply schema to narrow it
 *     against until the wire lands.
 *   • **Unanswered** refuses by name. This is the rule the codes exist for: a reply
 *     the frozen clock never released must never reach a surface as an absent value,
 *     because an absent value renders as "there is none" — a claim about the session
 *     that nothing checked.
 *   • **Refused** is thrown VERBATIM, unwrapped, exactly as the bridge throws it. A
 *     scripted refusal is the DAEMON's, and this port's outcome union has no arm for
 *     one; adding a code for it would paraphrase the daemon's own `{code, message}`
 *     into a growth-scoped vocabulary, which is the one thing a fixture must not do.
 *     A rejection is also what the caller will get once the wire lands and the
 *     operation becomes an ordinary bridge call, so the fixture is not teaching a
 *     shape the real seam will not produce.
 *
 * THE GENERIC IS KEYED ON THE OPERATION ID rather than on a bare value type, because
 * the caller now supplies a whole outcome and the discipline of this seam is that the
 * outcome has to be honest for the value shape in question — an empty enumeration
 * where an empty enumeration is a real reply, a refusal where the value has no empty
 * form at all. Keyed this way the fallback is checked against
 * `GrowthOperationSignatures[operationId]["value"]`, so one answering with a shape the
 * operation cannot return is a type error rather than a fixture teaching a surface a
 * value no daemon sends.
 */
export async function answerFromScriptedReply<TOperationId extends GrowthOperationId>(
  engine: ScenarioEngine,
  call: string,
  operationId: TOperationId,
  request: unknown,
  whenUnscripted: () => GrowthOutcome<GrowthOperationSignatures[TOperationId]["value"]>,
): Promise<GrowthOutcome<GrowthOperationSignatures[TOperationId]["value"]>> {
  const settlement = await settleScriptedReply(engine, call, request);
  switch (settlement.status) {
    case "unscripted":
      return whenUnscripted();
    case "resolved":
      return {
        status: "served",
        value: settlement.value as GrowthOperationSignatures[TOperationId]["value"],
      };
    case "unanswered":
      return growthScriptedReplyUnavailable(operationId, settlement.code, settlement.detail);
    case "refused":
      throw settlement.refusal;
  }
}
