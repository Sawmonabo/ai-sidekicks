// What a growth-slate ledger entry IS, independent of which entries exist.
//
// The ledger is two tables — `GROWTH_OPERATIONS` in `growth-operations/` and
// `GROWTH_PREREQUISITES` in `growth-prerequisites.ts` — and each is long enough to
// be its own module. What they genuinely share is this: a fixed row shape and a
// closed id set to key it by.
//
// That vocabulary lives here rather than beside either table for two reasons.
// Beside one table, the other would have to import its sibling for a vocabulary
// neither owns — an edge that says nothing true about the ledger. And the port
// layer needs `GrowthOperationId` to derive its method set without needing the
// rows underneath it; a type-only module has no reason to change when a row lands,
// which is what keeps the tables' churn out of everything downstream of them.
//
// Nothing here holds data and nothing here decides anything. A row's CONTENT is
// its table's; a row's SHAPE is this file's.

import type { GrowthSlateRowId } from "./growth-slate.js";

/** Whether an entry is wired to a real bridge yet. Checked against the slate. */
export type GrowthLiveStatus = "fixture-only" | "live";

/** A callable the eventual namespace will expose. */
export type GrowthOperationKind = "method" | "subscription";

/**
 * The non-callable prerequisites a row also needs.
 *
 * `bridge-member` is the one that is not a wire shape: a reading the SHELL composes
 * and hands the renderer over `SidekicksBridge`, which no port method can stand
 * behind because the console resolves it off the bridge it already holds rather than
 * calling for it. Filing one as a `type-member` would say it is a field on a reply
 * some daemon sends, which is the opposite of where its composition lives.
 *
 * What separates it from a growth OPERATION that also reads the shell — the OS
 * notification-permission probe is one — is when the answer can change: a probe's
 * answer moves at runtime, so it is asked through a port method each time, while a
 * bridge member is fixed at window construction and read during render, so a method
 * that "fetched" it would be a promise wrapped around a value already in hand.
 */
export type GrowthPrerequisiteKind =
  | "pane-kind"
  | "settings-key"
  | "type-member"
  | "event-type"
  | "error-namespace"
  | "tool-registration"
  | "bridge-member"
  | "governing-document";

export interface GrowthOperationEntry {
  readonly id: GrowthOperationId;
  readonly slateRow: GrowthSlateRowId;
  readonly kind: GrowthOperationKind;
  /** The wire method string, where the slate row already names one. */
  readonly expectedWireMethod: string | undefined;
  readonly liveStatus: GrowthLiveStatus;
  readonly summary: string;
}

export interface GrowthPrerequisiteEntry {
  readonly id: GrowthPrerequisiteId;
  readonly slateRow: GrowthSlateRowId;
  readonly kind: GrowthPrerequisiteKind;
  readonly liveStatus: GrowthLiveStatus;
  readonly summary: string;
}

export type GrowthOperationId =
  | "browserNavigate"
  | "browserReload"
  | "browserStopLoading"
  | "browserGoBack"
  | "browserGoForward"
  | "browserSubscribeNavigation"
  | "browserSubscribeToolCalls"
  | "browserRespondToToolCall"
  | "browserPolicyRead"
  | "browserPolicyWrite"
  | "browserSiteDataList"
  | "browserSiteDataClear"
  | "terminalSubscribeOutput"
  | "terminalWrite"
  | "terminalResize"
  | "terminalAcquireWriteLease"
  | "terminalReleaseWriteLease"
  | "devServerProbe"
  | "sessionRename"
  | "sessionArchive"
  | "sessionClose"
  | "sessionReactivate"
  | "sessionRead"
  | "sessionList"
  | "daemonStatusRead"
  | "daemonStop"
  | "daemonRestart"
  | "onboardingStateRead"
  | "onboardingStepAdvance"
  | "onboardingStepSkip"
  | "onboardingComplete"
  | "onboardingProviderSignInHandoff"
  | "shellConfigRead"
  | "shellConfigWrite"
  | "invitesList"
  | "healthSubscribe"
  | "gitActionExecute"
  | "artifactIngestBegin"
  | "artifactIngestWriteChunk"
  | "artifactIngestComplete"
  | "artifactList"
  | "artifactRead"
  | "artifactDelete"
  | "artifactAllowlistRead"
  | "artifactIngestAbort"
  | "sessionSearch"
  | "windowDetachPane"
  | "windowFocusAuxiliary"
  | "windowCloseAuxiliary"
  | "windowSubscribePaneErrors"
  | "providerSessionImportBegin"
  | "providerSessionImportSubscribe"
  | "attentionProjectionRead"
  | "attentionPreferenceRead"
  | "attentionPreferenceUpdate"
  | "attentionOsPermissionRead"
  // workflow — in the registered method registry's own order, so a reader comparing
  // the two reads them top to bottom. Each id is its wire method's tail with the
  // root folded in, which `growth-operations/index.test.ts` holds every entry to.
  | "workflowDefinitionList"
  | "workflowRunStart"
  | "workflowRunRead"
  | "workflowRunCancel"
  | "workflowRunResume"
  | "workflowPhaseOutputRead"
  | "workflowGateResolve"
  | "workflowHumanFormSubmit"
  | "workflowGateChainVerify"
  // The run enumeration, which is NOT one of the thirteen above and folds to no wire
  // method: it serves its own slate row, because every registered run operation
  // addresses one run by an id the caller already holds.
  | "workflowRunList"
  // The version chain, on the same footing and for the mirror-image reason: the
  // registry addresses a version by `(definitionId, versionNumber)`, so an id in hand
  // resolves to nothing and the read that would resolve it folds to no wire method.
  | "workflowVersionChainRead"
  // gitflow
  | "gitflowBranchContextRead"
  | "gitflowPrPrepare"
  // identity, and the callback-tool registry the approvals pane reads
  | "callerParticipantRead"
  | "callbackToolRegistryRead"
  | "approvalProjectionRead"
  | "approvalResolve"
  | "approvalRuleList"
  | "approvalRuleRevoke"
  | "sessionGoalUpdate"
  | "sessionGoalClear"
  // agent plane — the four `agent.*` verbs the console calls, in the order a surface
  // meets them: read the roster, put a sidekick in, move its provider axes, take it
  // out. Each id is its wire method's tail with the root folded in, which
  // `growth-operations.test.ts` holds every entry to.
  | "agentList"
  | "agentAttach"
  | "agentConfigUpdate"
  | "agentDetach"
  // orchestration — one parent run's child links and the fold of the creates that
  // were refused, which is the only record refused work leaves anywhere.
  | "orchestrationChildRunLinkRead"
  // sidekick — the registry's own order; each id is its wire method's tail with the
  // root folded in, which `growth-operations/index.test.ts` holds every entry to.
  | "sidekickDefinitionList"
  | "sidekickDefinitionCreate"
  | "sidekickDefinitionUpdate"
  | "sidekickDefinitionDelete"
  | "sidekickPeerInvocationSet"
  // the hydrated event read, and the session cost plane's two reads
  | "hydratedEventRead"
  | "orchestrationCostReceiptRead"
  | "orchestrationBudgetRead"
  // diagnostics — the registry's own order; each id is its wire method's tail with
  // the root folded in, which `growth-operations/index.test.ts` holds every entry to.
  // `healthSubscribe` above is deliberately NOT one of these: it is a stream serving
  // a different slate row and a different surface.
  | "healthStatusRead"
  | "healthFailureDetailRead"
  | "healthStuckRunInspect"
  | "healthRecoveryActionRequest"
  | "healthRedactionPolicyRead"
  // provider accounts — the three the registry read and its tail do not cover. The
  // list and the subscription are BOUND (`daemon/daemon-reply-registry.ts`,
  // `daemon/daemon-streams.ts`), so they are deliberately absent from this union.
  | "providerAccountLogin"
  | "providerAccountLoginCancel"
  | "providerAccountRegister"
  // MCP governance — the inventory read and the two mutations the operator page
  // sends. Each id is its wire method's tail with the root folded in, which
  // `growth-operations/index.test.ts` holds every entry to.
  | "mcpList"
  | "mcpSetEnabled"
  | "mcpSetTrust";

export type GrowthPrerequisiteId =
  | "browserPaneKindDeclaration"
  | "browserNodeSettings"
  | "browserCallbackToolRows"
  | "terminalWriteLeaseObligations"
  | "onboardingErrorCodes"
  | "shellConfigPreferenceKeys"
  | "agentSnapshotAxisMembers"
  | "gitActionVocabulary"
  | "gitflowErrorNamespace"
  | "worktreeSetupRecipeCarrier"
  | "workflowEventTypeRegistration"
  | "workflowDefinitionScopeMeaning"
  | "timelineEpochMember"
  | "timelineRevisionAttestationMember"
  | "timelinePathReferenceMember"
  | "approvalRememberedRuleMember"
  | "approvalAmendmentArm"
  | "agentProviderSwitchFailedEvent"
  | "nodeSelfDeclarationCarrier"
  | "providerSessionImportSpec";
