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
    "gitActionExecute",
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
