// What a growth-slate ledger entry IS, independent of which entries exist.
//
// The ledger is two tables — `GROWTH_OPERATIONS` in `growth-operations.ts` and
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
  // root folded in, which `growth-operations.test.ts` holds every entry to.
  | "workflowDefinitionList"
  | "workflowRunStart"
  | "workflowRunRead"
  | "workflowRunCancel"
  | "workflowRunResume"
  | "workflowPhaseOutputRead"
  | "workflowGateResolve"
  | "workflowHumanFormSubmit"
  | "workflowGateChainVerify"
  // gitflow
  | "gitflowBranchContextRead"
  | "gitflowPrPrepare"
  // identity, and the callback-tool registry the approvals pane reads
  | "callerParticipantRead"
  | "callbackToolRegistryRead"
  // sidekick — the registry's own order; each id is its wire method's tail with the
  // root folded in, which `growth-operations.test.ts` holds every entry to.
  | "sidekickDefinitionList"
  | "sidekickDefinitionCreate"
  | "sidekickDefinitionUpdate"
  | "sidekickDefinitionDelete"
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
  | "providerSessionImportSpec";
