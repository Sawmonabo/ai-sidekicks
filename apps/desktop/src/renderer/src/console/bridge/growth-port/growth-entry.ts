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

/** The non-callable prerequisites a row also needs. */
export type GrowthPrerequisiteKind =
  | "pane-kind"
  | "settings-key"
  | "type-member"
  | "event-type"
  | "error-namespace"
  | "tool-registration"
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
  // The rest of the human half of the pane's chrome. The navigation verbs above landed
  // first because the address field needed them; these are the page-lifecycle acts the
  // strip and the picker dispatch — select, reorder, show, hide, create, close, and
  // developer tools — the page reading both of them draw from, and the acts that are
  // not page actions at all: capture, pick element, the file open that runs the
  // mount-envelope check, and the site-data reset. `browserPaneAttach` /
  // `browserPaneDetach` open and tear down the pane's view, `browserRevealPageFile`
  // hands a page's own local file to the file manager, and the chord mirror and the
  // accelerator stream are the keyboard handback's two halves. Every one of them
  // serves the same slate row the verbs above do, because they are one namespace and
  // it is registered nowhere yet.
  | "browserSelect"
  | "browserReorder"
  | "browserShow"
  | "browserHide"
  | "browserCreate"
  | "browserClose"
  | "browserDevtools"
  | "browserSubscribePages"
  | "browserCapture"
  | "browserPickElement"
  | "browserOpenFile"
  | "browserClearSiteData"
  | "browserRevealPageFile"
  | "browserPaneAttach"
  | "browserPaneDetach"
  | "browserPublishChordMirror"
  | "browserSubscribeAccelerators"
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
  | "orchestrationBudgetRead";

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
  | "providerSessionImportSpec";
