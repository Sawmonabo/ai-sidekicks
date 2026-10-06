# Agent Definition Tables (Plan-024)

The agent definition tables of the daemon's one SQLite schema. The [Local SQLite Schema](local-sqlite-schema.md) holds its pragmas, its conventions and every other area.

Node-local registry of saved agent configurations, for [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md). One row per definition. This is **configuration, not session state**: it is not events-canonical and is never rebuilt from the event log, and it reaches linked devices like every other screen.

**Where a definition lives.** A definition comes from one of four origins: ours (`~/.ai-sidekicks/agents/<name>.md` for a global one, `<project>/.ai-sidekicks/agents/` for a project's own, committed with the repository), Claude Code's own agent files, Codex's own agent files, or a plugin's, which is read-only and carries its plugin's name. A row holds the union of both providers' fields: a provider's file holds only the fields that provider reads, and every other field — the icon and accent, and on a Codex file the hooks and memory scope, which a Codex role file does not read — lives in this row, attached to the file by its name and location. A file renamed or deleted outside the app leaves its row `orphaned`, keeping the extras and the last path the file was known at, until it is reattached to a file or discarded; nothing is rewritten or dropped silently. Whether the provider switches an item off, and whether its file failed to load, are read from the file by the daemon's watch on every read and are not stored.

`id` is daemon-minted, opaque, and immutable, and is stable across a rename — `name` is a mutable human label and is never an identity key (I-024-1). A run started under a definition holds a **snapshot** of it: no foreign key binds a running agent to this table, and no read path serving one consults it, so editing or deleting a definition can never widen the authority of an agent already running (I-024-2).

`bindings` is the definition's provider axes, and it is one JSON column rather than four loose ones. It holds a default binding and any number of overrides — `{ "default": { driverName, unsupportedProviderName, modelId, providerAccountId, effort }, "overrides": [ … ] }` (`driverName` null, with `unsupportedProviderName` holding the name as the file gave it, only when the file names a provider this app does not run) — because one saved agent runs on either provider without being copied into a second definition, and four loose columns could hold only one provider's setup. The default is one of the bindings rather than a fallback beside them, and an override is a whole binding in its own right: an override's driver is unique within the definition and never repeats the default's, so which binding answers for a driver is never ambiguous. JSON rather than a child table because the list is bounded, always read with its row, and never queried across definitions — the same convention `tool_allowlist` on this table already follows.

A `providerAccountId` inside a binding deliberately carries **no foreign key** to `provider_accounts` (D-024-1), which a JSON column could not express anyway and which the corpus would refuse if it could. `ON DELETE CASCADE` would discard configuration the person wrote when an account is removed; `ON DELETE SET NULL` would silently convert a pinned account into "the provider's default account", which is exactly the substitution the fail-closed resolution rule forbids; `ON DELETE RESTRICT` would make account removal fail because an unrelated definition names it. The reference is therefore unenforced at the schema layer and checked when a run resolves the binding, which is the only point at which the answer matters.

`tool_allowlist` is three-state and the three states are **not** interchangeable (I-024-4): `NULL` means the driver's default tool set, the JSON array `'[]'` means no tools at all, and a populated array means exactly those tools. Representing "no tools" as an absent value would make the most restrictive choice unexpressible.

The table has no level column (I-024-8): every agent runs at the level of the session or workflow run it works in.

```sql
-- Owner: Plan-024
CREATE TABLE agent_definitions (
  id                     TEXT NOT NULL PRIMARY KEY,  -- daemon-minted opaque immutable definitionId; stable across a rename (I-024-1). A NULL definitionId would key nothing, and a `STRICT` table's PRIMARY KEY column cannot hold one.
  name                   TEXT NOT NULL  -- mutable human label; NEVER an identity key on any wire request, stored reference, or audit row
                         CHECK(length(name) > 0 AND length(name) <= 128 AND instr(name, char(0)) = 0),
  name_folded            TEXT NOT NULL,  -- full-Unicode case fold of `name`, computed by the store on every write (I-024-7).
                                         -- Stored rather than derived because SQLite has no Unicode-aware collation to index on:
                                         -- this column is what the uniqueness index arbitrates, so the DATABASE enforces folded
                                         -- uniqueness and no concurrent pair of non-ASCII case variants can both commit.
  description            TEXT NOT NULL DEFAULT ''
                         CHECK(instr(description, char(0)) = 0),
  icon                   TEXT,  -- NULL = the generic agent glyph. A glyph key from the console's own icon set; icon and accent are two fields, not one theme, so either changes without the other
  accent_hue             TEXT,  -- NULL = no chosen hue, and the card draws the generic mark's own. One step of the console's twelve-step hue wheel
  origin                 TEXT NOT NULL DEFAULT 'ours'  -- which place the definition's file lives in
                         CHECK(origin IN ('ours', 'claude', 'codex', 'plugin')),
  plugin_name            TEXT NOT NULL DEFAULT '',  -- the installing plugin's name on a plugin's agent, which is read-only; '' on every other origin
  scope                  TEXT NOT NULL DEFAULT 'global'  -- global, or one project's own
                         CHECK(scope IN ('global', 'project')),
  scope_ref              TEXT NOT NULL DEFAULT '',  -- the project record's id at 'project'; '' at 'global'
  source_path            TEXT NOT NULL,  -- the file the definition lives in; on an orphaned row, the last path the file was known at
  orphaned               INTEGER NOT NULL DEFAULT 0  -- 1 while the file is renamed or deleted outside the app and the row is neither reattached nor discarded
                         CHECK(orphaned IN (0, 1)),
  hooks                  TEXT,  -- JSON in the form an agent file's `hooks` key holds ({ <Event>: [{ matcher?, hooks: [<handler>] }] }); NULL = none. The agent's own value on every origin
                         CHECK(hooks IS NULL OR (json_valid(hooks) AND json_type(hooks) = 'object')),
  memory_scope           TEXT  -- where the agent's own memory lives; NULL = none. The agent's own value on every origin
                         CHECK(memory_scope IS NULL OR memory_scope IN ('user', 'project', 'local')),
  bindings               TEXT NOT NULL  -- the provider axes as one JSON object: a default binding plus its overrides, each binding naming a driver, a model, an optional provider account and an optional effort, one object because a definition reaches both providers
                         CHECK(json_valid(bindings)
                               AND json_type(bindings) = 'object'
                               AND json_type(bindings, '$.default') = 'object'
                               AND json_type(bindings, '$.overrides') = 'array'),
  turn_cap               INTEGER  -- NULL = no cap, and the daemon adds none of its own. The number of turns this agent may take before it is stopped; not a budget
                         CHECK(turn_cap IS NULL OR turn_cap > 0),
  instructions           TEXT NOT NULL DEFAULT ''  -- the system-prompt text the agent runs under; node-local configuration the person wrote, never emitted into an event payload
                         CHECK(instr(instructions, char(0)) = 0),
  goal                   TEXT
                         CHECK(goal IS NULL OR (length(goal) > 0 AND instr(goal, char(0)) = 0)),
  tool_allowlist         TEXT  -- three-state (I-024-4): NULL = driver defaults, '[]' = no tools, populated = exactly those. The array-shape CHECK admits '[]' and rejects a scalar or object
                         CHECK(tool_allowlist IS NULL OR (json_valid(tool_allowlist) AND json_type(tool_allowlist) = 'array')),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  CHECK((origin = 'plugin') = (plugin_name <> '')),
  CHECK((scope = 'global') = (scope_ref = ''))
);

-- Case-insensitive name uniqueness (I-024-7), per origin and scope: two definitions differing only in
-- letter case are one handle to a human reading a picker, and a service-layer-only check races under
-- concurrent creates from the desktop and CLI clients at once. The index arbitrates the STORED FOLD KEY,
-- so the guarantee is the full-Unicode one and not an ASCII subset of it. It is unique within one origin
-- (and one plugin) and one scope (and one project), so a provider's own `reviewer` sits beside ours.
CREATE UNIQUE INDEX idx_agent_definitions_name_folded
  ON agent_definitions(origin, plugin_name, scope, scope_ref, name_folded);
```

**Why a stored fold key rather than `COLLATE NOCASE`.** SQLite's built-in `NOCASE` collation folds only the 26 ASCII letters — [SQLite datatype documentation](https://sqlite.org/datatype3.html#collating_sequences) — so an index built on it collides `Reviewer` with `reviewer` but admits a pair differing only in a non-ASCII case mapping. A full-Unicode check in the definition store beside an ASCII index would not hold, because the layer performing the real fold is the layer that cannot be atomic: two concurrent creates of `Ärger` and `ärger` would each pass the service precheck, and the ASCII index would then accept both. Persisting the fold (`name_folded`, written by the store on every insert and update) moves the full-Unicode comparison into the unique index itself, so uniqueness is decided once, by the database, under the same folding the service uses. The store still performs the fold — it owns the Unicode algorithm — but it is not the correctness boundary, only the producer of the key. `name` continues to hold the person's original casing for display.
