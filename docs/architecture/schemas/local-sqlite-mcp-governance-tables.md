# MCP Governance Tables (Plan-022)

The MCP server governance tables of the daemon's one SQLite schema. The [Local SQLite Schema](local-sqlite-schema.md) holds its pragmas, its conventions and every other area.

Machine-scoped governance state for [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) (V1 feature #15): the binding store (each binding's enabled overlay and native-tool baseline), the per-tool override store, the per-project switch for the servers Claude Code brings itself, the governance-mutation idempotency receipt store, and the record of which OAuth client each server admitted. Provider config files remain the config source of truth — the daemon persists only governance state and derives the unified inventory on read, so no table here mirrors provider config ([Spec-024 § State And Data Implications](../../specs/024-mcp-server-configuration-and-governance.md#state-and-data-implications)). All the tables here are daemon-local with no session FK; settled sign-ins are the `mcp.*` event type in the `mcpGovernance` category, appended through the Plan-004 `EventLogService` path, and a status change is a live notice on `mcp.subscribe` written to no log (receipts are retry-window dedup evidence, deliberately not audit rows).

```sql
-- Owner: Plan-022
CREATE TABLE mcp_server_bindings (
  provider           TEXT NOT NULL,  -- the provider's open id, checked against the registered drivers where a request or a provider's reading brings it in; a row keeps it as written
  scope              TEXT NOT NULL
                     CHECK(scope IN ('user', 'project', 'local', 'plugin', 'connector', 'managed')),  -- scope axis of the binding identity (Spec-024 §Unified Inventory): writable at user, project and local on every provider; 'connector' (a claude.ai connector) and 'managed' (a server an administrator layer declares) are the servers a provider brings itself, Claude Code's today, read-only, their rows holding the tool overrides; a Codex 'local' binding is the daemon's emulation and has a row like any other; a 'plugin' binding is a server an installed plugin declares, whose row holds the person's switch and tool overrides while its declaration changes only with the plugin
  scope_ref          TEXT NOT NULL DEFAULT '',  -- canonical project root (project) / keying directory (local) / the plugin's name (plugin) / the provider account's id (connector); '' for user and managed scope
  scope_place        TEXT NOT NULL DEFAULT '',  -- the WSL 2 distribution a project or local root is in; '' for a root outside one and for every other scope
  server_name        TEXT NOT NULL,
  enabled_override   INTEGER
                     CHECK(enabled_override IS NULL OR enabled_override IN (0, 1)),  -- the daemon's per-server enabled overlay (Claude bindings and every plugin binding — Claude user scope has no enabled field, and a plugin's declaration is the plugin's; Codex's own bindings use its native `enabled` config field); NULL = no overlay
  native_tool_baseline_json TEXT,        -- pre-governance snapshot of the binding's native override-projection fields (enabled_tools / disabled_tools / tools.<t>.approval_mode), captured at the first facet materialization, held while any facet is materialized, dropped once facet-free; Codex-materialized bindings only (Claude facets are daemon-enforced — no native writes, no baseline). mcp.toolOverride.clear restores from it (Spec-024 §Tool-Level Overrides) — without it, restore-on-clear would invent values
  first_observed_at  TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (provider, scope, scope_ref, scope_place, server_name),
  -- binding-ref structural validity, mirroring the schema-level discriminated union (defense in depth):
  -- user and managed scope have no scope_ref ('' sentinel); project/local/plugin/connector REQUIRE one;
  -- only a project or local root has a distribution
  CHECK((scope IN ('user', 'managed')) = (scope_ref = '')),
  CHECK(scope IN ('project', 'local') OR scope_place = '')
) STRICT;
```

```sql
-- Owner: Plan-022
CREATE TABLE mcp_tool_overrides (
  provider          TEXT NOT NULL,  -- the provider's open id, as in mcp_server_bindings
  scope             TEXT NOT NULL
                    CHECK(scope IN ('user', 'project', 'local', 'plugin', 'connector', 'managed')),  -- binding identity axes mirror mcp_server_bindings
  scope_ref         TEXT NOT NULL DEFAULT '',
  scope_place       TEXT NOT NULL DEFAULT '',
  server_name       TEXT NOT NULL,
  tool_name         TEXT NOT NULL,
  enabled           INTEGER
                    CHECK(enabled IS NULL OR enabled IN (0, 1)),  -- allow/deny facet; NULL = provider default
  approval_mode     TEXT                   -- Codex-native vocabulary adopted as the normalized set (Spec-024 §Tool-Level Overrides)
                    CHECK(approval_mode IS NULL OR approval_mode IN ('auto', 'prompt', 'writes', 'approve')),
  idempotency_class TEXT                   -- NULL = the Spec-004 manualReconcileOnly floor (Spec-024 §Tool-Level Overrides)
                    CHECK(idempotency_class IS NULL OR idempotency_class IN ('idempotent', 'compensable')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (provider, scope, scope_ref, scope_place, server_name, tool_name),
  -- an all-NULL facet row is meaningless: mcp.toolOverride.clear nulls the one facet it names, and
  -- clearing the row's last set facet deletes the row instead of blanking it — and the
  -- mcp.toolOverride.update contract mirrors this as a garde check (>= 1 facet required), so a
  -- facet-less override dies as a typed validation error before it can reach this constraint
  CHECK(enabled IS NOT NULL OR approval_mode IS NOT NULL OR idempotency_class IS NOT NULL),
  -- binding-ref structural validity, mirroring mcp_server_bindings (defense in depth)
  CHECK((scope IN ('user', 'managed')) = (scope_ref = '')),
  CHECK(scope IN ('project', 'local') OR scope_place = ''),
  FOREIGN KEY (provider, scope, scope_ref, scope_place, server_name)
    REFERENCES mcp_server_bindings(provider, scope, scope_ref, scope_place, server_name)
    ON DELETE CASCADE  -- overrides never outlive their binding row
) STRICT;
```

The FK targets the binding table because first observation of any binding upserts its row ([Spec-024 § Unified Inventory](../../specs/024-mcp-server-configuration-and-governance.md#unified-inventory)) — that row is each binding's durable governance anchor, so overrides cascade to it rather than to any provider-config mirror (there is none). Identity is the scope-qualified binding `(provider, scope, scope_ref, scope_place, server_name)`: same-named servers in two scopes are distinct configurations with independent overrides, so collapsing them would bleed one scope's overrides into the other. One project path in two distributions is two roots, so it is two keys: `scope_place` names the WSL 2 distribution a `project` or `local` root is in, and is `''` for a root outside one and for every other scope, since SQLite counts NULLs in a key as distinct. Lookups ride the composite primary keys: the inventory merge and the Spec-004 tool-metadata resolution both read by binding prefix, so no secondary indexes are warranted.

```sql
-- Owner: Plan-022
CREATE TABLE mcp_mutation_receipts (
  client_idempotency_key  TEXT NOT NULL PRIMARY KEY,  -- requester-generated UUID (Spec-004's mandatory clientIdempotencyKey; the interventions UNIQUE(target_run_id, client_idempotency_key) precedent, adapted to machine-scoped operations with no run axis)
  operation               TEXT NOT NULL,              -- the receipted mcp.* operation the key was spent on (the governance mutations, mcp.server.signIn and mcp.server.signOut; mcp.server.reconnect is unreceipted)
  status                  TEXT NOT NULL
                          CHECK(status IN ('pending', 'committed')),  -- two-phase (the Plan-012 command_receipts discipline, Spec-024 §Authorization): the row INSERTs as a 'pending' intent in its own transaction BEFORE any provider leg runs, and flips to 'committed' in the same transaction as the mutation's store writes — closing both crash windows around the external provider side effect (a durable provider write can never be left unfinalized: startup reconciliation completes any pending intent — verifying provider state, finishing store writes exactly once — or expires an intent whose provider leg never ran)
  response_json           TEXT,                       -- the acknowledged response, returned verbatim as the saved result on any retry with the same key, whatever the second request carries — no provider call or store write (Spec-024 §Authorization); NULL while 'pending' (recorded at finalization). One representation exception: the mcp.server.signIn row stores the acknowledgment with authorizationUrl STRUCTURALLY OMITTED — launch URLs embed single-use PKCE state and are never durable (Plan-022 I-022-1) — so its saved result is an acknowledgment with no URL (the flow already launched; a caller that never received the URL starts a new login under a fresh key)
  created_at              TEXT NOT NULL,              -- RFC 3339 UTC; 'committed' rows older than 24 h are pruned opportunistically on later mutation writes ('pending' intents resolve at startup reconciliation, never silently pruned)
  CHECK((status = 'committed') = (response_json IS NOT NULL))
) STRICT;
```

Receipts are **two-phase** because the provider config write is an external side effect no SQLite transaction can span. The `'pending'` intent row (key and operation) commits in its **own transaction before** the provider leg runs; finalization — `status = 'committed'` plus the recorded response — commits in the **same transaction** as the mutation's governance-store writes, making the acknowledgment and the saved result atomic. That closes both crash windows: crash before the provider leg leaves a pending intent with no provider effect (startup reconciliation expires it — the caller retries fresh); crash after a durable provider write but before finalization leaves a pending intent whose provider state startup reconciliation verifies, completing the store writes **exactly once, late**, then finalizing. An identical-key retry that meets a pending row first drives that reconciliation, then returns the finalized response; a lost IPC response after commit can re-drive only the provider leg (safe by construction — sanctioned provider writes are upserts, full-set replacements, or version-guarded), never a second acknowledgment. Receipts carry no config values.

```sql
-- Owner: Plan-022 (T22.2.12)
-- The daemon's own per-project switch for a server a provider brings itself (Claude Code's claude.ai
-- connectors and the servers an administrator layer declares): one row per such server switched off for one project, deleted when it is switched
-- back on. Claude Code's own `disabledMcpServers` is read, never written; a server named there is off for
-- that project as well.
CREATE TABLE mcp_project_server_switches (
  provider      TEXT NOT NULL,  -- the provider's open id, as in mcp_server_bindings
  scope         TEXT NOT NULL CHECK(scope IN ('connector', 'managed')),
  scope_ref     TEXT NOT NULL DEFAULT '',  -- the provider account's id (connector); '' (managed)
  scope_place   TEXT NOT NULL DEFAULT '',  -- '' for both scopes; kept so the key matches the binding's
  server_name   TEXT NOT NULL,
  project_root  TEXT NOT NULL,             -- canonical project root the switch is off for
  project_place TEXT NOT NULL DEFAULT '',  -- the WSL 2 distribution that root is in; '' for a root outside one
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (provider, scope, scope_ref, scope_place, server_name, project_root, project_place),
  CHECK((scope = 'managed') = (scope_ref = '')),
  CHECK(scope IN ('project', 'local') OR scope_place = ''),
  FOREIGN KEY (provider, scope, scope_ref, scope_place, server_name)
    REFERENCES mcp_server_bindings(provider, scope, scope_ref, scope_place, server_name)
    ON DELETE CASCADE  -- a switch never outlives its binding row
) STRICT;
```

```sql
-- Owner: Plan-022
-- Which OAuth client each server admitted at its last sign-in, one row per server: the daemon's own, or
-- a provider's own client (Claude Code's or Codex's) where the server admits only that one. A fact about the server,
-- so it is kept once here rather than on each binding that names the server. A sign-out forgets only the
-- sign-in and keeps this row, so every later sign-in is one press. Not a credential.
CREATE TABLE mcp_server_admitted_clients (
  provider              TEXT NOT NULL,  -- the provider's open id, as in mcp_server_bindings
  server_name           TEXT NOT NULL,
  admitted_oauth_client TEXT NOT NULL,  -- 'daemon', or the open id of the provider whose own client the server admits
  PRIMARY KEY (provider, server_name)
) STRICT;
```
