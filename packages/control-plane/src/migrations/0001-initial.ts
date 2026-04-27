// Plan-001 PR #4 — initial Collaboration Control Plane Postgres schema (inlined SQL).
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
// this migration (or adding 0002+), copy the per-table block from that
// file verbatim (including `-- Owner:` and per-column comments) so the
// inline constant stays in lockstep with the canonical doc.
//
// ----------------------------------------------------------------------------
// Plan-001 scope (this migration)
// ----------------------------------------------------------------------------
//
// Plan-001 PR #4 owns the physical CREATE for three control-plane tables
// (faithful subset of docs/architecture/schemas/shared-postgres-schema.md):
//
//   * participants         — minimal identity anchor (id, created_at);
//                            Plan-018 ALTERs in display_name/identity_ref/
//                            metadata + identity_mappings side table later.
//                            Created FIRST so session_memberships' FK
//                            REFERENCES participants(id) is resolvable at
//                            CREATE-time (per shared-postgres-schema.md
//                            §Migration-order invariant).
//   * sessions             — session metadata, including min_client_version
//                            forward-declared per ADR-018 §Decision #1
//                            (semver "MAJOR.MINOR" format) and §Decision #3
//                            (monotonic session-floor enforcement). Plan-001
//                            writes NULL by default; Plan-003 attach flow
//                            owns enforcement (BL-090).
//   * session_memberships  — per-(session, participant) record + role/state.
//                            Plan-001 inserts the owner-membership row at
//                            session creation time; Plan-002 extends with
//                            invite-driven membership flows.
//
// Plus the schema_migrations anchor row consumed by the migration runner.
//
// Forward-declared columns (Plan-001 declares the shape; downstream plans
// own the read/write semantics):
//   * sessions.min_client_version — Plan-003 owns attach-time floor check
//     and VERSION_FLOOR_EXCEEDED return per ADR-018 §Decision #4.
//   * participants identity columns (display_name, identity_ref, metadata)
//     and identity_mappings table — Plan-018 adds via additive ALTERs;
//     anchor row shape (id, created_at) is what Plan-001 ships now so
//     FK constraints in Plan-001/002/003 tables resolve at CREATE-time.
//
// ----------------------------------------------------------------------------
// BL-069 invariant carried into the SQL header comments
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
// loss. SessionDirectoryService.createSession implements this contract.
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
-- Owner: Plan-001 PR #4 (minimal identity anchor for FK resolution)
-- Extended by: Plan-018 (identity/profile columns via additive ALTER TABLE)
--
-- Created BEFORE sessions/session_memberships so the FK constraint in
-- session_memberships REFERENCES participants(id) resolves at CREATE-time
-- per shared-postgres-schema.md §Migration-order invariant.
CREATE TABLE participants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Owner: Plan-001 PR #4
CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state           TEXT NOT NULL DEFAULT 'provisioning'
                  CHECK(state IN ('provisioning', 'active', 'archived', 'closed', 'purge_requested', 'purged')),
  config          JSONB NOT NULL DEFAULT '{}',   -- session configuration
  metadata        JSONB NOT NULL DEFAULT '{}',   -- extensible metadata
  min_client_version TEXT,                       -- NULL = no floor; semver "MAJOR.MINOR" per ADR-018 §Decision #1
                                                 -- (format) and §Decision #3 (monotonic session-floor enforcement).
                                                 -- Control plane is authoritative for session metadata (ADR-004);
                                                 -- peers read floor from here at join and reject below-floor
                                                 -- writes with VERSION_FLOOR_EXCEEDED per ADR-018 §Decision #4.
                                                 -- Enforcement owned by Plan-003 attach flow (BL-090).
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_state ON sessions(state);

-- BL-069 invariant: see file-level comment block above for the upsert
-- contract that SessionDirectoryService.createSession implements.

-- Owner: Plan-001 PR #4 | Extended by: Plan-002 (invite-driven membership flows)
CREATE TABLE session_memberships (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id),
  participant_id  UUID NOT NULL REFERENCES participants(id),
  role            TEXT NOT NULL DEFAULT 'viewer'
                  CHECK(role IN ('owner', 'viewer', 'collaborator', 'runtime contributor')),
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK(state IN ('pending', 'active', 'suspended', 'revoked')),
  joined_at       TIMESTAMPTZ,                   -- set when state becomes 'active'
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, participant_id)
);

CREATE INDEX idx_session_memberships_session ON session_memberships(session_id);
CREATE INDEX idx_session_memberships_participant ON session_memberships(participant_id);

-- Schema-version anchor consumed by migration-runner.ts.
CREATE TABLE schema_migrations (
  version         INTEGER NOT NULL PRIMARY KEY,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  description     TEXT
);

INSERT INTO schema_migrations (version, description)
VALUES (1, 'Initial schema');
`;
