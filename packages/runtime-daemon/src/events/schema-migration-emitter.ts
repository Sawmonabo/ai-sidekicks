// Plan-006 T3.4 — the schema-migration emitter.
//
// One `schema.migrated` event per completed migration BATCH, appended to the
// daemon's own log under the daemon-scope sentinel session. Batch granularity
// is the spec's own, not a simplification: `Spec-006 §Event Maintenance
// (event_maintenance)` fires this type "once per migration batch (equivalent to
// Flyway's `AFTER_MIGRATE_OPERATION_FINISH`), not once per SQL statement", so a
// start that applies versions 5 through 8 produces exactly one row carrying the
// whole batch.
//
// ----------------------------------------------------------------------------
// Two entry points, one emission seam — and why BOTH are needed
// ----------------------------------------------------------------------------
//
//   * {@link SchemaMigrationEmitter.emitBatchCompletion} — the PRIMARY path.
//     The batch's caller hands over what it just committed, including the SQL it
//     actually executed.
//   * {@link SchemaMigrationEmitter.reconcileOnStartup} — the FALLBACK path.
//     Compares the durable `schema_version` table against the newest recorded
//     `schema.migrated` event: gap-fills whatever the log never recorded, and
//     reports the opposite divergence — durable state BEHIND the log — rather
//     than emitting for it.
//
// The primary path alone would leave a permanent hole, and naming the hole is
// the whole argument for the second path. Each migration COMMITS in its own
// transaction (`migration-runner.ts`); the event is appended AFTERWARDS, through
// a service that allocates a sequence, chains a hash and signs the row. A daemon
// killed between those two points has a migrated database and no record of the
// migration — permanently, because the runner's `hasMigrationApplied` guard sees
// the migration as applied and will never re-run it, so the callback is never
// re-offered. Reconcile is what makes that window recoverable at the next start.
//
// IDEMPOTENCY CLASS: `manual_reconcile_only`, and deliberately not `idempotent`.
// A retry cannot reproduce the first attempt's row: the append allocates a fresh
// `sequence`, chains to a different `prev_hash` and stamps a new `occurredAt`,
// so re-running after a partial failure mints a SECOND, unrelated commitment
// rather than converging on the first. Nothing here deduplicates on the caller's
// behalf, and nothing can — the reconcile gap query is the recovery mechanism,
// and it is a comparison of durable state, not a retry.
//
// ----------------------------------------------------------------------------
// The checksum — plain concatenation, ascending version order
// ----------------------------------------------------------------------------
//
// `checksum` is BLAKE3 over the migrations' SQL bytes, concatenated in ascending
// `version` order and hashed once; the digest is carried base64, matching how
// every other byte field in this package reaches the wire. Plan-006 T3.4 and the
// `checksum` field comment in `@ai-sidekicks/contracts` both specify the
// construction as "over concatenated migration file contents", so the framing a
// hash construction would normally want (length prefixes, an id bound in) is
// deliberately absent: changing it is a corpus edit first, then this file, then
// any verifier — the same ordering `merkle-anchor-service.ts` records for its
// own construction. What the corpus leaves free is the ORDER, pinned here to
// ascending version so the digest is a function of the batch's content and not
// of the caller's array order.
//
// RESIDUAL, stated rather than closed: an unframed concatenation cannot tell a
// statement that MOVED between two migrations in the same batch from one that
// did not. The defence this checksum actually provides is the one the task
// names — silent divergence of migration CONTENT between what a daemon has
// executed and what a later reader believes it executed — and content moving
// across a boundary inside one batch is invisible to it.
//
// WHY THE BATCH CARRIES SQL AND A REGISTRY IS STILL REQUIRED. The primary path
// hashes the bytes the batch reports executing, which is the strongest thing it
// can commit to. The reconcile path has no such report — a gap is discovered
// from `schema_version` rows written by a process that is gone — so it resolves
// each version through {@link SchemaMigrationEmitterDeps.migrationSources}. Two
// sources for one value invite silent disagreement, so every batch entry is
// CROSS-CHECKED against the registry before it is hashed: a registry that has
// drifted from what the runner executes is itself the migration-file divergence
// this checksum exists to catch, and it is caught at the seam rather than
// years later in an audit.
//
// SECOND RESIDUAL, on the reconcile path specifically. A gap fill's checksum is
// computed over the CURRENT registry's bytes, so it witnesses what this daemon
// build believes those migrations are — not what the vanished process actually
// executed. If the binary was upgraded between the crash and the next start,
// and a shipped migration's SQL changed in that upgrade, the reconstructed row
// launders the new bytes as though they were the executed ones. The cross-check
// above cannot see this: there is no executed-bytes report to compare against.
// The `reconcile:` marker on `operationId` is what tells a later reader that
// this row's checksum is a claim about the registry rather than a witness of an
// execution, and it is the reason gap fills are worth distinguishing at all.
//
// ----------------------------------------------------------------------------
// What is NOT emitted
// ----------------------------------------------------------------------------
//
// A batch that applied NOTHING produces no event, in both of its cases:
//
//   * Nothing to do (the ordinary start, every migration already applied). The
//     `event_maintenance` rows are never compacted and never shredded
//     (`Spec-006 §Event Maintenance (event_maintenance)`), so a row per daemon
//     start is unbounded permanent growth recording that nothing happened.
//   * A batch that FAILED before committing anything. There is no honest row to
//     write: `migrationId` and `checksum` are required non-empty fields, and
//     neither has a value when no migration landed. Minting a `schema.migrated`
//     row for a migration that never landed would put a false record into the
//     log to describe a failure the runner already raises to its caller.
//
// A PARTIAL batch — some migrations committed, then one threw — DOES emit, with
// `success: false` over the migrations that actually landed. That is the case
// where the flag carries information the sequence of committed versions cannot.
//
// THE TWO CORPUS LINES THIS RULE HAS TO ANSWER TO, since both look like they say
// otherwise. `Spec-006 §Event Maintenance (event_maintenance)` pins the row at
// "one event per `sidekicks db migrate` invocation, not one per migration file",
// which is a statement about GRANULARITY — batch rather than file — and says
// nothing about which outcomes are recordable; this file honours it by emitting
// once per batch regardless of how many migrations the batch spans. And
// `docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session
// Event Taxonomy` glosses the field as "false is representable — a failed batch
// is the row worth auditing", which this rule agrees with wherever the row can
// be built: `success: false` is emitted for every batch that committed anything.
// The total-failure row is not withheld by policy, it is UNCONSTRUCTIBLE —
// `MigrationBatchResult` reports only committed migrations, so a batch that
// committed none carries no migration to name in `migrationId` and no bytes to
// hash into `checksum`. Recording that outcome would need a payload shape that
// can describe an ATTEMPT, which is a contracts change and not this file's.
//
// ----------------------------------------------------------------------------
// Which failures propagate, and which substitute
// ----------------------------------------------------------------------------
//
// Split by whether the field carries integrity or a label:
//
//   * INTEGRITY-BEARING inputs propagate. A gap version the registry cannot
//     resolve, a registry entry filed under a version it does not declare, a
//     batch whose reported endpoints disagree with the migrations it lists, a
//     batch entry whose SQL disagrees with the registry, an applied version
//     absent from `schema_version`, a `schema_version.version` or stored
//     `toVersion` that is not a version — each throws, and the caller decides
//     how fatal that is.
//   * COSMETIC inputs substitute. `schema_version.description` is nullable, and
//     the payload's `description` must be non-empty, non-blank and NUL-free; a
//     startup that fails because a migration was recorded without a usable label
//     would be a self-inflicted outage over a display string, so any unusable
//     one becomes {@link SCHEMA_MIGRATION_UNLABELLED_DESCRIPTION}. Integrity
//     here rides the checksum, not the prose.
//   * ONE DIVERGENCE IS REPORTED RATHER THAN THROWN OR SWALLOWED: durable state
//     BEHIND the log — a `schema_version` that has been emptied or rolled back
//     while a signed `schema.migrated` row remembers a higher version. It is not
//     an input this emitter can refuse (both sides are durable, and neither is
//     wrong on its face), and it must not read as "nothing to do", which is what
//     an early return on an empty table used to make it. So it comes back as the
//     `durable_state_behind_log` outcome, non-fatal, for the caller to surface.
//     Startup stays alive: a daemon that refuses to run cannot serve the very
//     log that recorded the divergence.
//
// ----------------------------------------------------------------------------
// Reconcile precision
// ----------------------------------------------------------------------------
//
// The gap query is `MAX(sequence)` over `schema.migrated` rows SCOPED TO THE
// SENTINEL SESSION. The scope is load-bearing rather than defensive: `sequence`
// is allocated per session, so an unscoped maximum compares positions in
// different hash chains. Every `event_maintenance` row is sentinel-bound
// (`Spec-006 §Event Maintenance (event_maintenance)`), and the one carve-out in
// that rule is scoped to `event.compacted`, so for this type the sentinel is the
// only chain the row can be in.
//
// ONE event fills the whole gap, however many versions it spans. The original
// batch boundaries are not recoverable — `schema_version` records a version, a
// timestamp and a description per row, and nothing that groups rows into the
// operation that applied them — so a reconstruction into "the batches that
// probably happened" would be invention. `executionMs` is 0 on this path,
// meaning UNKNOWN rather than instantaneous, and `operationId` carries the
// {@link RECONCILE_OPERATION_ID_PREFIX} marker so a reader can tell a
// reconstructed record from a witnessed one. `appliedBy` names the reconciling
// component, which on this path is the daemon that FOUND the gap and not the one
// that applied the migrations; that is the only honest reading, since
// `schema_version` has no applier column to recover the original from.
//
// The gap read and the append run under ONE {@link withSessionAppendLock} hold
// on the sentinel session, which the nested append reuses re-entrantly. That
// closes the read-then-write window outright in-process: a concurrent primary
// emit cannot slip between this read and this append, because its own append
// queues on the same lock and lands strictly after. Two reconciles cannot both
// observe the same gap for the same reason.
//
// The lock is process-local, and that is the residual: two daemons against one
// database file could each observe the gap and each emit a fill. Unlike the
// append path — where `UNIQUE (session_id, sequence)` is a storage-level
// backstop — there is NO such constraint here, and a duplicated gap fill is
// over-recording rather than corruption.
//
// ORDERING PRECONDITION: reconcile before the first batch of a start, not
// alongside it. The lock orders a batch's APPEND against this one, but nothing
// orders a batch's COMMIT: a migration whose `schema_version` row lands just
// before this method's read is pulled into the fill, and the batch then appends
// its own event covering the same version. Two rows, both true, one redundant.
//
// ----------------------------------------------------------------------------
// Wiring status
// ----------------------------------------------------------------------------
//
// Nothing calls this yet. `migration-runner.ts` is outside T3.4's Files clause
// and has no callback seam today, so attaching the primary path to the runner
// and the reconcile call to daemon startup is a separate change against the
// composition root. Both paths ship complete here — T3.5 owns their coverage —
// so that change is a wiring edit rather than a design one.
//
// ONE PRECONDITION THAT WIRING INHERITS, because it is not obvious and it bites
// hardest on the case everyone tests first. This is the tree's first appender on
// the SENTINEL chain, and `EventLogService.append` signs every row through
// `DaemonSigningKeySource.read`, which throws — non-retryably, minting nothing —
// when the session has no `daemon_signing_keys` row. That table is created BY
// migration 5, so on a genuinely fresh database the very batch that establishes
// the schema cannot have a signable sentinel key at the moment it finishes: the
// key store did not exist when the batch began, and provisioning is CP-006-7's,
// not this file's. The first-run event is therefore expected to fail its append
// and be picked up by the NEXT start's reconcile, once the sentinel key has been
// provisioned. Wiring that treats a failed first-run emit as fatal would turn
// the ordinary bootstrap into a crash loop.
//
// Spec coverage: `Spec-006 §Event Maintenance (event_maintenance)`
// (schema.migrated — batch granularity, sentinel binding, payload extension).
// Verifies invariant: none — no Plan-006 §Invariants entry names this task. The
// invariants this file must not BREAK belong to the append path, and it reaches
// the log only through `EventLogService.append`, which owns them.
// Refs: Plan-006 T3.4, Plan-001 (`schema_version` — owner; read-only here),
// `docs/architecture/schemas/local-sqlite-schema.md`.

import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EventEnvelopeVersionSchema,
  SCHEMA_MIGRATION_DESCRIPTION_MAX_LEN,
  SchemaMigratedPayloadSchema,
  type EventEnvelopeVersion,
  type NodeId,
  type SchemaMigratedEvent,
  type SchemaMigratedPayload,
} from "@ai-sidekicks/contracts";
import { blake3 } from "@noble/hashes/blake3.js";
import type { Database, Statement } from "better-sqlite3";

import type { EventLogService, UnsequencedEventEnvelope } from "./event-log-service.js";
import { withSessionAppendLock } from "./session-append-lock.js";

/**
 * The append surface this emitter needs, and nothing more.
 *
 * A `Pick` off the real service rather than a fresh interface: the seam stays
 * substitutable for a test double while remaining bound to T3.1's signature, so
 * a change to `append` fails here at compile time instead of drifting.
 */
export type SchemaMigrationEventLog = Pick<EventLogService, "append">;

/** Marks a reconstructed record's `operationId` — see the reconcile section. */
export const RECONCILE_OPERATION_ID_PREFIX = "reconcile:";

/**
 * Stands in for a `schema_version.description` that is NULL or blank.
 *
 * The column is nullable and the payload field is not; substituting is the
 * cosmetic-input half of the propagate-or-substitute split above.
 */
export const SCHEMA_MIGRATION_UNLABELLED_DESCRIPTION = "(migration recorded without a description)";

/** Separator between per-migration entries in the batch description. */
const DESCRIPTION_SEPARATOR = "; ";

/**
 * The `fromVersion` of a gap fill for a log that has never recorded a
 * migration — the empty-database version, one below the first real one.
 */
const NO_SCHEMA_VERSION = 0;

// Type-bound rather than spelled as bare literals, so a taxonomy rename in
// `@ai-sidekicks/contracts` breaks this file at compile time.
const SCHEMA_MIGRATED_EVENT_TYPE: SchemaMigratedEvent["type"] = "schema.migrated";
const SCHEMA_MIGRATED_EVENT_CATEGORY: SchemaMigratedEvent["category"] = "event_maintenance";
const SCHEMA_MIGRATED_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

/**
 * One migration as the daemon executed it.
 *
 * `sql` is the migration module's exported SQL constant — this repo's migrations
 * are TypeScript modules exporting SQL text rather than `.sql` files on disk, so
 * "migration file contents" is that constant's bytes, which is what the runner
 * hands to `db.exec` and therefore the only thing worth committing to.
 */
export interface MigrationSource {
  /** The `schema_version.version` this migration establishes. */
  readonly version: number;
  /** Stable identifier — the migration module's name, e.g. `0005-daemon-signing-keys`. */
  readonly migrationId: string;
  /** The SQL text as executed. */
  readonly sql: string;
}

/**
 * One completed migration batch — the `AFTER_MIGRATE_OPERATION_FINISH` report.
 *
 * `applied` lists only the migrations that COMMITTED, ascending or not (this
 * module orders them); a batch that threw partway reports the committed prefix
 * with `success: false`. `toVersion` is therefore the schema version standing
 * after the batch, which for a non-empty `applied` is its highest version — the
 * emitter checks that agreement rather than trusting either half alone.
 */
export interface MigrationBatchResult {
  /** Schema version before the batch; 0 for a fresh database. */
  readonly fromVersion: number;
  /** Schema version after the batch. */
  readonly toVersion: number;
  /** The migrations this batch committed. */
  readonly applied: readonly MigrationSource[];
  /** Wall-clock duration of the batch, in milliseconds; rounded at the seam. */
  readonly executionMs: number;
  /** Whether the batch finished without error. */
  readonly success: boolean;
  /**
   * Groups the event with anything else the same operation emitted — Liquibase's
   * `DEPLOYMENT_ID` role, per the `schema.migrated` precedent in
   * `Spec-006 §Event Maintenance (event_maintenance)`. Minted per batch when
   * absent.
   */
  readonly operationId?: string;
}

/** Construction deps for {@link SchemaMigrationEmitter}. */
export interface SchemaMigrationEmitterDeps {
  /**
   * The daemon's SQLite handle, already migrated — statements are prepared in
   * the constructor, so this emitter is constructed after `openDatabase`.
   */
  readonly db: Database;
  /** This daemon's NodeId, carried on every emitted payload. */
  readonly nodeId: NodeId;
  /** The sole durable append path (T3.1). */
  readonly eventLog: SchemaMigrationEventLog;
  /**
   * What `appliedBy` reports: the component that ran the migrations, and on the
   * reconcile path the component that found the gap.
   *
   * A COMPONENT IDENTITY, never an operating-system user. These rows are signed,
   * never compacted and never shredded, so a personal identifier written here
   * could not be removed later.
   */
  readonly appliedBy: string;
  /**
   * Every migration this daemon can apply, keyed by version.
   *
   * Cross-checks the primary path and is the reconcile path's only source of
   * migration bytes.
   */
  readonly migrationSources: ReadonlyMap<number, MigrationSource>;
  /** Injected for tests; defaults to the system clock. */
  readonly now?: () => Date;
  /** Injected for tests; defaults to a random UUID. */
  readonly eventIdFactory?: () => string;
  /** Injected for tests; defaults to a random UUID. */
  readonly operationIdFactory?: () => string;
}

/** What a reconcile pass did, in the terms a caller can act on. */
export type SchemaMigrationReconcileOutcome =
  | {
      readonly emitted: false;
      /**
       * `no_migrations_applied` — the database has no `schema_version` rows and
       * the log has no `schema.migrated` row either: a genuinely fresh database.
       * `already_recorded` — the log already covers every applied version.
       */
      readonly reason: "no_migrations_applied" | "already_recorded";
    }
  | {
      readonly emitted: false;
      /**
       * The durable schema is BEHIND the log: the newest recorded event names a
       * version `schema_version` does not have, which includes the case where
       * that table has been emptied entirely.
       *
       * REPORTED, NOT THROWN. It is a divergence worth an operator's attention —
       * a restored-from-backup or hand-edited database beside a signed audit
       * trail that remembers more than the schema does — but a daemon that
       * refuses to start cannot serve the log that recorded the divergence, and
       * the emitter has no repair to offer. So it declines to emit and hands the
       * finding to its caller.
       */
      readonly reason: "durable_state_behind_log";
      /** The `toVersion` of the newest recorded `schema.migrated` event. */
      readonly recordedVersion: number;
      /** The highest applied version, or `undefined` when there are none. */
      readonly durableVersion: number | undefined;
    }
  | {
      readonly emitted: true;
      readonly fromVersion: number;
      readonly toVersion: number;
      /** The versions the gap fill covers, ascending. */
      readonly versions: readonly number[];
    };

// Raw `schema_version` row. Every member is `unknown` because the column
// declarations are claims TypeScript never checked and the read boundary is
// where they get checked — the stance `merkle-anchor-service.ts` takes toward
// `PendingAnchorRow` and `signing-key-source.ts` toward `DaemonSigningKeyRow`.
// SQLite's declared types give AFFINITY, not enforcement, so anything with
// write access to the file can leave a TEXT value in `version`.
interface SchemaVersionRow {
  readonly version: unknown;
  readonly description: unknown;
}

/** Raw `payload` column of the newest `schema.migrated` row — same stance. */
interface SchemaMigratedPayloadRow {
  readonly payload: unknown;
}

/**
 * BLAKE3 over the batch's SQL bytes, ascending by version, base64.
 *
 * A PURE FUNCTION, EXPORTED, because a checksum a later verifier must reproduce
 * has to be reachable without constructing a daemon — and because the ordering
 * rule is the part worth testing directly.
 *
 * Refuses an empty list: a digest over no bytes is a well-defined value that
 * commits to nothing, and every caller here has already established that the
 * batch applied something.
 */
export function computeMigrationBatchChecksum(sources: readonly MigrationSource[]): string {
  if (sources.length === 0) {
    throw new Error("computeMigrationBatchChecksum requires at least one migration source");
  }
  const ordered = [...sources].sort((left, right) => left.version - right.version);
  let previousVersion: number | undefined;
  for (const source of ordered) {
    if (previousVersion !== undefined && source.version === previousVersion) {
      throw new Error(
        `computeMigrationBatchChecksum refuses duplicate migration version ${source.version}`,
      );
    }
    previousVersion = source.version;
  }

  const encoder = new TextEncoder();
  const encoded = ordered.map((source) => encoder.encode(source.sql));
  let width = 0;
  for (const part of encoded) width += part.length;
  const concatenated = new Uint8Array(width);
  let offset = 0;
  for (const part of encoded) {
    concatenated.set(part, offset);
    offset += part.length;
  }
  return Buffer.from(blake3(concatenated)).toString("base64");
}

/**
 * Joins per-migration description entries into one payload `description`,
 * bounded by `SCHEMA_MIGRATION_DESCRIPTION_MAX_LEN`.
 *
 * Drops WHOLE entries rather than cutting mid-sentence, and says how many it
 * dropped: a description ending mid-word reads like corruption where a count
 * reads like a bound. Only a leading entry too long to fit at all is sliced,
 * and that slice still carries a marker — a bounded string that does not say it
 * was bounded is the exact failure the whole-entry rule exists to avoid.
 *
 * EXPORTED BECAUSE the ceiling arithmetic is the part that silently produces a
 * wrong-but-plausible result, and a private helper's behaviour at the boundary
 * can only be probed through a full emit with a contrived `schema_version`.
 */
export function buildMigrationBatchDescription(entries: readonly string[], prefix = ""): string {
  if (entries.length === 0) return `${prefix}${SCHEMA_MIGRATION_UNLABELLED_DESCRIPTION}`;
  const budget = SCHEMA_MIGRATION_DESCRIPTION_MAX_LEN - prefix.length;
  const joined = entries.join(DESCRIPTION_SEPARATOR);
  if (joined.length <= budget) return `${prefix}${joined}`;

  let kept = 0;
  let width = 0;
  for (const entry of entries) {
    const separatorWidth = kept === 0 ? 0 : DESCRIPTION_SEPARATOR.length;
    const markerWidth = omissionMarker(entries.length - kept - 1).length;
    if (width + separatorWidth + entry.length + markerWidth > budget) break;
    width += separatorWidth + entry.length;
    kept += 1;
  }
  if (kept === 0) {
    // A CUT ENTRY ALWAYS CARRIES A MARKER, including the single-entry case where
    // nothing was dropped and `omissionMarker` would render nothing at all — the
    // result would then be a silently shortened label indistinguishable from one
    // that was recorded that way.
    const marker = truncationMarker(entries.length - 1);
    const room = Math.max(budget - marker.length, 1);
    return `${prefix}${sliceOnCharacterBoundary(joined, room)}${marker}`;
  }
  const head = entries.slice(0, kept).join(DESCRIPTION_SEPARATOR);
  return `${prefix}${head}${omissionMarker(entries.length - kept)}`;
}

/** ` [+N more]`, or nothing when none were dropped. */
function omissionMarker(omitted: number): string {
  return omitted <= 0 ? "" : ` [+${omitted} more]`;
}

/** The marker for a description whose FIRST entry had to be cut. */
function truncationMarker(omitted: number): string {
  return omitted <= 0 ? " [truncated]" : ` [truncated, +${omitted} more]`;
}

/**
 * `slice`, backed off by one when the cut would land between the halves of a
 * surrogate pair.
 *
 * JavaScript string indices are UTF-16 code units, so slicing a non-BMP
 * character in half leaves a lone surrogate — an unpaired code unit that has no
 * Unicode scalar value, encodes to U+FFFD through `TextEncoder`, and would
 * therefore put a replacement character into a signed, un-shreddable row.
 */
function sliceOnCharacterBoundary(text: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  const lastKept = text.charCodeAt(maxLength - 1);
  const isHighSurrogate = lastKept >= 0xd800 && lastKept <= 0xdbff;
  return text.slice(0, isHighSurrogate ? maxLength - 1 : maxLength);
}

/**
 * Emits `schema.migrated` at the batch boundary, and gap-fills what a crash
 * between commit and emit lost.
 */
export class SchemaMigrationEmitter {
  readonly #nodeId: NodeId;
  readonly #eventLog: SchemaMigrationEventLog;
  readonly #appliedBy: string;
  readonly #migrationSources: ReadonlyMap<number, MigrationSource>;
  readonly #now: () => Date;
  readonly #eventIdFactory: () => string;
  readonly #operationIdFactory: () => string;

  // Prepared once; both are read on paths that run at most once per batch, but
  // preparing in the constructor keeps the failure of a missing table at
  // construction rather than at the first migration.
  readonly #selectSchemaVersions: Statement;
  readonly #selectNewestSchemaMigrated: Statement;

  constructor(deps: SchemaMigrationEmitterDeps) {
    this.#nodeId = deps.nodeId;
    this.#eventLog = deps.eventLog;
    this.#appliedBy = requireNonBlank(deps.appliedBy, "appliedBy");
    this.#migrationSources = deps.migrationSources;
    this.#now = deps.now ?? ((): Date => new Date());
    this.#eventIdFactory = deps.eventIdFactory ?? ((): string => crypto.randomUUID());
    this.#operationIdFactory = deps.operationIdFactory ?? ((): string => crypto.randomUUID());

    // Plan-001 owns `schema_version`; this emitter only ever reads it. The
    // descriptions come from here rather than from `MigrationSource` because
    // they are what the migration DECLARED about itself at apply time, and
    // because the reconcile path has no other source for them.
    this.#selectSchemaVersions = deps.db.prepare(
      `SELECT version, description FROM schema_version ORDER BY version ASC`,
    );
    // Scoped to the sentinel session: `sequence` is per-session, so an unscoped
    // maximum would compare positions in unrelated hash chains.
    this.#selectNewestSchemaMigrated = deps.db.prepare(
      `SELECT payload FROM session_events
        WHERE session_id = ? AND type = ?
        ORDER BY sequence DESC
        LIMIT 1`,
    );
  }

  /**
   * The PRIMARY path: record a batch the caller just committed.
   *
   * Returns without emitting when the batch applied nothing — see "What is NOT
   * emitted". Every other refusal throws, leaving the caller to decide whether a
   * missing audit row should fail the start.
   */
  async emitBatchCompletion(batch: MigrationBatchResult): Promise<void> {
    const applied = this.#validateBatch(batch);
    if (applied.length === 0) return;

    const descriptions = this.#readSchemaVersionDescriptions();
    const entries = applied.map((source) => describeMigration(source, descriptions));
    await this.#appendSchemaMigrated({
      operationId: batch.operationId ?? this.#operationIdFactory(),
      fromVersion: batch.fromVersion,
      toVersion: batch.toVersion,
      sources: applied,
      description: buildMigrationBatchDescription(entries),
      executionMs: Math.round(batch.executionMs),
      success: batch.success,
    });
  }

  /**
   * The FALLBACK path: emit one gap-filling event for every applied version the
   * log never recorded.
   *
   * It emits for exactly one divergence direction. When the durable schema is
   * BEHIND the log instead, there is no honest event to write, so the pass
   * returns `durable_state_behind_log` for the caller to surface — see
   * {@link SchemaMigrationReconcileOutcome}. `no_migrations_applied` therefore
   * means both sides are empty, not just the `schema_version` table.
   *
   * Run this before the start's first migration batch, not concurrently with
   * one — the ordering precondition in this file's header says why.
   */
  async reconcileOnStartup(): Promise<SchemaMigrationReconcileOutcome> {
    return withSessionAppendLock(
      DAEMON_SCOPE_SENTINEL_SESSION_ID,
      async (): Promise<SchemaMigrationReconcileOutcome> => {
        // BOTH sides are read before either is judged. Checking the durable
        // table first and returning early on an empty one would report a
        // stripped `schema_version` sitting beside a signed `schema.migrated`
        // row as a fresh database — the one divergence direction this method
        // used to answer quietly.
        const descriptions = this.#readSchemaVersionDescriptions();
        const recordedVersion = this.#readNewestRecordedVersion();
        const durableVersion =
          descriptions.size === 0 ? undefined : Math.max(...descriptions.keys());

        if (
          recordedVersion !== undefined &&
          (durableVersion === undefined || durableVersion < recordedVersion)
        ) {
          return {
            emitted: false,
            reason: "durable_state_behind_log",
            recordedVersion,
            durableVersion,
          };
        }
        if (durableVersion === undefined)
          return { emitted: false, reason: "no_migrations_applied" };

        const gapVersions = [...descriptions.keys()].filter(
          (version) => recordedVersion === undefined || version > recordedVersion,
        );
        if (gapVersions.length === 0) return { emitted: false, reason: "already_recorded" };

        const sources = gapVersions.map((version) => this.#resolveMigrationSource(version));
        const fromVersion = recordedVersion ?? NO_SCHEMA_VERSION;
        const toVersion = Math.max(...gapVersions);
        const entries = sources.map((source) => describeMigration(source, descriptions));
        await this.#appendSchemaMigrated({
          operationId: `${RECONCILE_OPERATION_ID_PREFIX}${this.#operationIdFactory()}`,
          fromVersion,
          toVersion,
          sources,
          description: buildMigrationBatchDescription(entries, "[reconciled] "),
          // UNKNOWN, not instantaneous: the batch that applied these versions
          // left no duration behind, and 0 is the only non-negative integer that
          // does not invent one.
          executionMs: 0,
          // A migration that fails commits no `schema_version` row, so every
          // version visible to this query is one that landed.
          success: true,
        });
        return { emitted: true, fromVersion, toVersion, versions: gapVersions };
      },
    );
  }

  // ------------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------------

  /**
   * Checks a batch against itself and against the registry, returning its
   * migrations in version order.
   *
   * Every check here is a claim the event would otherwise assert on the caller's
   * word: that the endpoints match the migrations listed, that no version is
   * reported twice, and that the SQL being hashed is the SQL this daemon knows
   * for that version.
   */
  #validateBatch(batch: MigrationBatchResult): readonly MigrationSource[] {
    const fromVersion = requireSchemaVersion(batch.fromVersion, "fromVersion");
    const toVersion = requireSchemaVersion(batch.toVersion, "toVersion");
    if (fromVersion > toVersion) {
      throw new Error(
        `schema.migrated batch runs backwards: fromVersion ${fromVersion} > toVersion ${toVersion}`,
      );
    }
    if (!Number.isFinite(batch.executionMs) || batch.executionMs < 0) {
      throw new Error(
        `schema.migrated batch reports a non-duration executionMs: ${describeStoredValue(batch.executionMs)}`,
      );
    }

    const applied = [...batch.applied].sort((left, right) => left.version - right.version);
    let previousVersion: number | undefined;
    for (const source of applied) {
      const version = requireSchemaVersion(source.version, "applied migration version");
      if (previousVersion !== undefined && version === previousVersion) {
        throw new Error(`schema.migrated batch lists version ${version} twice`);
      }
      previousVersion = version;
      requireNonBlank(source.migrationId, `migrationId for version ${version}`);
      requireNonBlank(source.sql, `sql for version ${version}`);
      const registered = this.#resolveMigrationSource(version);
      if (registered.sql !== source.sql || registered.migrationId !== source.migrationId) {
        throw new Error(
          `schema.migrated batch disagrees with the registered migration for version ${version} — ` +
            `the registry and the executed migration must be the same bytes`,
        );
      }
    }
    if (applied.length === 0) return applied;

    const highest = applied[applied.length - 1]?.version;
    const lowest = applied[0]?.version;
    if (highest === undefined || lowest === undefined) {
      // Unreachable: `applied` is non-empty here. Typed rather than asserted so
      // the narrowing stays honest.
      throw new Error("schema.migrated batch lost its endpoints while ordering");
    }
    if (highest !== toVersion) {
      throw new Error(
        `schema.migrated batch reports toVersion ${toVersion} but its highest applied migration is ${highest}`,
      );
    }
    if (lowest <= fromVersion) {
      throw new Error(
        `schema.migrated batch reports fromVersion ${fromVersion} but applies version ${lowest}, which it should already have`,
      );
    }
    return applied;
  }

  /** Applied versions to their descriptions, ascending, blanks substituted. */
  #readSchemaVersionDescriptions(): ReadonlyMap<number, string> {
    const rows = this.#selectSchemaVersions.all() as readonly SchemaVersionRow[];
    const descriptions = new Map<number, string>();
    for (const row of rows) {
      descriptions.set(
        readStoredSchemaVersion(row.version),
        readStoredDescription(row.description),
      );
    }
    return descriptions;
  }

  /**
   * The `toVersion` of the newest recorded `schema.migrated` row, or `undefined`
   * when the log has none.
   *
   * Reads the single field the gap query needs rather than re-parsing the whole
   * payload through `SchemaMigratedPayloadSchema`: that schema is `.strict()`,
   * so a row written by a later daemon carrying an added field would fail to
   * re-parse here and turn a forward-compatible payload into a startup failure.
   * A payload that is not an object, or whose `toVersion` is not a version, is a
   * different matter and throws — falling through to "nothing recorded" there
   * would re-emit a gap fill for migrations already recorded.
   *
   * READING THE STORED PAYLOAD AT ALL IS SOUND FOR ONE REASON: `schema.migrated`
   * is an `event_maintenance` row, and those are never compacted and never
   * shredded (`Spec-006 §Event Maintenance (event_maintenance)`). The gap query
   * can therefore trust that a row it finds still carries its payload, which is
   * not true of the compactable categories, whose stubs would read as a payload
   * with the field missing.
   *
   * The parsed version is bounded by {@link requireSchemaVersion} like every
   * other version in this file. `/^\d+$/` alone admits digit strings past
   * `Number.MAX_SAFE_INTEGER`, which coerce to a float that no migration can
   * ever exceed — silently disabling reconcile for as long as that row is the
   * newest one.
   */
  #readNewestRecordedVersion(): number | undefined {
    const row = this.#selectNewestSchemaMigrated.get(
      DAEMON_SCOPE_SENTINEL_SESSION_ID,
      SCHEMA_MIGRATED_EVENT_TYPE,
    ) as SchemaMigratedPayloadRow | undefined;
    if (row === undefined) return undefined;
    if (typeof row.payload !== "string") {
      throw new Error(
        `the newest schema.migrated row carries a payload column that is not TEXT: ${describeStoredValue(row.payload)}`,
      );
    }

    const parsed: unknown = JSON.parse(row.payload);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(
        `the newest schema.migrated row carries a payload that is not an object: ${describeStoredValue(parsed)}`,
      );
    }
    const toVersion: unknown = (parsed as Record<string, unknown>)["toVersion"];
    if (typeof toVersion !== "string" || !/^\d+$/.test(toVersion)) {
      throw new Error(
        `the newest schema.migrated row carries a toVersion that is not a schema version: ${describeStoredValue(toVersion)}`,
      );
    }
    return requireSchemaVersion(Number(toVersion), "recorded toVersion");
  }

  /** The registered migration for a version, or a loud refusal. */
  #resolveMigrationSource(version: number): MigrationSource {
    const source = this.#migrationSources.get(version);
    if (source === undefined) {
      throw new Error(
        `no registered migration for schema version ${version} — ` +
          `schema.migrated cannot commit to bytes this daemon does not have`,
      );
    }
    // The key and the entry are two independent claims about the same version,
    // and on the reconcile path the registry is the ONLY source of migration
    // bytes — nothing downstream would notice the disagreement. A mis-keyed
    // entry would otherwise mint a signed audit record naming one migration and
    // committing to another's bytes.
    if (source.version !== version) {
      throw new Error(
        `the migration registered under version ${version} declares version ${source.version} — ` +
          `a mis-keyed registry entry would sign an audit record for the wrong migration`,
      );
    }
    return source;
  }

  /** The one emission seam: parse the payload, then append it. */
  async #appendSchemaMigrated(input: {
    readonly operationId: string;
    readonly fromVersion: number;
    readonly toVersion: number;
    readonly sources: readonly MigrationSource[];
    readonly description: string;
    readonly executionMs: number;
    readonly success: boolean;
  }): Promise<void> {
    // ONE clock read for both spellings. The envelope's `occurredAt` is
    // normalized and persisted by the append path while the payload's copy rides
    // inside `payload` untouched, so taking two reads — or two spellings of one
    // read — would sign a row claiming two different instants.
    const occurredAt = this.#now().toISOString();
    const terminal = input.sources[input.sources.length - 1];
    if (terminal === undefined) {
      // Unreachable: both callers establish a non-empty batch first.
      throw new Error("schema.migrated has no terminal migration to name");
    }

    const payload: SchemaMigratedPayload = SchemaMigratedPayloadSchema.parse({
      nodeId: this.#nodeId,
      operationId: input.operationId,
      occurredAt,
      fromVersion: String(input.fromVersion),
      toVersion: String(input.toVersion),
      // The batch's TERMINAL migration, not a list of all of them: the field is
      // bounded by `EVENT_FIELD_MAX_LEN` (256), which a joined list of a
      // full-history batch would exceed. `description` carries the roster, and
      // `fromVersion`/`toVersion` carry the span.
      migrationId: terminal.migrationId,
      description: input.description,
      checksum: computeMigrationBatchChecksum(input.sources),
      appliedBy: this.#appliedBy,
      executionMs: input.executionMs,
      success: input.success,
    });

    const envelope: UnsequencedEventEnvelope = {
      id: this.#eventIdFactory(),
      sessionId: DAEMON_SCOPE_SENTINEL_SESSION_ID,
      occurredAt,
      actor: null,
      category: SCHEMA_MIGRATED_EVENT_CATEGORY,
      type: SCHEMA_MIGRATED_EVENT_TYPE,
      // Assignable with no cast because `SchemaMigratedPayload` is a type ALIAS
      // and therefore carries an implicit index signature; declaring it as an
      // interface upstream would break this line rather than this file's logic.
      payload,
      version: SCHEMA_MIGRATED_EVENT_VERSION,
    };
    await this.#eventLog.append(envelope);
  }
}

/** `"<version>: <description>"` — one entry of the batch description. */
function describeMigration(
  source: MigrationSource,
  descriptions: ReadonlyMap<number, string>,
): string {
  const description = descriptions.get(source.version);
  if (description === undefined) {
    // The durable table contradicts the claim that this version was applied.
    // Integrity-bearing, so it propagates rather than substituting a label.
    throw new Error(
      `schema_version has no row for version ${source.version}, which was reported as applied`,
    );
  }
  return `${source.version}: ${description}`;
}

/** A schema version is a non-negative safe integer, and nothing else. */
function requireSchemaVersion(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `schema.migrated ${label} is not a schema version: ${describeStoredValue(value)}`,
    );
  }
  return value;
}

/**
 * `schema_version.version` as a number.
 *
 * INTEGRITY-BEARING, so it propagates: every other version in this file is a
 * key into the migration registry, and a column that is not a version cannot be
 * one. Coercing it with `Number` instead would map SQL NULL to 0 and a TEXT
 * value to `NaN`, and the first diagnostic the caller then sees blames the
 * registry for not holding a migration at a version the column never named.
 */
function readStoredSchemaVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `schema_version.version is not a schema version: ${describeStoredValue(value)}`,
    );
  }
  return value;
}

/**
 * `schema_version.description` as a payload-legal label.
 *
 * COSMETIC, so it substitutes — for all four unusable shapes, not just the
 * declared-nullable one: SQL NULL, blank or whitespace-only, NUL-bearing (which
 * `wireFreeFormString` refuses outright, and which would otherwise reach the
 * emission seam and throw there), and a non-TEXT value some other writer left in
 * the column. Integrity here rides the checksum; the label is display.
 */
function readStoredDescription(value: unknown): string {
  if (typeof value !== "string") return SCHEMA_MIGRATION_UNLABELLED_DESCRIPTION;
  return value.trim().length === 0 || value.includes("\0")
    ? SCHEMA_MIGRATION_UNLABELLED_DESCRIPTION
    : value;
}

/**
 * Renders a refused value for a throw message without trusting its declared
 * type — the stance `signing-key-source.ts`'s `describeByteShape` takes, for the
 * same reason: these values come from columns whose types SQLite treats as
 * affinity rather than enforcement.
 */
function describeStoredValue(value: unknown): string {
  if (value === null) return "SQL NULL";
  if (typeof value === "string") {
    // Bounded: one of these values is a description that may run to the full
    // 512-character ceiling, and an error message is not a place to reprint it.
    const shown = value.length > 60 ? `${value.slice(0, 60)}…` : value;
    return `the ${value.length}-character string ${JSON.stringify(shown)}`;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return `the ${typeof value} ${String(value)}`;
  }
  return `a value of type ${typeof value}`;
}

/**
 * Refuses a blank string at construction or validation time rather than letting
 * `SchemaMigratedPayloadSchema` refuse it at the emission seam — a daemon wired
 * with an empty `appliedBy` should fail when it is wired, not on the first
 * migration it ever runs.
 */
function requireNonBlank(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `schema.migrated ${label} must be a non-blank string, not ${describeStoredValue(value)}`,
    );
  }
  return value;
}
