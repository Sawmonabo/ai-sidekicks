# Data Architecture

## Purpose

Define the system's durable storage model and the boundary between local runtime state and shared collaboration state.

## Scope

This document covers durable stores, event logs, projections, artifacts, and recovery metadata.

## Context

The product requires durable replay and recovery while keeping local execution private and machine-scoped. That requires a deliberate split between local runtime storage and shared collaboration storage.

## Responsibilities

- persist runtime events, receipts, projections, and recovery handles locally
- persist session directory, membership, invite, and presence history in shared storage
- support replay and projection rebuild
- preserve artifact provenance and audit history

## Component Boundaries

| Store | Responsibility |
| --- | --- |
| `Local SQLite Store` | Canonical node-local event log, command receipts, runtime bindings, queue state, run projections, and approval records needed for local recovery. |
| `Shared Postgres Store` | Shared session metadata, invites, memberships, presence history, session directory, and cross-node coordination records. |
| `Artifact Storage` | Durable artifact payloads and manifests, split between `local-only` and shared-visible artifacts according to policy. |
| `Projection Layer` | Read-optimized materializations derived from canonical event streams and shared coordination records. |

Artifact Storage uses an OCI-inspired manifest envelope with content-addressable storage (CAS) keyed by SHA-256 for deduplication. Locally, artifacts are stored on the filesystem. For shared artifacts, blob storage is used.

Presence data is ephemeral. It is maintained as a Yjs Awareness CRDT in memory only and is NOT persisted to any durable store. In V1, cross-node fan-out for presence uses Postgres LISTEN/NOTIFY.

## Data Flow

1. Local execution state changes append to the local event log.
2. Local projections update from those events for fast reads and replay safety.
3. Shared collaboration actions write to the shared relational store.
4. Artifact manifests record provenance and visibility; payloads are stored locally or shared according to policy.
5. Clients read merged projections from local and shared stores.

## Trust Boundaries

- Local SQLite stores machine-scoped execution truth and recovery data.
- Shared Postgres stores collaboration truth, not local code-execution authority.
- Artifact replication across that boundary must respect visibility and trust policy.

## Privacy and Data Protection

PII fields in session events are stored in a separate encrypted column (`pii_payload`) using per-participant AES-256-GCM keys. This enables crypto-shredding for GDPR deletion: destroying a participant's key renders their PII unrecoverable without affecting the rest of the event log.

## Schema References

- [Local SQLite Schema](./schemas/local-sqlite-schema.md) — canonical DDL for daemon-local tables
- [Shared Postgres Schema](./schemas/shared-postgres-schema.md) — canonical DDL for control plane tables
- [Cross-Plan Dependency Graph](./cross-plan-dependencies.md) — table ownership map (which plan owns CREATE vs ALTER for each table)

## Migration Strategy

### Local SQLite

- **Versioning:** Embedded migration runner with a `schema_version` table. Forward-only migrations.
- **Upgrade path:** The daemon checks `schema_version` on startup. If the current binary expects a higher version, it runs pending migrations in order. No rollback — failed migrations halt startup with an explicit error.
- **Extension pattern:** When Plan-015 (or other extending plans) needs to ALTER a table owned by Plan-001, the extending plan's migration must declare a dependency on the base table's creation migration. The migration runner enforces ordering via version numbers.

### Shared Postgres

- **Versioning:** Migration tool (e.g., golang-migrate, dbmate, or equivalent). `schema_migrations` table tracks applied versions.
- **Rollback policy:** Each migration must include a down migration. Rollbacks are available but discouraged in production — prefer forward-fix migrations.
- **Multi-node coordination:** Migrations run from a single coordinator (deploy pipeline), not from individual nodes. Nodes connecting to a database with a newer schema than expected must refuse to start and surface a version mismatch error.

## Failure Modes

- Local SQLite corruption prevents replay until repaired or restored.
- Projection lag causes stale reads even when canonical events exist.
- Shared metadata writes succeed while local artifact publication fails, leaving partial visibility that must be reconciled.
- Artifact visibility policy is misapplied and exposes `local-only` outputs too broadly.

## Related Domain Docs

- [Session Model](../domain/session-model.md)
- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Related Specs

- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [Artifacts Files And Attachments](../specs/014-artifacts-files-and-attachments.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../specs/020-observability-and-failure-recovery.md)

## Related Architecture Docs

- [Cross-Plan Dependency Graph and Ownership Map](./cross-plan-dependencies.md) — table ownership, package path ownership, build order, and inter-plan dependency declarations

## Related ADRs

- [SQLite Local State And Postgres Control Plane](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)
