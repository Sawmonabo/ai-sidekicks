// The named values growth-port replies are made of.
//
// One interface per shape a served operation answers with, plus the one closed
// vocabulary those shapes read from. They are the CONSOLE's, derived from what its
// surfaces render — not a claim about the eventual wire shape, which belongs to the
// document named on the operation's slate row.
//
// WHY THEY ARE NOT IN THE SIGNATURE TABLE. Most request and reply shapes ARE stated
// inline next door in `growth-signatures.ts`, and that is the default: a shape read
// once at one call site earns no name. A shape lands here when it has a second
// reader — `GrowthSessionSummary` is one the fixture port constructs and the family
// barrel publishes — or when naming it is what lets two operations answer with the
// same thing rather than two spellings of it. The table then reads as a table.
//
// WHAT IS NOT HERE. Shapes that carry their own vocabulary AND several members,
// which take a module each on the `attention-projection.ts` precedent and state a
// deletion obligation there. The line is drawn where it stops being a value and
// starts being a domain.

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

/**
 * The artifact families the manifest discriminates. Closed, declared once, derived
 * below — `docs/architecture/contracts/api-payload-contracts.md` §ArtifactManifest's
 * `ArtifactType`, which is the five families `Spec-014 §Required Behavior` enumerates
 * plus the workflow phase-output type.
 */
export const GROWTH_ARTIFACT_TYPES = [
  "file",
  "diff",
  "summary",
  "log",
  "design",
  "workflow_output",
] as const;

/** One artifact family. Derived, so the vocabulary has exactly one home. */
export type GrowthArtifactType = (typeof GROWTH_ARTIFACT_TYPES)[number];

/**
 * The visibility classes an artifact carries.
 *
 * Two, and the distinction is the one `Spec-014 §Required Behavior` makes load-bearing:
 * visibility is explicit and `local-only` is a different fact from shared-visible.
 * Partial per-participant redaction is deliberately absent — that spec puts it out of
 * V1 scope, and a third value here would let a surface offer a state nothing serves.
 */
export const GROWTH_ARTIFACT_VISIBILITIES = ["local-only", "shared"] as const;

/** One visibility class. Derived, so the vocabulary has exactly one home. */
export type GrowthArtifactVisibility = (typeof GROWTH_ARTIFACT_VISIBILITIES)[number];

/** The lifecycle states a manifest row is in. */
export const GROWTH_ARTIFACT_STATES = ["pending", "published", "superseded"] as const;

/** One manifest lifecycle state. Derived, so the vocabulary has exactly one home. */
export type GrowthArtifactState = (typeof GROWTH_ARTIFACT_STATES)[number];

/**
 * Where this node's copy of a shared artifact's payload stands.
 *
 * Read as PERSISTED, never recomputed from live relay state — which is exactly what
 * makes it renderable: an unresolved-attachment marker carries a non-`pinned` status
 * verbatim as its cause, and `expired` reads as "payload not obtainable, remedy is a
 * re-publish" rather than narrowly as "TTL elapsed".
 */
export const GROWTH_ARTIFACT_REPLICATION_STATUSES = [
  "pending_replication",
  "pinned",
  "over_cap",
  "quota_exceeded",
  "expired",
] as const;

/** One replication status. Derived, so the vocabulary has exactly one home. */
export type GrowthArtifactReplicationStatus = (typeof GROWTH_ARTIFACT_REPLICATION_STATUSES)[number];

/**
 * One artifact as the manifest envelope carries it.
 *
 * Mirrored member-for-member from the registered `ArtifactManifest` in
 * `docs/architecture/contracts/api-payload-contracts.md` §ArtifactManifest — the
 * OCI-inspired envelope `Spec-014 §Interfaces And Contracts` states, plus the
 * daemon-persisted `visibility` / `state` / `metadata` fields the wire shape adds.
 * `packages/contracts` registers no artifact schema yet (Plan-014 Task 1 mints it in
 * `packages/contracts/src/artifacts/`), so the architecture contract is the source,
 * named here so the mirror is checkable by reading one section rather than by memory.
 *
 * ONE MEMBER IS SPELLED DIFFERENTLY, AND ONLY ONE. The envelope's `id` is
 * `artifactId` here, because a bare `id` on a value a renderer passes around says
 * nothing about what it identifies and the console's own request shapes already name
 * this scalar `artifactId`. Every other member keeps the envelope's spelling exactly,
 * including the two maps whose whole point is that they are distinct: `annotations`
 * is the OCI string-to-string map and `metadata` is freeform daemon-side provenance.
 *
 * WHAT THE OLD SHAPE HAD, AND WHERE IT WENT. `byteLength` is the envelope's `size`;
 * `contentType` is not a member at all — a media type is daemon-side provenance and
 * rides `metadata` — and `name` likewise has no envelope member: a file's declared
 * name reaches the manifest through `annotations`. The thin shape refused a served
 * list as an unmapped list shape, which is what a summary that is three members of a
 * fourteen-member record does the first time a surface needs the rest of them.
 */
export interface GrowthArtifactSummary {
  readonly artifactId: string;
  readonly sessionId: string;
  /** Absent when no run produced the artifact. */
  readonly runId?: string;
  /**
   * The publishing caller, absent when the daemon itself produced the artifact with
   * no attributable one. Optional for that reason rather than for convenience: the
   * delete-own-artifacts scope evaluates the column this mirrors fail-closed, so an
   * absent value matches no collaborator.
   */
  readonly createdBy?: string;
  readonly artifactType: GrowthArtifactType;
  /** The OCI `digest` (SHA-256). Required: a content-addressed manifest always has one. */
  readonly digest: string;
  /** The payload's byte length. Server-derived, so always present. */
  readonly size: number;
  readonly annotations: Readonly<Record<string, string>>;
  /** Present only on a derivative manifest, naming the source it was derived from. */
  readonly subject?: string;
  readonly visibility: GrowthArtifactVisibility;
  readonly state: GrowthArtifactState;
  /** Absent on a local-only artifact, which has no replication to report. */
  readonly replicationStatus?: GrowthArtifactReplicationStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface GrowthSessionSummary {
  readonly sessionId: string;
  /**
   * Optional because a session may genuinely have no name, and
   * `Spec-023 §Console Design (Meridian)` says what happens then: it renders by its
   * identifier, never by an invented title. A required member would force every
   * producer to supply one, and the only value a producer without a title can
   * supply is a fabrication.
   */
  readonly title?: string;
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

/**
 * One notification preference, as both the read reply and the update request carry it.
 *
 * `Spec-019 §Interfaces And Contracts` requires the preference pair to "support
 * per-surface preferences", and `Spec-019 §Resolved Questions and V1 Scope Decisions`
 * scopes the store itself to global-per-participant in V1 — so the console's shape is
 * an opaque keyed value rather than an enumeration of surfaces, and stays that way
 * until a document names the keys. Read and update share one declaration because they
 * are the two sides of one record: two copies would let the reply and the request
 * disagree about what a preference IS, which is a disagreement nothing here can catch.
 */
export interface GrowthAttentionPreference {
  readonly key: string;
  readonly value: Readonly<Record<string, unknown>>;
}

/**
 * One tool the daemon has exposed into a session, as the registry read returns it.
 *
 * The registered shape is the function-form provider tool: a name, a description, and
 * a JSON Schema for the arguments. `inputSchema` stays an opaque record rather than a
 * parsed schema type because it IS a JSON Schema document and the console neither
 * validates against it nor compiles it — the approvals pane renders what a tool takes,
 * and a parsed type here would be a second schema vocabulary with one reader.
 *
 * A named value rather than an inline reply shape because the read answers with a
 * LIST of them: the element type is what a surface's props and its row component both
 * name, which is the second reader this module's header asks for.
 */
export interface GrowthCallbackTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

// gitflow

/**
 * A writable run's branch context, as `Spec-011 §Interfaces And Contracts`
 * requires the read to expose it — base, head, upstream, and worktree association.
 *
 * The three optional members are optional on the wire for structural reasons, not
 * for convenience, and the reasons are worth carrying: `upstreamRef` is absent
 * until the head branch has one, and `worktreeId` / `ephemeralCloneId` are present
 * only on the anchoring their context actually has (`branch_contexts` carries an
 * at-most-one association CHECK). A required member here would force a producer to
 * supply a value for an anchoring the context does not have, and the only value it
 * could supply is a fabrication.
 */
export interface GrowthBranchContext {
  readonly branchContextId: string;
  readonly workspaceId: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly upstreamRef?: string;
  readonly worktreeId?: string;
  readonly ephemeralCloneId?: string;
}

/**
 * The states a prepared pull request is in. Closed, declared once, derived below.
 *
 * `Spec-011 §Required Behavior` makes PR preparation reviewable BEFORE any remote
 * mutation, and these two are what that review is between: a proposal still being
 * assembled and one a person may send. Neither names a remote state — nothing here
 * has talked to a git host.
 */
export const GROWTH_PR_PREPARATION_STATES = ["draft", "ready"] as const;

/** One prepared-pull-request state. Derived, so the vocabulary has one home. */
export type GrowthPrPreparationState = (typeof GROWTH_PR_PREPARATION_STATES)[number];
