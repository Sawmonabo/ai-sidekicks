# Plan-022: Data Retention And GDPR Compliance

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `022` |
| **Slug** | `data-retention-and-gdpr` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude Opus 4.7` |
| **Spec** | [Spec-022: Data Retention And GDPR Compliance](../specs/022-data-retention-and-gdpr.md) |
| **Required ADRs** | [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | Plan-001 (this plan forward-declares a column on Plan-001's `session_events` table and contributes `participant_keys` to Plan-001's initial SQLite migration); Plan-007 (local daemon IPC host for the 501 GDPR stub routes) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Ship the V1 **schema and write-path** of the Spec-022 crypto-shredding model so that every event written in V1 lands with its PII encrypted under a per-participant key. Operational deletion/export/purge flows are V1.1+ and this plan leaves behind a minimal, unambiguous surface (501 Not Implemented stubs + reserved routes) rather than silent non-existence.

## Scope

- Create the `participant_keys` SQLite table (schema per Spec-022 §Participant Keys) owned by this plan, populated on first participant provisioning.
- **Forward-declare** the `session_events.pii_payload BLOB` column onto Plan-001's initial SQLite migration `0001-initial.sql` so Tier 1 ships a schema already compatible with crypto-shredding. Plan-001's migration inherits this constraint at authoring time (Session 4 / post-BL-054 propagation).
- Daemon master-key bootstrap: OS keychain primary (macOS Keychain, Windows DPAPI/Credential Manager, Linux libsecret via `keytar`); file fallback at `${XDG_DATA_HOME:-~/.local/share}/ai-sidekicks/daemon/master-key` (mode `0600`, base64-encoded 32 bytes) when keychain is unavailable.
- Per-participant key derivation: HKDF-SHA256 (RFC 5869) with `info = "ais.participant.v1" || participant_id`, `salt = null`, `ikm` = participant authentication material passed by Plan-018 at provisioning time; derived key is the AES-256 content key.
- PII encryption format: AES-256-GCM with `AAD = participant_id || event_id`, 12-byte random nonce, wire format `iv || ciphertext || tag`. Written to `session_events.pii_payload` by every event writer that emits PII.
- Master-key wrap for `participant_keys.encrypted_key_blob`: AES-256-GCM with `AAD = participant_id || "ais.master-wrap.v1"`. **Spec-022 does not name the wrap cipher; this plan fixes it to AES-256-GCM to match the PII cipher for implementation economy (single audited primitive).**
- PII splitter: a pure function over Spec-006 event taxonomy that routes fields into `{payload, pii_payload}` based on the taxonomy's `pii:true` marker. Non-PII events write a NULL `pii_payload`.
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
- [x] `@noble/hashes` and `@noble/ciphers` crypto-library decision (ADR-010 §Relay Authentication — already fixed to `@noble` v2.x for V1)
- [ ] Plan-001 is authored and accepts the forward-declaration (actioned in Session 4 per BL-054)
- [ ] Spec-006 event taxonomy has a per-event `pii:true|false` marker (BL-087 follow-up work for shared-log taxonomy; this plan assumes the marker exists at implementation time)

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

### SQLite: `participant_keys` (new, owned by Plan-022)

```sql
CREATE TABLE participant_keys (
  participant_id      TEXT    NOT NULL PRIMARY KEY,
  encrypted_key_blob  BLOB    NOT NULL,            -- AES-256-GCM-wrapped AES-256 key
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

## Implementation Steps

1. Add `@noble/hashes` (HKDF-SHA256) and `@noble/ciphers` (AES-256-GCM) to `packages/runtime-daemon/package.json` at the same major versions pinned by ADR-010 for relay encryption (implementation economy: one audited crypto surface).
2. Implement `packages/runtime-daemon/src/config/master-key-source.ts` with keychain-primary (via `keytar`) and file-fallback (`${XDG_DATA_HOME:-~/.local/share}/ai-sidekicks/daemon/master-key`, mode `0600`) bootstrap. Emit `daemon.master_key_source` event on resolution.
3. Implement `packages/runtime-daemon/src/crypto/participant-key-deriver.ts`: HKDF-SHA256 with `info = "ais.participant.v1" || participant_id`, returns 32-byte AES-256 key.
4. Implement `packages/runtime-daemon/src/crypto/wrap-codec.ts`: AES-256-GCM wrap with `AAD = participant_id || "ais.master-wrap.v1"`.
5. Implement `packages/runtime-daemon/src/persistence/participant-keys/participant-keys-store.ts`: CRUD on `participant_keys` using `wrap-codec`; provides `ensureKeyFor(participantId, ikm)` idempotent provisioning.
6. Implement `packages/runtime-daemon/src/crypto/pii-codec.ts`: AES-256-GCM with `AAD = participant_id || event_id`, 12-byte random nonce, wire format `iv || ciphertext || tag`.
7. Implement `packages/runtime-daemon/src/persistence/session-events/write-with-pii.ts`: PII splitter consuming Spec-006 taxonomy's `pii:true|false` marker; returns `{payload, pii_payload}`. Consumed by Plan-001's event-writer helper on integration.
8. Forward-declare schema: during Plan-001 authoring (Session 4), migration `0001-initial.sql` must include `pii_payload BLOB` on `session_events` and the full `participant_keys` CREATE TABLE. Capture this dependency in BL-054's propagation pass.
9. Implement `packages/runtime-daemon/src/http/gdpr-stub-routes.ts`: three 501 handlers returning `gdpr.endpoint_not_v1`; registered via Plan-007's IPC host.
10. Document the new error code in `docs/architecture/contracts/error-contracts.md` and the new schema elements in `docs/architecture/schemas/local-sqlite-schema.md`.

## Parallelization Notes

- Steps 1–7 (crypto + store) are independent of Plan-001 authoring and can land in parallel with Plan-001's skeleton once Plan-001 reaches the migration-authoring stage.
- Step 8 (forward-declaration into Plan-001's migration) is the integration point and must not be skipped; BL-054's propagation pass is the coordination mechanism.
- Step 9 (501 stubs) depends only on Plan-007's IPC host being present; fully parallelizable with any other Plan-022 step.

## Test And Verification Plan

- **Unit, `pii-codec`**: round-trip (encrypt → decrypt) plus AAD-mismatch test (decrypt with wrong `participant_id` MUST fail). NIST GCM test vectors (SP 800-38D Appendix B) for baseline AES-256-GCM correctness.
- **Unit, `participant-key-deriver`**: RFC 5869 test vectors (Appendix A, A.1–A.3) for HKDF-SHA256.
- **Unit, `wrap-codec`**: AAD mismatch (wrong `participant_id` in wrap AAD) MUST fail decrypt.
- **Unit, `pii-splitter`**: given a fixture of Spec-006 event types (some PII, some not), confirm routing is correct.
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
- If a PII-splitter taxonomy marker is missing for a specific event type, the splitter's default policy is **route to `pii_payload`** (err on side of encryption). Emit a `daemon.pii_taxonomy_missing` event with the event type for operator audit. This is a containment fallback, not a rollback.
- If the forward-declaration onto Plan-001's migration is missed during Session 4 integration, the schema drift is a build-time failure — the "Integration, migration" test catches it before merge.

## Risks And Blockers

- **Risk**: Spec-006 event taxonomy marker (`pii:true|false`) is not in place at implementation time. **Mitigation**: splitter defaults to PII routing; BL-087 follow-up tracks taxonomy completion.
- **Risk**: `keytar` drops a platform backend (historically libsecret on some distros). **Mitigation**: file fallback is always live; platform-coverage tests exercise both paths.
- **Risk**: HKDF `ikm` source (participant authentication material from Plan-018) may not be stable across password-change events. **Mitigation**: V1 scopes rotation out entirely; Plan-018's identity model must document that auth-credential changes do not mutate the HKDF `ikm` in V1, or key rotation becomes mandatory.
- **Blocker**: Plan-001 authoring (Session 4). The forward-declaration onto migration 0001 must be accepted during Plan-001 drafting. BL-054 is the propagation mechanism.

## Done Checklist

- [ ] `participant_keys` table schema matches Spec-022 §Participant Keys exactly
- [ ] Plan-001 migration 0001 includes `session_events.pii_payload BLOB` and the full `participant_keys` CREATE TABLE (forward-declaration accepted)
- [ ] AES-256-GCM PII encryption round-trips with `AAD = participant_id || event_id`
- [ ] HKDF-SHA256 derivation passes RFC 5869 test vectors
- [ ] AES-256-GCM master-key wrap round-trips with `AAD = participant_id || "ais.master-wrap.v1"`
- [ ] OS keychain bootstrap succeeds on macOS and Windows; file fallback succeeds on Linux-without-libsecret
- [ ] PII splitter routes Spec-006 events correctly per the `pii` marker; missing-marker events default to PII
- [ ] All three GDPR stub routes return HTTP 501 with `gdpr.endpoint_not_v1` error code
- [ ] `docs/architecture/contracts/error-contracts.md` documents `gdpr.endpoint_not_v1`
- [ ] `docs/architecture/schemas/local-sqlite-schema.md` documents `participant_keys` + `pii_payload`
- [ ] Spec-022 header `Implementation Plan` row points to this plan

## Tier Intent

This plan lands in **Tier 2** of the canonical build order per BL-045 exit criteria. Reasoning: Plan-022's schema must be present in Plan-001's Tier 1 migration (forward-declaration), but Plan-022's code paths can ship alongside Plan-002 in Tier 2 because the operational deletion/export/purge paths are V1.1+ (501 stubs only in V1). BL-054's cross-plan-dependencies.md §5 propagation pass will move `participant_keys` ownership from the current placeholder `Spec-022` row to a `Plan-022` row, and place Plan-022 in Tier 2 alongside Plan-002.

## References

- [Spec-022: Data Retention And GDPR Compliance](../specs/022-data-retention-and-gdpr.md)
- [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md)
- [ADR-010: PASETO WebAuthn MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md) — adjacent for crypto-library consistency (`@noble/hashes`, `@noble/ciphers`)
- [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md)
- [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md)
- [RFC 5869 — HKDF](https://datatracker.ietf.org/doc/html/rfc5869) — HKDF-SHA256 key derivation
- [NIST SP 800-38D](https://csrc.nist.gov/publications/detail/sp/800-38d/final) — AES-GCM normative spec
