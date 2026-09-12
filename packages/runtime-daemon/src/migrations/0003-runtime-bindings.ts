// driver-contract + runtime-binding schema (inlined SQL).
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file — the same rationale as `0001-initial.ts` /
// `0002-runtime-node.ts`:
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
// The canonical schema source-of-truth is — the four CREATE TABLE blocks
// below are copied verbatim from that section (including the `-- Owner:`
// headers, the per-column comments, and the provider-output
// defense-in-depth CHECK constraints) so the inline constant stays in
// lockstep with the canonical doc.
//
// ----------------------------------------------------------------------------
// Scope (this migration — version 3)
// ----------------------------------------------------------------------------
//
// Owns the physical CREATE for four Local SQLite tables:
//
//   * runtime_bindings      — driver-instance ↔ run bindings; PK `id`,
//                             index `idx_runtime_bindings_run` on `run_id`.
//                             extends with recovery-aware persistence
//                             methods; row-level recovery state lives in
//                             the dedicated `recovery_checkpoints` table,
//                             NOT here.
//   * driver_capabilities   — per-driver 7-flag capability matrix;
//                             composite PK (driver_name, capability_flag).
//   * driver_tools          — per-tool metadata; composite PK
//                             Persists each tool's `idempotency_class` so the
//                             daemon's two-phase command-receipt protocol
//                             resolves crash-recovery dispatch class without
//                             round-tripping the driver.
//   * driver_contract_meta  — per-driver parent row (PK driver_name) holding
//                             the single advertised `contract_version` that
//                             cold-start cache hydration reconstructs into
//                             GetCapabilitiesResult.capabilities.contractVersion
//                             without round-tripping the driver. DISTINCT
//                             from the per-run
//                             runtime_bindings.contract_version.
//
// Out of scope (hard ownership boundaries — do NOT add here):
//   * No `recovery_state` / `recovery_needed` / `recovery_reason` columns on
//     runtime_bindings — owns the `recovery_checkpoints` table.
//   * No FK to a local `sessions` table — sessions are shared-Postgres-only.
//     Session-level lookups compose the caller-supplied active-run ids (the
//     daemon's event-sourced run-state projection — there is no `runs`
//     table) with the store's binding-by-run lookups (campaign B6 gloss; the
//     batch `findByRuns` lands with the campaign's bundle).
//
// Provider-output validation obligation (Phase-2 write-seam, defense-in-depth):
//   `contract_version` and `resume_handle` are provider-declared strings. The
//   DB CHECK constraints below bound the SQLite-expressible part — length +
//   NUL-rejection (and non-empty for the NOT NULL `contract_version`, and
//   non-empty-when-present for the nullable `resume_handle`). The 4096/64
//   length literals are the canonical bounds reused by the write-path Zod
//   guards (runtime_bindings driver_contract_meta) so the two defense layers
//   stay consistent. Semver-shape validation is NOT expressible as a
//   pure-SQLite CHECK (a GLOB cannot model semver), so it is enforced at the
//   write seam via the `semver` package — NOT here, and NOT at the contract
//   layer (`packages/contracts/src/provider-driver.ts`).
//
// The `schema_version` anchor table itself is this migration only
// INSERTs its version-3 row.

export const RUNTIME_BINDINGS_MIGRATION_SQL: string = `
-- Provider-output defense-in-depth CHECKs:
-- contract_version and resume_handle are provider-declared strings persisted at
-- the write seam. The 4096/64 length literals are the canonical bounds that
-- write-path guard reuses, so the two layers stay consistent.
CREATE TABLE runtime_bindings (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  driver_name       TEXT NOT NULL,            -- e.g. 'claude', 'codex'
  contract_version  TEXT NOT NULL             -- semver of driver contract
                    CHECK (length(contract_version) > 0 AND length(contract_version) <= 64 AND instr(contract_version, char(0)) = 0),
  resume_handle     TEXT                      -- provider-owned opaque handle
                    CHECK (resume_handle IS NULL OR (length(resume_handle) > 0 AND length(resume_handle) <= 4096 AND instr(resume_handle, char(0)) = 0)),
  runtime_metadata  TEXT NOT NULL DEFAULT '{}', -- JSON: provider-specific recovery data
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_runtime_bindings_run ON runtime_bindings(run_id);

CREATE TABLE driver_capabilities (
  driver_name       TEXT NOT NULL,
  capability_flag   TEXT NOT NULL
                    CHECK(capability_flag IN (
                      'resume', 'steer', 'interactive_requests', 'mcp',
                      'tool_calls', 'reasoning_stream', 'model_mutation'
                    )),
  supported         INTEGER NOT NULL DEFAULT 0, -- boolean: 0 or 1
  refreshed_at      TEXT NOT NULL,
  PRIMARY KEY (driver_name, capability_flag)
);

-- Normalized per-tool rows mirror the per-flag-row shape of driver_capabilities.
CREATE TABLE driver_tools (
  driver_name        TEXT NOT NULL,
  tool_name          TEXT NOT NULL,
  idempotency_class  TEXT NOT NULL
                     CHECK(idempotency_class IN (
                       'idempotent', 'compensable', 'manual_reconcile_only'
                     )),
  description        TEXT,
  refreshed_at       TEXT NOT NULL,
  PRIMARY KEY (driver_name, tool_name)
);

-- The capability cache is keyed by driver_name (driver_capabilities + driver_tools are
-- per-driver children); this parent row holds the single per-driver contract_version so
-- cold-start hydration can reconstruct GetCapabilitiesResult = { capabilities: { flags,
-- contractVersion }, tools } WITHOUT round-tripping the driver. Distinct from
-- runtime_bindings.contract_version, which records the version bound to a specific run.
-- Provider-output defense-in-depth CHECK: contract_version mirrors the
-- runtime_bindings.contract_version bound (length + NUL-rejection, 64-char ceiling).
-- Semver-shape validation lives write-path Zod guard (the \`semver\` package) — not
-- expressible as a pure-SQLite CHECK.
CREATE TABLE driver_contract_meta (
  driver_name       TEXT PRIMARY KEY,
  contract_version  TEXT NOT NULL             -- semver of the driver's advertised capability contract
                    CHECK (length(contract_version) > 0 AND length(contract_version) <= 64 AND instr(contract_version, char(0)) = 0),
  refreshed_at      TEXT NOT NULL             -- last capability-refresh write (matches driver_capabilities.refreshed_at cadence)
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (3, datetime('now'), 'Driver and runtime binding tables (runtime_bindings, driver_capabilities, driver_tools, driver_contract_meta)');
`;
