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
| `Local SQLite Store` | Canonical node-local event log, command receipts, runtime bindings, queue state, run projections, and approval records needed for local recovery. V1 driver pin: `better-sqlite3@^12.9.0` on a single-writer worker thread (see [Spec-015 §Writer Concurrency](../specs/015-persistence-recovery-and-replay.md#writer-concurrency)). |
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

## Event-Sourcing Scope

Governed by [ADR-017: Shared Event-Sourcing Scope](../decisions/017-shared-event-sourcing-scope.md).

V1 scopes event-sourcing to per-daemon local event logs. Each daemon owns an authoritative `session_events` table in its Local SQLite (Plan-001 owner; see [local-sqlite-schema.md](./schemas/local-sqlite-schema.md)). There is no shared session event log in Postgres; shared-postgres-schema.md contains coordination records only.

**Cross-participant event delivery.** When Alice's daemon emits an event, the event payload is pairwise-encrypted per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) and distributed via the relay to every session participant. Each receiving daemon validates the sender signature, decrypts the payload, and appends the event to its own local `session_events` table with its own per-session monotonic sequence number. Alice's sequence and Bob's sequence for the same event payload will differ.

**Federated audit model (accepted trade-off).** Cross-participant audit — "what happened in session X across all participants between T1 and T2?" — spans multiple daemons. There is no single Postgres query that returns a canonical cross-participant event list. Audit export collects log exports from every participant's daemon and merges them. This is the explicit accepted cost of V1's zero-knowledge relay.

**Per-daemon sequence semantics (accepted consequence).** Per-daemon `sequence` is monotonic only within that daemon's own log. Daemons may disagree on the ordering of concurrent events that arrived from different peers at overlapping wall-clock times. Consumers that need cross-daemon ordering must use wall-clock timestamps with origin-participant-id tiebreakers, or Hybrid Logical Clocks (BL-076). Raw `sequence` is not a cross-daemon ordering primitive.

**Within-daemon ordering primitive.** For ordering events emitted by a single daemon across wall-clock discontinuities (NTP step, VM resume, operator clock edit), the authoritative primitive is `session_events.monotonic_ns` — a BIGINT produced by `process.hrtime.bigint()` per [Spec-015 §Clock Handling](../specs/015-persistence-recovery-and-replay.md#clock-handling). Its zero point is unspecified and resets on every daemon restart, so it is strictly a within-process ordering primitive, never a cross-daemon one.

**V1.1 upgrade path.** ADR-017 retains shared event log (Option A) as a V1.1 candidate, gated on [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) MLS promotion gates (audit + interop + 4-week soak). V1.1 would add a `session_events_shared` Postgres table populated in parallel with per-daemon logs; local logs remain authoritative for local replay.

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

## Cross-Version Compatibility

DDL schema migration (above) is distinct from **wire-format** compatibility between participants running different client versions. Schema migration answers "how does one node upgrade its own storage?" Wire-format compatibility answers "how do nodes at different versions interoperate during a session?"

AI Sidekicks is peer-to-peer multi-node with independent upgrade cadences per [ADR-020: V1 Deployment Model and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md). Mixed-version participation within a single session is the normal case, not an edge case. The wire format carried between participants — `EventEnvelope` defined in [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md) — is therefore evolved under a versioning contract specified in [ADR-018: Cross-Version Compatibility](../decisions/018-cross-version-compatibility.md).

Key properties the rest of the architecture depends on:

- **Wire version** is an envelope-level `EventEnvelope.version` field using semver string `"MAJOR.MINOR"`. Producer writes its own outgoing version at emit time.
- **Session metadata** carries `min_client_version` as a monotonic-raise floor. Control plane is authoritative per [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md); peers never trust peer-reported floor values.
- **Audit log is never rewritten.** Receivers encountering unknown event types persist the original canonical bytes as signed **version stubs** — a distinct artifact from the compaction stubs defined in [Spec-006 §Event Compaction Policy](../specs/006-session-event-taxonomy-and-audit-log.md#event-compaction-policy). A version stub retains all canonical fields verbatim (so Ed25519 signatures remain verifiable per Spec-006 §Integrity Protocol); a compaction stub removes `payload` and is therefore no longer signature-verifiable. Upgrade-time re-interpretation happens via an upcaster chain at read/dispatch time, never by rewriting committed rows.
- **MINOR bumps are additive-only.** New optional fields, new event types, new enum values. Any semantic or structural break requires a MAJOR bump.
- **Version stubs are excluded from compaction** until re-interpreted at least once, so post-upgrade replay is lossless.

See [ADR-018 §Decision](../decisions/018-cross-version-compatibility.md#decision) for the full semantics and [ADR-018 §Reviewer Checklist for MINOR Bumps](../decisions/018-cross-version-compatibility.md#reviewer-checklist-for-minor-bumps) for the author discipline that governs each additive bump.

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
- [Shared Event-Sourcing Scope](../decisions/017-shared-event-sourcing-scope.md) — V1 per-daemon local event logs; shared log deferred to V1.1 gated on ADR-010 MLS promotion gates
