// `daemon_signing_keys`, the per-session sealed-Ed25519 custody store
// (inlined SQL).
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file — the same rationale as `0001-initial.ts` through
// `0004-worktree-lifecycle.ts`, whose header spells it out in full: `tsc -b`
// copies no non-TS assets into `dist/`, `package.json` `"files": ["dist"]`
// would exclude `src/migrations/` from the published tarball anyway, and
// bundlers treat `import.meta.url` inconsistently.
//
// The block below (its leading comment, the CREATE TABLE, and the per-column
// comments) is a CONTENT-verbatim copy of the canonical schema, the same
// discipline `0004-worktree-lifecycle.ts` applies to its four blocks. The sole
// difference is line wrapping.
//
// The public-key half — the roster registration a verifier resolves by NodeId —
// is governed separately and is not created here.
//
// ----------------------------------------------------------------------------
// Scope (this migration — version 5)
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
// the control plane. puts node-local execution state in SQLite and shared
// control-plane state in Postgres, and this table is squarely the former. (The
// pre-review draft mis-located the sealed key as a column on shared-Postgres
// `sessions`; corrected 2026-05-28 post-Codex T4 review — provenance Progress
// Log.)
//
// It is reserved storage for a rotation ceremony no V1 document specifies —
// V1's rotation policy is refusal — kept on the same "get the envelope right
// in the initial migration" discipline as `participant_keys.rotated_at`
// (pinned NULL in V1).
//
// The sibling tables are NOT here. `pending_anchor_uploads` ships in its own
// Phase-3 migration alongside the Merkle-anchor service that writes it, and
// the `session_events.retention_class` / `session_events.stub_signature`
// columns ship with the compactor — each additive, each in its own version.
//
// The `schema_version` anchor table itself is this migration only
// INSERTs its version-5 row.

export const DAEMON_SIGNING_KEYS_MIGRATION_SQL: string = `
-- Owner: | Migration: 0005-daemon-signing-keys.ts (Tier 4 Phase 2) Per-session
-- daemon Ed25519 signing keypair. Private key is sealed via the OS keystore
-- master key (@napi-rs/keyring v1.2.0 — Keychain
-- kSecAttrAccessibleWhenUnlockedThisDeviceOnly on macOS / CRED_TYPE_GENERIC
-- CRED_PERSIST_LOCAL_MACHINE on Windows / Secret Service via libsecret +
-- kwallet6 + keyutils fallback on Linux). Public key is registered in the
-- session participant roster at join time. Sealed-key storage lives in local
-- SQLite (NOT shared-Postgres sessions) SQLite- local-state boundary —
-- daemon-private secrets are per-machine. rotated_at is reserved and unwritten
-- in V1: no daemon signing-key rotation ceremony is specified anywhere (a
-- different-key registration is refused); only a future rotation extension
-- writes it.
CREATE TABLE daemon_signing_keys (
  session_id          TEXT PRIMARY KEY,
  public_key          BLOB NOT NULL,         -- Ed25519 32-byte public key
  sealed_private_key  BLOB NOT NULL,         -- Ed25519 private key sealed via OS keystore master key
  created_at          TEXT NOT NULL,
  rotated_at          TEXT                   -- reserved; see rotation note above
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (5, datetime('now'), 'Daemon signing keys (daemon_signing_keys)');
`;
