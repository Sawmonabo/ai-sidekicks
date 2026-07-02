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

This plan covers the `EventEnvelope` contract and version semantics, the 140-event taxonomy registry across 19 categories per [Spec-006 §Event Type Summary](../specs/006-session-event-taxonomy-and-audit-log.md) (140 per the 2026-07-02 Spec-006 B1 amendment; lines 551+553 — canonical count), append-only persistence with BLAKE3 hash chain and Ed25519 signatures over RFC 8785 JCS canonical bytes, Merkle anchor emission into the shared `event_log_anchors` table (metadata only per [ADR-017](../decisions/017-shared-event-sourcing-scope.md)), the PII-column indirection pattern (`pii_payload` ciphertext + `pii_ciphertext_digest`), replay reads, live subscriptions, and compaction to audit stubs.

Plan-006 is the canonical emitter of the `event_maintenance` and `audit_integrity` categories (6 event types total). It is not the emitter of the remaining 17 categories — see §Event Taxonomy Coverage for the ownership boundary.

## Non-Goals

- Full timeline UI rendering (Plan-013)
- Metrics and dashboard implementation (Plan-020)
- Emission of events owned by other plans: `session.*` lifecycle (Plan-001 — except the two `session.goal_*` events, which are Plan-016-owned per the census row below: the goal set/clear RPC surface, 2026-07-02 campaign), `runtime_node.*` and `session.clock_*` (Plan-003 / Plan-015), `dispatch.*` (Spec-024 implementation), `participant.*` purge trigger (Plan-022; Plan-006 emits only the `event.shredded` audit artifact, recording the Path-1 crypto-shred), `policy_bundle.*` (V1.1 Cedar runtime bundle loader)
- Crypto-shred fan-out orchestration (Plan-022 owns the three-path orchestrator; Plan-006 provides the append path and emits `event.shredded` for the Path-1 crypto-shred, emitted after Path 3 per Spec-022 ordering)
- Cedar policy bundle runtime loading (V1.1 per [ADR-012](../decisions/012-cedar-approval-policy-engine.md) §Decision — V1 compiles policies into the daemon image at build time)

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred
- [x] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier 4 audit (NS-16 / PR #124), audit synthesis 2026-05-28; per-task Gate-4 traceability sub-bullets (a `Spec coverage` + `Verifies invariant` pair on each Phase 1–4 task) completed 2026-06-14 — the audit's per-task-traceability deliverable, outstanding from the 2026-05-28 synthesis; see [Status Promotion Gate §1](../operations/plan-implementation-readiness-audit-runbook.md#status-promotion-gate).

Integrity protocol invariants ([Spec-006 §Integrity Protocol](../specs/006-session-event-taxonomy-and-audit-log.md), [Spec-022 §Signature Safety Under Shred](../specs/022-data-retention-and-gdpr.md)) are load-bearing — changes to canonical-form fields or field ordering require an ADR-018 MINOR envelope bump and cannot be retrofitted to already-signed rows.

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/event.ts` (EXTEND in place per Plan-001's contracts package layout — directory-placement decision resolved 2026-05-28) — `EventEnvelope` schema + 19-category `EventCategory` literal union + 140-event `SessionEventType` literal union + `SESSION_EVENT_CATEGORY_BY_TYPE` registry + `CapabilityDetails` wrapper + `RuntimeNodeCapability{Declared,Updated}Payload` interfaces. The `events/` subdirectory does not exist in the contracts package; the top-level co-location pattern (Plan-001 baseline: 16 categories + 3-variant union + factory + registry) is the canonical layout.
- `packages/contracts/src/event-anchor.ts` (NEW Plan-006-owned) — `AnchorPayload` wire shape for daemon → control-plane anchor upload (Phase 3 T3.3). Top-level co-located per the package convention.
- `packages/contracts/src/error.ts` (CROSS-LINK only — JSDoc on `EventEnvelopeVersionSchema` pointing to the existing `VersionFloorExceededError` + `VersionCeilingExceededError` schemas at error.ts:97-101, 306-339, already shipped by Plan-001 T2.3 per the Phase 1 audit forward-completed surface)
- `packages/runtime-daemon/src/events/canonicalizer.ts` — RFC 8785 JCS emitter with mandatory UTF-16 code-unit lex-sort field ordering per the canonicalization resolution + Spec-006:597 amendment + RFC 3339 UTC millisecond `occurredAt`
- `packages/runtime-daemon/src/events/signer.ts` — BLAKE3 hash chain + Ed25519 signer
- `packages/runtime-daemon/src/events/signing-key-source.ts` (NEW Plan-006-owned per the signing-key custody resolution) — `DaemonSigningKeySource` interface + `OsKeystoreSealedDaemonSigningKeySource` implementation (per-session Ed25519 sealed via OS-keystore master-key; stored as ciphertext in the new local `daemon_signing_keys` SQLite table per ADR-004 SQLite-local-state boundary — corrected from the pre-Codex-T4-review draft that mis-located the column on shared-Postgres `sessions`)
- `packages/runtime-daemon/src/events/pii-indirection.ts` — AES-256-GCM encrypt + BLAKE3 ciphertext digest + payload embed (sole write path for `pii_payload`)
- `packages/runtime-daemon/src/events/event-log-service.ts` — append path writing all integrity columns; emits `event.shredded` on the Plan-022 shred-fan-out callback (after Path 3; records the Path-1 crypto-shred)
- `packages/runtime-daemon/src/events/compactor.ts` — audit-stub generator + compaction triggers; **enforces anchor-before-compaction protocol per Spec-006 §Post-Compaction Integrity (force-fires `MerkleAnchorService.anchorRange()` if the to-be-compacted range is not yet anchor-covered)**; emits `event.compacted`; uses `session_events.retention_class` discriminator per the audit-stub representation resolution
- `packages/runtime-daemon/src/events/merkle-anchor-service.ts` — anchor cadence + upload to shared `event_log_anchors`; durable partition queue via `pending_anchor_uploads` table per the partition-anchor queue resolution
- `packages/runtime-daemon/src/events/integrity-verifier.ts` — read-side chain/signature/anchor/stub-signature/scalar-binding verifier; emits `audit_integrity_verified` / `audit_integrity_failed` with the 11-value `failureMode` enum from Spec-006:472 (post amendment for the four `anchor_missing_for_compacted_range` / `anchor_signature_invalid` / `stub_signature_invalid` / `stub_scalar_mismatch` modes added by the post-compaction integrity protocol per Spec-006 §Post-Compaction Integrity)
- `packages/runtime-daemon/src/events/key-reuse-observer.ts` — observer-pattern Sigstore-precedent key-reuse detector; emits `key_reuse_detected` with `rotationInvariantViolated: 'refuse_on_rotation'` and halts ingest from the colliding signer's NodeId
- `packages/runtime-daemon/src/events/schema-migration-emitter.ts` — emits `schema.migrated` on Flyway-precedent `AFTER_MIGRATE_OPERATION_FINISH` batch boundary
- `packages/runtime-daemon/src/events/replay-service.ts` — `EventReadAfterCursor`, `EventReadWindow`, cursor state tracking compacted regions
- `packages/runtime-daemon/src/events/event-subscription.ts` — `EventSubscription` replay-then-live producer (consumes `LocalSubscriptionProducer<EventEnvelope>` from Plan-007 CP-007-4)
- `packages/control-plane/src/event-anchors/` (anchor-router.ts + anchor-store.ts) — shared `event_log_anchors` write path (metadata only per ADR-017); mounted on Plan-008-bootstrap `host.ts`
- `packages/client-sdk/src/eventClient.ts` — typed SDK methods + `EventSubscription` (registers `event.readAfterCursor`, `event.readWindow`, `event.subscribe` under Plan-007 namespace per CP-006-4)
- `apps/desktop/src/renderer/src/timeline/CompactedStubSegment.tsx` — narrow-scope audit-stub renderer (Plan-013 Non-Goal per §Non-Goals; full timeline UI deferred)

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

Plan-006 owns the **140-event type registry across 19 categories** per [Spec-006 §Event Type Summary](../specs/006-session-event-taxonomy-and-audit-log.md) — 140 per the 2026-07-02 Spec-006 B1 amendment (+10: `run.rolled_back`, four `driver_ask.*`, two `session.goal_*`, two `subagent.*`, `usage.rate_limit_update`; registrations + emitters land with the capability-enhancement campaign's bundles). The 19 categories: <!-- corpus:total-check column="Count" prose-total="event type registry" prose-total="event taxonomy registry" -->

| Category | Count | Emitter Plan |
| --- | --- | --- |
| `session_lifecycle` (session + channel/agent + repo/workspace/worktree) | 27 | [Plan-001](./001-shared-session-core.md) (7 `session.*`) + [Plan-016](./016-multi-agent-channels-and-orchestration.md) (7 `channel.*`/`agent.*` incl. `channel.unmuted`, Tier-6 audit D-016-12; +2 `session.goal_*` — the goal set/clear RPC surface, 2026-07-02 capability-enhancement campaign) + [Plan-009](./009-repo-attachment-and-workspace-binding.md) + [Plan-010](./010-worktree-lifecycle-and-execution-modes.md) (11 `repo.*`/`workspace.*`/`worktree.*`) |
| `membership_change` (invite/membership + presence) | 13 | [Plan-002](./002-invite-membership-and-presence.md) (incl. `membership.created`) |
| `channel_arbitration` | 3 | [Plan-016](./016-multi-agent-channels-and-orchestration.md) (incl. `orchestration.rejected`, Tier-6 audit D-016-11) |
| `run_lifecycle` | 10 | [Plan-004](./004-queue-steer-pause-resume.md) |
| `interactive_request` (queue + intervention + driver ask) | 15 | [Plan-004](./004-queue-steer-pause-resume.md) (5 queue + 6 intervention) + [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) (4 `driver_ask.*` via the campaign's driver-ask normalizer, wire-sourced from the Plan-005 driver — 2026-07-02; the registration task — payload schemas, category-map entries, union variants — lands with the campaign B13 plan-amendment, a named merge prerequisite before any emitter: Plan-012's current T1.1/CP-012-2 text predates it and covers only the seven `approval.*` rows) |
| `approval_flow` | 8 | [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) (7 `approval.*`) + [Plan-016](./016-multi-agent-channels-and-orchestration.md) (`moderation.review_flagged`, Tier-6 audit D-016-10) |
| `artifact_publication` | 6 | [Plan-014](./014-artifacts-files-and-attachments.md) |
| `assistant_output` | 2 | [Plan-005](./005-provider-driver-contract-and-capabilities.md) |
| `tool_activity` | 7 | [Plan-005](./005-provider-driver-contract-and-capabilities.md) (3 `tool.*` driver-normalized + 2 `subagent.*` — SubagentStart/SubagentStop lifecycle normalization, campaign B10, 2026-07-02) + [Plan-015](./015-persistence-recovery-and-replay.md) (idempotency-class `tool.replayed` / `tool.skipped_during_recovery`) |
| `cross_node_dispatch` | 13 | [Plan-027](./027-cross-node-dispatch-and-approval.md) implements [Spec-024](../specs/024-cross-node-dispatch-and-approval.md); see [Cross-Plan Dependency Graph §Spec-024 Implementation Plan](../architecture/cross-plan-dependencies.md#spec-024-implementation-plan) |
| `usage_telemetry` | 5 | [Plan-005](./005-provider-driver-contract-and-capabilities.md) (4 driver-sourced — the 2026-07-02 campaign maps the provider `rate_limits` kind onto `usage.rate_limit_update`) + [Plan-016](./016-multi-agent-channels-and-orchestration.md) (`usage.budget_warning` from the BudgetAccountant, Tier-6 audit A-016-6) |
| `onboarding_lifecycle` | 2 | [Plan-026](./026-first-run-onboarding.md) |
| `runtime_node_lifecycle` | 9 | [Plan-003](./003-runtime-node-attach.md) (7 `runtime_node.*`) + [Plan-015](./015-persistence-recovery-and-replay.md) (2 `session.clock_*`) |
| `recovery_events` | 3 | [Plan-015](./015-persistence-recovery-and-replay.md) |
| `participant_lifecycle` | 5 | [Plan-022](./022-data-retention-and-gdpr.md) |
| `audit_integrity` | 3 | **Plan-006** (verifier + observer) |
| `security_events` | 4 | [Plan-007](./007-local-ipc-and-daemon-control.md) (`security.default.override` Phase 1; `security.update.available` Tier 4) + [Plan-022](./022-data-retention-and-gdpr.md) (`daemon.master_key_source`, `daemon.pii_split_ambiguous`; registered in Spec-006 at the Tier-5 swap per D-022-5) |
| `event_maintenance` | 3 | **Plan-006** (compactor, schema-migration emitter, shred audit artifact) |
| `policy_events` | 2 | V1.1 Cedar runtime bundle loader — see V1/V1.1 note below |
| **Total** | **140** |  |

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
- Fields included (the canonical set — membership only; serialized order is mandated by RFC 8785 §3.2.3 UTF-16 code-unit lex-sort of member names, NOT the order listed here): `id`, `sessionId`, `sequence`, `occurredAt`, `category`, `type`, `actor`, `payload`, `correlationId`, `causationId`, `version`.
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

- **Plan-006 emits `event.shredded` (Spec-006 §Event Maintenance)** recording the Path-1 crypto-shred (SQLite `participant_keys` row DELETE) — but **emitted after Path 3 completes**, per the [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md#shred-fan-out) ordering, so the "shredded" marker never precedes the Path-3 diagnostic-bucket flush — carrying `{participantId, affectedSessionIds[], piiPayloadsCleared, shredReason}`. The event has no PII content and is retained indefinitely.
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

Plan-006 ships in **four phases**, each phase = one PR. The phase boundaries align with the audit-derived dispatch graph (see [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)).

**Phase 1 — Contracts** (T1.1 – T1.7). Widen `packages/contracts/src/event.ts` in place per Plan-001's contracts package layout: `EventCategory` literal union to 19 entries; enumerate all 140 `SessionEventType` literals; author the named `EventEnvelopeSchema`; bind `CapabilityDetails` typed wrapper for `runtime_node.capability_declared` / `runtime_node.capability_updated` payloads (closes Plan-005 CP-005-5); cross-link version-bound errors to Spec-006 + ADR-018; widen api-payload-contracts.md Plan-006 §EventEnvelope block from 16 to 19 categories; confirm envelope-to-`session_events`-column bijection.

**Phase 2 — Crypto Protocol Core** (T2.1 – T2.7). RFC 8785 JCS canonicalizer with UTF-16 lex-sort field ordering (Spec-006:597 amended in this PR to describe field membership and lex-sort serialization); BLAKE3 hash-chain + Ed25519 signer; golden-vector contract tests (RFC 8785 Appendix-A vectors + project-specific edge cases); PII indirection codec enforcing encrypt → digest → embed → canonicalize → sign sole-write-path; post-shred signature-verification property test; genesis-row backfill migration; **T2.7 — `DaemonSigningKeySource` interface + `OsKeystoreSealedDaemonSigningKeySource` implementation** (user-ratified 2026-05-28; self-contained signing-key custody using OS-keystore-managed master key + sealed BLOB persisted in the new local `daemon_signing_keys` SQLite table per ADR-004 SQLite-local-state boundary — corrected from the pre-Codex-T4-review draft that mis-located the column on shared-Postgres `sessions`).

**Phase 3 — Persistence + Maintenance** (T3.1 – T3.5). Append-path service writing the forward-declared integrity columns + Plan-022 Path 1 shred callback; compactor with three triggers (50K events / 90 days / 500MB) + audit-stub format + three-layer category-exclusion enforcement + new `session_events.retention_class` discriminator column (typed column over JSON-field probe); Merkle-anchor service with earlier-of-1000-events-or-300s cadence + new `pending_anchor_uploads` table for durable partition queue (Design A — SQLite table with `UNIQUE(session_id, node_id, start_sequence, end_sequence)`); schema-migration emitter on `AFTER_MIGRATE_OPERATION_FINISH` batch boundary with callback-seam primary path + reconcile-on-startup fallback (hybrid resolution); cross-task contract-test suite + end-to-end shred-safety regression (Plan-006:548 acceptance gate).

**Phase 4 — Read-Side + SDK + Desktop Stub** (T4.1 – T4.9). Three-check integrity verifier (chain → signature → anchor) plus per-row stub-signature and scalar-binding re-verification for compacted rows, emitting the full 11-value `failureMode` enum per Spec-006:472 (post-amendment for the post-compaction integrity protocol — `anchor_missing_for_compacted_range` + `anchor_signature_invalid` + `stub_signature_invalid` + `stub_scalar_mismatch` are additive-MINOR extensions per ADR-018 §Decision #8); `key-reuse-observer.ts` enforcing `refuse_on_rotation` Sigstore-precedent invariant and halting ingest from colliding NodeId; `replay-service.ts` for `EventReadAfterCursor` + `EventReadWindow` honoring `retentionClass: 'audit_stub'` for compacted regions; new `session_snapshots.{has_compacted_ranges, compacted_range_count}` columns (existing `as_of_sequence` already carries cursor-state semantics; only the compaction-incidence flags are added); `EventSubscription` replay-then-live stream consuming `LocalSubscriptionProducer<EventEnvelope>` with sequence-monotonicity gap-detection in the SDK; Zod replay-shape schemas mirrored from api-payload-contracts.md:825-852; client SDK `eventClient.ts` typed entry-points registered under Plan-007 namespace as `event.readAfterCursor` / `event.readWindow` / `event.subscribe` per CP-006-4; desktop `<CompactedStubSegment>` narrow-scope renderer (Plan-013 Non-Goal compliance); end-to-end integration tests.

The per-task `Provides` / `Depends` / `IdempotencyClass` / inline-cite block follows in §Tasks. Each task names its file path, exported symbols, intra-phase + cross-plan dependencies, idempotency classification per [Spec-015 §Idempotency Classes and Recovery Behavior](../specs/015-persistence-recovery-and-replay.md#idempotency-classes-and-recovery-behavior), and Spec-006 / ADR-018 cite anchors. The full audit-trail rationale for each ratification (drift class, options considered, hardened-mode recommendation) is surface-forwarded into this plan body + the [api-payload-contracts.md §Plan-006](../architecture/contracts/api-payload-contracts.md) doc-mirror per AGENTS.md Surface-Forward-Then-Delete; transient working artifacts under `.agents/tmp/research/plan-readiness-audit/plan-006/` are gitignored and deleted post-merge.

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

### Co-Tier Phase Ordering Precondition

Plan-005 and Plan-006 are co-tier (both Tier 4) in the cross-plan DAG. The Plan-006 Phase 1 contract surface **imports** types Plan-005 Phase 1 ships:

- `DriverCapabilityFlag` (literal union)
- `NormalizedProviderToolMetadata` (the post-`.default()` `z.output` of `ProviderToolMetadataSchema`; `CapabilityDetails.tools` imports the normalized shape because event payloads cross the persistence boundary)

Both are exported from `packages/contracts/src/provider-driver.ts` by Plan-005 Phase 1 (T1.1 – T1.4). Until that file lands on `develop`, Plan-006 Phase 1 T1.4 cannot compile. The ordering is therefore: **Plan-005 Phase 1 PR → Plan-006 Phase 1 PR**. PR authors MUST cite the Plan-005 Phase 1 merge commit in the Plan-006 Phase 1 PR description so the precondition is auditable. No reciprocal: Plan-005 Phase 1 has no Plan-006 import.

### Phase 1 — Contracts (`packages/contracts/src/event.ts` extension in place)

#### Tasks

##### T1.1 — Widen `EventCategory` enum to 19 canonical entries

File: `packages/contracts/src/event.ts` (EXTEND). Provides: `EventCategory` literal union with all 19 entries adding `channel_arbitration`, `onboarding_lifecycle`, `cross_node_dispatch` to the existing 16. Depends: existing 16-entry baseline at `event.ts:74-90` (Plan-001's contracts package). IdempotencyClass: N/A (type).

- **Spec coverage:** Spec-006 line 561 (channel_arbitration), Spec-006 line 571 (cross_node_dispatch), Spec-006 line 573 (onboarding_lifecycle)
- **Verifies invariant:** I-006-1-01 (category/type bijection — the 19-category union)

##### T1.2 — Enumerate 140 `SessionEventType` literals + category registry

File: `packages/contracts/src/event.ts` (EXTEND). Provides: `SessionEventType` literal union of all 140 strings; `SESSION_EVENT_CATEGORY_BY_TYPE: ReadonlyMap<SessionEventType, EventCategory>`; per-category const arrays (`SESSION_LIFECYCLE_EVENT_TYPES`, etc.). Depends: T1.1; existing 3-variant `SessionEvent` union; existing registry pattern at `event.ts:431`. IdempotencyClass: N/A (type/data).

- **Spec coverage:** Spec-006 line 551 (Event Type Summary), Spec-006 line 553 (Total enumerated event types), Spec-006 lines 557-581
- **Verifies invariant:** I-006-1-01 (140-type / 19-category bijection), I-006-1-02 (event-type-string immutability)

##### T1.3 — Author named `EventEnvelopeSchema` with canonical field set

File: `packages/contracts/src/event.ts` (EXTEND — refactor existing `buildCommonShape()` output to a named export). Provides: `EventEnvelopeSchema: z.ZodType<EventEnvelope>`; `EventEnvelope` inferred interface; JSDoc citing Spec-006:590-602 + ADR-018 §Decision #1/#2/#6 (the field SET is canonical; serialized order is mandated by RFC 8785 §3.2.3 UTF-16 lex-sort — see Spec-006:597 amendment). Depends: T1.1, T1.2, existing `EventEnvelopeVersionSchema` brand. IdempotencyClass: N/A (type).

- **Spec coverage:** Spec-006 line 597 (Fields included — the canonical set)
- **Verifies invariant:** I-006-1-03 (envelope field set fixed; RFC 8785 lex-sort serialization), I-006-1-04 (`EventEnvelope.version` immutability)

##### T1.4 — Bind `CapabilityDetails` + `RuntimeNodeCapability*Payload` interfaces

File: `packages/contracts/src/event.ts` (EXTEND; imports `DriverCapabilityFlag` + `NormalizedProviderToolMetadata` from `./provider-driver`). Provides: `CapabilityDetails = { flags: Record<DriverCapabilityFlag, boolean>; contractVersion: string; tools: readonly NormalizedProviderToolMetadata[] }` (`tools` is the normalized shape — `CapabilityDetails` is an event payload that crosses the persistence / event boundary); `RuntimeNodeCapabilityDeclaredPayload = { capability, capabilityDetails }`; `RuntimeNodeCapabilityUpdatedPayload = { capability, previousState, newState }`. Depends: **Plan-005 Phase 1 (T1.1–T1.4) MUST ship `packages/contracts/src/provider-driver.ts` exporting `DriverCapabilityFlag` + `NormalizedProviderToolMetadata` before this task can compile** — see §Co-Tier Phase Ordering Precondition above. IdempotencyClass: N/A (type).

- **Spec coverage:** Spec-006 line 412 (`runtime_node.capability_declared`), Spec-006 line 413 (`runtime_node.capability_updated`)
- **Verifies invariant:** none (type-only payload-wrapper binding; closes Plan-005 CP-005-5 — no Phase-1 invariant names T1.4)

##### T1.5 — Cross-link version-bound errors to Spec-006 + ADR-018 (JSDoc-only)

File: `packages/contracts/src/event.ts` (EXTEND JSDoc on `EventEnvelopeVersionSchema`); optional reciprocal cite in `docs/architecture/contracts/error-contracts.md:364-365`. Provides: JSDoc cross-link pointer; no new schemas (Plan-001 T2.3 already shipped `VersionFloorExceededErrorSchema` + `VersionCeilingExceededErrorSchema` per Phase 1 audit forward-completed surface). Depends: Plan-001 T2.3 shipped artifacts. IdempotencyClass: N/A (docs).

- **Spec coverage:** Spec-006 line 88 (`VERSION_FLOOR_EXCEEDED`)
- **Verifies invariant:** none (JSDoc-only cross-link; no Phase-1 invariant covers the FLOOR/CEILING version errors)

##### T1.6 — Widen api-payload-contracts.md Plan-006 §EventEnvelope block to 19 categories

File: `docs/architecture/contracts/api-payload-contracts.md` (EDIT Plan-006 §EventEnvelope block, ~line 705-723). Provides: Updated `EventCategory` doc-mirror to 19 entries + comment "16 categories total" → "19 categories total per Spec-006 §Event Type Summary (140 event types — 140 per the 2026-07-02 Spec-006 B1 amendment; was 130 pre-B1)". Already applied in this audit PR. Depends: T1.1. IdempotencyClass: N/A (docs).

- **Spec coverage:** Spec-006 line 551 (Event Type Summary), Spec-006 lines 555-582
- **Verifies invariant:** none (doc-mirror widening of api-payload-contracts.md; no Phase-1 invariant names T1.6)

##### T1.7 — Confirm envelope ↔ `session_events` column bijection

File: None (verification + JSDoc anchor). Provides: Type-level assertion that every required `EventEnvelope` field maps to a column on `session_events`; phase boundary clarification (Phase 1 does not author integrity-column population — that lands in Phase 2). Depends: Plan-001 forward-declared columns per cross-plan-deps.md:25. IdempotencyClass: N/A (verification).

- **Spec coverage:** Spec-006 line 597 (Fields included — the canonical set), local-sqlite-schema.md `session_events`
- **Verifies invariant:** none (type-level bijection verification; no Phase-1 invariant names T1.7)

### Phase 2 — Crypto Protocol Core (`packages/runtime-daemon/src/events/`)

#### Tasks

##### T2.1 — RFC 8785 JCS canonicalizer

File: `packages/runtime-daemon/src/events/canonicalizer.ts` (NEW). Provides: `canonicalizeEvent(envelope: EventEnvelope): CanonicalBytes` returning phantom-branded `Uint8Array` constructible only inside this module; `canonicalizeJson(value: unknown): CanonicalBytes` for Spec-024 `request_body_hash` reuse per CP-006-3. Depends: `EventEnvelope` + `EventEnvelopeVersion` (T1.3); pinned JCS library (`canonicalize@3.0.0` — Erdtman's RFC 8785 reference implementation, Apache-2.0, zero-deps, bundled TS types; **exact-pinned**, not a caret range: the canonical bytes feed every event `row_hash` + `daemon_signature`, so the canonicalizer version is locked and the T2.3 golden-vector suite binds its output to RFC 8785 §A — a silent minor bump must never change canonical bytes). IdempotencyClass: `idempotent`.

- **Spec coverage:** Spec-006 line 594 (RFC 8785), Spec-006 line 597 (Fields included — the canonical set), Spec-006 line 599 (occurredAt), Spec-006 line 600 (pii_ciphertext_digest)
- **Verifies invariant:** none (canonicalizer library task; byte-stability is verified by T2.3 under I-006-2-03 and single-use by signRow under I-006-2-06, which name those tasks not this one)

##### T2.2 — BLAKE3 hash-chain + Ed25519 signer

File: `packages/runtime-daemon/src/events/signer.ts` (NEW). Provides: `signRow(canonical: CanonicalBytes, prevHash: Uint8Array, signingKey: Ed25519PrivateKey): SignedRow`; `verifyRow(...)` for read-side; `GENESIS_PREV_HASH` (32 zero bytes). Depends: T2.1; `@noble/hashes/blake3.js` + `@noble/curves/ed25519.js` (already pinned in crypto-paseto); T2.7 daemon signing-key source. IdempotencyClass: `idempotent` (RFC 8032 Ed25519 determinism).

- **Spec coverage:** Spec-006 line 586 (chained to its predecessor), Spec-006 line 602 (row_hash)
- **Verifies invariant:** I-006-2-06 (one canonicalization per row — signRow takes CanonicalBytes once for both BLAKE3 input and Ed25519 message)

##### T2.3 — Golden-vector tests for canonicalizer

File: `packages/runtime-daemon/src/events/__tests__/canonicalizer.golden.test.ts` (NEW). Provides: Vitest suite asserting byte-stable output across field-order drift, null-vs-undefined, clock-tick boundaries, nested-payload lex-sort, numeric edge cases per ECMA-262 ToString, `version: "1.0"` literal, RFC 8785 Appendix-A vectors. Inline hex fixtures (matches crypto-paseto convention). Depends: T2.1, T2.2. IdempotencyClass: N/A (test).

- **Spec coverage:** Spec-006 line 592 (same canonical form), Spec-006 line 594 (RFC 8785), Spec-006 line 597 (Fields included — the canonical set), Spec-006 line 598 (present-but-null), Spec-006 line 599 (occurredAt)
- **Verifies invariant:** I-006-1-03 (envelope field set fixed; RFC 8785 lex-sort serialization), I-006-2-03 (canonical bytes byte-stable across implementations)

##### T2.4 — PII indirection codec (sole write path)

File: `packages/runtime-daemon/src/events/pii-indirection.ts` (NEW). Provides: `writeEventWithPii(input: RawEventInput, db, encryptor, signingKey): Promise<SignedRow>` as the one-and-only path writing non-null `pii_payload`; branded `PiiPayloadCiphertext` constructible only here; `PiiEncryptor` interface (implementation owned by Plan-022 per CP-006-1). Depends: T2.1, T2.2; `splitPii()` shape from Plan-022 working copy (interface only; runtime injection at composition root). IdempotencyClass: `manual_reconcile_only` per AES-256-GCM random-nonce non-replay-safety (NIST SP 800-38D §8.2).

- **Spec coverage:** Spec-006 line 600 (pii_ciphertext_digest)
- **Verifies invariant:** I-006-2-01 (encrypt→digest→embed→canonicalize→sign order is load-bearing — the per-stage phantom brands this codec emits), I-006-2-02 (sole write path for pii_payload), I-006-2-07 (`RawEventInput` discriminated union types `pii_payload: never` for `audit_integrity` / `event_maintenance` — the compile-time counterpart to I-006-3-01's runtime refusal), I-006-3-01 (layer 2 — pii-indirection.ts refuses audit_integrity / event_maintenance)

##### T2.5 — Post-shred signature-verification property test

File: `packages/runtime-daemon/src/events/__tests__/post-shred-verify.test.ts` (NEW). Provides: Vitest property suite asserting `writeEventWithPii(...)` produces canonical bytes including `pii_ciphertext_digest`; after `pii_payload = NULL` (Path 1), `daemon_signature` still verifies; tampering any envelope field post-shred → verification fails. Depends: T2.4. IdempotencyClass: N/A (test).

- **Spec coverage:** Spec-006 line 600 (pii_ciphertext_digest)
- **Verifies invariant:** I-006-2-01 (encrypt→digest→embed→canonicalize→sign order; post-shred signature still verifies), I-006-2-05 (signed bytes commit to pii_ciphertext_digest, not raw ciphertext)

##### T2.6 — Genesis-row backfill migration

File: `packages/runtime-daemon/src/migrations/0NNN-genesis-chain-backfill.ts` (NEW; NNN at PR time). Provides: Migration walking placeholder rows (32-byte zero buffers from Plan-001 T2.3) in `sequence` order; computes `row_hash = BLAKE3(prevHash || canonical_bytes)` + `daemon_signature` for each; detect-real-signature skip on re-run. Depends: T2.1, T2.2, CP-006-2 (Plan-001 placeholder convention). IdempotencyClass: `idempotent` (detect-real-signature skip on re-run).

- **Spec coverage:** Spec-006 line 586 (chained to its predecessor), security-architecture.md §Audit Log Integrity (sequence=0 prev_hash = 32 zero bytes — line 372; Spec-006:586 delegates the genesis-seed value to this doc)
- **Verifies invariant:** I-006-2-04 (genesis prev_hash = 32 zero bytes; subsequent prev_hash[n] = row_hash[n-1])

##### T2.7 — DaemonSigningKeySource interface + OsKeystore-sealed implementation + `daemon_signing_keys` SQLite table

File: `packages/runtime-daemon/src/events/signing-key-source.ts` (NEW). Provides: `DaemonSigningKeySource` interface (`create(sessionId): Promise<{publicKey: Ed25519PublicKey}>` — returns the PUBLIC key ONLY so daemon-private signing material never crosses the Plan-006/Plan-002 boundary; the freshly generated private key is sealed in-place and is reachable solely through the signer-local `read(sessionId): Promise<Ed25519PrivateKey>` path); `OsKeystoreSealedDaemonSigningKeySource` implementation generating fresh per-session Ed25519 keypair, sealing the private key via OS-keystore-managed master key (`@napi-rs/keyring` v1.2.0 per [Spec-022 §Daemon Master Key :146](../specs/022-data-retention-and-gdpr.md) — Keychain `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` on macOS / `CRED_TYPE_GENERIC` `CRED_PERSIST_LOCAL_MACHINE` on Windows / Secret Service via libsecret + kwallet6 + keyutils fallback on Linux; supersedes prior `keytar` reference — keytar is unmaintained), **storing ciphertext in the new local `daemon_signing_keys` SQLite table (`session_id` TEXT PK, `public_key` BLOB NOT NULL, `sealed_private_key` BLOB NOT NULL, `created_at` TEXT NOT NULL, `rotated_at` TEXT nullable)** per ADR-004 SQLite-local-state boundary — daemon-private secrets are per-machine and MUST NOT live in shared-Postgres `sessions` (corrected post-Codex T4 review on PR #124; the canonical schema doc-mirror at [local-sqlite-schema.md §Audit Log Crypto Tables](../architecture/schemas/local-sqlite-schema.md#audit-log-crypto-tables-plan-006) is the source of truth); new additive migration `0NNN-daemon-signing-keys.ts` creates the table. Depends: T2.1, T2.2 (consumer); Plan-002 amendment-via-extension adds session-create call-site + roster public-key registration per CP-006-7. IdempotencyClass: `manual_reconcile_only` per per-session key generation non-replay-safety.

- **Spec coverage:** Spec-022 line 146 (@napi-rs/keyring), ADR-004 §Decision (SQLite-local-state boundary)
- **Verifies invariant:** none (key-custody / keystore-sealing task; daemon signing-key production + OS-keystore sealing are governed by Spec-022 §Daemon Master Key and ADR-004, outside Plan-006 §Invariants)

### Phase 3 — Persistence + Maintenance (`packages/runtime-daemon/src/events/`)

#### Tasks

##### T3.1 — Append-path service writing integrity columns + Plan-022 Path 1 shred callback

File: `packages/runtime-daemon/src/events/event-log-service.ts` (NEW). Provides: `EventLogService.append(envelope, options): Promise<{id, sequence, rowHash}>` as the sole append path under per-session mutex; `registerShredCallback(handler: ShredCallback): void` invoked by Plan-022's Path 1 orchestrator after `participant_keys` DELETE commits; refuses any `append()` whose `payload` carries a PII-tagged field without `pii_ciphertext_digest` (surfaces `daemon.pii_split_bypass` typed error). Depends: T2.1, T2.2, T2.4, T2.7; Plan-001 forward-declared columns; Plan-001 `I-001-2` (sequence as canonical replay key). IdempotencyClass: `manual_reconcile_only` per chain-append non-retry-safety.

- **Spec coverage:** Spec-006 line 586 (chained to its predecessor), Spec-006 line 760 (sequence numbers), Spec-006 line 600 (pii_ciphertext_digest), Spec-006 line 520 (event.shredded), Spec-006 line 498 (daemon.pii_split_bypass typed error — characterized at the daemon.pii_split_ambiguous row as an append-without-pii_ciphertext_digest hard rejection, distinct from that taxonomy event)
- **Verifies invariant:** none (append-path service; the write-path and PII-split invariants name Phase 2 pii-indirection.ts, not this task)

##### T3.2 — Compactor with three triggers + anchor-before-compaction protocol + audit-stub format + `retention_class` discriminator (Design B — typed column)

File: `packages/runtime-daemon/src/events/compactor.ts` (NEW). Provides: `Compactor.tick(): Promise<CompactionPassResult>` invoked by daemon idle scheduler; SQL selector excluding `category IN ('audit_integrity', 'event_maintenance')` (layer 1 of three-layer enforcement); **anchor-before-compaction enforcement per [Spec-006 §Post-Compaction Integrity](../specs/006-session-event-taxonomy-and-audit-log.md#post-compaction-integrity) — before mutating any row in the to-be-compacted range, verify a covering Merkle anchor exists in `pending_anchor_uploads` or `event_log_anchors`; if absent, force-fire via T3.3 `MerkleAnchorService.anchorRange({sessionId, fromSeq, toSeq})` and wait for durable queue insertion before proceeding (refuses to compact if force-fire fails)**; **per-row stub commitment — for each row, build the audit-stub projection (Spec-006 §Compacted Event Format), serialize it once to its canonical byte string `B = canonical_bytes(stub)`, compute `stub_signature = Ed25519(B)` with the daemon signing key, then store that **same** `B` verbatim in `payload` (sign-exact-bytes invariant — no re-serialization between signing and storing, so the verifier checks `stub_signature` directly over the stored `payload` bytes; canonical bytes bind `id`+`sequence`, so the signature is non-replayable across rows)**; audit-stub UPDATE that **REPLACES** `payload` with that canonical byte string `B` (the JCS-canonicalized audit-stub projection) (the column is `NOT NULL` — it is rewritten, NOT nulled — so replay/renderer can still surface the visible stub per Spec-006 §Replay Interaction), NULLs `correlation_id`/`causation_id`/`pii_payload`, sets `retention_class = 'audit_stub'`, and writes `stub_signature`, but NEVER mutates `prev_hash`/`row_hash`/`daemon_signature`/`participant_signature`/`monotonic_ns`/`version` (I-006-3-03); `event.compacted` envelope per Spec-006 §Event Maintenance; **new additive migration `0NNN-retention-class-and-stub-signature.ts` adds `session_events.retention_class TEXT CHECK (retention_class IS NULL OR retention_class = 'audit_stub')` (typed discriminator over JSON-field probe; the column-level CHECK closes the discriminator domain and is ALTER-ADD-COLUMN-addable — it references only the new column and permits NULL, so pre-migration rows pass) + `session_events.stub_signature BLOB` (per-row post-compaction commitment, NULL for live rows) columns. The co-presence invariant (`retention_class = 'audit_stub'` ⟺ non-NULL `stub_signature`) is a two-column constraint that ALTER cannot add as a table-level CHECK without a 12-step rebuild of the append-only audit log; it is enforced at the verification layer instead (T4.1 — NULL `stub_signature` on an `audit_stub` row → `stub_signature_invalid`).** Depends: T3.1 (event.compacted emission); T3.3 (`MerkleAnchorService.anchorRange()` API extension for force-fire); T2.7 daemon signing key (consumer — `stub_signature` minting); Phase 1 contracts. IdempotencyClass: `compensable` per mid-pass replay-safety (re-entry skips already-stubbed rows via `retention_class IS NULL`; anchor force-fire is idempotent per T3.3 `UNIQUE(session_id, node_id, start_sequence, end_sequence)`).

- **Spec coverage:** Spec-006 lines 637-639, Spec-006 line 675 (audit-stub projection), Spec-006 line 681 (Anchor-before-compaction protocol), Spec-006 line 519 (event.compacted), Spec-006 line 463 (never compacted), Spec-006 line 510 (never compacted)
- **Verifies invariant:** I-006-3-01 (three-layer non-compaction / non-shred enforcement — layer 1 SQL selector), I-006-3-03 (compaction anchor-before-stub and chain-commitment-frozen)

##### T3.3 — Merkle-anchor service with earlier-of-1000-or-300s cadence + durable partition queue (Design A — SQLite-backed queue) + force-fire anchor-range API

Files: `packages/runtime-daemon/src/events/merkle-anchor-service.ts` (NEW); `packages/contracts/src/event-anchor.ts` (NEW Plan-006-owned); `packages/control-plane/src/event-anchors/anchor-router.ts` + `anchor-store.ts` (NEW). Provides: `MerkleAnchorService.onEventAppended({sessionId, sequence, rowHash}): Promise<void>` cadence-driven hook; `MerkleAnchorService.anchorRange({sessionId, fromSeq, toSeq}): Promise<AnchorPayload>` force-fire entry-point consumed by T3.2 compactor's anchor-before-compaction protocol per Spec-006 §Post-Compaction Integrity — synchronously computes the Merkle root over `[fromSeq, toSeq]`, signs with the daemon Ed25519 key, durably inserts into `pending_anchor_uploads`, and returns once the row is queued (does NOT await control-plane upload — local queue's durable monotonic ordering + daemon signature is sufficient for anchor-before-stub gating); `AnchorPayload` type bound to the seven `event_log_anchors` columns (no `payload` field; structurally enforces ADR-017 metadata-only constraint per I-006-3-02); BLAKE3 binary Merkle tree with RFC-9162 §2.1 odd-leaf duplication; **new additive migration `0NNN-pending-anchor-uploads.ts` adds a durable partition queue table with `UNIQUE(session_id, node_id, start_sequence, end_sequence)` so unflushed anchors survive daemon restart without re-signing per Plan-006:152 AND so `anchorRange()` force-fire is idempotent against re-entry after crash.** Depends: T3.1 hook; T2.2 signer (Ed25519 over merkle root); Plan-006 `event_log_anchors` shipped via shared-postgres-schema.md:400-417; Plan-008-bootstrap `host.ts` for router mount per CP-006-2. IdempotencyClass: `idempotent` (Postgres `ON CONFLICT DO NOTHING`; no re-signing on retry per Plan-006:152; `anchorRange()` is doubly idempotent — its coverage pre-check (`∃ anchor: start_sequence ≤ fromSeq AND end_sequence ≥ toSeq`) short-circuits a force-fire when a wider anchor already covers the range, and the `UNIQUE(session_id, node_id, start_sequence, end_sequence)` key makes a genuine re-fire of the **same** `[fromSeq, toSeq]` return the queued row without re-signing — distinct ranges sharing a `start_sequence` are NOT collapsed).

- **Spec coverage:** Spec-006 line 606 (ANCHOR_INTERVAL_EVENTS), Spec-006 line 684 (force-fire), Spec-006 line 685 (pending_anchor_uploads)
- **Verifies invariant:** I-006-3-02 (event_log_anchors upload is metadata-only at the type level — AnchorPayload has no payload field)

##### T3.4 — Schema-migration emitter on `AFTER_MIGRATE_OPERATION_FINISH` batch boundary (hybrid callback + reconcile design)

File: `packages/runtime-daemon/src/events/schema-migration-emitter.ts` (NEW); Plan-006 contract addition: `SchemaMigratedPayload` shape with `{fromVersion, toVersion, migrationId, description, checksum, appliedBy, executionMs, success}`. Provides: `SchemaMigrationEmitter.emitBatchCompletion(batch: MigrationBatchResult): Promise<void>` invoked via callback seam on the migration runner (primary path) OR via reconcile-on-startup `MAX(sequence) WHERE type = 'schema.migrated'` gap fill (fallback). BLAKE3 `checksum` over concatenated migration file contents defends against silent migration-file divergence. Depends: T3.1; Plan-001 `schema_version` table (Plan-001 owns; Plan-006 reads). IdempotencyClass: `manual_reconcile_only` per crash-between-commit-and-emit reconcile semantics.

- **Spec coverage:** Spec-006 line 518 (schema.migrated)
- **Verifies invariant:** none (schema-migration emitter; no Plan-006 §Invariant references this task)

##### T3.5 — Phase 3 contract-test suite + end-to-end shred-safety regression (Plan-006:548 acceptance gate)

Files: Five `__tests__/` files spanning T3.1-T3.4 + shred-safety E2E. Provides: Genesis-and-multi-row chain integrity test; trigger tests for each of the three compaction thresholds; cadence test for the earlier-of rule with the `AnchorPayload` no-`payload`-field TypeScript structural assertion; batch-boundary granularity (1 batch → 1 event) + rollback path + reconcile-on-startup; **E2E: 60+ events with non-null `pii_payload` → compaction pass → Plan-022 Path 1 crypto-shred via `participant_keys` DELETE → `event.shredded` callback → integrity verifier reruns over full chain → all signatures verify, all chain hashes verify, `<pii-shredded>` markers replace PII fields on read.** Depends: T3.1-T3.4; Phase 2; Plan-022's `splitPii()` (mock via fixture if Plan-022 implementation hasn't landed). IdempotencyClass: N/A (test).

- **Spec coverage:** Spec-006 line 520 (event.shredded), Spec-006 line 600 (pii_ciphertext_digest), Spec-006 lines 637-639, Spec-006 line 606 (ANCHOR_INTERVAL_EVENTS), Spec-006 line 602 (row_hash), Spec-006 line 518 (schema.migrated)
- **Verifies invariant:** I-006-3-01 (three-layer enforcement — E2E exercises all three layers), I-006-3-02 (AnchorPayload no-payload-field assertion), I-006-3-04 (anchor cadence earlier-of both thresholds)

### Phase 4 — Read-Side + SDK + Desktop Stub

#### Tasks

##### T4.1 — `integrity-verifier.ts` three-check verifier + full 11-value `failureMode` enum + anchor + stub-signature + scalar-binding compacted-row verification

Files: `packages/runtime-daemon/src/events/integrity-verifier.ts` (NEW) + test. Provides: `verifyRange(params): Promise<VerifyResult>` returning `{kind: 'verified' | 'failed', ...}` with the 11-value `failureMode` enum (`'hash_mismatch' | 'signature_mismatch' | 'anchor_mismatch' | 'inclusion_proof_failed' | 'consistency_proof_failed' | 'log_file_missing' | 'log_file_moved' | 'anchor_missing_for_compacted_range' | 'anchor_signature_invalid' | 'stub_signature_invalid' | 'stub_scalar_mismatch'`) verbatim from Spec-006:472 (post-amendment — the four `anchor_missing_for_compacted_range` / `anchor_signature_invalid` / `stub_signature_invalid` / `stub_scalar_mismatch` modes are additive-MINOR extensions per ADR-018 §Decision #8 sanctioning the post-compaction integrity protocol); `VerifierFailureModeSchema` + `VerifierFailurePathSchema` (`'inclusion' | 'consistency' | 'signature'`) Zod schemas; appends `audit_integrity_verified` OR `audit_integrity_failed` per pass (I-006-4-01 exactly-one). **Compacted-row handling per Spec-006 §Post-Compaction Integrity: for any row with `retention_class = 'audit_stub'`, run THREE checks (all must pass): (a) skip per-row chain recomputation against the original (canonical bytes unrecoverable) and instead verify a covering Merkle anchor exists in `pending_anchor_uploads` or `event_log_anchors` AND its daemon Ed25519 `root_signature` verifies — anchor-missing → `failureMode: 'anchor_missing_for_compacted_range'`, anchor-signature-invalid → `failureMode: 'anchor_signature_invalid'`; (b) verify `stub_signature` directly over the canonical byte string stored in `payload` (the exact bytes the compactor signed — not re-canonicalized, not reconstructed from scalar columns) using the `NodeId`-resolved daemon Ed25519 public key — tampered/replayed/missing `stub_signature` → `failureMode: 'stub_signature_invalid'` (the signature is REQUIRED on every `audit_stub` row; absence is a failure, never a skip); (c) decode the audit-stub projection from the just-verified `payload` bytes and assert each surviving scalar column (`id`, `session_id`, `sequence`, `occurred_at`, `category`, `type`, `actor`) byte-equals its projection counterpart (`occurred_at` ↔ `occurredAt`, `session_id` ↔ `sessionId`, …; `compactedAt`/`summary` have no scalar column) — any divergence → `failureMode: 'stub_scalar_mismatch'` (closes the forge-a-scalar-column gap where `stub_signature` over `payload` and the anchor over the frozen `row_hash` both still verify but a filter/reconstruction reads the tampered scalar). Mixed ranges (some uncompacted, some `audit_stub`) are split-verified: chain-recompute the uncompacted prefix + run all three compacted-row checks on the compacted suffix; all must pass.** Depends: Phase 1 contracts; Phase 2 canonicalizer + signer; Plan-001 `session_events` table; Plan-006 P3 `event_log_anchors` + `pending_anchor_uploads`. IdempotencyClass: `compensable` per per-pass new-row append (consumers dedupe on `(verifierNodeId, fromSeq, toSeq)`).

- **Spec coverage:** Spec-006 line 471 (audit_integrity_verified), Spec-006 line 472 (audit_integrity_failed), Spec-006 line 693 (anchor_missing_for_compacted_range), Spec-006 line 694 (stub_signature), Spec-006 line 695 (stub_scalar_mismatch), Spec-006 line 697 (mixed ranges)
- **Verifies invariant:** I-006-3-03 (compaction anchor-before-stub + chain-commitment-frozen; three-check verifier), I-006-4-01 (verifyRange emits exactly one verified / failed per range), I-006-4-02 (verifier rows are themselves chain-and-signature-protected)

##### T4.2 — `key-reuse-observer.ts` enforcing `refuse_on_rotation`

Files: `packages/runtime-daemon/src/events/key-reuse-observer.ts` (NEW) + test. Provides: `KeyReuseObserver` class with `start(sessionId)` / `stop(sessionId)` / `getDetectedReuse()`; emits `key_reuse_detected` with `rotationInvariantViolated: 'refuse_on_rotation'` verbatim (Spec-006:473); HALTS ingest of further events from the colliding signer's `NodeId` (I-006-4-03). Depends: Phase 1 `EventEnvelope` + `NodeId`; Phase 2 Ed25519 fingerprint; Plan-007 `LocalSubscriptionConsumer<EventEnvelope>`; Plan-001 participant-roster snapshot. IdempotencyClass: `compensable` per dedupe-by-`(offendingKeyFingerprint, detectorNodeId)`.

- **Spec coverage:** Spec-006 line 473 (key_reuse_detected)
- **Verifies invariant:** I-006-4-03 (refuse_on_rotation — halts ingest from the colliding signer's NodeId)

##### T4.3 — `replay-service.ts` for `EventReadAfterCursor` + `EventReadWindow`

Files: `packages/runtime-daemon/src/events/replay-service.ts` (NEW) + test. Provides: `readAfterCursor(params): Promise<EventReadAfterCursorResponse>` returning `{events, nextCursor, hasMore}`; `readWindow(params): Promise<EventReadWindowResponse>` bounded by `[fromSequence, toSequence]`; events from compacted regions returned as audit-stub envelopes with `payload.retentionClass === 'audit_stub'` (I-006-4-04 — never silent omission). Depends: T4.6 Zod schemas; Phase 1 contracts; Phase 3 T3.2 compactor format; Plan-001 daemon-migration substrate; ADR-018 §Decision #6 + #9 (upcaster chain on read; unknown-MAJOR accept-and-stub). IdempotencyClass: `idempotent` (pure read).

- **Spec coverage:** Spec-006 line 71 (EventReadAfterCursor), Spec-006 line 72 (EventReadWindow), Spec-006 line 65 (audit-visible stub)
- **Verifies invariant:** I-006-4-04 (replay across compacted regions returns audit stubs, never silent omission)

##### T4.4 — `session_snapshots` extension with compacted-region cursor state (Reading (a) — additive flag columns only)

Files: `packages/runtime-daemon/src/migrations/0NNN-session-snapshots-compaction-cursor.ts` (NEW) + doc-mirror amendment to local-sqlite-schema.md. Provides: Two additive columns `has_compacted_ranges BOOLEAN NOT NULL DEFAULT 0` + `compacted_range_count INTEGER NOT NULL DEFAULT 0`. Existing `as_of_sequence` already satisfies the "replay-cursor state" clause of Plan-006:69; only the compaction-incidence flags are NEW. Depends: Plan-001 migration runner; existing `session_snapshots` table (Plan-001-owned, Plan-006 extends per local-sqlite-schema.md:62). IdempotencyClass: `idempotent` (migration).

- **Spec coverage:** Spec-006 line 715 (replay cursor tracks)
- **Verifies invariant:** none (Plan-006-owned additive migration adding session_snapshots compaction-incidence flags; no I-006 invariant names this task)

##### T4.5 — `EventSubscription` SSE/JSON-RPC notification stream

Files: `packages/runtime-daemon/src/events/event-subscription.ts` (NEW) + test + IPC handler. Provides: `subscribe(params: EventSubscriptionRequest): LocalSubscriptionProducer<EventEnvelope>` returning daemon-side producer; streams in two halves (replay from `afterCursor` then live append); monotonic cursor handoff at boundary (I-006-4-05); backpressure model verified at design-review against Plan-007 CP-007-4 `LocalSubscriptionProducer<T>` contract (pre-dispatch verification clause). Depends: T4.3; Phase 1; Plan-007 IPC substrate; Plan-008-bootstrap SSE substrate. IdempotencyClass: `idempotent` per open-call (append-only log).

- **Spec coverage:** Spec-006 line 73 (EventSubscription), Spec-006 line 59 (monotonically increasing sequence)
- **Verifies invariant:** I-006-4-05 (EventSubscription replay-then-live cursor handoff is monotonic — no duplicate or gap at boundary)

##### T4.6 — Zod replay-shape schemas

File: `packages/contracts/src/event.ts` (EXTEND with replay-shape Zod schemas; co-located per Plan-001's contracts package layout rather than a separate `replay-shapes.ts`). Provides: `EventReadAfterCursorRequestSchema` + `Response`; `EventReadWindowRequestSchema` + `Response`; `EventSubscriptionRequestSchema`; all `z.infer<>` typed exports. Mirrors api-payload-contracts.md:825-852 verbatim. Depends: Phase 1 contracts (`EventEnvelope`, `EventCursor`, `SessionId`). IdempotencyClass: N/A (type).

- **Spec coverage:** Spec-006 line 71 (EventReadAfterCursor), Spec-006 line 72 (EventReadWindow), Spec-006 line 73 (EventSubscription)
- **Verifies invariant:** I-006-4-06 (Zod-validated wire envelopes at the SDK seam — malformed responses rejected)

##### T4.7 — Client SDK `eventClient.ts` typed entry points

Files: `packages/client-sdk/src/eventClient.ts` (NEW) + test; `packages/client-sdk/src/index.ts` (EXTEND). Provides: `EventClient` interface (`readAfterCursor`, `readWindow`, `subscribe`); `createDaemonEventClient(client: JsonRpcClient): EventClient` factory (daemon-only per ADR-017 — no control-plane variant since event reads go through daemon IPC, not control-plane endpoints). Sequence-monotonicity gap-detection on `subscribe` per the live-stream gap-detection resolution. Depends: T4.6 Zod schemas; Plan-007 transport substrate. IdempotencyClass: SDK wrapper inherits transport semantics.

- **Spec coverage:** Spec-006 line 71 (EventReadAfterCursor), Spec-006 line 72 (EventReadWindow), Spec-006 line 73 (EventSubscription), Spec-006 line 64 (live-stream gap)
- **Verifies invariant:** I-006-4-06 (Zod-validated wire envelopes at the SDK seam; sequence-monotonicity gap-detection)

##### T4.8 — Desktop `<CompactedStubSegment>` narrow-scope renderer

Files: `apps/desktop/src/renderer/src/timeline/CompactedStubSegment.tsx` (NEW) + test. Provides: React component consuming `EventEnvelope` carrying audit-stub payload `{id, sessionId, sequence, occurredAt, category, type, actor, compactedAt, retentionClass: 'audit_stub', summary}` per Spec-006:656-673; single-line summary render + dimmed/badged visual distinction from live events; **NEVER renders null or empty** (I-006-4-07: audit stubs are always visibly present). Depends: T4.7 `EventClient`; Phase 1; Phase 3 T3.2 audit-stub format; existing renderer substrate (Plan-002 P5/P6 bridge pattern). IdempotencyClass: N/A (UI).

- **Spec coverage:** Spec-006 line 718 (retentionClass), Spec-006 lines 656-673, Spec-006 line 675 (never a silent omission)
- **Verifies invariant:** I-006-4-07 (audit stubs render as visible summarized segments — never null or empty)

##### T4.9 — Wire client SDK Zod parse + desktop integration E2E

Files: `packages/client-sdk/src/eventClient.integration.test.ts` + `apps/desktop/src/renderer/src/timeline/CompactedStubSegment.integration.test.tsx` (NEW). Provides: Integration test driving `eventClient.readAfterCursor` against a fixture log with compacted ranges; assert SDK does NOT throw or silently omit audit-stub rows; renderer integration test feeding SDK-parsed envelope into `<CompactedStubSegment>` and asserting visible DOM segment with summary text + "compacted" indicator. Depends: T4.1, T4.3, T4.5, T4.6, T4.7, T4.8. IdempotencyClass: N/A (test).

- **Spec coverage:** Spec-006 line 65 (audit-visible stub), Spec-006 line 718 (retentionClass)
- **Verifies invariant:** I-006-4-07 (audit stubs render as visible segments; empty summary still produces a visible segment)

## Open Authoring Decisions (Category 2 — Audit-Surfaced)

These are decisions the spec or prior plan iterations did not settle, surfaced by the 2026-05-28 Plan-006 audit. Load-bearing decisions are ratified inline; all others are resolved in-PR with hardened-mode defaults.

- **Event contracts directory placement.** Resolved: Extend `packages/contracts/src/event.ts` top-level per Plan-001's contracts package layout (extend the canonical file; do not fork a sibling). The `events/` subdirectory referenced by prior plan iterations does not exist; no other plan adopts a subdirectory pattern.
- **RFC 8785 lex-sort vs Spec-006:597 listed order.** Resolved: RFC 8785 §3.2.3 UTF-16 code-unit lex-sort is non-negotiable (the canonical-bytes invariant depends on it). Spec-006:597 lists field MEMBERSHIP, not serialized order — amended in this audit PR ("Fields included (the canonical set; serialized order is mandated by RFC 8785 §3.2.3 UTF-16 code-unit lex-sort of member names, not the order listed here)"). T2.3 golden vectors assert the lex-sorted output as ground truth.
- **Daemon Ed25519 signing-key custody.** Resolved (user-ratified 2026-05-28): Plan-006 T2.7 self-contains. Phase 2 ships `DaemonSigningKeySource` interface + `OsKeystoreSealedDaemonSigningKeySource` implementation; per-session Ed25519 sealed via OS-keystore master key (`@napi-rs/keyring` v1.2.0 per [Spec-022:146](../specs/022-data-retention-and-gdpr.md) — Keychain/libsecret/DPAPI; supersedes prior `keytar` reference); stored as ciphertext in new local `daemon_signing_keys` SQLite table per ADR-004 SQLite-local-state boundary (post-Codex-T4-review redesign 2026-05-28; supersedes the pre-review draft that mis-located the column on shared-Postgres `sessions`). Plan-002 amendment-via-extension adds session-create call-site + roster public-key registration per CP-006-7. No Plan-022 (Tier 5) dependency → no tier inversion.
- **JCS library: vendor vs in-house.** Resolved: Vendor — `canonicalize` package (Erdtman's RFC 8785 reference implementation; ships with the RFC). T2.3 lifts RFC 8785 Appendix-A vectors verbatim as a sub-suite to catch version-drift bugs. In-house implementation rejected per ECMA-262 ToString edge-case risk.
- **Golden-vector storage: inline hex vs JSON fixture.** Resolved: Inline hex strings in the test file. Matches crypto-paseto convention (`packages/crypto-paseto/src/__tests__/v4-local.test.ts:100`); PR-diff is the audit trail for byte-stable artifacts.
- **`pii_ciphertext_digest` position + wire shape.** Resolved: Top-level field on `payload` (matches Spec-006:600 + Spec-022:342 literal reading); wire shape is **lowercase hex 64-char string** (matches BLAKE3 reference output convention; T2.3 golden vectors are reviewer-friendly in hex).
- **`participantSignature` minting boundary.** Resolved: Phase 2 signer exports both `mintParticipantSignature(...)` (write-side helper accepting participant private key) and `verifyParticipantSignature(...)` (read-side); the WHICH-events-are-sensitive enum lives in `packages/contracts/src/event.ts` Phase 1 extension; the WHEN-to-mint decision is Plan-002 / Plan-022 territory.
- **Partition-anchor queue durability.** Resolved: Design A — new SQLite table `pending_anchor_uploads` with columns mirroring `AnchorPayload` plus `attempt_count`, `last_attempt_at`, `last_error`; `UNIQUE(session_id, node_id, start_sequence, end_sequence)` constraint. Survives daemon restart; queryable for operator triage; storage footprint bounded at ≤ 1 anchor per 300s per session. Design B (reconstruct from Postgres deltas) fails the no-re-signing constraint; Design C (in-memory) fails durability.
- **Audit-stub representation: column add vs payload discriminator.** Resolved: Design B — new `session_events.retention_class TEXT` column. Partial index `WHERE retention_class IS NULL` keeps hot-path replay queries fast; explicit column makes stub state visible at row inspection; three-layer enforcement easier with typed column than JSON-field probe.
- **Migration-runner integration: callback vs polling.** Resolved: Hybrid — callback seam on the runner (primary path; immediate emission via `onBatchFinish(handler)`) + startup reconciliation fallback (`MAX(sequence) WHERE type = 'schema.migrated'` gap fill, guarding against crash between commit and emit). Callback amendment to Plan-001 migration-runner per cross-plan-deps.md §2 housekeeping exception (Plan-006 may fix-in-place since the change adds a callback seam without altering semantics).
- **`session_snapshots` extension scope.** Resolved: Reading (a) — existing `as_of_sequence` already carries cursor-state semantics per local-sqlite-schema.md:66; T4.4 adds ONLY the compaction-incidence flag columns `has_compacted_ranges` + `compacted_range_count`. Plan-015 owns the separate `replay_cursors` table for projector resumption; the two surfaces answer different questions.
- **`EventSubscription` backpressure model.** Resolved: Phase 4 implementer reads Plan-007 CP-007-4 `LocalSubscriptionProducer<T>` contract first; if Plan-007 ratifies a backpressure model there, T4.5 follows. If Plan-007 CP-007-4 is silent at T4.5 dispatch time, surface as a Plan-007 ratification before T4.5 lands. **Phase 4 owes pre-dispatch verification.**
- **`summary` field max-length and generation rule.** Resolved: Deferred to Phase 3 T3.2 (`compactor.ts` is the emission site). T4.8's `<CompactedStubSegment>` MUST handle arbitrary lengths gracefully (CSS truncation + tooltip-on-hover); renderer-side resilience does not gate Phase 5's emission rule.
- **Live-stream gap detection mechanism.** Resolved: Sequence-number monotonicity check in the SDK's `EventClient.subscribe` (Option (b)) as canonical gap-detection; SSE reconnect via `Last-Event-ID` header (Option (a)) as reconnect path. Heartbeat-with-cursor (Option (c)) deferred unless Plan-008-bootstrap heartbeat substrate adds it natively.

## Cross-Plan Obligations

Each obligation gets a CP-006-N ID. The Cross-Plan Dependency Graph entry for Plan-006 (cross-plan-dependencies.md §3 row 135) mirrors this list.

- **CP-006-1 — Plan-022 PII codec interface boundary.** Phase 2 T2.4's `pii-indirection.ts` consumes `PiiEncryptor` as an interface; Plan-022 (Tier 5) ships the AES-256-GCM + HKDF-SHA256 + XChaCha20-Poly1305 implementation. Phase 2 ships interface + test-only stub; composition root (Plan-001 / Plan-003 bootstrap) MUST inject the real codec — never the stub — and ships a runtime assertion against the stub outside tests.
- **CP-006-2 — Anchor-router mount on Plan-008-bootstrap.** Phase 3 T3.3 ships `packages/control-plane/src/event-anchors/anchor-router.ts` as a tRPC procedure; mount point is Plan-008-bootstrap `host.ts` per cross-plan-deps.md §2. Plan-006 extends; Plan-008 substrate owns.
- **CP-006-3 — RFC 8785 JCS shared with Spec-024 dispatch.** Spec-024 §request_body_hash computes a BLAKE3 digest over RFC-8785-canonicalized JSON. Phase 2 T2.1's `canonicalizeEvent` + `canonicalizeJson` are the workspace's single source of truth for RFC 8785; Plan-027 (Spec-024 implementer) MUST consume — never re-implement.
- **CP-006-4 — `event.*` JSON-RPC namespace registration with Plan-007.** Phase 4 T4.7 registers `event.readAfterCursor`, `event.readWindow`, `event.subscribe` under Plan-007's namespace registry per Plan-007 I-007-9. Plan-007 Phase 4 (Tier 4) MUST accept these three method-name registrations; without them, the SDK seam fails to register at daemon startup. Reciprocal entry on Plan-007's side per CP-007-N.
- **CP-006-5 — `CapabilityDetails` + `providerFailureDetail` carry-forward with Plan-005 (CLOSES CP-005-5).** Phase 1 T1.4 binds typed `CapabilityDetails` interface for `runtime_node.capability_*` event payloads; Phase 3 audit-mirror adds `providerFailureDetail?: string` to `run.failed` payload (api-payload-contracts.md:996-1019 `RunStateChangeEvent`). Both are ADR-018-compliant additive-only MINOR additions. **Discharge artifacts applied in this audit PR.** **Carry-forward (Plan-003 cross-plan amendment 2026-06-02, PR #137):** the `runtime_node.capability_declared` / `capability_updated` payload-shape Zod schemas are **authored by Plan-003 Phase 2** in `packages/contracts/src/runtime-node.ts` (CREATE), shipping `capabilityDetails` / `previousState` / `newState` as interim-opaque `z.record(z.string(), z.unknown())`. Phase 1 T1.4 therefore **EXTENDs** those existing schemas — it binds the canonical `CapabilityDetails` wrapper over the interim-opaque field and registers them into `SessionEventSchema`; it does **not** re-author the payload shapes from scratch. See Plan-003 §CP-003-1 (Payload-shape ownership) and [cross-plan-dependencies.md §3 Plan-003 row](../architecture/cross-plan-dependencies.md#3-inter-plan-dependency-graph).
- **CP-006-6 — Plan-001 forward-declared schema is immutable.** Plan-006 Phase 3 reads columns shipped by Plan-001 in `0001-initial.ts` but never re-shapes them. Plan-001 `I-001-3` enforces this. New tables + columns Plan-006 needs (`daemon_signing_keys` table, `session_events.retention_class`, `session_snapshots.{has_compacted_ranges, compacted_range_count}`, `pending_anchor_uploads` table) ship as Plan-006-owned additive migrations at Tier 4, never as modifications to `0001-initial.ts`.
- **CP-006-7 — Plan-002 amendment for daemon_signing_key generation at session-create.** Plan-002 (Tier 1, closed) reopens via amendment-via-extension PR to extend session-create with `DaemonSigningKeySource.create(sessionId)` call + participant-roster public-key registration. Amendment is scope-limited to call-site + roster row write; no master-key crypto leaks into Plan-002. Spec-006:602 (the daemon public key is the NodeId-resolved public key from the session participant roster used for signature verification) is the governing semantic.
- **CP-006-8 — Plan-013 audit-stub renderer surface (forward-declared).** Phase 4 T4.8 ships `<CompactedStubSegment>` as the audit-stub render contract per Spec-006:675. The future Plan-013 (Timeline Rendering And Replay UI) MUST consume — not re-implement. Bidirectional once Plan-013 lands; one-sided forward-declared today (verified via `ls`: `docs/plans/013-*.md` does not exist).
- **CP-006-9 — Plan-015 recovery-dispatcher consumes T4.3 read-after-cursor.** Plan-015 (Tier 7) recovery path calls `eventClient.readAfterCursor` (or daemon-internal `replay-service.ts:readAfterCursor`) to rebuild projections from the last `replay_cursors.last_sequence` checkpoint. T4.6 Zod schemas are the binding interface.
- **CP-006-10 — Plan-020 metrics + dashboard consume audit-integrity events (forward-declared).** Plan-020 (Metrics & Dashboards; Non-Goal of Plan-006 per §Non-Goals) SHOULD consume `audit_integrity_verified`, `audit_integrity_failed`, `key_reuse_detected` for an audit-health dashboard. Binding when Plan-020 is authored.

## Invariants

Each invariant gets an I-006-N ID with the enforcement strategy and the test that confirms it.

- **I-006-1-01 — Category/type bijection.** Every event type belongs to exactly one category; `SESSION_EVENT_CATEGORY_BY_TYPE.size === 140` (140 per the 2026-07-02 Spec-006 B1 amendment — the pre-B1 target was 130) and `new Set(SESSION_EVENT_CATEGORY_BY_TYPE.values()).size === 19`. Enforced via Phase 1 type-level exhaustiveness check + runtime assertion. Cite: Spec-006:551-582.
- **I-006-1-02 — Event-type-string immutability.** Type strings are immutable wire identifiers; renames are forbidden once a type is registered. Enforced via build-time const-assertion + ADR-018 §Decision #8 (MINOR additive-only). Cite: Spec-006:590-602; ADR-018 §Decision #8.
- **I-006-1-03 — Envelope field set is fixed; serialized order is RFC 8785 lex-sort.** The Zod schema declares the canonical field set; RFC 8785 §3.2.3 mandates UTF-16 code-unit lex-sort serialization. JSDoc on `EventEnvelopeSchema` references the Spec-006:597 amendment. Enforced via Phase 2 T2.3 golden-vector tests + Spec-006:597 prose amendment. Cite: Spec-006:590-602 + amendment; RFC 8785 §3.2.3.
- **I-006-1-04 — `EventEnvelope.version` immutability.** Producer-set at emit; never rewritten on read (upcaster chain mutates in-memory representation only). Enforced via `EventEnvelopeVersion` brand + JSDoc cite to ADR-018 §Decision #2/#6. Cite: ADR-018 §Decision #2, #6; Spec-006:77-91.
- **I-006-2-01 — Encrypt → digest → embed → canonicalize → sign order is load-bearing.** Phantom-branded types per stage make reversing the order a TS compile error: `RawEventInput → EventWithPiiDigest → CanonicalBytes → SignedRow`. T2.5 post-shred property test verifies signature still verifies after `pii_payload` shred. Cite: Spec-022 §Signature Safety Under Shred:323-350.
- **I-006-2-02 — `pii-indirection.ts` is the sole write path for `pii_payload`.** Branded `PiiPayloadCiphertext` constructible only inside this module; Plan-001's persistence-layer INSERT helper types the parameter as `PiiPayloadCiphertext | null`; cross-module construction is a TS compile error. Cite: Plan-006:170.
- **I-006-2-03 — Canonical bytes are byte-stable across implementations.** T2.3 golden-vector tests + RFC 8785 Appendix-A conformance vectors guarantee byte-identical output for semantically-equal envelopes. Cite: RFC 8785; Spec-006:590-602.
- **I-006-2-04 — Genesis `prev_hash` = 32 zero bytes; subsequent `prev_hash[n] = row_hash[n-1]`.** Enforced via T2.6 backfill migration + persistence-layer assertion. Cite: Spec-006:586; Plan-006:136; Plan-001:306.
- **I-006-2-05 — Signed bytes commit to `pii_ciphertext_digest`, not raw ciphertext.** `daemon_signature` covers `canonical_bytes(row)` which includes the digest but excludes `pii_payload`; post-shred verification still succeeds. T2.5 verifies. Cite: Spec-022:332-359; Spec-006:600.
- **I-006-2-06 — One canonicalization per row.** `signRow` takes `CanonicalBytes` once and uses it for both BLAKE3 input and Ed25519 message — no opportunity for drift. Cite: Security Architecture:378.
- **I-006-2-07 — `audit_integrity` and `event_maintenance` categories carry no `pii_payload`.** Discriminated-union type on `RawEventInput`: events in these categories have `pii_payload: never`. Cite: Spec-006:459+506; Spec-006:502.
- **I-006-3-01 — Three-layer `audit_integrity` + `event_maintenance` non-compaction / non-shred enforcement.** Layer 1: compactor selector excludes (T3.2). Layer 2: `pii-indirection.ts` refuses (Phase 2). Layer 3: shred fan-out Path 1 selector excludes (Plan-022). T3.5 E2E test exercises all three. Cite: Plan-006:202-206.
- **I-006-3-02 — `event_log_anchors` upload is metadata-only at the type level.** `AnchorPayload` (T3.3) has no `payload` field, no `events` field, no `pii_payload` field. Structurally enforces ADR-017's "control plane sees only ciphertext-derived hashes". T3.5 structural-type test asserts the exact seven fields. Cite: ADR-017 §Decision; shared-postgres-schema.md:392-419.
- **I-006-3-03 — Compaction is anchor-before-stub and chain-commitment-frozen.** T3.2 enforces the anchor-before-compaction protocol per [Spec-006 §Post-Compaction Integrity](../specs/006-session-event-taxonomy-and-audit-log.md#post-compaction-integrity): before mutating any row in range `[start_seq, end_seq]`, the compactor verifies (or force-fires + durably queues) a covering Merkle anchor with daemon Ed25519 signature, computes a per-row `stub_signature` over the canonical bytes of each audit-stub projection, then in one transaction **replaces** `payload` with the JCS-canonicalized audit-stub projection (column is `NOT NULL` — rewritten, not nulled), NULLs `correlation_id`/`causation_id`/`pii_payload`, sets `retention_class = 'audit_stub'`, and writes `stub_signature`. Chain-commitment columns (`prev_hash`/`row_hash`/`daemon_signature`/`participant_signature`/`monotonic_ns`/`version`) are NEVER mutated. T4.1 verifier handles `retention_class = 'audit_stub'` rows via THREE checks (all must pass): (a) anchor-existence + anchor-signature (NOT chain-recomputation against the original, which is impossible after canonical bytes are discarded) — anchor-missing → `failureMode: 'anchor_missing_for_compacted_range'`, anchor-signature-invalid → `failureMode: 'anchor_signature_invalid'`; (b) `stub_signature` re-verification directly over the canonical bytes stored in `payload` (the exact bytes signed at compaction) — tampered/replayed/missing → `failureMode: 'stub_signature_invalid'`; (c) scalar-binding — decode the projection from the verified `payload` bytes and assert each surviving scalar column (`id`/`session_id`/`sequence`/`occurred_at`/`category`/`type`/`actor`) equals its projection field — divergence → `failureMode: 'stub_scalar_mismatch'` (the surviving scalar columns are not covered by `stub_signature`, so an at-rest scalar edit would otherwise forge a filter/reconstruction value). All four are additive-MINOR enum extensions per ADR-018 §Decision #8 (sanctioned). Cite: Spec-006 §Post-Compaction Integrity (anchor-before-compaction protocol + per-row stub_signature commitment + scalar-binding check + threat model); Spec-006 §Integrity Protocol (two-tier integrity); ADR-018 §Decision #8.
- **I-006-3-04 — Anchor cadence: earlier-of (1000 events) OR (300 seconds).** Constants `ANCHOR_INTERVAL_EVENTS = 1000` and `ANCHOR_INTERVAL_SECONDS = 300`. T3.5 cadence test exercises both thresholds independently. Cite: Spec-006 §Anchoring Cadence.
- **I-006-4-01 — Exactly-one verifier emission per range.** `verifyRange({sessionId, fromSeq, toSeq})` emits exactly ONE of `audit_integrity_verified` or `audit_integrity_failed`; never zero, never two. Consumers dedupe by `(verifierNodeId, fromSeq, toSeq, verifiedAt)`. Cite: Spec-006:471-472.
- **I-006-4-02 — Verifier rows are themselves chain-and-signature-protected.** A tampered-after-the-fact integrity-failure record cannot be silently appended without breaking the chain. T4.1 fault-injection test verifies. Cite: Security Architecture §Audit Log Integrity:415.
- **I-006-4-03 — `refuse_on_rotation` invariant enforcement.** Key-reuse detection halts ingest of further events from the colliding signer's `NodeId`; `key_reuse_detected` payload carries `rotationInvariantViolated: 'refuse_on_rotation'` verbatim. T4.2 test verifies. Cite: Spec-006:473.
- **I-006-4-04 — Replay across compacted regions returns audit stubs, never silent omission.** `readAfterCursor` / `readWindow` return all sequence positions; compacted positions carry `payload.retentionClass === 'audit_stub'`. T4.3 test asserts. Cite: Spec-006:65; Spec-006:714-718.
- **I-006-4-05 — `EventSubscription` replay-then-live cursor handoff is monotonic.** Strict sequence order; no duplicate at boundary; no gap at boundary. T4.5 test verifies. Cite: Spec-006:73; Spec-006:64.
- **I-006-4-06 — Zod-validated wire envelopes at SDK seam.** Malformed responses rejected at the SDK boundary, not silently coerced. T4.6 + T4.7 tests verify. Cite: Plan-005 Phase 4 precedent.
- **I-006-4-07 — Audit stubs render as visible summarized segments.** `<CompactedStubSegment>` never renders null or empty; empty `summary` still produces a visible "(compacted, no summary)" segment. T4.8 + T4.9 tests verify. Cite: Spec-006:65; Spec-006:675.

## Audit Reconciliation

Transcription errors and cross-doc inconsistencies discovered during the 2026-05-28 Plan-006 audit, all resolved in this PR or named follow-up.

- **Plan-006 working-copy 120/18 vs canonical 123/19.** Pre-audit lines 22/47/219 transcribed the wrong count. Reconciled to the then-canonical 123/19 (Spec-006 §Event Type Summary enumerates the 19 categories and the event-type total). The canonical total subsequently advanced to **125/19** at the 2026-05-30 Tier-5 swap — Plan-022 D-022-5 registered `daemon.master_key_source` + `daemon.pii_split_ambiguous` under `security_events` — to **126/19** at the 2026-06-10 Tier-6 swap — Plan-012 D-012-8 registered `approval.canceled` under `approval_flow` (Spec-006:259) — and to **130/19** in the same Tier-6 swap — Plan-016 registered `usage.budget_warning` (A-016-6), `moderation.review_flagged` (D-016-10), `orchestration.rejected` (D-016-11), `channel.unmuted` (D-016-12); all mirrored into §Event Taxonomy Coverage above. Working-copy updated in this audit PR.
- **`events/` subdirectory non-existent in `packages/contracts/src/`.** Plan-006 working-copy referenced `packages/contracts/src/events/envelope.ts` + `events/taxonomy.ts`; the directory does not exist (Plan-001's contracts package uses top-level co-location). Reconciled per the directory-placement decision: extend top-level `event.ts` in place. Working-copy Target Areas updated.
- **api-payload-contracts.md Plan-006 §EventEnvelope listed 16 categories.** Reconciled per T1.6: widened to 19 with the three missing entries (`channel_arbitration`, `onboarding_lifecycle`, `cross_node_dispatch`) and the comment updated from "16 categories total" to reference Spec-006 §Event Type Summary with the canonical event-type count (123 at this audit; advanced to 125 at the 2026-05-30 Tier-5 swap per Plan-022 D-022-5, then 126 at the 2026-06-10 Tier-6 swap per Plan-012 D-012-8, then 130 at the same Tier-6 swap per Plan-016 — `usage.budget_warning` A-016-6, `moderation.review_flagged` D-016-10, `orchestration.rejected` D-016-11, `channel.unmuted` D-016-12). Applied in this audit PR.
- **`security-architecture.md:415-417` used superseded `failureKind: 'chain_break'` interim term.** Spec-006:629 explicitly says the prior interim registration is superseded; Spec-006:472 enumerates the canonical `failureMode` enum (7 values at audit time, extended to 11 in this audit PR — see post-compaction integrity entries below). Fixed in this audit PR (security-architecture.md:415 lines updated to use `failureMode` + `failurePath`).
- **Spec-006:597 prose amendment** — Pre-amendment wording "Fields included, in this order:" was ambiguous against RFC 8785 §3.2.3's mandate. Amended in this audit PR to "Fields included (the canonical set; serialized order is mandated by RFC 8785 §3.2.3 UTF-16 code-unit lex-sort of member names, not the order listed here)" with explicit RFC 8785 cite.
- **Post-compaction integrity gap surfaced by Codex review on PR #124 (T5 P1 finding, 2026-05-28).** Pre-amendment Plan-006 I-006-3-03 stated "Verifier short-circuits chain recomputation on `retention_class = 'audit_stub'` rows" — violating Spec-006 §Integrity Protocol's "append-only AND tamper-evident" guarantee + §Acceptance Criteria #3 ("visible in audit history even after payload compaction"). Resolved by introducing the **anchor-before-compaction protocol**: Spec-006 amended with a new §Post-Compaction Integrity sub-section under §Event Compaction Policy, §Integrity Protocol amended with two-tier integrity statement, `failureMode` enum extended from 7 to 9 values (`anchor_missing_for_compacted_range` + `anchor_signature_invalid`, additive-MINOR per ADR-018 §Decision #8), and a 4th Acceptance Criterion added. Plan-006 I-006-3-03 rewritten; T3.2 compactor + T4.1 verifier updated; Plan-006 line 56 + line 229 enum-count references swept to 9. Hardened-mode path; no V1.1 deferral. Resolution surfaces the compacted-range integrity guarantee at anchor-existence + anchor-signature granularity (per-row recomputation is impossible after canonical bytes are discarded, but the daemon-signed Merkle anchor — durably persisted to both `pending_anchor_uploads` and `event_log_anchors` — provides range-level commitment to the pre-compaction state).
- **Post-compaction stub authenticity gap surfaced by Codex re-review on PR #124 (round-2 P1 finding, 2026-05-28).** The round-1 anchor-before-compaction protocol (above) commits to the ORIGINAL pre-compaction bytes (via the frozen `row_hash` the anchor's Merkle root covers) but left the POST-compaction audit-stub bytes — now the only visible `payload` — unauthenticated: a local tamper of the stub's `summary`/`actor` while leaving `row_hash` + the signed Merkle root untouched still verified. Resolved (hardened-mode, no V1.1 deferral) by adding a per-row **`stub_signature`** — an Ed25519 signature over `canonical_bytes(audit-stub projection)` minted by the compactor at compaction time (T3.2) and re-verified by T4.1 against the row's CURRENT stub bytes. Spec-006 §Compacted Event Format + §Post-Compaction Integrity amended (per-row commitment + full threat model: stub-edit, cross-row replay, signature-strip, and both `retention_class`-flip directions all detected); `failureMode` enum extended 9 → 10 (`stub_signature_invalid`, additive-MINOR per ADR-018 §Decision #8); Spec-006 §Compacted Event Format clarified that `payload` is REPLACED with the stub projection (the column is `NOT NULL`), not nulled — coupled fix for the replay/renderer "never silent omission" contract (Codex round-2 P2 on T3.2). New additive column `session_events.stub_signature BLOB` (migration `0NNN-retention-class-and-stub-signature.ts`); I-006-3-03 + T3.2 + T4.1 + Plan-006 line 56 + line 229 enum-count references swept to 10; security-architecture.md §Verification Rules extended with the stub-signature check. Marked a deliberate security amendment to an approved spec (anchor = external proof of original existence; `stub_signature` = at-rest proof of stub authenticity; both required, neither sufficient alone).
- **Post-compaction scalar-binding gap surfaced by Codex re-review on PR #124 (round-5 P1 finding, 2026-05-28).** The round-2 `stub_signature` (above) authenticates only the `payload` projection bytes, but the surviving scalar columns (`id`/`session_id`/`sequence`/`occurred_at`/`category`/`type`/`actor`) are neither nulled nor frozen nor signed — a denormalized cache that SQL filters (`idx_session_events_type`) and envelope reconstruction read. An at-rest edit to a scalar column (e.g. `actor`, `type`) left `payload` + `stub_signature` + the anchor all verifying while a filter/reconstruction surfaced the forged value. Resolved (hardened-mode, no V1.1 deferral) by a per-row **scalar-binding check**: T4.1 decodes the projection from the verified `payload` bytes and asserts each surviving scalar column byte-equals its projection counterpart — divergence → `stub_scalar_mismatch`. Spec-006 §Post-Compaction Integrity amended (verifier "two checks" → "three checks" + new threat-model scenario + new Acceptance Criterion), `failureMode` enum extended 10 → 11 (`stub_scalar_mismatch`, additive-MINOR per ADR-018 §Decision #8); security-architecture.md Rule 4 + cross-plan-dependencies.md `stub_signature` row + I-006-3-03 + T4.1 + Plan-006 line 56 + line 229 enum-count references swept to 11. The signed `payload` projection is affirmed as the authoritative source for a compacted row's envelope fields; the scalar columns are an index/filter cache trustworthy only post-verification.

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

**Prerequisite (off-plan)** — Plan-002 amendment-via-extension PR must land before step 2 begins. The amendment wires session-create to invoke `DaemonSigningKeySource.create(sessionId)` (T2.7), which writes the per-session sealed keypair into the Plan-006-owned `daemon_signing_keys` local SQLite table (migration ships under Plan-006 T2.7, not Plan-002). Without the call-site, every `EventLogService.append()` from step 2 onward hits a null signing-key lookup and the Ed25519 signer throws. Tracked under CP-006-7. The amendment is sequencing-only — Plan-002's already-shipped phases are untouched.

1. Land envelope contracts + taxonomy enum + error-contract version codes (Phase 1).
2. Enable append-only writes with BLAKE3 chain and Ed25519 signatures behind internal feature gating (Phase 2 — depends on Prerequisite + step 1).
3. Enable PII indirection (encrypt → digest → embed → sign order) (Phase 2 — depends on step 2).
4. Enable compaction + Merkle anchor emission (Phase 3 — depends on step 3).
5. Enable replay reads and live subscription catch-up (Phase 4 — depends on step 4).
6. Enable integrity verifier + observer-pattern `key_reuse_detected` (Phase 4 — depends on step 5).

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
- **Plan-002 amendment sequencing.** The signing-key column + session-create call-site live in Plan-002. The amendment-via-extension PR must merge before step 2 of Rollout Order; the §Rollout Order Prerequisite captures this. Late landing surfaces as null-signing-key throws on the first `EventLogService.append()` — a load-bearing cross-plan sequence dependency, not a runtime bug.

## Progress Log

### Shipment Manifest

<!-- Machine-readable. Housekeeper-emitted, orchestrator-written, preflight-read.
     Schema authoritative in:
       .claude/skills/plan-execution/scripts/lib/manifest.mjs -->

```yaml
manifest_schema_version: 1
shipped: []
```

### Notes

<!-- Per-PR human commentary (round-trips, learnings, partial-ship details). Append-only. -->

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
