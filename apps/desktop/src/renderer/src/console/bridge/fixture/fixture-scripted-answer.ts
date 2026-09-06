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

import type { GrowthOperationId } from "../growth-port/index.js";
import type { GrowthOutcome } from "../growth-port/index.js";
import { growthScriptedReplyUnavailable } from "../growth-port/index.js";
import type { ScenarioEngine } from "../scenario-runtime/index.js";
import { settleScriptedReply } from "../scenario-runtime/index.js";

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
 *   • **Unscripted** is not a failure on this port. Every operation the fixture serves
 *     has an honest answer of its own for a scenario that scripts nothing — the branch
 *     read's is that this workspace has no branch context — so the caller supplies it
 *     and the port serves it. `reply-unscripted` therefore stays what it has always
 *     been: `fixture-bridge.ts`'s authoring error, raised where a call really has no
 *     answer at all.
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
 */
export async function answerFromScriptedReply<TValue>(
  engine: ScenarioEngine,
  call: string,
  operationId: GrowthOperationId,
  request: unknown,
  whenUnscripted: () => TValue,
): Promise<GrowthOutcome<TValue>> {
  const settlement = await settleScriptedReply(engine, call, request);
  switch (settlement.status) {
    case "unscripted":
      return { status: "served", value: whenUnscripted() };
    case "resolved":
      return { status: "served", value: settlement.value as TValue };
    case "unanswered":
      return growthScriptedReplyUnavailable(operationId, settlement.code, settlement.detail);
    case "refused":
      throw settlement.refusal;
  }
}
