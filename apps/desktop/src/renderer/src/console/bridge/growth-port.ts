// The growth port: the console's single fixture-only seam.
//
// `Plan-023 §Console growth slate` names twenty-four wires the console builds
// against and does not yet have. Those rows are not methods — one bundles a whole
// namespace plus two settings plus a pane-kind declaration, several describe type
// semantics on replies that already exist. So the port is keyed by OPERATION, not
// by row:
//
//   • `GROWTH_OPERATIONS` — one entry per eventual bridge method or subscription,
//     each naming the slate row it serves.
//   • `GROWTH_PREREQUISITES` — the non-callable rest: types, settings keys,
//     pane-kind declarations, event-type registrations, error namespaces. These
//     never become port methods, because a method that dispatches nothing is a
//     fiction the compiler would then let callers depend on.
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

import { refuse, type ConsoleRefusal } from "../core/index.js";
import type { GrowthSlateRowId } from "./growth-slate.js";
import { growthSlateRow } from "./growth-slate.js";

/** Why the port refused. One member today; a closed set so a second is a decision. */
export const GROWTH_PORT_REFUSAL_CODES = ["wire-unregistered"] as const;

/** One growth-port refusal code. Derived, so the vocabulary is declared once. */
export type GrowthPortRefusalCode = (typeof GROWTH_PORT_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const GROWTH_PORT_REFUSAL_ORIGIN = "growth-port";

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
  | "providerSessionImportSubscribe";

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
};

/** Every non-callable prerequisite, keyed by id. Never a port method. */
export const GROWTH_PREREQUISITES: Readonly<Record<GrowthPrerequisiteId, GrowthPrerequisiteEntry>> =
  {
    browserPaneKindDeclaration: prerequisite(
      "browserPaneKindDeclaration",
      "browser-pane-namespace",
      "pane-kind",
      "the browser member of the closed pane-kind set",
    ),
    browserNodeSettings: prerequisite(
      "browserNodeSettings",
      "browser-pane-namespace",
      "settings-key",
      "the two node-wide browser settings",
    ),
    browserCallbackToolRows: prerequisite(
      "browserCallbackToolRows",
      "browser-tool-relay",
      "tool-registration",
      "browser tool set as callback-tool rows in the session registry",
    ),
    terminalWriteLeaseObligations: prerequisite(
      "terminalWriteLeaseObligations",
      "terminal-pane",
      "type-member",
      "the renderer's obligations under the shared-terminal write lease",
    ),
    onboardingErrorCodes: prerequisite(
      "onboardingErrorCodes",
      "onboarding-methods",
      "error-namespace",
      "the first-run error codes the frame renders",
    ),
    shellConfigPreferenceKeys: prerequisite(
      "shellConfigPreferenceKeys",
      "shell-config-preferences",
      "settings-key",
      "crash-report opt-out, the two browser switches, and the auto-update toggle",
    ),
    agentSnapshotAxisMembers: prerequisite(
      "agentSnapshotAxisMembers",
      "agent-snapshot-axes",
      "type-member",
      "the four attach-time snapshot axes as optional members on the agent-list reply",
    ),
    gitActionVocabulary: prerequisite(
      "gitActionVocabulary",
      "gitflow-actions",
      "type-member",
      "the closed vocabulary of git actions the surfaces may offer",
    ),
    gitflowErrorNamespace: prerequisite(
      "gitflowErrorNamespace",
      "gitflow-actions",
      "error-namespace",
      "the gitflow error codes the surfaces render",
    ),
    worktreeSetupRecipeCarrier: prerequisite(
      "worktreeSetupRecipeCarrier",
      "worktree-setup-recipe",
      "type-member",
      "the worktree setup-recipe carrier the repos surface renders",
    ),
    workflowEventTypeRegistration: prerequisite(
      "workflowEventTypeRegistration",
      "workflow-event-registration",
      "event-type",
      "the twenty-four workflow event types the run pane projects",
    ),
    workflowDefinitionScopeMeaning: prerequisite(
      "workflowDefinitionScopeMeaning",
      "workflow-definition-scope",
      "type-member",
      "what a project-scoped workflow-definition reference means",
    ),
    timelineEpochMember: prerequisite(
      "timelineEpochMember",
      "timeline-epoch-attestation",
      "type-member",
      "the timeline read's epoch member",
    ),
    timelineRevisionAttestationMember: prerequisite(
      "timelineRevisionAttestationMember",
      "timeline-epoch-attestation",
      "type-member",
      "the timeline read's revision-attestation member",
    ),
    timelinePathReferenceMember: prerequisite(
      "timelinePathReferenceMember",
      "timeline-path-reference",
      "type-member",
      "the validated path-reference member on timeline rows",
    ),
    approvalRememberedRuleMember: prerequisite(
      "approvalRememberedRuleMember",
      "approval-remembered-rule",
      "type-member",
      "the per-row remembered-rule match on approval rows",
    ),
    approvalAmendmentArm: prerequisite(
      "approvalAmendmentArm",
      "approval-amendment-arm",
      "type-member",
      "the amendment arm on the approval decision input",
    ),
    providerSessionImportSpec: prerequisite(
      "providerSessionImportSpec",
      "provider-session-import",
      "governing-document",
      "the spec that will govern provider-session import",
    ),
  };

/**
 * The refusal a live bridge returns for an unbuilt wire.
 *
 * The console's ONE refusal shape (`core/refusal.ts`), widened with what a growth
 * refusal knows and nothing else does: which operation was called, which slate row
 * it serves, and who owes the wire. `core/refusal.ts` names this port as one of the
 * five producers that had minted a refusal vocabulary of its own — the cost was
 * that a surface rendering a growth refusal beside a persistence one had to
 * translate between two shapes to reach one renderer. Extending means
 * `isConsoleRefusal` answers true here and `<RefusalCard {...outcome} />` works.
 *
 * `status` stays, and is not replaced by the presence of `code`: this value is one
 * arm of `GrowthOutcome`, and the discriminant is what makes the served arm
 * narrowable.
 */
export interface GrowthUnavailable extends ConsoleRefusal {
  readonly status: "unavailable";
  readonly code: GrowthPortRefusalCode;
  readonly operationId: GrowthOperationId;
  readonly slateRow: GrowthSlateRowId;
  readonly owningDocument: string;
}

/** A served result, from the fixture bridge. */
export interface GrowthServed<TValue> {
  readonly status: "served";
  readonly value: TValue;
}

export type GrowthOutcome<TValue> = GrowthServed<TValue> | GrowthUnavailable;

/** A subscription's served form: an async iterable the caller drains and closes. */
export interface GrowthStream<TEvent> {
  readonly events: AsyncIterable<TEvent>;
  close(): void;
}

// --- Operation signatures -------------------------------------------------
//
// One typed entry per operation. The request and value types are the CONSOLE's,
// derived from what its surfaces need — not a claim about the eventual wire shape,
// which belongs to the owning document. Where a shape is genuinely unknown to the
// console it is stated as a named empty request rather than `unknown`, so a caller
// that starts passing something has to come here and say what.

export interface GrowthNavigationState {
  readonly url: string;
  readonly title: string;
  readonly isLoading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface GrowthToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
}

export interface GrowthTerminalChunk {
  readonly terminalId: string;
  readonly data: string;
}

export interface GrowthArtifactSummary {
  readonly artifactId: string;
  readonly name: string;
  readonly byteLength: number;
  readonly contentType: string;
}

export interface GrowthSessionSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly state: string;
}

export interface GrowthInviteSummary {
  readonly inviteId: string;
  readonly state: string;
  readonly expiresAt: string;
}

export interface GrowthHealthReading {
  readonly component: string;
  readonly state: string;
  readonly observedAt: string;
}

export interface GrowthPaneError {
  readonly paneId: string;
  readonly reason: string;
}

export interface GrowthImportProgress {
  readonly importId: string;
  readonly turnsSeen: number;
  readonly state: string;
}

interface GrowthOperationSignatures {
  browserNavigate: { request: { readonly paneId: string; readonly url: string }; value: void };
  browserReload: { request: { readonly paneId: string }; value: void };
  browserStopLoading: { request: { readonly paneId: string }; value: void };
  browserGoBack: { request: { readonly paneId: string }; value: void };
  browserGoForward: { request: { readonly paneId: string }; value: void };
  browserSubscribeNavigation: {
    request: { readonly paneId: string };
    value: GrowthStream<GrowthNavigationState>;
  };
  browserSubscribeToolCalls: {
    request: { readonly sessionId: string };
    value: GrowthStream<GrowthToolCall>;
  };
  browserRespondToToolCall: {
    request: { readonly toolCallId: string; readonly resultJson: string };
    value: void;
  };
  terminalSubscribeOutput: {
    request: { readonly terminalId: string };
    value: GrowthStream<GrowthTerminalChunk>;
  };
  terminalWrite: { request: { readonly terminalId: string; readonly data: string }; value: void };
  terminalResize: {
    request: { readonly terminalId: string; readonly columns: number; readonly rows: number };
    value: void;
  };
  terminalAcquireWriteLease: {
    request: { readonly terminalId: string };
    value: { readonly granted: boolean };
  };
  terminalReleaseWriteLease: { request: { readonly terminalId: string }; value: void };
  devServerProbe: { request: { readonly port: number }; value: { readonly listening: boolean } };
  sessionRename: { request: { readonly sessionId: string; readonly title: string }; value: void };
  sessionArchive: { request: { readonly sessionId: string }; value: void };
  sessionClose: { request: { readonly sessionId: string }; value: void };
  sessionReactivate: { request: { readonly sessionId: string }; value: void };
  daemonStatusRead: {
    request: Record<string, never>;
    value: { readonly state: string; readonly version: string };
  };
  daemonStop: { request: Record<string, never>; value: void };
  daemonRestart: { request: Record<string, never>; value: void };
  onboardingStateRead: {
    request: Record<string, never>;
    value: { readonly completedStepIds: readonly string[]; readonly isComplete: boolean };
  };
  onboardingStepAdvance: { request: { readonly stepId: string }; value: void };
  onboardingStepSkip: { request: { readonly stepId: string }; value: void };
  onboardingComplete: { request: Record<string, never>; value: void };
  onboardingProviderSignInHandoff: { request: { readonly providerName: string }; value: void };
  shellConfigRead: { request: Record<string, never>; value: Readonly<Record<string, boolean>> };
  shellConfigWrite: { request: { readonly key: string; readonly enabled: boolean }; value: void };
  invitesList: { request: { readonly sessionId: string }; value: readonly GrowthInviteSummary[] };
  healthSubscribe: { request: Record<string, never>; value: GrowthStream<GrowthHealthReading> };
  gitActionExecute: {
    request: { readonly workspaceId: string; readonly action: string };
    value: { readonly accepted: boolean };
  };
  artifactIngestBegin: {
    request: { readonly sessionId: string; readonly name: string; readonly byteLength: number };
    value: { readonly ingestId: string };
  };
  artifactIngestWriteChunk: {
    request: { readonly ingestId: string; readonly offset: number; readonly byteLength: number };
    value: void;
  };
  artifactIngestComplete: { request: { readonly ingestId: string }; value: GrowthArtifactSummary };
  artifactList: {
    request: { readonly sessionId: string };
    value: readonly GrowthArtifactSummary[];
  };
  artifactRead: { request: { readonly artifactId: string }; value: GrowthArtifactSummary };
  artifactDelete: { request: { readonly artifactId: string }; value: void };
  artifactAllowlistRead: {
    request: { readonly sessionId: string };
    value: { readonly contentTypes: readonly string[]; readonly maximumByteLength: number };
  };
  artifactIngestAbort: { request: { readonly ingestId: string }; value: void };
  sessionSearch: { request: { readonly query: string }; value: readonly GrowthSessionSummary[] };
  windowDetachPane: { request: { readonly paneId: string }; value: { readonly windowId: string } };
  windowFocusAuxiliary: { request: { readonly windowId: string }; value: void };
  windowCloseAuxiliary: { request: { readonly windowId: string }; value: void };
  windowSubscribePaneErrors: {
    request: Record<string, never>;
    value: GrowthStream<GrowthPaneError>;
  };
  providerSessionImportBegin: {
    request: { readonly providerName: string; readonly sourceRef: string };
    value: { readonly importId: string };
  };
  providerSessionImportSubscribe: {
    request: { readonly importId: string };
    value: GrowthStream<GrowthImportProgress>;
  };
}

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
  const entry = GROWTH_OPERATIONS[operationId];
  const row = growthSlateRow(entry.slateRow);
  return {
    ...refuse(
      GROWTH_PORT_REFUSAL_ORIGIN,
      "wire-unregistered",
      `Not checked — ${row.wire} is not registered yet (${row.owningDocument} owns it).`,
    ),
    code: "wire-unregistered",
    status: "unavailable",
    operationId,
    slateRow: entry.slateRow,
    owningDocument: row.owningDocument,
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
  };
}

function op(
  id: GrowthOperationId,
  slateRow: GrowthSlateRowId,
  kind: GrowthOperationKind,
  summary: string,
  expectedWireMethod?: string,
): GrowthOperationEntry {
  return { id, slateRow, kind, summary, expectedWireMethod, liveStatus: "fixture-only" };
}

function prerequisite(
  id: GrowthPrerequisiteId,
  slateRow: GrowthSlateRowId,
  kind: GrowthPrerequisiteKind,
  summary: string,
): GrowthPrerequisiteEntry {
  return { id, slateRow, kind, summary, liveStatus: "fixture-only" };
}
