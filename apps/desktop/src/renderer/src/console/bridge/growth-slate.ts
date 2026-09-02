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
  | "gitflow-actions"
  | "artifact-ingest-and-crud"
  | "artifact-allowlist-and-abort"
  | "worktree-setup-recipe"
  | "workflow-event-registration"
  | "workflow-definition-scope"
  | "timeline-epoch-attestation"
  | "timeline-path-reference"
  | "approval-remembered-rule"
  | "approval-amendment-arm"
  | "session-search"
  | "window-control-namespace"
  | "provider-session-import"
  | "attention-plane";

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
    wire: "agent-list projection of the four attach-time snapshot axes (optional members)",
    owningDocument: "Spec-030, Spec-016",
    consumingSurface: "agent console, cast bar",
    wireRegistered: false,
  },
  "gitflow-actions": {
    id: "gitflow-actions",
    wire: "the git action-execute vocabulary and the gitflow error namespace",
    owningDocument: "Spec-011",
    consumingSurface: "repos, diffs, and pull-request surfaces",
    wireRegistered: false,
  },
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
