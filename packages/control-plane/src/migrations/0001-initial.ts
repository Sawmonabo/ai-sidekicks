// Initial control-plane Postgres schema (inlined SQL).
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file. The rationale mirrors `packages/runtime-daemon/src/
// migrations/0001-initial.ts`:
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
// `docs/architecture/schemas/shared-postgres-schema.md` — when extending
// this migration (or adding a later one), copy the per-table block from
// that file verbatim (including `-- Owner:` and per-column comments) so the
// inline constant stays in lockstep with the canonical doc.
//
// ----------------------------------------------------------------------------
// Scope (this migration)
// ----------------------------------------------------------------------------
//
// Two control-plane tables plus the schema-version anchor consumed by the
// migration runner:
//
//   * participants   — minimal identity anchor (id, created_at). Created
//                      FIRST so `sessions.owner_user_id` can declare its FK
//                      REFERENCES participants(id) at CREATE-time. Later
//                      migrations add the profile columns.
//   * sessions       — session metadata, including the owning user and the
//                      forward-declared `min_client_version` floor. The
//                      session's owner is a single column on this row: one
//                      user owns a session, and ownership is bound at
//                      create time.
//
// Forward-declared columns (the shape ships here; the read/write semantics
// land with the flow that needs them):
//   * sessions.min_client_version — the attach flow owns the floor check and
//     the below-floor rejection. This migration writes NULL by default.
//   * participants identity columns (display_name, identity_ref, metadata)
//     and the identity_mappings side table — added later via additive
//     ALTERs; the anchor row shape (id, created_at) is what ships now so FK
//     constraints resolve at CREATE-time.
//
// ----------------------------------------------------------------------------
// Session-id provenance
// ----------------------------------------------------------------------------
//
// `sessions.id` is daemon-assigned UUID v7 per RFC 9562 for the production
// path. The `gen_random_uuid()` DEFAULT exists for the rare control-plane-
// originated row (admin provisioning). The reconciliation upsert pattern is:
//
//   INSERT INTO sessions (id, ...) VALUES ($1, ...)
//     ON CONFLICT (id) DO UPDATE SET updated_at = sessions.updated_at
//     RETURNING *;
//
// `DO UPDATE` (not `DO NOTHING`) is required so `RETURNING *` always yields
// a row, letting the daemon distinguish retry-after-crash from silent write
// loss. SessionDirectoryService.createSession implements this contract, and
// relies on the returned row carrying the PERSISTED `owner_user_id` so a
// retry with a different owner is rejected rather than applied.
//
// ----------------------------------------------------------------------------
// Why one transactional batch
// ----------------------------------------------------------------------------
//
// Postgres DDL is fully transactional (unlike e.g. MySQL). Wrapping the
// entire migration plus the schema_migrations INSERT in a single
// `BEGIN; ... COMMIT;` ensures a torn write (process kill mid-migration,
// disk error) leaves the database fully unmigrated rather than half-
// migrated. The migration runner (`migration-runner.ts`) executes this
// constant via `db.exec()` after wrapping it in `BEGIN; ... COMMIT;`.

export const INITIAL_MIGRATION_SQL: string = `
-- Minimal identity anchor for FK resolution.
-- Extended later by the identity/profile columns via additive ALTER TABLE.
--
-- Created BEFORE sessions so the FK constraint in
-- sessions.owner_user_id REFERENCES participants(id) resolves at CREATE-time.
CREATE TABLE participants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   UUID NOT NULL REFERENCES participants(id),
                                                 -- The single user who owns this session. No DEFAULT:
                                                 -- an insert that omits the owner fails closed at the
                                                 -- database rather than materializing an ownerless
                                                 -- session. Bound at create time and never rewritten.
  state           TEXT NOT NULL DEFAULT 'provisioning'
                  CHECK(state IN ('provisioning', 'active', 'archived', 'closed', 'purge_requested', 'purged')),
  config          JSONB NOT NULL DEFAULT '{}',   -- session configuration
  metadata        JSONB NOT NULL DEFAULT '{}',   -- extensible metadata
  min_client_version TEXT,                       -- NULL = no floor; semver "MAJOR.MINOR".
                                                 -- The control plane is authoritative for session
                                                 -- metadata; peers read the floor from here and reject
                                                 -- below-floor writes. Enforcement lands with the
                                                 -- attach flow.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_state ON sessions(state);

-- An unindexed FK column forces a sequential scan of sessions on every
-- parent-row mutation in participants, which the erasure flow performs.
CREATE INDEX idx_sessions_owner_user ON sessions(owner_user_id);

-- Schema-version anchor consumed by migration-runner.ts.
CREATE TABLE schema_migrations (
  version         INTEGER NOT NULL PRIMARY KEY,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  description     TEXT
);

INSERT INTO schema_migrations (version, description)
VALUES (1, 'Initial schema');
`;
