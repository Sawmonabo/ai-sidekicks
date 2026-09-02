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
//
// AND NOT HERE EITHER: A VOCABULARY `@ai-sidekicks/contracts` ALREADY SHIPS. The
// console's own vocabularies below exist because the corpus registers them in a
// document and no code package carries them. Where a package DOES carry one, the
// member names the package's type and this module declares nothing. `billingMode` is
// that case, and the comment on it says what the second union cost.

import type { BillingMode } from "@ai-sidekicks/contracts";

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
/**
 * What `AttachmentIngestComplete` answers once the daemon has the bytes. Mirrors
 * `api-payload-contracts.md` `AttachmentIngestCompleteResponse` member-for-member:
 * the derived truth that replaces the caller's declaration, never the manifest —
 * a completion is the pipeline's verdict on one payload, and the manifest it
 * committed is read through `artifactRead`.
 */
export interface GrowthAttachmentIngestCompletion {
  readonly artifactId: string;
  readonly contentHash: string;
  readonly normalizedName: string;
  /** Server-derived from the payload signature; the declared type is never recorded. */
  readonly derivedMediaType: string;
  /** Server-derived byte length of the spooled payload; authoritative over the declared bound. */
  readonly derivedSizeBytes: number;
}

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

// session cost

/**
 * Whether a figure is fully priced. Aggregate reuse of the row-level usage vocabulary.
 *
 * A type alias rather than a value list because nothing here enumerates it: the wire
 * supplies the reading and the console renders it, and `Spec-016 §Cost Figure Display
 * Consistency` makes it observability only — a surface that branched enforcement on it
 * would be a second trust regime over a number the daemon already settled.
 */
export type GrowthCostStatus = "priced" | "unpriced";

/**
 * The session's limits and its committed spend, mirrored member-for-member from
 * `OrchestrationBudgetState` in
 * `docs/architecture/contracts/api-payload-contracts.md` (the budget read and update
 * replies carry this same shape, and the cost receipt's session total IS it).
 *
 * Mirrored rather than imported because no code package carries the type — the shape
 * is registered in that document and nowhere else, which is the whole of what this
 * row's slate entry says. The four decomposition members at the end are not new
 * arithmetic: `observedPricedCostCents + observedUnpricedDebitCents` is
 * `observedCostCents`, and `observedCostCents + reservedCostCents` is
 * `committedSpendCents`, which is the enforced figure every surfaced session cost
 * renders — never a sum the renderer takes over a visible run list.
 */
export interface GrowthBudgetState {
  readonly sessionId: string;
  readonly costLimitCents: number;
  readonly turnLimitPerAgent: number;
  readonly maxExecutingChannels: number;
  readonly maxQueueDepthPerChannel: number;
  readonly maxPendingOrchestrationRuns: number;
  readonly activeChildLimit: number;
  readonly unpricedFamilyCaps: readonly GrowthUnpricedFamilyCap[];
  readonly observedCostCents: number;
  readonly reservedCostCents: number;
  readonly observedPricedCostCents: number;
  readonly observedUnpricedDebitCents: number;
  readonly committedSpendCents: number;
  readonly costStatus: GrowthCostStatus;
}

/** One owner-supplied escape for a model family the wire prices at nothing. */
export interface GrowthUnpricedFamilyCap {
  readonly modelFamily: string;
  readonly hardCapUsdCents: number;
}

/**
 * The party a unit of work is attributed to — the turn-scoped effective principal,
 * carried verbatim from the metered rows the receipt folds.
 *
 * Two closed arms with the participant reference required on the participant arm and
 * absent on the system arm, rather than one nullable id: an unstamped value and a
 * deliberately-unattributed one would otherwise be the same shape, and spend no
 * participant caused — a sweep, an idle settlement, a recovery turn — is a real answer
 * rather than a missing one.
 */
export type GrowthEffectivePrincipal =
  | { readonly kind: "participant"; readonly participantId: string }
  | { readonly kind: "system" };

/**
 * The receipt: one session figure, decomposed three ways.
 *
 * Each axis is a PARTITION of the same spend, so each totals to
 * `sessionTotal.committedSpendCents`. A surface asserting that is asserting no row was
 * double-counted or dropped, which is the one property a receipt is for.
 */
export interface GrowthCostReceipt {
  readonly sessionTotal: GrowthBudgetState;
  readonly runs: readonly GrowthCostReceiptRunRow[];
  readonly causedBy: readonly GrowthCostReceiptCausedByRow[];
  readonly byAccount: readonly GrowthCostReceiptAccountRow[];
}

export interface GrowthCostReceiptRunRow {
  readonly runId: string;
  readonly costCents: number;
  readonly costStatus: GrowthCostStatus;
  /**
   * Required and closed at one literal. The receipt is the one surface emitting
   * run-scoped cost figures, and every row carrying the declaration is what makes that
   * verifiable positively rather than by nobody having added a second scope.
   */
  readonly aggregationScope: "run-only";
}

export interface GrowthCostReceiptCausedByRow {
  readonly party: GrowthEffectivePrincipal;
  readonly costCents: number;
  readonly costStatus: GrowthCostStatus;
}

export interface GrowthCostReceiptAccountRow {
  readonly providerAccountId: string;
  readonly displayLabel: string;
  /**
   * How the account is billed. The CONTRACTS type, imported rather than restated.
   *
   * This member used to name a local `GrowthBillingMode` spelling the same three
   * arms, and a closed set with two homes drifts in exactly one direction: the
   * package widens its union, the console still compiles, and the new arm arrives
   * on the wire as a value this surface cannot represent — rendered as whichever
   * label the fallback happens to be, which is a spend claim nothing supports.
   * `provider-account.ts` is where the arms and the reason `unknown` is one of them
   * are stated; there is no second name for them here, because a name here would be
   * the same defect with an alias in front of it.
   */
  readonly billingMode: BillingMode;
  readonly costCents: number;
  readonly costStatus: GrowthCostStatus;
}
