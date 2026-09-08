// What a growth-slate row IS, and which rows exist — the closed vocabulary the
// ledger beside this file fills in.
//
// SPLIT OFF `growth-slate.ts` ON `growth-entry.ts`'S OWN SEAM. That module states the
// rule this one applies: a row's CONTENT is its table's and a row's SHAPE is a
// type-only module's, because a type-only module has no reason to change when a row
// lands. The ledger is prose — four sentences per row, fifty-eight rows — and it had
// grown past the size the structure rules set while carrying this vocabulary as well.
//
// THE UNION IS HERE AND THE ROWS ARE NEXT DOOR, WHICH THE COMPILER STILL PAIRS.
// `GROWTH_SLATE_ROWS_BY_ID` is a mapped type over this union, so a member added here
// with no row beneath it is a compile error in that module and a row filed under an
// unknown key is a compile error too. Splitting the two apart costs neither check.
//
// EVERY READER THAT NEEDS ONLY THE VOCABULARY TAKES THIS MODULE — the entry tables in
// `growth-operations/` and `growth-prerequisites.ts`, the outcome ledger, and the
// scenario manifest. Only a reader that needs the ROWS reaches `growth-slate.ts`,
// which is the edge that keeps the ledger's churn out of everything downstream of it.

/** A row's stable identifier. Used by port entries and by the manifest. */
export type GrowthSlateRowId =
  | "browser-pane-namespace"
  | "browser-tool-relay"
  | "terminal-pane"
  | "dev-server-probe"
  | "session-lifecycle-verbs"
  | "session-directory-read"
  | "daemon-control-methods"
  | "onboarding-methods"
  | "shell-config-preferences"
  | "invites-list"
  | "health-subscribe"
  | "agent-snapshot-axes"
  | "child-run-linkage"
  | "agent-provider-switch-failure"
  | "agent-provider-switch-terminal"
  | "gitflow-actions"
  | "artifact-ingest-and-crud"
  | "artifact-allowlist-and-abort"
  | "worktree-setup-recipe"
  | "workflow-event-registration"
  | "workflow-definition-scope"
  | "timeline-epoch-attestation"
  | "timeline-path-reference"
  | "approval-method-payloads"
  | "approval-remembered-rule"
  | "approval-amendment-arm"
  | "session-goal-methods"
  | "session-search"
  | "window-control-namespace"
  | "provider-session-import"
  | "attention-plane"
  | "workflow-run-control"
  | "workflow-run-enumeration"
  | "caller-participant-identity"
  | "callback-tool-registry-read"
  | "sidekick-definition-registry"
  | "hydrated-event-read"
  | "cost-receipt-read"
  | "workflow-version-chain"
  | "workspace-execution-context"
  | "mount-health-identity-verdict"
  | "channel-lifecycle-verbs"
  | "channel-roster-read"
  | "membership-roster-read"
  | "participant-presence-detail"
  | "terminal-control-holder"
  | "presence-activity-fields"
  | "control-plane-host"
  | "pending-invite-namespace"
  | "notification-permission-read"
  | "shell-status-signals"
  | "onboarding-desktop-surface"
  | "workflow-definition-authoring"
  | "health-diagnostics-reads"
  | "provider-account-signin-and-token"
  | "mcp-governance-plane"
  | "node-self-declaration"
  | "workflow-human-form-schema";

export interface GrowthSlateRow {
  readonly id: GrowthSlateRowId;
  /** The wire the console needs, in the plan table's own words. */
  readonly wire: string;
  /** The document that owns registering it. */
  readonly owningDocument: string;
  /** The console surface family that consumes it. */
  readonly consumingSurface: string;
  /**
   * Always false while the row is on the slate. Present as a field rather than
   * implied so the test's assertion reads as a check rather than a tautology, and
   * so the day a row is half-landed the discrepancy is representable.
   */
  readonly wireRegistered: false;
}
