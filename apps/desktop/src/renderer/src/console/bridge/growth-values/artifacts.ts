// The artifact plane's values: the manifest's four closed vocabularies, the ingest
// completion, the summary, the read's two arms, and the delete's receipt.
//
// The largest domain here by a wide margin, and the reason this directory exists:
// it used to sit above the session, attention, gitflow, and cost-receipt values in
// one module, so five independent wire surfaces shared one maintenance boundary.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys — why a shape earns a name, what belongs in the
// signature table instead, and what belongs in a module of its own — and publishes
// the whole set. Import from the barrel; this file is the domain's own text.

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
 *
 * AND WHAT IT STILL HAS NO MEMBER FOR, CHECKED RATHER THAN ASSUMED. There is no
 * `ArtifactSummary` anywhere in that document — `ArtifactManifest` is the one
 * registered envelope — and it registers neither a content-type member nor an expiry
 * one. The media type is the `metadata` provenance above, and the nearest thing to an
 * expiry is `replicationStatus: "expired"`, which the wire records as "payload not
 * obtainable, remedy is a re-publish" rather than as an instant: a deadline member
 * here would be a figure this console could render and no daemon could supply. So the
 * mirror gains nothing for either, and this paragraph is why, rather than the absence
 * being read as an oversight by the next reader who looks.
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

/**
 * How an inline artifact payload's bytes are encoded.
 *
 * A type alias rather than a value list, on the `GrowthCostStatus` rule below:
 * nothing here enumerates the arms, the wire supplies the reading and the reader
 * switches on it. The contract is explicit that a reader switches and never sniffs,
 * which is the whole reason the member exists beside `payload` rather than being
 * inferred from it.
 */
export type GrowthArtifactPayloadEncoding = "utf8" | "base64";

/**
 * What an artifact read answers with: the manifest, and a way to reach the bytes.
 *
 * Mirrored member-for-member from the registered `ArtifactReadResponse` in
 * `docs/architecture/contracts/api-payload-contracts.md` — all four members, and the
 * manifest NESTED rather than flattened, because that is the shape the wire sends and a
 * console value that hoisted the envelope's members up beside `payload` would be a
 * second spelling of a record `GrowthArtifactSummary` already mirrors.
 *
 * WHY THIS IS A VALUE AND NOT THE SUMMARY ITSELF. `artifactRead` used to answer with
 * the bare manifest, which made the pane's two reads indistinguishable: a metadata read
 * and a payload fetch are one call separated by `includePayload`, and with no member to
 * carry the answer the second was unrepresentable — a surface could ask for bytes and
 * had nowhere to receive them.
 *
 * WHY IT IS CORRELATED ARMS AND NOT THREE INDEPENDENT OPTIONALS. Three optionals admit
 * eight combinations and the contract registers two. The other six are replies a pane
 * would compile against and could not act on: a bare manifest with neither a handle nor
 * inline content leaves the served path with no way to REACH the bytes, a `payload`
 * with no `payloadEncoding` leaves it with no way to DECODE them, and a
 * `payloadEncoding` with no payload describes bytes that are not there. The contract
 * says both halves of this — `Spec-014 §Interfaces And Contracts` requires a read to
 * return "manifest plus retrievable payload handle or inline content", and the
 * registered response comments the encoding as "present when payload is" — so the arms
 * below are the registration read as it is written rather than a console tightening.
 *
 * TWO ARMS, NOT THREE. Deferred is a handle and no bytes; inline is the bytes with the
 * encoding to read them by. The metadata read — `includePayload` absent — lands on the
 * DEFERRED arm rather than in an arm of its own: the handle is the CAS key, which a
 * manifest read has already resolved and which costs nothing to return, and a third
 * arm carrying neither would be exactly the unreachable reply this union exists to
 * refuse. "I asked for the bytes and did not get them inline" — the caller asked and
 * the encoded member would not fit the wire's frame ceiling — is that same arm, and it
 * is a real served answer a surface has to draw rather than a refusal.
 *
 * The inline arm leaves `payloadHandle` OPTIONAL rather than forbidding it, because the
 * contract does not: a reply may hand back both, and a union that refused the pair
 * would be the console deciding something the wire has not.
 */
export type GrowthArtifactRead = GrowthArtifactReadDeferred | GrowthArtifactReadInline;

/** What both arms carry: the envelope the read is about. */
interface GrowthArtifactReadBase {
  readonly manifest: GrowthArtifactSummary;
}

/** The reply that hands back a key to fetch the bytes with, rather than the bytes. */
export interface GrowthArtifactReadDeferred extends GrowthArtifactReadBase {
  /** The CAS key or URL for deferred retrieval. Required on this arm: it IS this arm. */
  readonly payloadHandle: string;
  readonly payload?: never;
  readonly payloadEncoding?: never;
}

/** The reply that carries the bytes, and the encoding a reader switches on. */
export interface GrowthArtifactReadInline extends GrowthArtifactReadBase {
  /** Permitted beside the bytes, because the registered response permits it. */
  readonly payloadHandle?: string;
  /** The bytes, present when `includePayload` was set and the size permitted. */
  readonly payload: string;
  /** Present exactly when `payload` is. Read, never sniffed from the bytes. */
  readonly payloadEncoding: GrowthArtifactPayloadEncoding;
}

/**
 * What became of the payload behind a deleted manifest.
 *
 * Three arms and no boolean, on the contract's own reasoning: the bytes were unlinked,
 * another manifest still names the shared payload so they deliberately stay, or the
 * post-commit unlink failed and the orphan sweep owns the retry. A boolean could not
 * report the third truthfully — it would have to answer "not reclaimed", which is what
 * the second arm also says and means something entirely different about the operator's
 * disk.
 *
 * A type alias rather than a value list, on the `GrowthCostStatus` rule below: nothing
 * here enumerates the arms, the daemon settles the disposition and the surface renders
 * the one it was handed.
 */
export type GrowthArtifactPayloadDisposition =
  | "reclaimed"
  | "reclaim_pending"
  | "retained_by_references";

/**
 * The receipt a delete answers with.
 *
 * Mirrored member-for-member from the registered `ArtifactDeleteResponse` in
 * `docs/architecture/contracts/api-payload-contracts.md`. The operation used to answer
 * with nothing, and a delete that answers with nothing is a delete a surface can only
 * report as "done": the daemon settles two facts at that moment which no later read can
 * recover, and both are things a person acts on.
 *
 * `payloadDisposition` is the first — whether the bytes went, stayed for another
 * manifest, or are owed to a sweep. `rePublishForeclosed` is the second, and it is the
 * one a confirmation dialogue exists for: deleting a manifest that carried the
 * publisher-retained relay key destroys that key with the row, so re-publish becomes
 * permanently impossible and the late-join remedy is gone. Grounded in the destroyed
 * LOCAL key alone — never a claim about what the relay still holds, which nothing here
 * has asked and nothing here could answer.
 *
 * Every member is REQUIRED, and that is the load-bearing part rather than a default
 * choice: an absent disposition would be indistinguishable from a served one, so a
 * surface would render "reclaimed" for a reply that said nothing, and a missing
 * foreclosure flag read as `false` would tell a person a re-publish is still available
 * on exactly the artifact where it no longer is.
 */
export interface GrowthArtifactDeleteReceipt {
  readonly artifactId: string;
  readonly payloadDisposition: GrowthArtifactPayloadDisposition;
  /** True when the delete destroyed the retained relay key, foreclosing re-publish. */
  readonly rePublishForeclosed: boolean;
  readonly deletedAt: string;
}
