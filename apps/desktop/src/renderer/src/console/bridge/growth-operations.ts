// The callable half of the growth ledger: one entry per eventual bridge method or
// subscription, each naming the slate row it serves.
//
// `Plan-023 §Console growth slate` names the wires the console builds against and
// does not yet have. Those rows are not methods — one bundles a whole namespace
// plus two settings plus a pane-kind declaration — so the ledger is keyed by
// OPERATION rather than by row, and this table is the operation half of that key
// space. The non-callable rest lives in `growth-prerequisites.ts`, and the two are
// separate modules because they are separate closed sets with separate readers:
// every row here has a port method behind it and supplies that method's refusal its
// slate-row attribution, while a prerequisite row is only ever audited.
//
// WHY A TABLE AND NOT A LIST. The entry a caller reaches for is always reached by
// id, and the compiler — not a reviewer — is what should guarantee a new id gets an
// entry. A `Record` keyed by `GrowthOperationId` makes a missing entry and an
// unknown key both compile errors; an array beside the union would make neither.

import type {
  GrowthOperationEntry,
  GrowthOperationId,
  GrowthOperationKind,
} from "./growth-entry.js";
import type { GrowthSlateRowId } from "./growth-slate.js";

/**
 * Every operation, keyed by id. Typed as an exhaustive record so the compiler — not
 * a reviewer — is what guarantees a new id gets an entry.
 */
export const GROWTH_OPERATIONS: Readonly<Record<GrowthOperationId, GrowthOperationEntry>> = {
  browserNavigate: op(
    "browserNavigate",
    "browser-pane-namespace",
    "method",
    "navigate the embedded browser pane to a URL",
  ),
  browserReload: op(
    "browserReload",
    "browser-pane-namespace",
    "method",
    "reload the embedded browser pane",
  ),
  browserStopLoading: op(
    "browserStopLoading",
    "browser-pane-namespace",
    "method",
    "stop an in-flight page load",
  ),
  browserGoBack: op(
    "browserGoBack",
    "browser-pane-namespace",
    "method",
    "step back in the pane's history",
  ),
  browserGoForward: op(
    "browserGoForward",
    "browser-pane-namespace",
    "method",
    "step forward in the pane's history",
  ),
  browserSubscribeNavigation: op(
    "browserSubscribeNavigation",
    "browser-pane-namespace",
    "subscription",
    "navigation state for the pane's chrome (URL, title, loading, history depth)",
  ),
  browserSubscribeToolCalls: op(
    "browserSubscribeToolCalls",
    "browser-tool-relay",
    "subscription",
    "daemon-to-desktop relay of agent browser tool calls awaiting execution",
  ),
  browserRespondToToolCall: op(
    "browserRespondToToolCall",
    "browser-tool-relay",
    "method",
    "return a browser tool call's result to the daemon",
  ),
  terminalSubscribeOutput: op(
    "terminalSubscribeOutput",
    "terminal-pane",
    "subscription",
    "terminal output stream for a shared terminal session",
  ),
  terminalWrite: op(
    "terminalWrite",
    "terminal-pane",
    "method",
    "write participant keystrokes, subject to the write lease",
  ),
  terminalResize: op(
    "terminalResize",
    "terminal-pane",
    "method",
    "report the pane's column and row count",
  ),
  terminalAcquireWriteLease: op(
    "terminalAcquireWriteLease",
    "terminal-pane",
    "method",
    "take the shared-terminal write lease",
  ),
  terminalReleaseWriteLease: op(
    "terminalReleaseWriteLease",
    "terminal-pane",
    "method",
    "give the write lease back",
  ),
  devServerProbe: op(
    "devServerProbe",
    "dev-server-probe",
    "method",
    "probe whether a local dev server is listening, for the browser pane's chip",
  ),
  sessionRename: op("sessionRename", "session-lifecycle-verbs", "method", "rename a session"),
  sessionArchive: op("sessionArchive", "session-lifecycle-verbs", "method", "archive a session"),
  sessionClose: op("sessionClose", "session-lifecycle-verbs", "method", "close a session"),
  sessionReactivate: op(
    "sessionReactivate",
    "session-lifecycle-verbs",
    "method",
    "reactivate an archived session",
  ),
  sessionRead: op(
    "sessionRead",
    "session-directory-read",
    "method",
    "read one session's snapshot, so its store can reach a base state and project the stream bound to it",
    "session.read",
  ),
  sessionList: op(
    "sessionList",
    "session-directory-read",
    "method",
    "list the sessions on this node, so a surface can offer more than the set this window happens to have open",
  ),
  daemonStatusRead: op(
    "daemonStatusRead",
    "daemon-control-methods",
    "method",
    "read the daemon's status for the settings daemon page",
    "DaemonStatusRead",
  ),
  daemonStop: op("daemonStop", "daemon-control-methods", "method", "stop the daemon", "DaemonStop"),
  daemonRestart: op(
    "daemonRestart",
    "daemon-control-methods",
    "method",
    "restart the daemon",
    "DaemonRestart",
  ),
  onboardingStateRead: op(
    "onboardingStateRead",
    "onboarding-methods",
    "method",
    "read first-run progress",
  ),
  onboardingStepAdvance: op(
    "onboardingStepAdvance",
    "onboarding-methods",
    "method",
    "record a completed first-run step",
  ),
  onboardingStepSkip: op(
    "onboardingStepSkip",
    "onboarding-methods",
    "method",
    "record a skipped first-run step",
  ),
  onboardingComplete: op(
    "onboardingComplete",
    "onboarding-methods",
    "method",
    "finish first-run setup",
  ),
  onboardingProviderSignInHandoff: op(
    "onboardingProviderSignInHandoff",
    "onboarding-methods",
    "method",
    "hand the participant off to a provider's own sign-in flow",
  ),
  shellConfigRead: op(
    "shellConfigRead",
    "shell-config-preferences",
    "method",
    "read the shell-level preferences",
  ),
  shellConfigWrite: op(
    "shellConfigWrite",
    "shell-config-preferences",
    "method",
    "set one shell-level preference",
  ),
  invitesList: op("invitesList", "invites-list", "method", "list pending invites", "invites.list"),
  healthSubscribe: op(
    "healthSubscribe",
    "health-subscribe",
    "subscription",
    "node health for the strip and the park banner",
    "health.subscribe",
  ),
  gitActionExecute: op(
    "gitActionExecute",
    "gitflow-actions",
    "method",
    "run a git action from the repos and diffs surfaces",
    "gitflow.gitActionExecute",
  ),
  artifactIngestBegin: op(
    "artifactIngestBegin",
    "artifact-ingest-and-crud",
    "method",
    "open an attachment ingest",
  ),
  artifactIngestWriteChunk: op(
    "artifactIngestWriteChunk",
    "artifact-ingest-and-crud",
    "method",
    "write one ingest chunk",
  ),
  artifactIngestComplete: op(
    "artifactIngestComplete",
    "artifact-ingest-and-crud",
    "method",
    "close an ingest",
  ),
  artifactList: op(
    "artifactList",
    "artifact-ingest-and-crud",
    "method",
    "list a session's artifacts",
  ),
  artifactRead: op(
    "artifactRead",
    "artifact-ingest-and-crud",
    "method",
    "read one artifact's metadata",
  ),
  artifactDelete: op("artifactDelete", "artifact-ingest-and-crud", "method", "delete an artifact"),
  artifactAllowlistRead: op(
    "artifactAllowlistRead",
    "artifact-allowlist-and-abort",
    "method",
    "read the effective attachment allow-list so the pane can say what it will accept before a file is chosen",
  ),
  artifactIngestAbort: op(
    "artifactIngestAbort",
    "artifact-allowlist-and-abort",
    "method",
    "abort an in-flight ingest",
  ),
  sessionSearch: op(
    "sessionSearch",
    "session-search",
    "method",
    "search sessions from the palette and the all-sessions list",
  ),
  windowDetachPane: op(
    "windowDetachPane",
    "window-control-namespace",
    "method",
    "detach a pane into an auxiliary window",
  ),
  windowFocusAuxiliary: op(
    "windowFocusAuxiliary",
    "window-control-namespace",
    "method",
    "focus an auxiliary window",
  ),
  windowCloseAuxiliary: op(
    "windowCloseAuxiliary",
    "window-control-namespace",
    "method",
    "close an auxiliary window",
  ),
  windowSubscribePaneErrors: op(
    "windowSubscribePaneErrors",
    "window-control-namespace",
    "subscription",
    "the crashed-window pane-error signal",
  ),
  providerSessionImportBegin: op(
    "providerSessionImportBegin",
    "provider-session-import",
    "method",
    "start importing an existing provider session's history",
  ),
  providerSessionImportSubscribe: op(
    "providerSessionImportSubscribe",
    "provider-session-import",
    "subscription",
    "progress for a running provider-session import",
  ),
  attentionProjectionRead: op(
    "attentionProjectionRead",
    "attention-plane",
    "method",
    "read a session's actionable and informational attention, run-scoped items and the session aggregate together, over the daemon JSON-RPC transport",
    "attention.projectionRead",
  ),
  attentionPreferenceRead: op(
    "attentionPreferenceRead",
    "attention-plane",
    "method",
    "read the participant's global notification preferences, over the control-plane transport",
    "attention.preferenceRead",
  ),
  attentionPreferenceUpdate: op(
    "attentionPreferenceUpdate",
    "attention-plane",
    "method",
    "set one global notification preference, over the control-plane transport",
    "attention.preferenceUpdate",
  ),
  // workflow — nine of the thirteen rows of the registered method registry, in that
  // registry's own order. The four it does not carry are named in the slate row's
  // own wire text: the two authoring writes and the version read no console surface
  // on this substrate calls, and the draft save, which is declared with no handler
  // to reach.
  workflowDefinitionList: op(
    "workflowDefinitionList",
    "workflow-run-control",
    "method",
    "enumerate the workflow definitions visible here, resolved most-specific-first, so the builder can name one it does not already hold an id for",
    "workflow.definitionList",
  ),
  workflowRunStart: op(
    "workflowRunStart",
    "workflow-run-control",
    "method",
    "start a run against a pinned definition version",
    "workflow.runStart",
  ),
  workflowRunRead: op(
    "workflowRunRead",
    "workflow-run-control",
    "method",
    "read one run's header and its per-phase projection, park surface included, so the pane renders a parked run from this one call",
    "workflow.runRead",
  ),
  workflowRunCancel: op(
    "workflowRunCancel",
    "workflow-run-control",
    "method",
    "cancel a run, the operator control that is the only named producer of the cancelled status",
    "workflow.runCancel",
  ),
  workflowRunResume: op(
    "workflowRunResume",
    "workflow-run-control",
    "method",
    "resume a parked run, carrying the explicit version re-pin as a request member rather than an operation of its own",
    "workflow.runResume",
  ),
  workflowPhaseOutputRead: op(
    "workflowPhaseOutputRead",
    "workflow-run-control",
    "method",
    "read one phase's durable outputs, which stay addressable after the run ends",
    "workflow.phaseOutputRead",
  ),
  workflowGateResolve: op(
    "workflowGateResolve",
    "workflow-run-control",
    "method",
    "resolve a phase-boundary gate and read back the appended chain row's anchor",
    "workflow.gateResolve",
  ),
  workflowHumanFormSubmit: op(
    "workflowHumanFormSubmit",
    "workflow-run-control",
    "method",
    "submit a human phase's form under optimistic concurrency, so a stale submission is refused rather than silently overwriting",
    "workflow.humanFormSubmit",
  ),
  workflowGateChainVerify: op(
    "workflowGateChainVerify",
    "workflow-run-control",
    "method",
    "verify a run's gate-resolution hash chain and report the first divergent sequence",
    "workflow.gateChainVerify",
  ),
  // The run enumeration, on its own row and naming no wire method — the corpus
  // registers none, and an invented string here would be a wire fact traceable to
  // nothing.
  workflowRunList: op(
    "workflowRunList",
    "workflow-run-enumeration",
    "method",
    "enumerate the workflow runs a session holds, so a person can see what is running and what is parked without already holding a run id",
  ),
  // gitflow
  gitflowBranchContextRead: op(
    "gitflowBranchContextRead",
    "gitflow-actions",
    "method",
    "read the base, head, upstream, and worktree association a writable run executes against, for the repos surface's branch-context summary",
    "gitflow.branchContextRead",
  ),
  gitflowPrPrepare: op(
    "gitflowPrPrepare",
    "gitflow-actions",
    "method",
    "prepare a reviewable pull-request proposal from the recorded branch context, before any remote mutation",
    "gitflow.prPrepare",
  ),
  // identity, and the callback-tool registry the approvals pane reads. Neither row
  // registers a method string anywhere, so neither entry names one — the corpus has
  // the daemon RESOLVE a caller's principal and never return it, and has the
  // callback-tool registry ride spawn with no read seam at all.
  callerParticipantRead: op(
    "callerParticipantRead",
    "caller-participant-identity",
    "method",
    "read which of a session's participants this window is, so a members surface can address the sender and an approvals control can resolve the caller's own role rather than treating an unread one as read-only",
  ),
  callbackToolRegistryRead: op(
    "callbackToolRegistryRead",
    "callback-tool-registry-read",
    "method",
    "read the callback tools registered into a session, so the approvals pane can name what an agent may call rather than only what it has already been seen calling",
  ),
  // sidekick — four of the five registered pairs, in the registry's own order. The
  // fifth, the per-session peer-invocation opt-in, is not here: it is session state
  // rather than a definition, and no surface on this substrate sets it.
  sidekickDefinitionList: op(
    "sidekickDefinitionList",
    "sidekick-definition-registry",
    "method",
    "list this node's saved sidekick definitions, unfiltered — the registry returns full records, so there is no separate read verb to pair with it",
    "sidekick.definitionList",
  ),
  sidekickDefinitionCreate: op(
    "sidekickDefinitionCreate",
    "sidekick-definition-registry",
    "method",
    "save a new definition, every axis but the name optional and an omitted axis stored as the inherit state rather than as today's default materialised",
    "sidekick.definitionCreate",
  ),
  sidekickDefinitionUpdate: op(
    "sidekickDefinitionUpdate",
    "sidekick-definition-registry",
    "method",
    "patch a definition, an absent key leaving the stored value alone and an explicit null clearing it back to the inherit state",
    "sidekick.definitionUpdate",
  ),
  sidekickDefinitionDelete: op(
    "sidekickDefinitionDelete",
    "sidekick-definition-registry",
    "method",
    "delete a definition, which never touches an agent attached from it because attach copies rather than references",
    "sidekick.definitionDelete",
  ),
  // The hydrated event read. It names no wire method for the same reason the two
  // identity rows above name none: the projection is built daemon-side and reaches
  // no bridge namespace, so an invented string here would be traceable to nothing.
  hydratedEventRead: op(
    "hydratedEventRead",
    "hydrated-event-read",
    "method",
    "open one event's machine-authored body — the assistant and tool prose the taxonomy records the existence of and the event payload does not carry — so a ledger row renders what was said rather than only that something was",
  ),
  // The session cost plane. Both ids are the registered method's TAIL without its
  // root, unlike the workflow and sidekick blocks above: the console calls exactly
  // these two verbs of a plane whose other pairs it never reaches, so a root folded
  // into both ids would lengthen every call site and disambiguate nothing. The
  // entry still names the method in full, so the transcription stays checkable.
  orchestrationCostReceiptRead: op(
    "orchestrationCostReceiptRead",
    "cost-receipt-read",
    "method",
    "read the committed-spend fold decomposed along its per-run, per-caused-by, and per-paying-account axes, each a partition of the same session figure rather than a second computation of it",
    "orchestration.costReceiptRead",
  ),
  orchestrationBudgetRead: op(
    "orchestrationBudgetRead",
    "cost-receipt-read",
    "method",
    "read the session's limits and the committed-spend figure admission compares against, served from the same accountant accessor the receipt is, so the two can never disagree",
    "orchestration.budgetRead",
  ),
};

function op(
  id: GrowthOperationId,
  slateRow: GrowthSlateRowId,
  kind: GrowthOperationKind,
  summary: string,
  expectedWireMethod?: string,
): GrowthOperationEntry {
  return { id, slateRow, kind, summary, expectedWireMethod, liveStatus: "fixture-only" };
}
