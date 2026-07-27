// Plan-006 T2.7 — `daemon_signing_keys`, the per-session sealed-Ed25519
// custody store (inlined SQL).
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file — the same rationale as `0001-initial.ts` through
// `0004-worktree-lifecycle.ts`, whose header spells it out in full: `tsc -b`
// copies no non-TS assets into `dist/`, `package.json` `"files": ["dist"]`
// would exclude `src/migrations/` from the published tarball anyway, and
// bundlers treat `import.meta.url` inconsistently.
//
// The canonical schema source-of-truth is
// `docs/architecture/schemas/local-sqlite-schema.md §Audit Log Crypto Tables (Plan-006)`
// — the block below is copied from that section (its leading comment, the
// CREATE TABLE, and the per-column comments) so the inline constant stays in
// lockstep with the canonical doc, the same discipline
// `0004-worktree-lifecycle.ts` applies to its four blocks. The copy is
// CONTENT-verbatim; the sole difference is line wrapping. This file formerly
// substituted `0005-` for the doc's `0NNN-` migration placeholder, and the
// stable heading anchor `Spec-022 §Daemon Master Key` for the doc's
// `Spec-022` LINE cite; both have since landed in the canonical doc itself,
// so NO content substitution remains. The doc absorbed the longer anchor into
// its existing line rather than re-flowing the rest of the `@napi-rs/keyring`
// sentence, while this copy re-flowed it — so that one sentence breaks at
// different points in the two copies while spelling the same text.
//
// The two governing anchors, in their gate-checkable form:
// `Spec-022 §Daemon Master Key` (the OS-keystore custody ladder the sealing
// master key is drawn from) and `ADR-004 §Decision` (the SQLite-local-state
// boundary that puts this table in local SQLite at all). A third,
// `docs/architecture/security-architecture.md §Per-Event Daemon Signature`,
// governs the public-key half: the roster registration a verifier resolves by
// NodeId. The SQL body below spells that last one the way the schema doc does
// — bare basename, unbackticked — because the body is a doc mirror; the
// backticked form lives here so the anchor is actually verified.
//
// ----------------------------------------------------------------------------
// Plan-006 scope (this migration — version 5)
// ----------------------------------------------------------------------------
//
// ONE table, and deliberately only one. `daemon_signing_keys` holds the
// per-session Ed25519 keypair whose private half signs every `session_events`
// row for that session: the public key as-is (it is published to the session
// participant roster anyway) and the private key SEALED, never in the clear.
// `packages/runtime-daemon/src/events/signing-key-source.ts` is the only module
// that reads or writes it.
//
// WHY LOCAL SQLITE AND NOT SHARED POSTGRES. A daemon signing key is a
// per-machine secret: it attests that THIS node emitted a row, so replicating
// it would both defeat the attestation and put daemon-private key material in
// the control plane. `ADR-004 §Decision` puts node-local execution state in
// SQLite and shared control-plane state in Postgres, and this table is squarely
// the former. (The pre-review Plan-006 draft mis-located the sealed key as a
// column on shared-Postgres `sessions`; corrected 2026-05-28 post-Codex T4
// review — provenance in the Plan-006 Progress Log.)
//
// `rotated_at` SHIPS UNWRITTEN. The column is in the canonical DDL and is
// mirrored faithfully, but no V1 code path sets it: `signing-key-source.ts`
// publishes no rotate operation, and the session_id PRIMARY KEY makes
// re-creation an error rather than a silent re-key. It is forward-declared
// storage for the ADR-010 rotation its own column comment names, on the same
// "get the envelope right in the initial migration" discipline as
// `participant_keys.rotated_at` (pinned NULL in V1 by I-022-10).
//
// The sibling Plan-006 tables are NOT here. `pending_anchor_uploads` ships in
// its own Phase-3 migration alongside the Merkle-anchor service that writes it
// (Plan-006 T3.3), and the `session_events.retention_class` /
// `session_events.stub_signature` columns ship with the compactor (Plan-006
// T3.2) — each additive, each in its own version, per CP-006-6 (Plan-001's
// forward-declared schema in `0001-initial.ts` is never re-shaped).
//
// The `schema_version` anchor table itself is owned by Plan-001
// (`0001-initial.ts`); this migration only INSERTs its version-5 row.

export const DAEMON_SIGNING_KEYS_MIGRATION_SQL: string = `
-- Owner: Plan-006 | Migration: 0005-daemon-signing-keys.ts (Tier 4 Phase 2)
-- Per-session daemon Ed25519 signing keypair. Private key is sealed via the
-- OS keystore master key (@napi-rs/keyring v1.2.0 per Spec-022 §Daemon Master Key
-- — Keychain kSecAttrAccessibleWhenUnlockedThisDeviceOnly on macOS /
-- CRED_TYPE_GENERIC CRED_PERSIST_LOCAL_MACHINE on Windows / Secret Service via
-- libsecret + kwallet6 + keyutils fallback on Linux). Public key is registered
-- in the session participant roster at join time per security-architecture.md
-- §Per-Event Daemon Signature. Sealed-key storage
-- lives in local SQLite (NOT shared-Postgres sessions) per ADR-004 SQLite-
-- local-state boundary — daemon-private secrets are per-machine.
CREATE TABLE daemon_signing_keys (
  session_id          TEXT PRIMARY KEY,
  public_key          BLOB NOT NULL,         -- Ed25519 32-byte public key
  sealed_private_key  BLOB NOT NULL,         -- Ed25519 private key sealed via OS keystore master key
  created_at          TEXT NOT NULL,
  rotated_at          TEXT                   -- non-NULL when key has been rotated per ADR-010
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (5, datetime('now'), 'Daemon signing keys (daemon_signing_keys)');
`;
