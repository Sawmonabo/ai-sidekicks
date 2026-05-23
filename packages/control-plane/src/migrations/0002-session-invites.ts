// Plan-002 PR #102 — second Collaboration Control Plane Postgres migration
// (inlined SQL). Adds the `session_invites` table required by Plan-002 Phase 1.
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file. The rationale mirrors `migrations/0001-initial.ts`:
//
//   1. The build pipeline (`tsc -b`) does NOT copy non-TS assets into
//      `dist/`. Any FS-relative load path (`new URL(..., import.meta.url)`)
//      would resolve correctly under `vitest` (running against `src/`) but
//      throw `ENOENT` at first dist-from-import use.
//   2. `package.json` `"files": ["dist"]` would exclude `src/migrations/`
//      from the published tarball anyway.
//   3. Bundlers handle `import.meta.url` inconsistently; inline strings
//      survive every transform stage.
//
// The canonical schema source-of-truth is
// `docs/architecture/schemas/shared-postgres-schema.md` — the `session_invites`
// block (lines 92-111) is reproduced VERBATIM below including `-- Owner:` and
// per-column comments so the inline constant stays in lockstep with the
// canonical doc. Any column-shape edit (add/remove/rename/CHECK change) MUST
// land first in the canonical doc per AGENTS.md "doc-first ordering".
//
// ----------------------------------------------------------------------------
// Plan-002 scope (this migration)
// ----------------------------------------------------------------------------
//
// Plan-002 Phase 1 owns the physical CREATE for ONE control-plane table
// (verbatim subset of docs/architecture/schemas/shared-postgres-schema.md
// §Session Invites):
//
//   * session_invites — invite records, durable until terminal state per
//                       Spec-002 §State And Data Implications line 155.
//                       FK references `sessions(id)` (Plan-001) and
//                       `participants(id)` (Plan-001 anchor + Plan-018
//                       additive extensions). Created AFTER 0001 because
//                       both FKs must resolve at CREATE-time per
//                       shared-postgres-schema.md §Migration-order invariant.
//
// Plus the schema_migrations anchor row consumed by the migration runner
// (`(version, description) = (2, 'session_invites table')`).
//
// ----------------------------------------------------------------------------
// Cross-plan boundary — NOT modified by this migration
// ----------------------------------------------------------------------------
//
// The following adjacent surfaces are deliberately untouched:
//
//   * `session_memberships` — Plan-001 owns the table per
//     `docs/architecture/cross-plan-dependencies.md` §1. This migration only
//     REFERENCES it via the inviter_id → participants(id) chain, never
//     ALTERs it. Plan-002's invite-driven membership flows mutate
//     session_memberships at the service layer via INSERT/UPDATE, not via
//     DDL.
//   * `sessions/migration-runner.ts` — Plan-001 owns the runner. Its
//     docstring at lines 151-158 anticipates v2 expansion via a per-version
//     loop, BUT wiring v2 into the runner is deferred to a downstream
//     Plan-002 PR (the service-layer PR where the table is actually read /
//     written). Adding v2 to the runner here would force a third commit on
//     Plan-001-owned code in this PR with no service-layer consumer to
//     justify it. The co-located test
//     (`__tests__/0002-session-invites.test.ts`) verifies the v2 SQL applies
//     cleanly via direct `tx.exec()` after v1 is applied via the runner,
//     proving the SQL is correct without forcing the runner-wiring rollout.
//
// ----------------------------------------------------------------------------
// I-002-3 — Presence is ephemeral, verified by omission
// ----------------------------------------------------------------------------
//
// Per Plan-002 §Invariants I-002-3 (and Spec-002 §State And Data Implications
// line 157), presence state (Yjs Awareness CRDT) is in-memory only and MUST
// NOT be persisted to a durable Postgres table. This migration creates
// `session_invites` ONLY — no presence-state table is created here, and no
// future column on `session_invites` carries presence-summary data. The
// invariant is preserved by omission. A broader regression test (P10 in
// Plan-002 §Test Plan, owned by task T2.5) asserts no presence-state table
// exists anywhere in the schema post-migration; the co-located test in this
// PR runs a narrow local guard (`information_schema.tables LIKE '%presence%'`
// returns empty after v1 + v2) so a stray CREATE TABLE in THIS migration
// would surface here as well as in T2.5.
//
// ----------------------------------------------------------------------------
// Token trust boundary
// ----------------------------------------------------------------------------
//
// Per Spec-002 §Token Security Properties (lines 107-113), the raw PASETO
// v4.local token is NEVER persisted: the control plane stores only the
// SHA-256 hash in `session_invites.token_hash`. The UNIQUE constraint on
// `token_hash` is the storage-layer enforcement of single-use semantics
// (Spec-002 line 109: "A token is consumed on first successful accept... The
// control plane sets the invite state to `accepted` atomically").
//
// ----------------------------------------------------------------------------
// Why one transactional batch
// ----------------------------------------------------------------------------
//
// Postgres DDL is fully transactional. The test caller wraps the entire
// migration plus the schema_migrations INSERT in a single `pg.transaction(...)`
// boundary (mirroring how `applyMigrations` wraps v1) so a torn write (process
// kill mid-migration, disk error) leaves the database fully at v1, never
// half-migrated to "v2 partial". The migration SQL itself does NOT contain
// `BEGIN;`/`COMMIT;` — the transaction boundary is owned by the caller,
// identical to `INITIAL_MIGRATION_SQL`.

export const SESSION_INVITES_MIGRATION_SQL: string = `
-- Owner: Plan-002
CREATE TABLE session_invites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id),
  inviter_id      UUID NOT NULL REFERENCES participants(id),
  token_hash      TEXT NOT NULL UNIQUE,          -- hashed invite token (never store plaintext)
  join_mode       TEXT NOT NULL DEFAULT 'viewer'
                  CHECK(join_mode IN ('viewer', 'collaborator', 'runtime contributor')),
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK(state IN ('pending', 'accepted', 'expired', 'revoked')),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_session_invites_session ON session_invites(session_id);
CREATE INDEX idx_session_invites_state ON session_invites(state) WHERE state = 'pending';

INSERT INTO schema_migrations (version, description)
VALUES (2, 'session_invites table');
`;
