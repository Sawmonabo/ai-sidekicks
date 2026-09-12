// PR #145 — third Control Plane Postgres migration (inlined SQL).
// Adds the `runtime_node_attachments` and `runtime_node_presence` tables.
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file. The rationale mirrors `migrations/0001-initial.ts` and
// `migrations/0002-session-invites.ts`:
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
// The canonical schema source-of-truth is) block is reproduced VERBATIM below
// including both `-- Owner: ` stamps, every per-column comment, and the
// multi-line comment on `idx_node_attachments_active`, so the inline constant
// stays in lockstep with the canonical doc. Any column-shape edit
// (add/remove/rename/CHECK change) MUST land first in the canonical doc per
// AGENTS.md "doc-first ordering".
//
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
//
// Owns the physical CREATE for TWO control-plane tables (verbatim subset
// of) — does NOT create these (header the `-- Owner: ` stamps in the
// canonical schema):
//
//   * runtime_node_attachments — durable runtime-node attach records for
//                       FK references `sessions(id)` and `users(id)` — BOTH ship in v1
//                       (`0001-initial`), so both FKs resolve at this migration's CREATE-time.
//   * runtime_node_presence — per-node heartbeat/health coordination record
//                       (`node_id` PRIMARY KEY; no FK).
//
// Plus the schema_migrations anchor row consumed by the migration runner
// (`(version, description) = (3, 'Runtime node attachments and presence')`).
//
// ----------------------------------------------------------------------------
// Boundary — why this CREATE TABLE runtime_node_presence is sanctioned
// ----------------------------------------------------------------------------
//
// Keeps COLLABORATIVE presence (Yjs Awareness CRDT — cursors/awareness)
// in-memory only. `runtime_node_presence` is a DIFFERENT domain: runtime-node
// LIVENESS (heartbeat + `health_state`), a durable coordination record
// sanctioned and — so this CREATE does NOT violate.
//
// ----------------------------------------------------------------------------
// Cross-plan boundary — NOT modified by this migration
// ----------------------------------------------------------------------------
//
// The following adjacent surfaces are deliberately untouched:
//
//   * `sessions` — owned by the initial migration. This migration does NOT
//     reference, ALTER, or mutate it. The attach and detach flows write ONLY
//     `runtime_node_attachments` / `runtime_node_presence`, at the service
//     layer, never via DDL.
//   * `sessions.min_client_version` — forward-declared by the initial
//     migration; the attach flow READS it. This migration neither re-declares
//     nor ALTERs it.
//   * `sessions/migration-runner.ts` — this SQL is wired into the canonical
//     `applyMigrations()` per-version loop by appending
//     `{ version: 3, sql: RUNTIME_NODES_MIGRATION_SQL }` to `MIGRATIONS` so
//     deployers pulling `develop` apply every registered version
//     automatically. Coverage is split: the co-located
//     `__tests__/0003-runtime-nodes.test.ts` exercises this v3 SQL via direct
//     `tx.exec()` (`applyRuntimeNodesMigration` helper) as a SQL-layer
//     regression backstop; `sessions/__tests__/migration-runner.test.ts` pins
//     the canonical runner-loop path (fresh-DB apply + idempotency).
//
// ----------------------------------------------------------------------------
// Why one transactional batch
// ----------------------------------------------------------------------------
//
// Postgres DDL is fully transactional. The runner wraps the entire migration
// plus the schema_migrations INSERT in a single `querier.transaction(...)`
// boundary (mirroring how `applyMigrations` wraps v1) so a torn write
// (process kill mid-migration, disk error) leaves the database fully at the
// previous version, never half-migrated to "v3 partial". The migration SQL
// itself does NOT contain `BEGIN;`/`COMMIT;` — the transaction boundary is
// owned by the caller, identical to `INITIAL_MIGRATION_SQL`.

export const RUNTIME_NODES_MIGRATION_SQL: string = `
CREATE TABLE runtime_node_attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id),
  user_id  UUID NOT NULL REFERENCES users(id),
  node_id         TEXT NOT NULL,                 -- daemon-assigned node identifier
  capabilities    JSONB NOT NULL DEFAULT '{}',   -- declared capabilities
  client_version  TEXT NOT NULL,                 -- daemon semver "MAJOR.MINOR" at attach; floor-compared vs sessions.min_client_version — makes the read-only verdict auditable + roster-displayable
  state           TEXT NOT NULL DEFAULT 'registering'
                  CHECK(state IN ('registering', 'online', 'degraded', 'offline', 'revoked')),
  attached_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_node_attachments_session ON runtime_node_attachments(session_id);
CREATE INDEX idx_node_attachments_user ON runtime_node_attachments(user_id);
CREATE UNIQUE INDEX idx_node_attachments_node ON runtime_node_attachments(node_id, session_id);
-- One-active-session enforcement ("one active session at a time in v1"): a node has at most one
-- attachment in an active state across all sessions. The partial UNIQUE constrains only
-- active-state rows, so an inactive ('offline' or 'revoked') row does not block a later (re)attach
-- at the index level. Reattach eligibility is then a application decision: an 'offline' row is
-- reactivated on reconnect, while a 'revoked' row is refused — revocation is terminal (P10).
CREATE UNIQUE INDEX idx_node_attachments_active ON runtime_node_attachments(node_id)
  WHERE state IN ('registering', 'online', 'degraded');

CREATE TABLE runtime_node_presence (
  node_id             TEXT NOT NULL PRIMARY KEY,
  last_heartbeat_at   TIMESTAMPTZ NOT NULL,
  health_state        TEXT NOT NULL DEFAULT 'online'
                      CHECK(health_state IN ('online', 'degraded', 'offline'))
);

INSERT INTO schema_migrations (version, description)
VALUES (3, 'Runtime node attachments and presence');
`;
