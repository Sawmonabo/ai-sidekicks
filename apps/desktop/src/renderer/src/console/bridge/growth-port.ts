// The growth port: the console's single fixture-only seam.
//
// `Plan-023 §Console growth slate` names thirty-three wires the console builds
// against and does not yet have. Those rows are not methods — one bundles a whole
// namespace plus two settings plus a pane-kind declaration, several describe type
// semantics on replies that already exist. So the port is keyed by OPERATION, not
// by row, and the ledger that records the keying is two tables next door:
// `GROWTH_OPERATIONS` (`growth-operations.ts`) for the callables and
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
// port: the mapped type that derives one method per operation, the refusal builder,
// and the refusing port itself. All three are one construction over whatever the
// signature table says, so they do not move when a wire is registered — and the
// table does, which is why it lives next door in `growth-signatures.ts`. The
// ledger's rows and the ledger's row shape are somebody else's too. What a call
// ANSWERS with is `growth-outcome.ts`, so a surface can narrow a result without
// reaching for the signature table it will never read.

import { refuse } from "../core/index.js";
import type { GrowthOperationId } from "./growth-entry.js";
import { GROWTH_OPERATIONS } from "./growth-operations.js";
import {
  GROWTH_PORT_REFUSAL_ORIGIN,
  type GrowthOutcome,
  type GrowthPortRefusalCode,
  type GrowthUnavailable,
} from "./growth-outcome.js";
import type { GrowthOperationSignatures } from "./growth-signatures.js";
import { growthSlateRow } from "./growth-slate.js";
import type { ScriptedReplyRefusalCode } from "./scripted-reply.js";

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
 * Build the refusal one operation returns when its wire is not registered.
 *
 * Routed through `core`'s `refuse` so the field order and the `origin` vocabulary
 * stay uniform across the console; the spread re-narrows `code`, which `refuse`'s
 * deliberately-`string` parameter widens away.
 */
export function growthUnavailable(operationId: GrowthOperationId): GrowthUnavailable {
  const row = growthSlateRow(GROWTH_OPERATIONS[operationId].slateRow);
  return buildGrowthUnavailable(
    operationId,
    "wire-unregistered",
    `Not checked — ${row.wire} is not registered yet (${row.owningDocument} owns it).`,
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
): GrowthUnavailable {
  return buildGrowthUnavailable(operationId, code, detail);
}

/**
 * The one construction both refusals share: `core`'s refusal, widened with what a
 * growth refusal knows.
 *
 * `code` is bound once and read twice — `refuse` takes it as a `string` and the
 * spread has to re-narrow it, so the value is needed in two positions, and two
 * independent literals could drift apart with nothing to catch it since one feeds a
 * parameter that accepts anything. One binding makes them the same value by
 * construction, and the parameter's annotation holds it inside the closed vocabulary
 * `GROWTH_PORT_REFUSAL_CODES` declares.
 */
function buildGrowthUnavailable(
  operationId: GrowthOperationId,
  code: GrowthPortRefusalCode,
  detail: string,
): GrowthUnavailable {
  const entry = GROWTH_OPERATIONS[operationId];
  return {
    ...refuse(GROWTH_PORT_REFUSAL_ORIGIN, code, detail),
    code,
    status: "unavailable",
    operationId,
    slateRow: entry.slateRow,
    owningDocument: growthSlateRow(entry.slateRow).owningDocument,
  };
}

/**
 * The live bridge's growth port: every operation refuses.
 *
 * Written out rather than generated from `GROWTH_OPERATIONS`, because the return
 * type is per-operation and a generated object would need a cast that switches off
 * exactly the checking this table exists to provide. The `GrowthPort` annotation
 * makes a missing method a compile error.
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
    // gitflow
    gitflowBranchContextRead: async () => growthUnavailable("gitflowBranchContextRead"),
    gitflowPrPrepare: async () => growthUnavailable("gitflowPrPrepare"),
    // identity, and the callback-tool registry read
    callerParticipantRead: async () => growthUnavailable("callerParticipantRead"),
    callbackToolRegistryRead: async () => growthUnavailable("callbackToolRegistryRead"),
    // sidekick
    sidekickDefinitionList: async () => growthUnavailable("sidekickDefinitionList"),
    sidekickDefinitionCreate: async () => growthUnavailable("sidekickDefinitionCreate"),
    sidekickDefinitionUpdate: async () => growthUnavailable("sidekickDefinitionUpdate"),
    sidekickDefinitionDelete: async () => growthUnavailable("sidekickDefinitionDelete"),
    // event content, and the session cost plane
    hydratedEventRead: async () => growthUnavailable("hydratedEventRead"),
    orchestrationCostReceiptRead: async () => growthUnavailable("orchestrationCostReceiptRead"),
    orchestrationBudgetRead: async () => growthUnavailable("orchestrationBudgetRead"),
  };
}
