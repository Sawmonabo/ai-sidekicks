// Plan-006 T3.3 — fourth Collaboration Control Plane Postgres migration
// (inlined SQL). Adds the `event_log_anchors` table required by Plan-006
// Phase 3 (the control-plane integrity witness for per-daemon event logs).
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
// The canonical schema source-of-truth is
// `docs/architecture/schemas/shared-postgres-schema.md` — the §Event Log
// Anchors (Plan-006 — Integrity Witness) block is reproduced VERBATIM below
// including the `-- Owner: Plan-006` stamp, the four-line V1-scope comment,
// every per-column comment, the `CHECK`, and the four-line UNIQUE-key
// rationale, so the inline constant stays in lockstep with the canonical doc.
// Any column-shape edit (add/remove/rename/CHECK change) MUST land first in the
// canonical doc per AGENTS.md "doc-first ordering". That doc block is itself
// marked **Forward-declared** with this migration named as its shipping
// vehicle — this file is that shipment.
//
// ----------------------------------------------------------------------------
// Why a metadata-only table does not contradict ADR-017
// ----------------------------------------------------------------------------
//
// ADR-017 rejected a shared event log for V1: events live on the emitting
// daemon's local SQLite and are never uploaded. A table named
// `event_log_anchors` in the SHARED Postgres schema reads, at a glance, like
// exactly the thing that decision refused — which is why the canonical schema
// doc's own invariant list calls it out by name and why the exclusion is
// restated here.
//
// The distinction is what the row CONTAINS. An anchor is a Merkle root, a
// signature over it, the emitting node, and the sequence range it covers —
// seven columns of metadata that let a reader VERIFY a log they must obtain
// from the daemon, and that reveal nothing about what the log says. No payload,
// no event bodies, no PII. Plan-006's I-006-3-02 is that constraint, and it is
// enforced structurally at the wire boundary by `AnchorPayload` in
// `@ai-sidekicks/contracts` (an exact seven-member `.strict()` schema, so an
// upload carrying a `payload` member is REFUSED rather than silently stripped),
// not merely asserted by this comment.
//
// ----------------------------------------------------------------------------
// V1 scope: session-scoped anchors only
// ----------------------------------------------------------------------------
//
// `session_id` carries a NOT NULL FK to `sessions(id)`, which is correct under
// V1 scope and is also the mechanism that enforces it. Daemon-scope
// (sentinel-partitioned) chains anchor LOCALLY in the daemon's
// `pending_anchor_uploads` and are never upload candidates: the sentinel Max
// UUID satisfies no `sessions(id)` row, and control-plane node-scope witnessing
// needs a node-identity trust anchor that ADR-017 §Node-Scope Anchor Witnessing
// defers to V1.1. The daemon's upload worker filters them out by that sentinel;
// the FK is the backstop if it ever stops.
//
// ----------------------------------------------------------------------------
// Cross-plan boundary — NOT modified by this migration
// ----------------------------------------------------------------------------
//
//   * `sessions` — Plan-001 owns the table per
//     `docs/architecture/cross-plan-dependencies.md` §1. This migration
//     REFERENCES it and neither ALTERs nor re-declares it. `sessions` ships in
//     v1 (`0001-initial`), so the FK resolves at this migration's CREATE time
//     per shared-postgres-schema.md §Migration-order invariant (v4 lands after
//     v1).
//   * `sessions/migration-runner.ts` — Plan-001 owns the runner. This SQL is
//     wired into the canonical `applyMigrations()` per-version loop by
//     appending `{ version: 4, sql: EVENT_LOG_ANCHORS_MIGRATION_SQL }` to
//     `MIGRATIONS` (after Plan-003's v3), in the SAME change set, so deployers
//     pulling `develop` apply v1 through v4 automatically. Coverage is split
//     the way Plan-003's is: the co-located `__tests__/0004-event-log-anchors.test.ts`
//     exercises this v4 SQL via direct `tx.exec()` as a SQL-layer regression
//     backstop, while `sessions/__tests__/migration-runner.test.ts` pins the
//     canonical runner-loop path.
//
// ----------------------------------------------------------------------------
// Why one transactional batch
// ----------------------------------------------------------------------------
//
// Postgres DDL is fully transactional. The runner wraps the entire migration
// plus the schema_migrations INSERT in a single `querier.transaction(...)`
// boundary (mirroring how `applyMigrations` wraps v1 through v3) so a torn
// write (process kill mid-migration, disk error) leaves the database fully at
// v3, never half-migrated to "v4 partial". The migration SQL itself does NOT
// contain `BEGIN;`/`COMMIT;` — the transaction boundary is owned by the caller,
// identical to `INITIAL_MIGRATION_SQL`, `SESSION_INVITES_MIGRATION_SQL`, and
// `RUNTIME_NODES_MIGRATION_SQL`.
//
// Spec coverage: `Spec-006 §Anchoring Cadence` (the seven-member anchor
// payload this table stores). Verifies invariant: I-006-3-02 (metadata-only
// witness). Refs: Plan-006 T3.3, ADR-017, BL-050,
// `docs/architecture/schemas/shared-postgres-schema.md` §Event Log Anchors.

export const EVENT_LOG_ANCHORS_MIGRATION_SQL: string = `
-- Owner: Plan-006 (BL-050; T3.3 additive control-plane migration)
-- Witness-only storage: Merkle roots + signatures for per-daemon local event logs.
-- Event payloads remain on the emitting daemon's local SQLite; never uploaded here.
-- V1 scope: SESSION-scoped anchors only. Node-scope (sentinel-partitioned, daemon-scope) chains
-- are witnessed locally only in V1 -- control-plane upload requires a node-identity trust anchor and
-- is a V1.1 extension (ADR-017 §Node-Scope Anchor Witnessing; Spec-006 §Daemon-Scope Event Binding).
-- The non-null session_id FK below is correct under this scope: only session-scoped anchors land here.
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
  -- end_sequence is part of the key (mirrors local pending_anchor_uploads): a cadence anchor [1,1000] and a wider
  -- compaction-covering anchor [1,5000] share start_sequence=1 and MUST coexist, so the daemon's ON CONFLICT DO NOTHING
  -- upload dedups only genuine re-uploads of the identical range. "Covering anchor" at verify time is a coverage test
  -- (start_sequence <= range_start AND end_sequence >= range_end) per Spec-006 §Post-Compaction Integrity, not exact-start.
  UNIQUE(session_id, node_id, start_sequence, end_sequence)
);

CREATE INDEX idx_event_log_anchors_session ON event_log_anchors(session_id, anchored_at DESC);
CREATE INDEX idx_event_log_anchors_node ON event_log_anchors(node_id, anchored_at DESC);

INSERT INTO schema_migrations (version, description)
VALUES (4, 'Event log anchors (integrity witness)');
`;
