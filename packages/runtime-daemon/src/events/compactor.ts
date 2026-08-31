// Plan-006 T3.2 — the audit-log compactor: three retention triggers, the
// anchor-before-compaction protocol, and the per-row audit-stub commitment.
//
// Compaction replaces a full event payload with a bounded audit stub. It is the
// only operation in this package that MUTATES an already-committed row of an
// append-only log, which is why almost every line below is a constraint rather
// than a mechanism. Three properties carry the design:
//
//   1. NEVER-COMPACTED CATEGORIES (I-006-3-01, layer 1). The candidate selector
//      excludes `audit_integrity` and `event_maintenance` in SQL, so a row of
//      either family is never even read as a candidate. This is the first of the
//      three layers the invariant names; the verifier and the shred path own the
//      other two.
//   2. ANCHOR BEFORE STUB (I-006-3-03; `Spec-006 §Post-Compaction Integrity`).
//      A covering Merkle anchor must exist over the whole to-be-compacted range
//      BEFORE any row's payload is mutated, because compaction destroys the
//      bytes `row_hash` and `daemon_signature` commit to. If the anchor cannot
//      be obtained, the session's pass refuses with ZERO rows mutated.
//   3. SIGN-EXACT-BYTES. The stub projection is canonicalized ONCE to `B`,
//      `stub_signature = Ed25519(B)`, and that same `B` is what lands in
//      `payload`. No re-serialization sits between signing and storing, so the
//      verifier authenticates the stub by checking the signature directly over
//      the stored bytes.
//
// ----------------------------------------------------------------------------
// Why `payload` is bound as TEXT, and why that is not a detail
// ----------------------------------------------------------------------------
//
// `session_events.payload` is a TEXT-affinity column. `B` is a `Uint8Array`.
// Binding `B` as a Buffer would write a BLOB into that column — SQLite does not
// coerce across the TEXT/BLOB boundary — and the verifier reading it back would
// then hold something other than the bytes that were signed. The binding below
// is therefore `new TextDecoder().decode(B)`: RFC 8785 JCS output is valid
// UTF-8, so the decode is lossless and the verifier recovers `B` exactly by
// UTF-8-encoding the stored TEXT. The decoded string is derived from `B` and is
// NEVER a second `JSON.stringify` of the projection object — that would be the
// re-serialization the sign-exact-bytes invariant forbids.
//
// ----------------------------------------------------------------------------
// Locking: what is held, and what is deliberately not
// ----------------------------------------------------------------------------
//
// Per-row attribute-and-stub runs inside `withSessionAppendLock` — one hold per
// row — so the Plan-004 admission-side span-check-plus-intervention-write and
// this side's attribute-and-stub serialize and never interleave. The attribution
// call is INSIDE the hold on purpose: serializing against admission is the whole
// point of the hold, and an attribution resolved before the hold could be
// invalidated by an intervention admitted in the gap.
//
// Everything that can block on foreign I/O is hoisted OUT of the hold: the
// signing key is resolved once per session before the row loop (an unseal may
// await a ceremony), the anchor force-fire happens before the loop, and the
// `event.compacted` emission happens after it. That emission takes the SENTINEL
// session's own lock, so it could not deadlock against a row hold even if it
// were nested — it is kept outside anyway, because a hold spanning an append is
// the exact shape the "never across I/O" rule exists to forbid.
//
// ----------------------------------------------------------------------------
// What is checked BEFORE anything is destroyed
// ----------------------------------------------------------------------------
//
// Compaction destroys payloads irreversibly, so every condition that can make a
// pass unable to FINISH is checked before the pass mutates its first row, and in
// increasing cost order:
//
//   1. INGEST HALT (`ingest-halt-source.ts`). A session halted for signing-key
//      reuse is SKIPPED, not refused — a skip leaves the age trigger live, so
//      the session compacts normally once the halt clears. Stub-signing is
//      attestation under the same key the halt declared repudiable, so a halted
//      session that compacted would destroy the pre-halt evidence and re-attest
//      what is left under the discredited key. Synchronous, no I/O, no lock.
//   2. SENTINEL SIGNING KEY. `event.compacted` is appended on the DAEMON-SCOPE
//      SENTINEL session, whose signing key is a different row of
//      `daemon_signing_keys` from the one the stubs are signed with. That key is
//      resolved by the append at the END of the pass, so an unresolvable one
//      would surface only AFTER every payload in the range was gone — leaving
//      irreversible destruction with no durable record of it, which the emission
//      note below calls the one outcome this module must never produce. The pass
//      therefore PROBES it up front and refuses with zero rows mutated.
//
// Both checks precede the `anchorRange` force-fire, not just the row loop: an
// anchor forced for a range that will never be compacted queues an upload the
// pass has no use for.
//
// BEHAVIORAL CONSEQUENCE of check 2, stated plainly: until CP-006-7 provisions
// the sentinel session's signing key, compaction is INERT — every triggered pass
// refuses, nothing is reclaimed, and the triggers keep firing. That is the
// deliberate trade. An inert compactor is a storage problem; a compactor that
// destroys payloads it cannot record is an audit-integrity problem, and only one
// of the two is recoverable.
//
// The probe reads the key and discards it. It is NOT carried across the row loop
// — `#emitCompacted` resolves the sentinel key again at emission time — because
// holding private key material alive across an unbounded loop extends its
// in-memory lifetime for no benefit. Nothing about either key is ever
// interpolated into a refusal message or any other rendered string.
//
// SCOPE, deliberate: the anchor drain is NOT wired to the halt seam. An anchor
// commits to PRE-halt bytes that already exist and destroys nothing, so
// withholding it would only deny the operator the integrity proof over exactly
// the range whose key came into question.
//
// ----------------------------------------------------------------------------
// Scheduling: "never runs during active runs" is the CALLER's precondition
// ----------------------------------------------------------------------------
//
// `Spec-006 §Event Compaction Policy` states that compaction "runs as a
// background daemon task during idle periods. It never runs during active
// runs." That is a property of WHEN `tick()` is invoked, and this module
// deliberately does not invent a run-state seam to enforce it: no run-state
// source exists in this package at Tier 4, and declaring one here would be a
// premature interface that Plan-004's run registry would then have to displace.
// The idle scheduler that owns `tick()` owns the precondition.
//
// Spec coverage: `Spec-006 §Event Compaction Policy` (the three trigger
// thresholds), `Spec-006 §Compacted Event Format` (the audit-stub projection),
// `Spec-006 §Post-Compaction Integrity` (anchor-before-compaction),
// `Spec-006 §Event Maintenance (event_maintenance)` (`event.compacted`; never
// compacted), `Spec-006 §Audit Integrity (audit_integrity)` (never compacted).
// Refs: Plan-006 T3.2, invariants I-006-3-01 and I-006-3-03,
// `migrations/0009-retention-class-and-stub-signature.ts`.

import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EVENT_CANONICAL_BYTES_MAX,
  EventCategorySchema,
  EventCompactedPayloadSchema,
  EventEnvelopeVersionSchema,
  ORIGIN_POSITION_STUB_KEY,
  SOURCE_EPOCH_PAYLOAD_KEY,
  SOURCE_POSITION_PAYLOAD_KEY,
  SessionIdSchema,
} from "@ai-sidekicks/contracts";
import type {
  AnchorPayload,
  EventCategory,
  EventCompactedPayload,
  EventEnvelopeVersion,
  NodeId,
  RunId,
  SessionId,
} from "@ai-sidekicks/contracts";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Database, Statement } from "better-sqlite3";

import { canonicalizeJson } from "./canonicalizer.js";
import type { CanonicalBytes } from "./canonicalizer.js";
import type {
  EventLogAppendOptions,
  EventLogAppendReceipt,
  UnsequencedEventEnvelope,
} from "./event-log-service.js";
import { NeverHaltedIngestHaltSource } from "./ingest-halt-source.js";
import type { IngestHaltSource } from "./ingest-halt-source.js";
import type { AnchorRangeRequest } from "./merkle-anchor-service.js";
import { isWithinSessionAppendLockHold, withSessionAppendLock } from "./session-append-lock.js";
import type { SessionContentKeyDisposer } from "./session-content-key-store.js";
import type { Ed25519PrivateKey } from "./signer.js";
import type { DaemonSigningKeySource } from "./signing-key-source.js";

// --------------------------------------------------------------------------
// Trigger thresholds — `Spec-006 §Event Compaction Policy`
// --------------------------------------------------------------------------
//
// The three spec-valued defaults. Exported (with explicit type annotations, per
// the repo-wide `isolatedDeclarations`) so a reader can see the spec numbers in
// code, and OVERRIDABLE through `CompactorDeps` so a test can drive each trigger
// independently: a suite that had to insert 50,000 rows or advance a clock 90
// days to observe a threshold would not test the thresholds at all, it would
// test its own fixture's patience.

/** 50,000 events per session — `Spec-006 §Event Compaction Policy`. */
export const COMPACTION_EVENT_COUNT_THRESHOLD: number = 50_000;

/** 90 days — `Spec-006 §Event Compaction Policy`. */
export const COMPACTION_AGE_THRESHOLD_DAYS: number = 90;

/** 500 MB of live payload per session — `Spec-006 §Event Compaction Policy`. */
export const COMPACTION_STORAGE_THRESHOLD_BYTES: number = 500 * 1024 * 1024;

/** The `retention_class` value a compacted row carries. */
export const AUDIT_STUB_RETENTION_CLASS = "audit_stub" as const;

/**
 * The two categories compaction NEVER touches — layer 1 of I-006-3-01's
 * three-layer enforcement, applied as a SQL exclusion so a row of either family
 * is never read as a candidate in the first place.
 *
 * `audit_integrity` rows are the tamper-evidence record itself; compacting them
 * would discard the evidence a verification failure consists of.
 * `event_maintenance` rows record the maintenance operations (including
 * compaction passes), so compacting them would let a compactor erase its own
 * audit trail.
 */
export const NON_COMPACTABLE_EVENT_CATEGORIES: readonly EventCategory[] = [
  "audit_integrity",
  "event_maintenance",
];

/**
 * The same two categories as a SQL literal list, INTERPOLATED into every
 * candidate-facing statement rather than bound as parameters.
 *
 * Bound parameters were the first shape and were wrong for a specific reason:
 * they occupied positional slots whose index depended on where the shared WHERE
 * fragment happened to sit inside each statement's SQL, so reordering a clause
 * in any one of six call sites would silently rebind the categories onto some
 * other predicate's slot — and layer 1 of I-006-3-01 would stop holding with no
 * error anywhere. These are compile-time constants, not input: `EventCategory`
 * is a closed union of bare identifiers, so there is no quote to escape and no
 * injection surface. Derived from the array above so the two can never drift.
 */
const NON_COMPACTABLE_CATEGORY_SQL_LIST: string = NON_COMPACTABLE_EVENT_CATEGORIES.map(
  (category) => `'${category}'`,
).join(", ");

// The payload member naming a row's run. No contracts constant exists for it —
// the corpus spells it inline (the `idx_session_events_run_terminal_once`
// indexed expression `json_extract(payload, '$.runId')` is the load-bearing
// spelling) — so it is pinned here once rather than respelled per use.
const RUN_ID_PAYLOAD_KEY = "runId" as const;

/**
 * Payload members preserved VERBATIM into the stub whenever the source payload
 * carries them, per `Spec-006 §Compacted Event Format`.
 *
 * A single preserve-when-present rule discharges every clause the spec states
 * per row family, and under-preserving is the direction with teeth:
 *
 *   * `runId` + `runVersion` — the `idx_session_events_run_terminal_once`
 *     backstop's indexed expressions on terminal `run_lifecycle` rows. Dropping
 *     either would index the stub as NULL and re-admit a duplicate terminal
 *     (NULLs are distinct in a SQLite UNIQUE index).
 *   * `executionPosture` + `credentialPolicyRef` — the posture audit boundary on
 *     `run.running` rows. `credentialPolicyRef` is preserved only when present:
 *     a `mode: 'trusted'` row carries a posture and no credential ref, and the
 *     stub neither requires nor fabricates one.
 *   * `targetPosition` — the rewind cutoff on accepted `run.rolled_back` rows,
 *     which the Plan-004 supersede projection rebuilds each epoch's boundary
 *     from.
 *   * `sourceEpoch` + `sourcePosition` — the cross-cutting epoch stamp, kept so
 *     a compacted stale-epoch row stays attributed to its source epoch.
 *   * `contentLength` + `contentTruncated` — the machine-authored body's SHAPE.
 *     The body itself lived in the sealed `content_payload` column and is NULLed
 *     by the same UPDATE, so these two are all that survives to say a body was
 *     there and how much of it the writer kept. `contentCiphertextDigest` is
 *     DELIBERATELY absent from this list and given no stub field of its own: it
 *     commits to ciphertext this UPDATE destroys, so preserving it would leave
 *     every compacted body-bearing row asserting a binding to bytes that no
 *     longer exist — the failure the 2026-07-27 owner-stamp amendment fixed
 *     retroactively for `pii_participant_id`, stated here at mint time instead.
 *
 * Enforcement, not narration, for the first pair: `trg_run_terminal_key_update`
 * fires on this module's `UPDATE OF payload` and ABORTs a stub that dropped,
 * retyped, or altered `runId` / `runVersion` on a terminal row.
 */
const PRESERVED_PAYLOAD_KEYS: readonly string[] = [
  RUN_ID_PAYLOAD_KEY,
  "runVersion",
  "executionPosture",
  "credentialPolicyRef",
  "targetPosition",
  SOURCE_EPOCH_PAYLOAD_KEY,
  SOURCE_POSITION_PAYLOAD_KEY,
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
];

// The `event.compacted` envelope's category/type/version. Minted THROUGH the
// schema rather than cast for `version`, on the `node-event-emitter.ts`
// reasoning: a literal that stopped satisfying the version grammar throws at
// import, in every consumer, rather than at the first emit against a real chain.
const EVENT_MAINTENANCE_CATEGORY: EventCategory = "event_maintenance";
const EVENT_COMPACTED_TYPE = "event.compacted" as const;
const COMPACTOR_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// Ed25519 signatures are 64 bytes (RFC 8032 §5.1.6). Module-local rather than
// imported: `signer.ts` and `merkle-anchor-service.ts` each already keep their
// own copy of this constant, and reaching across to either would import a
// private for no benefit. The check it guards mirrors the one `anchorRange`
// runs before it binds `root_signature` — see the sign site below.
const ED25519_SIGNATURE_LENGTH = 64;

// --------------------------------------------------------------------------
// The rollback-attribution seam (Plan-006-owned; Plan-004 T3.14 implements)
// --------------------------------------------------------------------------

/** The row an attribution is being asked about. */
export interface RollbackAttributionRequest {
  readonly sessionId: SessionId;
  readonly eventId: string;
  readonly sequence: number;
}

/**
 * The three dispositions `attributeAtCompaction` may answer with.
 *
 *   * `current` — the row belongs to the surviving timeline. No epoch stamp is
 *     written (absence keeps meaning "current"). `position`, when the
 *     implementation can resolve it, is the row's originating position and is
 *     written into the stub under {@link ORIGIN_POSITION_STUB_KEY}.
 *   * `superseded` — a later accepted `run.rolled_back` rewound past this row.
 *     The `sourceEpoch` + `sourcePosition` + `runId` triple is STAMPED into the
 *     stub, because compaction is the moment in-stream derivability is
 *     destroyed and the projection must freeze what a rebuild can no longer
 *     derive.
 *   * `defer` — a dispatched-but-unconcluded rollback intervention's rewind span
 *     covers the row. The compactor skips it this pass; the row stays live with
 *     `retention_class` NULL and is re-examined after the intervention
 *     concludes. Without deferral, idle compaction inside the
 *     admission-to-boundary window would stub the rewound tail unstamped (no
 *     accepted boundary exists yet), stranding it unattributable for the log's
 *     whole retention life.
 */
export type RollbackAttribution =
  | { readonly disposition: "current"; readonly position?: number | undefined }
  | {
      readonly disposition: "superseded";
      readonly sourceEpoch: number;
      readonly sourcePosition: number;
      readonly runId: RunId;
    }
  | { readonly disposition: "defer" };

/**
 * How the compactor asks whether a run-scoped row belongs to the surviving
 * timeline. Declared here because Plan-006 owns the seam and this task is its
 * first consumer; Plan-004 T3.14's supersede projection implements it and its
 * composition-root wiring replaces the vacuous default below (the CP-006-1
 * `PiiEncryptor` precedent, composition root included).
 *
 * Consulted ONLY for run-scoped rows — rows whose payload carries `runId`. Epoch
 * attribution and rewind spans are run-local, and the
 * `Spec-004 §Required Behavior` rewind-span check's detection keys are `runId`
 * plus `originPosition`, so a row with no run identity has nothing an attribution
 * could answer about.
 */
export interface RollbackAttributionSource {
  attributeAtCompaction(request: RollbackAttributionRequest): Promise<RollbackAttribution>;
}

/**
 * The vacuous default: every row is `current`, with no resolved position, and
 * never `defer`.
 *
 * Correct until Plan-004 lands, and correct for a precise reason rather than as
 * a placeholder: with no rollback implementation there is no accepted
 * `run.rolled_back` event and no dispatched intervention, so no row can be
 * superseded and none can be inside an unconcluded rewind span. It answers no
 * `position` because it has no epoch model to resolve one from — which is
 * exactly the legacy-stub state the spec describes ("a position-less stub of the
 * target run is therefore itself a standing refusal").
 */
export const VACUOUS_CURRENT_ROLLBACK_ATTRIBUTION_SOURCE: RollbackAttributionSource = {
  attributeAtCompaction(): Promise<RollbackAttribution> {
    return Promise.resolve({ disposition: "current" });
  },
};

// --------------------------------------------------------------------------
// The audit-stub projection
// --------------------------------------------------------------------------

/**
 * The field set of `Spec-006 §Compacted Event Format`, plus the
 * preserved/stamped members that section's compaction paragraph adds.
 *
 * The explicit `[preservedKey: string]: unknown` index signature is the
 * load-bearing member, and it is here because the preserved and stamped members
 * are written under keys this module does not know statically — the
 * preserve-when-present loop, the `ORIGIN_POSITION_STUB_KEY` write, and
 * `stampAttributionMember` all index by a runtime string. (It is declared as a
 * type alias rather than an interface only to match the file's other projection
 * shapes; with the index signature spelled out, an interface would be equally
 * assignable to `canonicalizeJson`'s record parameter.)
 *
 * `compactedAt` and `summary` exist ONLY inside these bytes — they have no
 * scalar column, which is why the verifier's scalar-binding check exempts them.
 */
export type AuditStubProjection = {
  id: string;
  sessionId: SessionId;
  sequence: number;
  occurredAt: string;
  category: EventCategory;
  type: string;
  actor: string | null;
  compactedAt: string;
  retentionClass: typeof AUDIT_STUB_RETENTION_CLASS;
  summary: string;
  [preservedKey: string]: unknown;
};

// --------------------------------------------------------------------------
// Pass results
// --------------------------------------------------------------------------

/** The closed trigger vocabulary of `Spec-006 §Event Compaction Policy`. */
export type CompactionReason = EventCompactedPayload["compactionReason"];

/** What one session's pass did — or refused to do, and why. */
export interface CompactionSessionOutcome {
  readonly sessionId: SessionId;
  /**
   * The trigger this pass attributed the compaction to. A single value because
   * `event.compacted.compactionReason` is a single enum member; when several
   * triggers fire at once the precedence is storage > count > age (see
   * {@link Compactor} for why).
   *
   * Absent ONLY when the pass refused before a trigger could be determined —
   * i.e. trigger evaluation itself threw, which is upstream of every mutation,
   * so an outcome with no `reason` always has `rowsStubbed: 0`.
   */
  readonly reason?: CompactionReason | undefined;
  /**
   * Lowest live compactable sequence the session held when the pass began.
   * Always known: it is read with the session census, before any trigger work.
   */
  readonly fromSequence: number;
  /**
   * Inclusive upper bound of the ANCHOR span — the range a covering anchor was
   * obtained over and candidates were drawn from. Wider than the set actually
   * stubbed whenever a row inside it deferred, was never-compactable, or (under
   * an age-triggered pass) was younger than the retention floor. Absent on the
   * same no-trigger refusal as {@link reason}.
   */
  readonly toSequence?: number | undefined;
  /** Rows whose payload was replaced by a signed audit stub this pass. */
  readonly rowsStubbed: number;
  /**
   * Rows the attribution source answered `defer` for. They remain live with
   * `retention_class` NULL and are re-examined on a later tick.
   */
  readonly rowsDeferred: number;
  /**
   * Sum over stubbed rows of max(0, (original payload + PII bytes) − stub
   * bytes). Clamped at zero PER ROW rather than in aggregate: a payload smaller
   * than its own stub compacts to MORE bytes (the projection carries ten fixed
   * members plus a summary), and `EventCompactedPayloadSchema` declares
   * `bytesReclaimed` nonnegative, so an unclamped row could make a whole
   * session's honest total fail the emission parse.
   */
  readonly bytesReclaimed: number;
  /**
   * Present iff this session's pass refused. A refusal is scoped to one session;
   * other sessions in the same tick proceed.
   *
   * It does NOT imply zero mutation. The refusals guaranteed unmutated are
   * exactly the ones raised before the row loop: the sentinel signing-key probe,
   * the anchor step, and a throwing halt source. A refusal raised mid-loop
   * leaves the rows already stubbed before it stubbed, and those rows are
   * reported in `rowsStubbed` and recorded by an `event.compacted` emitted over
   * exactly them (see {@link Compactor}).
   */
  readonly refusedReason?: string | undefined;
}

/** What one {@link Compactor.tick} did across every session it examined. */
export interface CompactionPassResult {
  /** Correlates this pass with the `event.compacted` rows it emitted. */
  readonly operationId: string;
  /**
   * Sessions holding at least one live compactable row when the pass began
   * **whose census row this pass could read**. A partition whose census row
   * fails its probe is skipped unexamined and counted in
   * {@link sessionsUnreadable} instead — it is neither examined, compacted, nor
   * refused. The narrower wording is deliberate: this count is what the pass
   * LOOKED AT, not what the table contained.
   *
   * It is an upper bound on what the pass acted on, not a statement of it. Two
   * examined sessions produce no outcome entry at all: one whose triggers all
   * declined to fire (the common case) and one skipped because its ingest is
   * halted. Read coverage off {@link outcomes}, which enumerates exactly the
   * sessions this pass acted on.
   */
  readonly sessionsExamined: number;
  /**
   * Sessions that stubbed at least one row AND completed without refusing.
   *
   * Disjoint from {@link sessionsRefused} by construction, so the two sum to at
   * most {@link sessionsExamined}. A session that stubbed rows and then refused
   * mid-loop counts under `sessionsRefused` only — but its rows still count in
   * {@link rowsStubbed}, which is a row census and not a session census.
   */
  readonly sessionsCompacted: number;
  /** Sessions whose pass refused (see {@link CompactionSessionOutcome}). */
  readonly sessionsRefused: number;
  /**
   * Partitions whose census row failed its probe and were skipped unexamined.
   *
   * A THIRD disjoint bucket beside {@link sessionsCompacted} and
   * {@link sessionsRefused}, and deliberately not a refusal. The distinguishing
   * property is not "never reached trigger evaluation" — a halt-skipped session
   * does not reach it either, and it is counted as examined — but that no
   * readable census row was ever obtained: the pass never held a session to act
   * on, so there was nothing for it to decline to destroy. Every refusal, at
   * whatever step it is raised, is raised against a partition the pass could
   * read; reporting these as refusals would claim a pass that never began.
   *
   * Operationally a nonzero value is a STANDING alarm, not a transient one. The
   * probe is a pure function of the stored rows, so the same partition fails on
   * every subsequent tick: it will never compact until the underlying rows are
   * repaired, and its live payload grows without bound until then. The count
   * exists precisely because the skip is silent by design — see
   * {@link Compactor} on why one corrupt aggregate must not abort a whole tick.
   */
  readonly sessionsUnreadable: number;
  readonly rowsStubbed: number;
  readonly rowsDeferred: number;
  readonly bytesReclaimed: number;
  /**
   * Wrapped session-content DEKs the pass's reconciliation sweep retired.
   *
   * PASS-SCOPED RATHER THAN PER-SESSION, and deliberately not folded into any
   * {@link outcomes} entry: the sweep asks a question about the whole database —
   * which keys exist with no live content row — so a key it reclaims frequently
   * belongs to a session this pass never examined, and attributing it to one
   * that happened to run would be a fabricated association.
   *
   * Nonzero here without a matching stub in this pass is EXPECTED, not
   * suspicious: it is precisely the arrear the sweep exists to collect — a key
   * whose last body was cleared by an earlier pass whose prompt disposal did not
   * complete, or one minted by an append that then aborted before sealing
   * anything.
   */
  readonly contentKeysReclaimed: number;
  /**
   * Candidates the reconciliation sweep passed over because their own disposal
   * failed.
   *
   * SEPARATE FROM {@link contentKeySweepFailure}, because the two describe
   * different failures: that one is the sweep not running, this one is the sweep
   * running and not reclaiming. Without it a pass in which every candidate threw
   * reports `contentKeysReclaimed: 0` and no failure at all — the same reading an
   * idle, healthy pass produces.
   */
  readonly contentKeysSkipped: number;
  /**
   * Present iff the reconciliation sweep itself failed.
   *
   * NOT a refusal and NOT attributed to a session. The sweep has no session to
   * blame — it runs after the loop, over the whole table — and it destroys
   * nothing a later pass needs, so a failure here neither aborts the tick nor
   * reclassifies any outcome. It is surfaced because the alternative is a
   * reclamation pass that silently stops reclaiming.
   */
  readonly contentKeySweepFailure?: string | undefined;
  /** One entry per session that fired a trigger or refused; never the no-ops. */
  readonly outcomes: readonly CompactionSessionOutcome[];
}

// --------------------------------------------------------------------------
// Injected dependencies
// --------------------------------------------------------------------------

/**
 * The durable append seam for `event.compacted`, typed against T3.1's own
 * parameter and return types so a signature change there fails THIS compile.
 *
 * Structural, naming no concrete class — the `SessionEventLog` seam in
 * `node/node-event-emitter.ts` is the precedent. It is re-declared here rather
 * than imported from that module because the dependency direction runs the
 * other way (`node/` consumes `events/`), and a type import upward would invert
 * it for no benefit.
 */
export interface CompactionEventLog {
  append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt>;
}

/**
 * The force-fire seam of `Spec-006 §Post-Compaction Integrity` step 2, typed
 * against T3.3's own request type and return payload.
 *
 * The compactor does NOT re-implement step 1's coverage query. `anchorRange`
 * already owns that exact predicate as its idempotency pre-check
 * (`start_sequence <= fromSeq AND end_sequence >= toSeq`) and short-circuits on
 * it, so delegating keeps ONE coverage predicate in the tree rather than two
 * that can drift, and spares this module a `nodeId`-scoped duplicate of the
 * queue read. The returned payload is then checked to actually cover the range
 * — see {@link Compactor}.
 */
export interface CompactionAnchorSource {
  anchorRange(request: AnchorRangeRequest): Promise<AnchorPayload>;
}

/** Construction dependencies. */
export interface CompactorDeps {
  /** The connection every candidate read and stub UPDATE lands on. */
  readonly db: Database;
  /** This daemon's NodeId — attributed in every `event.compacted` payload. */
  readonly nodeId: NodeId;
  /** Resolves the session's Ed25519 private key for `stub_signature`. */
  readonly signingKeySource: DaemonSigningKeySource;
  /** Where `event.compacted` is appended. */
  readonly eventLog: CompactionEventLog;
  /** The anchor-before-compaction force-fire seam. */
  readonly anchorSource: CompactionAnchorSource;
  /**
   * Retires a session's wrapped content DEK once this pass has cleared the last
   * body it sealed.
   *
   * REQUIRED, with no default. Every other optional dep here degrades to a
   * defensible stance when unwired — `haltSource` fails open to "compact
   * everything", `now` to the wall clock. This one has no such stance: a no-op
   * default would leave a composition root silently accumulating dead wrapped
   * keys and re-wrapping them on every rotate-on-shred, with nothing at the
   * wiring site to say so. Requiring it costs each caller one line and makes the
   * omission a compile error instead of a slow leak.
   */
  readonly contentKeyDisposer: SessionContentKeyDisposer;
  /**
   * The ingest-halt read seam. A halted session is skipped by the pass — see the
   * file header on why stub-signing counts as attestation.
   *
   * Optional, defaulting to `NeverHaltedIngestHaltSource`, which is the same
   * fail-OPEN stance `EventLogService` takes for the same dependency and for the
   * same reason: a composition root that has not yet wired the registry gets a
   * daemon that appends and compacts, not one that silently withholds retention
   * on every session. The wiring, not this default, is what makes the halt
   * observable.
   */
  readonly haltSource?: IngestHaltSource;
  /**
   * Rollback attribution. Defaults to
   * {@link VACUOUS_CURRENT_ROLLBACK_ATTRIBUTION_SOURCE}; Plan-004 T3.14's
   * composition-root wiring replaces it.
   */
  readonly rollbackAttributionSource?: RollbackAttributionSource;
  /**
   * Clock seam. ONE seam yields every instant the pass needs — the comparand
   * the 90-day threshold measures against, the stub's `compactedAt`, and the
   * `event.compacted` timestamps — so they can never disagree about when a
   * compaction happened. Defaults to `new Date()`.
   */
  readonly now?: () => Date;
  /** Override for `Spec-006`'s 50,000-events-per-session count trigger. */
  readonly eventCountThreshold?: number;
  /** Override for `Spec-006`'s 90-day age trigger. */
  readonly ageThresholdDays?: number;
  /** Override for `Spec-006`'s 500 MB-per-session storage trigger. */
  readonly storageThresholdBytes?: number;
  /** Mints the per-pass `operationId`. Defaults to `crypto.randomUUID()`. */
  readonly operationIdFactory?: () => string;
  /** Mints each `event.compacted` row's id. Defaults to `crypto.randomUUID()`. */
  readonly newEventId?: () => string;
}

// Raw read shapes. Every member is `unknown` because column declarations are
// claims TypeScript never checked and the read boundary is where they get
// checked — the `merkle-anchor-service.ts` convention.
interface SessionSummaryRow {
  readonly session_id: unknown;
  readonly live_count: unknown;
  readonly min_sequence: unknown;
  readonly live_bytes: unknown;
}

interface CandidateRow {
  readonly id: unknown;
  readonly sequence: unknown;
  readonly occurred_at: unknown;
  readonly category: unknown;
  readonly type: unknown;
  readonly actor: unknown;
  readonly payload: unknown;
  readonly pii_bytes: unknown;
  readonly content_bytes: unknown;
}

// One session's live-row census, read once at the top of its pass.
interface SessionSummary {
  readonly sessionId: SessionId;
  readonly liveCount: number;
  readonly minSequence: number;
  readonly liveBytes: number;
}

// The whole census read: the partitions this pass can act on, plus a tally of
// the ones it could not read. The tally rides back with the summaries rather
// than being recomputed, because the skip decision is made per row inside the
// read and is not recoverable from the surviving summaries afterwards.
interface SessionCensus {
  readonly summaries: readonly SessionSummary[];
  readonly unreadableCount: number;
}

/**
 * The outcome of evaluating the three triggers against one session.
 *
 * TWO candidate bounds, not one, because the three triggers do not all describe
 * prefixes — see the RETENTION FLOOR note on the trigger statements. A row is a
 * candidate when it satisfies EITHER bound; the union is what the pass compacts.
 */
interface TriggerEvaluation {
  readonly reason: CompactionReason;
  /** Inclusive upper bound of the anchor span: the greatest bound any firing trigger reached. */
  readonly cutoffSequence: number;
  /**
   * Count / storage: an oldest-first PREFIX bound. Every live compactable row at
   * or below it is a candidate. `undefined` when neither of those two fired.
   */
  readonly prefixCutoffSequence: number | undefined;
  /**
   * Age: an exclusive `occurred_at` bound, applied PER ROW rather than as a
   * prefix. `undefined` when the age trigger did not fire.
   */
  readonly ageCutoffInstant: string | undefined;
}

// Thrown to abort ONE session's pass. Caught at the session boundary and turned
// into a `refusedReason`; never escapes `tick()`.
class CompactionRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionRefusal";
  }
}

/**
 * The compaction pass.
 *
 * ### Trigger evaluation
 *
 * Each trigger contributes its own CANDIDATE SET, exactly as the Description
 * column of `Spec-006 §Event Compaction Policy`'s trigger table defines it, and
 * the pass compacts the UNION. Count and storage describe oldest-first prefixes
 * and share one prefix bound; age describes a per-row property and carries its
 * own (see the RETENTION FLOOR note on the trigger statements for why age can
 * NOT be collapsed into a prefix).
 *
 * The anchor span `[fromSequence, cutoffSequence]` is the enclosing range, not
 * the candidate set: it is contiguous over STORED rows, which is what
 * `anchorRange` requires (it hard-refuses a range whose stored-row count does
 * not match the span length). The candidate set is free to be sparse inside it —
 * it already is, since layer 1 of I-006-3-01 leaves a hole at every
 * never-compacted row — and a wider-than-necessary anchor is always sound.
 *
 * When several triggers fire at once, `compactionReason` reports the
 * highest-precedence one: **storage > count > age**. The order is deliberate and
 * documented rather than incidental (the field is a single enum member, so
 * SOMETHING must break the tie): storage pressure is a hard operational limit,
 * event count is a soft one, and age is retention hygiene with no urgency at
 * all. The reported reason never changes WHICH rows are compacted — that is
 * always the union.
 *
 * ### Refusals
 *
 * A refusal aborts one session's pass and is recorded on that session's outcome;
 * the tick continues with the next session (the `uploadPendingAnchors` drain
 * precedent). The whole pass — trigger evaluation, anchoring, the row loop, and
 * the emission — is inside the guarded region, so no session's failure can
 * discard the tick or the outcomes already collected.
 *
 * ZERO MUTATION IS NOT PROMISED BY A REFUSAL, and the distinction is worth
 * stating precisely because an earlier draft of this comment overstated it. The
 * anchor step is the refusal the spec mandates — "the compactor MUST refuse to
 * proceed with payload mutation if step 1 returns false and step 2 fails" — and
 * it precedes the row loop, so a session that cannot be anchored is left
 * entirely intact. A refusal raised INSIDE the loop (a
 * `trg_run_terminal_key_update` ABORT, an attribution source contradicting a
 * row's signed bytes, a corrupt row failing a read guard) cannot unwind the rows
 * already stubbed: each row commits under its own hold, so there is no
 * transaction to roll back. The pass therefore stops at the defective row —
 * continuing would compact the rest of the range under a known defect — and
 * emits `event.compacted` over exactly the rows it did stub before returning the
 * refusal. Destruction is never left unrecorded.
 */
export class Compactor {
  // No `#db` field: every statement this class issues is prepared in the
  // constructor below, so the handle itself is never needed again. Holding one
  // would only invite an ad-hoc `prepare` on a hot path.
  readonly #nodeId: NodeId;
  readonly #signingKeySource: DaemonSigningKeySource;
  readonly #eventLog: CompactionEventLog;
  readonly #anchorSource: CompactionAnchorSource;
  readonly #contentKeyDisposer: SessionContentKeyDisposer;
  readonly #haltSource: IngestHaltSource;
  readonly #rollbackAttributionSource: RollbackAttributionSource;
  readonly #now: () => Date;
  readonly #eventCountThreshold: number;
  readonly #ageThresholdDays: number;
  readonly #storageThresholdBytes: number;
  readonly #operationIdFactory: () => string;
  readonly #newEventId: () => string;

  // Re-entry guard for `tick()` — see its docblock.
  #running = false;

  // Prepared in the constructor rather than lazily: every statement below names
  // `retention_class`, so a handle that never ran migration 9 fails LOUD at
  // construction instead of at the first tick against a live database.
  readonly #sessionSummaryStmt: Statement;
  readonly #countCutoffStmt: Statement;
  readonly #ageCutoffStmt: Statement;
  readonly #storageCutoffStmt: Statement;
  readonly #candidateSequencesStmt: Statement;
  readonly #candidateRowStmt: Statement;
  readonly #stubUpdateStmt: Statement;

  constructor(deps: CompactorDeps) {
    this.#nodeId = deps.nodeId;
    this.#signingKeySource = deps.signingKeySource;
    this.#eventLog = deps.eventLog;
    this.#anchorSource = deps.anchorSource;
    this.#contentKeyDisposer = deps.contentKeyDisposer;
    this.#haltSource = deps.haltSource ?? new NeverHaltedIngestHaltSource();
    this.#rollbackAttributionSource =
      deps.rollbackAttributionSource ?? VACUOUS_CURRENT_ROLLBACK_ATTRIBUTION_SOURCE;
    this.#now = deps.now ?? ((): Date => new Date());
    this.#eventCountThreshold = deps.eventCountThreshold ?? COMPACTION_EVENT_COUNT_THRESHOLD;
    this.#ageThresholdDays = deps.ageThresholdDays ?? COMPACTION_AGE_THRESHOLD_DAYS;
    this.#storageThresholdBytes = deps.storageThresholdBytes ?? COMPACTION_STORAGE_THRESHOLD_BYTES;
    this.#operationIdFactory = deps.operationIdFactory ?? ((): string => crypto.randomUUID());
    this.#newEventId = deps.newEventId ?? ((): string => crypto.randomUUID());

    // LAYER 1 of I-006-3-01, spelled once and shared by every candidate-facing
    // statement below: the two never-compacted categories are excluded in SQL,
    // and `retention_class IS NULL` restricts the pass to rows not already
    // stubbed. The second half is what makes a crashed mid-pass tick resumable
    // (`compensable`): re-entry simply does not see the rows it already wrote.
    const liveCompactableWhere = `retention_class IS NULL
           AND category NOT IN (${NON_COMPACTABLE_CATEGORY_SQL_LIST})`;

    // Per-session census: how many live compactable rows, over what sequence
    // span, occupying how many bytes. `LENGTH(CAST(payload AS BLOB))` rather
    // than `LENGTH(payload)` because the latter counts CHARACTERS on a TEXT
    // column and the threshold is a byte budget.
    //
    // The census population is the COMPACTABLE one — it inherits the same
    // never-compacted exclusion the candidate selector applies — so all three
    // thresholds measure the set the compactor can actually act on. Measuring
    // them over every row instead would produce a trigger that cannot
    // terminate: a session whose `audit_integrity` rows alone exceeded a
    // threshold would fire on every tick forever, compacting everything else
    // and still being over. The same reading gives `event.compacted`'s
    // `eventsBefore` / `eventsAfter` their meaning.
    this.#sessionSummaryStmt = deps.db.prepare(
      `SELECT session_id AS session_id,
              COUNT(*) AS live_count,
              MIN(sequence) AS min_sequence,
              SUM(
                LENGTH(CAST(payload AS BLOB))
                  + COALESCE(LENGTH(pii_payload), 0)
                  + COALESCE(LENGTH(content_payload), 0)
              ) AS live_bytes
         FROM session_events
        WHERE ${liveCompactableWhere}
        GROUP BY session_id
        ORDER BY session_id`,
    );

    // ----------------------------------------------------------------------
    // THE RETENTION FLOOR — how each trigger's candidate set is bounded
    // ----------------------------------------------------------------------
    //
    // `Spec-006 §Event Compaction Policy`'s trigger table carries a Description
    // column, and that column is normative for each trigger's CANDIDATE SET,
    // not merely for what makes it fire:
    //
    //   * count   — "Oldest events beyond this are compaction candidates."
    //               Self-limiting: the newest 50,000 are never candidates,
    //               which is exactly the prefix the OFFSET below reaches.
    //   * age     — "Events older than 90 days are compaction candidates."
    //               A row younger than the threshold is NOT a candidate, no
    //               matter where it sits in sequence order. This is why the age
    //               bound is applied PER ROW below and not as a prefix: an
    //               `occurred_at` skewed relative to allocation order would
    //               otherwise drag every younger row beneath it into
    //               irreversible payload destruction, breaching the retention
    //               floor. A prefix cap that avoided that by clamping to the
    //               lowest young sequence is the opposite failure — one young
    //               row near the start of the log would starve the trigger
    //               permanently.
    //   * storage — "When session DB exceeds this, compact oldest events
    //               first." A pressure valve; the only bound is oldest-first.
    //
    // ADJUDICATION (`Spec-006 §Retention Windows`). That summary table's "90
    // days or 50K events (whichever is more generous)" row reads, taken as a
    // per-row conjunction, as a floor over BOTH windows at once: compact only
    // what is older than 90 days AND beyond the newest 50K. That reading is
    // refuted by the mechanism section it summarizes. Under it the age
    // trigger's candidate set becomes identical to the count trigger's, so age
    // could never name a candidate count would not — dead code for every
    // session, not just small ones. (`§Event Compaction Policy` separately
    // declares "Any one of the following triggers initiates compaction"; that
    // governs the fire condition rather than the candidate set, so it is
    // context here and not the argument.) The conjunction also degrades the
    // storage valve exactly when pressure is NEWEST: a session that reaches
    // 500 MB inside a week has nothing older than 90 days, so its candidate
    // set is empty on the pass where the storage trigger fires. Where a
    // summary table's parenthetical would render a mechanism the same spec
    // declares independent inoperative, the mechanism section governs: each
    // trigger's candidate set is its own Description column, and the pass
    // compacts the union. The parenthetical is imprecise prose about which
    // window binds a given session; the Description columns are the normative
    // statement of what each trigger may destroy.
    //
    // ----------------------------------------------------------------------

    // COUNT trigger. The cutoff is the sequence of the last row in the excess
    // prefix, reached by OFFSET rather than by reading the prefix.
    this.#countCutoffStmt = deps.db.prepare(
      `SELECT sequence AS cutoff
         FROM session_events
        WHERE session_id = ?
          AND ${liveCompactableWhere}
        ORDER BY sequence
        LIMIT 1 OFFSET ?`,
    );

    // AGE trigger. This statement answers only "did it fire, and how high does
    // the anchor span have to reach" — the HIGHEST aged sequence. WHICH rows it
    // makes candidates is decided per row by the `occurred_at` bound in the
    // candidate scan, so a young row below this cutoff survives the pass.
    this.#ageCutoffStmt = deps.db.prepare(
      `SELECT MAX(sequence) AS cutoff
         FROM session_events
        WHERE session_id = ?
          AND ${liveCompactableWhere}
          AND occurred_at < ?`,
    );

    // STORAGE trigger: "when session DB exceeds this, compact oldest events
    // first". The cutoff is the smallest sequence at which the oldest-first
    // running total reaches the overage, so exactly enough of the oldest history
    // is compacted to clear the threshold. An ESTIMATE by construction: it
    // measures live payload + PII bytes rather than the file's page allocation
    // (a single SQLite file holds many sessions, so `page_count * page_size`
    // cannot answer a per-session question), and it ignores the bytes the stubs
    // themselves will occupy. Both make it under-reclaim slightly, which
    // successive ticks converge away.
    this.#storageCutoffStmt = deps.db.prepare(
      `SELECT MIN(sequence) AS cutoff
         FROM (
           SELECT sequence,
                  SUM(
                    LENGTH(CAST(payload AS BLOB))
                      + COALESCE(LENGTH(pii_payload), 0)
                      + COALESCE(LENGTH(content_payload), 0)
                  ) OVER (ORDER BY sequence ROWS UNBOUNDED PRECEDING) AS cumulative_bytes
             FROM session_events
            WHERE session_id = ?
              AND ${liveCompactableWhere}
         )
        WHERE cumulative_bytes >= ?`,
    );

    // Candidate SEQUENCES only. The rows themselves are re-read one at a time
    // under the per-row lock, so a pass over 50,000 candidates holds 50,000
    // integers rather than 50,000 payloads, and every projection is built from
    // state observed INSIDE the hold rather than from a snapshot taken before
    // it.
    //
    // NAMED binds, uniquely among the statements here: this one carries five
    // parameters, two of them nullable, and a positional list would put the
    // retention floor one argument-order slip away from silently inverting.
    //
    // The two candidate bounds are OR'd — the union of the firing triggers'
    // candidate sets — and each self-neutralizes when its trigger did not fire,
    // with no `IS NULL` branch needed: SQLite evaluates both `sequence <= NULL`
    // and `occurred_at < NULL` to NULL, an OR of two NULLs is NULL, and a NULL
    // WHERE excludes the row. So an unfired bound contributes nothing, and if
    // BOTH were somehow unset the scan would return zero rows — which is why
    // the caller asserts that case is unreachable rather than trusting it.
    this.#candidateSequencesStmt = deps.db.prepare(
      `SELECT sequence AS sequence
         FROM session_events
        WHERE session_id = @sessionId
          AND ${liveCompactableWhere}
          AND sequence BETWEEN @fromSequence AND @toSequence
          AND (sequence <= @prefixCutoffSequence OR occurred_at < @ageCutoffInstant)
        ORDER BY sequence`,
    );

    // `pii_bytes` and `content_bytes` are the ONLY per-candidate figures here
    // that no threshold consults. Traced: both reach `originalBytes` and nothing
    // else, `originalBytes` reaches `bytesReclaimed` and nothing else, and
    // `bytesReclaimed` is a REPORTED total — it lands on the `event.compacted`
    // payload and the pass result, and is read by no trigger, no cutoff, and no
    // candidate-selection predicate. The two aggregate statements above are
    // where the sealed columns' bytes have to be counted for a threshold to see
    // them, and they now count both.
    //
    // `content_bytes` is nonetheless summed into the reclaim figure rather than
    // dropped as decorative: `event.compacted` is itself a never-compacted,
    // never-shredded row, so its `bytesReclaimed` is a permanent claim about
    // what this pass destroyed. Omitting the body would understate that claim by
    // up to `CONTENT_PAYLOAD_PLAINTEXT_MAX` per row for exactly the rows whose
    // compaction reclaimed the most.
    this.#candidateRowStmt = deps.db.prepare(
      `SELECT id AS id,
              sequence AS sequence,
              occurred_at AS occurred_at,
              category AS category,
              type AS type,
              actor AS actor,
              payload AS payload,
              COALESCE(LENGTH(pii_payload), 0) AS pii_bytes,
              COALESCE(LENGTH(content_payload), 0) AS content_bytes
         FROM session_events
        WHERE session_id = ?
          AND sequence = ?
          AND ${liveCompactableWhere}`,
    );

    // The mutation of `Spec-006 §Post-Compaction Integrity` step 5, and its SET
    // list is exhaustive BY OMISSION as much as by inclusion. `payload` is
    // REWRITTEN, never nulled (the column is NOT NULL, and replay must still be
    // able to surface the visible stub). `pii_participant_id` joins the NULLed
    // set alongside `pii_payload` per the 2026-07-27 PII-owner-stamp amendment:
    // the stub projection carries no PII owner, so a surviving stamp would name
    // a participant for a row whose ciphertext is gone and I-006-2-12's
    // read-side check would report `pii_owner_stamp_unbound` on every compacted
    // row. `content_payload` joins the same NULLed set: the machine-authored
    // body is destroyed here exactly as the PII ciphertext is, and its digest is
    // dropped from the stub rather than preserved (see PRESERVED_PAYLOAD_KEYS),
    // so a compacted row asserts no binding to bytes this statement removed.
    // There is no `content_owner_stamp` counterpart to NULL — the content
    // partition is session-scoped, and `session_id` is already canonical and
    // signed. NOT in the SET list, and load-bearing that they are not:
    // `prev_hash`, `row_hash`, `daemon_signature`, `participant_signature`,
    // `monotonic_ns`, `version` (I-006-3-03 freezes the chain commitment) and
    // `category` / `type` (naming them would trip the de-scope leg of
    // `trg_run_terminal_key_update`, and the scalar-binding check reads them as
    // the stub projection's counterparts). The `retention_class IS NULL` guard
    // in the WHERE makes a re-entered UPDATE a zero-row no-op rather than a
    // double-stub.
    this.#stubUpdateStmt = deps.db.prepare(
      `UPDATE session_events
          SET payload = ?,
              correlation_id = NULL,
              causation_id = NULL,
              pii_payload = NULL,
              pii_participant_id = NULL,
              content_payload = NULL,
              retention_class = ?,
              stub_signature = ?
        WHERE id = ?
          AND session_id = ?
          AND retention_class IS NULL`,
    );
  }

  /**
   * Run one compaction pass over every session holding live compactable rows.
   *
   * Invoked by the daemon's idle scheduler, which owns the "never during active
   * runs" precondition (see the file header). Sessions are processed
   * sequentially: the work is I/O-light and lock-heavy, and running them
   * concurrently would multiply the number of held session locks for no
   * throughput gain on a background task.
   *
   * TWO guards, and they cover different shapes — an earlier draft conflated
   * them and claimed more than one guard can support:
   *
   *   * SINGLE-FLIGHT (`#running`). A second `tick()` entered while one is in
   *     flight returns an empty result immediately. This is scheduler hygiene:
   *     two concurrent passes would race each other's candidate reads, and the
   *     loser would spend a pass discovering rows the winner had already
   *     stubbed. It says nothing about the FIRST tick's calling context.
   *   * NOT-INSIDE-A-HOLD (`isWithinSessionAppendLockHold`). A `tick()` invoked
   *     from inside a live `withSessionAppendLock` hold likewise returns an
   *     empty result. `#running` cannot cover this: the nested tick IS the first
   *     one, so the single-flight flag is clear and it would proceed. The hazard
   *     is that the lock is owner-scoped REENTRANT — a tick running inside a
   *     hold on session S acquires NOTHING for S's rows and stubs them outside
   *     the serialization the hold exists to provide, silently.
   *
   * No call site sits inside a hold today, so the second guard is prophylactic;
   * it is here because the failure it prevents is silent, irreversible, and
   * would be introduced by an ordinary-looking refactor (wrapping a maintenance
   * routine in a hold "for consistency").
   */
  async tick(): Promise<CompactionPassResult> {
    const operationId: string = this.#operationIdFactory();
    if (this.#running || isWithinSessionAppendLockHold()) {
      return emptyPassResult(operationId);
    }
    this.#running = true;
    try {
      return await this.#runPass(operationId);
    } finally {
      this.#running = false;
    }
  }

  async #runPass(operationId: string): Promise<CompactionPassResult> {
    const passInstant: Date = this.#now();
    const census: SessionCensus = this.#readSessionSummaries();
    const outcomes: CompactionSessionOutcome[] = [];

    for (const summary of census.summaries) {
      const outcome: CompactionSessionOutcome | undefined = await this.#compactSession(
        summary,
        operationId,
        passInstant,
      );
      if (outcome !== undefined) {
        outcomes.push(outcome);
      }
    }

    // THE RECONCILIATION SWEEP, and it runs on EVERY pass rather than only when
    // this pass stubbed something. The per-session disposal above is the prompt
    // path and has exactly one attempt: if it throws, or the process exits
    // between the last body being stubbed and the disposal completing, the key
    // survives — and no later pass finds a row left to stub for that session, so
    // `rowsStubbed` is zero forever after and the prompt path is never reached
    // again. An obligation derived from work this pass just did cannot survive
    // the pass that did it.
    //
    // The sweep asks the DURABLE question instead — which wrapped keys exist
    // with no live `content_payload` row — so the obligation is re-derived from
    // state the database remembers. That also collects the OTHER orphan class the
    // prompt path structurally cannot see: a key minted by an append that then
    // failed before it sealed anything, on a session that may never compact at
    // all.
    //
    // AFTER THE LOOP, so it observes settled sessions and holds no session's
    // append lock while examining the rest. `tick()` already refuses to run
    // inside a hold, and the sweep takes one hold per session rather than one for
    // the pass.
    let contentKeysReclaimed = 0;
    let contentKeysSkipped = 0;
    let contentKeySweepFailure: string | undefined;
    try {
      const sweep = await this.#contentKeyDisposer.sweepUnreferenced();
      contentKeysReclaimed = sweep.reclaimed;
      contentKeysSkipped = sweep.skipped;
    } catch (error) {
      // Reported, never fatal and never attributed. There is no session to
      // reclassify — the sweep spans the table — and nothing is lost by a
      // failure: the next pass re-derives exactly the same candidates.
      contentKeySweepFailure = `session content-key reconciliation sweep failed: ${describeError(error)}`;
    }

    return {
      operationId,
      sessionsExamined: census.summaries.length,
      // Disjoint by construction: a session that stubbed rows and then refused
      // is a refusal, not a completion. Its rows still appear in `rowsStubbed`,
      // which counts rows rather than sessions.
      sessionsCompacted: outcomes.filter(
        (outcome) => outcome.rowsStubbed > 0 && outcome.refusedReason === undefined,
      ).length,
      sessionsRefused: outcomes.filter((outcome) => outcome.refusedReason !== undefined).length,
      // Disjoint from BOTH of the above, and from `sessionsExamined`: these
      // partitions were never examined, so they are additive to it rather than
      // a subset of it.
      sessionsUnreadable: census.unreadableCount,
      rowsStubbed: outcomes.reduce((total, outcome) => total + outcome.rowsStubbed, 0),
      rowsDeferred: outcomes.reduce((total, outcome) => total + outcome.rowsDeferred, 0),
      bytesReclaimed: outcomes.reduce((total, outcome) => total + outcome.bytesReclaimed, 0),
      contentKeysReclaimed,
      contentKeysSkipped,
      // Conditionally spread rather than assigned `undefined`:
      // `exactOptionalPropertyTypes` makes a present-but-undefined key a
      // different value from an absent one, and absent is what "the sweep did
      // not fail" means.
      ...(contentKeySweepFailure === undefined ? {} : { contentKeySweepFailure }),
      outcomes,
    };
  }

  // ------------------------------------------------------------------------
  // Internal — one session's pass
  // ------------------------------------------------------------------------

  /**
   * Returns `undefined` in the two cases that produce no outcome entry: no
   * trigger fired (the common case, and not worth reporting), or the session's
   * ingest is HALTED and the pass skipped it before evaluating anything.
   *
   * The halt case is a SKIP rather than a refusal, and the distinction is
   * behavioral rather than cosmetic. A refusal is a session whose triggers were
   * evaluated and whose pass then declined to destroy anything; reporting a halt
   * that way would claim an evaluation that never ran, and would mint one
   * refusal entry per halted session per tick for as long as the halt lasts. The
   * skip also leaves the trigger state untouched, so the session compacts on the
   * first tick after the halt clears with nothing to re-arm.
   *
   * NEVER THROWS. The guarded region brackets the entire pass — the halt check,
   * trigger evaluation, the sentinel-key probe, anchoring, the row loop, and the
   * emission — so one session's failure can neither discard the outcomes already
   * collected by the tick nor skip the sessions after it. That bracketing is the
   * whole point: an earlier draft guarded only the middle, which left a
   * trigger-evaluation throw able to abort the tick with zero stubs, and an
   * append rejection at the emission able to abort it AFTER destroying payloads.
   * The two injected seams consulted before the row loop — the halt source and
   * the signing-key source — are inside it for the same reason: neither can be
   * assumed total, and a throwing implementation of either must cost one
   * session's pass, not the tick.
   */
  async #compactSession(
    summary: SessionSummary,
    operationId: string,
    passInstant: Date,
  ): Promise<CompactionSessionOutcome | undefined> {
    const fromSequence: number = summary.minSequence;
    let trigger: TriggerEvaluation | undefined;
    let rowsStubbed = 0;
    let rowsDeferred = 0;
    let bytesReclaimed = 0;
    let lowestStubbedSequence: number | undefined;
    let highestStubbedSequence: number | undefined;
    let refusedReason: string | undefined;

    try {
      // HALT SKIP — first inside the guarded region, because it is the cheapest
      // thing that can stop this pass (a synchronous set membership, no I/O and
      // no lock) and everything after it either costs a round trip or queues
      // work. INSIDE the try rather than above it: `isHalted` is an injected
      // seam, and a seam that throws must degrade to this session's refusal like
      // every other failure here, never escape and abort the whole tick.
      //
      // `ingest-halt-source.ts`: a halted session's signing key "can no longer
      // attest anything", and the response is to stop appending on every locally
      // hosted identity. Stub-signing is attestation — every stubbed row is a
      // fresh Ed25519 signature over bytes this daemon just minted — so
      // compacting a halted session would destroy the pre-halt evidence of the
      // very key event under investigation and re-attest the remains under the
      // discredited key.
      //
      // The predicate is asked about THIS session, never about the sentinel: the
      // halt registry forbids halting the daemon-scope sentinel outright.
      if (this.#haltSource.isHalted(summary.sessionId)) {
        return undefined;
      }

      trigger = this.#evaluateTriggers(summary, passInstant);
      if (trigger === undefined) {
        return undefined;
      }
      const toSequence: number = trigger.cutoffSequence;

      // SENTINEL SIGNING-KEY PROBE — the second pre-destruction check (see the
      // file header). After the trigger guard, so an idle partition never pays
      // for it; before `anchorRange`, so a range that will never be compacted
      // never force-fires an anchor upload on its behalf.
      await this.#probeSentinelSigningKey();

      // STEPS 1-3 of `Spec-006 §Post-Compaction Integrity`, delegated whole to
      // `anchorRange` — its coverage pre-check IS step 1, its force-fire is
      // step 2, and it returns only once the row is durably queued, which is
      // step 3. What cannot be delegated is the CHECK that the anchor it handed
      // back actually spans the range: a payload covering less than
      // `[fromSequence, toSequence]` would leave part of the range with no
      // original-existence proof after its bytes are destroyed.
      //
      // AC RECONCILIATION. The acceptance criterion phrases step 1 as "a
      // covering anchor exists in `pending_anchor_uploads` OR
      // `event_log_anchors`". The daemon cannot consult the second: it is
      // control-plane Postgres. The local queue is nevertheless a superset of
      // every anchor this node produced rather than a weaker substitute — the
      // upload path stamps `uploaded_at` and NEVER deletes the row — so an
      // anchor that reached `event_log_anchors` is still present locally, and a
      // local-only coverage test cannot miss one. (`anchorRange` additionally
      // hard-refuses a range whose stored-row count differs from its span
      // length; the span stays dense because sequence allocation is head+1 and
      // compaction rewrites rows rather than deleting them.)
      const anchor: AnchorPayload = await this.#anchorSource.anchorRange({
        sessionId: summary.sessionId,
        fromSeq: fromSequence,
        toSeq: toSequence,
      });
      if (anchor.startSequence > fromSequence || anchor.endSequence < toSequence) {
        throw new CompactionRefusal(
          `anchor [${String(anchor.startSequence)}, ${String(anchor.endSequence)}] does not cover ` +
            `the compaction range [${String(fromSequence)}, ${String(toSequence)}]; refusing to ` +
            "mutate any row (Spec-006 anchor-before-compaction).",
        );
      }

      // Resolved ONCE per session, before the row loop and outside every lock:
      // an unseal may await a key ceremony, and holding a session's append lock
      // across that would stall every producer on the same session.
      const signingKey: Ed25519PrivateKey = await this.#signingKeySource.read(summary.sessionId);

      const candidateSequences: readonly number[] = this.#readCandidateSequences(
        summary.sessionId,
        fromSequence,
        toSequence,
        trigger,
      );

      for (const sequence of candidateSequences) {
        const rowOutcome = await this.#attributeAndStubRow(
          summary.sessionId,
          sequence,
          signingKey,
          passInstant,
        );
        if (rowOutcome.deferred) {
          rowsDeferred += 1;
          continue;
        }
        if (rowOutcome.stubbed) {
          rowsStubbed += 1;
          bytesReclaimed += rowOutcome.bytesReclaimed;
          lowestStubbedSequence ??= sequence;
          highestStubbedSequence = sequence;
        }
      }
    } catch (error) {
      refusedReason = describeError(error);
    }

    // Emitted whenever the pass actually replaced payloads — INCLUDING when it
    // then refused. `event.compacted` is the audit record that "a compaction
    // pass has replaced full event payloads in a range with audit stubs", and a
    // mid-loop refusal is exactly the case where rows were destroyed; skipping
    // the emission there would leave that destruction unrecorded, which is the
    // one outcome this module must never produce. A pass that deferred every
    // candidate has nothing to report and emits nothing.
    //
    // Runs outside every row hold, after the loop.
    // `trigger` is in the condition to narrow it, not to test it: a row can only
    // be stubbed downstream of a fired trigger, so `rowsStubbed > 0` already
    // implies both it and the two bounds are set. Written as a conjunction
    // rather than a non-null assertion so that if the implication ever stops
    // holding the emission is skipped rather than reporting a fabricated reason.
    if (rowsStubbed > 0 && trigger !== undefined && lowestStubbedSequence !== undefined) {
      try {
        await this.#emitCompacted({
          sessionId: summary.sessionId,
          operationId,
          passInstant,
          // The ACTUALLY-STUBBED span, narrower than the anchor span whenever a
          // row inside it deferred, was never-compactable, or survived an
          // age-triggered pass — see the emission's own note.
          fromSequence: lowestStubbedSequence,
          toSequence: highestStubbedSequence ?? lowestStubbedSequence,
          eventsBefore: summary.liveCount,
          eventsAfter: summary.liveCount - rowsStubbed,
          bytesReclaimed,
          rowsStubbed,
          reason: trigger.reason,
        });
      } catch (error) {
        // The rows are already stubbed and the record of that failed to land.
        // Reported as a refusal — with the mid-loop cause kept when there was
        // one, because the two failures are independent and the first explains
        // why the pass stopped where it did.
        const emissionFailure = `event.compacted emission failed after ${String(rowsStubbed)} rows were stubbed: ${describeError(error)}`;
        refusedReason =
          refusedReason === undefined ? emissionFailure : `${refusedReason}; ${emissionFailure}`;
      }
    }

    // CONTENT-KEY SWEEP. The stub UPDATE above is the only `content_payload =
    // NULL` writer in the tree, which makes this pass the only thing that can
    // retire the last body a session's wrapped DEK ever sealed — so the key's
    // death belongs here. `deleteIfUnreferenced` re-checks the predicate under
    // its own exclusion and is a no-op when any sealed body survives, so this
    // says "a body may have gone" and lets the store decide, rather than
    // computing a liveness answer here that would be stale by the time it ran.
    //
    // GATED ON `rowsStubbed > 0` for cost, not correctness: a pass that stubbed
    // nothing cleared nothing, and the call would be a guaranteed no-op query
    // per idle session per tick.
    //
    // AFTER THE EMISSION, and outside every row hold. `event.compacted` is an
    // `event_maintenance` row whose `content_payload` is NULL by construction,
    // so it cannot change the predicate's answer either way — the ordering is
    // chosen so the sweep observes a settled session rather than one mid-record.
    //
    // ITS OWN try/catch, in the emission's exact idiom and for the same reason:
    // the rows are already stubbed and the pass genuinely succeeded, so a failed
    // cleanup must be REPORTED without being allowed to abort the tick or to
    // erase the mid-loop cause when there was one. Nothing is lost by a failure
    // — the predicate is idempotent and the next pass that stubs a row retries.
    //
    // THE PROMPT PATH, not the only one. A failure here is a DELAY rather than a
    // permanent leak, because `#runPass` runs a reconciliation sweep at the end
    // of every pass that re-derives the same obligation from durable state —
    // which is what makes this call's single attempt acceptable.
    //
    // ONE CONSEQUENCE WORTH STATING, because it is not obvious from here: a
    // `refusedReason` moves this session out of `sessionsCompacted` and into
    // `sessionsRefused` in the tick summary, so a failed sweep reports a session
    // whose rows DID stub as a refusal. That is the counter's stated rule ("a
    // session that stubbed rows and then refused is a refusal") applied to a
    // post-condition this pass genuinely owns — the session is left settled, its
    // record emitted and its dead key retired — and it is the same treatment the
    // emission failure above already gets. The alternative, a silent success
    // with the leaked key unreported, is strictly worse; `rowsStubbed` still
    // counts the rows, so no work is erased by the reclassification.
    if (rowsStubbed > 0) {
      try {
        await this.#contentKeyDisposer.deleteIfUnreferenced(summary.sessionId);
      } catch (error) {
        const sweepFailure = `session content-key sweep failed after ${String(rowsStubbed)} rows were stubbed: ${describeError(error)}`;
        refusedReason =
          refusedReason === undefined ? sweepFailure : `${refusedReason}; ${sweepFailure}`;
      }
    }

    return {
      sessionId: summary.sessionId,
      reason: trigger?.reason,
      fromSequence,
      toSequence: trigger?.cutoffSequence,
      rowsStubbed,
      rowsDeferred,
      bytesReclaimed,
      refusedReason,
    };
  }

  /**
   * Resolve the DAEMON-SCOPE SENTINEL's signing key and immediately discard it,
   * refusing the session's pass when it cannot be resolved.
   *
   * WHY A SEPARATE KEY AT ALL. The stubs are signed with the SESSION's key,
   * resolved further down; `event.compacted` is appended on the sentinel session
   * (`Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring`) and is
   * signed with the SENTINEL's. They are different rows of `daemon_signing_keys`
   * and either can be resolvable while the other is not — so a session key that
   * resolved says nothing about whether this pass will be able to record itself.
   *
   * WHY UP FRONT. The emission runs after the row loop, so without this probe
   * the first evidence of an unresolvable sentinel key arrives once every
   * payload in the range is already gone. That is the unrecorded-destruction
   * outcome the emission note calls the one this module must never produce, and
   * it recurs on every tick because the trigger that fired is still firing.
   *
   * PROBE, NOT HOLD. The resolved key is not returned and not stored: extending
   * private key material's in-memory lifetime across an unbounded row loop buys
   * nothing, since `#emitCompacted`'s append resolves it again at emission time.
   * A key that becomes unresolvable in the gap still fails there — this probe
   * narrows the window, it does not close it, and it is not claimed to.
   *
   * NO KEY MATERIAL IN THE MESSAGE. Only the REJECTION is ever rendered, and a
   * rejection is by construction the absence of a key; the resolved value is
   * discarded without being read, stringified, or logged.
   */
  async #probeSentinelSigningKey(): Promise<void> {
    try {
      await this.#signingKeySource.read(DAEMON_SCOPE_SENTINEL_SESSION_ID);
    } catch (error) {
      throw new CompactionRefusal(
        "the daemon-scope sentinel's signing key could not be resolved, so this pass could not " +
          "append the event.compacted record of its own work; refusing to mutate any row " +
          `(${describeError(error)}).`,
      );
    }
  }

  // ------------------------------------------------------------------------
  // Internal — trigger evaluation
  // ------------------------------------------------------------------------

  #evaluateTriggers(summary: SessionSummary, passInstant: Date): TriggerEvaluation | undefined {
    const storageCutoff: number | undefined = this.#storageTriggerCutoff(summary);
    const countCutoff: number | undefined = this.#countTriggerCutoff(summary);
    const ageCutoffInstant: string = new Date(
      passInstant.getTime() - this.#ageThresholdDays * MILLISECONDS_PER_DAY,
    ).toISOString();
    const ageCutoff: number | undefined = this.#ageTriggerCutoff(summary, ageCutoffInstant);

    // Pushed in precedence order (storage > count > age) rather than assembled
    // from conditional spreads: the spread form needed an `as` cast on
    // `firing[0]` purely to defeat `noUncheckedIndexedAccess`, and that cast
    // would have outlived the `length === 0` guard that justified it.
    const firing: { readonly reason: CompactionReason; readonly cutoff: number }[] = [];
    if (storageCutoff !== undefined) {
      firing.push({ reason: "storage_threshold", cutoff: storageCutoff });
    }
    if (countCutoff !== undefined) {
      firing.push({ reason: "count_threshold", cutoff: countCutoff });
    }
    if (ageCutoff !== undefined) {
      firing.push({ reason: "age_threshold", cutoff: ageCutoff });
    }

    const highestPrecedence = firing[0];
    if (highestPrecedence === undefined) {
      return undefined;
    }

    // The reported reason is the highest-precedence firing trigger; the anchor
    // span reaches the greatest bound any of them produced.
    const cutoffSequence: number = firing.reduce(
      (highest, candidate) => (candidate.cutoff > highest ? candidate.cutoff : highest),
      Number.NEGATIVE_INFINITY,
    );

    // Count and storage share the prefix bound (both describe an oldest-first
    // prefix); age contributes only its per-row bound.
    const prefixCutoffSequence: number | undefined =
      storageCutoff !== undefined && countCutoff !== undefined
        ? Math.max(storageCutoff, countCutoff)
        : (storageCutoff ?? countCutoff);

    const evaluation: TriggerEvaluation = {
      reason: highestPrecedence.reason,
      cutoffSequence,
      prefixCutoffSequence,
      ageCutoffInstant: ageCutoff === undefined ? undefined : ageCutoffInstant,
    };
    if (
      evaluation.prefixCutoffSequence === undefined &&
      evaluation.ageCutoffInstant === undefined
    ) {
      // Unreachable: `firing` is non-empty here, and each of the three triggers
      // sets one of these two bounds. Asserted anyway because the failure it
      // guards is invisible — both bounds NULL makes the candidate scan match
      // nothing, so a fired trigger would compact zero rows and report success.
      throw new CompactionRefusal(
        `trigger ${evaluation.reason} fired for session ${summary.sessionId} but produced ` +
          "neither a prefix bound nor an age bound; refusing rather than scanning no candidates.",
      );
    }
    return evaluation;
  }

  #countTriggerCutoff(summary: SessionSummary): number | undefined {
    if (summary.liveCount <= this.#eventCountThreshold) {
      return undefined;
    }
    const excess: number = summary.liveCount - this.#eventCountThreshold;
    const row: unknown = this.#countCutoffStmt.get(summary.sessionId, excess - 1);
    return readOptionalSequence(row, "count-trigger cutoff");
  }

  #ageTriggerCutoff(summary: SessionSummary, ageCutoffInstant: string): number | undefined {
    const row: unknown = this.#ageCutoffStmt.get(summary.sessionId, ageCutoffInstant);
    return readOptionalSequence(row, "age-trigger cutoff");
  }

  #storageTriggerCutoff(summary: SessionSummary): number | undefined {
    if (summary.liveBytes <= this.#storageThresholdBytes) {
      return undefined;
    }
    const overage: number = summary.liveBytes - this.#storageThresholdBytes;
    const row: unknown = this.#storageCutoffStmt.get(summary.sessionId, overage);
    return readOptionalSequence(row, "storage-trigger cutoff");
  }

  // ------------------------------------------------------------------------
  // Internal — per-row attribute-and-stub
  // ------------------------------------------------------------------------

  /**
   * ONE hold on the session's append lock, spanning read → attribute → project
   * → canonicalize → sign → UPDATE.
   *
   * The attribution await is inside the hold BY DESIGN: serializing the
   * compactor's attribute-and-stub against the Plan-004 admission side's
   * span-check-plus-intervention-write is the reason the hold exists, and an
   * attribution resolved outside it could be invalidated by an intervention
   * admitted in the gap — producing an unstamped stub for a row that a rollback
   * had, by then, rewound past.
   *
   * ### Per-row commits, and the "one transaction" the spec asks for
   *
   * `Spec-006 §Post-Compaction Integrity` step 5 says "ONLY THEN mutate the rows
   * in one transaction", and I-006-3-03 repeats it. This module instead commits
   * ONE ROW PER HOLD, and the deviation is forced rather than chosen: the plan
   * mandates one append-lock hold per row and forbids holding across I/O, while
   * the attribution call is an await that must happen inside the hold (above).
   * A single transaction spanning every row would therefore have to span every
   * attribution round-trip too — one hold across N foreign calls, which is the
   * exact shape the locking rule exists to forbid, and on a 50,000-row pass it
   * would stall every producer on the session for the whole pass.
   *
   * What the "one transaction" phrasing protects is that no row is ever left
   * half-compacted — payload replaced but signature or discriminator missing —
   * and that survives per-row commits intact: each row's replace-plus-sign-plus-
   * discriminate is a single UPDATE, hence atomic. What per-row commits give up
   * is all-or-nothing across the RANGE, and the spec already admits exactly that
   * state: its verifier semantics define mixed ranges, running per-row chain
   * recomputation on the uncompacted rows and the three compacted-row checks on
   * the stubs. A partially-compacted range is a range the verifier is specified
   * to accept, so the invariant's property holds per row where it is meaningful.
   */
  async #attributeAndStubRow(
    sessionId: SessionId,
    sequence: number,
    signingKey: Ed25519PrivateKey,
    passInstant: Date,
  ): Promise<{
    readonly stubbed: boolean;
    readonly deferred: boolean;
    readonly bytesReclaimed: number;
  }> {
    return withSessionAppendLock(sessionId, async () => {
      const raw: unknown = this.#candidateRowStmt.get(sessionId, sequence);
      if (raw === undefined) {
        // Compacted by a concurrent pass, or shredded away, between the
        // candidate scan and this hold. Not an error — the `compensable`
        // re-entry property is exactly this.
        return { stubbed: false, deferred: false, bytesReclaimed: 0 };
      }
      const row = raw as CandidateRow;

      const eventId: string = readString(row.id, "session_events.id");
      const storedPayload: string = readString(row.payload, "session_events.payload");
      // Measured off the STORED text, not off a re-serialization of the parsed
      // object: the two disagree by whatever key order and whitespace the
      // original write used, and this number is both frozen into the signed
      // stub summary and reported as reclaimed bytes. One reading, one figure.
      const storedPayloadByteLength: number = Buffer.byteLength(storedPayload, "utf8");
      const payloadObject: Record<string, unknown> = parsePayload(storedPayload, eventId);
      const runId: unknown = payloadObject[RUN_ID_PAYLOAD_KEY];
      const isRunScoped: boolean = runId !== undefined && runId !== null;

      // Attribution is a RUN-scoped question (see `RollbackAttributionSource`),
      // so a row with no run identity is never asked about and can never defer.
      const attribution: RollbackAttribution = isRunScoped
        ? await this.#rollbackAttributionSource.attributeAtCompaction({
            sessionId,
            eventId,
            sequence,
          })
        : { disposition: "current" };

      if (attribution.disposition === "defer") {
        return { stubbed: false, deferred: true, bytesReclaimed: 0 };
      }

      const projection: AuditStubProjection = this.#projectAuditStub(
        sessionId,
        row,
        eventId,
        payloadObject,
        storedPayloadByteLength,
        attribution,
        passInstant,
      );

      // SIGN-EXACT-BYTES. `B` is the bounded canonicalization's FINAL output —
      // produced once, the signature covers `B`, and the statement after the
      // width check stores the UTF-8 decoding of that same `B`. Nothing
      // downstream of the bounded producer may re-serialize the projection.
      //
      // The decode step is sound because `canonicalizeJson` refuses a projection
      // containing a lone surrogate (`canonicalizer.ts`'s well-formed-strings
      // guard, RFC 8785 §3.2.2.2). That guard is load-bearing HERE and not only
      // there: relaxing it would let `B` hold an unpaired surrogate, the
      // TextDecoder would substitute U+FFFD on the way to the column, and every
      // `stub_signature` written for such a row would fail verification against
      // the bytes actually stored — silently, and only for the affected rows.
      const canonicalStubBytes: CanonicalBytes = canonicalizeBoundedStubProjection(
        projection,
        eventId,
      );
      const stubSignature: Uint8Array = ed25519.sign(canonicalStubBytes, signingKey);
      if (stubSignature.length !== ED25519_SIGNATURE_LENGTH) {
        // Mirrors the check `anchorRange` runs before binding `root_signature`.
        // The column is a bare BLOB and the verifier treats a `stub_signature`
        // that fails to verify as tamper evidence, so a wrong-length signature
        // would be indistinguishable at verify time from a forged row.
        throw new CompactionRefusal(
          `stub signature for event ${eventId} is ${String(stubSignature.length)} bytes, ` +
            `expected ${String(ED25519_SIGNATURE_LENGTH)}.`,
        );
      }
      const storedStubText: string = new TextDecoder().decode(canonicalStubBytes);

      const result = this.#stubUpdateStmt.run(
        storedStubText,
        AUDIT_STUB_RETENTION_CLASS,
        Buffer.from(stubSignature),
        eventId,
        sessionId,
      );
      if (result.changes !== 1) {
        // The `retention_class IS NULL` guard matched nothing, which under this
        // hold can only mean the row moved out from under a read taken inside
        // the same critical section. Loud rather than silent: a zero-change
        // UPDATE reported as a success would count a row as stubbed that still
        // holds its full payload.
        throw new CompactionRefusal(
          `audit-stub UPDATE for event ${eventId} (sequence ${String(sequence)}) changed ` +
            `${String(result.changes)} rows, expected 1.`,
        );
      }

      const originalBytes: number =
        storedPayloadByteLength +
        readNumber(row.pii_bytes, "pii byte length") +
        readNumber(row.content_bytes, "content byte length");
      const stubBytes: number = canonicalStubBytes.length;
      return {
        stubbed: true,
        deferred: false,
        bytesReclaimed: Math.max(0, originalBytes - stubBytes),
      };
    });
  }

  #projectAuditStub(
    sessionId: SessionId,
    row: CandidateRow,
    eventId: string,
    payloadObject: Record<string, unknown>,
    storedPayloadByteLength: number,
    attribution: Extract<RollbackAttribution, { disposition: "current" | "superseded" }>,
    passInstant: Date,
  ): AuditStubProjection {
    // PARSED, not cast. This value is signed into the stub and is then what the
    // verifier's scalar-binding check compares the `category` column against, so
    // a column holding something outside the canonical enum would be frozen into
    // the projection by the one operation that destroys the evidence of how it
    // got there. The `merkle-anchor-service.ts` parsed-not-cast convention, on
    // the surface where it matters most.
    const category: EventCategory = EventCategorySchema.parse(
      readString(row.category, "session_events.category"),
    );
    const type: string = readString(row.type, "session_events.type");

    const projection: AuditStubProjection = {
      // Scalar counterparts. Each of these is read back by the verifier's
      // scalar-binding check and asserted byte-equal to its column, so every one
      // is taken from the STORED row rather than recomputed.
      id: eventId,
      sessionId,
      sequence: readNumber(row.sequence, "session_events.sequence"),
      occurredAt: readString(row.occurred_at, "session_events.occurred_at"),
      category,
      type,
      actor: readNullableString(row.actor, "session_events.actor"),
      // Column-less members, minted here and existing only inside these bytes.
      compactedAt: passInstant.toISOString(),
      retentionClass: AUDIT_STUB_RETENTION_CLASS,
      summary: buildStubSummary(category, type, payloadObject, storedPayloadByteLength),
    };

    for (const key of PRESERVED_PAYLOAD_KEYS) {
      const value: unknown = payloadObject[key];
      if (value !== undefined) {
        projection[key] = value;
      }
    }

    if (attribution.disposition === "current") {
      if (attribution.position !== undefined) {
        projection[ORIGIN_POSITION_STUB_KEY] = assertNonNegativeInteger(
          attribution.position,
          `attribution position for event ${eventId}`,
        );
      }
      return projection;
    }

    // SUPERSEDED — stamp the triple. Each member is checked against whatever the
    // payload already carried rather than overwritten: a disagreement means the
    // attribution source contradicts a value the daemon SIGNED at ingest, and
    // compaction is irreversible, so the row must not be stubbed under either
    // reading. `runId` in particular appears once in the projection — the
    // preserved payload copy and the attribution's copy cannot both be written —
    // so a mismatch is not merely suspicious, it is unresolvable.
    stampAttributionMember(
      projection,
      SOURCE_EPOCH_PAYLOAD_KEY,
      assertNonNegativeInteger(attribution.sourceEpoch, `sourceEpoch for event ${eventId}`),
      eventId,
    );
    stampAttributionMember(
      projection,
      SOURCE_POSITION_PAYLOAD_KEY,
      assertNonNegativeInteger(attribution.sourcePosition, `sourcePosition for event ${eventId}`),
      eventId,
    );
    stampAttributionMember(projection, RUN_ID_PAYLOAD_KEY, attribution.runId, eventId);
    return projection;
  }

  // ------------------------------------------------------------------------
  // Internal — `event.compacted` emission
  // ------------------------------------------------------------------------

  /**
   * One `event.compacted` per compacted SESSION.
   *
   * `fromSeq` / `toSeq` are session-scoped sequence bounds, so a single event
   * spanning several sessions could not name a meaningful range — which is why
   * `Spec-006 §Event Maintenance (event_maintenance)` grants a single-session
   * pass the option of carrying that session's real id. The row binds the
   * daemon-scope sentinel at the ENVELOPE (it is a daemon-scope maintenance
   * event, and its own category is never compacted) while the payload carries
   * the real session.
   *
   * ### What `fromSeq` / `toSeq` mean here
   *
   * They bound the rows this pass ACTUALLY STUBBED — the lowest and highest such
   * sequence — not the range it scanned. The scanned range is wider whenever a
   * candidate deferred, and wider still under an age-triggered pass, whose
   * candidate set is sparse by design. Reporting the scanned range would tell a
   * consumer that rows it never touched are now stubs, and after a mid-loop
   * refusal it would name a range whose tail still holds full payloads.
   *
   * Even narrowed, the range is a BOUND and not a partition: never-compacted
   * rows and deferred rows can sit inside it and remain live. A consumer that
   * needs the count reads `tombstoneCount`; one that needs per-row truth reads
   * `retention_class`. Narrowing is safe for the integrity path because nothing
   * locates a covering anchor through this event —
   * `Spec-006 §Post-Compaction Integrity`'s verifier reads the anchor from
   * `pending_anchor_uploads` / `event_log_anchors` keyed on the row's own
   * sequence, and the anchor obtained by this pass covers the wider scanned
   * span, so it covers every narrowed row a fortiori.
   */
  async #emitCompacted(input: {
    readonly sessionId: SessionId;
    readonly operationId: string;
    readonly passInstant: Date;
    readonly fromSequence: number;
    readonly toSequence: number;
    readonly eventsBefore: number;
    readonly eventsAfter: number;
    readonly bytesReclaimed: number;
    readonly rowsStubbed: number;
    readonly reason: CompactionReason;
  }): Promise<void> {
    const occurredAt: string = input.passInstant.toISOString();
    // `.parse()`d at the emission seam — the emitter-parses convention, so a
    // drifted field set fails here rather than persisting an unvalidated
    // payload into the audit log.
    const payload: EventCompactedPayload = EventCompactedPayloadSchema.parse({
      nodeId: this.#nodeId,
      operationId: input.operationId,
      occurredAt,
      sessionId: input.sessionId,
      fromSeq: input.fromSequence,
      toSeq: input.toSequence,
      // Live (uncompacted) compactable rows for the session before and after the
      // pass. The row COUNT reading would be vacuous — compaction rewrites rows
      // and never deletes them, so it would report the same number twice.
      eventsBefore: input.eventsBefore,
      eventsAfter: input.eventsAfter,
      bytesReclaimed: input.bytesReclaimed,
      // The audit stubs this pass minted — Kafka's tombstone vocabulary, which
      // the spec's field set borrows: a stub is this log's tombstone, the
      // bounded record that stands where the full payload was.
      tombstoneCount: input.rowsStubbed,
      compactionReason: input.reason,
    });

    await this.#eventLog.append({
      id: this.#newEventId(),
      sessionId: DAEMON_SCOPE_SENTINEL_SESSION_ID,
      occurredAt,
      category: EVENT_MAINTENANCE_CATEGORY,
      type: EVENT_COMPACTED_TYPE,
      actor: null,
      // `EventCompactedPayload` is an object TYPE ALIAS, which TypeScript grants
      // an implicit index signature — so this is a safe specific-to-general
      // widening, not a reinterpretation (the `node-event-emitter.ts` note on
      // the same conversion carries the full reasoning).
      payload: payload as Record<string, unknown>,
      version: COMPACTOR_EVENT_VERSION,
    });
  }

  // ------------------------------------------------------------------------
  // Internal — reads
  // ------------------------------------------------------------------------

  /**
   * The census, with ONE malformed partition skipped rather than fatal.
   *
   * This read runs before any session's guarded pass, so a throw here aborts
   * the whole tick before a single session is examined. Every field is
   * therefore probed rather than asserted: a corrupt aggregate on one
   * `session_id` must not stop the pass from compacting every well-formed one —
   * the same reasoning the branded-id parse below already applied, extended to
   * the numeric reads it sat beside.
   *
   * Every skip is COUNTED, and the count rides back to the pass result as
   * `sessionsUnreadable`. Skipping silently would convert this hardening into a
   * permanent silent failure: the skipped partition would appear in no field of
   * a {@link CompactionPassResult}, so it would stop compacting forever with no
   * operator signal.
   */
  #readSessionSummaries(): SessionCensus {
    const rows: readonly unknown[] = this.#sessionSummaryStmt.all();
    const summaries: SessionSummary[] = [];
    let unreadableCount = 0;
    for (const raw of rows) {
      const row = raw as SessionSummaryRow;
      // A session id that does not parse cannot be handed to `anchorRange` (it
      // takes the branded `SessionId`) and cannot be trusted as a lock key.
      const sessionIdText: unknown = row.session_id;
      if (typeof sessionIdText !== "string") {
        unreadableCount += 1;
        continue;
      }
      const parsed = SessionIdSchema.safeParse(sessionIdText);
      if (!parsed.success) {
        unreadableCount += 1;
        continue;
      }
      const liveCount: number | undefined = optionalFiniteNumber(row.live_count);
      const minSequence: number | undefined = optionalFiniteNumber(row.min_sequence);
      const liveBytes: number | undefined = optionalFiniteNumber(row.live_bytes);
      if (liveCount === undefined || minSequence === undefined || liveBytes === undefined) {
        unreadableCount += 1;
        continue;
      }
      summaries.push({ sessionId: parsed.data, liveCount, minSequence, liveBytes });
    }
    return { summaries, unreadableCount };
  }

  #readCandidateSequences(
    sessionId: SessionId,
    fromSequence: number,
    toSequence: number,
    trigger: TriggerEvaluation,
  ): readonly number[] {
    // Named binds — the two trailing bounds are nullable and their SQL is an OR
    // of two self-neutralizing comparisons (see the statement).
    const rows: readonly unknown[] = this.#candidateSequencesStmt.all({
      sessionId,
      fromSequence,
      toSequence,
      prefixCutoffSequence: trigger.prefixCutoffSequence ?? null,
      ageCutoffInstant: trigger.ageCutoffInstant ?? null,
    });
    return rows.map((raw) =>
      readNumber((raw as { readonly sequence: unknown }).sequence, "candidate sequence"),
    );
  }
}

// --------------------------------------------------------------------------
// Module-local helpers
// --------------------------------------------------------------------------

/** The result a guard-rejected {@link Compactor.tick} returns without doing work. */
function emptyPassResult(operationId: string): CompactionPassResult {
  return {
    operationId,
    sessionsExamined: 0,
    sessionsCompacted: 0,
    sessionsRefused: 0,
    sessionsUnreadable: 0,
    rowsStubbed: 0,
    rowsDeferred: 0,
    bytesReclaimed: 0,
    // A guard-rejected tick did no work of any kind, the sweep included: it is
    // rejected precisely because another pass is running or an append hold is
    // open, and both are states the sweep must not run inside.
    contentKeysReclaimed: 0,
    contentKeysSkipped: 0,
    outcomes: [],
  };
}

/** A `catch` binding rendered for a `refusedReason`, whatever was thrown. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A finite number, or `undefined` when the column held anything else.
 *
 * The probing counterpart to {@link readNumber}: used where a malformed value
 * must skip ONE session rather than abort the pass. SQLite hands back `bigint`
 * for large integers under some driver settings, so those are accepted and
 * narrowed rather than rejected — but only when the value round-trips, since a
 * count or byte total past 2^53 is not something this module can arithmetic on
 * honestly.
 */
function optionalFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "bigint") {
    const narrowed = Number(value);
    return Number.isSafeInteger(narrowed) ? narrowed : undefined;
  }
  return undefined;
}

/**
 * The human-readable one-liner `Spec-006 §Compacted Event Format` requires,
 * generated at compaction time from the original payload.
 *
 * Deliberately composed from the row's SHAPE (category, type, field count, byte
 * count) and never from payload VALUES. A stub carries no PII — `pii_payload`
 * and its owner stamp are cleared in the same UPDATE — so interpolating payload
 * content here would re-introduce, in signed and indefinitely-retained bytes,
 * exactly what the rest of the operation removes. Shape-composition also keeps
 * the summary SMALL for every row the ceiling-enforced append path wrote
 * (`type` is capped at the wire), but smallness here is a property, not the
 * enforcement: {@link canonicalizeBoundedStubProjection} holds the WHOLE
 * projection to `EVENT_CANONICAL_BYTES_MAX` at the sign site, and this field
 * is the one it may truncate to get there.
 */
function buildStubSummary(
  category: EventCategory,
  type: string,
  payloadObject: Record<string, unknown>,
  storedPayloadByteLength: number,
): string {
  const fieldCount: number = Object.keys(payloadObject).length;
  return (
    `${category}/${type}: original payload discarded at compaction ` +
    `(${String(fieldCount)} fields, ${String(storedPayloadByteLength)} bytes)`
  );
}

/**
 * Canonicalize a stub projection under the append path's
 * `EVENT_CANONICAL_BYTES_MAX` bound (`Spec-006 §Compacted Event Format`,
 * 2026-08-12 amendment), truncating the locally-minted `summary` toward the
 * bound and REFUSING when the projection stays oversized with `summary` gone.
 *
 * Why this can fire at all: the append path enforces the same ceiling on
 * every row it writes, but this module reads rows straight off SQLite — rows
 * written before the ceiling existed, or outside `EventLogService` entirely —
 * and the preserve-when-present loop copies payload members into the
 * projection verbatim. `summary` is the one member minted HERE, locally
 * generated prose rather than signed origin content, so it is the one member
 * a bound may lawfully shorten (the same reasoning by which `Spec-006
 * §Compacted Event Format` names it the truncation target). Everything else
 * is either a verifier-checked scalar counterpart or preserved attribution
 * content whose loss would strand a later rollback or entitlement check —
 * truncating those would trade an unservable stub for a corrupt one — so a
 * projection still over the bound with an empty summary throws
 * {@link CompactionRefusal}: the row stays live, the pass reports the
 * refusal, and the next pass re-encounters it loudly rather than this one
 * signing a stub the Spec-008 backfill seam can never carry.
 *
 * Truncation is measured on CANONICAL BYTES, never on string length: the
 * overage is a byte figure, and each round cuts at least that many CODE
 * POINTS off the summary's tail. Every code point serializes to ≥ 1 canonical
 * byte, so each round removes ≥ the overage and the loop strictly converges
 * (one round in the common all-ASCII case; a second only when escape
 * sequences or multi-byte characters made the first cut overshoot
 * impossible). Cutting by code points via `Array.from` rather than by UTF-16
 * units is load-bearing, not style: `type` is caller-supplied and embedded in
 * the summary, and a `.slice` that split a surrogate pair would turn a bound
 * violation into a hard `canonicalizeJson` refusal (the RFC 8785 §3.2.2.2
 * well-formed-strings guard) on the very next round.
 */
function canonicalizeBoundedStubProjection(
  projection: AuditStubProjection,
  eventId: string,
): CanonicalBytes {
  // Truncation rounds rebuild a fresh object rather than assigning into the
  // caller's projection: the caller must never observe a summary that differs
  // from the one the returned bytes canonicalize.
  let boundedProjection: AuditStubProjection = projection;
  let canonicalStubBytes: CanonicalBytes = canonicalizeJson(boundedProjection);
  while (
    canonicalStubBytes.length > EVENT_CANONICAL_BYTES_MAX &&
    boundedProjection.summary.length > 0
  ) {
    const overage: number = canonicalStubBytes.length - EVENT_CANONICAL_BYTES_MAX;
    const summaryCodePoints: readonly string[] = Array.from(boundedProjection.summary);
    boundedProjection = {
      ...boundedProjection,
      summary: summaryCodePoints.slice(0, Math.max(0, summaryCodePoints.length - overage)).join(""),
    };
    canonicalStubBytes = canonicalizeJson(boundedProjection);
  }
  if (canonicalStubBytes.length > EVENT_CANONICAL_BYTES_MAX) {
    throw new CompactionRefusal(
      `audit-stub projection for event ${eventId} is ${String(canonicalStubBytes.length)} ` +
        `canonical bytes with its summary already emptied — over the ` +
        `${String(EVENT_CANONICAL_BYTES_MAX)}-byte EVENT_CANONICAL_BYTES_MAX bound every ` +
        `stored payload must satisfy (Spec-006 §Compacted Event Format). Refusing to stub: ` +
        `every remaining member is a verifier-checked scalar or preserved attribution ` +
        `content this pass may not shorten.`,
    );
  }
  return canonicalStubBytes;
}

/**
 * Write one attribution-supplied member, refusing rather than overwriting when
 * the payload already carries a DIFFERENT value for it (see the call site).
 */
function stampAttributionMember(
  projection: AuditStubProjection,
  key: string,
  value: number | string,
  eventId: string,
): void {
  const existing: unknown = projection[key];
  if (existing !== undefined && existing !== value) {
    throw new CompactionRefusal(
      `rollback attribution for event ${eventId} reports ${key}=${String(value)} but the row's ` +
        `signed payload carries ${key}=${String(existing)}; refusing to stub a row whose ` +
        "attribution contradicts its own signed bytes.",
    );
  }
  projection[key] = value;
}

function parsePayload(storedPayload: string, eventId: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storedPayload);
  } catch (error) {
    throw new CompactionRefusal(
      `session_events.payload for event ${eventId} is not valid JSON ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CompactionRefusal(
      `session_events.payload for event ${eventId} is not a JSON object; the stub projection ` +
        "cannot read the preserved members out of it.",
    );
  }
  return parsed as Record<string, unknown>;
}

function assertNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new CompactionRefusal(
      `${label} must be a non-negative integer, got ${String(value)}; refusing to sign it into a ` +
        "stub that is retained indefinitely.",
    );
  }
  return value;
}

// `MIN`/`MAX`/`OFFSET` cutoff reads: SQLite answers "no such row" as either a
// missing row or a row whose aggregate is NULL, and both mean the same thing
// here (this trigger names no candidate).
function readOptionalSequence(row: unknown, label: string): number | undefined {
  if (row === undefined || row === null) {
    return undefined;
  }
  const value: unknown = (row as { readonly cutoff: unknown }).cutoff;
  if (value === null || value === undefined) {
    return undefined;
  }
  return readNumber(value, label);
}

function readString(value: unknown, column: string): string {
  if (typeof value === "string") return value;
  throw new CompactionRefusal(
    `${column} is not TEXT (got ${typeof value}); the stored row is corrupt.`,
  );
}

function readNullableString(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  return readString(value, column);
}

/**
 * The refusing counterpart to {@link optionalFiniteNumber}, and it applies the
 * SAME bigint rule: a `bigint` is accepted only when it round-trips through
 * `Number` as a safe integer.
 *
 * The two must not disagree. The values that reach here are sequences and byte
 * counts read out of the same rows the probing reader measures, and they flow
 * into arithmetic (`sequence + 1`, byte subtraction) and into signed stub
 * payloads. A bare `Number(value)` past 2^53 silently yields a NEIGHBOURING
 * integer — which as a sequence names a DIFFERENT row than the one the database
 * returned, and as a byte count gets signed into a stub retained indefinitely.
 * Refusing is the only honest answer at that magnitude.
 */
function readNumber(value: unknown, column: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") {
    const narrowed: number = Number(value);
    if (Number.isSafeInteger(narrowed)) return narrowed;
    throw new CompactionRefusal(
      `${column} is a bigint past the safe-integer range (${String(value)}); refusing to narrow ` +
        "it, because the nearest double names a different row than the one stored.",
    );
  }
  throw new CompactionRefusal(
    `${column} is not a finite INTEGER (got ${typeof value}); the stored row is corrupt.`,
  );
}
