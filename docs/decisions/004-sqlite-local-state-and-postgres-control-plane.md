# ADR-004: SQLite Local State And Postgres Control Plane

| Field         | Value                   |
| ------------- | ----------------------- |
| **Status**    | `accepted`              |
| **Type**      | `Type 2 (one-way door)` |
| **Domain**    | `Data Architecture`     |
| **Date**      | `2026-04-14`            |
| **Author(s)** | `Codex`                 |
| **Reviewers** | `Accepted 2026-04-15`   |

## Context

The system needs durable local execution truth, replay, and recovery on participant machines, while also needing shared coordination storage for invites, memberships, presence, and session directory metadata. A single storage model for both concerns would either over-centralize local execution data or under-serve collaboration queries.

## Problem Statement

How should the system split local execution storage from shared collaboration storage?

### Trigger

The data architecture and persistence specs require a concrete storage split before implementation plans can be written.

## Decision

We will use SQLite for node-local execution state and Postgres for shared control-plane state.

### Thesis — Why This Option

SQLite is a strong fit for Local Runtime Daemon persistence: embedded, transactional, WAL-backed, and simple to ship with desktop and CLI execution nodes. Postgres is a strong fit for shared Collaboration Control Plane data that needs multi-actor relational integrity, indexing, and operational visibility across hosted or self-hosted deployments.

### Antithesis — The Strongest Case Against

Two storage systems create operational and engineering complexity. JSON files are simpler locally. A single hosted relational store would simplify some analytics and cross-session querying. SQLite can struggle if local write volume or concurrency becomes unexpectedly high.

### Synthesis — Why It Still Holds

JSON files are too weak for replay-heavy, event-oriented runtime truth. A single hosted store would break the local-execution boundary and increase trust and offline dependence. SQLite's constraints are acceptable for Local Runtime Daemon workloads, especially with WAL and deliberate projection design. The dual-store complexity is justified because the data domains are different.

## Alternatives Considered

### Option A: SQLite Local + Postgres Shared (Chosen)

- **What:** Use embedded SQLite per runtime node and Postgres for collaboration services.
- **Steel man:** Aligns storage technology with trust boundary and workload shape.
- **Weaknesses:** Requires explicit replication boundaries and two operational models.

### Option B: File-Based Local Storage + Postgres Shared (Rejected)

- **What:** Use JSON or file stores locally and Postgres remotely.
- **Steel man:** Simple local implementation and easy inspection.
- **Why rejected:** Too weak for event sourcing, receipts, transactional queue state, and reliable replay.

### Option C: One Shared Relational Store For Everything (Rejected)

- **What:** Centralize both local execution and collaboration data in a remote relational system.
- **Steel man:** Simplifies some centralized querying and operations.
- **Why rejected:** Violates the local-execution boundary and weakens offline and privacy characteristics.

## Assumptions Audit

| #   | Assumption                                                         | Evidence                                                                                           | What Breaks If Wrong                                  |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | Local daemon workloads fit SQLite well.                            | The persistence spec requires SQLite with WAL for node-local execution truth and restart recovery. | SQLite could become a bottleneck or operational pain. |
| 2   | Shared collaboration data needs multi-actor relational guarantees. | Invite, membership, presence, and session directory data are cross-user.                           | A lighter shared store might suffice.                 |
| 3   | The system can keep local and shared data boundaries explicit.     | Data architecture and security docs already separate them.                                         | Replication or visibility bugs could blur the model.  |

## Failure Mode Analysis

| Scenario                                              | Likelihood | Impact | Detection                                       | Mitigation                                                  |
| ----------------------------------------------------- | ---------- | ------ | ----------------------------------------------- | ----------------------------------------------------------- |
| Local SQLite store is corrupted or unavailable        | Low        | High   | Daemon recovery fails or enters degraded mode   | Block mutable work, expose repair path, and support restore |
| Shared Postgres is unavailable                        | Med        | High   | Invite, membership, or presence operations fail | Preserve explicit `local-only` degraded mode                |
| Artifact or metadata is written to the wrong boundary | Med        | High   | Visibility or audit anomalies appear            | Enforce policy-aware manifest classification and tests      |

## Reversibility Assessment

- **Reversal cost:** High. It would require migrations, operational changes, and likely API contract changes.
- **Blast radius:** Persistence, replay, recovery, observability, control-plane services, and operations docs.
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

- Exact replay and snapshot tuning under heavy long-running session volume

## Decision Validation

### Pre-Implementation Checklist

- [ ] All unvalidated assumptions have a validation plan
- [x] At least one alternative was seriously considered and steel-manned
- [ ] Antithesis was reviewed by someone other than the author
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified and communicated to the team

### Success Criteria

| Metric                                                                      | Target                                   | Measurement Method              | Check Date   |
| --------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------- | ------------ |
| Local restart recovery succeeds from embedded storage                       | 100% of recovery test fixtures           | Recovery integration suite      | `2026-04-14` |
| Shared collaboration data remains queryable and durable across participants | 100% of core membership and invite paths | Control-plane integration suite | `2026-04-14` |

## References

### Research Conducted

| Source                                               | Type                       | Key Finding                                                                            | URL/Location                                                                                                |
| ---------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `architecture/data-architecture.md`                  | Canonical architecture doc | Local and shared state belong to different trust and workload domains                  | [architecture/data-architecture.md](../architecture/data-architecture.md)                                   |
| `specs/015-persistence-recovery-and-replay.md`       | Canonical spec             | SQLite and Postgres split is part of the correctness contract                          | [specs/015-persistence-recovery-and-replay.md](../specs/015-persistence-recovery-and-replay.md)             |
| `operations/local-persistence-repair-and-restore.md` | Canonical operations doc   | Local persistence integrity and restore behavior are explicit operational requirements | [operations/local-persistence-repair-and-restore.md](../operations/local-persistence-repair-and-restore.md) |

### Related Domain Docs

- [Session Model](../domain/session-model.md)
- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

### Related Architecture Docs

- [Data Architecture](../architecture/data-architecture.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)

### Related Specs

- [Artifacts Files And Attachments](../specs/014-artifacts-files-and-attachments.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../specs/020-observability-and-failure-recovery.md)

### Related ADRs

- [Local Execution Shared Control Plane](./002-local-execution-shared-control-plane.md)
- [Daemon Backed Queue And Interventions](./003-daemon-backed-queue-and-interventions.md)

## Decision Log

| Date       | Event        | Notes                                                           |
| ---------- | ------------ | --------------------------------------------------------------- |
| 2026-04-14 | Proposed     | Initial draft                                                   |
| 2026-04-14 | Re-baselined | Reviewer assignment and acceptance validation remain incomplete |
| 2026-04-15 | Accepted     | ADR accepted                                                    |
