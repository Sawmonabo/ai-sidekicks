# Plan-006: Session Event Taxonomy And Audit Log

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `006` |
| **Slug** | `session-event-taxonomy-and-audit-log` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-006: Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-012](../decisions/012-cedar-approval-policy-engine.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md), [ADR-018](../decisions/018-cross-version-compatibility.md), [ADR-020](../decisions/020-v1-deployment-model-and-oss-license.md) |
| **Dependencies** | [Plan-001](./001-shared-session-core.md) (forward-declares `session_events` integrity columns, `pii_payload`, and `participant_keys` per Plan-001 §Cross-Plan Forward-Declared Schema — Plan-006 owns the read/write semantics defined here) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement the canonical append-only session-event contract, its tamper-evident integrity protocol, and the PII-column indirection — providing the register-and-append-path infrastructure every other plan emits into.

## Scope

This plan covers the `EventEnvelope` contract and version semantics, the 120-event taxonomy registry across 18 categories, append-only persistence with BLAKE3 hash chain and Ed25519 signatures over RFC 8785 JCS canonical bytes, Merkle anchor emission into the shared `event_log_anchors` table (metadata only per [ADR-017](../decisions/017-shared-event-sourcing-scope.md)), the PII-column indirection pattern (`pii_payload` ciphertext + `pii_ciphertext_digest`), replay reads, live subscriptions, and compaction to audit stubs.

Plan-006 is the canonical emitter of the `event_maintenance` and `audit_integrity` categories (6 event types total). It is not the emitter of the remaining 16 category entries — see §Event Taxonomy Coverage for the ownership boundary.

## Non-Goals

- Full timeline UI rendering (Plan-013)
- Metrics and dashboard implementation (Plan-020)
- Emission of events owned by other plans: `session.*` lifecycle (Plan-001), `runtime_node.*` and `session.clock_*` (Plan-003 / Plan-015), `dispatch.*` (Spec-024 implementation), `participant.*` purge trigger (Plan-022; Plan-006 emits only the `event.shredded` audit artifact after Path 1 completes), `policy_bundle.*` (V1.1 Cedar runtime bundle loader)
- Crypto-shred fan-out orchestration (Plan-022 owns the three-path orchestrator; Plan-006 provides the append path and emits `event.shredded` on Path 1 completion)
- Cedar policy bundle runtime loading (V1.1 per [ADR-012](../decisions/012-cedar-approval-policy-engine.md) §Decision — V1 compiles policies into the daemon image at build time)

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Integrity protocol invariants ([Spec-006 §Integrity Protocol](../specs/006-session-event-taxonomy-and-audit-log.md), [Spec-022 §Signature Safety Under Shred](../specs/022-data-retention-and-gdpr.md)) are load-bearing — changes to canonical-form fields or field ordering require an ADR-018 MINOR envelope bump and cannot be retrofitted to already-signed rows.

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/events/envelope.ts` — `EventEnvelope` shape + `.version` semantics
- `packages/contracts/src/events/taxonomy.ts` — 120-event type enum + 18-category enum
- `packages/contracts/src/errors/version-errors.ts` — `VERSION_FLOOR_EXCEEDED` + `VERSION_CEILING_EXCEEDED` error codes
- `packages/runtime-daemon/src/events/canonicalizer.ts` — RFC 8785 JCS emitter with fixed field ordering and RFC 3339 UTC millisecond `occurredAt`
- `packages/runtime-daemon/src/events/signer.ts` — BLAKE3 hash chain + Ed25519 signer
- `packages/runtime-daemon/src/events/pii-indirection.ts` — AES-256-GCM encrypt + BLAKE3 ciphertext digest + payload embed (sole write path for `pii_payload`)
- `packages/runtime-daemon/src/events/event-log-service.ts` — append path writing all integrity columns; emits `event.shredded` at Plan-022 Path 1 callback
- `packages/runtime-daemon/src/events/compactor.ts` — audit-stub generator + compaction triggers; emits `event.compacted`
- `packages/runtime-daemon/src/events/merkle-anchor-service.ts` — anchor cadence + upload to shared `event_log_anchors`
- `packages/runtime-daemon/src/events/integrity-verifier.ts` — read-side chain/signature/anchor verifier + observer-pattern key-reuse detector; emits `audit_integrity_verified` / `audit_integrity_failed` / `key_reuse_detected`
- `packages/runtime-daemon/src/events/schema-migration-emitter.ts` — emits `schema.migrated` on batch boundary
- `packages/runtime-daemon/src/events/replay-service.ts` — `EventReadAfterCursor`, `EventReadWindow`, cursor state tracking compacted regions
- `packages/control-plane/src/event-anchors/` — shared `event_log_anchors` write path (metadata only per ADR-017)
- `packages/client-sdk/src/eventClient.ts` — typed SDK methods + `EventSubscription`
- `apps/desktop/src/renderer/src/timeline/` — audit-stub rendering for compacted regions

## Data And Storage Changes

- Implement read/write semantics for `session_events` columns forward-declared by Plan-001 per [Plan-001 §Cross-Plan Forward-Declared Schema](./001-shared-session-core.md): `monotonic_ns`, `prev_hash`, `row_hash`, `daemon_signature`, `participant_signature`, `pii_payload`, plus the payload-embedded `pii_ciphertext_digest` field.
- Add shared `event_log_anchors` table (Postgres) — columns `session_id`, `node_id`, `start_sequence`, `end_sequence`, `merkle_root`, `root_signature`, `anchored_at`. Metadata only; the control plane does **not** receive session event payloads per [ADR-017](../decisions/017-shared-event-sourcing-scope.md).
- Extend local `session_snapshots` with replay-cursor state and a flag indicating whether a range contains compacted regions.
- **No `session_events_shared` table.** Per ADR-017 §Decision, V1 ships Option B (per-daemon local logs). Cross-participant events are distributed by the relay as pairwise-encrypted payloads and appended to each receiving daemon's local log with that daemon's own per-session sequence number.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) and [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for canonical column definitions.

## API And Transport Changes

- Define `EventEnvelope` v1.0 with `.version = "1.0"` at emit per [Spec-006 §EventEnvelope Version Semantics](../specs/006-session-event-taxonomy-and-audit-log.md) — semver `"MAJOR.MINOR"` per [ADR-018 §Decision #1](../decisions/018-cross-version-compatibility.md); producer-set at emit time per §Decision #2; immutable per [Spec-006 §EventEnvelope Version Semantics](../specs/006-session-event-taxonomy-and-audit-log.md) (Immutability) + ADR-018 §Decision #6 (upcaster chain on read, never log rewrite) — rewriting `.version` would break the hash chain and signatures, which both commit to canonical bytes including `.version`.
- Register `EventReadAfterCursor`, `EventReadWindow`, and `EventSubscription` in the shared client SDK and daemon or control-plane contracts.
- Register typed `VERSION_FLOOR_EXCEEDED` and `VERSION_CEILING_EXCEEDED` in [Error Contracts](../architecture/contracts/error-contracts.md) before the first Plan-001 emitter lands, per ADR-018 §Decision #10 (pre-Plan-001 registration mandate; below-floor write behavior defined in §Decision #4).
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas.

## Event Taxonomy Coverage

Plan-006 owns the **123-event type registry across 19 categories** per [Spec-006 §Event Type Summary](../specs/006-session-event-taxonomy-and-audit-log.md). The 19 categories:

| Category | Count | Emitter Plan |
| --- | --- | --- |
| `session_lifecycle` (session + channel/agent + repo/workspace/worktree) | 24 | [Plan-001](./001-shared-session-core.md) (7 `session.*`) + [Plan-016](./016-multi-agent-channels-and-orchestration.md) (6 `channel.*`/`agent.*`) + [Plan-009](./009-repo-attachment-and-workspace-binding.md) + [Plan-010](./010-worktree-lifecycle-and-execution-modes.md) (11 `repo.*`/`workspace.*`/`worktree.*`) |
| `membership_change` (invite/membership + presence) | 13 | [Plan-002](./002-invite-membership-and-presence.md) (incl. `membership.created`) |
| `channel_arbitration` | 2 | [Plan-016](./016-multi-agent-channels-and-orchestration.md) |
| `run_lifecycle` | 9 | [Plan-004](./004-queue-steer-pause-resume.md) |
| `interactive_request` (queue + intervention) | 11 | [Plan-004](./004-queue-steer-pause-resume.md) |
| `approval_flow` | 6 | [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) |
| `artifact_publication` | 6 | [Plan-014](./014-artifacts-files-and-attachments.md) |
| `assistant_output` | 2 | [Plan-005](./005-provider-driver-contract-and-capabilities.md) |
| `tool_activity` | 5 | [Plan-005](./005-provider-driver-contract-and-capabilities.md) + [Plan-015](./015-persistence-recovery-and-replay.md) (idempotency-class `tool.replayed` / `tool.skipped_during_recovery`) |
| `cross_node_dispatch` | 13 | [Plan-027](./027-cross-node-dispatch-and-approval.md) implements [Spec-024](../specs/024-cross-node-dispatch-and-approval.md); see [Cross-Plan Dependency Graph §Spec-024 Implementation Plan](../architecture/cross-plan-dependencies.md#spec-024-implementation-plan) |
| `usage_telemetry` | 3 | [Plan-005](./005-provider-driver-contract-and-capabilities.md) |
| `onboarding_lifecycle` | 2 | [Plan-026](./026-first-run-onboarding.md) |
| `runtime_node_lifecycle` | 9 | [Plan-003](./003-runtime-node-attach.md) (7 `runtime_node.*`) + [Plan-015](./015-persistence-recovery-and-replay.md) (2 `session.clock_*`) |
| `recovery_events` | 3 | [Plan-015](./015-persistence-recovery-and-replay.md) |
| `participant_lifecycle` | 5 | [Plan-022](./022-data-retention-and-gdpr.md) |
| `audit_integrity` | 3 | **Plan-006** (verifier + observer) |
| `security_events` | 2 | [Plan-007](./007-local-ipc-and-daemon-control.md) (`security.default.override` Phase 1; `security.update.available` Tier 4) |
| `event_maintenance` | 3 | **Plan-006** (compactor, schema-migration emitter, shred audit artifact) |
| `policy_events` | 2 | V1.1 Cedar runtime bundle loader — see V1/V1.1 note below |
| **Total** | **123** |  |

Plan-006 is the canonical emitter for the two bold-faced categories above (6 event types):

- `event_maintenance`: `schema.migrated`, `event.compacted`, `event.shredded`
- `audit_integrity`: `audit_integrity_verified`, `audit_integrity_failed`, `key_reuse_detected`

Plan-006 provides the append-path infrastructure, canonical envelope, and integrity protocol that all other emitter plans write into; it does not emit their category entries.

**V1 vs V1.1 emission scope (`policy_events`).** Per [ADR-012 §Decision](../decisions/012-cedar-approval-policy-engine.md), V1 compiles Cedar policies into the daemon image at build time; runtime Cedar WASM bundle loading is V1.1. The `policy_bundle.loaded` / `policy_bundle.rejected` types are registered in the V1 taxonomy so the registry is complete from V1 forward, but their emitter ships in V1.1 as part of the bundle loader. Plan-006 implements the type registration only; a V1.1 plan owns the bundle-loader emission surface.

## Integrity Protocol

Plan-006 implements the tamper-evidence protocol defined in [Spec-006 §Integrity Protocol](../specs/006-session-event-taxonomy-and-audit-log.md).

### Canonical Serialization

Per [Spec-006 §Canonical Serialization Rules](../specs/006-session-event-taxonomy-and-audit-log.md):

- Canonicalization: [RFC 8785 JSON Canonicalization Scheme (JCS)](https://datatracker.ietf.org/doc/html/rfc8785). The canonicalizer is shared with [Spec-024](../specs/024-cross-node-dispatch-and-approval.md)'s `request_body_hash` so the daemon runs one canonicalization rule across integrity and dispatch.
- Hash function: [BLAKE3](https://github.com/BLAKE3-team/BLAKE3-specs/blob/master/blake3.pdf) for both the hash-chain digest and the `pii_ciphertext_digest`.
- Signature scheme: [RFC 8032 §5.1 — Ed25519](https://datatracker.ietf.org/doc/html/rfc8032#section-5.1).
- Canonical fields, in order: `id`, `sessionId`, `sequence`, `occurredAt`, `category`, `type`, `actor`, `payload`, `correlationId`, `causationId`, `version`.
- Present-but-null fields are serialized as `null`, not omitted — "absent" vs "present-but-null" are wire-distinguishable.
- `occurredAt` is RFC 3339 UTC with millisecond precision (`YYYY-MM-DDTHH:MM:SS.sssZ`) so ordering is byte-stable.
- `pii_payload` is NOT in the canonical form. Events with non-NULL `pii_payload` embed `pii_ciphertext_digest` inside `payload` (and `payload` IS canonical) so the signature commits to a one-way digest of the ciphertext.

### Hash Chain

Every `session_events` row:

- `prev_hash` = `row_hash` of the immediately-prior row for the same `session_id` (genesis row uses 32 zero bytes as `prev_hash`).
- `row_hash` = `BLAKE3(prev_hash || canonical_bytes(row))`.

Verification: recompute `canonical_bytes(row)`, recompute `BLAKE3(prev_hash || canonical_bytes(row))`, compare to the stored `row_hash`. Mismatch halts replay at the offending sequence and surfaces `audit_integrity_failed` with `failureMode = 'hash_mismatch'`.

### Ed25519 Signatures

- `daemon_signature` = `Ed25519(daemon_signing_key, canonical_bytes(row))`.
- `participant_signature` = `Ed25519(participant_signing_key, canonical_bytes(row))` — optional, populated for participant-authoritative events (e.g., approval decisions per [Spec-012](../specs/012-approvals-permissions-and-trust-boundaries.md)).
- Verification uses the `NodeId`-resolved public key from the session participant roster per [Security Architecture §Audit Log Integrity](../architecture/security-architecture.md).

### Merkle Anchor Emission

Per [Spec-006 §Anchoring Cadence](../specs/006-session-event-taxonomy-and-audit-log.md):

- Anchors fire on the earlier of `ANCHOR_INTERVAL_EVENTS = 1000` events OR `ANCHOR_INTERVAL_SECONDS = 300` seconds since the previous anchor.
- Anchor payload = `(session_id, node_id, start_sequence, end_sequence, merkle_root, root_signature, anchored_at)` — metadata only.
- `root_signature` = `Ed25519(daemon_signing_key, merkle_root)` — same daemon key used for row signatures.
- Anchors are uploaded to Postgres `event_log_anchors`; no session event payloads are sent to the control plane per ADR-017.
- Partition tolerance: if control-plane upload fails, anchors queue locally and flush on reconnect without re-signing. Local hash chain and signatures provide tamper-evidence without the anchor tier; anchors provide external cross-observer consistency.

## PII Columns

Plan-006 owns the read/write semantics for the `session_events.pii_payload BLOB` column forward-declared in Plan-001.

### Encrypt-Then-Digest-Then-Sign Order

The write-path order is LOAD-BEARING for [Spec-022 §Signature Safety Under Shred](../specs/022-data-retention-and-gdpr.md). Reversing any step breaks the safety proof — a signature directly over `pii_payload` ciphertext would leave signed bytes on disk after a shred, enabling length and structure attacks.

1. Extract PII fields from the in-memory event object (user messages, file paths, code snippets per [Spec-022 §PII Payload Column Pattern](../specs/022-data-retention-and-gdpr.md)).
2. Encrypt PII under the participant's AES-256-GCM key (key resolved from `participant_keys.encrypted_key_blob`; table owned by Plan-022 per Plan-001 §Cross-Plan Forward-Declared Schema). Output: `pii_ciphertext` bytes.
3. Compute `pii_ciphertext_digest = BLAKE3(pii_ciphertext)`.
4. Embed `pii_ciphertext_digest` into the `payload` field.
5. Canonicalize the envelope (per §Canonical Serialization above). `pii_payload` is excluded; `pii_ciphertext_digest` is included because it lives inside `payload`.
6. Compute `row_hash = BLAKE3(prev_hash || canonical_bytes)` and `daemon_signature = Ed25519(canonical_bytes)`.
7. Persist the row: `payload` (carrying the digest), `pii_payload` (ciphertext), `row_hash`, `daemon_signature`, `participant_signature?`.

The single write path is `pii-indirection.ts`; callers MUST NOT construct `pii_payload` bytes by any other route.

### Read Path

- `pii_payload IS NULL` — no decryption; return payload verbatim.
- `pii_payload` non-NULL and decryption key available — load ciphertext, decrypt under the participant AES-256-GCM key, merge decrypted PII back into the payload for the authorized caller.
- `pii_payload` non-NULL and key absent (crypto-shred has occurred; `participant_keys` row DELETEd in Plan-022 Path 1) — return the envelope + payload (including `pii_ciphertext_digest`) with PII fields replaced by a `<pii-shredded>` marker. Signature and hash verification remain valid because canonical bytes exclude `pii_payload`.

## Shred Fan-Out Cross-References

Plan-006 participates in the Path 1 → Path 2 → Path 3 fan-out defined in [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md):

- **Plan-006 emits `event.shredded` (Spec-006 §Event Maintenance)** after Path 1 (SQLite crypto-shred via `participant_keys` row DELETE) completes, carrying `{participantId, affectedSessionIds[], piiPayloadsCleared, shredReason}`. The event has no PII content and is retained indefinitely.
- **`participant.purged` emission discipline.** Plan-022 owns the emit trigger for `participant.purged` (Spec-006 §Participant Lifecycle), but the timing is constrained by [Spec-022 §Ordering And Atomicity](../specs/022-data-retention-and-gdpr.md): Plan-022 MUST NOT emit `participant.purged` until all three paths complete. Plan-006 provides the append path and does not short-circuit this ordering.
- **Partial-shred recovery.** On per-path failure, `participant.purge_requested` remains the most recent durable state per Spec-022 §Fallback Behavior. Plan-006's append path refuses to record a `participant.purged` until Plan-022's orchestrator reports all three paths complete; idempotent retries are safe because all three paths are idempotent per Spec-022 §Ordering And Atomicity.

## Audit Integrity Invariant

Events in the `audit_integrity` category (`audit_integrity_verified`, `audit_integrity_failed`, `key_reuse_detected`) **and** the `event_maintenance` category (`schema.migrated`, `event.compacted`, `event.shredded`) are subject to a shared invariant:

> **These events are never compacted. These events are never crypto-shredded.**

The invariant is declared symmetrically in [Spec-006 §Audit Integrity](../specs/006-session-event-taxonomy-and-audit-log.md) and [Spec-006 §Event Maintenance](../specs/006-session-event-taxonomy-and-audit-log.md). Rationale:

- Compacting `audit_integrity_failed` would destroy the record that a chain break was detected — a verifier could not distinguish "no failure occurred" from "the failure record was compacted away."
- Crypto-shredding `audit_integrity_*` events would defeat the tamper-evidence guarantee the protocol is designed to provide.
- Compacting `schema.migrated` would destroy the audit trail of a non-reversible schema change.
- Shredding `event.shredded` would be self-referential — the audit stub of the shred operation must survive indefinitely.

Plan-006 enforces the invariant at three layers:

- `compactor.ts` excludes events where `category IN ('audit_integrity', 'event_maintenance')` from compaction candidates and logs a contract test failure if ever a row from those categories is passed into the compaction selector.
- `pii-indirection.ts` refuses to write `pii_payload` for events in either category (these categories have `pii_payload = NULL` by construction — their content carries no participant PII).
- Shred fan-out Path 1 SQL selector explicitly excludes these categories from `pii_payload` clear scope (defense-in-depth; redundant with the previous rule because these rows' `pii_payload` is always NULL, but prevents regressions if a future event type is mis-categorized).

## Cross-Version Compatibility Surface

Plan-006 owns the `EventEnvelope` contract's integration with [ADR-018](../decisions/018-cross-version-compatibility.md):

- `.version` format `"MAJOR.MINOR"` per ADR-018 §Decision #1.
- Producer-set at emit per §Decision #2; never copied from received events.
- Unknown-MAJOR events persisted as version stubs retaining full canonical bytes per §Decision #5 (read-side behavior per §Decision #9 accept-and-stub); the row's `.version` stays the producer's original — version-stubbing never rewrites the canonical row.
- Unknown-MINOR optional fields and enum values preserved verbatim for future upcasting per [Spec-006 §EventEnvelope Version Semantics](../specs/006-session-event-taxonomy-and-audit-log.md) + ADR-018 §Decision #8 (MINOR additive-only) composed with §Decision #6 (upcaster chain on read).
- MAJOR-mismatch at session join produces typed `VERSION_FLOOR_EXCEEDED` (below `session.min_client_version`) or `VERSION_CEILING_EXCEEDED` (above session's highest supported MAJOR) per §Decision #4 + §Decision #10.
- Event-type registry extensions within the same envelope MAJOR are additive-only per §Decision #8 — event-type renames are explicitly forbidden because readers dispatch on the name.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define the `EventEnvelope` contract, the 120-event type enum, and the 18-category enum in `packages/contracts/src/events/`. Register `VERSION_FLOOR_EXCEEDED` + `VERSION_CEILING_EXCEEDED` in Error Contracts.
2. Implement the RFC 8785 JCS canonicalizer and the BLAKE3 + Ed25519 signer. Ship golden-vector contract tests covering RFC 8785 test vectors, field-ordering edge cases, null-vs-absent, and millisecond-precision `occurredAt`.
3. Implement `pii-indirection.ts` enforcing the encrypt → digest → embed → canonicalize → sign order as the sole write path for `pii_payload`. Contract tests cover the post-shred signature-verification property.
4. Implement `event-log-service.ts` append path writing Plan-001's forward-declared integrity columns (`monotonic_ns`, `prev_hash`, `row_hash`, `daemon_signature`, `participant_signature`, `pii_payload`). Expose a Plan-022 callback entry point for Path 1 completion that emits `event.shredded`.
5. Implement `compactor.ts` with the three triggers (50K events per session / 90 days / 500MB per-session SQLite) and the audit-stub format per [Spec-006 §Compacted Event Format](../specs/006-session-event-taxonomy-and-audit-log.md). Exclude `audit_integrity` and `event_maintenance` categories. Emit `event.compacted` on each pass.
6. Implement `merkle-anchor-service.ts` with the earlier-of-1000-events-or-300-seconds cadence. Upload metadata-only anchors to shared `event_log_anchors` per ADR-017.
7. Implement `integrity-verifier.ts` — read-side chain, signature, and anchor verification plus the observer-pattern key-reuse detector. Emit `audit_integrity_verified` on success; `audit_integrity_failed` (with the full `failureMode` enum per Spec-006 §Audit Integrity) on failure; `key_reuse_detected` when the rotation invariant `refuse_on_rotation` is violated.
8. Implement `schema-migration-emitter.ts` — emit `schema.migrated` on the `AFTER_MIGRATE_OPERATION_FINISH` batch boundary (per-operation granularity per Spec-006 §Event Maintenance, not per-statement).
9. Implement `replay-service.ts` — `EventReadAfterCursor`, `EventReadWindow`, `EventSubscription` with cursor state tracking compacted regions (via `retentionClass: 'audit_stub'`).
10. Wire the client SDK reads and desktop timeline rendering to display compacted stubs as summarized segments per Spec-006 §Replay Interaction with Compacted Regions.

## Parallelization Notes

- Contracts (envelope + taxonomy + error codes) block all runtime-daemon work; author first.
- Canonicalizer + signer + `pii-indirection` require contracts only and produce golden-vector artifacts the rest of the stack validates against.
- Merkle-anchor service, integrity verifier, compactor, and replay service can proceed in parallel once the append path is stable.
- Desktop timeline audit-stub rendering waits for replay-cursor + compacted-region detection.

## Test And Verification Plan

- RFC 8785 JCS golden-vector conformance tests (standard vectors + project-specific edge cases: null-vs-absent, nested object ordering, numeric canonicalization, millisecond-precision `occurredAt`).
- Hash-chain tests: genesis row, multi-row chain integrity, chain-break detection produces `audit_integrity_failed` with `failureMode = 'hash_mismatch'`.
- Signature tests: daemon-only and dual (daemon + participant) signatures, `NodeId` rotation invariant enforcement — a row signed by a rotated-out key produces `key_reuse_detected`.
- Version-stub round-trip: an unknown-MAJOR event is persisted verbatim; the log row's `.version` remains the producer's original; an upcaster chain re-interprets on upgrade without rewriting the row.
- PII indirection tests: post-shred signature still verifies over canonical bytes; a shredded event surfaces `pii_ciphertext_digest` but no plaintext and replaces PII fields with `<pii-shredded>`.
- Encrypt-order regression tests: a deliberately-misordered write path (signing before digest-embedding) is rejected by contract tests.
- Compaction tests: all three triggers fire independently; `audit_integrity` and `event_maintenance` categories are excluded; audit-stub format preserves envelope-level fields (id, sessionId, sequence, occurredAt, category, type, actor).
- Merkle-anchor tests: earlier-of cadence fires correctly; anchor payload is metadata only; `root_signature` verifies under the daemon public key.
- Replay tests: `EventReadAfterCursor` surfaces `retentionClass: 'audit_stub'` for compacted regions; `EventReadWindow` is bounded.
- End-to-end lifecycle: session.created → 50+ events → compaction pass → crypto-shred → integrity verification succeeds over the full chain, confirming the signature-safety property under real shred conditions.

## Rollout Order

1. Land envelope contracts + taxonomy enum + error-contract version codes.
2. Enable append-only writes with BLAKE3 chain and Ed25519 signatures behind internal feature gating.
3. Enable PII indirection (encrypt → digest → embed → sign order).
4. Enable replay reads and live subscription catch-up.
5. Enable compaction + Merkle anchor emission.
6. Enable integrity verifier + observer-pattern `key_reuse_detected`.

## Rollback Or Fallback

- If a new envelope MAJOR regresses, freeze new event-category adoption; ADR-018 §Decision #5 version-stub behavior keeps older readers consuming the log as opaque rows until the rollback lands.
- If compaction regresses (audit stubs malformed, wrong categories compacted), disable the compactor — full event retention remains correct without compaction.
- If Merkle anchor emission regresses (upload failure, signature mismatch), disable the anchor service — the local hash chain and row signatures retain tamper-evidence on each daemon's log.
- If the integrity verifier produces false-positive `audit_integrity_failed`, disable the verifier; chain and signatures remain durable on disk for later re-verification.

## Risks And Blockers

- **Canonicalization drift.** Any divergence from RFC 8785 JCS (field ordering, null-vs-absent, numeric canonicalization) produces hashes and signatures that two honest daemons cannot reconcile. A single shared canonicalizer implementation plus golden-vector tests are load-bearing.
- **PII write-path order.** Reversing the encrypt → digest → embed → sign order breaks Spec-022 §Signature Safety Under Shred. Enforced by making `pii-indirection.ts` the sole write path and by encrypt-order regression tests.
- **Category drift.** Event-type renames or category reassignments on existing wire types violate ADR-018 §Decision #8. Enforced by the taxonomy enum + contract tests; new types are additive-only.
- **Anchor cadence under partition.** If the daemon cannot reach the control plane for >300 seconds, anchors queue locally. The per-daemon hash chain + signatures retain tamper-evidence on each local log; the anchor tier provides external cross-observer consistency that catches up on reconnect.
- **Invariant enforcement regressions.** If the compactor or shred selector ever mis-categorizes an `audit_integrity` or `event_maintenance` event, the invariant is violated silently. Enforced at three layers (compactor, pii-indirection, shred selector) to prevent single-layer regressions.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
