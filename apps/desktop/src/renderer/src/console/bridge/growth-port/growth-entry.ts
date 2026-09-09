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

import type { GrowthSlateRowId } from "./growth-slate-row.js";

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
 *
 * `daemon-producer` is the odd one and is here because the others could not hold it:
 * every kind above names something that is not DECLARED anywhere, and this one names a
 * value that is fully declared and that nothing on the producing side can ever emit.
 * Filing such a row as a `type-member` would claim the contract is missing a member it
 * already carries, and filing it as a `governing-document` would claim a decision is
 * open that is already approved — both are read by a person deciding what to build,
 * and both would send them to the wrong file.
 */
export type GrowthPrerequisiteKind =
  | "pane-kind"
  | "settings-key"
  | "type-member"
  | "event-type"
  | "error-namespace"
  | "tool-registration"
  | "bridge-member"
  | "governing-document"
  | "daemon-producer";

/**
 * One callable's row.
 *
 * THE SENTENCE DESCRIBING THE OPERATION IS NOT A MEMBER HERE. It is a second
 * declaration in the plane module that owns the row —
 * `<PLANE>_GROWTH_OPERATION_SUMMARIES`, keyed by the same closed id set — because the
 * split is by CONSUMER, which is the rule `growth-slate-consumers.ts` states for the
 * slate's own `consumingSurface`. A running console reads exactly one member of this
 * row, `slateRow`, which attributes a refusal; the sentence is written for a reader of
 * `Plan-023 §Console growth slate` and its only mechanical reader is the check beside
 * each table. These rows are on the initial import graph because every refusal composes
 * from them, so a sentence carried here was prose on the document every session
 * downloads. `growth-operations/index.ts` states the whole reading and holds the
 * composition that reaches the sentences.
 */
export interface GrowthOperationEntry {
  readonly id: GrowthOperationId;
  readonly slateRow: GrowthSlateRowId;
  readonly kind: GrowthOperationKind;
  /** The wire method string, where the slate row already names one. */
  readonly expectedWireMethod: string | undefined;
  readonly liveStatus: GrowthLiveStatus;
}

export interface GrowthPrerequisiteEntry {
  readonly id: GrowthPrerequisiteId;
  readonly slateRow: GrowthSlateRowId;
  readonly kind: GrowthPrerequisiteKind;
  readonly liveStatus: GrowthLiveStatus;
  readonly summary: string;
  /**
   * The event-type strings an `event-type` row is waiting to be registered.
   *
   * ON THE ENTRY RATHER THAN INSIDE ITS SENTENCE, for the reason
   * {@link GrowthOperationEntry.expectedWireMethod} is: a wire string a gate has to
   * READ cannot live only in prose written for a person. An `event-type` row's whole
   * claim is that a type is absent from the shipped census, and until that claim was a
   * value nothing checked it — the day the registration lands, the row would have gone
   * on reporting a debt already paid, which is the one failure this ledger exists to
   * prevent. Deliberately `string[]` and not `SessionEventType`: a type this array can
   * name is by definition not a member of that union yet, so narrowing it would make
   * the array unwritable exactly while the row is owed.
   *
   * Absent where the row's unmet need names no specific type (a registration counted
   * rather than enumerated). Never empty: an `event-type` row with an empty array
   * would read as a checked claim about nothing.
   */
  readonly unregisteredEventTypes?: readonly string[];
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
  // not page actions at all: capture, pick element, and the file open that runs the
  // mount-envelope check. The site-data reset the pane's overflow dispatches is
  // `browserSiteDataClear` below, beside the settings page's reads of the same
  // partitions — one act, one row, whichever surface sends it. `browserPaneAttach` /
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
  | "browserProducedArtifacts"
  | "browserPickElement"
  | "browserOpenFile"
  | "browserRevealPageFile"
  | "browserPaneAttach"
  | "browserPaneDetach"
  | "browserPublishChordMirror"
  | "browserSubscribeAccelerators"
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
  // the identity a header renders: the session's display title and
  // its wire-verbatim state, which the store-shaped snapshot read above drops.
  | "sessionIdentityRead"
  | "daemonStatusRead"
  | "daemonStop"
  | "daemonRestart"
  // a read of the negotiated ack the shell holds, put by a window rather
  // than by the shell that performed the handshake: which protocol was negotiated,
  // which set the daemon supports, and — when the two sides do not meet — why. The
  // id names the READ and never `daemon.hello`, which a window must never re-issue:
  // a second handshake on a live connection is refused by design.
  | "daemonNegotiationRead"
  | "daemonStart"
  | "onboardingStateRead"
  | "onboardingStepAdvance"
  | "onboardingStepSkip"
  | "onboardingComplete"
  | "onboardingPresentChoice"
  | "onboardingTelemetryPrompt"
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
  | "artifactVisibilityUpdate"
  | "artifactAllowlistRead"
  | "artifactIngestAbort"
  | "sessionSearch"
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
  // The definition plane's own three registry rows — the two reads that open a
  // definition and one of its versions, and the single write all five authoring acts
  // ride. Registered method strings like the nine above, and on a slate row of their
  // own because they are the boundary that row's count is drawn at.
  | "workflowDefinitionRead"
  | "workflowVersionRead"
  | "workflowDefinitionCreate"
  // gitflow — three of the four registered `gitflow.*` method strings.
  // `diffArtifactCreate` mints the diff artifact both diff surfaces render; the
  // fourth, `gitActionExecute`, is declared above with the act plane it belongs to
  // rather than here.
  | "gitflowBranchContextRead"
  | "gitflowDiffArtifactCreate"
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
  // `growth-operations/index.test.ts` holds every entry to.
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
  // the live gap fill: re-open the stream after a position the caller states
  | "timelineSubscribe"
  // the workspace execution context — the normalized checkout root and the
  // fallback-mode marker, neither of which any registered reply carries
  | "workspaceExecutionContextRead"
  // channel plane — the four lifecycle verbs in the registry's own order, then the
  // roster read. Each id is its wire method's tail with the root folded in, which
  // `growth-operations/index.test.ts` holds every entry to.
  | "channelCreate"
  | "channelMute"
  | "channelUnmute"
  | "channelArchive"
  | "channelRosterRead"
  // The membership roster read, which folds to no wire method: `membership.update` is
  // keyed by an identifier every registered carrier answers only from a join or a
  // write, so the read that would supply one is registered nowhere and has no tail to
  // fold. The per-device presence fan-out beside it does have one.
  | "membershipRosterRead"
  | "participantPresenceDetailRead"
  // The session's terminal-control holder, which folds to no wire method either: the
  // holder is a MEMBER of the runtime-node roster reply rather than a read of its
  // own, and the shipped strict schema does not carry it.
  | "terminalControlHolderRead"
  // presence — the two Awareness activity fields, read for everyone else and
  // published for this participant. Neither field is a method anywhere in the
  // corpus, so no id here folds a wire method: see `growth-operations/presence.ts`.
  | "presenceActivityRead"
  | "presenceComposingSet"
  | "presenceComposingClear"
  // invite — the pending-invite namespace `Spec-023 §Preload Bridge Contract` writes
  // out verbatim, each id its named method's tail with the root folded in, plus the
  // control-plane host a shareable link is composed from, which folds to no method.
  | "invitePendingSubscribe"
  | "inviteOutcomeSubscribe"
  | "inviteConfirmPending"
  | "inviteRetryPending"
  | "inviteDismissPending"
  | "controlPlaneHostRead"
  // the shell's notification-permission reading, which decides whether the
  // notification centre is the only surface these items reach a person on
  | "shellNotificationPermissionRead"
  // the shell's own condition, which is a main-process fact and not a daemon call:
  // the supervisor's step and attempt count, the handshake ack, and the two notices
  // an install can be quietly weaker for.
  | "shellStatusSubscribe"
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
  | "mcpSetTrust"
  // The two durable run records the corpus registers as COLUMNS with no read: the
  // intervention row's origin and admitting principal, and the queue row's binding to
  // a run. Both are asked by a run surface rather than by a plane of their own, which
  // is why they share one plane rather than joining the session or agent tables.
  | "runRecordInterventionHistoryRead"
  | "runRecordQueueRunBindingRead";

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
  | "agentProviderSwitchedEvent"
  | "nodeSelfDeclarationCarrier"
  | "providerSessionImportSpec"
  | "timelineResumeCursorMember"
  | "mountHealthIdentityProjection"
  | "workflowParentContentHashMember"
  | "workflowHumanFormContentMembers";
