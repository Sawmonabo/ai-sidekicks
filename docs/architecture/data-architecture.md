# Data Architecture

## Purpose

Define the system's durable storage model and the boundary between local runtime state and shared control-plane state.

## Scope

This document covers durable stores, event logs, projections, artifacts, and recovery metadata.

## Context

The product requires durable replay and recovery while keeping local execution private and machine-scoped. That requires a deliberate split between local runtime storage and shared control-plane storage.

## Responsibilities

- persist runtime events, receipts, projections, and recovery handles locally
- persist the session directory, the device registry, and device / node liveness history in shared storage
- support replay and projection rebuild
- preserve artifact provenance and audit history

## Component Boundaries

| Store | Responsibility |
| --- | --- |
| `Local SQLite Store` | Canonical node-local event log, command receipts, runtime bindings, queue state, run projections, and approval records needed for local recovery. V1 driver pin: `better-sqlite3` **13.0.3** exact (Node-API; moved from `^12.9.0` on 2026-09-01 with the Electron-44 pin move per [ADR-022 §Decision Log](../decisions/022-v1-toolchain-selection.md#decision-log) and [Spec-013 §Driver Pin](../specs/013-persistence-recovery-and-replay.md#driver-pin)) — on a single-writer worker thread (see [Spec-013 §Writer Concurrency](../specs/013-persistence-recovery-and-replay.md#writer-concurrency)). |
| `Shared Postgres Store` | Session metadata, the device registry, device and node liveness history, session directory, and cross-node coordination records. |
| `Artifact Storage` | Durable artifact payloads and manifests, split between `local-only` and shared-visible artifacts according to policy. |
| `Projection Layer` | Read-optimized materializations derived from canonical event streams and shared coordination records. |

Artifact Storage uses an OCI-inspired manifest envelope with content-addressable storage (CAS) keyed by SHA-256 for deduplication. Locally, artifacts are stored on the filesystem. For shared artifacts, the relay eagerly pins user-encrypted ciphertext in a digest-addressed, TTL-bounded relay blob store at publish time — so cross-node fetch works while the publishing node is offline — threat-model-scoped 2026-08-08 and time-bounded 2026-08-26 ([ADR-015 §Decision Log](../decisions/015-v1-feature-scope-definition.md#decision-log)): given an operational relay, not against a compromised node of the fetching user, and only while the relay pin is live — `state = 'pinned'` AND `expires_at` still in the future, ending at the artifact's retention TTL — with coordination rows and per-`(user, node)` wrapped CEKs in Postgres (`artifact_relay_*`) and never payload bytes — wrapped to durable per-node artifact-encryption keys held daemon-local (`artifact_encryption_keys`, Spec-020 master-key custody), never to session-ephemeral keys; see [Spec-012 §Cross-Node Artifact Relay](../specs/012-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1).

Liveness data is ephemeral. A device or runtime node records a heartbeat row that decays to `offline` when heartbeats stop; nothing about liveness is canonical, and no reader replays it. There is no shared presence CRDT — liveness answers only which of the user's own endpoints are currently reachable.

## Data Flow

1. Local execution state changes append to the local event log.
2. Local projections update from those events for fast reads and replay safety.
3. Device registration, liveness, and relay coordination write to the shared relational store.
4. Artifact manifests record provenance and visibility; payloads are stored locally or shared according to policy.
5. Clients read merged projections from local and shared stores.

## Event-Sourcing Scope

Governed by [ADR-017: Shared Event-Sourcing Scope](../decisions/017-shared-event-sourcing-scope.md).

V1 scopes event-sourcing to per-daemon local event logs. Each daemon owns an authoritative `session_events` table in its Local SQLite (Plan-001 owner; see [local-sqlite-schema.md](./schemas/local-sqlite-schema.md)). There is no shared session event log in Postgres; shared-postgres-schema.md contains coordination records only.

**Cross-device event delivery.** When the runtime node's daemon emits an event, the event payload is pairwise-encrypted per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) and distributed via the relay to the user's connected devices and to any other daemon of that user attached to the session. Each receiving daemon validates the sender signature, decrypts the payload, and appends the event to its own local `session_events` table with its own per-session monotonic sequence number. Two daemons' sequence numbers for the same event payload will differ.

**Federated audit model (accepted trade-off).** Audit that spans more than one of the user's machines — "what happened in session X between T1 and T2?" when the session moved between nodes — spans multiple daemons. There is no single Postgres query that returns a canonical cross-node event list, because the control plane holds no event payloads. Audit export collects log exports from each daemon and merges them. This is the explicit accepted cost of V1's zero-knowledge relay.

**Per-daemon sequence semantics (accepted consequence).** Per-daemon `sequence` is monotonic only within that daemon's own log. Daemons may disagree on the ordering of concurrent events that arrived from different senders at overlapping wall-clock times. Consumers that need cross-daemon ordering must use wall-clock timestamps with origin-node-id tiebreakers, or Hybrid Logical Clocks (BL-076). Raw `sequence` is not a cross-daemon ordering primitive.

**Within-daemon ordering primitive.** For ordering events emitted by a single daemon across wall-clock discontinuities (NTP step, VM resume, operator clock edit), the authoritative primitive is `session_events.monotonic_ns` — a BIGINT produced by `process.hrtime.bigint()` per [Spec-013 §Clock Handling](../specs/013-persistence-recovery-and-replay.md#clock-handling). Its zero point is unspecified and resets on every daemon restart, so it is strictly a within-process ordering primitive, never a cross-daemon one.

**V1.1 upgrade path.** ADR-017 retains shared event log (Option A) as a V1.1 candidate, gated on [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) MLS promotion gates (audit + interop + 4-week soak). V1.1 would add a `session_events_shared` Postgres table populated in parallel with per-daemon logs; local logs remain authoritative for local replay.

## Trust Boundaries

- Local SQLite stores machine-scoped execution truth and recovery data.
- Shared Postgres stores coordination truth, not local code-execution authority.
- Artifact replication across that boundary must respect visibility and trust policy.

## Privacy and Data Protection

PII fields in session events are stored in a separate encrypted column (`pii_payload`) using per-user AES-256-GCM keys — a discipline the `interventions` table mirrors for the Spec-003 rollback composite's staged replacement-send body (its own `pii_payload` under the same per-user key). This enables crypto-shredding for GDPR deletion: destroying a user's key renders their PII unrecoverable — both copies at once — without affecting the rest of the event log.

## Schema References

- [Local SQLite Schema](./schemas/local-sqlite-schema.md) — canonical DDL for daemon-local tables
- [Shared Postgres Schema](./schemas/shared-postgres-schema.md) — canonical DDL for control plane tables
- [Cross-Plan Dependency Graph](./cross-plan-dependencies.md) — the forward build order for plan phases that have not shipped yet

## Migration Strategy

### Local SQLite

- **Versioning:** Embedded migration runner with a `schema_version` table. Forward-only migrations.
- **Upgrade path:** The daemon checks `schema_version` on startup. If the current binary expects a higher version, it runs pending migrations in order. No rollback — failed migrations halt startup with an explicit error.
- **Extension pattern:** When Plan-013 (or other extending plans) needs to ALTER a table owned by Plan-001, the extending plan's migration must declare a dependency on the base table's creation migration. The migration runner enforces ordering via version numbers.

### Shared Postgres

- **Versioning:** Migration tool (e.g., golang-migrate, dbmate, or equivalent). `schema_migrations` table tracks applied versions.
- **Rollback policy:** Each migration must include a down migration. Rollbacks are available but discouraged in production — prefer forward-fix migrations.
- **Multi-node coordination:** Migrations run from a single coordinator (deploy pipeline), not from individual nodes. Nodes connecting to a database with a newer schema than expected must refuse to start and surface a version mismatch error.

## Cross-Version Compatibility

DDL schema migration (above) is distinct from **wire-format** compatibility between a user's own devices and machines running different client versions. Schema migration answers "how does one node upgrade its own storage?" Wire-format compatibility answers "how do a phone, a laptop app, and a runtime node at different versions interoperate during a session?"

A user updates each device and each machine on its own schedule, and a self-hosted deployment updates on yet another per [ADR-020: V1 Deployment Model and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md), so a session driven from a stale device against a freshly updated runtime node is the normal case, not an edge case. The wire format carried between a user's endpoints — `EventEnvelope` defined in [Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md) — is therefore evolved under a versioning contract specified in [ADR-018: Cross-Version Compatibility](../decisions/018-cross-version-compatibility.md).

Key properties the rest of the architecture depends on:

- **Wire version** is an envelope-level `EventEnvelope.version` field using semver string `"MAJOR.MINOR"`. Producer writes its own outgoing version at emit time.
- **Session metadata** carries `min_client_version` as a monotonic-raise floor. Control plane is authoritative per [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md); peers never trust peer-reported floor values.
- **Audit log is never rewritten.** Receivers encountering unknown event types persist the original canonical bytes as signed **version stubs** — a distinct artifact from the compaction stubs defined in [Spec-005 §Event Compaction Policy](../specs/005-session-event-taxonomy-and-audit-log.md#event-compaction-policy). A version stub retains all canonical fields verbatim (so Ed25519 signatures remain verifiable per `Spec-005 §Integrity Protocol`); a compaction stub removes `payload` and is therefore no longer signature-verifiable. Upgrade-time re-interpretation happens via an upcaster chain at read/dispatch time, never by rewriting committed rows.
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

- [Session Event Taxonomy And Audit Log](../specs/005-session-event-taxonomy-and-audit-log.md)
- [Artifacts Files And Attachments](../specs/012-artifacts-files-and-attachments.md)
- [Persistence Recovery And Replay](../specs/013-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../specs/018-observability-and-failure-recovery.md)

## Related Architecture Docs

- [Cross-Plan Dependency Graph](./cross-plan-dependencies.md) — the forward build order and the dependency edges between unshipped plan phases

## Related ADRs

- [SQLite Local State And Postgres Control Plane](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)
- [Shared Event-Sourcing Scope](../decisions/017-shared-event-sourcing-scope.md) — V1 per-daemon local event logs; shared log deferred to V1.1 gated on ADR-010 MLS promotion gates
