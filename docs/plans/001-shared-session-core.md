# Plan-001: Shared Session Core

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `001` |
| **Slug** | `shared-session-core` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-001: Shared Session Core](../specs/001-shared-session-core.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-018](../decisions/018-cross-version-compatibility.md) |
| **Dependencies** | None (tier-entry plan; owns `0001-initial.sql` migration and forward-declares schema shape consumed by [Plan-003](./003-runtime-node-attach.md), [Plan-006](./006-session-event-taxonomy-and-audit-log.md), [Plan-022](./022-data-retention-and-gdpr.md)) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement the minimum session creation, join, snapshot, and replay foundation used by all later features.

## Scope

This plan covers session ids, default channel creation, owner membership bootstrap, local event append, and typed session read or subscribe APIs.

## Non-Goals

- Invite lifecycle
- Runtime-node attach
- Queue and intervention behavior

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/session.ts`
- `packages/client-sdk/src/sessionClient.ts`
- `packages/runtime-daemon/src/session/session-service.ts`
- `packages/runtime-daemon/src/session/session-projector.ts`
- `packages/control-plane/src/sessions/session-directory-service.ts`
- `apps/desktop/renderer/src/session-bootstrap/`

## Data And Storage Changes

Plan-001 owns the initial migration (`0001-initial.sql`) and declares the schema shape downstream plans depend on. The column-level definitions are canonical in the schema docs below; this plan body enumerates which elements are forward-declared for cross-plan consumers.

- Add the minimal `participants` identity-anchor table (`id UUID PK`, `created_at TIMESTAMPTZ`) to Collaboration Control Plane storage **before** any FK-bearing shared table. This anchor is required at Plan-001 migration time because `session_memberships.participant_id`, `session_invites.inviter_id`, and `runtime_node_attachments.participant_id` all `REFERENCES participants(id)`, and Plan-001/002/003 execute before Plan-018 per [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md). Plan-001 owns the physical CREATE of the minimal shape only; identity/profile columns (`display_name`, `identity_ref`, `metadata`) and the `identity_mappings` side table are added by Plan-018 via additive ALTER migrations. See [Shared Postgres Schema §Participants Identity Anchor](../architecture/schemas/shared-postgres-schema.md#participants-identity-anchor-plan-001).
- Add shared `sessions` and `session_memberships` tables to Collaboration Control Plane storage. The `sessions` table carries `min_client_version TEXT` — NULL = no floor — forward-declared here per [ADR-018](../decisions/018-cross-version-compatibility.md) §Decision #1 (semver `"MAJOR.MINOR"` format) and §Decision #3 (monotonic session-floor enforcement); the control plane is authoritative for this field ([ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)).
- Add local `session_events` and `session_snapshots` tables to Local Runtime Daemon SQLite.
- Forward-declare `session_events.pii_payload BLOB` (NULLable) per [Spec-022 §PII Data Map](../specs/022-data-retention-and-gdpr.md) — semantics owned by Plan-022 (crypto-shred fan-out Path 1).
- Forward-declare the integrity-protocol columns on `session_events` — `monotonic_ns INTEGER NOT NULL`, `prev_hash BLOB NOT NULL`, `row_hash BLOB NOT NULL`, `daemon_signature BLOB NOT NULL`, `participant_signature BLOB` — per [Spec-006 §Integrity Protocol](../specs/006-session-event-taxonomy-and-audit-log.md) (BLAKE3 row_hash + Ed25519 daemon_signature + RFC 8785 JCS canonical serialization hash chain; semantics owned by Plan-006).
- Forward-declare the `participant_keys` table (per-participant AES-256-GCM key custody; columns: `participant_id` PK, `encrypted_key_blob`, `key_version`, `created_at`, `rotated_at`) per [Spec-022 §Participant Keys](../specs/022-data-retention-and-gdpr.md) — semantics and DELETE-as-crypto-shred lifecycle owned by Plan-022.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for canonical column definitions of `session_events`, `session_snapshots`, and `participant_keys`.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for canonical column definitions of `sessions` (including `min_client_version`) and `session_memberships`.

## Cross-Plan Forward-Declared Schema

Plan-001 emits the DDL above at tier entry (first migration). The downstream plans below own the read/write semantics and invariants for each forward-declared element. Engineers implementing Plan-001 MUST NOT add read/write logic for these columns; that logic belongs in the owner plan's implementation window.

| Forward-Declared Element | Semantics Owner | Invariant / Protocol |
| --- | --- | --- |
| `session_events.pii_payload` | [Plan-022](./022-data-retention-and-gdpr.md) | Encrypted under per-participant AES-256-GCM key (key in `participant_keys.encrypted_key_blob`); deleting the participant's key row crypto-shreds this column by construction per [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md) Path 1 |
| `session_events.monotonic_ns / prev_hash / row_hash / daemon_signature / participant_signature` | [Plan-006](./006-session-event-taxonomy-and-audit-log.md) | BLAKE3 hash chain + Ed25519 signatures over RFC 8785 JCS canonical bytes; `pii_payload` is excluded from canonical bytes but a `pii_ciphertext_digest` is embedded (one-way BLAKE3 over ciphertext) so signatures remain verifiable after crypto-shred per [Spec-022 §Signature Safety Under Shred](../specs/022-data-retention-and-gdpr.md) |
| `participant_keys` (table) | [Plan-022](./022-data-retention-and-gdpr.md) | Wrapped under daemon master key (XChaCha20-Poly1305); row DELETE = crypto-shred for all events authored by that participant; rotation updates `key_version` and stamps `rotated_at` |
| `sessions.min_client_version` | [Plan-003](./003-runtime-node-attach.md) | Attach-time floor check: daemons below floor are rejected with typed `VERSION_FLOOR_EXCEEDED` per [ADR-018](../decisions/018-cross-version-compatibility.md) §Decision #4; read-only degradation, not ejection |
| `participants` (minimal anchor: `id`, `created_at`) | [Plan-018](./018-identity-provider-adapters.md) | Plan-001 creates the anchor row shape; no participant rows are inserted until Plan-018's registration flow lands; Plan-018 adds `display_name`, `identity_ref`, `metadata`, and `identity_mappings` via additive ALTER migrations per [Shared Postgres Schema §Participants and Identity](../architecture/schemas/shared-postgres-schema.md#participants-and-identity-plan-018) |

## API And Transport Changes

- Add `SessionCreate`, `SessionRead`, `SessionJoin`, and `SessionSubscribe` to the shared client SDK and daemon/control-plane contracts.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define session contracts and ids in `packages/contracts`.
2. Implement shared Collaboration Control Plane session directory create or read or join paths.
3. Implement Local Runtime Daemon session event append and snapshot projection.
4. Add client SDK methods and desktop bootstrap wiring for create, join, read, and subscribe.

## Parallelization Notes

- Contract definitions and Collaboration Control Plane storage work can proceed in parallel with Local Runtime Daemon projection scaffolding.
- Desktop renderer integration should wait until client SDK contracts are stable.

## Test And Verification Plan

- Contract tests for session payload validation
- Integration tests for create and join and replay bootstrap
- Manual verification of create then reconnect then join from second client

## Rollout Order

1. Ship contracts and storage migrations
2. Enable create and read behind internal feature flag
3. Enable join and live subscribe once replay is stable

## Rollback Or Fallback

- Disable create or join endpoints and keep `local-only` session bootstrap if shared session flows regress.

## Risks And Blockers

- Event ordering mistakes between local and shared projections
- Unresolved `local-only` session promotion semantics

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
