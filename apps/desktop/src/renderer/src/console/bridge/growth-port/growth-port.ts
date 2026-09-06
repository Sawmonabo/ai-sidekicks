// The growth port: the console's single fixture-only seam.
//
// `Plan-023 §Console growth slate` names thirty-four wires the console builds
// against and does not yet have. Those rows are not methods — one bundles a whole
// namespace plus two settings plus a pane-kind declaration, several describe type
// semantics on replies that already exist. So the port is keyed by OPERATION, not
// by row, and the ledger that records the keying is two tables next door:
// `GROWTH_OPERATIONS` (`growth-operations/`) for the callables and
// `GROWTH_PREREQUISITES` (`growth-prerequisites.ts`) for the non-callable rest.
//
// I-023-13's test maps in both directions: no slate row is unmapped, no entry names
// a row that is not on the slate, and every entry's live-status agrees with its
// row. There is deliberately no dispatcher collapsing unrelated operations into one
// call — a single `invoke(name, payload)` would type-erase every one of these and
// make the fixture's shape identity unverifiable, which is the one property the
// port exists to keep.
//
// The live bridge implements every method as a typed refusal. That refusal renders
// as the "not checked" kind of nothing (`Spec-023 §Console Design (Meridian)` §The
// five kinds of nothing), never as an empty list — because "we have not asked" and
// "there is none" are different facts and the console does not conflate them.
//
// WHAT THIS FILE OWNS, AND WHY THE LINE IS HERE. Everything that CONSTRUCTS the
// port: the mapped type that derives one method per operation, the refusal builders,
// and the refusing port itself. All of them are one construction over whatever the
// signature table says, so they do not move when a wire is registered — and the
// table does, which is why it lives next door in `growth-signatures/`. The
// ledger's rows and the ledger's row shape are somebody else's too. What a call
// ANSWERS with is `growth-outcome.ts`, so a surface can narrow a result without
// reaching for the signature table it will never read.

import { normalizeWireRejection, refuse } from "../../core/index.js";
import type { GrowthOperationId } from "./growth-entry.js";
import { GROWTH_OPERATIONS } from "../growth-operations/index.js";
import {
  CALL_REJECTED_REFUSAL_CODE,
  GROWTH_PORT_REFUSAL_ORIGIN,
  WIRE_UNREGISTERED_REFUSAL_CODE,
  type GrowthCallRejected,
  type GrowthOutcome,
  type GrowthRefusalLedger,
  type GrowthWireRefused,
} from "./growth-outcome.js";
import type { GrowthOperationSignatures } from "../growth-signatures/index.js";
import { growthSlateRow } from "./growth-slate.js";
import type { ScriptedReplyRefusalCode } from "../scenario-runtime/index.js";

/**
 * The port. One method per operation, derived from the signature table so the
 * compiler keeps the three declarations — id union, metadata record, signature
 * table — in agreement.
 */
export type GrowthPort = {
  readonly [OperationId in GrowthOperationId]: (
    request: GrowthOperationSignatures[OperationId]["request"],
  ) => Promise<GrowthOutcome<GrowthOperationSignatures[OperationId]["value"]>>;
};

/**
 * What one operation answers with — the served arm or the refusal — read off the port.
 *
 * A PROJECTION OF `GrowthPort` AND NOT A SECOND DECLARATION, which is the whole point:
 * spelled out beside the port it would be a second statement of the same fact, and the
 * two agree only while someone keeps them in step.
 *
 * It exists because `Partial<GrowthPort>` is what a family hands the fixture bridge
 * when it scripts a port, and a scripted answer had no name: fixtures were annotated
 * `Record<string, unknown>` or left to infer, neither of which is assignable to the
 * method it fills, so the call sites reached for `as unknown as Partial<GrowthPort>` —
 * one cast switching off the checking on every operation in the object to get past the
 * one member that did not fit. With the answer nameable, a fixture is annotated with
 * the thing it has to be and the casts are unnecessary.
 *
 * `Port` IS IN THE NAME BECAUSE A FAMILY ALREADY HAS A `GrowthAnswer`. A family-level
 * growth-call seam declares one keyed by the VALUE a served answer carries; this one is
 * keyed by the OPERATION that answers, so the type published family-wide takes the
 * qualifier and says which axis it is keyed on.
 */
export type GrowthPortAnswer<TOperationId extends GrowthOperationId> = Awaited<
  ReturnType<GrowthPort[TOperationId]>
>;

/**
 * The VALUE inside a served answer, for a fixture that builds one member at a time.
 *
 * `GrowthPortAnswer` is the whole union, so `.value` is unreachable on it — correct for a
 * consumer, which must narrow before reading, and useless for a fixture, which is
 * declaring the served arm and knows it. Extracted from the same projection rather
 * than named again, so the two cannot describe different shapes.
 */
export type GrowthServedValue<TOperationId extends GrowthOperationId> = Extract<
  GrowthPortAnswer<TOperationId>,
  { readonly status: "served" }
>["value"];

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
 * Build the refusal a caller returns when a port call REJECTED instead of answering.
 *
 * A third entry point rather than a widened `growthUnavailable`, on the same reasoning
 * that split the second one out: this refusal is reached from the other side of the
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
 * READS DO NOT TAKE THIS BUILDER AND ACTS DO, which is the split rather than a
 * preference. Every growth READ in the tree settles through
 * `bridge/readings/read-settlement.ts`, which is strictly better for a read because it
 * keeps the daemon's own code as the refusal's. That seam answers a
 * `SettledReadRefusal` — the console's refusal shape plus the arm to narrow on — and
 * an ACT's consumer needs more than that: it branches on which growth code was raised,
 * so an unregistered wire and a wire that answered badly stay two facts, and it reads
 * the operation ledger to say which wire it was. That is this builder's output and not
 * the reading seam's, so the auxiliary hand-off's acts settle here, through
 * {@link settledGrowthCall} directly below.
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
 * Run one growth ACT whose promise must not reject.
 *
 * A `GrowthPort` method answers `served` or `unavailable`, and every caller in the
 * console branches on that pair. A REJECTION is outside the pair: it leaves the
 * caller's state where it was — no refusal rendered, no reading settled, a control
 * that answers a press by doing nothing — and, because these calls are dispatched
 * from effects and event handlers, it surfaces only as an unhandled rejection the
 * runner reports and a shipped window does not.
 *
 * So the rejection is answered in the port's own vocabulary rather than in each
 * caller's `catch`. The result is the same two-arm outcome, which means a caller has
 * one path and not two, and the refusal is {@link growthUnavailableFromRejection}'s —
 * `call-rejected`, carrying the operation ledger and the normalized `cause`.
 *
 * NOT `settleGrowthRead`, for the reason the paragraph above states: that seam is the
 * right one for a read and answers a shape an act's consumer cannot branch on. The two
 * live in different families for the same reason they answer differently.
 */
export async function settledGrowthCall<TValue>(
  operationId: GrowthOperationId,
  call: () => Promise<GrowthOutcome<TValue>>,
): Promise<GrowthOutcome<TValue>> {
  try {
    return await call();
  } catch (rejection: unknown) {
    return growthUnavailableFromRejection(operationId, rejection);
  }
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

/**
 * The live bridge's growth port: every operation refuses.
 *
 * Written out rather than generated from `GROWTH_OPERATIONS`, because the return
 * type is per-operation and a generated object would need a cast that switches off
 * exactly the checking this table exists to provide. The `GrowthPort` annotation
 * makes a missing method a compile error.
 *
 * THIS MODULE IS ITS HOME FOR EVERY READER OUTSIDE `bridge/`, and the three other
 * candidates are each closed for a reason rather than passed over. `live-bridge.ts`
 * takes it through `growth-port/index.js` because that door publishes to its own
 * family, which is what a sub-module door is; a `frame/`, `seats/` or view-family
 * module may not read that door at all, so the leaf specifier is what those have.
 * `bridge/index.ts` is not the answer even though `barrel-census` would pass a line
 * there — it passes on the production readers INSIDE this family, every one of which
 * reads the declaring module or the sub-module door and none of which could use the
 * family door without closing a self-edge. A door publishes what a reader outside the
 * family takes, and outside `bridge/` this symbol's every reader is a suite. That is
 * the same reading `core/wire-rejection.ts` records for `WireErrorEnvelope`, which
 * was held off `core/index.ts` while its readers were harnesses and took the door in
 * the diff that gave it production readers reaching it THROUGH that door. And a
 * re-export under `test/console/` would be the shim `apps/desktop/AGENTS.md` names
 * where it says the deep edge is the remedy — one more module to keep in step with
 * this signature, in exchange for a shorter specifier.
 */
export function createRefusingGrowthPort(): GrowthPort {
  return {
    browserNavigate: async () => growthUnavailable("browserNavigate"),
    browserReload: async () => growthUnavailable("browserReload"),
    browserStopLoading: async () => growthUnavailable("browserStopLoading"),
    browserGoBack: async () => growthUnavailable("browserGoBack"),
    browserGoForward: async () => growthUnavailable("browserGoForward"),
    browserSubscribeNavigation: async () => growthUnavailable("browserSubscribeNavigation"),
    browserSubscribeToolCalls: async () => growthUnavailable("browserSubscribeToolCalls"),
    browserRespondToToolCall: async () => growthUnavailable("browserRespondToToolCall"),
    terminalSubscribeOutput: async () => growthUnavailable("terminalSubscribeOutput"),
    terminalWrite: async () => growthUnavailable("terminalWrite"),
    terminalResize: async () => growthUnavailable("terminalResize"),
    terminalAcquireWriteLease: async () => growthUnavailable("terminalAcquireWriteLease"),
    terminalReleaseWriteLease: async () => growthUnavailable("terminalReleaseWriteLease"),
    devServerProbe: async () => growthUnavailable("devServerProbe"),
    sessionRename: async () => growthUnavailable("sessionRename"),
    sessionArchive: async () => growthUnavailable("sessionArchive"),
    sessionClose: async () => growthUnavailable("sessionClose"),
    sessionReactivate: async () => growthUnavailable("sessionReactivate"),
    sessionRead: async () => growthUnavailable("sessionRead"),
    sessionList: async () => growthUnavailable("sessionList"),
    sessionIdentityRead: async () => growthUnavailable("sessionIdentityRead"),
    daemonStatusRead: async () => growthUnavailable("daemonStatusRead"),
    daemonStop: async () => growthUnavailable("daemonStop"),
    daemonRestart: async () => growthUnavailable("daemonRestart"),
    onboardingStateRead: async () => growthUnavailable("onboardingStateRead"),
    onboardingStepAdvance: async () => growthUnavailable("onboardingStepAdvance"),
    onboardingStepSkip: async () => growthUnavailable("onboardingStepSkip"),
    onboardingComplete: async () => growthUnavailable("onboardingComplete"),
    onboardingProviderSignInHandoff: async () =>
      growthUnavailable("onboardingProviderSignInHandoff"),
    shellConfigRead: async () => growthUnavailable("shellConfigRead"),
    shellConfigWrite: async () => growthUnavailable("shellConfigWrite"),
    invitesList: async () => growthUnavailable("invitesList"),
    healthSubscribe: async () => growthUnavailable("healthSubscribe"),
    healthStatusRead: async () => growthUnavailable("healthStatusRead"),
    gitActionExecute: async () => growthUnavailable("gitActionExecute"),
    artifactIngestBegin: async () => growthUnavailable("artifactIngestBegin"),
    artifactIngestWriteChunk: async () => growthUnavailable("artifactIngestWriteChunk"),
    artifactIngestComplete: async () => growthUnavailable("artifactIngestComplete"),
    artifactList: async () => growthUnavailable("artifactList"),
    artifactRead: async () => growthUnavailable("artifactRead"),
    artifactDelete: async () => growthUnavailable("artifactDelete"),
    artifactAllowlistRead: async () => growthUnavailable("artifactAllowlistRead"),
    artifactIngestAbort: async () => growthUnavailable("artifactIngestAbort"),
    sessionSearch: async () => growthUnavailable("sessionSearch"),
    windowDetachPane: async () => growthUnavailable("windowDetachPane"),
    windowFocusAuxiliary: async () => growthUnavailable("windowFocusAuxiliary"),
    windowCloseAuxiliary: async () => growthUnavailable("windowCloseAuxiliary"),
    windowSubscribePaneErrors: async () => growthUnavailable("windowSubscribePaneErrors"),
    providerSessionImportBegin: async () => growthUnavailable("providerSessionImportBegin"),
    providerSessionImportSubscribe: async () => growthUnavailable("providerSessionImportSubscribe"),
    attentionProjectionRead: async () => growthUnavailable("attentionProjectionRead"),
    attentionPreferenceRead: async () => growthUnavailable("attentionPreferenceRead"),
    attentionPreferenceUpdate: async () => growthUnavailable("attentionPreferenceUpdate"),
    // workflow
    workflowDefinitionList: async () => growthUnavailable("workflowDefinitionList"),
    workflowRunStart: async () => growthUnavailable("workflowRunStart"),
    workflowRunRead: async () => growthUnavailable("workflowRunRead"),
    workflowRunCancel: async () => growthUnavailable("workflowRunCancel"),
    workflowRunResume: async () => growthUnavailable("workflowRunResume"),
    workflowPhaseOutputRead: async () => growthUnavailable("workflowPhaseOutputRead"),
    workflowGateResolve: async () => growthUnavailable("workflowGateResolve"),
    workflowHumanFormSubmit: async () => growthUnavailable("workflowHumanFormSubmit"),
    workflowGateChainVerify: async () => growthUnavailable("workflowGateChainVerify"),
    workflowRunList: async () => growthUnavailable("workflowRunList"),
    workflowVersionChainRead: async () => growthUnavailable("workflowVersionChainRead"),
    // gitflow
    gitflowBranchContextRead: async () => growthUnavailable("gitflowBranchContextRead"),
    gitflowPrPrepare: async () => growthUnavailable("gitflowPrPrepare"),
    // identity, and the callback-tool registry read
    callerParticipantRead: async () => growthUnavailable("callerParticipantRead"),
    callbackToolRegistryRead: async () => growthUnavailable("callbackToolRegistryRead"),
    // sidekick
    agentList: async () => growthUnavailable("agentList"),
    agentAttach: async () => growthUnavailable("agentAttach"),
    agentConfigUpdate: async () => growthUnavailable("agentConfigUpdate"),
    agentDetach: async () => growthUnavailable("agentDetach"),
    orchestrationChildRunLinkRead: async () => growthUnavailable("orchestrationChildRunLinkRead"),
    sidekickDefinitionList: async () => growthUnavailable("sidekickDefinitionList"),
    sidekickDefinitionCreate: async () => growthUnavailable("sidekickDefinitionCreate"),
    sidekickDefinitionUpdate: async () => growthUnavailable("sidekickDefinitionUpdate"),
    sidekickDefinitionDelete: async () => growthUnavailable("sidekickDefinitionDelete"),
    sidekickPeerInvocationSet: async () => growthUnavailable("sidekickPeerInvocationSet"),
    // event content, and the session cost plane
    hydratedEventRead: async () => growthUnavailable("hydratedEventRead"),
    orchestrationCostReceiptRead: async () => growthUnavailable("orchestrationCostReceiptRead"),
    orchestrationBudgetRead: async () => growthUnavailable("orchestrationBudgetRead"),
  };
}
