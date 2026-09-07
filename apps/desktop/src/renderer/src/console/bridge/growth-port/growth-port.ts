// The growth port: the console's single fixture-only seam.
//
// `Plan-023 §Console growth slate` names every wire the console builds
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
// WHAT THIS FILE OWNS, AND WHY THE LINE IS HERE. The port's SHAPE — the mapped type
// that derives one method per operation, the two projections a fixture annotates
// itself with — and the one entry TABLE that names every operation. The table is the
// half that moves: it grows a line every time a family adds a wire it does not have.
// The refusals it hands back do not move at all, so they are `growth-refusals.ts`,
// one directory entry away and imported by this file rather than the other way round.
// The signature table lives next door in `growth-signatures/`, the ledger's rows and
// row shape are somebody else's, and what a call ANSWERS with is `growth-outcome.ts`,
// so a surface can narrow a result without reaching for the signature table it will
// never read.

import type { GrowthOperationId } from "./growth-entry.js";
import type { GrowthOutcome } from "./growth-outcome.js";
import { growthUnavailable } from "./growth-refusals.js";
import type { GrowthOperationSignatures } from "../growth-signatures/index.js";

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
    browserPolicyRead: async () => growthUnavailable("browserPolicyRead"),
    browserPolicyWrite: async () => growthUnavailable("browserPolicyWrite"),
    browserSiteDataList: async () => growthUnavailable("browserSiteDataList"),
    browserSiteDataClear: async () => growthUnavailable("browserSiteDataClear"),
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
    approvalProjectionRead: async () => growthUnavailable("approvalProjectionRead"),
    approvalResolve: async () => growthUnavailable("approvalResolve"),
    approvalRuleList: async () => growthUnavailable("approvalRuleList"),
    approvalRuleRevoke: async () => growthUnavailable("approvalRuleRevoke"),
    sessionGoalUpdate: async () => growthUnavailable("sessionGoalUpdate"),
    sessionGoalClear: async () => growthUnavailable("sessionGoalClear"),
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
    // The five diagnostics reads. `healthSubscribe` above is a different wire on a
    // different slate row; these are the page's own, and all five refuse under a live
    // bridge exactly as everything else in this table does.
    healthStatusRead: async () => growthUnavailable("healthStatusRead"),
    healthFailureDetailRead: async () => growthUnavailable("healthFailureDetailRead"),
    healthStuckRunInspect: async () => growthUnavailable("healthStuckRunInspect"),
    healthRecoveryActionRequest: async () => growthUnavailable("healthRecoveryActionRequest"),
    healthRedactionPolicyRead: async () => growthUnavailable("healthRedactionPolicyRead"),
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
    attentionOsPermissionRead: async () => growthUnavailable("attentionOsPermissionRead"),
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
    // provider accounts — the three the registry read and its tail do not cover.
    // `providerAccount.list` and `providerAccount.subscribe` are bound elsewhere in
    // this family and are deliberately not on this table.
    providerAccountLogin: async () => growthUnavailable("providerAccountLogin"),
    providerAccountLoginCancel: async () => growthUnavailable("providerAccountLoginCancel"),
    providerAccountRegister: async () => growthUnavailable("providerAccountRegister"),
    // MCP governance
    mcpList: async () => growthUnavailable("mcpList"),
    mcpSetEnabled: async () => growthUnavailable("mcpSetEnabled"),
    mcpSetTrust: async () => growthUnavailable("mcpSetTrust"),
  };
}
