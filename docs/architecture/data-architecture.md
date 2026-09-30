# Data Architecture

## Purpose

Define the system's durable storage model and the boundary between local runtime state and shared control-plane state.

## Scope

This document covers durable stores, event logs, projections, artifacts, and recovery metadata.

## Context

The product requires durable replay and recovery while keeping local execution private and machine-scoped. That requires a deliberate split between local runtime storage and shared control-plane storage.

## Responsibilities

- persist runtime events, receipts, projections, and recovery handles locally
- persist the device registry, the signed statement chain and each machine's registration in shared storage; the control plane keeps no session record
- support replay and projection rebuild
- preserve artifact provenance and audit history

## Component Boundaries

| Store | Responsibility |
| --- | --- |
| `Local SQLite Store` | Canonical node-local event log, command receipts, runtime bindings, queue state, run projections, and approval records needed for local recovery. V1 driver pin: `better-sqlite3` **13.0.3** exact (Node-API, per [ADR-022](../decisions/022-v1-toolchain-selection.md) and [Spec-013 §Driver Pin](../specs/013-persistence-recovery-and-replay.md#driver-pin)) — on a single-writer worker thread (see [Spec-013 §Writer Concurrency](../specs/013-persistence-recovery-and-replay.md#writer-concurrency)). |
| `Shared Postgres Store` | The device registry, the signed statement chain and each machine's registration. No session record: a machine's service is its sessions' one store. |
| `Artifact Storage` | Durable artifact payloads and manifests, held on the machine that runs the session. |
| `Projection Layer` | Read-optimized materializations derived from canonical event streams and shared coordination records. |

Artifact Storage uses an OCI-inspired manifest envelope with content-addressable storage (CAS) keyed by SHA-256 for deduplication. Artifacts are stored on the filesystem of the machine that runs the session, and the person's other devices list and read them through Remote Control. The control plane holds no artifact bytes, keys or copies.

Liveness data is ephemeral. A device or a machine is reachable while its relay connection is live, and the control plane records that connection; nothing about liveness is canonical, and no reader replays it. There is no shared presence CRDT — liveness answers only which of the user's own endpoints are currently reachable.

## Data Flow

1. Local execution state changes append to the local event log.
2. Local projections update from those events for fast reads and replay safety.
3. Device registration, liveness, and relay coordination write to the shared relational store.
4. Artifact manifests record provenance; payloads stay on the machine that runs the session.
5. Clients read merged projections from local and shared stores.

## Event-Sourcing Scope

Governed by [ADR-017: Shared Event-Sourcing Scope](../decisions/017-shared-event-sourcing-scope.md).

V1 scopes event-sourcing to per-machine local event logs. Each session runs on one owning machine for its whole life, and that machine's daemon owns the session's authoritative `session_events` table in its Local SQLite (Plan-001 owner; see [local-sqlite-schema.md](./schemas/local-sqlite-schema.md)). There is no shared session event log in Postgres; shared-postgres-schema.md contains coordination records only.

**Cross-device event delivery.** Another device reads a session, live and in its history, over its own sealed channel to the owning machine ([ADR-010](../decisions/010-tokens-passkeys-and-the-remote-channel.md)); the relay carries those frames without reading them, and no other daemon appends a copy of the session's events.

**Audit across machines (accepted trade-off).** No single query spans all of the person's machines: each machine answers for the sessions it runs, and an audit or export covering several machines reads each one. The control plane holds no event payloads, which is the cost of a relay that sees no session content.

**Within-daemon ordering primitive.** For ordering events emitted by a single daemon across wall-clock discontinuities (NTP step, VM resume, operator clock edit), the authoritative primitive is `session_events.monotonic_ns` — a BIGINT produced by `process.hrtime.bigint()` per [Spec-013 §Clock Handling](../specs/013-persistence-recovery-and-replay.md#clock-handling). Its zero point is unspecified and resets on every daemon restart, so it is strictly a within-process ordering primitive, never a cross-daemon one.

## Trust Boundaries

- Local SQLite stores machine-scoped execution truth and recovery data.
- Shared Postgres stores coordination truth, not local code-execution authority.

## Privacy and Data Protection

PII fields in session events are stored in a separate encrypted column (`pii_payload`) under the session's content key, the AES-256-GCM key that also seals the session's machine-authored content, with an associated-data label of their own — a discipline the `interventions` table mirrors for a steer's directive text and `queue_items` for a queue item's body, a person's send or an orchestration-authored prompt (each its own `pii_payload` under the same session key). `Delete old data` deletes the session's content key before the session's rows, overwritten with zeros first and with a `TRUNCATE` checkpoint after commit ([Spec-020 §Ordering And Atomicity](../specs/020-data-retention-and-gdpr.md#ordering-and-atomicity)), so the purge leaves no readable copy, even in freed database pages, and `Erase all data` shreds every session at once by destroying the daemon master key the content keys are wrapped under, before it deletes the store.

## Schema References

- [Local SQLite Schema](./schemas/local-sqlite-schema.md) — canonical DDL for daemon-local tables
- [Shared Postgres Schema](./schemas/shared-postgres-schema.md) — canonical DDL for control plane tables
- [Cross-Plan Dependency Graph](./cross-plan-dependencies.md) — the forward build order for plan phases that have not shipped yet

## Schema Evolution

Each database has one schema, created whole when it is first opened: the daemon's Local SQLite schema and the control plane's Postgres schema. There are no numbered migrations and no upgrade steps. A feature that needs a table or a column adds it to its database's one schema, and to that schema's test, in the change that builds the feature. Every table in the daemon's schema is `STRICT`.

## Cross-Version Compatibility

The schema (above) is distinct from **wire-format** compatibility between a user's own devices and the machine when they run different versions. The schema answers "what does one database hold?" Wire-format compatibility answers "how do a phone, a laptop app, and the machine's service at different versions interoperate during a session?"

A user updates each device and each machine on its own schedule, and a self-hosted deployment updates on yet another per [ADR-020: V1 Deployment Model and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md), so a session driven from a stale device against a freshly updated runtime node is the normal case, not an edge case. The wire format carried between a user's endpoints — `EventEnvelope` defined in [Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md) — is therefore evolved under a versioning contract specified in [ADR-018: Cross-Version Compatibility](../decisions/018-cross-version-compatibility.md).

Key properties the rest of the architecture depends on:

- **Wire version** is an envelope-level `EventEnvelope.version` field using semver string `"MAJOR.MINOR"`. Producer writes its own outgoing version at emit time.
- **The app and the service agree a version range at the handshake.** Each app accepts its own service version and the previous one; outside that range the console is read-only and names the side that is behind. A session carries no version floor of its own.
- **Audit log is never rewritten.** Receivers encountering unknown event types persist the original bytes as **version stubs** — a distinct artifact from the compaction stubs defined in [Spec-005 §Event Compaction Policy](../specs/005-session-event-taxonomy-and-audit-log.md#event-compaction-policy). A version stub retains all its fields verbatim; a compaction stub removes `payload`. Upgrade-time re-interpretation happens via an upcaster chain at read/dispatch time, never by rewriting committed rows.
- **MINOR bumps are additive-only.** New optional fields, new event types, new enum values. Any semantic or structural break requires a MAJOR bump.
- **Version stubs are excluded from compaction** until re-interpreted at least once, so post-upgrade replay is lossless.

See [ADR-018 §Decision](../decisions/018-cross-version-compatibility.md#decision) for the full semantics and [ADR-018 §Reviewer Checklist for MINOR Bumps](../decisions/018-cross-version-compatibility.md#reviewer-checklist-for-minor-bumps) for the author discipline that governs each additive bump.

## Failure Modes

- Local SQLite corruption prevents replay until repaired or restored.
- Projection lag causes stale reads even when canonical events exist.

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
- [Shared Event-Sourcing Scope](../decisions/017-shared-event-sourcing-scope.md) — V1 per-machine local event logs; no shared log
