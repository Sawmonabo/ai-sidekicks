// Fourth Control Plane Postgres migration (inlined SQL).
// Adds the `event_log_anchors` table.
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file. The rationale mirrors `migrations/0001-initial.ts`,
// `migrations/0002-session-invites.ts`, and `migrations/0003-runtime-nodes.ts`:
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
// The canonical schema source-of-truth's integrity-witness block is
// reproduced VERBATIM below including the `-- Owner: ` stamp, the four-line
// V1-scope comment, every per-column comment, the `CHECK`, and the four-line
// UNIQUE-key rationale, so the inline constant stays in lockstep with the
// canonical doc. Any column-shape edit (add/remove/rename/CHECK change) MUST
// land first in the canonical doc per AGENTS.md "doc-first ordering". That doc
// block is itself marked **Forward-declared** with this migration named as its
// shipping vehicle — this file is that shipment.
//
// ----------------------------------------------------------------------------
// Why a metadata-only table does not contradict
// ----------------------------------------------------------------------------
//
// A table named `event_log_anchors` in the SHARED Postgres schema reads, at a
// glance, like exactly the thing that decision refused — which is why the
// canonical schema doc's own invariant list calls it out by name and why the
// exclusion is restated here.
//
// The distinction is what the row CONTAINS. An anchor is a Merkle root, a
// signature over it, the emitting node, and the sequence range it covers —
// seven columns of metadata that let a reader VERIFY a log they must obtain
// from the daemon, and that reveal nothing about what the log says. No payload,
// no event bodies, no PII.
//
// ----------------------------------------------------------------------------
// V1 scope: session-scoped anchors only
// ----------------------------------------------------------------------------
//
// The daemon's upload worker filters them out by that sentinel; the FK is the
// backstop if it ever stops.
//
// ----------------------------------------------------------------------------
// Cross-plan boundary — NOT modified by this migration
// ----------------------------------------------------------------------------
//
//   * `sessions` — owns the table. `sessions` ships in v1 (`0001-initial`), so
//     the FK resolves at this migration's CREATE time.
//   * `sessions/migration-runner.ts` — owns the runner. This SQL is wired into the
//     canonical `applyMigrations()` per-version loop by appending `{ version: 4, sql:
//     EVENT_LOG_ANCHORS_MIGRATION_SQL }` to `MIGRATIONS` (after the v3), in the SAME
//     change set, so deployers pulling `develop` apply v1 through v4 automatically.
//
// ----------------------------------------------------------------------------
// Why one transactional batch
// ----------------------------------------------------------------------------
//
// Postgres DDL is fully transactional. The runner wraps the entire migration
// plus the schema_migrations INSERT in a single `querier.transaction(...)`
// boundary (mirroring how `applyMigrations` wraps the earlier versions) so a
// torn write (process kill mid-migration, disk error) leaves the database fully
// at v3, never half-migrated to "v4 partial". The migration SQL itself does NOT
// contain `BEGIN;`/`COMMIT;` — the transaction boundary is owned by the caller,
// identical to `INITIAL_MIGRATION_SQL` and `RUNTIME_NODES_MIGRATION_SQL`.
//

export const EVENT_LOG_ANCHORS_MIGRATION_SQL: string = `
-- Owner: Witness-only storage: Merkle roots + signatures for per-daemon local event logs. Event
-- payloads remain on the emitting daemon's local SQLite; never uploaded here. V1 scope:
-- SESSION-scoped anchors only. The non-null session_id FK below is correct under this scope: only
-- session-scoped anchors land here.
CREATE TABLE event_log_anchors (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL REFERENCES sessions(id),
  node_id           TEXT NOT NULL,                    -- emitting daemon's NodeId (roster key)
  start_sequence    BIGINT NOT NULL,                  -- first session_events.sequence in anchor range
  end_sequence      BIGINT NOT NULL,                  -- last session_events.sequence in anchor range
  merkle_root       BYTEA NOT NULL,                   -- 32 bytes; BLAKE3 Merkle root over row_hash leaves
  root_signature    BYTEA NOT NULL,                   -- 64 bytes; Ed25519 signature over merkle_root by emitting daemon
  anchored_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_sequence >= start_sequence),
  -- end_sequence is part of the key (mirrors local pending_anchor_uploads): a cadence anchor
  -- [1,1000] and a wider compaction-covering anchor [1,5000] share start_sequence=1 and MUST
  -- coexist, so the daemon's ON CONFLICT DO NOTHING upload dedups only genuine re-uploads of the
  -- identical range. "Covering anchor" at verify time is a coverage test (start_sequence <=
  -- range_start AND end_sequence >= range_end) not exact-start.
  UNIQUE(session_id, node_id, start_sequence, end_sequence)
);

CREATE INDEX idx_event_log_anchors_session ON event_log_anchors(session_id, anchored_at DESC);
CREATE INDEX idx_event_log_anchors_node ON event_log_anchors(node_id, anchored_at DESC);

INSERT INTO schema_migrations (version, description)
VALUES (4, 'Event log anchors (integrity witness)');
`;
