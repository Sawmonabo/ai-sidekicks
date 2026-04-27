# Plan-022: Data Retention And GDPR Compliance

| Field               | Value                                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**          | `approved`                                                                                                                                                                                                                   |
| **NNN**             | `022`                                                                                                                                                                                                                        |
| **Slug**            | `data-retention-and-gdpr`                                                                                                                                                                                                    |
| **Date**            | `2026-04-17`                                                                                                                                                                                                                 |
| **Author(s)**       | `Claude Opus 4.7`                                                                                                                                                                                                            |
| **Spec**            | [Spec-022: Data Retention And GDPR Compliance](../specs/022-data-retention-and-gdpr.md)                                                                                                                                      |
| **Required ADRs**   | [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md)                                                                                                                                      |
| **Dependencies**    | Plan-001 (this plan forward-declares a column on Plan-001's `session_events` table and contributes `participant_keys` to Plan-001's initial SQLite migration); Plan-007 (local daemon IPC host for the 501 GDPR stub routes) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md)                                                                                                                                                    |

## Goal

Ship the V1 **schema and write-path** of the Spec-022 crypto-shredding model so that every event written in V1 lands with its PII encrypted under a per-participant key. Operational deletion/export/purge flows are V1.1+ and this plan leaves behind a minimal, unambiguous surface (501 Not Implemented stubs + reserved routes) rather than silent non-existence.

## Scope

- Create the `participant_keys` SQLite table (schema per Spec-022 §Participant Keys) owned by this plan, populated on first participant provisioning.
- **Forward-declare** the `session_events.pii_payload BLOB` column onto Plan-001's initial SQLite migration `0001-initial.sql` so Tier 1 ships a schema already compatible with crypto-shredding. Plan-001's migration inherits this constraint at authoring time (Session 4 / post-BL-054 propagation).
- Daemon master-key bootstrap: OS keychain primary (macOS Keychain, Windows DPAPI/Credential Manager, Linux libsecret via `keytar`); file fallback at `${XDG_DATA_HOME:-~/.local/share}/ai-sidekicks/daemon/master-key` (mode `0600`, base64-encoded 32 bytes) when keychain is unavailable.
- Per-participant key derivation: HKDF-SHA256 (RFC 5869) with `info = "ais.participant.v1" || participant_id`, `salt = null`, `ikm` = participant authentication material passed by Plan-018 at provisioning time; derived key is the AES-256 content key.
- PII encryption format: AES-256-GCM with `AAD = participant_id || event_id`, 12-byte random nonce, wire format `iv || ciphertext || tag`. Written to `session_events.pii_payload` by every event writer that emits PII.
- Master-key wrap for `participant_keys.encrypted_key_blob`: XChaCha20-Poly1305 with `AAD = participant_id || "ais.master-wrap.v1"`, 24-byte random nonce, wire format `nonce || ciphertext || tag`. Matches [Spec-022 §Participant Keys](../specs/022-data-retention-and-gdpr.md#participant-keys) and Plan-001's forward-declared `participant_keys` table. **Rationale.** XChaCha20-Poly1305's 192-bit random nonce eliminates the nonce-collision risk that AES-256-GCM's 96-bit nonce creates for a master-wrap key whose nonces are randomly generated across potentially many rotations and devices; per [RFC 8439 §4](https://datatracker.ietf.org/doc/html/rfc8439) and [draft-irtf-cfrg-xchacha-03](https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha-03), the 192-bit nonce space is safe for arbitrary random nonces, whereas AES-256-GCM's 96-bit nonce requires counter management or bounded total messages per key. PII content encryption (`pii_payload`) remains AES-256-GCM because the AAD `participant_id || event_id` uniquely binds each record to a per-write counter-safe context.
- PII splitter: a pure, content-aware function `splitPii(event) → {payload, pii_payload}` that the emitter invokes per write. The emitter decides at the call site whether a given field carries PII (by passing the field to the `piiPayload` branch of the splitter input); the splitter does not consult a per-event-type registry attribute. Non-PII events write a NULL `pii_payload`. **Rationale.** Spec-006's event taxonomy does not carry a per-event `pii:true|false` attribute and is not planned to — classifying 120 event types across 18 categories into PII buckets is brittle because a single event type can carry PII on one call-site and none on another (e.g. `run.prompt_submitted` carries PII when the prompt is user-authored, none when the prompt is a system template). Call-site classification is the only model that stays correct under this ambiguity.
- 501 Not Implemented stub routes for the three V1.1+ GDPR endpoints (`POST /sessions/{id}/purge`, `GET /participants/{id}/export`, `DELETE /participants/{id}/data`) returning error code `gdpr.endpoint_not_v1` — preserves URL contract for V1.1 upgrade without shipping half-finished behavior.

## Non-Goals

- **Operational deletion/export/purge behavior.** V1 ships only the 501 stubs for the three endpoints; real behavior is V1.1+ per Spec-022 §Implementation Notes ("Crypto-shredding logic is post-V1").
- **Key rotation.** Spec-022 explicitly scopes this out of V1 (§Implementation Notes). `key_version` defaults to `1`; `rotated_at` stays `NULL`.
- **Postgres tombstone anonymization** on participant deletion. Postgres hard-delete + membership tombstoning is V1.1+.
- **90-day retention compaction** — that is Plan-006's domain (event compaction policy).
- **Any behavior that depends on the V1.1+ MLS upgrade path** per ADR-010 (pairwise X25519 → MLS). PII encryption here is at rest in the daemon SQLite only; transport encryption is orthogonal.

## Preconditions

- [x] Spec-022 is approved (this plan is paired with it)
- [x] ADR-015 V1 Feature Scope Definition is accepted (places GDPR schema readiness as V1 surface requirement)
- [x] `@noble/hashes` and `@noble/ciphers` crypto-library decision ([ADR-010 §Decision point 3](../decisions/010-paseto-webauthn-mls-auth.md#decision) / [security-architecture.md §Relay Authentication And Encryption](../architecture/security-architecture.md#relay-authentication-and-encryption-task-53) — already fixed to `@noble` v2.x for V1)
- [ ] Plan-001 is authored and accepts the forward-declaration (actioned in Session 4 per BL-054)
- [x] PII classification is a call-site decision owned by the emitter, not a Spec-006 registry attribute. Spec-006 does not carry a `pii:true|false` per-event-type flag — the splitter consumes the emitter's explicit split of `{payload, piiPayload}` on each write. See §Scope for rationale.

## Target Areas

- `packages/runtime-daemon/src/crypto/` — **created by this plan**: `master-key-source.ts`, `participant-key-deriver.ts`, `pii-codec.ts`, `wrap-codec.ts`
- `packages/runtime-daemon/src/persistence/participant-keys/` — **created by this plan**: `participant-keys-store.ts`
- `packages/runtime-daemon/src/persistence/session-events/` — **extended by this plan**: event-writer helper `write-with-pii.ts` that the Plan-001 writer path consumes
- `packages/runtime-daemon/src/persistence/migrations/0001-initial.sql` — **forward-declared addition to Plan-001's migration**: `session_events.pii_payload BLOB` column + full `participant_keys` table
- `packages/runtime-daemon/src/config/master-key-source.ts` — keychain bootstrap (via `keytar`), file fallback path resolution
- `packages/runtime-daemon/src/http/gdpr-stub-routes.ts` — **created by this plan**: three 501 handlers registered by Plan-007's IPC host
- `docs/architecture/contracts/error-contracts.md` — **extended**: new error code `gdpr.endpoint_not_v1` (HTTP 501)
- `docs/architecture/schemas/local-sqlite-schema.md` — **extended**: `participant_keys` table schema + `session_events.pii_payload` column documented

## Data And Storage Changes

### PII Data Map (Three Durability Tiers)

Per [Spec-022 §PII Data Map](../specs/022-data-retention-and-gdpr.md#pii-data-map), three PII durability tiers are reachable from `DELETE /participants/{id}/data`. Plan-022 owns the V1 schema and write-path for the durable-tier SQLite side (below); Plan-018 owns the Postgres side of the durable tier; Plan-020 owns the bounded-retention tier; the telemetry-export tier is covered by Plan-020's default-deny outbound posture. Plan-022 is the orchestrator that reconciles the three tiers when the V1.1 deletion handler ships (see Implementation Step 11 + [§Signature Safety Under Shred](#signature-safety-under-shred)).

**Durable tier** (V1 schema in scope for Plan-022's SQLite side; Postgres side referenced for V1.1 orchestration):

| Table                           | Column                         | Owner Plan                                                  | Shred Path                                                   |
| ------------------------------- | ------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------ |
| `session_events` (SQLite)       | `pii_payload`                  | Plan-022 write-path; Plan-001 migration forward-declaration | Path 1 — crypto-shred via `participant_keys` row DELETE      |
| `participant_keys` (SQLite)     | `encrypted_key_blob`           | Plan-022                                                    | Path 1 — row DELETE destroys per-participant AES-256-GCM key |
| `participants` (PG)             | `display_name`, `identity_ref` | Plan-018 (identity model)                                   | Path 2 — hard DELETE row                                     |
| `identity_mappings` (PG)        | `external_id`                  | Plan-018                                                    | Path 2 — hard DELETE row                                     |
| `session_invites` (PG)          | `token_hash`                   | Plan-018                                                    | Path 2 — anonymize participant reference                     |
| `notification_preferences` (PG) | `preference_value`             | Plan-018                                                    | Path 2 — hard DELETE row                                     |

**Bounded-retention diagnostic tier** (daemon-local SQLite, non-canonical per [Spec-020 §Required Behavior](../specs/020-observability-and-failure-recovery.md#required-behavior); ≤ 7-day TTL; Plan-020 ownership):

| Table                                      | Column                | Owner Plan | Shred Path                                                                   |
| ------------------------------------------ | --------------------- | ---------- | ---------------------------------------------------------------------------- |
| `driver_raw_events` (SQLite, daemon-local) | `raw_payload`         | Plan-020   | Path 3 — scoped flush before TTL                                             |
| `command_output` (SQLite, daemon-local)    | `stdout`, `stderr`    | Plan-020   | Path 3 — scoped flush before TTL                                             |
| `tool_traces` (SQLite, daemon-local)       | `args`, `result_body` | Plan-020   | Path 3 — scoped flush before TTL                                             |
| `reasoning_detail` (SQLite, daemon-local)  | `detailed_payload`    | Plan-020   | Path 3 — scoped flush before TTL; summary retained (non-PII by construction) |

**Telemetry export tier** (outbound OTel / error-tracker sinks; default-deny, opt-in; Plan-020 redaction-policy ownership):

| Sink                            | Attribute                            | Owner Plan | Shred Coverage                                                                                                                                 |
| ------------------------------- | ------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| OTel span attributes (outbound) | `gen_ai.prompt`, `gen_ai.completion` | Plan-020   | Redacted by default per [Spec-020 §PII in Diagnostics](../specs/020-observability-and-failure-recovery.md#pii-in-diagnostics); opt-in required |
| OTel log body (outbound)        | log `body`                           | Plan-020   | Redacted by default; operator scrubbing policy                                                                                                 |
| Error-tracker sink (outbound)   | `request`, `extra`                   | Plan-020   | Server-side scrubbing (default-deny keyname list)                                                                                              |

Plan-022 does not operate against remote sinks directly. Telemetry-tier shred coverage is achieved by Plan-020's default-deny outbound posture (no PII content leaves the daemon unless opt-in per bucket, per [Spec-020 §PII in Diagnostics](../specs/020-observability-and-failure-recovery.md#pii-in-diagnostics)).

### SQLite: `participant_keys` (new, owned by Plan-022)

```sql
CREATE TABLE participant_keys (
  participant_id      TEXT    NOT NULL PRIMARY KEY,
  encrypted_key_blob  BLOB    NOT NULL,            -- XChaCha20-Poly1305-wrapped AES-256 key (wire: nonce || ciphertext || tag)
  key_version         INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT    NOT NULL,            -- ISO 8601
  rotated_at          TEXT                         -- ISO 8601, NULL until first rotation (V1.1+)
);
```

### SQLite: `session_events.pii_payload` (forward-declared onto Plan-001's migration)

Plan-001's initial migration `0001-initial.sql` MUST include `pii_payload BLOB` on the `session_events` column list directly (not as a later ALTER). Rationale: Spec-022 §Schema Requirements is load-bearing — _"This schema separation must be present in the initial V1 schema to avoid costly migration later."_ BL-054's propagation pass verifies the forward-declaration has been accepted.

### Filesystem: master-key bootstrap

- **Primary**: OS keychain entry under service `"ai-sidekicks.daemon"`, account `"master-key"` (32 random bytes, base64).
- **Fallback**: `${XDG_DATA_HOME:-~/.local/share}/ai-sidekicks/daemon/master-key` with mode `0600`.
- **Bootstrap contract**: if neither exists, generate 32 random bytes (`crypto.getRandomValues`), write to keychain; fall back to file if keychain unavailable; emit a single `daemon.master_key_source` event with `{source: "keychain" | "file"}` on startup.

## API And Transport Changes

### 501 GDPR stub routes (HTTP, local IPC via Plan-007's host)

Three routes registered by Plan-022, all returning HTTP 501 with:

```json
{
  "error": {
    "code": "gdpr.endpoint_not_v1",
    "message": "Crypto-shredding is post-V1; this endpoint is reserved for a V1.1+ release."
  }
}
```

Routes:

- `POST /sessions/{id}/purge`
- `GET /participants/{id}/export`
- `DELETE /participants/{id}/data`

The stubs preserve the URL contract so V1.1 can ship real handlers without a breaking route addition. No request validation or authentication beyond Plan-007's standard IPC auth; 501 is returned unconditionally.

## Signature Safety Under Shred

Event rows carry an Ed25519 signature over canonical bytes per [Spec-006 §Integrity Protocol](../specs/006-session-event-taxonomy-and-audit-log.md#integrity-protocol). After Path 1 destroys a participant's AES-256-GCM key (see Implementation Step 11), the signature bytes on every pre-shred event row remain on disk indefinitely for audit integrity. Plan-022's write-path obligations (Implementation Step 7 below) ensure these retained signatures **cannot** re-introduce plaintext PII recoverability, per [Spec-022 §Signature Safety Under Shred](../specs/022-data-retention-and-gdpr.md#signature-safety-under-shred). Five-point proof:

1. **Canonical bytes exclude `pii_payload`.** Per [Spec-006 §Canonical Serialization Rules](../specs/006-session-event-taxonomy-and-audit-log.md#canonical-serialization-rules), canonical-bytes-under-signature cover 11 envelope fields (`id`, `sessionId`, `sequence`, `occurredAt`, `category`, `type`, `actor`, `payload`, `correlationId`, `causationId`, `version`) — **not** `pii_payload`. Events whose `pii_payload` is non-NULL embed `pii_ciphertext_digest = BLAKE3(pii_payload_ciphertext)` inside `payload`, which **is** in the canonical form. Plan-022's write-path (Implementation Step 7, `write-with-pii.ts`) MUST compute this digest and embed it in `payload` BEFORE the canonicalizer runs; Plan-006 owns the canonical-serialization semantics — see Plan-006 §PII Columns 7-step Encrypt-Then-Digest-Then-Sign order. Any implementation path that signs `pii_payload` ciphertext directly (skipping the digest indirection) is a signature-integrity regression.
2. **Ed25519 signature verification is a public operation.** Per [RFC 8032 §5.1](https://datatracker.ietf.org/doc/html/rfc8032#section-5.1), Ed25519 verification takes `(public key, message, signature) → bool`. No plaintext oracle is introduced by verification; an attacker holding every signed row and the daemon's public key learns only that canonical bytes are authentic, never plaintext PII.
3. **BLAKE3 digest is one-way.** `pii_ciphertext_digest` commits to ciphertext via a 32-byte BLAKE3 digest. Preimage recovery requires brute force over the ciphertext preimage space (AES-256-GCM output bytes, not plaintext).
4. **AES-256-GCM key destruction is load-bearing.** The per-participant AES-256-GCM key lives only in `participant_keys.encrypted_key_blob`, wrapped under the daemon master key. Path 1 DELETE of the `participant_keys` row destroys the content key by construction — no credential can unwrap a key that is no longer present. Even if an attacker somehow recovered the ciphertext preimage of `pii_ciphertext_digest` (infeasible per point 3), the AES-256-GCM key required to decrypt it is already gone. This matches the cryptographic-construction argument in [Spec-022 §Signature Safety Under Shred point 4](../specs/022-data-retention-and-gdpr.md#signature-safety-under-shred).
5. **256-bit brute force is infeasible.** Per [NIST SP 800-38D](https://csrc.nist.gov/publications/detail/sp/800-38d/final), AES-256-GCM provides no cryptanalytic shortcut that allows plaintext recovery without the key; 2^256 keyspace rules out brute force for any known-feasible attacker.

**Therefore.** Signature bytes retained indefinitely for audit integrity commit only to ciphertext that Path 1 rendered irrecoverable. Verification remains possible; plaintext recovery remains infeasible. This is the audit-integrity-load-bearing property that lets V1 ship `pii_payload` crypto-shred without breaking Spec-006's BLAKE3 hash chain or Ed25519 signature chain.

## Implementation Steps

1. Add `@noble/hashes` (HKDF-SHA256) and `@noble/ciphers` (AES-256-GCM for PII content encryption; XChaCha20-Poly1305 for master-key wrap of `participant_keys.encrypted_key_blob`) to `packages/runtime-daemon/package.json` at the same major versions pinned by ADR-010 for relay encryption (implementation economy: one audited crypto library with two distinct AEAD primitives matched to their use case — AES-256-GCM for counter-bounded per-record PII writes; XChaCha20-Poly1305 for random-nonce master-wrap).
2. Implement `packages/runtime-daemon/src/config/master-key-source.ts` with keychain-primary (via `keytar`) and file-fallback (`${XDG_DATA_HOME:-~/.local/share}/ai-sidekicks/daemon/master-key`, mode `0600`) bootstrap. Emit `daemon.master_key_source` event on resolution.
3. Implement `packages/runtime-daemon/src/crypto/participant-key-deriver.ts`: HKDF-SHA256 with `info = "ais.participant.v1" || participant_id`, returns 32-byte AES-256 key.
4. Implement `packages/runtime-daemon/src/crypto/wrap-codec.ts`: XChaCha20-Poly1305 wrap with `AAD = participant_id || "ais.master-wrap.v1"`, 24-byte random nonce, wire format `nonce || ciphertext || tag`.
5. Implement `packages/runtime-daemon/src/persistence/participant-keys/participant-keys-store.ts`: CRUD on `participant_keys` using `wrap-codec`; provides `ensureKeyFor(participantId, ikm)` idempotent provisioning.
6. Implement `packages/runtime-daemon/src/crypto/pii-codec.ts`: AES-256-GCM with `AAD = participant_id || event_id`, 12-byte random nonce, wire format `iv || ciphertext || tag`.
7. Implement `packages/runtime-daemon/src/persistence/session-events/write-with-pii.ts`: content-aware PII splitter with signature `splitPii({ payload, piiPayload }) → { payload: PayloadWithDigest, pii_payload: Buffer | null }`. The emitter partitions fields at the call site: non-PII fields go to `payload`, PII fields go to `piiPayload`. When `piiPayload` is non-null, the splitter encrypts it via `pii-codec.ts` (AES-256-GCM), computes `pii_ciphertext_digest = BLAKE3(pii_payload_ciphertext)`, and embeds the digest in the returned `payload` BEFORE the canonicalizer (owned by Plan-006) runs — so the canonical bytes carry the digest commitment but never the plaintext. This embed-before-canonicalize order is load-bearing for [§Signature Safety Under Shred](#signature-safety-under-shred) and matches Plan-006 §PII Columns 7-step Encrypt-Then-Digest-Then-Sign order exactly. Plan-022 owns the digest-embed on the write path; Plan-006's `pii-indirection.ts` is the sole canonicalization path. Consumed by Plan-001's event-writer helper on integration. The splitter never inspects a Spec-006 registry attribute — call-site classification is authoritative.
8. Forward-declare schema: during Plan-001 authoring (Session 4), migration `0001-initial.sql` must include `pii_payload BLOB` on `session_events` and the full `participant_keys` CREATE TABLE. Capture this dependency in BL-054's propagation pass.
9. Implement `packages/runtime-daemon/src/http/gdpr-stub-routes.ts`: three 501 handlers returning `gdpr.endpoint_not_v1`; registered via Plan-007's IPC host.
10. Document the new error code in `docs/architecture/contracts/error-contracts.md` and the new schema elements in `docs/architecture/schemas/local-sqlite-schema.md`.
11. **Reserve Shred Fan-Out Orchestration surface (V1.1+).** Plan-022 is the V1 schema + write-path surface; the real `DELETE /participants/{id}/data` handler is V1.1+ (per §Non-Goals — 501 stubs in V1). When the real handler ships in V1.1, it MUST execute these three paths in the order below before emitting `participant.purged`, per [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md#shred-fan-out):
    1. **Path 1 — SQLite crypto-shred.** DELETE the participant's row from `participant_keys`. Per-participant AES-256-GCM key is destroyed; all `pii_payload` ciphertext for every session the participant touched becomes permanently unrecoverable. Audit artifact: one `event.shredded` event (payload contains no PII; retained indefinitely per [Spec-006 §Event Maintenance](../specs/006-session-event-taxonomy-and-audit-log.md#event-maintenance-event_maintenance)); `event.shredded` emission is owned by [Plan-006](./006-session-event-taxonomy-and-audit-log.md) §Shred Fan-Out Cross-References.
    2. **Path 2 — Postgres hard DELETE.** DELETE rows from `participants`, `identity_mappings`, `notification_preferences`. Anonymize participant references in `session_invites` and `session_memberships` via the tombstone-identifier pattern per [Spec-022 §Postgres (Control Plane) Deletion](../specs/022-data-retention-and-gdpr.md#postgres-control-plane-deletion). Postgres-side table ownership is Plan-018 (identity model) + Plan-001 (`session_memberships`); Plan-022 is the orchestrator. Any DELETE failure reports the whole path failed; daemon does not partially advance.
    3. **Path 3 — Bounded-retention scoped flush.** For each of the 4 diagnostic buckets (`driver_raw_events`, `command_output`, `tool_traces`, `reasoning_detail` — all owned by Plan-020), DELETE all rows tagged with the purged participant ID. Scoped flush short-circuits the normal 7-day TTL. Counters-only audit artifact (`diagnostic_rows_purged` per table).

    After all three paths complete, the daemon emits the aggregate `participant.purged` event. No ACID transaction spans the three paths — SQLite and Postgres are distinct durability domains. Per-path idempotence supports operator-retry on partial completion: key-already-deleted is a no-op (Path 1); DELETE-of-nonexistent is a no-op (Path 2); flush-of-empty-buckets is a no-op (Path 3).

    **Ordering rationale** (per [Spec-022 §Ordering And Atomicity](../specs/022-data-retention-and-gdpr.md#ordering-and-atomicity)):
    - **Path 1 before Path 2** — crypto-shred first so a concurrent reader cannot decrypt `pii_payload` via a Postgres lookup chain during the Postgres-row-delete window. After Path 1, ciphertext is unrecoverable regardless of what Postgres contains.
    - **Path 2 before Path 3** — hard-delete the Postgres participant record before clearing diagnostic buckets so a diagnostic-bucket reader cannot re-derive PII via Postgres JOIN during the bucket-flush window.
    - **`participant.purged` last** — the aggregate event is the durable audit artifact of the whole operation; emitting it before all three paths complete would misrepresent completion state.

    **V1 code requirement: zero.** This step is a cross-plan alignment checkpoint, not a code-landing step. It verifies: (a) Plan-001's `participant_keys` schema emits no foreign-key cascade barrier blocking a Path 1 DELETE; (b) Plan-018's Postgres schema exposes all Path 2 deletion/anonymization targets; (c) Plan-020's diagnostic-bucket tables accept per-participant-id scoped flush as Path 3 targets; (d) Plan-006's `event.shredded` emission on Path 1 completion is wired per Plan-006 §Shred Fan-Out Cross-References. Any cross-plan drift surfaced by this checkpoint is fixed at the drifted plan; Plan-022 is the reporter, not the fixer.

## Parallelization Notes

- Steps 1–7 (crypto + store) are independent of Plan-001 authoring and can land in parallel with Plan-001's skeleton once Plan-001 reaches the migration-authoring stage.
- Step 8 (forward-declaration into Plan-001's migration) is the integration point and must not be skipped; BL-054's propagation pass is the coordination mechanism.
- Step 9 (501 stubs) depends only on Plan-007's IPC host being present; fully parallelizable with any other Plan-022 step.

## Test And Verification Plan

- **Unit, `pii-codec`**: round-trip (encrypt → decrypt) plus AAD-mismatch test (decrypt with wrong `participant_id` MUST fail). NIST GCM test vectors (SP 800-38D Appendix B) for baseline AES-256-GCM correctness.
- **Unit, `participant-key-deriver`**: RFC 5869 test vectors (Appendix A, A.1–A.3) for HKDF-SHA256.
- **Unit, `wrap-codec`**: AAD mismatch (wrong `participant_id` in wrap AAD) MUST fail decrypt.
- **Unit, `pii-splitter`**: given emitter inputs with explicit `{payload, piiPayload}` partitions, confirm routing and digest-embed order; given ambiguous mixed-shape inputs (nested records with unclassified fields), confirm fallback routes the whole ambiguous record to `pii_payload` and emits `daemon.pii_split_ambiguous`.
- **Unit, `write-with-pii` digest embedding (signature-safety gate)**: given a fixture event with non-NULL `pii_payload`, confirm the returned shape includes `pii_ciphertext_digest` field in `payload` equal to `BLAKE3(pii_payload_ciphertext)`. Verify BLAKE3 output against [BLAKE3 official test vectors](https://github.com/BLAKE3-team/BLAKE3/blob/master/test_vectors/test_vectors.json) for correctness. This test is the V1 gate on [§Signature Safety Under Shred](#signature-safety-under-shred) — Plan-006's canonicalizer relies on this digest being present in `payload` before it hashes and signs.
- **Integration, migration**: Plan-001's migration 0001 fixture must include `pii_payload` on `session_events` and the full `participant_keys` table; test asserts `PRAGMA table_info(session_events)` and `PRAGMA table_info(participant_keys)`.
- **Integration, write-path**: end-to-end participant provisioning → event write → SQLite inspection shows `pii_payload` is ciphertext bytes (not plaintext JSON) and that the `payload` column contains only non-PII fields.
- **Integration, master-key bootstrap**: mocked keychain-unavailable case falls back to file, emits `daemon.master_key_source` event with `source: "file"`.
- **Integration, 501 routes**: all three routes return HTTP 501 with `gdpr.endpoint_not_v1` error code regardless of request body.
- **Manual verification**: on macOS, confirm keychain entry is created; on Linux without libsecret, confirm file fallback triggers.

## Rollout Order

1. Land crypto libraries + `master-key-source.ts` + unit tests (Steps 1–2) — no schema impact yet.
2. Land `participant-key-deriver.ts`, `wrap-codec.ts`, `pii-codec.ts` with unit tests (Steps 3, 4, 6) — pure-function, no persistence impact.
3. Land `participant-keys-store.ts` + `write-with-pii.ts` with unit + integration tests (Steps 5, 7) — depends on Plan-001's migration skeleton being available.
4. Coordinate with Plan-001 authoring (Session 4) to accept the forward-declaration (Step 8). BL-054's cross-plan propagation pass verifies.
5. Land `gdpr-stub-routes.ts` + documentation updates (Steps 9–10).

## Rollback Or Fallback

- If the keychain primary fails at bootstrap, the file fallback is the rollback path — no code change required.
- If an emitter passes a mixed-shape record where PII/non-PII partitioning is ambiguous (e.g. a nested object where some keys are PII and others are not, with no explicit partition), the splitter's default policy is **route the whole ambiguous record to `pii_payload`** (err on the side of encryption). Emit a `daemon.pii_split_ambiguous` event with the event type + field path for operator audit. This is a containment fallback, not a rollback. The emitter should be amended to partition fields explicitly on the next write path touch.
- If the forward-declaration onto Plan-001's migration is missed during Session 4 integration, the schema drift is a build-time failure — the "Integration, migration" test catches it before merge.

## Risks And Blockers

- **Risk**: an emitter forgets to partition PII fields explicitly and passes PII as plain `payload`. **Mitigation**: code review rule — every event emission that could plausibly carry PII content (user text, file content, prompt bodies, provider outputs) MUST route through `splitPii` with an explicit `piiPayload` argument; the splitter's ambiguous-record containment fallback (route-to-pii_payload + `daemon.pii_split_ambiguous` event) protects against accidental plaintext writes but is not the primary safeguard.
- **Risk**: `keytar` drops a platform backend (historically libsecret on some distros). **Mitigation**: file fallback is always live; platform-coverage tests exercise both paths.
- **Risk**: HKDF `ikm` source (participant authentication material from Plan-018) may not be stable across password-change events. **Mitigation**: V1 scopes rotation out entirely; Plan-018's identity model must document that auth-credential changes do not mutate the HKDF `ikm` in V1, or key rotation becomes mandatory.
- **Blocker**: Plan-001 authoring (Session 4). The forward-declaration onto migration 0001 must be accepted during Plan-001 drafting. BL-054 is the propagation mechanism.

## Done Checklist

- [ ] `participant_keys` table schema matches Spec-022 §Participant Keys exactly
- [ ] Plan-001 migration 0001 includes `session_events.pii_payload BLOB` and the full `participant_keys` CREATE TABLE (forward-declaration accepted)
- [ ] AES-256-GCM PII encryption round-trips with `AAD = participant_id || event_id`
- [ ] HKDF-SHA256 derivation passes RFC 5869 test vectors
- [ ] XChaCha20-Poly1305 master-key wrap round-trips with `AAD = participant_id || "ais.master-wrap.v1"` and 24-byte random nonce
- [ ] OS keychain bootstrap succeeds on macOS and Windows; file fallback succeeds on Linux-without-libsecret
- [ ] PII splitter `splitPii({payload, piiPayload})` partitions correctly per emitter-supplied classification; ambiguous-record records default to `pii_payload` and emit `daemon.pii_split_ambiguous`
- [ ] `write-with-pii.ts` computes `pii_ciphertext_digest = BLAKE3(pii_payload_ciphertext)` and embeds it in `payload` BEFORE the canonicalizer runs, per [§Signature Safety Under Shred](#signature-safety-under-shred) and Plan-006 §PII Columns 7-step order
- [ ] [§PII Data Map (Three Durability Tiers)](#pii-data-map-three-durability-tiers) enumerates durable + bounded-retention + telemetry-export tiers with owner-plan attribution (Plan-018 / Plan-020 / Plan-022) per [Spec-022 §PII Data Map](../specs/022-data-retention-and-gdpr.md#pii-data-map)
- [ ] Implementation Step 11 reserves the V1.1 ordered Path 1 → Path 2 → Path 3 execution contract with rationale per [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md#shred-fan-out) and §Ordering And Atomicity
- [ ] Cross-plan alignment confirmed: Plan-001 `participant_keys` cascade-barrier-free (Path 1); Plan-018 Postgres deletion targets (Path 2); Plan-020 diagnostic-bucket scoped flush (Path 3); Plan-006 `event.shredded` emission on Path 1 completion
- [ ] All three GDPR stub routes return HTTP 501 with `gdpr.endpoint_not_v1` error code
- [ ] `docs/architecture/contracts/error-contracts.md` documents `gdpr.endpoint_not_v1`
- [ ] `docs/architecture/schemas/local-sqlite-schema.md` documents `participant_keys` + `pii_payload`
- [ ] Spec-022 header `Implementation Plan` row points to this plan

## Tier Intent

This plan lands in **Tier 5** of the [canonical build order](../architecture/cross-plan-dependencies.md#5-canonical-build-order) per BL-045 exit criteria, co-tier with Plan-004, Plan-008, Plan-018, Plan-025 (steps 1–4). Reasoning: Plan-022's schema must be present in Plan-001's Tier 1 migration (forward-declaration per §1 Contested `participant_keys` row), but Plan-022's implementation code paths (store, rotation, wrap-codec) ship at Tier 5 because the operational deletion/export/purge paths are V1.1+ (501 stubs only in V1). `participant_keys` §1 Contested row carries Plan-001 (forward-declarer) + Plan-022 (schema-origin + Tier 5 code paths).

## References

- [Spec-022: Data Retention And GDPR Compliance](../specs/022-data-retention-and-gdpr.md)
- [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md)
- [ADR-010: PASETO WebAuthn MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md) — adjacent for crypto-library consistency (`@noble/hashes`, `@noble/ciphers`)
- [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md)
- [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md)
- [RFC 5869 — HKDF](https://datatracker.ietf.org/doc/html/rfc5869) — HKDF-SHA256 key derivation
- [NIST SP 800-38D](https://csrc.nist.gov/publications/detail/sp/800-38d/final) — AES-GCM normative spec
