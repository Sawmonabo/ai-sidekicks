// The port side of the scripted-reply seam: one settlement, three kinds of answer.
//
// `scripted-reply.ts` classifies what happened when the fixture went looking for one
// call's canned reply and REPORTS it, deliberately naming no refusal — because its
// two consumers name one in different vocabularies and in different shapes. The
// fixture bridge rejects, its method signatures fixed by the preload contract; the
// growth port returns a `GrowthOutcome` a surface narrows on. This module is the
// second of those two translations, and the only one a growth operation needs.
//
// WHY IT IS A MODULE AND NOT A FUNCTION INSIDE EITHER NEIGHBOUR
//
// It cannot live in `scripted-reply.ts`, and the reason is structural rather than
// stylistic: naming a growth refusal means calling `growth-port.ts`, which imports
// `growth-outcome.ts`, which already imports `scripted-reply.ts` for the two
// non-arrival codes both refusal vocabularies spread in. A translation placed in the
// seam would close `growth-outcome → scripted-reply → growth-port → growth-outcome`,
// and `structure:layering` fails a cycle. Placing it in `growth-outcome.ts` closes
// the same loop one hop earlier, and that module's own header is the reason why: it
// is what a CALLER writes code against, and a caller narrowing a result has no
// business importing the port to describe a success.
//
// It does not belong in `fixture-growth-port.ts` either, which is where it started
// and grew. That module is the fixture's served PORT — which operations answer, and
// what each one derives from a scenario — while this is the one seam every scripted
// answer crosses on the way out; a file holding both is the two-jobs shape
// `apps/desktop/AGENTS.md` sizes at about four hundred lines. So this sits below the
// port and above the seam, knows both neighbours, and is known by neither.
//
// WHY THE OPERATION ID IS THE TYPE PARAMETER
//
// The caller supplies the answer for a scenario that scripts nothing, and the whole
// discipline of this seam is that such an answer has to be honest for the value
// shape in question — an empty enumeration where an empty enumeration is a real
// reply, a refusal where the value has no empty form at all. Keying the generic on
// the operation id rather than on a bare value type makes that a compile-time fact:
// the fallback is checked against `GrowthOperationSignatures[operationId]["value"]`,
// so a fallback answering with a shape the operation cannot return is a type error
// rather than a fixture teaching a surface a value no daemon sends.

import type { GrowthOperationId } from "./growth-entry.js";
import type { GrowthOutcome } from "./growth-outcome.js";
import { growthScriptedReplyUnavailable } from "./growth-port.js";
import type { GrowthOperationSignatures } from "./growth-signatures.js";
import type { ScenarioEngine } from "./scenario.js";
import { settleScriptedReply } from "./scripted-reply.js";

/**
 * Answer one served operation from the scenario's script, or from the caller's own
 * statement of what a scenario that scripts nothing means.
 *
 * The four settlements `scripted-reply.ts` reports land here as three different kinds
 * of answer, and the mapping is the whole reason this helper exists rather than four
 * inline arms per operation:
 *
 *   • **Unscripted** is not a failure on this port, and it is not automatically a
 *     served absence either. It is whatever the OPERATION's own honest answer is for
 *     a scenario that has said nothing, so the caller hands back the whole outcome:
 *     the branch-context read serves the absence, because "this workspace has no
 *     branch context" is a state a repos surface has to draw, while the workflow run
 *     read refuses, because a run snapshot has no empty form and an invented one is a
 *     run a pane would offer operator controls on. `reply-unscripted` therefore stays
 *     what it has always been: `fixture-bridge.ts`'s authoring error, raised where a
 *     call really has no answer at all.
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
export async function answerFromScriptedReply<TOperationId extends GrowthOperationId>(
  engine: ScenarioEngine,
  call: string,
  operationId: TOperationId,
  whenUnscripted: () => GrowthOutcome<GrowthOperationSignatures[TOperationId]["value"]>,
): Promise<GrowthOutcome<GrowthOperationSignatures[TOperationId]["value"]>> {
  const settlement = await settleScriptedReply(engine, call);
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
