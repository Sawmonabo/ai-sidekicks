# Spec-015: Persistence Recovery And Replay

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `015` |
| **Slug** | `persistence-recovery-and-replay` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Data Architecture](../architecture/data-architecture.md), [Run State Machine](../domain/run-state-machine.md), [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md) |
| **Implementation Plan** | [Plan-015: Persistence Recovery And Replay](../plans/015-persistence-recovery-and-replay.md) |

## Purpose

Define the persistence contract that allows restart recovery, replay, and durable local execution truth.

## Scope

This spec covers local persistence, shared coordination persistence, recovery rules, and replay expectations.

## Non-Goals

- Full operations procedures
- Detailed schema design
- Provider-driver internal persistence formats

## Domain Dependencies

- [Session Model](../domain/session-model.md)
- [Run State Machine](../domain/run-state-machine.md)
- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)

## Architectural Dependencies

- [Data Architecture](../architecture/data-architecture.md)
- [Observability Architecture](../architecture/observability-architecture.md)
- [ADR-003: Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)
- [ADR-004: SQLite Local State And Postgres Control Plane](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)

## Required Behavior

- Each runtime node must persist canonical local execution state in a durable local store.
- The default local execution store must be SQLite with WAL and foreign keys enabled.
- The default shared collaboration store must be Postgres or an equivalent relational control-plane store.
- Canonical local execution data must include session events, queue state, approvals, runtime bindings, and command receipts.
- Restart recovery must attempt:
  1. projection rebuild from canonical events
  2. restoration of runtime bindings
  3. resumption or explicit failure transition for in-flight runs
- Replay must be possible without client memory or ad hoc transcript reconstruction.

## Default Behavior

- Local mutable operations are blocked if the local durable store is unavailable.
- Recovery runs automatically on daemon startup before new mutable work is accepted.
- Recovery prefers adopting existing live provider sessions where possible before using stored resume handles.

## Fallback Behavior

- If a persisted driver handle cannot be resumed, the affected run must transition to `failed` with visible recovery failure detail rather than silently disappearing or restarting as a new run.
- If projection rebuild fails, the daemon may enter degraded read-only mode while exposing repair signals.
- If shared control-plane storage is unavailable, local execution may continue for already attached local sessions, but shared membership and invite operations must fail explicitly.

## Interfaces And Contracts

- `RecoveryStatusRead` must expose whether the node is healthy, replaying, degraded, or blocked.
- `ReplayReadAfterCursor` must read authoritative events after a known cursor.
- `ProjectionRebuild` must be idempotent.
- `RuntimeBindingRead` must expose the data needed to attempt session adoption or resume.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## Idempotency Protocol

Side-effecting tool calls that may be retried — either by the driver on transient failure, or by the daemon during restart recovery — must not execute twice. The daemon enforces exactly-once semantics via a **two-phase command receipt**: `accept` → `execute` → terminal-status, with each phase committed in its own SQLite transaction. A tool call is uniquely identified by `command_id` (the idempotency key) and may additionally carry a caller-supplied `dedupe_key` for remote-side deduplication.

### Two-Phase Receipt Commit

```sql
-- Phase 1: accept (one transaction)
BEGIN;
  INSERT INTO command_receipts
    (id, command_id, run_id, status, idempotency_class, dedupe_key, created_at)
    VALUES (?, ?, ?, 'accepted', ?, ?, now());
COMMIT;

-- Phase 2: execute (one transaction, optimistic compare-and-set)
BEGIN;
  UPDATE command_receipts
    SET started_at = now()
    WHERE id = ? AND started_at IS NULL;
  -- rowcount = 1 → this worker owns the execution; rowcount = 0 → another worker
  -- already claimed the receipt, abort this attempt without invoking the tool.
COMMIT;
-- side-effecting tool call happens here, outside any DB transaction

-- Phase 3: terminal-status (one transaction)
BEGIN;
  UPDATE command_receipts
    SET status = ?, completed_at = now()
    WHERE id = ?;
  -- status ∈ {'completed','failed'}; 'rejected' is only set at accept-time.
COMMIT;
```

The `UPDATE ... SET started_at = now() WHERE started_at IS NULL` in Phase 2 is an **optimistic compare-and-set primitive**. Under SQLite WAL mode it is serializable on the row's page, so exactly one concurrent caller observes a rowcount of 1 and proceeds to invoke the tool; all others observe 0 and abort without invoking. This closes the double-execution window during concurrent restart recovery, where multiple recovery workers might race to re-drive the same in-flight receipt.

### Idempotency Classes and Recovery Behavior

Drivers declare `tool.idempotency_class` per-tool at attach time (see [Spec-005 § Tool Metadata](005-provider-driver-contract-and-capabilities.md#tool-metadata)). A receipt whose Phase 2 started but never reached Phase 3 — `started_at IS NOT NULL AND completed_at IS NULL` — is an in-flight receipt.

The in-flight-receipt sweep runs **only at daemon startup**, per [§Default Behavior](#default-behavior) ("Recovery runs automatically on daemon startup before new mutable work is accepted"). While the daemon is running, an in-flight marker denotes a live worker that owns the receipt and is actively invoking the tool; another worker MUST NOT re-claim it. The optimistic CAS in Phase 2 covers the narrow concurrent-boot race (for example a supervisor restarting the daemon twice in quick succession or two recovery workers racing on the same receipt); it is **not** a general garbage-collector for long-running in-flight executions. A receipt stuck in-flight across a fully-live daemon is treated as a bug, not a recovery input.

Recovery dispatches on `idempotency_class`:

| Class | Recovery Behavior |
| --- | --- |
| `idempotent` | Re-execute the tool. External deduplication (if any) is the tool's responsibility. Emit `tool.replayed`. |
| `compensable` | Re-execute the tool with the receipt's `dedupe_key` attached so the remote side can reject duplicates. Pattern follows [Stripe idempotency keys](https://docs.stripe.com/api/idempotent_requests). On confirmed duplicate response, emit `tool.skipped_during_recovery`. |
| `manual_reconcile_only` | Do **not** re-execute. Halt the affected run with a `recovery-needed` condition per [Spec-005 § Fallback Behavior](005-provider-driver-contract-and-capabilities.md#fallback-behavior). Emit `tool.skipped_during_recovery` and surface an operator escalation. |

Examples: `idempotent` covers pure reads (`file.read`, `shell.stat`) and server-side-idempotent writes (for example `S3 PutObject` with `If-Match`). `compensable` covers Stripe charges, payment authorizations, and any remote side that honors a client-supplied idempotency key. `manual_reconcile_only` covers one-shot external actions where the remote side offers no deduplication — for example a webhook to a legacy system or a PR merge on a remote repo — and where executing twice would produce a user-visible incident.

### Recovery Events

Two event types are reserved for tool-recovery outcomes, both with category `tool_activity`. They are registered here and in [Spec-006](006-session-event-taxonomy-and-audit-log.md), with full taxonomy-table enumeration tracked by [BL-064](../backlog.md):

| Type | Description |
| --- | --- |
| `tool.replayed` | A tool with `idempotency_class ∈ {idempotent, compensable}` was re-executed during recovery. Payload: `{sessionId, runId, commandId, idempotencyClass, dedupeKey?}`. |
| `tool.skipped_during_recovery` | A tool with `idempotency_class = 'manual_reconcile_only'` was detected in-flight during recovery and was **not** re-executed. Payload: `{sessionId, runId, commandId, reason}`. |

### References

- [Spec-005 § Tool Metadata](005-provider-driver-contract-and-capabilities.md#tool-metadata) — per-tool `idempotency_class` declaration
- [Local SQLite Schema § Command Receipts](../architecture/schemas/local-sqlite-schema.md) — `command_receipts` table and two-phase columns
- [Stripe Idempotency Keys](https://docs.stripe.com/api/idempotent_requests) — canonical precedent for `compensable`
- [Sagas: Long-Lived Transactions — Garcia-Molina & Salem, 1987](https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf) — precedent for compensating-transaction pattern

## Writer Concurrency

All writes to the local SQLite event log pass through a **single writer worker** isolated on a Node.js worker thread. This is a platform requirement, not a stylistic choice: the `node:worker_threads` documentation excludes native-addon-backed objects from `postMessage`-transferable values, so a `better-sqlite3` `Database` handle cannot be shared across threads ([nodejs.org/api/worker_threads.html](https://nodejs.org/api/worker_threads.html), fetched 2026-04-19; reinforced by [better-sqlite3 `docs/threads.md`](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/threads.md)). Each worker opens its own connection; only the designated writer worker holds a connection opened in read-write mode.

### Driver Pin

V1 pins **`better-sqlite3@^12.9.0`** as the local SQLite driver. v12.9.0 was released 2026-04-12 with engines declaring `node: "20.x || 22.x || 23.x || 24.x || 25.x"` ([package.json](https://github.com/WiseLibs/better-sqlite3/blob/master/package.json), fetched 2026-04-19). Recommended Node runtime is 24 LTS. The alternative built-in `node:sqlite` module is not yet viable for V1 — on Node 24.15.0 LTS and Node 25.9.0 Current its stability index is still `1.2 — Release candidate` ([nodejs.org/api/sqlite.html](https://nodejs.org/api/sqlite.html), fetched 2026-04-19). Re-evaluate pre-V2 once `node:sqlite` graduates to Stability 2 (Stable).

**Upgrade policy.** Minor and patch bumps within the `^12.9.0` range are auto-applied by the package manager; any future major (`13.x.y`) must be explicitly re-evaluated against the pragma overrides in §Pragmas and the `.backup()` atomicity contract in §Backup Policy before the pin moves. Since V1's durability posture depends on `synchronous = FULL` and on the undocumented fsync behavior of `.backup()`, a surprise major bump that changed either behavior would be invisible without this gate.

### Pragmas

The writer worker sets the following pragmas on first connection:

```sql
PRAGMA journal_mode = WAL;      -- concurrent readers during writes
PRAGMA synchronous = FULL;      -- override better-sqlite3 default (NORMAL) for chain-of-custody durability
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

The `synchronous = FULL` override is load-bearing. The `better-sqlite3` bundled distribution compiles with `SQLITE_DEFAULT_SYNCHRONOUS=1` (NORMAL), which the maintainers note trades *"a slight loss of durability"* for WAL throughput ([better-sqlite3 `docs/performance.md`](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md), fetched 2026-04-19). That trade-off is unacceptable for `session_events` because each row is part of a cryptographic hash chain (see [Spec-006 §Integrity Protocol](006-session-event-taxonomy-and-audit-log.md#integrity-protocol)) — a lost write breaks verifiability irrecoverably.

### Bounded Queue and Batched Transactions

The writer worker consumes events from a bounded in-memory queue. Per the charter in [BL-061](../backlog.md), the queue cap is `10_000` events and batches flush at `50` events OR `10 ms`, whichever fires first. Each batch runs under one `db.transaction(fn)` call — the `better-sqlite3` primitive that commits atomically on return and rolls back on throw ([API docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md), fetched 2026-04-19).

**Hash-chain serialization within a batch.** Spec-006 §Integrity Protocol chains `row_hash` **per `session_id`** (the chain is rooted at the session's sequence-0 zero-fill and each `prev_hash_i = row_hash_{i-1}` is scoped to the same session). Within a single transaction the writer therefore groups pending events by `session_id`, reads each session's last-persisted `row_hash` once at batch start, then for each group processes events in enqueue order: for each event `i` derive `prev_hash_i = row_hash_{i-1}` (from the same session), compute `row_hash_i = BLAKE3(prev_hash_i || canonical_bytes_i)`, sign the canonical envelope with the daemon Ed25519 key, and INSERT. A batch mixing sessions A and B runs two independent chain computations, one per session — never a single cross-session chain. Chain integrity and batching therefore coexist without weakening Spec-006.

### Backpressure

When the queue is at cap, enqueue semantics dispatch on event category:

- **Canonical state-change events** (every event type tracked by Spec-006 as canonical — `run_lifecycle.*`, `tool_activity.*`, `approval_*`, and all others) — the enqueuing call awaits an internal promise that resolves once the next batch drains; the event is never dropped and the write path never returns a silent failure.
- **`assistant.thinking_update` only** — dropped at enqueue, with a per-session 1/s-rate-limited `event_dropped` counter emitted via the observability path (not the event log). The counter is tagged `session_id` and `event_type` so operators can distinguish drops across sessions. Per [Spec-006](006-session-event-taxonomy-and-audit-log.md) `assistant.thinking_update` is a non-canonical narration stream; drops preserve end-to-end run semantics and audit verifiability.

No other event types are drop-eligible. Any future addition to the drop set must be explicit in this spec.

### Alerting

The `sqlite_queue_depth_p99` metric (queue depth at the 99th percentile, sampled per second) alerts at **80% of queue cap** (8_000 of 10_000 by default). At this threshold the daemon emits a `persistence_backpressure` warning. The full alert shape (severity, notification channel, auto-remediation policy) is forward-declared here; Spec-020 will carry the entry when its alert catalog lands. Until then, implementations treat `persistence_backpressure` as a local-daemon-log warning with a Prometheus-style counter `sqlite_queue_depth_p99` tagged by `session_id` (populated if the saturating event carries one) and `event_category`. Sustained backpressure on state-change events eventually surfaces as user-visible run-progression latency, so the alert fires well before queue exhaustion.

### References

- [Node.js worker_threads](https://nodejs.org/api/worker_threads.html) — platform constraint mandating per-worker native-addon handles
- [better-sqlite3 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) — `.backup()`, `db.transaction(fn)`, pragma surface (v12.9.0 released 2026-04-12)
- [better-sqlite3 performance](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md) — default `synchronous=NORMAL` trade-off
- [better-sqlite3 threads](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/threads.md) — per-worker connection pattern
- [Node.js node:sqlite](https://nodejs.org/api/sqlite.html) — Stability `1.2 — Release candidate` on Node 24 LTS as of 2026-04-19
- [Spec-006 §Integrity Protocol](006-session-event-taxonomy-and-audit-log.md#integrity-protocol) — per-session hash chain + signature commitments
- [Spec-020](020-observability-and-failure-recovery.md) — target home for the `persistence_backpressure` alert taxonomy entry (forward-declared above; entry not yet landed)

## Clock Handling

Session events carry two timestamps: `occurred_at` (RFC 3339 wall-clock UTC) for display and audit export, and `monotonic_ns` (BIGINT nanoseconds from a monotonic source) for ordering within a single daemon's event log.

### Monotonic Source

`monotonic_ns` is produced by `process.hrtime.bigint()`. Per the Node.js documentation: *"The `bigint` version of the `process.hrtime()` method returning the current high-resolution real time in nanoseconds as a `bigint`"* ([nodejs.org/api/process.html#processhrtimebigint](https://nodejs.org/api/process.html#processhrtimebigint), fetched 2026-04-19). The underlying `process.hrtime()` docs add the load-bearing guarantee: *"These times are relative to an arbitrary time in the past, and not related to the time of day and therefore not subject to clock drift."*

**Semantics.** `monotonic_ns` is not a UNIX timestamp. Its zero point is unspecified and changes on every daemon restart. It serves exactly two purposes: (a) stable within-daemon event ordering when the wall clock jumps (NTP step, VM resume, manual operator edit); (b) precise duration measurements between events produced by the same daemon process.

**Out-of-scope explicitly.** `monotonic_ns` is **not** a cross-daemon ordering primitive. See [data-architecture.md §Event-Sourcing Scope](../architecture/data-architecture.md#event-sourcing-scope) on why per-daemon `sequence` and `monotonic_ns` do not induce a total order across daemons. Hybrid Logical Clocks (HLC) are tracked under [BL-076](../backlog.md) and are out-of-scope for V1 per [ADR-017](../decisions/017-shared-event-sourcing-scope.md) (V1 chose Option B — daemon-authoritative per-participant ordering, no shared event log to order against).

### Wall-Clock Format

`occurred_at` is an ISO 8601 / RFC 3339 string with millisecond precision and `Z` suffix: `YYYY-MM-DDTHH:mm:ss.sssZ`. This is the exact output of `Date.prototype.toISOString()` (ECMA-262 §21.4.4.36) and is unambiguous to any RFC 3339 parser ([datatracker.ietf.org/doc/html/rfc3339](https://datatracker.ietf.org/doc/html/rfc3339), fetched 2026-04-19). Per RFC 3339 §5.6 the grammar permits `Z` or numeric `±HH:MM`; this spec mandates uppercase `Z`.

### NTP Sync Precondition

Daemon startup runs a platform-appropriate NTP-sync probe before accepting mutable writes. The platform matrix:

| Platform | Command | Pass Condition |
|---|---|---|
| Linux (systemd) | `timedatectl show --property=NTPSynchronized --value` | stdout is `yes` |
| Linux (chrony, no systemd) | `chronyc tracking` | `Leap status` is `Normal` (not `Not synchronised`) |
| Windows | `w32tm /query /status /verbose` | `Last Sync Error == 0` AND `Stratum < 16` AND `Source != "Local CMOS Clock"` |
| macOS | `systemsetup -getusingnetworktime` + `sntp -sS time.apple.com` | `getusingnetworktime` returns `On` AND `sntp` offset within ±500 ms |
| Container | Probe the host, not the container | via `--ntp-sync-status-override=<env|file>` or host D-Bus socket mount |

The Linux `NTPSynchronized` property reads the kernel `adjtimex(2)` flag via the `org.freedesktop.timedate1` D-Bus interface and is authoritative regardless of which daemon (timesyncd, chrony, ntpd) maintains sync ([man.archlinux.org/man/core/systemd/org.freedesktop.timedate1.5.en](https://man.archlinux.org/man/core/systemd/org.freedesktop.timedate1.5.en), fetched 2026-04-19). Windows parses multiple fields because no single boolean exists ([learn.microsoft.com/en-us/windows-server/networking/windows-time-service/windows-time-service-tools-and-settings](https://learn.microsoft.com/en-us/windows-server/networking/windows-time-service/windows-time-service-tools-and-settings), page dated 2025-09-18, fetched 2026-04-19). macOS has no single-boolean equivalent; its probe is explicitly best-effort and may false-negative on recently-restarted hosts before `timed` syncs. Containers inherit the host kernel clock but typically lack a `timedate1` D-Bus service, so detection must be hoisted out of the container — the override env var/path is the sanctioned escape hatch.

If the probe fails, the daemon emits a `session.clock_unsynced` event (see §Reserved Events below) and **continues to accept writes**. Refusing writes would hard-fail nodes on legitimately offline networks; operators monitoring `session.clock_unsynced` rates have the audit trail needed to investigate without the daemon losing availability.

### Material-Skew Threshold

"Material" clock skew is **500 ms**, borrowed from CockroachDB's `--max-offset` default ([cockroachlabs.com/docs/stable/operational-faqs](https://www.cockroachlabs.com/docs/stable/operational-faqs), v26.1, fetched 2026-04-19). CockroachDB uses 500 ms as a distributed-consensus correctness gate; AI Sidekicks is a single-node audit log, so this number is a conservative ceiling rather than a physics floor. When a runtime NTP correction applies a wall-clock jump greater than 500 ms the daemon emits a `session.clock_corrected` event so replay and audit export can reason about wall-clock discontinuities.

Kubernetes kubelet publishes no clock-skew tolerance ([kubernetes.io/docs/reference/node/node-status/](https://kubernetes.io/docs/reference/node/node-status/), fetched 2026-04-19; no `NodeHasSufficientClockSkew` condition exists). etcd publishes no clock-skew threshold ([etcd.io/docs/v3.4/tuning/](https://etcd.io/docs/v3.4/tuning/)). CockroachDB is therefore the only operationally-mature published precedent with a concrete number.

### Reserved Events

The `session.clock_unsynced` and `session.clock_corrected` event types are enumerated under [Spec-006 §Runtime Node Lifecycle](006-session-event-taxonomy-and-audit-log.md#runtime-node-lifecycle-runtime_node_lifecycle) with category `runtime_node_lifecycle`. The event names are preserved verbatim for wire stability per [ADR-018 §Decision #3](../decisions/018-cross-version-compatibility.md) (MINOR bumps are additive-only; event-type rename is not additive) even though the prior `run_lifecycle` category classification was incorrect — these events describe daemon state (clock source), not a run's state. Only the category field moves in the canonical enumeration.

Behavioral semantics anchored in this spec:

- `session.clock_unsynced` is emitted when the NTP sync probe described in [§NTP Sync Precondition](#ntp-sync-precondition) above fails at daemon startup. The daemon continues to accept writes — refusing writes would hard-fail nodes on legitimately offline networks; operators monitoring emission rates have the audit trail needed to investigate without the daemon losing availability.
- `session.clock_corrected` is emitted when a runtime NTP correction applies a wall-clock jump greater than the 500 ms material-skew threshold described in [§Material-Skew Threshold](#material-skew-threshold) above. The `wallClockDeltaMs` payload field is the wall-clock jump that triggered the event; the two `monotonic_ns` readings in the payload bracket that jump and will differ only by the time elapsed in the correction handler (they are not a re-statement of the delta).

### References

- [Node.js process.hrtime.bigint()](https://nodejs.org/api/process.html#processhrtimebigint) — monotonic nanosecond source; "not subject to clock drift"
- [RFC 3339 §5.6](https://datatracker.ietf.org/doc/html/rfc3339) — wall-clock format grammar
- [systemd `timedate1` interface](https://man.archlinux.org/man/core/systemd/org.freedesktop.timedate1.5.en) — `NTPSynchronized` D-Bus property
- [chrony `chronyc` documentation](https://chrony-project.org/doc/4.5/chronyc.html) — `Leap status` field for non-systemd Linux
- [CockroachDB operational FAQs](https://www.cockroachlabs.com/docs/stable/operational-faqs) — `--max-offset` 500 ms precedent (v26.1)
- [Microsoft Learn — Windows Time Service tools](https://learn.microsoft.com/en-us/windows-server/networking/windows-time-service/windows-time-service-tools-and-settings) — `w32tm /query /status` parse fields
- [ADR-017](../decisions/017-shared-event-sourcing-scope.md) — V1 daemon-authoritative ordering; HLC deferred to V1.1
- [BL-076](../backlog.md) — Hybrid Logical Clocks tracking (out-of-scope for V1)

## Backup Policy

The daemon guarantees the local SQLite store can be restored within 24 hours of data staleness (restore SLO). The policy has four components: WAL checkpoint cadence, periodic full backup, retention, and pre-migration snapshots.

### WAL Checkpoint Cadence

The daemon runs WAL checkpoints under two triggers, both **PASSIVE mode**:

- **Page-driven (auto)** — SQLite's built-in autocheckpoint fires when the WAL reaches `1000` pages (the default for `PRAGMA wal_autocheckpoint` confirmed at [sqlite.org/pragma.html#pragma_wal_autocheckpoint](https://sqlite.org/pragma.html#pragma_wal_autocheckpoint), last-updated 2025-11-13, fetched 2026-04-19). Per [sqlite.org/c3ref/wal_checkpoint_v2.html](https://sqlite.org/c3ref/wal_checkpoint_v2.html) — *"All automatic checkpoints are PASSIVE."*
- **Time-driven (explicit)** — the daemon runs `PRAGMA wal_checkpoint(PASSIVE)` every 5 minutes via the writer worker. PASSIVE is the only mode that, per [wal_checkpoint_v2.html](https://sqlite.org/c3ref/wal_checkpoint_v2.html), *"does as much work as possible without interfering with other database connections"* — it never invokes the busy-handler callback and does not block readers or writers. FULL, RESTART, and TRUNCATE each either block writers or contend with readers.

On backup completion the daemon runs a one-shot `PRAGMA wal_checkpoint(TRUNCATE)` to reclaim the WAL file's on-disk footprint. TRUNCATE is the only mode that truncates the log file to zero bytes (wal_checkpoint_v2.html). Running TRUNCATE opportunistically (tied to backup) keeps the steady-state cadence strictly PASSIVE and avoids stalling the writer under normal load.

### Daily Full Backup

A daily full backup runs via the CLI `sidekicks db backup` and uses `better-sqlite3.backup(destination)` — a Promise-returning method that wraps the SQLite Online Backup API ([better-sqlite3 `docs/api.md`](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md), fetched 2026-04-19). Per WiseLibs' docs: *"You can continue to use the database normally while a backup is in progress. If the same database connection mutates the database while performing a backup, those mutations will be reflected in the backup automatically."* This matches the single-writer-worker model; multi-connection concurrent writes are not permitted in V1 so the alternate *"backup forcefully restarted"* path does not apply.

**Atomicity.** The SQLite Online Backup API holds a shared lock on the source database during each step and an *"exclusive lock on the destination file"* for the full duration ([sqlite.org/c3ref/backup_finish.html](https://sqlite.org/c3ref/backup_finish.html), fetched 2026-04-19). WiseLibs' documentation does not specify whether `.backup()` fsyncs the destination or the parent directory. The daemon MUST therefore mandate the following publish sequence at the implementation layer:

1. Write to a same-filesystem staging path `<target>.tmp`.
2. `fsync()` the staging file descriptor.
3. `rename(<target>.tmp, <target>)` — atomic on a single filesystem per [`rename(2)`](https://man7.org/linux/man-pages/man2/rename.2.html).
4. `fsync()` the parent directory file descriptor — required for directory-entry durability per [`fsync(2)`](https://man7.org/linux/man-pages/man2/fsync.2.html): *"Calling `fsync()` does not necessarily ensure that the entry in the directory containing the file has also reached disk. For that an explicit `fsync()` on a file descriptor for the directory is also needed."*

A single-runner lock (`<backups-dir>/backup.lock` opened with `O_EXCL|O_CREAT`) prevents concurrent backup invocations from racing on the destination's exclusive lock.

### Retention

Retention follows a GFS-structured rolling window: **7 daily + 4 weekly**, for a steady-state maximum of 11 backup files plus any in-progress staging files and the single `backup.lock`. Daily backups older than 7 days are pruned; weekly backups (one per ISO week, promoted from that week's Monday daily) older than 4 weeks are pruned. This is a project convention, not a named-in-literature retention standard — chosen to bracket the 24-hour restore SLO plus one human-escalation week.

Pruning runs as part of the daily backup workflow after the new backup succeeds; no stand-alone pruner process is needed.

### Pre-Migration Backup

Before `schema_version` migration runs — specifically, before any `ALTER TABLE` or `DROP TABLE` statement in a pending migration — the daemon creates a pre-migration backup via the same `.backup()` primitive, with filename `pre-migration-v{N}-{timestamp}.db`. This provides a load-bearing rollback point: if a forward-only migration leaves the database in an unrecoverable state, the operator can restore from the pre-migration backup and revert the binary.

Mainstream ORM/migration tools surveyed — Django 5.1 migrations, Rails 8.1 Active Record migrations, Alembic 1.18 — do not automate a pre-migration backup; this is an intentional local guarantee of this project, not an inherited convention. Pre-migration backups are retained indefinitely until explicit operator prune via `sidekicks db backup --prune-pre-migration`.

### Filesystem Layout

**Host install (daemon running directly on host).** Backups live at `$XDG_STATE_HOME/ai-sidekicks/backups/` (default `$HOME/.local/state/ai-sidekicks/backups/`). Per the [XDG Base Directory Specification v0.8](https://specifications.freedesktop.org/basedir-spec/latest/) (8 May 2021, current as of 2026-04-19), `$XDG_STATE_HOME` *"defines the base directory relative to which user-specific state files should be stored"* and is intended to hold *"actions history (logs, history, recently used files, …); current state of the application that can be reused on a restart"* — backups fall squarely within this definition (vs `$XDG_DATA_HOME`, which is for user-portable data).

**Container install (daemon running inside Docker).** XDG variables inside a container are not meaningful (`$HOME` is typically ephemeral). The container writes to absolute path `/var/lib/ai-sidekicks/backups/`; the operator bind-mounts host `$XDG_STATE_HOME/ai-sidekicks/backups/` to that container path ([docs.docker.com/engine/storage/volumes/](https://docs.docker.com/engine/storage/volumes/), fetched 2026-04-19). Named volumes are acceptable but sacrifice direct host-side access for off-box replication. This reconciles the container-relative `./data/backups/` path declared in [Spec-027 §Row 6](027-self-host-secure-defaults.md) — that path is the operator-facing default in the bundled `docker-compose.yml` (a bind mount from host `./data/` to container `/var/lib/ai-sidekicks/`), while this spec owns the daemon-side absolute path and the atomicity contract above.

**Permissions.** The backups directory MUST be created with mode `0700` on POSIX (owner-only read/write/execute), matching the container-side requirement in [Spec-027 §Row 6](027-self-host-secure-defaults.md). This applies to both the host install path and any bind-mount target on the host side; the container's view inherits from the host because bind-mount permissions are not independently enforced by Docker.

### Master-Key Separation

The daemon master key wrapping participant AES-GCM keys is deliberately excluded from all backups per [Spec-022 §Daemon Master Key](022-data-retention-and-gdpr.md#daemon-master-key) and the [Local Persistence Repair And Restore §Backup Constraints](../operations/local-persistence-repair-and-restore.md#backup-constraints) runbook. The SQLite Online Backup API copies only database pages; it cannot pick up sibling files. `daemon-master.enc` is therefore trivially excluded from `.backup()` output. Operators running tar/rsync-style backups over the daemon's filesystem root MUST follow the runbook's OS-specific exclusion rules to preserve crypto-shred correctness.

### Restore SLO

Data staleness on restore is bounded at **≤ 24 hours** (worst case = crash 23h 59m after the last daily backup). Faster RPO is available via WAL replay from the most recent checkpoint (bounded at ≤ 5 minutes by the time-driven cadence) when the on-disk WAL is salvageable; the 24h SLO governs the pathological case where the filesystem is lost.

### References

- [sqlite.org/backup.html](https://sqlite.org/backup.html) — Online Backup API semantics
- [sqlite.org/c3ref/backup_finish.html](https://sqlite.org/c3ref/backup_finish.html) — destination-side exclusive lock
- [sqlite.org/c3ref/wal_checkpoint_v2.html](https://sqlite.org/c3ref/wal_checkpoint_v2.html) — checkpoint mode semantics (PASSIVE / FULL / RESTART / TRUNCATE)
- [sqlite.org/pragma.html#pragma_wal_autocheckpoint](https://sqlite.org/pragma.html#pragma_wal_autocheckpoint) — 1000-page default (last-updated 2025-11-13)
- [better-sqlite3 API — `.backup()`](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) — Promise-returning wrapper
- [XDG Base Directory Specification v0.8](https://specifications.freedesktop.org/basedir-spec/latest/) — `$XDG_STATE_HOME` semantics (8 May 2021)
- [Docker storage volumes](https://docs.docker.com/engine/storage/volumes/) — container bind-mount pattern
- [`fsync(2)`](https://man7.org/linux/man-pages/man2/fsync.2.html) — parent-directory fsync requirement
- [`rename(2)`](https://man7.org/linux/man-pages/man2/rename.2.html) — same-filesystem atomicity
- [Spec-022 §Daemon Master Key](022-data-retention-and-gdpr.md#daemon-master-key) — master-key custody and crypto-shred contract
- [Spec-027 §Row 6](027-self-host-secure-defaults.md) — self-host default `backup on by default`
- [Local Persistence Repair And Restore §Backup Constraints](../operations/local-persistence-repair-and-restore.md#backup-constraints) — operator-facing OS exclusion rules

## State And Data Implications

- Local canonical event data and command receipts are the basis for replay and idempotency.
- Shared control-plane data remains separate from local execution truth.
- Recovery outcomes must be surfaced into canonical event history and operational telemetry.

## Example Flows

- `Example: The daemon restarts during a blocked approval state. Startup replay rebuilds the session projection, restores the pending approval, and resumes the session in a recoverable waiting state.`
- `Example: A provider session cannot be resumed. The daemon records a recovery failure outcome, transitions the run to failed with provider failure detail and recovery-needed condition, and leaves the run visible to users and operators for intervention.`

## Implementation Notes

- Recovery is a first-class product behavior, not just an operator tool.
- SQLite durability settings are part of the correctness contract for local execution.
- Projection rebuild logic should be testable in isolation from live provider transports.

## Pitfalls To Avoid

- Treating client cache as sufficient for recovery
- Silently dropping in-flight run state after restart
- Using one undifferentiated store for both local execution and shared collaboration truth

## Acceptance Criteria

- [ ] Local node restart can rebuild session projections and restore pending queue or approval state.
- [ ] Local mutable work is blocked when canonical local persistence is unavailable.
- [ ] Recovery failure is visible and auditable rather than silent.

## ADR Triggers

- If the product changes the local-vs-shared storage split or the default local persistence engine, create or update `../decisions/004-sqlite-local-state-and-postgres-control-plane.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: snapshot compaction cadence is not standardized in v1. Correctness must not depend on compaction, and implementations may run without scheduled compaction.

## References

- [Data Architecture](../architecture/data-architecture.md)
- [Observability Architecture](../architecture/observability-architecture.md)
- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
