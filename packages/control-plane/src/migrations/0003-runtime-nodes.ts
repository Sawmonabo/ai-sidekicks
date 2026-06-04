// Plan-003 Phase 3 T3.1 — third Collaboration Control Plane Postgres migration
// (inlined SQL). Adds the two Plan-003-OWNED runtime-node coordination tables
// required by the Phase-3 control-plane attach flow:
//
//   * runtime_node_attachments — durable runtime-node attachment records
//                                (reconnect/audit per Spec-003 line 82). FK
//                                references `sessions(id)` and
//                                `participants(id)` (both Plan-001 anchors).
//   * runtime_node_presence    — durable runtime-node heartbeat/health
//                                snapshot keyed by node_id.
//
// Plus the schema_migrations anchor row consumed by the migration runner
// (`(version, description) = (3, 'Runtime node attachments and presence')`).
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
// The canonical schema source-of-truth is
// `docs/architecture/schemas/shared-postgres-schema.md` — the
// §"Runtime Node Attachments (Plan-003)" block (lines 191-225) is reproduced
// VERBATIM below including the `-- Owner: Plan-003` stamps, the per-column
// comments, BOTH unique indexes, and the I-003-5 partial-unique predicate, so
// the inline constant stays in lockstep with the canonical doc. Any
// column-shape edit (add/remove/rename/CHECK/index change) MUST land first in
// the canonical doc per AGENTS.md "doc-first ordering".
//
// ----------------------------------------------------------------------------
// Plan-001 does NOT create these tables — Plan-003 owns the physical CREATE
// ----------------------------------------------------------------------------
//
// Both tables carry `-- Owner: Plan-003` in the canonical schema. Plan-001's
// migration (0001-initial.ts) ships only the `participants` / `sessions` /
// `session_memberships` anchors; Plan-002 (0002-session-invites.ts) adds
// `session_invites`. These two runtime-node tables come into existence HERE —
// the guard `migrations/__tests__/runtime-node-upstream-anchors.test.ts`
// asserts (assertion 3) these tables are PRESENT after this migration; its
// header note (d) tripwire was flipped from ABSENT to PRESENT in this same PR.
//
// Created AFTER 0001 because both FKs (`session_id REFERENCES sessions(id)`,
// `participant_id REFERENCES participants(id)`) must resolve at CREATE-time per
// `shared-postgres-schema.md` §Migration-order invariant. Plan-001/002/003
// execute before Plan-018 per cross-plan-dependencies.md; Plan-018's identity
// columns are additive ALTERs over the same `participants` anchor and do not
// affect this migration's FK resolution.
//
// ----------------------------------------------------------------------------
// The two unique indexes are BOTH load-bearing — neither is optional
// ----------------------------------------------------------------------------
//
//   * idx_node_attachments_node — composite UNIQUE (node_id, session_id):
//     a given node has at most one attachment row per session.
//   * idx_node_attachments_active — PARTIAL UNIQUE on (node_id)
//     WHERE state IN ('registering', 'online', 'degraded'): a node has at most
//     ONE attachment in an active state across ALL sessions. This is the
//     storage-layer enforcement of Plan-003 I-003-5 / Spec-003 line 118
//     ("one active session at a time in v1"). An inactive ('offline' or
//     'revoked') row escapes the predicate, so it does not block a later
//     (re)attach at the index level — reattach eligibility is then a T3.2
//     application decision (reactivate 'offline', refuse 'revoked'). T3.2 / P9
//     (single-active-session refusal) depends on this index existing.
//
// ----------------------------------------------------------------------------
// I-002-3 boundary clarification — runtime_node_presence is NOT a violation
// ----------------------------------------------------------------------------
//
// Plan-002 I-002-3 forbids persisting EPHEMERAL Yjs-Awareness session-presence
// CRDT state to a durable table. `runtime_node_presence` is a DIFFERENT
// concept: a durable runtime-node heartbeat/health snapshot, explicitly
// enumerated as a stored coordination record by the ADR-017 invariant block at
// the head of shared-postgres-schema.md ("presence history" + "runtime-node
// attachments"). It is canonically named `runtime_node_presence` under its
// `-- Owner: Plan-003` stamp — it is NOT renamed to evade the I-002-3
// `%presence%` test probes, because the canonical name is the contract. Those
// probes (sibling presence/migration tests that assert no `%presence%` table)
// were written before this Plan-003 table existed; they were narrowed in this
// PR to allowlist exactly `runtime_node_presence` while still forbidding any
// other (Yjs-Awareness) presence-state table — see the updated guards in
// presence-register-service.test.ts and migration-shape.test.ts.
//
// ----------------------------------------------------------------------------
// Why one transactional batch
// ----------------------------------------------------------------------------
//
// Postgres DDL is fully transactional. The migration runner
// (`sessions/migration-runner.ts`) executes this constant inside a single
// `Querier.transaction(...)` boundary (after acquiring the advisory lock and
// re-probing), so a torn write (process kill mid-migration) leaves the
// database fully at v2, never half-migrated to "v3 partial". The migration SQL
// itself does NOT contain `BEGIN;`/`COMMIT;` — the transaction boundary is
// owned by the caller, identical to `INITIAL_MIGRATION_SQL` and
// `SESSION_INVITES_MIGRATION_SQL`. The `INSERT INTO schema_migrations` is the
// last statement so the version anchor commits atomically with the DDL.
//
// Refs: Plan-003 Phase 3 T3.1; Spec-003 line 82 (durable runtime-node records
// for reconnect/audit), line 118 (one active session at a time in v1);
// Plan-003 §Invariants I-003-5; docs/architecture/schemas/
// shared-postgres-schema.md §"Runtime Node Attachments (Plan-003)".

export const RUNTIME_NODES_MIGRATION_SQL: string = `
-- Owner: Plan-003
CREATE TABLE runtime_node_attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id),
  participant_id  UUID NOT NULL REFERENCES participants(id),
  node_id         TEXT NOT NULL,                 -- daemon-assigned node identifier
  capabilities    JSONB NOT NULL DEFAULT '{}',   -- declared capabilities
  client_version  TEXT NOT NULL,                 -- daemon semver "MAJOR.MINOR" at attach; floor-compared vs sessions.min_client_version (ADR-018 §Decision #4) — makes the read-only verdict auditable + roster-displayable
  state           TEXT NOT NULL DEFAULT 'registering'
                  CHECK(state IN ('registering', 'online', 'degraded', 'offline', 'revoked')),
  attached_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_node_attachments_session ON runtime_node_attachments(session_id);
CREATE INDEX idx_node_attachments_participant ON runtime_node_attachments(participant_id);
CREATE UNIQUE INDEX idx_node_attachments_node ON runtime_node_attachments(node_id, session_id);
-- One-active-session enforcement (Plan-003 I-003-5; Spec-003 line 118 — "one active session at a time in v1"):
-- a node has at most one attachment in an active state across all sessions. The partial UNIQUE constrains
-- only active-state rows, so an inactive ('offline' or 'revoked') row does not block a later (re)attach at
-- the index level. Reattach eligibility is then a T3.2 application decision: an 'offline' row is reactivated
-- on reconnect, while a 'revoked' row is refused — revocation is terminal (Plan-003 T3.2/P10).
CREATE UNIQUE INDEX idx_node_attachments_active ON runtime_node_attachments(node_id)
  WHERE state IN ('registering', 'online', 'degraded');

-- Owner: Plan-003
CREATE TABLE runtime_node_presence (
  node_id             TEXT NOT NULL PRIMARY KEY,
  last_heartbeat_at   TIMESTAMPTZ NOT NULL,
  health_state        TEXT NOT NULL DEFAULT 'online'
                      CHECK(health_state IN ('online', 'degraded', 'offline'))
);

INSERT INTO schema_migrations (version, description)
VALUES (3, 'Runtime node attachments and presence');
`;
