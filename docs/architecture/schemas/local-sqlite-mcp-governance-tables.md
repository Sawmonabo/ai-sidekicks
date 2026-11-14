# MCP Governance Tables (Plan-022)

The MCP server governance tables of the daemon's one SQLite schema. The [Local SQLite Schema](local-sqlite-schema.md) holds its pragmas, its conventions and every other area.

Machine-scoped governance state for [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) (V1 feature #15): the binding store (each binding's enabled overlay, native-tool baseline and last declared address), the per-tool override store, the per-project switch for the servers Claude Code brings itself, the governance-mutation idempotency receipt store with the pin of the key its digests are taken under, the record of which OAuth client each server admitted, and the sign-outs a binding's removal owes. Provider config files remain the config source of truth — the daemon persists only governance state and derives the unified inventory on read, so no table here mirrors provider config ([Spec-024 § State And Data Implications](../../specs/024-mcp-server-configuration-and-governance.md#state-and-data-implications)). All the tables here are daemon-local with no session FK; settled sign-ins are the `mcp.*` event type in the `mcpGovernance` category, appended through the Plan-004 `EventLogService` path, and a status change is a live notice on `mcp.subscribe` written to no log (receipts are retry-window dedup evidence, deliberately not audit rows).

```sql
-- Owner: Plan-022
CREATE TABLE mcp_server_bindings (
  provider           TEXT NOT NULL,  -- the provider's open id, checked against the registered drivers where a request or a provider's reading brings it in; a row keeps it as written
  scope              TEXT NOT NULL
                     CHECK(scope IN ('user', 'project', 'local', 'plugin', 'connector', 'managed')),  -- scope axis of the binding identity (Spec-024 §Unified Inventory): writable at user, project and local on every provider; 'connector' (a claude.ai connector) and 'managed' (a server any provider's administrator layer declares) are the servers a provider brings itself, read-only, their rows holding the tool overrides; a Codex 'local' binding is the daemon's emulation and has a row like any other; a 'plugin' binding is a server an installed plugin declares, whose row holds the person's switch and tool overrides while its declaration changes only with the plugin
  scope_ref          TEXT NOT NULL DEFAULT '',  -- canonical project root (project) / keying directory (local) / the plugin's name (plugin) / the provider account's id (connector); '' for user and managed scope
  scope_place        TEXT NOT NULL DEFAULT '',  -- the WSL 2 distribution a project or local root is in; '' for a root outside one and for every other scope
  server_name        TEXT NOT NULL,
  enabled_override   INTEGER
                     CHECK(enabled_override IS NULL OR enabled_override IN (0, 1)),  -- the daemon's own switch for a binding whose provider keeps none: Claude bindings, every plugin binding and a Codex `local` binding the daemon emulates — Claude user scope has no enabled field, a plugin's declaration is the plugin's, and an emulated `local` add's receipt carries the switch its config asks (on for a new server asking nothing), which the landed commit writes; Codex's other bindings use its native `enabled` config field; NULL = no overlay
  native_tool_baseline_json TEXT,        -- pre-governance snapshot of the binding's native override-projection fields (enabled_tools / disabled_tools / tools.<t>.approval_mode), captured at the first facet materialization, held while any facet is materialized, dropped once facet-free; Codex-materialized bindings only (Claude facets are daemon-enforced — no native writes, no baseline). mcp.toolOverride.clear restores from it (Spec-024 §Tool-Level Overrides) — without it, restore-on-clear would invent values
  last_declared_address_digest TEXT,  -- the server address digest of the address the binding's whole address last read as, written at each read that declares one; a removal whose address no longer reads (a variable lost its value) signs this one out, a remaining binding whose address no longer reads keeps its sign-in, and a read at another address owes this one's sign-out; NULL until one has read. Never the address, whose user name, password and query are credentials
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
-- A governance mutation's idempotency key, written as a pending intent before the provider is
-- touched and committed in the same write as the mutation's own rows.
CREATE TABLE mcp_mutation_receipts (
  client_idempotency_key  TEXT NOT NULL PRIMARY KEY,  -- requester-generated UUID (Spec-004's mandatory clientIdempotencyKey; the interventions UNIQUE(target_run_id, client_idempotency_key) precedent, adapted to machine-scoped operations with no run axis)
  operation               TEXT NOT NULL,              -- the mcp.* method the key was spent on (the governance mutations, mcp.server.signIn and mcp.server.signOut; mcp.server.reconnect is unreceipted)
  -- The binding the mutation writes, keyed as its row is. No foreign key: a first add's row does
  -- not exist when the receipt begins, and a committed remove's receipt outlives its binding.
  provider                TEXT NOT NULL,
  scope                   TEXT NOT NULL CHECK(scope IN ('user', 'project', 'local', 'plugin', 'connector', 'managed')),
  scope_ref               TEXT NOT NULL DEFAULT '',
  scope_place             TEXT NOT NULL DEFAULT '',
  server_name             TEXT NOT NULL,
  request_digest          BLOB CHECK(request_digest IS NULL OR length(request_digest) = 32),  -- the keyed digest of the idempotency key and the request; NULL only on a row committed when the receipt key was lost
  before_digest           BLOB CHECK(before_digest IS NULL OR length(before_digest) = 32),    -- the keyed digest of the binding's declaration before the write; NULL where it had none
  after_digest            BLOB CHECK(after_digest IS NULL OR length(after_digest) = 32),      -- the keyed digest of the declaration the write leaves; NULL for a remove
  wanted_enabled          INTEGER CHECK(wanted_enabled IS NULL OR wanted_enabled IN (0, 1)),  -- a switch's wanted state; NULL for every other mutation
  status                  TEXT NOT NULL
                          CHECK(status IN ('pending', 'committed')),  -- two-phase (the Plan-012 command_receipts discipline, Spec-024 §Authorization): the row INSERTs as a 'pending' intent in its own transaction BEFORE any provider leg runs, and flips to 'committed' in the same transaction as the mutation's store writes — closing both crash windows around the external provider side effect (a durable provider write can never be left unfinalized: startup reconciliation completes any pending intent — verifying provider state, finishing store writes exactly once — or expires an intent whose provider leg never ran)
  response_json           TEXT,                       -- the acknowledged response, returned verbatim as the saved result on a retry with the same key and the same request — no provider call or store write; a retry under the key with another request is refused mcp.server.idempotencyConflict, except on a row committed when the receipt key was lost, whose saved result answers any request (Spec-024 §Authorization); NULL while 'pending' (recorded at finalization). One representation exception: the mcp.server.signIn row stores the acknowledgment with authorizationUrl STRUCTURALLY OMITTED — launch URLs embed single-use PKCE state and are never durable (Plan-022 I-022-1) — so its saved result is an acknowledgment with no URL (the flow already launched; a caller that never received the URL starts a new login under a fresh key)
  created_at              TEXT NOT NULL,              -- RFC 3339 UTC; 'committed' rows older than 24 h are pruned opportunistically on later mutation writes ('pending' intents resolve at startup reconciliation, never silently pruned)
  CHECK((status = 'committed') = (response_json IS NOT NULL)),
  CHECK(request_digest IS NOT NULL OR status = 'committed'),
  CHECK((scope IN ('user', 'managed')) = (scope_ref = '')),
  CHECK(scope IN ('project', 'local') OR scope_place = '')
) STRICT;
```

Receipts are **two-phase** because the provider config write is an external side effect no SQLite transaction can span. The `'pending'` intent row (key and operation) commits in its **own transaction before** the provider leg runs; finalization — `status = 'committed'` plus the recorded response — commits in the **same transaction** as the mutation's governance-store writes, making the acknowledgment and the saved result atomic. That closes both crash windows: crash before the provider leg leaves a pending intent with no provider effect (startup reconciliation expires it — the caller retries fresh); crash after a durable provider write but before finalization leaves a pending intent whose provider state startup reconciliation verifies, completing the store writes **exactly once, late**, then finalizing. An identical-key retry that meets a pending row first drives that reconciliation, then returns the finalized response; a lost IPC response after commit can re-drive only the provider leg (safe by construction — sanctioned provider writes are upserts, full-set replacements, or version-guarded), never a second acknowledgment. A retry with the same key is matched by the keyed digest of its request, and the digests of the binding's declaration before and after the write let a pending intent's provider state be settled at start. Receipts carry no config values: the digests are keyed, and no column holds a declaration. A sign-in's or sign-out's pending receipt is expired at the start and by a retry under its key, which runs the command again, since neither writes a provider config nor a daemon row.

```sql
-- Owner: Plan-022
-- The keyed hash of a fixed label under the receipt key the credential store holds, never the key,
-- which tells that key from another. One row, written when a key is first held and replaced when a
-- lost key is made again.
CREATE TABLE mcp_receipt_key_pin (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  pin        BLOB NOT NULL CHECK(length(pin) = 32)
) STRICT;
```

```sql
-- Owner: Plan-022 (T22.2.12)
-- The daemon's own per-project switch for a server a provider brings itself (Claude Code's claude.ai
-- connectors and the servers an administrator layer declares): one row per such server switched off for one project, deleted when it is switched
-- back on and with the project. The row names the project by its id, so the switch follows the project when
-- its folder moves or is re-attached, and the inventory lists it under the root the project's attached mount
-- is at now. Claude Code's own `disabledMcpServers` is read, never written; a server named there is off for
-- that project as well.
CREATE TABLE mcp_project_server_switches (
  provider      TEXT NOT NULL,  -- the provider's open id, as in mcp_server_bindings
  scope         TEXT NOT NULL CHECK(scope IN ('connector', 'managed')),
  scope_ref     TEXT NOT NULL DEFAULT '',  -- the provider account's id (connector); '' (managed)
  scope_place   TEXT NOT NULL DEFAULT '',  -- '' for both scopes; kept so the key matches the binding's
  server_name   TEXT NOT NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,  -- the project the switch is off for
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (provider, scope, scope_ref, scope_place, server_name, project_id),
  CHECK((scope = 'managed') = (scope_ref = '')),
  CHECK(scope_place = ''),  -- neither scope a switch takes has a distribution
  FOREIGN KEY (provider, scope, scope_ref, scope_place, server_name)
    REFERENCES mcp_server_bindings(provider, scope, scope_ref, scope_place, server_name)
    ON DELETE CASCADE  -- a switch never outlives its binding row
) STRICT;
```

A server is named in every row and keychain attribute by its **server address digest**: HMAC-SHA256 of its canonical address (scheme and host case, default port, trailing slash and fragment folded) under one 32-byte key, lowercase hex. The key is one item of the MCP sign-ins' credential-store service, made from the system's random source on first use and read once per daemon life; a store that cannot give it refuses the call as `mcp.bindingStoreUnavailable` and changes no row. An item there that holds no key is refused the same way and never replaced, since every sign-in filed under its digests would be lost with it. A key that is gone while sign-ins are filed is made again, and each sign-in is filed under the new key's digest of the address its secret holds before the new key is written, so a stop part-way leaves the key gone and the next start finishes the move. In one write before the key is written, every row naming a moved sign-in's old digest follows it to the new one: its owed sign-out, each binding's `last_declared_address_digest`, its `mcp_server_admitted_clients` row and each command receipt's `mcp_server_endpoint`, so no settle reads a binding off its server and no client registers twice. A command receipt names a task's server at an address by the same digest (`mcp_server_endpoint`, [Local SQLite Schema](local-sqlite-schema.md)), so no row lets a guessed address be confirmed without the key. The address itself, whose user name, password and query are credentials ([Spec-024 §Implementation Notes](../../specs/024-mcp-server-configuration-and-governance.md#implementation-notes), transient-secret handling), is kept only inside the sign-in's credential-store secret.

```sql
-- Owner: Plan-022
-- Which OAuth client each server admitted, one row per server address however many bindings or providers
-- name it, as its sign-in is kept: a provider's own client (Claude Code's or Codex's), written when that
-- provider's flow completes, and the mark that the daemon's own client ended an attempt with no callback, so
-- the next press goes to a provider's flow and the mark survives a restart. A fact about the server, so it is
-- kept once here rather than on each binding that names the server. A sign-out forgets only the sign-in and
-- keeps this row, so every later sign-in is one press. Not a credential.
CREATE TABLE mcp_server_admitted_clients (
  server_address_digest    TEXT NOT NULL PRIMARY KEY,  -- the server address digest, the account its sign-in is kept under; never the address
  admitted_oauth_client    TEXT,  -- the open id of the provider whose own client the server admitted; NULL until one has
  own_client_unfinished_at TEXT,  -- when the daemon's own client last ended an attempt with no callback; NULL otherwise
  CHECK(admitted_oauth_client IS NOT NULL OR own_client_unfinished_at IS NOT NULL)
) STRICT;
```

```sql
-- Owner: Plan-022
-- The sign-out a removed binding, or one whose address changed, owes the server it named: written before the
-- provider's write, so a stop between the write and the sign-out leaves it for the next start, and cleared once a
-- settle finds another binding naming the server or signs it out. A credential store that refuses the
-- sign-out keeps the row for the next settle, at the daemon's start or after a sign-in or sign-out press. Not a
-- credential.
CREATE TABLE mcp_server_owed_sign_outs (
  server_address_digest TEXT NOT NULL PRIMARY KEY  -- the server address digest, the account its sign-in is kept under; never the address
) STRICT;
```
