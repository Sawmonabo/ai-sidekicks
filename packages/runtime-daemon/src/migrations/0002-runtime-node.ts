// Plan-003 PR #135 — runtime-node Local Runtime Daemon schema (inlined SQL).
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file — the same rationale as `0001-initial.ts`:
//
//   1. The build pipeline (`tsc -b`) does NOT copy non-TS assets into
//      `dist/`. Any FS-relative load path (`new URL(..., import.meta.url)`)
//      would resolve correctly under `vitest` (running against `src/`) but
//      throw `ENOENT` at first dist-from-import use.
//   2. `package.json` `"files": ["dist"]` would exclude `src/migrations/`
//      from the published tarball anyway, so a published consumer would
//      never see the SQL file even if a build-time copy step ran.
//   3. Bundlers (esbuild / webpack / Bun) handle `import.meta.url`
//      inconsistently; inline strings survive every transform stage.
//
// The canonical schema source-of-truth is
// `docs/architecture/schemas/local-sqlite-schema.md`
// §"Runtime Node Local Tables (Plan-003)" — the two CREATE TABLE blocks
// below are copied verbatim from that section (including the `-- Owner:`
// header and the `-- JSON` per-column comment) so the inline constant stays
// in lockstep with the canonical doc.
//
// ----------------------------------------------------------------------------
// Plan-003 scope (this migration — version 2)
// ----------------------------------------------------------------------------
//
// Plan-003 owns the physical CREATE for two Local SQLite tables:
//
//   * node_capabilities  — per-node capability declarations (Plan-003 owner);
//                          composite PK (node_id, capability_key).
//   * node_trust_state   — per-node trust level (Plan-003 owner); PK node_id.
//
// Out of scope here: the Plan-003 Postgres tables
// (`runtime_node_attachments`, `runtime_node_presence`) are Phase-3
// control-plane surfaces, not Local SQLite, and are NOT created by this
// migration. The `schema_version` anchor table itself is owned by Plan-001
// (`0001-initial.ts`); this migration only INSERTs its version-2 row.

export const RUNTIME_NODE_MIGRATION_SQL: string = `
-- Owner: Plan-003
CREATE TABLE node_capabilities (
  node_id           TEXT NOT NULL,
  capability_key    TEXT NOT NULL,
  capability_value  TEXT NOT NULL DEFAULT '{}', -- JSON
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (node_id, capability_key)
);

-- Owner: Plan-003
CREATE TABLE node_trust_state (
  node_id           TEXT NOT NULL PRIMARY KEY,
  trust_level       TEXT NOT NULL DEFAULT 'untrusted',
  established_at    TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (2, datetime('now'), 'Runtime node local tables (node_capabilities, node_trust_state)');
`;
