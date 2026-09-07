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
  growthUnscriptedReply,
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
 *   • **Unscripted** is the CALLER's to answer, and its answer is an outcome rather
 *     than a value — because the honest reading differs per operation and neither
 *     arm may be forced on the other. The list reads' is a served EMPTY state: a
 *     session with no invites and a node with no saved sidekick definitions are
 *     ordinary, and a surface has to draw them. The approvals reads', the branch
 *     read's, and every workflow read's is a refusal: a scenario that models no
 *     approvals has left the question unasked, the registered branch-context reply is
 *     flat and carries no absence at all, and a workflow run snapshot has no empty
 *     form — an invented one is a run a pane would offer operator controls on — so
 *     serving one for any of them would put "there is none" in front of a person for
 *     a fact nothing checked. So the parameter returns `GrowthOutcome` and this
 *     helper decides neither. A caller taking the refusing arm reaches for
 *     `growthUnscriptedReply` and never `growthUnavailable`, because this fixture
 *     SERVES these operations and the build does carry no less of the wire for a
 *     scenario that said nothing.
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

/**
 * Answer one WRITE from the script, and refuse where the scenario scripts none.
 *
 * BESIDE ITS READING SIBLING because it is the same join: a settlement mapped onto an
 * outcome. It lived in `fixture-growth-port.ts` while that port was its only caller,
 * and moved here when the onboarding plane took a module of its own — two callers, one
 * rule, and a copy in the second would have been free to disagree about the one
 * decision below.
 *
 * A read has an empty state and a write does not: "this session has no agents" is a
 * state the console draws, and there is no such thing as "the attach that happened and
 * produced nothing". So a write no scenario answers cannot take the served arm with a
 * synthesized receipt — that would tell a surface the daemon did something no author
 * ever said it did, and for an attach it would mint an identity every later read is
 * keyed by.
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
    // Unreachable: the guard above already refused every unscripted call, and the seam
    // reports `unscripted` only for exactly that. Named rather than cast, so a later
    // change that moves the guard fails here loudly instead of serving a value that was
    // never scripted.
    throw new Error(`${call} reached the unscripted arm behind its own scripted guard`);
  });
}
