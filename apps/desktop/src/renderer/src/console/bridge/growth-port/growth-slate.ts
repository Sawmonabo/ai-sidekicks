// The console's in-tree mirror of `Plan-023 §Console growth slate`.
//
// The slate is the plan's honest ledger of every wire the console builds against
// the fixture and does not yet have. This module is that ledger as data, so the
// growth port and the scenario manifest can be checked against it by a test rather
// than by a reviewer's memory (I-023-13).
//
// The coupling the test enforces is the one the plan states: "a row leaves the
// table when its amendment lands; a console PR that wires a surface live against an
// unregistered wire is a review rejection". So every row here carries
// `wireRegistered: false` — that is what being ON the slate MEANS — and every port
// entry naming a row must declare itself fixture-only. When a wire lands, its row
// is deleted here and from the plan in the same PR, and the test then fails on the
// port entry that still claims fixture-only, which is exactly the reminder the
// console wants at that moment.

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
  | "notification-permission-read"
  | "shell-status-signals"
  | "onboarding-desktop-surface";

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

/**
 * Every row, keyed by its id.
 *
 * A `Record` keyed by `GrowthSlateRowId` rather than a bare array, and each value's
 * `id` pinned to its own key by the mapped type. The array this replaced listed the
 * rows a SECOND time beside the union above, and nothing checked the two agreed: an
 * id added to the union with no row beneath it compiled fine and threw at runtime
 * the first time a port entry named it. Both directions are now compile errors —
 * a missing row, an unknown key, and a row filed under the wrong id.
 *
 * Insertion order is the plan table's order and `Object.values` preserves it, so
 * `GROWTH_SLATE_ROWS` below still reads in table order for diff legibility.
 */
const GROWTH_SLATE_ROWS_BY_ID: {
  readonly [Id in GrowthSlateRowId]: GrowthSlateRow & { readonly id: Id };
} = {
  "browser-pane-namespace": {
    id: "browser-pane-namespace",
    wire: "browser pane kind, the browser bridge namespace, and the two node-wide browser settings",
    owningDocument:
      "Spec-023 §Preload Bridge Contract + §Console Design (Meridian); the embedded-browser Type-2 ADR",
    consumingSurface: "browser pane",
    wireRegistered: false,
  },
  "browser-tool-relay": {
    id: "browser-tool-relay",
    wire: "browser tool set as Spec-005 callback-tool rows plus the daemon-to-desktop tool-call relay",
    owningDocument: "Spec-005; the embedded-browser Type-2 ADR",
    consumingSurface: "browser pane",
    wireRegistered: false,
  },
  "terminal-pane": {
    id: "terminal-pane",
    wire: "terminal pane as a renderer surface with the shared-terminal write lease's renderer obligations",
    owningDocument: "Spec-003",
    consumingSurface: "terminal pane",
    wireRegistered: false,
  },
  "dev-server-probe": {
    id: "dev-server-probe",
    wire: "live-listener probe for the dev-server chip",
    owningDocument: "Spec-007, or the embedded-browser ADR",
    consumingSurface: "browser pane (the dev-server chip)",
    wireRegistered: false,
  },
  "session-lifecycle-verbs": {
    id: "session-lifecycle-verbs",
    wire: "session lifecycle verbs — rename, archive, close, reactivate",
    owningDocument: "Spec-001",
    consumingSurface: "all-sessions list, workspace header",
    wireRegistered: false,
  },
  "session-directory-read": {
    id: "session-directory-read",
    wire: "typed session snapshot read for a store's base state, and the participant's session directory read, over the daemon method union",
    owningDocument:
      "Spec-007 (the daemon method union); Spec-001 (the session.read payloads; no directory read is registered)",
    consumingSurface: "session-store initialisation, all-sessions list, auxiliary context picker",
    wireRegistered: false,
  },
  "daemon-control-methods": {
    id: "daemon-control-methods",
    wire: "daemon status-read, stop, and restart method strings",
    owningDocument: "Spec-007",
    consumingSurface: "settings daemon page",
    wireRegistered: false,
  },
  "onboarding-methods": {
    id: "onboarding-methods",
    wire: "the five-method onboarding registration and its error codes",
    owningDocument: "Plan-026",
    consumingSurface: "first-run frame",
    wireRegistered: false,
  },
  "shell-config-preferences": {
    id: "shell-config-preferences",
    wire: "shell-config preference carrier on the bridge (crash-report opt-out, the two browser switches, the auto-update toggle)",
    owningDocument: "Spec-023 §Preload Bridge Contract + §State And Data Implications",
    consumingSurface: "settings pages",
    wireRegistered: false,
  },
  "invites-list": {
    id: "invites-list",
    wire: "the invites list read",
    owningDocument: "Spec-002",
    consumingSurface: "invites surface",
    wireRegistered: false,
  },
  "health-subscribe": {
    id: "health-subscribe",
    wire: "the health subscription",
    owningDocument: "Spec-020",
    consumingSurface: "health strip, park banner",
    wireRegistered: false,
  },
  "agent-snapshot-axes": {
    id: "agent-snapshot-axes",
    wire: "the four `agent.*` verbs (roster read, attach, configuration update, detach) and the agent-list projection of the four attach-time snapshot axes (optional members)",
    owningDocument: "Spec-030, Spec-016",
    consumingSurface: "agent console, cast bar",
    wireRegistered: false,
  },
  // The linkage read is its own row rather than a member of the agent row above,
  // because it is a different namespace with a different owner: an agent is a
  // participant in a session and a child run is a relationship between two RUNS, and
  // the refusal fold it carries has no counterpart on any agent read.
  "child-run-linkage": {
    id: "child-run-linkage",
    wire: "one parent run's child-run links and the fold of the creates that were refused",
    owningDocument: "Spec-016",
    consumingSurface: "agent console run-linkage panel",
    wireRegistered: false,
  },
  "agent-provider-switch-failure": {
    id: "agent-provider-switch-failure",
    wire: "the `agent.provider_switch_failed` event type, so a deferred switch that could not be applied reaches a client that did not issue the mutation",
    owningDocument: "Spec-006, Plan-016",
    consumingSurface: "composer (the target chip)",
    wireRegistered: false,
  },
  "gitflow-actions": {
    id: "gitflow-actions",
    wire: "the branch-context read, the PR-preparation call, the git action-execute vocabulary, and the gitflow error namespace",
    owningDocument: "Spec-011",
    consumingSurface: "repos, diffs, and pull-request surfaces",
    wireRegistered: false,
  },
  // WHERE THE PANE'S SAVE GOES, AND WHY IT IS NOT A ROW HERE. An artifact read hands
  // back bytes, and the pane has to be able to put them somewhere — so the question is
  // whether that producer is missing too. It is not: `native.showSaveDialog` is on the
  // `SidekicksBridge` contract in `packages/contracts/src/desktop-bridge.ts` beside the
  // rest of the `native` namespace, and both bridges refuse it as an absent CAPABILITY
  // rather than an unregistered wire. A row here would be the wrong record of that —
  // this table's rows are wires no document registers, and adding one for a method the
  // contract already names would put a wire on the slate that has nothing to land.
  //
  // The residual is narrower and belongs to that package rather than to this one: its
  // `SaveDialogOptions` and `SaveDialogResult` are Tier-1 stubs declaring no member, so
  // a caller can neither suggest a filename nor read back the path a person chose. That
  // is a shape to fill in where it is declared, not a wire to register here, and it is
  // recorded at the row it would otherwise be minted against so the next reader does
  // not mint one.
  "artifact-ingest-and-crud": {
    id: "artifact-ingest-and-crud",
    wire: "attachment ingest method-name table and artifact CRUD method strings",
    owningDocument: "Plan-014",
    consumingSurface: "artifact pane",
    wireRegistered: false,
  },
  "artifact-allowlist-and-abort": {
    id: "artifact-allowlist-and-abort",
    wire: "effective allow-list read; ingest abort",
    owningDocument: "Spec-014",
    consumingSurface: "artifact pane",
    wireRegistered: false,
  },
  "worktree-setup-recipe": {
    id: "worktree-setup-recipe",
    wire: "the worktree setup-recipe carrier",
    owningDocument: "Spec-010",
    consumingSurface: "repos surface",
    wireRegistered: false,
  },
  "workflow-event-registration": {
    id: "workflow-event-registration",
    wire: "registration of the twenty-four workflow event types",
    owningDocument: "Spec-006, Spec-017",
    consumingSurface: "workflow-run pane",
    wireRegistered: false,
  },
  "workflow-definition-scope": {
    id: "workflow-definition-scope",
    wire: "the workflow-definition project-scope reference meaning",
    owningDocument: "Spec-017",
    consumingSurface: "workflow-builder pane",
    wireRegistered: false,
  },
  "timeline-epoch-attestation": {
    id: "timeline-epoch-attestation",
    wire: "the timeline read's epoch and revision-attestation member",
    owningDocument: "Spec-013",
    consumingSurface: "timeline pane",
    wireRegistered: false,
  },
  "timeline-path-reference": {
    id: "timeline-path-reference",
    wire: "validated path-reference member on timeline rows",
    owningDocument: "Spec-013",
    consumingSurface: "timeline pane",
    wireRegistered: false,
  },
  "approval-method-payloads": {
    id: "approval-method-payloads",
    wire: "registered request and reply payload shapes for the four `approval.*` methods the pane calls",
    owningDocument: "Plan-012",
    consumingSurface: "approvals pane",
    wireRegistered: false,
  },
  "approval-remembered-rule": {
    id: "approval-remembered-rule",
    wire: "per-row remembered-rule match on approval rows",
    owningDocument: "Spec-012",
    consumingSurface: "approvals pane",
    wireRegistered: false,
  },
  "approval-amendment-arm": {
    id: "approval-amendment-arm",
    wire: "the approval amendment arm",
    owningDocument: "Spec-012",
    consumingSurface: "approvals pane",
    wireRegistered: false,
  },
  "session-goal-methods": {
    id: "session-goal-methods",
    wire: "registered request and reply payload shapes for `session.goalUpdate` and `session.goalClear`",
    owningDocument: "Plan-016",
    consumingSurface: "approvals pane (the session goal card)",
    wireRegistered: false,
  },
  "session-search": {
    id: "session-search",
    wire: "the session-search query surface",
    owningDocument: "Spec-001",
    consumingSurface: "palette, all-sessions list",
    wireRegistered: false,
  },
  "window-control-namespace": {
    id: "window-control-namespace",
    wire: "window-control bridge namespace — renderer-initiated pane detach into an auxiliary window, auxiliary-window focus and close, and the crashed-window pane-error signal",
    owningDocument: "Spec-023 §Preload Bridge Contract + §Console Design (Meridian)",
    consumingSurface: "session workspace deck, auxiliary windows",
    wireRegistered: false,
  },
  "provider-session-import": {
    id: "provider-session-import",
    wire: "provider-session import ingest",
    owningDocument: "a new spec",
    consumingSurface: "import flow",
    wireRegistered: false,
  },
  "attention-plane": {
    id: "attention-plane",
    wire: "the attention projection read and the notification preference pair, with the `AttentionItem` trigger and severity domains they carry",
    owningDocument:
      "Spec-019 §Interfaces And Contracts (the three operations); Plan-019 (the `packages/contracts/src/attention/` schemas, which no code package carries)",
    consumingSurface: "notification centre, icon-rail attention marker",
    wireRegistered: false,
  },
  "workflow-run-control": {
    id: "workflow-run-control",
    wire: "nine of the thirteen workflow method strings — the definition enumeration, the run start and read, the operator cancel and resume pair, the phase-output read, the gate resolve, the human-form submit, and the gate-chain verify — with the run, phase, definition, and output shapes they carry",
    owningDocument:
      "Spec-017 §Interfaces And Contracts (the definition, run, gate, phase-output, and human-form operations) + §Operator run control (SA-45) (the cancel and resume pair); Plan-017 (the shared-contracts and client-SDK registration, which no code package carries)",
    consumingSurface: "workflow-run pane, workflow builder",
    wireRegistered: false,
  },
  "workflow-run-enumeration": {
    id: "workflow-run-enumeration",
    wire: "a read of the workflow runs a session holds. Registered nowhere, and not one of the thirteen rows the row above draws on: every registered run operation addresses ONE run by an id the caller must already hold, so a surface that lists runs has no wire to ask and no id to ask it with",
    owningDocument:
      "Spec-017 §Interfaces And Contracts (the run operations, none of which enumerates); Plan-017 (the shared-contracts and client-SDK registration an enumeration would join)",
    consumingSurface: "workflows destination (the runs it holds)",
    wireRegistered: false,
  },
  "caller-participant-identity": {
    id: "caller-participant-identity",
    wire: "the caller's own participant identity — which of a session's projected participants this window IS",
    owningDocument:
      "api-payload-contracts.md §Authenticated Principal And Authorization Model (the resolved principal's outbound disposition, which that section does not yet carry); Spec-018 §Interfaces And Contracts (the reply shape)",
    consumingSurface: "members surface (invite create), approvals pane (the role-gated control)",
    wireRegistered: false,
  },
  "callback-tool-registry-read": {
    id: "callback-tool-registry-read",
    wire: "a read of a session's registered callback-tool set, which rides only the spawn and resume parameters and has no read seam",
    owningDocument:
      "Spec-005 §Required Behavior (the session callback-tool registry); api-payload-contracts.md §Plan-005 — Provider Driver Contract (Internal Interface) (the SessionCallbackTool shape and the client-facing driver namespace a read verb would join)",
    consumingSurface: "approvals pane",
    wireRegistered: false,
  },
  "sidekick-definition-registry": {
    id: "sidekick-definition-registry",
    wire: "all five sidekick method strings — the definition list, create, update, and delete, plus the per-session peer-invocation grant — with the saved-definition shape and the five definition-plane refusal codes they carry",
    owningDocument:
      "Spec-030 §Interfaces And Contracts; Plan-030 §API And Transport Changes (the shapes are registered in api-payload-contracts.md and the codes in error-contracts.md, and no code package carries either)",
    consumingSurface: "sidekick-definitions page, agent console peer-invocation control",
    wireRegistered: false,
  },
  "hydrated-event-read": {
    id: "hydrated-event-read",
    wire: "the hydrated event read that pairs a verified event row with its opened machine-authored body, and the participant-text body no arm of that read opens",
    owningDocument:
      "Spec-006 §Assistant Output (assistant_output); Plan-006 §Phase 3B — Machine-authored content column (explicit-label supplement) (the HydratedSessionEvent projection over session_events.content_payload, which the daemon builds and no bridge namespace serves; the participant half rides session_events.pii_payload under the same document and has no read projection at all)",
    consumingSurface: "timeline pane, ledger rows",
    wireRegistered: false,
  },
  "cost-receipt-read": {
    id: "cost-receipt-read",
    wire: "the session cost receipt read and the orchestration budget read — the committed-spend fold and its per-run, per-caused-by, and per-paying-account decomposition",
    owningDocument:
      "Spec-016 §Session Cost Receipt (the decomposition and its two partition identities); api-payload-contracts.md §Plan-016 (the two method strings and their reply shapes, registered there and in no code package)",
    consumingSurface: "cost-receipt settings page, cost meters",
    wireRegistered: false,
  },
  "workflow-version-chain": {
    id: "workflow-version-chain",
    wire: "a read of the version chain one run's pinned version belongs to, addressed by that opaque version id. Registered nowhere, and the mirror image of the row above it: workflow.versionRead addresses a version by (definitionId, versionNumber) and the definition enumeration carries only each definition's latest, so a surface holding a run's pin holds no way to name any other version of the same definition",
    owningDocument:
      "Spec-017 §Interfaces And Contracts (the definition and version operations, none of which resolves a version id); Plan-017 (the shared-contracts and client-SDK registration a chain read would join)",
    consumingSurface: "workflow-run pane (the resume control's re-pin picker)",
    wireRegistered: false,
  },
  "notification-permission-read": {
    id: "notification-permission-read",
    wire: "the shell's own reading of whether this machine will display an OS notification for this application. `native.showNotification` is on the preload contract and returns void, so the renderer cannot observe a denial through it, and no bridge member reports the permission",
    owningDocument:
      "Spec-023 §Preload Bridge Contract + §Main Process Responsibilities (which own OS notification emission and the do-not-disturb honouring, and register no permission read); Spec-019 §Fallback Behavior (the in-app-only fallback the reading selects)",
    consumingSurface: "notification centre (the OS-notifications-denied arm)",
    wireRegistered: false,
  },
  "shell-status-signals": {
    id: "shell-status-signals",
    wire: "the shell's own status as one feed — the daemon supervisor's step and its attempt count out of five, the daemon.hello negotiation ack (compatible, protocolVersion, reason, daemonSupportedProtocols), the loopback-fallback signal, and the keystore-unavailable signal. Every one of them is a main-process fact and none of them is a daemon call: the renderer is not a direct daemon client, the ack belongs to the connection the main process holds, and a second handshake from here would be refused as one already completed",
    owningDocument:
      "Spec-023 §Preload Bridge Contract (no namespace carries any of it); Spec-023 §Daemon Supervision Lifecycle (the six steps and the five-attempt ladder), §Fallback Behavior (the loopback fallback and the offline read-only mode), §Native Keystore (the memory-only degradation); Spec-007 (the DaemonHelloAck shape, which packages/contracts publishes and no bridge namespace serves)",
    consumingSurface:
      "frame shell-state chrome — the daemon chip, the version banner, the reconnect and read-only banners, and the loopback/keystore notice strip",
    wireRegistered: false,
  },
  "onboarding-desktop-surface": {
    id: "onboarding-desktop-surface",
    wire: "`onboarding.presentChoice` and `onboarding.telemetryPrompt`, the two preload-bridge methods `Spec-026 §Desktop Surface` names — the main-process hosts for the relay choice's secret entry and the telemetry answer",
    owningDocument:
      "Spec-023 §Preload Bridge Contract (which admits `onboarding` by name); Spec-026 §Desktop Surface",
    consumingSurface: "first-run onboarding (group A)",
    wireRegistered: false,
  },
};

/**
 * The rows, in the plan table's order. Order is load-bearing only for diff
 * legibility; every lookup keys on ids.
 */
export const GROWTH_SLATE_ROWS: readonly GrowthSlateRow[] = Object.values(GROWTH_SLATE_ROWS_BY_ID);

/**
 * Row lookup.
 *
 * Total, and it did not used to be: the linear search this replaced threw a
 * `RangeError` on an id with no row, which is the right behaviour for a set the
 * compiler cannot close and the wrong shape for one it can. The record above is
 * exhaustive over `GrowthSlateRowId`, so a typo is now a compile error at the call
 * site and there is no runtime arm left to take.
 */
export function growthSlateRow(id: GrowthSlateRowId): GrowthSlateRow {
  return GROWTH_SLATE_ROWS_BY_ID[id];
}
