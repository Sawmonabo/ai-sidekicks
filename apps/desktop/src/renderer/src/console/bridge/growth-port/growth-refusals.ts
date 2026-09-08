// Every refusal the growth port mints, and the ledger each one carries.
//
// SPLIT OUT OF `growth-port.ts`, WHICH WAS DOING TWO JOBS. That file's entry TABLE is
// one line per operation and grows by one every time a family adds a wire it does not
// have; these builders are four constructions that do not move when a wire is
// registered. Putting them behind one maintenance boundary means the table's diffs and
// the refusal vocabulary's diffs stop landing in the same file.
//
// FOUR ENTRY POINTS AND NOT ONE WIDENED BUILDER. The reasons are on each of them, and
// they are the same reason four times: each refusal is reached from a different side
// and composes its sentence from a different fact — the slate row, the parked-reply
// seam's own diagnosis, the scenario's missing script, or what a rejection said. A
// single builder taking every one of those as an optional would let a caller hand the
// unregistered arm a sentence that contradicts the row it cites.
//
// WHAT IS NOT HERE. The port's shape and the object whose every method refuses; both
// are `growth-port.ts`'s, which imports this module and is imported by nothing here.
// The direction is what keeps the split a seam: refusals know nothing about the table.

import { normalizeWireRejection, refuse } from "../../core/index.js";
import type { GrowthOperationId } from "./growth-entry.js";
import { GROWTH_OPERATIONS } from "../growth-operations/index.js";
import {
  CALL_REJECTED_REFUSAL_CODE,
  GROWTH_PORT_REFUSAL_ORIGIN,
  WIRE_UNREGISTERED_REFUSAL_CODE,
  type GrowthCallRejected,
  type GrowthRefusalLedger,
  type GrowthWireRefused,
} from "./growth-outcome.js";
import { growthSlateRow } from "./growth-slate.js";
import {
  SCRIPT_ABSENT_REFUSAL_CODE,
  type ScriptedReplyRefusalCode,
} from "../scenario-runtime/index.js";

/**
 * Build the refusal one operation returns when its wire is not registered.
 *
 * Routed through `core`'s `refuse` so the field order and the `origin` vocabulary
 * stay uniform across the console; that builder is generic in its code, so this
 * port's closed vocabulary arrives narrowed rather than widened to `string`.
 */
export function growthUnavailable(operationId: GrowthOperationId): GrowthWireRefused {
  const row = growthSlateRow(GROWTH_OPERATIONS[operationId].slateRow);
  return buildWireRefused(
    operationId,
    WIRE_UNREGISTERED_REFUSAL_CODE,
    // Product vocabulary only: the owning document travels as the structured
    // `owningDocument` member for the ledger, never inside the sentence a person
    // reads, which names the wire and the fact that this build does not carry it.
    `Not checked — ${row.wire} is not registered on this build yet.`,
  );
}

/**
 * Build the refusal a FIXTURE operation returns when its scripted reply never came.
 *
 * A second entry point rather than a widened `growthUnavailable`, because the two
 * refusals are reached from opposite sides: the wire-unregistered one composes its
 * own sentence from the slate row and takes no caller input, while this one carries
 * the seam's diagnosis verbatim (`scripted-reply.ts` composes it, and the fixture
 * bridge renders the same words). Folding them into one signature would make the
 * message optional on a builder whose whole job is to say WHY, and would let a caller
 * hand `wire-unregistered` a sentence that contradicts the slate row.
 *
 * The `code` parameter is the seam's own type, not the port's full vocabulary: the
 * only codes reachable here are the two a parked reply can fail with, so passing
 * `wire-unregistered` through this door is a compile error rather than a convention.
 */
export function growthScriptedReplyUnavailable(
  operationId: GrowthOperationId,
  code: ScriptedReplyRefusalCode,
  detail: string,
): GrowthWireRefused {
  return buildWireRefused(operationId, code, detail);
}

/**
 * Build the refusal a SERVED fixture operation returns when the scenario scripts it
 * nothing.
 *
 * A third entry point for the third reason a growth call can fail to answer, and the
 * one that would be wrong to fold into either of the others. `growthUnavailable`
 * composes "this build does not carry the wire" out of the slate row, which is false
 * for an operation the fixture serves and would send a reader to the document that
 * owes a wire the fixture already stands in for. `growthScriptedReplyUnavailable`
 * carries the parked-reply seam's own diagnosis, and nothing was parked here.
 *
 * What happened is a property of the SCENARIO, so the sentence names the call the
 * script is missing and the remedy is to drive the surface from a scenario that
 * scripts it — the same words `fixture-bridge.ts` reaches for on the call arm.
 */
export function growthUnscriptedReply(
  operationId: GrowthOperationId,
  call: string,
): GrowthWireRefused {
  return buildWireRefused(
    operationId,
    SCRIPT_ABSENT_REFUSAL_CODE,
    `Not checked — this scenario scripts no reply for \`${call}\`, so the question was never put.`,
  );
}

/**
 * Build the refusal a caller returns when a port call REJECTED instead of answering.
 *
 * A fourth entry point rather than a widened `growthUnavailable`, on the same reasoning
 * that split the others out: this refusal is reached from the other side of the
 * call, its sentence carries what the rejection said, and folding it in would put an
 * optional rejection on a builder whose whole job is to name an unregistered wire.
 *
 * IT EXISTS SO THAT A CALLER DOES NOT MINT ITS OWN. Every operation on this port is
 * typed to resolve to a `GrowthOutcome`, and every port in this build does; the
 * rejection channel is nonetheless there, and a caller reading only the fulfilment arm
 * leaves its surface on the read-in-flight state forever. The fail-closed arm needs a
 * refusal, and a refusal a CALLER builds would carry the caller's `origin` and a code
 * from no vocabulary — which is exactly the sprawl `core/refusal.ts` names. So the
 * port mints it: `origin` stays this port's, and `code` stays one member of
 * `GROWTH_PORT_REFUSAL_CODES`.
 *
 * THE SENTENCE AND THE CAUSE BOTH COME FROM `normalizeWireRejection`. A rejection is
 * an unestablished value — the throw of a hostile accessor is the ordinary hazard on
 * this path, and reading it is exactly what the console's one total normalizer is
 * for. What it recovers travels on `cause` WHOLE: `code` says this port's call broke,
 * which is one fact however the rejection spelled itself, and `cause.code` says what
 * the other side sent, which is a different fact and the one a person acts on. An
 * earlier revision kept the first and dropped the second, so a daemon's own dotted
 * code was read here and then thrown away — and a surface settling a rejection
 * through this builder rendered `call-rejected` where its sibling one navigation
 * later rendered `workflow.session_not_found` for the same class of failure.
 *
 * NO CALLER IN THE CONSOLE TAKES THIS BUILDER TODAY, and that is a measured state
 * rather than an oversight: every growth call in the tree — reads and the two run
 * controls alike — settles through `bridge/readings/read-settlement.ts`, which is
 * strictly better for a READ because it keeps the daemon's code as the refusal's own.
 * It is kept because the port's vocabulary carries `call-rejected` and a code nothing
 * can construct is worse than a constructor nothing yet calls: the rejection channel
 * of a promise exists whether a contract uses it or not, and the next caller that
 * cannot reach the reading layer needs a refusal that carries this port's origin
 * rather than one it invented. Its suite drives it, so what it produces is pinned.
 *
 * NO `RejectionFallback` IS PASSED, and that is a reading of what one does rather than
 * an omission. A fallback is the caller's stand-in SENTENCE for a rejection carrying no
 * machine-readable code, and supplying one short-circuits the arm that reads an
 * `Error`'s own message — so a fallback here would replace every ordinary rejection's
 * reason with a constant. Without one the normalizer is still total: an error gives up
 * its message, a thrown primitive is stringified through the bounded stringifier, and a
 * structure or a hostile carrier settles on that module's own unrepresentable-value
 * text.
 */
export function growthUnavailableFromRejection(
  operationId: GrowthOperationId,
  rejection: unknown,
): GrowthCallRejected {
  const row = growthSlateRow(GROWTH_OPERATIONS[operationId].slateRow);
  const cause = normalizeWireRejection(GROWTH_PORT_REFUSAL_ORIGIN, rejection);
  return {
    ...refuse(
      GROWTH_PORT_REFUSAL_ORIGIN,
      CALL_REJECTED_REFUSAL_CODE,
      // Product vocabulary, and the same shape the unregistered sentence takes: the
      // wire this read needed, then what went wrong with it.
      `${row.wire} did not answer — ${cause.detail}`,
    ),
    ...growthRefusalLedger(operationId),
    cause,
  };
}

/**
 * The ledger every growth refusal carries: which operation, which row, whose wire.
 *
 * ONE CONSTRUCTION FOR THE MEMBERS `core` HAS NO REASON TO KNOW, and no count of the
 * builders that spread it — a number written here is a claim about the module's other
 * declarations, and it went stale the moment a builder was added or split.
 */
function growthRefusalLedger(operationId: GrowthOperationId): GrowthRefusalLedger {
  const entry = GROWTH_OPERATIONS[operationId];
  return {
    status: "unavailable",
    operationId,
    slateRow: entry.slateRow,
    owningDocument: growthSlateRow(entry.slateRow).owningDocument,
  };
}

/**
 * A refusal for a wire nobody asked: the unregistered one, and a scripted reply that
 * never came.
 *
 * `code` is written in ONE position. `refuse` is generic in it, so the parameter's
 * annotation is what the spread carries onto the result, and there is no second
 * literal to drift from the first. The rejection arm is deliberately NOT routed
 * through here: it carries a member neither of these two has, and a builder taking an
 * optional cause would let a caller mint a `call-rejected` refusal that dropped one.
 */
function buildWireRefused(
  operationId: GrowthOperationId,
  code: GrowthWireRefused["code"],
  detail: string,
): GrowthWireRefused {
  return {
    ...refuse(GROWTH_PORT_REFUSAL_ORIGIN, code, detail),
    ...growthRefusalLedger(operationId),
  };
}
