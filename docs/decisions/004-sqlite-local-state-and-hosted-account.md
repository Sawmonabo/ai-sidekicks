# ADR-004: SQLite Local State And Hosted Account

| Field         | Value                   |
| ------------- | ----------------------- |
| **Status**    | `accepted`              |
| **Type**      | `Type 2 (one-way door)` |
| **Domain**    | `Data Architecture`     |
| **Date**      | `2026-04-14`            |
| **Author(s)** | `Codex`                 |
| **Reviewers** | `Accepted 2026-04-15`   |

## Context

The system needs durable local execution truth, rebuild, and recovery on the user's machines, while also needing shared coordination storage for the account's statement chain and the device and machine registry. A single storage model for both concerns would either over-centralize local execution data or under-serve the coordination queries every device makes.

## Problem Statement

How should the system split local execution storage from shared coordination storage?

### Trigger

The data architecture and persistence specs require a concrete storage split before implementation plans can be written.

## Decision

We will use SQLite for machine-local execution state, and a separate SQLite database inside the relay for the hosted account. On Cloudflare the account's data lives in the relay's Durable Object, in its SQLite storage; on the self-hosted relay it is a SQLite file the relay's one process writes ([Deployment Topology §Account Storage](../architecture/deployment-topology.md#account-storage), [Hosted Account Schema](../architecture/schemas/hosted-account-schema.md)). The two databases never share a file, a table or a row.

### Damaged local state

Damaged history is repaired before anything is given up, and it never stops the rest of the app.

1. **Heal first.** The daemon copies the database file and its `-wal` and `-shm` files aside untouched, then rebuilds the damaged session's projection again from its events. Where the file itself is damaged, it recovers the file into a fresh one with SQLite's recovery API (`sqlite3_recover`), or, where the person keeps backups (`Back up automatically` or `Back up now`, [Spec-013 §Backup Policy](../specs/013-persistence-and-recovery.md#backup-policy)), reads the session's missing events from the newest backup, taking whichever source holds more of them, and runs `PRAGMA integrity_check` on the result before using it.
2. **Last good point.** Where an event still cannot be read, the session opens read-only at every event before the first damaged one, with `Continue from here` and `Delete session`. `Continue from here` appends one event naming the damaged range, which every reader and rebuild skips, so the log is never truncated or rewritten ([ADR-016](./016-shared-event-sourcing-scope.md)). The damaged rows stay where they are, kept for the person to inspect.
3. **Unreadable session.** A session with no readable event reads `Damaged` and offers only `Delete session`.
4. **One session, not the node.** Only the damaged session refuses writes. Every other session and the rest of the daemon keep working, and `daemon.status.read` names each damaged session.

### Thesis — Why This Option

SQLite is a strong fit for Local Runtime Daemon persistence: embedded, transactional, WAL-backed, and simple to ship with desktop and CLI execution nodes. The account's data is small (one person, a handful of machines and devices, and a statement chain that grows by a statement per link, rename or removal) and every write to it already passes through the relay, so SQLite beside the connections gives it relational integrity and indexing with no outside database to host, pay for or suspend, and one SQL dialect on both relays. On Cloudflare, SQLite is the storage a Durable Object is built on, and it comes with point-in-time recovery ([Deployment Topology §Account Storage](../architecture/deployment-topology.md#account-storage)).

### Antithesis — The Strongest Case Against

Two databases create operational and engineering complexity. JSON files are simpler locally. A single hosted relational store would simplify some analytics and cross-session querying. SQLite can struggle if local write volume or concurrency becomes unexpectedly high.

### Synthesis — Why It Still Holds

JSON files are too weak for rebuild-heavy, event-oriented runtime truth. A single hosted store would break the local-execution boundary and increase trust and offline dependence. SQLite's constraints are acceptable for Local Runtime Daemon workloads, especially with WAL and deliberate projection design. The two-database complexity is justified because the data domains are different, and both speak SQLite.

## Alternatives Considered

### Option A: SQLite Local + SQLite Inside The Relay (Chosen)

- **What:** Use embedded SQLite per machine, and the relay's own SQLite for the hosted account: the Durable Object's storage on Cloudflare, a file on the self-hosted relay.
- **Steel man:** Aligns each database with its trust boundary and workload shape, with no outside database service.
- **Weaknesses:** Requires explicit boundaries between the machine's data and the account's, and the self-hosted relay's file needs a backup of its own.

### Option B: File-Based Local Storage (Rejected)

- **What:** Use JSON or file stores on the machine.
- **Steel man:** Simple local implementation and easy inspection.
- **Why rejected:** Too weak for event sourcing, receipts, transactional queue state, and reliable rebuild.

### Option C: One Shared Relational Store For Everything (Rejected)

- **What:** Centralize both local execution and coordination data in a remote relational system.
- **Steel man:** Simplifies some centralized querying and operations.
- **Why rejected:** Violates the local-execution boundary and weakens offline and privacy characteristics.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Local daemon workloads fit SQLite well. | The persistence spec requires SQLite with WAL for machine-local execution truth and restart recovery. | SQLite could become a bottleneck or operational pain. |
| 2 | Shared coordination data needs relational guarantees. | Statement-chain, device-registry and machine-registration rows are read and written by several of the user's devices and machines at once. | A lighter shared store might suffice. |
| 3 | The system can keep local and shared data boundaries explicit. | Data architecture and security docs already separate them. | Replication or visibility bugs could blur the model. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Local SQLite store is corrupted or unavailable | Low | High | A session's rebuild fails at restart, or `PRAGMA integrity_check` does not read `ok` | Heal first (copy aside, rebuild, `sqlite3_recover` or the newest backup, where one exists); else open the session at its last good point; else mark it `Damaged`; only that session refuses writes (§Damaged local state) |
| The relay, and with it the account's database, is unavailable | Med | High | Device linking, machine registration, or statement-chain reads fail | Preserve explicit `local-only` degraded mode |
| Artifact or metadata is written to the wrong boundary | Med | High | Visibility or audit anomalies appear | Enforce policy-aware manifest classification and tests |

## Reversibility Assessment

- **Reversal cost:** High. It would require migrations, operational changes, and likely API contract changes.
- **Blast radius:** Persistence, rebuild, recovery, observability, control-plane services, and operations docs.
- **Migration path:** Introduce a new store, backfill from canonical records, run dual-write or staged migration, then cut over.
- **Point of no return:** After implementation plans and runtime recovery depend on the store split.

## Consequences

### Positive

- Strong fit between storage engines and trust boundaries
- Better local durability than file-based storage

### Negative (accepted trade-offs)

- Dual-store complexity
- Need for careful artifact and metadata boundary design

### Unknowns

- Exact rebuild and snapshot tuning under heavy long-running session volume

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Local restart recovery succeeds from embedded storage | 100% of recovery test fixtures | Recovery integration suite | Each run of the recovery integration suite |
| Shared coordination data remains queryable and durable across the user's devices and machines | 100% of core device-registry and machine-registration paths | Control-plane integration suite | Each run of the control-plane integration suite |

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| `architecture/data-architecture.md` | Canonical architecture doc | Local and shared state belong to different trust and workload domains | [architecture/data-architecture.md](../architecture/data-architecture.md) |
| `specs/013-persistence-and-recovery.md` | Canonical spec | The local SQLite store is part of the correctness contract | [specs/013-persistence-and-recovery.md](../specs/013-persistence-and-recovery.md) |
| `operations/local-persistence-repair-and-restore.md` | Canonical operations doc | Local persistence integrity and restore behavior are explicit operational requirements | [operations/local-persistence-repair-and-restore.md](../operations/local-persistence-repair-and-restore.md) |
| SQLite Recovery API | Official docs | `sqlite3_recover` rebuilds a damaged database into a fresh file, keeping what it can read | [sqlite.org/recovery.html](https://sqlite.org/recovery.html) |
| Kafka log implementation | Official docs | At startup each record's CRC is checked and the log is cut back to the last valid record | [kafka.apache.org/42/implementation/log](https://kafka.apache.org/42/implementation/log/) |

### Related Domain Docs

- [Session Model](../domain/session-model.md)
- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

### Related Architecture Docs

- [Data Architecture](../architecture/data-architecture.md)
- [Daemon Architecture](../architecture/daemon.md)
- [Control Plane Architecture](../architecture/control-plane.md)

### Related Specs

- [Artifacts Files And Attachments](../specs/012-artifacts-files-and-attachments.md)
- [Persistence And Recovery](../specs/013-persistence-and-recovery.md)
- [Observability And Failure Recovery](../specs/018-observability-and-failure-recovery.md)

### Related ADRs

- [Local Execution Shared Control Plane](./002-local-execution-shared-control-plane.md)
- [Daemon Backed Queue And Interventions](./003-daemon-backed-queue-and-interventions.md)
