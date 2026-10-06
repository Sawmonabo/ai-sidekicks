# Local SQLite Schema

Canonical schema for the local daemon's SQLite database. Each runtime node maintains its own instance.

The database is one schema, created whole when the daemon first opens it. There are no numbered migrations and no upgrade steps: a feature that needs a table or a column adds it to this schema, and to the schema's test, in the change that builds the feature. Every table is `STRICT`, so each column is typed `INTEGER`, `REAL`, `TEXT`, `BLOB` or `ANY`, JSON is stored as `TEXT`, and a value that cannot be stored losslessly in its column's type is refused on write rather than kept under a looser affinity. A primary-key column of a `STRICT` table is `NOT NULL` whether or not it says so ([SQLite, STRICT Tables](https://www.sqlite.org/stricttables.html)).

**Storage boundary:** Machine-scoped execution truth and recovery data. See [Data Architecture](../data-architecture.md).

## Pragmas

```sql
PRAGMA journal_mode = WAL;      -- concurrent readers during writes
PRAGMA synchronous = FULL;      -- override better-sqlite3 default (NORMAL) for durability (see Spec-013 §Pragmas)
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA secure_delete = ON;      -- deleted content is overwritten with zeros, so a deleted session leaves no readable freed page
```

---

## Session Events (Plan-001, extended by Plans 004, 012)

```sql
-- Owner: Plan-001 | Extended by: Plan-004 (event taxonomy), Plan-025 (received-row provenance marker), Plan-012 (projection cursors)
CREATE TABLE session_events (
  id                     TEXT PRIMARY KEY,           -- ULID or UUID
  session_id             TEXT NOT NULL,              -- real session ULID/UUID, or a reserved node-scope sentinel for daemon-scope events (no FK; see Spec-005 §Daemon-Scope Event Binding)
  sequence               INTEGER NOT NULL,           -- monotonic per session
  occurred_at            TEXT NOT NULL,              -- RFC 3339 UTC with ms precision (wall-clock; display + audit)
  monotonic_ns           INTEGER NOT NULL,           -- process.hrtime.bigint() at emit; within-daemon ordering only (see Spec-013 §Clock Handling)
  category               TEXT NOT NULL,              -- e.g. 'run_lifecycle', 'assistant_output', 'tool_activity'
  type                   TEXT NOT NULL,              -- specific event type within category
  actor                  TEXT,                       -- the device a connection sent the event from, or the agent_id, or NULL for system
  payload                TEXT NOT NULL DEFAULT '{}', -- JSON event payload
  content_payload        BLOB,                       -- Assistant- and tool-generated prose (Spec-005 §Assistant Output + §Tool Activity): the assistant message body, the reasoning-update body, tool-call arguments / result / error bodies, and the provider's own denial an `approval.reviewer_denied` row keeps for `Allow once` (Claude Code's action as its `PermissionDenied` hook received it, Codex's review as Codex sent it). Stored as written, never encrypted by the app. A body of 1 KiB or more is compressed with raw deflate at level 6, and the encoding is recorded in the payload; a smaller body is stored as it is. NULL on every row whose event type carries no prose, event_maintenance rows among them. This column is machine-authored session work product (Spec-020 §PII Data Map).
  correlation_id         TEXT,                       -- links related events
  causation_id           TEXT,                       -- parent event that caused this one
  version                TEXT NOT NULL DEFAULT '1.0'
                         CHECK (version GLOB '[0-9]*.[0-9]*'), -- semver "MAJOR.MINOR" per ADR-017 §Decision #1
                                                               -- (never INTEGER; comparison must parse MAJOR/MINOR as ints —
                                                               -- lexical TEXT comparison is unsafe, e.g. "1.10" < "1.9")
  UNIQUE(session_id, sequence)
);

CREATE INDEX idx_session_events_session_seq ON session_events(session_id, sequence);
CREATE INDEX idx_session_events_type ON session_events(session_id, type);
CREATE INDEX idx_session_events_correlation ON session_events(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE UNIQUE INDEX idx_session_events_run_terminal_once ON session_events(json_extract(payload, '$.runId'), json_extract(payload, '$.runVersion')) WHERE category = 'run_lifecycle' AND type IN ('run.completed', 'run.failed', 'run.interrupted', 'run.stopped');

-- Projection-level terminal-key CHECK (Spec-005 at-most-once terminal emission; assigned to the Plan-004
-- schema work). A CHECK sees only the row being written, never the row an UPDATE replaces, so the guard is a
-- trigger trio: abort any terminal run_lifecycle write whose runId/runVersion key is NULL
-- OR the wrong storage class (json_type: runId 'text', runVersion 'integer' — a type-drifted "7"-vs-7 key bypasses the
-- UNIQUE index, which keys by storage class). The BEFORE UPDATE leg keys off OLD (the row WAS terminal) and additionally aborts a value-changing key rewrite (NEW key IS NOT OLD, null-safe) or a category/type de-scope — either frees the index entry for a duplicate terminal. The promote leg rejects re-typing any non-terminal row INTO the guarded set (terminal rows are INSERT-only): an OLD-keyed guard alone would let a null-keyed promotion slip both legs and the NULL-distinct UNIQUE index.
CREATE TRIGGER trg_run_terminal_key_insert BEFORE INSERT ON session_events
WHEN NEW.category = 'run_lifecycle'
  AND NEW.type IN ('run.completed', 'run.failed', 'run.interrupted', 'run.stopped')
  AND (json_extract(NEW.payload, '$.runId') IS NULL OR json_type(NEW.payload, '$.runId') <> 'text' OR json_extract(NEW.payload, '$.runVersion') IS NULL OR json_type(NEW.payload, '$.runVersion') <> 'integer')
BEGIN
  SELECT RAISE(ABORT, 'terminal run_lifecycle requires text runId + integer runVersion (non-null, correct storage class)');
END;
CREATE TRIGGER trg_run_terminal_key_update BEFORE UPDATE OF payload, category, type ON session_events
WHEN OLD.category = 'run_lifecycle'
  AND OLD.type IN ('run.completed', 'run.failed', 'run.interrupted', 'run.stopped')
  AND (json_extract(NEW.payload, '$.runId') IS NULL OR json_type(NEW.payload, '$.runId') <> 'text' OR json_extract(NEW.payload, '$.runVersion') IS NULL OR json_type(NEW.payload, '$.runVersion') <> 'integer' OR json_extract(NEW.payload, '$.runId') IS NOT json_extract(OLD.payload, '$.runId') OR json_extract(NEW.payload, '$.runVersion') IS NOT json_extract(OLD.payload, '$.runVersion') OR NEW.category IS NOT OLD.category OR NEW.type IS NOT OLD.type)
BEGIN
  SELECT RAISE(ABORT, 'terminal run_lifecycle row must preserve runId + runVersion (value + storage class) + category + type');
END;
CREATE TRIGGER trg_run_terminal_key_promote BEFORE UPDATE OF category, type ON session_events
WHEN NOT (OLD.category = 'run_lifecycle' AND OLD.type IN ('run.completed', 'run.failed', 'run.interrupted', 'run.stopped'))
  AND NEW.category = 'run_lifecycle'
  AND NEW.type IN ('run.completed', 'run.failed', 'run.interrupted', 'run.stopped')
BEGIN
  SELECT RAISE(ABORT, 'session_events rows cannot be promoted to terminal run_lifecycle by UPDATE — terminal rows are INSERT-only');
END;
```

**Terminal-exactly-once backstop.** The `idx_session_events_run_terminal_once` partial unique index is the schema-level terminal-exactly-once backstop (Plan-004): a duplicate terminal `run_lifecycle` row for the same `(runId, runVersion)` epoch fails loud with a `UNIQUE` violation; NULL `runId`/`runVersion` rows bypass it (SQLite NULL-distinctness), so the Plan-002 terminal emitter enforces the non-null-key precondition this index backstops. The engine semantics this backstop relies on are load-bearing, and each is cited to the official SQLite documentation: [expression indexes](https://sqlite.org/expridx.html) (the index keys on `json_extract(payload, …)` expressions), [partial indexes](https://sqlite.org/partialindex.html) (the `WHERE category = 'run_lifecycle' AND type IN (…)` filter), [UNIQUE-index enforcement](https://sqlite.org/lang_createindex.html#unique_indexes), and [NULL-distinctness](https://sqlite.org/nulls.html) (two NULLs are distinct for UNIQUE purposes, so NULL-key rows bypass the constraint). Beside it the schema carries the `trg_run_terminal_key_insert` / `trg_run_terminal_key_update` / `trg_run_terminal_key_promote` trigger trio — the projection-level CHECK-equivalent Spec-005's at-most-once-terminal-emission rule assigns to this schema work — which aborts terminal `run_lifecycle` writes whose `runId` / `runVersion` key is NULL **or the wrong storage class** (`json_type` must be `'text'` for `runId` and `'integer'` for `runVersion`, per the `RunId` string / any-run-progression-counter payload contract in [Spec-005 §Run Lifecycle](../../specs/005-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle) — a `"7"`-vs-`7` type-drifted key would otherwise bypass the storage-class-keyed UNIQUE index for exactly the malformed rows the backstop exists to catch). The INSERT leg closes the NULL-distinctness bypass the UNIQUE index cannot catch; the UPDATE leg (`BEFORE UPDATE OF payload, category, type`, keyed off `OLD` so a row that WAS terminal cannot escape by mutation) additionally aborts a **value-changing key rewrite** (`NEW` key `IS NOT` `OLD`, null-safe — an UPDATE rewriting `(R,7)` to another non-null pair would otherwise free the index entry for a duplicate terminal) and a **`category`/`type` de-scope** (flipping a terminal row out of the guarded set is the same escape). The promote leg closes the inverse escape: an UPDATE re-typing a non-terminal row INTO the guarded set is rejected outright — terminal rows are INSERT-only — so a null-keyed promotion cannot slip past the OLD-keyed update leg and the NULL-distinct UNIQUE index (Plan-004 schema work).

**Content payload (machine-authored prose).** `content_payload` is the durable home for the prose the _machine_ side of a session produces — the assistant message body, the reasoning-update body, and tool-call arguments / result / error bodies. It exists because [ADR-027](../../decisions/027-canonical-transcript-is-authoritative.md) rules the daemon's canonical transcript authoritative for the content of a provider session, and a projection rebuilt from `session_events` can only be authoritative for content the rows actually hold. It holds machine-authored session work product ([Spec-020 §PII Data Map](../../specs/020-data-retention-and-gdpr.md#pii-data-map)), stored plain like every other column. A body of 1 KiB or more is compressed with raw deflate at level 6 before it is written, and the encoding is recorded in the payload so a reader inflates it; a smaller body is stored as it is.

**Long bodies.** Unlike a person's message, `content_payload` admits machine-scale text: a tool result is routinely a file dump or a command's whole stdout. A body is kept whole, never truncated, refused or dropped, and a client fetches a long one on demand through the daemon's read rather than receiving it inside the event. Nothing removes a body in the background: a session's rows, bodies included, are kept until the person deletes the session with `Delete old data` ([Spec-005 §Event Compaction Policy](../../specs/005-session-event-taxonomy-and-audit-log.md#event-compaction-policy)).

**Purge.** Deleting a session deletes its rows outright, `content_payload` with them, with `secure_delete` on (§Pragmas), so the freed pages hold nothing readable.

**Relay disposition — the column is node-local.** `content_payload` is **never relayed**: the bytes stay on the node that wrote them, and a linked device reads a body only through the daemon's read, paired with the event and never merged into `payload` ([Spec-005 §Assistant Output](../../specs/005-session-event-taxonomy-and-audit-log.md#assistant-output-assistant_output)).

**A second node holding a body is unreachable in V1.** A session executes on exactly one bound runtime node ([Spec-027 §Required Behavior](../../specs/027-remote-control.md#required-behavior)), and every row in that session's log is authored by that node. No other daemon holds a row of this session, so there is no projection anywhere that would show a body it does not hold.

## Session Snapshots (Plan-001, extended by Plans 004, 012)

```sql
-- Owner: Plan-001 | Extended by: Plan-004, Plan-012
CREATE TABLE session_snapshots (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  as_of_sequence        INTEGER NOT NULL,           -- snapshot reflects events up to this sequence (projection-cursor state)
  state_blob            BLOB NOT NULL,              -- serialized session state
  created_at            TEXT NOT NULL,
  FOREIGN KEY (session_id, as_of_sequence) REFERENCES session_events(session_id, sequence)
);

CREATE INDEX idx_session_snapshots_session ON session_snapshots(session_id, as_of_sequence);
```

---

## Session Directory (Plan-001)

The daemon keeps one row per session it hosts in `sessions`, the directory that `session.list` and `session.read` answer from. [Spec-001 §State And Data Implications](../../specs/001-session-core.md#state-and-data-implications) owns the row; some of its columns are fixed here because other services read them:

- `shape TEXT NOT NULL CHECK (shape IN ('chat', 'project'))` — whether the session is a chat, bound to its own managed workspace, or a session in an attached project. It is set when the session is created and changes only when a chat is converted to a project. The sessions list groups by it, and it reaches clients as `shape` on `session.read` and `session.list`.
- `muted_at TEXT` — RFC 3339 UTC; NULL while the session is not muted. `session.muted` sets it and `session.unmuted` clears it, and a rebuild restores it from those events; it reaches clients as `muted` on `session.read` and `session.list`. While it is set, the session's `Finished` and `Failed` moments reach no channel and no device; `Waiting on you` and a workflow's Notify step are never silenced by it. The attention service reads it when it writes an entry.
- `group_id TEXT REFERENCES session_groups(id)` — the one group of its project the session sits in; NULL for a session in no group and for every chat. Indexed (`idx_sessions_group`), because the sessions list and search read a group's sessions by it. An archived session keeps it.

A session's groups, links and tags are the three layers of [Spec-001 §Groups, Links And Tags](../../specs/001-session-core.md#groups-links-and-tags): one place in the list, any number of relationships, any number of categories. All three are row-canonical daemon state written by the session service and the session tools, not rebuilt from the event log, and removed with their session.

```sql
-- Owner: Plan-001
CREATE TABLE session_groups (
  id           TEXT NOT NULL PRIMARY KEY,
  project_id   TEXT NOT NULL,              -- the project record the group belongs to; a chat has no groups
  name         TEXT NOT NULL,              -- the person's own casing, for display
  name_folded  TEXT NOT NULL,              -- the full-Unicode case fold of name, written by the store on every insert and rename
  created_at   TEXT NOT NULL
);

-- A group's name is unique in its project ignoring case, on the stored fold key, the same rule
-- agent definition names follow.
CREATE UNIQUE INDEX idx_session_groups_name_folded ON session_groups(project_id, name_folded);

CREATE INDEX idx_sessions_group ON sessions(group_id);

-- One row per pair of sessions and kind. The daemon writes or bumps a row when the event that makes it
-- is recorded, never by a rescan. Rows name sessions by id, so a rename changes none. Only a 'related'
-- row is ever deleted (the person's or an agent's Unlink); the others record what happened.
CREATE TABLE session_links (
  source_session_id  TEXT NOT NULL,
  target_session_id  TEXT NOT NULL,
  kind               TEXT NOT NULL
                     CHECK (kind IN ('started', 'copied_from', 'messaged', 'asked', 'mentioned', 'related')),
  use_count          INTEGER NOT NULL DEFAULT 1 CHECK (use_count >= 1),  -- messaged counts the messages traded
  first_at           TEXT NOT NULL,
  last_at            TEXT NOT NULL,          -- the 30-day halving of a link's weight is measured from here
  PRIMARY KEY (source_session_id, target_session_id, kind)
);

CREATE INDEX idx_session_links_target ON session_links(target_session_id, source_session_id);

-- Any number of tags per session, across projects, nested with '/'. The fold key makes a tag match
-- ignoring case, and a prefix match on it finds a parent's children ('billing' finds 'billing/stripe').
CREATE TABLE session_tags (
  session_id  TEXT NOT NULL,
  tag         TEXT NOT NULL,                 -- as written, for display
  tag_folded  TEXT NOT NULL,
  PRIMARY KEY (session_id, tag_folded)
);

CREATE INDEX idx_session_tags_tag ON session_tags(tag_folded, session_id);

-- Each session's related list, computed ahead by personalized PageRank cut at two steps and stored
-- under the session's id, so a read is one indexed lookup. A new link re-scores, in the background
-- after its event is written, only the two sessions it joins and their neighbors.
CREATE TABLE session_related (
  session_id          TEXT NOT NULL,
  related_session_id  TEXT NOT NULL,
  score               REAL NOT NULL,
  PRIMARY KEY (session_id, related_session_id)
);

CREATE INDEX idx_session_related_score ON session_related(session_id, score DESC);
```

Budget, at 10,000 sessions, 1,000,000 indexed messages, 100,000 links and 30,000 tags, measured on the daemon's own build: a related list under 1 ms and a search under 50 ms at p95. Measured on SQLite 3.50.4 at that size, a stored related list read in 0.012 ms and a tag or group lookup in 0.033 ms at p95.

---

## Session Console State (Plan-001)

The daemon's own session-scoped store for what a session holds outside its event log. [Spec-001 §State And Data Implications](../../specs/001-session-core.md#state-and-data-implications) declares the composer draft, its staged attachments and the review notes left on a file's lines durable here, so that a half-written message, its files and an unsent review reach the person's other devices; their columns are defined with the verbs that write them: `session.draftUpdate`, `session.attachmentAdd` / `session.attachmentRemove`, and `session.reviewNoteAdd` / `session.reviewNoteUpdate` / `session.reviewNoteRemove` ([api-payload-contracts §Operations Not Yet Built](../contracts/api-payload-contracts.md#operations-not-yet-built)). The block below holds the columns the spawn path reads: the session's own step bound and a Claude Code session's own advisor.

It is **configuration, not session history**: it is not events-canonical and is not rebuilt from the event log. A session's step bound is a preference the person set, so a log that can rebuild what a turn did has nothing to say about it.

```sql
-- Owner: Plan-001
CREATE TABLE session_console_state (
  session_id          TEXT NOT NULL PRIMARY KEY,  -- one row per session: written at `session.create` for a Claude Code session (its advisor), and for any other session on the first press that needs it
  max_steps_per_turn  INTEGER
                      CHECK (max_steps_per_turn IS NULL OR max_steps_per_turn >= 1),  -- this session's OWN bound on how many steps one turn may take. NULL = no session override, so the machine's own Runtime value applies, and where that is unset each provider does what it does on its own ([Spec-003 §The Step Bound On A Turn](../../specs/003-queue-steer-pause-resume.md#the-step-bound-on-a-turn)). The floor is 1 because a bound of zero would forbid the turn it bounds; the ceiling is the person's, since neither provider publishes one. The MACHINE-wide value is not here: it belongs to the Runtime settings page, so one number has one home on each side of the override
  advisor_model       TEXT,  -- a Claude Code session's own advisor: the model, or NULL when it is off. Copied at `session.create` from the machine settings file's `advisorModel` and changed only by `/advisor` in this session, each change appending `session.advisor_changed`; a later change to the default never reaches it
  updated_at          TEXT NOT NULL
);
```

The number is carried onto a spawn through `runtime_bindings.spawn_config` and realized by the driver, `--max-turns` on one leg and the daemon's own per-turn count on the other; a change reaches the session's next turn and never the turn in flight. The advisor rides the same path: every Claude Code process started for the session (after a restart, a resume or a provider switch, and a helper the bridge starts) reads `advisor_model` at launch.

---

## Queue and Intervention Tables (Plan-002)

```sql
-- Owner: Plan-002
CREATE TABLE queue_items (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'queued'
                  CHECK(state IN ('queued', 'admitted', 'superseded', 'canceled', 'not_delivered')),
  not_delivered_reason TEXT                    -- why a not_delivered item was not delivered: it waited past the
                  CHECK(not_delivered_reason IN ('timed_out', 'failed')),  -- daemon's own delivery timeout, or its delivery failed outright
  payload         TEXT NOT NULL DEFAULT '{}', -- JSON: context, metadata, identifiers, and the item's
                                              -- body, a person's send or an orchestration-authored
                                              -- prompt (a workflow step's input, an orchestrated
                                              -- child-run prompt), as plain text (Plan-002 T1.4,
                                              -- Spec-003). Every drain-selection field is its own
                                              -- column (state, target_run_id, session_id).
  target_run_id   TEXT,                       -- the run a user message is delivered into; NULL on an
                                              -- orchestration-authored item, which is admitted as a new run
  device_id       TEXT,                       -- the device a person's message came from (the machine's own
                                              -- screen or a linked device's channel), found from the
                                              -- connection at acceptance; NULL on an orchestration-authored
                                              -- item, the system's own (Queue And Intervention Model)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK((state = 'not_delivered') = (not_delivered_reason IS NOT NULL))  -- a not_delivered item always says why
);

CREATE INDEX idx_queue_items_session_state ON queue_items(session_id, state);
CREATE INDEX idx_queue_items_target_run ON queue_items(target_run_id) WHERE target_run_id IS NOT NULL;

-- Owner: Plan-002 (rejection_reason) | Extended by: Spec-004 (client_idempotency_key intervention dedupe)
CREATE TABLE interventions (
  id                     TEXT PRIMARY KEY,
  target_run_id          TEXT NOT NULL,
  type                   TEXT NOT NULL
                         CHECK(type IN ('steer', 'interrupt', 'faster_model_retry')),
  state                  TEXT NOT NULL DEFAULT 'requested'
                         CHECK(state IN ('requested', 'accepted', 'applied', 'rejected', 'degraded', 'expired')),
  payload                TEXT NOT NULL DEFAULT '{}', -- JSON: type-specific fields, a steer's text among them as plain text (Spec-003 §Required Behavior)
  expected_run_version   INTEGER NOT NULL,           -- MANDATORY fail-closed comparand (Spec-003 §Interfaces And Contracts / Plan-002 D-002-2)
  client_idempotency_key TEXT NOT NULL,              -- MANDATORY requester-generated UUID (a client's, or the daemon's own for its own stop); return-or-conflict intervention dedupe (Spec-004 §Required Behavior)
  device_id              TEXT,                       -- the device the intervention came from (the machine's own screen or a linked device's channel), found from the connection at acceptance; NULL means the daemon's own stop (Queue And Intervention Model)
  result                 TEXT,                       -- JSON: outcome details
  rejection_reason       TEXT,                       -- machine-readable rejected cause (driver.capability_unsupported foremost) — durable across a retry: the wire contract forbids result on rejected, so a retry that returns the saved result reconstructs rejectionReason from this column (Plan-002 T1.4/T3.13)
  created_at             TEXT NOT NULL,
  resolved_at            TEXT,
  UNIQUE(target_run_id, client_idempotency_key),     -- identical retry returns the saved result; key reuse with a differing payload rejects as intervention.idempotency_conflict (Spec-003 §Interfaces And Contracts) — distinct grain from command_receipts.command_id (per-command crash-recovery dedupe)
);

CREATE INDEX idx_interventions_run ON interventions(target_run_id);
CREATE INDEX idx_interventions_state ON interventions(state) WHERE state IN ('requested', 'accepted');

-- Owner: Plan-002 | Extended by: Plan-012 (recovery + two-phase idempotency protocol); Plan-003 (nullable mcp_task_id — MCP Tasks durable recovery handle)
CREATE TABLE command_receipts (
  id                TEXT PRIMARY KEY,
  command_id        TEXT NOT NULL UNIQUE,         -- idempotency key (client-supplied)
  run_id            TEXT,
  status            TEXT NOT NULL
                    CHECK(status IN ('accepted', 'rejected', 'completed', 'failed')),
  -- Two-phase commit columns
  started_at        TEXT,                         -- set by Phase 2 optimistic CAS; NULL until claimed
  completed_at      TEXT,                         -- set by Phase 3; NULL until terminal-status
  -- Plan-003's column: receiver-generated
  -- MCP Tasks taskId for a task-augmented MCP call (from the CreateTaskResult acceptance response).
  -- NULL until the receiver accepts — a crash before that leaves NULL and the call's run halts with
  -- `recovery-needed`. Spec-013 recovery reads this handle and polls tasks/get + tasks/result
  -- instead of halting. Written by Plan-003 T5.1 through the T3.13 receipt-write seam. Bounded like every persisted
  -- provider-declared string (the runtime_bindings defense-in-depth convention): the taskId is untrusted
  -- remote-peer output, so the CHECK bounds the SQLite-expressible part and the T5.1 write seam mirrors
  -- the same 256 — in CODE POINTS, since length(X) returns "the number of Unicode code points (not bytes)
  -- in input string X prior to the first U+0000 character"
  -- (https://www.sqlite.org/lang_corefunc.html#length). Both halves bind: the first sets the unit, the
  -- second is why the write seam's single bounded scan reports NUL over size whenever one walk sees
  -- both within its 256-code-point bound — a NUL-bearing handle measures short to length(X) and would
  -- otherwise be misreported as well-sized — while a NUL first reachable past that bound reports
  -- too-long instead: the scan stops at the first terminal fact it meets and never walks more than
  -- 257 code points of a hostile handle, so refusal cost is bounded. The seam additionally refuses a handle that
  -- is not well-formed Unicode, which the CHECK cannot see: UTF-8 prohibits encoding a lone surrogate
  -- outright ("The definition of UTF-8 prohibits encoding character numbers between U+D800 and U+DFFF",
  -- RFC 3629 §3, https://datatracker.ietf.org/doc/html/rfc3629#section-3), and the standard
  -- JavaScript-to-bytes conversion substitutes U+FFFD for each unpaired surrogate rather than failing
  -- ("To convert a JavaScript string into a scalar value string, replace any surrogates with U+FFFD",
  -- WHATWG Infra Standard, https://infra.spec.whatwg.org/#javascript-string-convert) — one or more
  -- U+FFFD per surrogate in practice, since the substitution width is the platform encoder's choice
  -- (both observed widths are pinned by the executable hazard proof in
  -- packages/runtime-daemon/src/provider/mcp/__tests__/task-handle-recorder.test.ts) — so the row
  -- would store a handle the receiver never issued.
  mcp_task_id       TEXT                          -- NULL default; MCP Tasks durable recovery handle
                    CHECK (mcp_task_id IS NULL OR (length(mcp_task_id) > 0 AND length(mcp_task_id) <= 256 AND instr(mcp_task_id, char(0)) = 0)),
  delivered         INTEGER NOT NULL DEFAULT 0     -- 1 once a task-augmented call's result has reached the conversation, by steering a running turn or starting one, so a result that arrives after a daemon restart is delivered once
                    CHECK (delivered IN (0, 1)),
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_command_receipts_run ON command_receipts(run_id) WHERE run_id IS NOT NULL;
-- Recovery sweep index: the startup sweep's in-flight receipts, each resumed by its task handle
-- or halted
CREATE INDEX idx_command_receipts_inflight ON command_receipts(run_id)
  WHERE started_at IS NOT NULL AND completed_at IS NULL;
```

---

## Driver and Runtime Binding Tables (Plan-003)

```sql
-- Owner: Plan-003 | Extended by: Plan-012 (recovery-aware persistence)
-- Provider-output defense-in-depth CHECKs (Plan-003 T2.1): contract_version and
-- resume_handle are provider-declared strings persisted at the write seam. The
-- DB CHECK layer bounds the SQLite-expressible part (length + NUL-rejection);
-- semver-shape validation is NOT expressible as a pure-SQLite CHECK and is
-- enforced at the write seam Zod guard (T2.2 runtime_bindings) using the
-- `semver` package. The 4096/64 length literals are the canonical bounds that
-- the T2.2 write-path guard reuses, so the two layers stay consistent.
CREATE TABLE runtime_bindings (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  driver_name         TEXT NOT NULL,            -- e.g. 'claude', 'codex'
  contract_version    TEXT NOT NULL             -- canonical, identifying semver of driver contract (build metadata rejected by the T2.2 write-path Zod guard)
                      CHECK (length(contract_version) > 0 AND length(contract_version) <= 64 AND instr(contract_version, char(0)) = 0),
  cli_version_raw     TEXT NOT NULL             -- the provider-printed CLI version verbatim (`rawVersion`), captured at every binding write (Spec-004 §Required Behavior `cliVersion` report)
                      CHECK (length(cli_version_raw) > 0 AND length(cli_version_raw) <= 128 AND instr(cli_version_raw, char(0)) = 0),
  cli_version_semver  TEXT                      -- the parsed form (`parsedVersion`); NULL where the printed version does not parse. Recorded and shown, never compared: no build is refused or called too old, parsed or not
                      CHECK (cli_version_semver IS NULL OR (length(cli_version_semver) > 0 AND length(cli_version_semver) <= 64 AND instr(cli_version_semver, char(0)) = 0)),
  resume_handle       TEXT                      -- provider-owned opaque handle
                      CHECK (resume_handle IS NULL OR (length(resume_handle) > 0 AND length(resume_handle) <= 4096 AND instr(resume_handle, char(0)) = 0)),
  spawn_config        TEXT NOT NULL DEFAULT '{}', -- JSON: daemon-owned record of the spawn-bound configuration realized at process spawn (executionPosture / callbackTools / subagentPolicy / outputSchema plus providerAccountId, maxStepsPerTurn and resolvedExecutablePath — each valued by Plan-003 T3.45 / T3.18 / T3.23); written at every spawn — the durable source recovery re-reads to reconstruct ResumeSessionParams' data legs without the original client request (function legs re-injected fresh, never stored). Daemon-constructed, so no provider-string CHECK — same trust class as runtime_metadata below
  runtime_metadata    TEXT NOT NULL DEFAULT '{}', -- JSON: provider-specific recovery data
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_runtime_bindings_run ON runtime_bindings(run_id);

-- Owner: Plan-003
CREATE TABLE driver_capabilities (
  driver_name       TEXT NOT NULL,
  capability_flag   TEXT NOT NULL
                    CHECK(capability_flag IN (
                      'resume', 'steer', 'interactive_requests', 'mcp',
                      'tool_calls', 'reasoning_stream', 'model_mutation',
                      'structured_output', 'rollback', 'session_fork', 'session_goals',
                      'callback_tools', 'subagents', 'context_compaction',
                      'provider_commands', 'output_speed'
                    )),
  supported         INTEGER NOT NULL DEFAULT 0, -- boolean: 0 or 1
                    -- The CHECK above lists every flag the capability union declares. Every driver_name holds one
                    -- row per flag, supported=0 where the driver does not declare it (undeclared = unsupported,
                    -- I-003-2), because the hydrator's exact-cardinality guard refuses a cache whose row count
                    -- differs from the union's. This CHECK lists every flag in the union.
  refreshed_at      TEXT NOT NULL,
  PRIMARY KEY (driver_name, capability_flag)
);

-- Owner: Plan-003
-- Per-tool metadata, cached so Settings › MCP servers shows each tool's declared idempotency_class
-- without round-tripping the driver; recovery never branches on it (Spec-004 §Required Behavior). Normalized per-tool rows
-- mirror the per-flag-row shape of driver_capabilities.
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

-- Owner: Plan-003
-- Per-driver capability-contract metadata. The capability cache is keyed by driver_name
-- (driver_capabilities + driver_tools are per-driver children); this parent row holds the
-- single per-driver contract_version so cold-start hydration can reconstruct
-- GetCapabilitiesResult = { capabilities: { flags, contractVersion }, tools } WITHOUT
-- round-tripping the driver (Spec-004 §Recovery Consequences cache-as-source-of-truth). Distinct from
-- runtime_bindings.contract_version, which records the version bound to a specific run.
-- Provider-output defense-in-depth CHECK (Plan-003 T2.1): `contract_version`
-- mirrors the `runtime_bindings.contract_version` bound (length + NUL-rejection,
-- 64-char ceiling). Semver-shape validation lives at the T2.4 write-path Zod
-- guard (the `semver` package) — not expressible as a pure-SQLite CHECK.
-- `contract_version` is a CANONICAL, IDENTIFYING semver string: build metadata
-- (SemVer §10, non-identifying) is rejected by the T2.4 write-path Zod guard, so
-- two byte-different strings can never denote the same contract version (which
-- would otherwise report a changed capability snapshot on a non-change).
CREATE TABLE driver_contract_meta (
  driver_name         TEXT PRIMARY KEY,
  contract_version    TEXT NOT NULL             -- canonical, identifying semver of the driver's advertised capability contract (build metadata rejected by the T2.4 write-path Zod guard)
                      CHECK (length(contract_version) > 0 AND length(contract_version) <= 64 AND instr(contract_version, char(0)) = 0),
  cli_version_raw     TEXT                      -- cached `cliVersion.rawVersion` from the last capability refresh (Spec-004 §Required Behavior); NULL until the first refresh writes it
                      CHECK (cli_version_raw IS NULL OR (length(cli_version_raw) > 0 AND length(cli_version_raw) <= 128 AND instr(cli_version_raw, char(0)) = 0)),
  cli_version_semver  TEXT                      -- cached `cliVersion.parsedVersion`; NULL where the printed version does not parse. Cold-start hydration MUST treat a NULL `cli_version_raw` as a cache miss and refresh from the driver — the required `GetCapabilitiesResult.cliVersion` is never fabricated from cache
                      CHECK ((cli_version_raw IS NOT NULL OR cli_version_semver IS NULL) AND (cli_version_semver IS NULL OR (length(cli_version_semver) > 0 AND length(cli_version_semver) <= 64 AND instr(cli_version_semver, char(0)) = 0))),
  refreshed_at        TEXT NOT NULL             -- last contract-meta write: every capability-refresh write, plus the eventless cli_version pair-only currency refresh, so it may lead driver_capabilities.refreshed_at
);
```

The build-metadata rejection above is grounded in the SemVer specification itself: per [Semantic Versioning 2.0.0 §10](https://semver.org/#spec-item-10), "Build metadata MUST be ignored when determining version precedence. Thus two versions that differ only in the build metadata, have the same precedence." Because `1.2.3+build.5` and `1.2.3+build.6` denote the SAME contract version under that precedence rule, persisting them as byte-distinct `contract_version` strings would let a non-change masquerade as a change. The shared write-path Zod guard (`assertValidContractVersion`, invoked from both the T2.2 `runtime_bindings` and T2.4 `driver_contract_meta` write paths) therefore REJECTS — rather than strips/normalizes — any value carrying build metadata, keeping the stored value byte-identical to what was validated and both `contract_version` columns canonical-identifying.

**Cloud tasks.** `cloud_tasks` holds one row per task a session sent to its provider's own cloud (`cloud.taskStart`), read by `cloud.taskList` and `cloud.taskRead`. Each row belongs to its session and records the task's state exactly as the provider last reported it, never a state the daemon inferred: on Codex `pending`, `ready`, `applied` or `error`, and on Claude Code `submitted` for the task's whole life, because Claude Code's command line reports no later state. Each row also keeps the task's environment label, from which [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.31 reads the project's last Codex environment back. [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) owns the row's columns.

---

## Runtime Node Local Tables (Plan-025)

```sql
-- Owner: Plan-025
-- This machine: its id, minted at the daemon's first start, and the friendly name read then
-- (Spec-002). One row, kept the same at every later start.
CREATE TABLE local_machine (
  singleton         INTEGER PRIMARY KEY CHECK (singleton = 1),
  node_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  minted_at         TEXT NOT NULL
);

-- Owner: Plan-025
CREATE TABLE node_trust_state (
  node_id           TEXT NOT NULL,
  owner_user_id     TEXT NOT NULL,
  established_at    TEXT NOT NULL,  -- first registration; a re-registration keeps it
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (node_id, owner_user_id)
);
```

---

## Workspace and Git Tables (Plan-006, Plan-007, Plan-008)

```sql
-- Owner: Plan-006
CREATE TABLE repo_mounts (
  id                  TEXT PRIMARY KEY,
  node_id             TEXT NOT NULL,          -- this machine's own node id, stamped by the daemon and never taken from the caller; a mount belongs to the machine, not to a session
  local_path          TEXT NOT NULL,          -- user-entered attach path (provenance)
  canonical_root      TEXT NOT NULL,          -- resolver output: absolute, symlink-resolved (envelope/dedupe key)
  origin              TEXT NOT NULL DEFAULT 'attached'
                      CHECK(origin IN ('attached', 'managed')),
                                              -- 'attached' = a project's folder the person attached or cloned; 'managed' = a chat's
                                              -- git-initialized workspace the daemon owns (Spec-001 §Required Behavior; ADR-030)
  managed_session_id  TEXT,                   -- the one chat a managed mount belongs to (event-sourced session id, no FK, matching session_id columns elsewhere)
  state               TEXT NOT NULL DEFAULT 'attached'
                      CHECK(state IN ('attached', 'detached', 'archived')),
  attached_at         TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  metadata            TEXT NOT NULL DEFAULT '{}', -- JSON; commonDir: attach-persisted canonicalized git common directory — the repo-identity anchor bind/run re-derivation must match (Spec-007 §Repo Identity And Common-Directory Keying (V1 Definition)); reads never write it
  CHECK ((origin = 'managed') = (managed_session_id IS NOT NULL))
);

-- Active-mount uniqueness binds the CANONICAL root per owning node (Plan-006 D-006-7): two
-- entered aliases resolving to one root are one mount, whichever session asked, and a folder
-- is listed once per machine with what uses it; detached rows stay re-attachable as new rows.
CREATE UNIQUE INDEX idx_repo_mounts_active_root
  ON repo_mounts(node_id, canonical_root) WHERE state = 'attached';
CREATE UNIQUE INDEX idx_repo_mounts_managed_session
  ON repo_mounts(managed_session_id) WHERE managed_session_id IS NOT NULL;

-- Owner: Plan-006
CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  repo_mount_id   TEXT NOT NULL REFERENCES repo_mounts(id),
  execution_mode  TEXT NOT NULL               -- where the session works, chosen at bind (session.create or repo.workspaceBind): 'bound-root' = the project's own checkout; 'provisioned-worktree' = a worktree of its own. A chat's managed workspace is always 'bound-root'
                  CHECK(execution_mode IN ('bound-root', 'provisioned-worktree')),
  fs_root         TEXT,                       -- resolved filesystem root
  state           TEXT NOT NULL DEFAULT 'preparing'
                  CHECK(state IN ('preparing', 'ready', 'stale', 'archived')),
  metadata        TEXT NOT NULL DEFAULT '{}', -- JSON; lastError detail on a failed mode switch (Spec-007); boundRoot: admitted bind origin — the bound-root execution-root carrier, never cleared by a new preparation (Spec-007/Spec-008)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_workspaces_session ON workspaces(session_id);
CREATE INDEX idx_workspaces_repo ON workspaces(repo_mount_id);

-- Owner: Plan-007 (provenance columns, active-branch uniqueness, cleanup stamp — D-007-5)
CREATE TABLE worktrees (
  id                    TEXT PRIMARY KEY,
  repo_mount_id         TEXT NOT NULL REFERENCES repo_mounts(id),
  created_by_session_id TEXT NOT NULL,              -- creating-session provenance (Spec-008 §State And Data Implications; session ids are event-sourced — no FK, matching session_id columns elsewhere)
  created_by_run_id     TEXT,                       -- creating-run provenance; NULL = pre-run explicit prepare (run ids are event-sourced, not FK-constrained)
  branch_name           TEXT NOT NULL,
  fs_root               TEXT NOT NULL,              -- filesystem path to worktree (under the daemon execution-roots dir, D-007-6)
  state                 TEXT NOT NULL DEFAULT 'creating'
                        CHECK(state IN ('creating', 'ready', 'dirty', 'merged', 'retired', 'failed')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  cleaned_at            TEXT                        -- async disk-cleanup stamp (retire records state; the sweep stamps cleanup)
);

CREATE INDEX idx_worktrees_repo ON worktrees(repo_mount_id);
-- At most one live checkout per (mount, branch): mirrors git's own constraint — a checkout existing
-- on disk (any non-retired, non-failed state, including 'merged') still holds the branch. Race arbiter
-- for the provenance-split collision policy (Spec-008 §Branch, Base And Preparation Rules).
CREATE UNIQUE INDEX idx_worktrees_active_branch ON worktrees(repo_mount_id, branch_name)
  WHERE state NOT IN ('retired', 'failed');

-- Owner: Plan-007
-- A worktree removed with `Discard and remove`, kept whole until the person presses `Delete now`; nothing
-- deletes it automatically. The folder is moved intact to
-- ~/.ai-sidekicks/worktrees/<project>/.removed/<name>-<removed id>/, holding the tree, a copy of git's
-- per-worktree record and a pack of the staged objects, and every commit the kept record names is pinned
-- in the person's repository under refs/sidekicks/removed/<removed id>/. `Put back` moves the tree back and
-- removes the pins; `Delete now` deletes the kept folder and the pins (Spec-008 §State And Data Implications).
CREATE TABLE removed_worktrees (
  id              TEXT PRIMARY KEY,
  mount_id        TEXT NOT NULL REFERENCES repo_mounts(id),
  project_id      TEXT NOT NULL,              -- the project record the worktree belonged to
  worktree_name   TEXT NOT NULL,
  original_path   TEXT NOT NULL,              -- where the worktree lived, for `Put back`
  branch          TEXT NOT NULL,
  head_commit     TEXT NOT NULL,
  removed_at      TEXT NOT NULL,
  size_bytes      INTEGER,                    -- read once after the discard, off its path; NULL until read
  size_read_at    TEXT
);

CREATE INDEX idx_removed_worktrees_project ON removed_worktrees(project_id);

-- Owner: Plan-007 | Extended by: Plan-008
-- Root carrier (D-007-5): provisioned-worktree rows reference the worktree; bound-root rows reference
-- none (the project's own checkout carries no Plan-007 root row).
CREATE TABLE branch_contexts (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  worktree_id        TEXT REFERENCES worktrees(id),
  base_branch        TEXT NOT NULL,
  head_branch        TEXT NOT NULL,
  upstream_ref       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX idx_branch_contexts_workspace ON branch_contexts(workspace_id);
CREATE UNIQUE INDEX idx_branch_contexts_worktree_workspace ON branch_contexts(worktree_id, workspace_id) WHERE worktree_id IS NOT NULL;  -- one binding row per (workspace, worktree) — D-007-15 upsert; the worktree-keyed BranchContextRead resolves on the pair

-- Owner: Plan-007 (D-007-16) | Extended by: Plan-014
-- Per-run execution binding (Spec-008 §State And Data Implications: execution mode as run setup data):
-- which workspace, mode and root a run that works in a repository executes against. One row per run, written
-- at the run's start: an agent run keyed by its run id, a workflow run keyed by its workflow run id (both
-- event-sourced UUIDs, so the PRIMARY KEY carries no FK). A run in a chat's own folder, and a `None` run, writes no row. A workflow
-- run's row lives as long as the run's record, and a session that moves while the run is paused leaves its
-- steps on the recorded root (Spec-015 §Interfaces And Contracts).
-- released_at stamps run-terminal release; an undo leaves it as it is (Spec-003 §Required Behavior; the Plan-007 bundle owns the implementing task).
CREATE TABLE run_execution_contexts (
  run_id             TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,                  -- event-sourced session id (no FK, matching session_id columns elsewhere)
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  execution_mode     TEXT NOT NULL
                     CHECK(execution_mode IN ('bound-root', 'provisioned-worktree')),
  execution_root     TEXT NOT NULL,
  git_common_dir     TEXT NOT NULL,                  -- `git rev-parse --git-common-dir` (absolute) captured at context creation: the surviving canonical git dir for the base pins under `refs/sidekicks/base/<owner id>/` and the alternate a capture is read through, so pin removal outlives a worktree retirement of execution_root (provisioned-worktree → the main repository's git dir; bound-root → <root>/.git)
  worktree_id        TEXT REFERENCES worktrees(id),
  branch_context_id  TEXT NOT NULL REFERENCES branch_contexts(id),
  point_capture_error TEXT,                          -- workflow runs: why a snapshot point after the start failed to capture; NULL while every point captured. A fault at the start fails the run before its first step instead
  created_at         TEXT NOT NULL,
  released_at        TEXT,
  -- Mode-conditional identity: a provisioned-worktree row names its worktree, a bound-root row names none,
  -- and both carry their branch context (Spec-008 §State And Data Implications).
  CHECK ((execution_mode = 'provisioned-worktree') = (worktree_id IS NOT NULL))
);

CREATE INDEX idx_run_execution_contexts_workspace ON run_execution_contexts(workspace_id);
```

**Project record.** An attached repository is a project, and each project keeps a durable record beside its mount: its display name, the setup steps its worktrees run after preparation, its own environment rows, whether it is archived, and a cloning mark while `repo.clone` fetches it. One origin holds one project record, so attaching a folder that is already a project finds that project. Renaming a project edits the display name alone. Deleting a project forgets the record and detaches its mount; its sessions and the folder on disk stay ([Spec-007 §Required Behavior](../../specs/007-repo-attachment-and-workspace-binding.md#required-behavior)). The removed-worktree records, the agent definitions and the workflow secrets key a project by this record's id.

---

## Artifact Tables (Plan-011)

```sql
-- Owner: Plan-011
-- + size_bytes realizes the OCI manifest envelope (D-011-1).
CREATE TABLE artifact_manifests (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  run_id             TEXT,
  created_by         TEXT,                       -- the device the publishing request came from; NULL for a daemon-produced artifact
  artifact_type      TEXT NOT NULL              -- Spec-012 §Interfaces And Contracts discriminator (D-011-3)
                     CHECK(artifact_type IN ('file', 'diff', 'summary', 'log', 'design', 'workflow_output')),
  state              TEXT NOT NULL DEFAULT 'pending'
                     CHECK(state IN ('pending', 'published', 'superseded')),
  content_hash       TEXT NOT NULL,              -- SHA-256 content address (OCI `digest`); intrinsic to a content-addressed manifest (I-011-1), set at insert by the writing producer (AttachmentIngest or ArtifactPublish) from its own payload — D-011-1
  size_bytes         INTEGER NOT NULL,           -- OCI manifest-descriptor `size` (payload byte length); set at insert by the writing producer from its own payload, never a payload-less row — D-011-1
  metadata           TEXT NOT NULL DEFAULT '{}', -- JSON: daemon-side provenance, the file name and the media type (Spec-012)
  created_at         TEXT NOT NULL
);

CREATE INDEX idx_artifact_manifests_session ON artifact_manifests(session_id);
CREATE INDEX idx_artifact_manifests_run ON artifact_manifests(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_artifact_manifests_hash ON artifact_manifests(content_hash);

-- Owner: Plan-011
CREATE TABLE artifact_payload_refs (
  id              TEXT PRIMARY KEY,
  manifest_id     TEXT NOT NULL REFERENCES artifact_manifests(id),
  storage_path    TEXT NOT NULL,              -- filesystem path or CAS key
  media_type      TEXT NOT NULL,              -- MIME type
  size_bytes      INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_artifact_payload_refs_manifest ON artifact_payload_refs(manifest_id);
-- The derived-refcount lookup key — the session sweep
-- counts surviving references by storage_path on every reclaim decision (Spec-012 §Local Artifact
-- Deletion And CAS Reclaim (V1)), and an unindexed lookup would full-scan the table each time.
CREATE INDEX idx_artifact_payload_refs_storage_path ON artifact_payload_refs(storage_path);
```

> **The OCI manifest envelope.** `artifact_manifests.size_bytes` (OCI manifest-descriptor `size`) realizes the OCI envelope per D-011-1. An artifact is never changed in place. **`content_hash`/`size_bytes` are `NOT NULL`:** a content-addressed manifest's `digest` is intrinsic to its identity (I-011-1), and each producer (Plan-011 Task 2 AttachmentIngest, Task 3 ArtifactPublish) computes the SHA-256 + byte length from its own payload and inserts its manifest with both columns set in the same transaction as the payload-ref — the two are independent producers, each writing its own manifest (so the `artifactId` AttachmentIngest returns resolves from the ingest-written manifest, not a later publish), so neither is ever NULL and no payload-less manifest is ever read — this is 1:1 with the **required** `digest`/`size` fields on the `ArtifactManifest` wire shape ([api-payload-contracts.md](../contracts/api-payload-contracts.md)). The file name lives in `metadata`, which the wire carries as `ArtifactManifest.metadata`.

---

## Approval Tables (Plan-009)

The 6 canonical approval categories: `tool_execution`, `file_write`, `network_access`, `destructive_git`, `plan_approval`, `gate`. A question and an MCP elicitation are not approvals: each is one `question.asked` record, answered outside the approval pipeline.

```sql
-- Owner: Plan-009 (D-009-2)
CREATE TABLE approval_requests (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,        -- owning session (Spec-010 §Required Behavior; Spec-005 §Approval Flow payload; projection key);
                                              -- event-sourced session id (no FK, matching session_id columns elsewhere)
  run_id                TEXT NOT NULL,        -- no REFERENCES: run state is event-sourced (ADR-016; interventions precedent)
  requested_by          TEXT NOT NULL,        -- requester actor (the agent's actor id, or the device a person's request came from; Spec-010 §Required Behavior)
  category              TEXT NOT NULL
                        CHECK(category IN (
                          'tool_execution', 'file_write', 'network_access', 'destructive_git',
                          'plan_approval', 'gate'                                 -- mirrors Spec-010 canonical enum
                        )),
  scope                 TEXT NOT NULL,        -- requested scope descriptor
  resource_descriptor   TEXT NOT NULL DEFAULT '{}', -- target resource details (JSON; Spec-010 §Interfaces And Contracts, 'must include')
  ask_id                TEXT,                 -- originating provider permission ask's askId, set iff the request was
                                              -- minted by the CP-009-5 permission-ask normalizer; rebuilt from
                                              -- approval.requested.askId on rebuild (D-009-6/D-009-7) so outcome routing to the native
                                              -- ask survives restart with several in-flight asks on one run
  state                 TEXT NOT NULL DEFAULT 'pending'
                        CHECK(state IN ('pending', 'approved', 'rejected', 'canceled')),
                                              -- No 'expired' state and no deadline column: a request waits until it is
                                              -- answered. Moving the session's permission level to one that never asks
                                              -- answers an open request -- the blocked call runs -- so it lands
                                              -- 'approved'; only an interrupt or any other end of its run and the
                                              -- provider process ending land 'canceled'. Nothing on this table is left
                                              -- for a sweep to settle and silence is never read as either a grant or a
                                              -- denial (Spec-010 §Required Behavior)
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL         -- last state-transition instant (a cancel carries no resolution row)
);

CREATE INDEX idx_approval_requests_run ON approval_requests(run_id);
CREATE INDEX idx_approval_requests_session ON approval_requests(session_id);
CREATE INDEX idx_approval_requests_state ON approval_requests(state) WHERE state = 'pending';
CREATE UNIQUE INDEX idx_approval_requests_ask ON approval_requests(run_id, ask_id) WHERE ask_id IS NOT NULL;
-- UNIQUE (run_id, ask_id): exactly one approval row per native ask — a normalizer retry or a rebuild's
-- re-mint collides here instead of persisting a duplicate pending row whose outcome routing
-- would then fan out or pick arbitrarily (Spec-010 one ask↔one approval)

-- Owner: Plan-009
CREATE TABLE approval_resolutions (
  request_id               TEXT PRIMARY KEY REFERENCES approval_requests(id),
                                              -- PK = the durable wire id (approvalRequestId): enforces the 1:1 decision row
                                              -- and keeps every column event-derivable for a rebuild here or on a peer (I-009-9).
                                              -- The first answer from any device settles the request.
  device_id                TEXT NOT NULL,     -- the answering device, the one whose connection carried the answer; a card
                                              -- answered elsewhere reads it as `Answered on <device>` (Spec-027 §Required Behavior)
  decision                 TEXT NOT NULL
                           CHECK(decision IN ('approved', 'rejected')),
  effective_scope          TEXT NOT NULL,     -- granted scope; = request scope unless the answer narrowed it (Spec-010 §Required Behavior);
                                              -- never broader than requested (domain invariant; Phase-2 enforced)
  remembered_scope_kind    TEXT               -- 'session' | 'project' when the answer handed a rule to the provider; NULL otherwise (Spec-010 §Interfaces And Contracts)
                           CHECK(remembered_scope_kind IS NULL OR remembered_scope_kind IN ('session', 'project')),
  remembered_scope_pattern TEXT,              -- the derived subject of that rule, nullable
  resolved_at              TEXT NOT NULL
);
```

The daemon keeps no table of approval rules: the providers keep them ([Spec-010 §Default Behavior](../../specs/010-approvals-permissions-and-trust-boundaries.md#default-behavior)), and a session's own answers are its `approval_resolutions` rows and its `approval.remembered` and `approval.rule_revoked` events, which the inspector's `Rules` reads beside the providers' own rules.

---

## Credential Policy Reference (Plan-009)

A run's `executionPosture.credentialPolicyRef` is a plain reference naming the credential deny list the daemon handed the provider for that run ([Spec-010 §Required Behavior](../../specs/010-approvals-permissions-and-trust-boundaries.md#required-behavior) posture semantics). It rides the `run.running` posture in `session_events` and needs no table of its own: deleting a session deletes it with the session's rows.

---

## Workflow Tables (Plan-014)

Full workflow-engine schema. Its tables hold the definitions and their version chain, the runs, the append-only gate history (C-13/I7), a form step's draft, the per-step record, the armed triggers, the webhook tokens, the per-node key-value store and the workflow secrets' records ([Spec-015 §Interfaces And Contracts](../../specs/015-workflow-authoring-and-execution.md#interfaces-and-contracts)). `session_events` remains canonical truth; tables 3, 5 and 6 are rebuildable projections, 1, 2 and 4 are immutable truth, and 7 to 10 are MUTABLE truth: what this machine is armed to do next, and which secrets it holds, are facts no event history can reconstruct, so the durable row is the truth and the in-process timer is only a cache over it, re-armed from the row after a restart ([Spec-015 §Truth vs projection vs ephemeral (SA-24)](../../specs/015-workflow-authoring-and-execution.md#truth-vs-projection-vs-ephemeral-sa-24)). One column on the projection tier is truth as well: a waiting step's `wait_deadline_at` is written when the step starts waiting, and the deadline timer is a cache over it.

The normalized-table-over-blob shape and the rebuildable-projection split align with industry persistence precedents: durable-execution engines persist normalized state per run rather than monolithic blobs ([Restate — What is Durable Execution](https://restate.dev/what-is-durable-execution)); and large-engine persistence tiers separate hot live state from cold archive ([Argo Workflows — Workflow Archive](https://argo-workflows.readthedocs.io/en/latest/workflow-archive/)). [Spec-015 §References](../../specs/015-workflow-authoring-and-execution.md#references) enumerates the full primary-source corpus.

**Canvas geometry is stored, and it is not definition bytes.** A document's own `layout` section — a position per node, an optional viewport and the sticky notes — sits **outside** the hashed body and outside the BLAKE3 preimage, and is persisted in a `layout_json` column beside the body on `workflow_definitions` and on `workflow_versions` ([Spec-015 §Canvas layout is not definition bytes (SA-32)](../../specs/015-workflow-authoring-and-execution.md#canvas-layout-is-not-definition-bytes-sa-32)). It is part of the document rather than a client's private note, so it travels with the document — the file form carries it as an optional section, and a document that arrives with none is laid out deterministically, left to right, by the same layout library in the daemon and in the renderer, so a definition is never unopenable and opens the same way twice. Because no byte the engine reads changes with it, a drag mints no version and enters no rebuild; it is not a storage tier of its own. Park-and-resume is the `waiting` status on tables 3 and 6, with a waiting step's cause, its armed resume instant, the spent account an `account` wait groups under and its deadline on the step's row; its always-on engine event record lands on the Plan-017-owned bounded-retention diagnostic tier ([Spec-015 §Engine event record (SA-40)](../../specs/015-workflow-authoring-and-execution.md#engine-event-record-sa-40)), whose buckets are log files in the daemon's data folder, never tables of this schema (Plan-014 CP-014-9).

```sql
-- ========================================================================
-- 1. workflow_definitions — content-hashed, immutable, schema-versioned
-- ========================================================================
-- Owner: Plan-014
-- Commitments: C-1 (one document plus a typed TypeScript SDK), C-8 (schema version marker)
CREATE TABLE workflow_definitions (
  id                   TEXT PRIMARY KEY,               -- ULID; NOT the content hash
  name                 TEXT NOT NULL,                  -- author-facing name, in the person's own casing
  name_folded          TEXT NOT NULL,                  -- the full-Unicode case fold of name, written by the store on every insert and rename
  content_hash         TEXT NOT NULL,                  -- BLAKE3 over JCS-canonicalized definition body
  schema_version       TEXT NOT NULL                   -- the document's own schemaVersion, verbatim; V1 value '2' (Spec-015 §Required Behavior). A string rather than a number so a later '2.1' round-trips
                       CHECK(schema_version GLOB '[0-9]*'),
  definition_body      TEXT NOT NULL,                  -- JSON (canonicalized per RFC 8785); full author-supplied definition
  layout_json          TEXT,                           -- JSON: the document's own layout section — a position per node, an optional viewport, the sticky notes. OUTSIDE the content_hash preimage, so editing it mints no version; NULL = written with no layout, which opens laid out deterministically left to right
  -- The workflow's tags: matched ignoring case, nested with '/', no spaces. Set from the builder
  -- header or by an agent through the workflow authoring call; OUTSIDE the content_hash preimage, so
  -- a change mints no version. The Workflows tab's row and its tag filter read them.
  tags                 TEXT NOT NULL DEFAULT '[]'
                       CHECK(json_valid(tags) AND json_type(tags) = 'array'),
  -- The workflow's own permission level, set from the builder's level pill and starting at 'yolo':
  -- every run of the workflow uses it wherever the run lives, and a live run takes a change from its
  -- next step. OUTSIDE the content_hash preimage, so a change mints no version.
  permission_level     TEXT NOT NULL DEFAULT 'yolo'
                       CHECK(permission_level IN ('readonly','ask','reviewed','sandboxed','yolo')),
  created_at           TEXT NOT NULL,
  created_by           TEXT,                           -- the device the save came from
  deleted_at           TEXT                            -- the soft delete: set when the person deletes the workflow, whose runs keep their pinned versions; NULL while it is in the library
);

-- One library, so a name names one workflow: unique among the workflows not deleted ignoring case,
-- on the stored fold key, the same rule agent definition names follow, and a deleted workflow's name
-- can be used again. A save, an import or a create whose name another workflow holds in any letter
-- case is refused with workflow.definition_refused (finding name_taken).
CREATE UNIQUE INDEX idx_workflow_definitions_name_folded ON workflow_definitions(name_folded) WHERE deleted_at IS NULL;
CREATE INDEX idx_workflow_definitions_content_hash ON workflow_definitions(content_hash);

-- Note: `updated_at` intentionally absent — definitions are immutable by C-9/F13 convention.
-- Edits create a new row in workflow_versions referencing this row as a parent.

-- ========================================================================
-- 2. workflow_versions — definition history chain (F13 additive versioning)
-- ========================================================================
-- Owner: Plan-014
-- Commitments: F13 / C-8 version-API-at-V1; see Spec-015 §Required Behavior
CREATE TABLE workflow_versions (
  id                   TEXT PRIMARY KEY,               -- ULID
  definition_id        TEXT NOT NULL REFERENCES workflow_definitions(id),
  version_number       INTEGER NOT NULL,               -- monotonic per definition_id
  parent_version_id    TEXT REFERENCES workflow_versions(id), -- NULL at version_number=1
  parent_content_hash  TEXT,                           -- BLAKE3 of parent definition body; NULL at version 1
  content_hash         TEXT NOT NULL,                  -- BLAKE3 of THIS version's body
  definition_body      TEXT NOT NULL,                  -- JSON (canonicalized per RFC 8785); THIS version's full definition document — name, the trigger node, the nodes and the edges (Spec-015 §Graph model — nodes, ports, and edges (SA-29)) — the BLAKE3 preimage of content_hash, so a version read serves the whole document parsed from this body and read -> export reproduces the canonical bytes verbatim (storing the nodes alone would leave a later version's name and trigger unreconstructable against content_hash; not a duplicate of workflow_definitions.definition_body above — that row carries the definition's current author-supplied body, each version row snapshots its own immutable bytes)
  layout_json          TEXT,                           -- JSON: this version's layout section, snapshotted beside its immutable body and outside content_hash's preimage, so an export of any version reproduces the file form it was written as
  author_note          TEXT,                           -- opt-in changelog message
  created_at           TEXT NOT NULL,
  created_by           TEXT,                           -- the device the save came from
  saved_by_agent_id    TEXT,                           -- the agent that saved this version through the authoring call; NULL where the person saved it in the builder, so the Versions panel names the user or that agent
  UNIQUE(definition_id, version_number),
  UNIQUE(definition_id, content_hash)                  -- per-definition: one definition never stores the same bytes as two versions
);

CREATE INDEX idx_workflow_versions_definition ON workflow_versions(definition_id, version_number DESC);
CREATE INDEX idx_workflow_versions_parent ON workflow_versions(parent_version_id)
  WHERE parent_version_id IS NOT NULL;

-- ========================================================================
-- 3. workflow_runs — one row per run: status, timings, trigger, chain
-- ========================================================================
-- Owner: Plan-014
-- A run's row and its step data on workflow_steps are kept until the person deletes the run or its
-- session; nothing drops them on a timer. A run's time cap is the
-- one `Stop a run after` setting on Settings › Runtime, off by default, and time spent waiting on a person
-- does not count against it; no run carries a cap, a step budget or a pool reservation of its own.
CREATE TABLE workflow_runs (
  id                        TEXT PRIMARY KEY,          -- the workflow run id, an event-sourced UUID; run_execution_contexts keys the captured context of a run that works in a repository by it
  workflow_version_id       TEXT NOT NULL REFERENCES workflow_versions(id),
  session_id                TEXT NOT NULL,             -- the asking chat's session, or the workflow's own session for a run no chat asked for
  status                    TEXT NOT NULL DEFAULT 'new'
                            CHECK(status IN (
                              'new','running','waiting','succeeded','failed','canceled','crashed'
                            )),
  mode                      TEXT NOT NULL
                            CHECK(mode IN ('manual','trigger','webhook','chat','agent','retry','sub-workflow')),
  trigger_json              TEXT NOT NULL DEFAULT '{}', -- JSON: the trigger record — which trigger node started the run and with what
  started_by                TEXT NOT NULL,             -- who or what started it: the user, a schedule, chat, an agent, a webhook, a file event or a parent workflow
  started_at                TEXT,                      -- RFC 3339 UTC; NULL while the run is new
  finished_at               TEXT,
  -- Result
  failure_reason            TEXT,                       -- null unless status in ('failed','canceled','crashed')
  failure_detail            TEXT,                       -- JSON; includes cancellation_reason per Spec-015 §Workflow Transcript Integration
  -- Chains: a run that starts runs. Every row names its chain's first run; the first run's own row
  -- counts the runs the chain has started and records the person's answer to the chain's question,
  -- which is itself a row in workflow_gate_resolutions, so a chain needs no table of its own.
  chain_root_run_id         TEXT NOT NULL,             -- the chain's first run; the run's own id for a first run
  chain_from_error          INTEGER NOT NULL DEFAULT 0 -- 1 when an error trigger joined the chain
                            CHECK(chain_from_error IN (0,1)),
  chain_run_count           INTEGER,                   -- first run only: runs the chain has started, the first included, incremented in the transaction that creates each run
  chain_kept_going          INTEGER                    -- first run only: 1 once the person answered `Keep going`
                            CHECK(chain_kept_going IS NULL OR chain_kept_going IN (0,1)),
  kept                      INTEGER NOT NULL DEFAULT 0 -- the run's Keep mark: deleting old runs (workflow.runsDelete) leaves a kept run
                            CHECK(kept IN (0,1)),
  created_at                TEXT NOT NULL,
  CHECK((chain_root_run_id = id) = (chain_run_count IS NOT NULL)),
  CHECK((chain_run_count IS NULL) = (chain_kept_going IS NULL))
);

CREATE INDEX idx_workflow_runs_session ON workflow_runs(session_id);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status)
  WHERE status IN ('new','running','waiting');
CREATE INDEX idx_workflow_runs_chain ON workflow_runs(chain_root_run_id);  -- `Stop them all` cancels every run of the chain still going
CREATE INDEX idx_workflow_runs_version ON workflow_runs(workflow_version_id);

-- ========================================================================
-- 4. workflow_gate_resolutions — append-only per C-13 / I7
-- ========================================================================
-- Owner: Plan-014
-- Commitment: C-13 append-only approval history; the invariant
-- is I7 in Spec-015 §Pitfalls To Avoid.
CREATE TABLE workflow_gate_resolutions (
  id                         TEXT PRIMARY KEY,          -- ULID
  workflow_run_id            TEXT NOT NULL REFERENCES workflow_runs(id),
  sequence                   INTEGER NOT NULL,          -- per-run monotonic starting at 1
  node_id                    TEXT,                      -- the human.approval node answered; NULL for a chain's question, which belongs to the run
  -- Gate identity
  gate_kind                  TEXT NOT NULL
                             CHECK(gate_kind IN (
                               'human.approval','chain'
                             )),
  approval_category          TEXT                       -- mirrors Plan-009 approval_requests.category when applicable
                             CHECK(approval_category IS NULL OR approval_category IN (
                               'tool_execution','file_write','network_access','destructive_git',
                               'plan_approval','gate'
                             )),
  approval_request_id        TEXT NOT NULL REFERENCES approval_requests(id), -- the Plan-009 approval request this gate answered
  -- Resolution
  outcome                    TEXT NOT NULL
                             CHECK(outcome IN ('approved','rejected')),
  device_id                  TEXT NOT NULL,             -- the answering device, as on approval_resolutions
  resolved_at                TEXT NOT NULL,
  decision_context           TEXT NOT NULL DEFAULT '{}', -- JSON: scope, resource, reason text, etc.
  UNIQUE(workflow_run_id, sequence),
  CHECK((gate_kind = 'human.approval') = (node_id IS NOT NULL))
);

CREATE INDEX idx_gate_resolutions_run ON workflow_gate_resolutions(workflow_run_id, sequence);
CREATE INDEX idx_gate_resolutions_node ON workflow_gate_resolutions(workflow_run_id, node_id)
  WHERE node_id IS NOT NULL;
CREATE INDEX idx_gate_resolutions_approval ON workflow_gate_resolutions(approval_request_id)
  WHERE approval_request_id IS NOT NULL;

-- No UPDATE or DELETE triggers — append-only enforced at application layer (writer worker only inserts).
-- Each row's id is the gateResolutionId that the session's workflow.gate_resolved event carries.

-- ========================================================================
-- 5. human_phase_form_state — daemon-held draft of a form step
-- ========================================================================
-- Owner: Plan-014
-- Carries a form step's drafts (Spec-015 §Human form drafts (SA-26)), keyed by run and node.
-- Written through `workflow.humanFormDraftSave`; each autosave bumps the row's own
-- draft version. A client never keeps a form draft in window storage.
CREATE TABLE human_phase_form_state (
  id                      TEXT PRIMARY KEY,           -- ULID
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id),
  node_id                 TEXT NOT NULL,              -- the form node in the run's pinned definition
  draft_json              TEXT NOT NULL DEFAULT '{}', -- JSON: current form field values
  draft_version           INTEGER NOT NULL DEFAULT 1, -- bumps on each autosave tick; optimistic-concurrency token
  submitted               INTEGER NOT NULL DEFAULT 0  -- boolean; 1 terminal
                          CHECK(submitted IN (0,1)),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE(workflow_run_id, node_id)                    -- one draft row per (run, form node)
);

CREATE INDEX idx_human_phase_form_state_step ON human_phase_form_state(workflow_run_id, node_id)
  WHERE submitted = 0;

-- ========================================================================
-- 6. workflow_steps — one row per step attempt (projection over the events
--     the run, approval and form pipelines already emit)
-- ========================================================================
-- Owner: Plan-014
-- A projection, not a second account of the run: every field below except wait_deadline_at is derivable
-- from the log, which is what keeps one step's history a function of the events rather than a parallel
-- record. wait_deadline_at is truth: it is written when the step starts waiting, and the deadline timer
-- is a cache over it, re-armed from the row when the daemon starts.
CREATE TABLE workflow_steps (
  workflow_run_id   TEXT NOT NULL REFERENCES workflow_runs(id),
  node_id           TEXT NOT NULL,                 -- the node in the pinned definition this attempt ran
  attempt           INTEGER NOT NULL,              -- 1-based; a retry of the same node at the same point
  execution_index   INTEGER NOT NULL,              -- per-run monotonic: the faithful what-happened-when order for a branching run, independent of graph shape
  source_json       TEXT NOT NULL DEFAULT '[]'     -- JSON array, one entry per input slot: the edge that ACTUALLY fed it and which run of the source produced it (null for a slot nothing fed), so a run page can say this merge consumed the third run of a loop
                    CHECK(json_valid(source_json) AND json_type(source_json) = 'array'),
  status            TEXT NOT NULL
                    CHECK(status IN ('pending', 'running', 'waiting', 'waiting-memory', 'succeeded', 'failed', 'skipped', 'canceled')),
                                                 -- 'waiting-memory' = held by the memory gate before it starts; 'canceled' = running or waiting when its run ended failed or canceled
  wait_cause        TEXT                         -- what a waiting step waits on: a person ('approval', 'form', 'reply'), its chain's question ('chain'), or a spent provider account ('account')
                    CHECK(wait_cause IS NULL OR wait_cause IN ('approval', 'form', 'reply', 'chain', 'account')),
  resume_at         TEXT,                        -- the instant a step parked on a spent account resumes itself, where one is armed; NULL where none is, which reads as awaiting resume
  wait_account_id   TEXT,                        -- a step waiting on 'account': the spent provider account, which workflow.runAttentionList groups by, so every run waiting on one account presents as one entry
  wait_deadline_at  TEXT,                        -- the instant a step waiting on a person gives up, set only where its Timeout is
  started_at        TEXT NOT NULL,
  finished_at       TEXT,                          -- NULL until the step settles
  -- The payload refs a step panel reads, each stored as the JSON WorkflowPayloadRef shape so a
  -- run read stays bounded whatever the step produced: under the 64 KiB inline bound the payload is
  -- items on this row, above it an artifact through the ordinary ingest pipeline and this row keeps the
  -- reference.
  input_ref         TEXT NOT NULL
                    CHECK(json_valid(input_ref)),
  output_ref        TEXT NOT NULL
                    CHECK(json_valid(output_ref)),
  log_ref           TEXT NOT NULL
                    CHECK(json_valid(log_ref)),
  cost_usd_micros   INTEGER,                     -- integer micro-dollars; NULL = never billed; the step still reads `$0.00` and names no account
  cost_account_id   TEXT,                          -- the provider account that paid; deliberately no foreign key, for the reason agent_definitions states
  error_json        TEXT                           -- JSON: the typed step error (message plus the node it belongs to); NULL on every non-failed status
                    CHECK(error_json IS NULL OR json_valid(error_json)),
  advisories_json   TEXT                           -- JSON array of non-fatal hints — an unwired branch that dropped items, a deprecated param, a truncated output. Never errors, and NULL where the step attached none
                    CHECK(advisories_json IS NULL OR (json_valid(advisories_json) AND json_type(advisories_json) = 'array')),
  PRIMARY KEY (workflow_run_id, execution_index),  -- the execution index is what identifies an attempt within its run; (node_id, attempt) can repeat across branches of one run
  CHECK((cost_usd_micros IS NULL) = (cost_account_id IS NULL)),  -- a figure always names the account that paid it
  CHECK((status = 'waiting') = (wait_cause IS NOT NULL)),
  -- The live wait state clears in the same statement that moves the step out of 'waiting'.
  CHECK(status = 'waiting' OR (resume_at IS NULL AND wait_account_id IS NULL AND wait_deadline_at IS NULL)),
  CHECK(wait_cause = 'account' OR (resume_at IS NULL AND wait_account_id IS NULL)),
  CHECK(wait_deadline_at IS NULL OR wait_cause IN ('approval', 'form', 'reply'))
);

CREATE INDEX idx_workflow_steps_node ON workflow_steps(workflow_run_id, node_id, attempt);
CREATE INDEX idx_workflow_steps_resume ON workflow_steps(resume_at)
  WHERE resume_at IS NOT NULL;                   -- the resume sweep's scan
CREATE INDEX idx_workflow_steps_wait_deadline ON workflow_steps(wait_deadline_at)
  WHERE wait_deadline_at IS NOT NULL;            -- re-arming the deadline timers at start
CREATE INDEX idx_workflow_steps_wait_account ON workflow_steps(wait_account_id)
  WHERE wait_account_id IS NOT NULL;             -- one attention entry per spent account

-- ========================================================================
-- 7. workflow_triggers — one row per armed trigger (MUTABLE TRUTH)
-- ========================================================================
-- Owner: Plan-014
-- Arming is durable and the in-process timer is only a cache over these rows: on daemon start, after
-- the projection rebuild, every enabled workflow re-arms from them. No event history can reconstruct
-- what this machine is armed to do next, which is why the row is the truth.
CREATE TABLE workflow_triggers (
  definition_id     TEXT NOT NULL REFERENCES workflow_definitions(id),
  node_id           TEXT NOT NULL,                 -- the trigger node in the definition
  kind              TEXT NOT NULL,                 -- the trigger node kind, in the node catalog's own vocabulary; no CHECK list, because the catalog owns it and a copy here would go stale behind it
  config_hash       TEXT NOT NULL,                 -- over the trigger's own params: a re-arm compares it, so an unchanged trigger is not disarmed and re-armed for a save that did not touch it
  next_fire_at      TEXT,                          -- NULL where the kind has no schedule (a webhook, a chat start) or while disarmed
  last_fire_at      TEXT,                          -- NULL until it has fired once
  enabled           INTEGER NOT NULL DEFAULT 0
                    CHECK(enabled IN (0, 1)),      -- a workflow is enabled or not as a whole: enabling arms every trigger it declares, disabling disarms all of them
  PRIMARY KEY (definition_id, node_id)
);

CREATE INDEX idx_workflow_triggers_due ON workflow_triggers(next_fire_at)
  WHERE enabled = 1 AND next_fire_at IS NOT NULL;  -- the arming sweep's only scan

-- ========================================================================
-- 8. workflow_webhook_tokens — one row per workflow with a webhook trigger
--     (MUTABLE TRUTH)
-- ========================================================================
-- Owner: Plan-014
-- The bearer token the loopback listener checks. Only its hash is stored: a stolen database must not
-- yield a working token, and the listener compares a hash to a hash.
CREATE TABLE workflow_webhook_tokens (
  definition_id     TEXT PRIMARY KEY REFERENCES workflow_definitions(id),
  token_hash        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  last_used_at      TEXT                           -- NULL until the address is first called
);

-- ========================================================================
-- 9. workflow_node_state — the per-(workflow, node) key-value store
--     (MUTABLE TRUTH)
-- ========================================================================
-- Owner: Plan-014
-- Trigger cursor state — the last session event read, the last file-watch stamp — lives here and NEVER
-- on the document, so the document stays hashable and safe to edit: a cursor written into the body
-- would change the content hash on every fire and mint a version for nothing. It also holds the values a
-- `Keep for later runs` step keeps: one entry per (workflow, name), with the value, the run that kept it and
-- when. A value over 64 KiB is kept as a file and read back the same way, by the rule a step's payload over
-- the inline bound follows. Kept values belong to the workflow, not to a version: saving, restoring or
-- duplicating a version leaves them, a duplicate starts with none, and `workflow.keptVarsClear` or deleting
-- the workflow removes them.
CREATE TABLE workflow_node_state (
  definition_id     TEXT NOT NULL REFERENCES workflow_definitions(id),
  node_id           TEXT NOT NULL,               -- '' for a kept value, which belongs to the workflow rather than to one node
  key               TEXT NOT NULL,               -- a cursor's key, or a kept value's name
  value_json        TEXT NOT NULL
                    CHECK(json_valid(value_json)),
  kept_by_run_id    TEXT,                        -- the run that kept the value; NULL for trigger cursor state
  updated_at        TEXT NOT NULL,               -- when the value was written or kept
  PRIMARY KEY (definition_id, node_id, key),
  CHECK(kept_by_run_id IS NULL OR node_id = '')
);

-- ========================================================================
-- 10. workflow_secrets — one row per workflow secret (MUTABLE TRUTH)
-- ========================================================================
-- Owner: Plan-014
-- A secret's record, never its value: the daemon keeps the value as its own item in the operating system's credential store
-- (ADR-036), and no read, reply, event, log or error carries it. A step parameter stores only
-- secret://<scope>/<name>, resolved when the step runs and only in a field its kind marks sensitive.
-- Managed through workflow.secretCreate, workflow.secretReplace, workflow.secretDelete and
-- workflow.secretList, from the step's Credential field; nothing on Settings holds them.
CREATE TABLE workflow_secrets (
  id                TEXT PRIMARY KEY,            -- the secretId
  scope             TEXT NOT NULL
                    CHECK(scope IN ('project', 'shared')),  -- never a session
  scope_ref         TEXT NOT NULL,               -- the project record's id at 'project'; '' at 'shared'
  name              TEXT NOT NULL                -- lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters
                    CHECK(length(name) BETWEEN 1 AND 64 AND name GLOB '[a-z0-9]*' AND name NOT GLOB '*[^a-z0-9-]*'),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,               -- the last `Replace value`
  CHECK((scope = 'shared') = (scope_ref = '')),
  UNIQUE(scope, scope_ref, name)                 -- a name taken in its scope is refused with workflow.secret_name_invalid (reason: taken)
);
```

**Index rationale + write-amplification estimate:** Per-index query justifications above are sized against SQLite's standard query-planner cost model — partial indexes with `WHERE` clauses are evaluated only over the matching subset, yielding the smallest workable index for the live-set queries ([SQLite — Partial Indexes](https://www.sqlite.org/partialindex.html)). The engine commits the step rows one turn of its loop started or settled in one transaction and hands that turn's events to the event log as one batch — Spec-013's 50 events or 10 ms to a transaction, flushed under one `db.transaction(fn)` call — `better-sqlite3` commits each batch atomically and rolls back on throw (_"Calling [.transaction()] returns a new function that, when called, runs the given function inside an SQLite transaction"_ — [better-sqlite3 API docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)). Measured, twenty steps starting and finishing together cost 1.3 to 2.3 ms of the daemon's time in one transaction against up to 12.3 ms one by one, and a sustained 10,000 step boundaries cost 17 to 19 µs each, so nothing the engine emits outruns the store under `synchronous = FULL` WAL and no write rate limit is needed ([SQLite — Write-Ahead Logging](https://www.sqlite.org/wal.html)).

---

## Orchestration Tables (Plan-013)

DDL per Plan-013 D-013-5. Posture per table: `run_links` and `agents` are events-canonical projections ([ADR-016](../../decisions/016-shared-event-sourcing-scope.md) Option B — rebuilt from `session_events`; never written except by the projector); `session_budgets` is row-canonical daemon configuration (the `queue_items` posture — mutated by wire method, not evented), and so are the session-messaging tables, the `agents.pending_switch` column (written before a switch is acknowledged, since no event records a switch being asked for) and `agent_tree_nodes` (written by the daemon alone when an agent starts and when it finishes), so none of them is rebuilt from the log.

```sql
-- Owner: Plan-013 (events-canonical projection of the run.queued orchestration-carrier fields — D-013-3)
CREATE TABLE run_links (
  parent_run_id     TEXT NOT NULL,
  child_run_id      TEXT NOT NULL,
  session_id        TEXT NOT NULL,                      -- session provenance (I-013-3): local and relay rebuild scope by session
  reached_by        TEXT NOT NULL
                    CHECK(reached_by IN ('provider_subagent', 'bridge_run', 'workflow_step')),   -- how the child was reached (D-013-12)
  created_at        TEXT NOT NULL,
  PRIMARY KEY (child_run_id),                       -- single-parent: a child run links to exactly one parent (one-shot run.queued linkage D-013-3)
  CHECK (parent_run_id <> child_run_id)             -- a run never parents itself
);

CREATE INDEX idx_run_links_parent ON run_links(parent_run_id); -- parent → children scans (orchestration.childRunLinkRead; the session's agent tree)
CREATE INDEX idx_run_links_session ON run_links(session_id);

-- Owner: Plan-013 (events-canonical projection of the agent events).
-- No wire verb brings an agent into a session or takes one out: a row appears where an agent
-- takes part -- the session's own lead, a delegation from it, or an agent the person named in the
-- composer -- and a row has no lifecycle state: an agent is in its session or it is not. The values
-- a row holds are carried on the events that create and move it, so the projection is deterministic
-- from the log alone.)
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  driver_name     TEXT NOT NULL,                        -- provider driver key (Plan-003 capability surface)
  model_id        TEXT NOT NULL,
  provider_account_id TEXT,                             -- D-013-17: the binding's own account, the Plan-023 `provider_accounts.account_id`
                                                        -- this agent spawns under; NULL = follow the provider's current account, whichever it
                                                        -- is when a run starts, so this agent follows the mark when it moves. Set only when
                                                        -- the binding itself names an account. The account a run landed on is carried on the
                                                        -- settling agent.provider_binding_changed event, beside the binding, and is never
                                                        -- written here, so a following agent is never silently pinned. The Spec-025 spawn gate reads it
  effort          TEXT,                                 -- D-013-17: reasoning effort, validated against the target
                                                        -- model's driver-reported `effortLevels` rather than a schema CHECK --
                                                        -- the valid set is per-model and provider-owned, so a CHECK here would
                                                        -- go stale against the provider rather than protect anything
  output_speed    TEXT,                                 -- D-013-17, the output-speed axis: the EFFECTIVE speed mode this
                                                        -- agent spawns under. NULL = never set, so the provider's own default stands --
                                                        -- an agent is not born with a speed mode and no surface sets one at birth.
                                                        -- Uncheckable here for the same reason as `effort`: the valid set is the
                                                        -- driver-published `outputSpeedLevels`, so a CHECK would go stale behind a vendor.
                                                        -- A durable column because the applying coordinator commits
                                                        -- the effective binding into these columns inside the transaction that clears
                                                        -- `pending_switch` below: a spawn-bound axis with a durable pending column and no
                                                        -- durable effective column would apply once and silently revert at the next
                                                        -- restart
  tool_allowlist  TEXT,                                 -- CP-024-3: JSON array, THREE-state like its wire axis —
                                                        -- SQL NULL = driver defaults, '[]' = no tools, populated = exactly these.
                                                        -- The daemon composes the callback registry from it (I-024-10)
  instructions    TEXT,                                 -- CP-024-3: the system-prompt content AS APPLIED when the run started
                                                        -- Read by prompt construction: after the source definition is
                                                        -- deleted the row itself must still answer what the agent was given
                                                        -- (I-024-12)
  resolved_from_definition_id TEXT,                     -- the saved agent definition this agent was resolved from, written from
                                                        -- the resolved configuration's resolvedFromDefinitionId; NULL for an agent no definition produced.
                                                        -- No foreign key: the row keeps naming its source after that definition is deleted,
                                                        -- as `instructions` keeps what it was given
  pending_switch  TEXT,                                 -- D-013-17: the JSON AgentBindingSwitchPending shape, status literal
                                                        -- included so the stored blob is self-identifying rather than a wire artifact
                                                        -- reproduced in a column: a row read in isolation names what it is -- {status:
                                                        -- 'pending', switchId, appliesAt: 'turn_boundary'|'run_boundary',
                                                        -- interruptRequested, pendingAxes: {driverName?, modelId?, providerAccountId?,
                                                        -- effort?, outputSpeed?}, replacedSwitchId?} -- shared with the mutation reply and
                                                        -- the `pendingSwitch` member agent.list returns, so what a client was told and what
                                                        -- a restart re-arms from are the same record. What is stored here is a SUPERSET of
                                                        -- that shared shape: on the immediate arm it additionally carries
                                                        -- interruptDispatch ('requested' | 'dispatched'), which is never returned to a
                                                        -- caller or appended to a payload; it is a member of THIS JSON blob, not a column
                                                        -- of its own. interruptDispatch is 'requested' | 'dispatched' rather than boolean because recovery must
                                                        -- separate 'crashed before the interrupt went out, so dispatch it' from 'crashed
                                                        -- after it landed, so reconcile' -- redispatching in the second case would fire a
                                                        -- second interrupt at a run that already took one -- and it advances by its own
                                                        -- durable write, so a crash between the two costs one idempotent redispatch and
                                                        -- never the switch. interruptRequested is stored rather than derived because
                                                        -- appliesAt does not imply it: a deferred switch and an interrupted one can both
                                                        -- read 'turn_boundary'. pendingAxes carries TARGET VALUES and not axis names: at
                                                        -- the boundary the caller's request is gone, so the row must be sufficient to
                                                        -- apply the switch by itself. Two writers admit a switch: agent.configUpdate, for
                                                        -- the provider, model, effort and speed axes, and providerAccount.setCurrent, which
                                                        -- records a pending account switch on an agent following the moved mark whose
                                                        -- session cannot move in place at its next request. This is the ONE switch
                                                        -- acknowledged to a caller but not yet applied at its boundary; NULL = none.
                                                        -- Durable because the acknowledgment is a promise a restart must keep: startup
                                                        -- re-arms from this column instead of dropping the intent. A single nullable
                                                        -- column is what makes one-pending-per-agent structural -- a later switch from either
                                                        -- writer overwrites it (supersession, last writer wins) under the same row lock,
                                                        -- so a queue of half-wanted switches is unrepresentable. Holds the PENDING
                                                        -- binding only; the effective binding stays in the columns above and moves
                                                        -- there at application. Cleared by whichever terminal event settles the switch
                                                        -- (agent.provider_binding_changed / agent.provider_binding_change_failed, which leaves the
                                                        -- columns above untouched, so a switch that fails after it was accepted keeps the
                                                        -- agent on its previous binding) and by supersession
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_agents_session ON agents(session_id);

-- Owner: Plan-013 (row-canonical daemon configuration — queue_items posture, NOT evented; one row per session, written when the session is created from the Runtime settings' Spend limit and Tokens per run; mutated only via session.spendLimitUpdate and session.tokensPerRunUpdate — D-013-5)
CREATE TABLE session_budgets (
  session_id                    TEXT PRIMARY KEY,
  spend_limit_usd_micros        INTEGER,                        -- integer micro-dollars; NULL = `Unlimited`, the default; the session's `Spend limit` across every provider and account it uses (Spec-014 §Budget Policies)
  tokens_per_run                INTEGER,                        -- input and output tokens together for one run; NULL = `Unlimited`, the default; the session's `Tokens per run`
  updated_at                    TEXT NOT NULL,
  -- Each limit is NULL (no limit) or an integer the wire's limit verbs also check (D-013-5)
  CHECK (spend_limit_usd_micros IS NULL OR spend_limit_usd_micros >= 0),
  CHECK (tokens_per_run IS NULL OR tokens_per_run >= 1)
);

-- The daemon's own agent tree: one row per agent a provider starts inside a run (a Claude Code task,
-- a Codex child thread), written by the daemon alone when the agent starts and when it finishes and
-- never evented. After a daemon restart every child still running is re-attached by its id, and every
-- fan-out count is read from here.
CREATE TABLE agent_tree_nodes (
  run_id            TEXT NOT NULL,                  -- the run the agent was started in
  driver_name       TEXT NOT NULL,                  -- provider driver key, as on `agents`
  subagent_id       TEXT NOT NULL,                  -- the provider's own id for the agent, verbatim: the Claude Code task id or the
                                                    -- Codex thread id, which is also what a restart resumes it by
  parent_reference  TEXT,                           -- the provider's own parent link, verbatim: the Claude Code parent tool-call id or
                                                    -- the Codex parent thread id; NULL where the provider named none
  state             TEXT NOT NULL
                    CHECK(state IN ('running', 'completed', 'failed', 'interrupted', 'stopped')),
                    -- read from the agent's own update (the Claude Code task update, the Codex
                    -- child turn's frame), never from the lead's result
  started_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (run_id, driver_name, subagent_id)   -- one row per agent: a second start for the same agent is refused
);

-- Two sessions trading messages. [Spec-014 §State And Data Implications](../../specs/014-multi-agent-orchestration.md#state-and-data-implications)
-- declares both of the tables below durable, session-scoped daemon state, because a daemon restart
-- mid-exchange must deliver what it was holding and must not forget which two sessions were talking.
-- The session directory those tables are read against is the daemon's `sessions` table (§Session Directory),
-- and an address that moved with a restarted provider process is looked up again rather than remembered.
--
-- Neither table holds a message. The send and the arrival are the ordinary tool events of the two
-- sessions' own logs ([Spec-014 §Sessions Talking To Each Other](../../specs/014-multi-agent-orchestration.md#sessions-talking-to-each-other)),
-- which is where the words live; a queue row names the send it is holding and nothing else.
CREATE TABLE session_exchanges (
  session_id        TEXT NOT NULL,   -- the pair, held as ONE row with the two ids in ascending order
  peer_session_id   TEXT NOT NULL,   -- so the count below is one count for one exchange. Two rows for one pair would be two answers to "how many since the person last wrote", and each session's own row in the sessions list reads the peer it is not
  messages_since_user_wrote INTEGER NOT NULL DEFAULT 0
                    CHECK (messages_since_user_wrote >= 0),  -- what the exchange line on each session's row states, `talking to builder · 14`. Reset to zero when the person writes in either session; it is a fact on the row and never a limit, nothing of this runtime bounding how many messages two sessions trade
  started_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (session_id, peer_session_id),
  CHECK (session_id < peer_session_id)  -- the canonical ordering that makes the pair one row. An interrupt taken on either session reads this row to reach the other, so the pair is what is stored and the direction of the last message is not
);

-- Every message addressed to a PAUSED session, in arrival order. The daemon holds them while the
-- session is paused and delivers them one at a time in this order when it continues; a row is deleted
-- when its message is delivered, so the table is empty whenever nothing is being held.
CREATE TABLE session_paused_message_queue (
  target_session_id  TEXT NOT NULL,   -- the paused session the message is addressed to
  arrival_sequence   INTEGER NOT NULL,  -- arrival order at the daemon, per target session. Delivery follows it exactly: a queue that delivered out of order would rewrite the conversation the sending session believes it had
  source_session_id  TEXT NOT NULL,   -- the sending session
  source_event_id    TEXT NOT NULL,   -- the send's own tool event on the SENDING session's log, which is where the message text already lives (session_events.content_payload holds tool-call arguments). No foreign key, for the reason the event log's own session_id carries none, and no body column: a second copy of the words would be a second record of them
  arrived_at         TEXT NOT NULL,
  PRIMARY KEY (target_session_id, arrival_sequence),
  UNIQUE (target_session_id, source_event_id)  -- one hold per send, so a re-delivery attempt after a restart queues nothing twice
);
```

A run's token limit (`tokenLimit`, input and output together for one run) is `Unlimited` by default; the session's `Tokens per run` value is resolved onto each run at admission as a per-run `OrchestrationRunConfig` value and persisted durably as the `run.queued` payload's `effectiveRunConfig` (Plan-013 D-013-5; api-payload `RunStateChangeEvent`), and enforcement rebuilds from that event field, never by re-merging session values that may have changed mid-run. The service stops a run at the first usage report past its limit, so one request can overshoot slightly. Budget _accounting_ (tokens/cost consumed) has no **accumulator** table: the daemon's `BudgetAccountant` is an in-memory projection rebuilt from `usage_telemetry` + `run.*` events (D-013-5). `provider_account_usage_turns` below is not a second accountant: it projects the same `usage_telemetry` events into one row per turn so the figures can be sliced by account, by day and by model, which a running total cannot be (Spec-025 §State And Data Implications).

---

## Recovery Tables (Plan-012)

```sql
-- Owner: Plan-012
CREATE TABLE projection_cursors (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL UNIQUE,
  last_sequence   INTEGER NOT NULL,           -- last applied event sequence
  state           TEXT NOT NULL DEFAULT 'current'
                  CHECK(state IN ('current', 'rebuilding', 'stale')),
  updated_at      TEXT NOT NULL
);

-- Owner: Plan-012
CREATE TABLE recovery_checkpoints (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  checkpoint_type TEXT NOT NULL,              -- e.g. 'full', 'incremental'
  as_of_sequence  INTEGER NOT NULL,
  state_blob      BLOB NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_recovery_checkpoints_session ON recovery_checkpoints(session_id);
```

---

## MCP Governance Tables (Plan-022)

Node-scoped governance state for [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) (V1 feature #15): the binding store (each binding's enabled overlay and native-tool baseline), the per-tool override store, the governance-mutation idempotency receipt store, and the record of which OAuth client each server admitted. Provider config files remain the config source of truth — the daemon persists only governance state and derives the unified inventory on read, so no table here mirrors provider config ([Spec-024 § State And Data Implications](../../specs/024-mcp-server-configuration-and-governance.md#state-and-data-implications)). All the tables here are daemon-local with no session FK; settled sign-ins are the `mcp.*` event type in the `mcp_governance` category, appended through the Plan-004 `EventLogService` path, and a status change is a live notice on `mcp.subscribe` written to no log (receipts are retry-window dedup evidence, deliberately not audit rows).

```sql
-- Owner: Plan-022
CREATE TABLE mcp_server_bindings (
  provider           TEXT NOT NULL
                     CHECK(provider IN ('claude', 'codex')),  -- the McpProvider contract union (driver id namespace); an unchecked value would hand inventory code an impossible row its exhaustive McpProvider handling cannot represent
  scope              TEXT NOT NULL
                     CHECK(scope IN ('user', 'project', 'local', 'plugin')),  -- scope axis of the binding identity (Spec-024 §Unified Inventory): writable at user, project and local on both providers; a Codex 'local' binding is the daemon's emulation and has a row like any other; a 'plugin' binding is a server an installed plugin declares, whose row holds the person's switch and tool overrides while its declaration changes only with the plugin
  scope_ref          TEXT NOT NULL DEFAULT '',  -- canonical project root (project) / keying directory (local) / the plugin's name (plugin); '' for user scope
  server_name        TEXT NOT NULL,
  enabled_override   INTEGER
                     CHECK(enabled_override IS NULL OR enabled_override IN (0, 1)),  -- the daemon's per-server enabled overlay (Claude bindings and every plugin binding — Claude user scope has no enabled field, and a plugin's declaration is the plugin's; Codex's own bindings use its native `enabled` config field); NULL = no overlay
  native_tool_baseline_json TEXT,        -- pre-governance snapshot of the binding's native override-projection fields (enabled_tools / disabled_tools / tools.<t>.approval_mode), captured at the first facet materialization, held while any facet is materialized, dropped once facet-free; Codex-materialized bindings only (Claude facets are daemon-enforced — no native writes, no baseline). mcp.clearToolOverride restores from it (Spec-024 §Tool-Level Overrides) — without it, restore-on-clear would invent values
  first_observed_at  TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (provider, scope, scope_ref, server_name),
  -- binding-ref structural validity, mirroring the schema-level discriminated union (defense in depth):
  -- user scope has no scope_ref ('' sentinel); project/local/plugin REQUIRE one, on both providers
  CHECK((scope = 'user') = (scope_ref = ''))
);
```

```sql
-- Owner: Plan-022
CREATE TABLE mcp_tool_overrides (
  provider          TEXT NOT NULL
                    CHECK(provider IN ('claude', 'codex')),  -- the closed McpProvider union, mirroring mcp_server_bindings
  scope             TEXT NOT NULL
                    CHECK(scope IN ('user', 'project', 'local', 'plugin')),  -- binding identity axes mirror mcp_server_bindings
  scope_ref         TEXT NOT NULL DEFAULT '',
  server_name       TEXT NOT NULL,
  tool_name         TEXT NOT NULL,
  enabled           INTEGER
                    CHECK(enabled IS NULL OR enabled IN (0, 1)),  -- allow/deny facet; NULL = provider default
  approval_mode     TEXT                   -- Codex-native vocabulary adopted as the normalized set (Spec-024 §Tool-Level Overrides)
                    CHECK(approval_mode IS NULL OR approval_mode IN ('auto', 'prompt', 'writes', 'approve')),
  idempotency_class TEXT                   -- NULL = the Spec-004 manual_reconcile_only floor (Spec-024 §Tool-Level Overrides)
                    CHECK(idempotency_class IS NULL OR idempotency_class IN ('idempotent', 'compensable')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (provider, scope, scope_ref, server_name, tool_name),
  -- an all-NULL facet row is meaningless: mcp.clearToolOverride nulls the one facet it names, and
  -- clearing the row's last set facet deletes the row instead of blanking it — and the
  -- mcp.setToolOverride schema mirrors this as a Zod refinement (>= 1 facet required), so a
  -- facet-less override dies as a typed validation error before it can reach this constraint
  CHECK(enabled IS NOT NULL OR approval_mode IS NOT NULL OR idempotency_class IS NOT NULL),
  -- binding-ref structural validity, mirroring mcp_server_bindings (defense in depth)
  CHECK((scope = 'user') = (scope_ref = '')),
  FOREIGN KEY (provider, scope, scope_ref, server_name)
    REFERENCES mcp_server_bindings(provider, scope, scope_ref, server_name)
    ON DELETE CASCADE  -- overrides never outlive their binding row
);
```

The FK targets the binding table because first observation of any binding upserts its row ([Spec-024 § Unified Inventory](../../specs/024-mcp-server-configuration-and-governance.md#unified-inventory)) — that row is each binding's durable governance anchor, so overrides cascade to it rather than to any provider-config mirror (there is none). Identity is the scope-qualified binding `(provider, scope, scope_ref, server_name)`: same-named servers in two scopes are distinct configurations with independent overrides, so collapsing them would bleed one scope's overrides into the other. Lookups ride the composite primary keys: the inventory merge and the Spec-004 tool-metadata resolution both read by binding prefix, so no secondary indexes are warranted.

```sql
-- Owner: Plan-022
CREATE TABLE mcp_mutation_receipts (
  client_idempotency_key  TEXT NOT NULL PRIMARY KEY,  -- requester-generated UUID (Spec-004's mandatory clientIdempotencyKey; the interventions UNIQUE(target_run_id, client_idempotency_key) precedent, adapted to node-scoped operations with no run axis)
  operation               TEXT NOT NULL,              -- the receipted mcp.* operation the key was spent on (the governance mutations, mcp.oauthLogin and mcp.oauthLogout; mcp.reconnect is unreceipted)
  status                  TEXT NOT NULL
                          CHECK(status IN ('pending', 'committed')),  -- two-phase (the Plan-012 command_receipts discipline, Spec-024 §Authorization): the row INSERTs as a 'pending' intent in its own transaction BEFORE any provider leg runs, and flips to 'committed' in the same transaction as the mutation's store writes — closing both crash windows around the external provider side effect (a durable provider write can never be left unfinalized: startup reconciliation completes any pending intent — verifying provider state, finishing store writes exactly once — or expires an intent whose provider leg never ran)
  response_json           TEXT,                       -- the acknowledged response, returned verbatim as the saved result on any retry with the same key, whatever the second request carries — no provider call or store write (Spec-024 §Authorization); NULL while 'pending' (recorded at finalization). One representation exception: the mcp.oauthLogin row stores the acknowledgment with authorizationUrl STRUCTURALLY OMITTED — launch URLs embed single-use PKCE state and are never durable (Plan-022 I-022-1) — so its saved result is an acknowledgment with no URL (the flow already launched; a caller that never received the URL starts a new login under a fresh key)
  created_at              TEXT NOT NULL,              -- RFC 3339 UTC; 'committed' rows older than 24 h are pruned opportunistically on later mutation writes ('pending' intents resolve at startup reconciliation, never silently pruned)
  CHECK((status = 'committed') = (response_json IS NOT NULL))
);
```

Receipts are **two-phase** because the provider config write is an external side effect no SQLite transaction can span. The `'pending'` intent row (key and operation) commits in its **own transaction before** the provider leg runs; finalization — `status = 'committed'` plus the recorded response — commits in the **same transaction** as the mutation's governance-store writes, making the acknowledgment and the saved result atomic. That closes both crash windows: crash before the provider leg leaves a pending intent with no provider effect (startup reconciliation expires it — the caller retries fresh); crash after a durable provider write but before finalization leaves a pending intent whose provider state startup reconciliation verifies, completing the store writes **exactly once, late**, then finalizing. An identical-key retry that meets a pending row first drives that reconciliation, then returns the finalized response; a lost IPC response after commit can re-drive only the provider leg (safe by construction — sanctioned provider writes are upserts, full-set replacements, or version-guarded), never a second acknowledgment. Receipts carry no config values.

```sql
-- Owner: Plan-022
-- Which OAuth client each server admitted at its last sign-in, one row per server: the daemon's own, or
-- Claude Code's or Codex's where the server admits only that provider's client. A fact about the server,
-- so it is kept once here rather than on each binding that names the server. A sign-out forgets only the
-- sign-in and keeps this row, so every later sign-in is one press. Not a credential.
CREATE TABLE mcp_server_admitted_clients (
  provider              TEXT NOT NULL CHECK(provider IN ('claude', 'codex')),
  server_name           TEXT NOT NULL,
  admitted_oauth_client TEXT NOT NULL CHECK(admitted_oauth_client IN ('daemon', 'claude', 'codex')),
  PRIMARY KEY (provider, server_name)
);
```

---

## Provider Account Tables (Plan-023)

Node-local registry of the provider accounts this runtime node may execute against, for [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md). One row per registered account. The table stores **no credential material of any kind** — no token, no refresh token, no cookie, no keychain payload. Credentials live inside the per-account credential home, owned and written by the provider's own tooling; the daemon brokers refresh without ever holding the values, so there is no credential column here to leak, log, or delete. What is stored is the identity of an account, where its home lives, and how it bills.

`account_id` is daemon-minted, opaque, and immutable. It is deliberately **not** derived from credential material, an email address, or any provider-side subject identifier: those rotate, and an identity that rotates cannot key historical spend. `credential_generation` is a monotonic integer bumped at every credential-home lifecycle transition (initial authentication, re-authentication, revocation, home rebuild). The pair `(account_id, credential_generation)` is the account-scoped reading key — a quota reading or usage-limit signal taken under one generation must not be read as current after a re-authentication, which is exactly what the generation makes detectable.

```sql
-- Owner: Plan-023
CREATE TABLE provider_accounts (
  account_id            TEXT NOT NULL PRIMARY KEY,  -- daemon-minted opaque immutable identity; never derived from credential material (Spec-025 §Account identity and credential generation). A NULL identity would key nothing — `(account_id, credential_generation)` would be unmatchable, the child table's `ON DELETE CASCADE` would never fire for it, and the credential home derived from it could not be attributed back — and a `STRICT` table's PRIMARY KEY column cannot hold NULL, which the explicit `NOT NULL` states.
  provider              TEXT NOT NULL
                        CHECK(provider IN ('claude', 'codex')),  -- the same closed driver-id union the MCP governance tables use
  display_label         TEXT,  -- the name the person typed, present only on an account added from a pasted token or API key, where it is required; NULL on every other account, which its provider-reported identity names (Spec-025 §The account registry). Treated as personal data. Unique per provider ignoring case and surrounding spaces, by the index below
  credential_home_path  TEXT NOT NULL,  -- absolute path to this account's isolated credential home; the daemon constructs the spawn environment from it and never inherits ambient provider credentials (I-023-4)
  credential_generation INTEGER NOT NULL DEFAULT 1
                        CHECK(credential_generation >= 1),  -- monotonic, starts at 1; bumped at every credential-home lifecycle transition (I-023-2). The CHECK makes the floor enforced rather than asserted: a zero or negative generation sorts BEFORE a freshly registered account, so a reading stamped with one would read as newer than the account it describes and invert the staleness comparison the stamp exists for. A fractional generation never reaches the column: a `STRICT` INTEGER column stores `2.0` and `'3'` as integers and refuses `1.5`, so a monotonic counter cannot become divisible.
  billing_mode          TEXT NOT NULL
                        CHECK(billing_mode IN ('subscription', 'metered', 'unknown')),  -- how this account is charged; `unknown` is the honest-absence arm, never a synonym for metered; drives cost labeling, never cost derivation (Spec-025 §Billing mode)
  is_default            INTEGER NOT NULL DEFAULT 0
                        CHECK(is_default IN (0, 1)),  -- the provider's CURRENT account: the one a new run starts on, and the one a press on the Providers page moves, which carries every running session on that provider that is not pinned to an account with it (Spec-025 §Moving a session to another account). Exactly one per provider, enforced by the partial unique index below. The column keeps the `default` spelling the wire keeps in `isDefault` and in the `no_default` readiness arm, so the flag has one name across the schema and the payloads
  health_state          TEXT
                        CHECK(health_state IS NULL OR health_state IN ('authenticated', 'reauth_required', 'home_missing', 'indeterminate')),  -- the STORED outcome of the last validation of this account: the driver's authentication probe reading together with the credential-home observation taken at that same moment. NULL until a probe has ever been taken, which the wire renders as `indeterminate` — NOT as a failure and never as authenticated (I-023-8, I-023-9). This is the column the readiness projection reads; a registry read never re-derives it, so a read spawns no provider process and opens no credential file (Spec-025 §Node provider readiness and the sign-in handoff).
  health_observed_at    TEXT,  -- RFC 3339 UTC of the observation `health_state` records, written by the same act. NULL exactly when `health_state` is NULL, so the pair is set and cleared together; surfaced as `ProviderReadiness.observedAt` so a caller can apply its own age test. Deliberately NOT `updated_at`, which is NOT NULL and moves on any row mutation — a relabel would report the person's display-label edit as a fresh authentication observation.
  observed_auth_mode    TEXT
                        CHECK(observed_auth_mode IS NULL OR observed_auth_mode IN ('oauth_subscription', 'oauth_token', 'api_key', 'external', 'none', 'unknown')),  -- the authentication mode the provider's OWN status surface reports for this home, OBSERVED and never assumed (Spec-025 §Non-interactive token registration). NULL until observed; `unknown` is the distinct arm for "observed, but the provider named a mode this daemon does not recognize" — a tolerant arm so a vendor adding a mode does not fail an observation closed. `oauth_token` is the ADR-026 D2 class and is what admits a token-mode account; the token VALUE is not here and is in no column of any table (Spec-025 §State And Data Implications).
  last_refresh_observed_at TEXT,  -- RFC 3339 UTC of the most recent credential refresh the daemon has OBSERVED to have completed for this home, read from the provider's own durable marker where it publishes one. NULL = not observed, never "fine". Drives the freshness reading. The daemon never touches the credential itself: what renews a login is the provider's own code running inside its own home, which the limits read on one leg causes as that provider's own side effect, and a renewal there is no lifecycle transition — it moves this column and never `credential_generation` (Spec-025 §Credential-home health observation).
  logged_in_at          TEXT,  -- RFC 3339 UTC of the moment this home's credential was ISSUED. On a brokered sign-in that is the observed completion, which the daemon witnessed. On a token-mode registration it is the token's ISSUANCE time — read from the provider's own status surface where it publishes one, else supplied explicitly by the person — and is NOT the registration time: a token is minted out of band and may be registered months later, so anchoring here to registration would shift the horizon forward by the token's pre-registration age and could report a credential as good after it had expired. Where no issuance anchor exists the column stays NULL and the estimate renders as unknown; it is never defaulted to `created_at`. NULL also for a home imported by a registration that neither signed in nor supplied a token. The re-login horizon derived from it is MODE-DISPATCHED and is an ESTIMATE, never a fact: the interval belongs to the provider's issuance policy, which the daemon does not control and cannot verify.
  -- Provider-REPORTED account identity, surfaced by a health observation. This IS an account's
  -- identity on every surface that names one — the address, the plan as the provider itself names it,
  -- and the organization where the plan has one — and only an account added from a pasted token or
  -- API key carries a typed `display_label` beside it: one address can hold two accounts on
  -- different plans, so the plan and the organization are part of telling them apart rather than
  -- decoration around an invented name. Nullable and independently so: a provider may report any
  -- subset, and an absent value stays absent rather than defaulting. A later
  -- observation REPLACES these values (Spec-020 §PII Data Map, `provider_accounts` row); they are
  -- never logged, never evented, and never carried on an error.
  observed_account_email     TEXT,
  observed_account_plan      TEXT,  -- the provider's own word for the plan, verbatim; distinct from billing_mode, which says how the account is paid for rather than which plan it is on
  observed_account_org_id    TEXT,
  observed_account_org_name  TEXT,
  removal_intent        INTEGER NOT NULL DEFAULT 0
                        CHECK(removal_intent IN (0, 1)),  -- the durable half of the cross-store removal protocol (Spec-025 §Non-interactive token registration). The registry row and the token's credential-store item are SEPARATE DURABILITY DOMAINS — SQLite and the operating system's credential store commit independently — so removal marks intent here FIRST, then destroys the secret, then deletes the row. A crash mid-sequence therefore strands a row already marked unusable rather than a live credential nobody can see. Admission REFUSES any account whose row is intent-marked, and daemon-start reconciliation completes every marked row and destroys every token item matching no row. Not a status enum: the row's other states are already carried by `health_state`, and folding removal into that column would let an observation overwrite an in-flight removal.
  probe_enabled         INTEGER NOT NULL DEFAULT 1
                        CHECK(probe_enabled IN (0, 1)),  -- per-account opt-out for the background health observer (Spec-025 §Credential-home health observation). Default-on, because an account nobody observes is an account whose stored reading silently ages; durable rather than in-memory, so a restart does not resume observing an account the person silenced. Opting out suppresses the OBSERVER only: the deliberate probe verb and spawn validation still write the pair, because both are acts the person or a run explicitly asked for.
  window_start_enabled  INTEGER NOT NULL DEFAULT 1
                        CHECK(window_start_enabled IN (0, 1)),  -- per-account switch for the one smallest turn the daemon spends at each window reset so the new window's clock starts then (Spec-025 §Credential-home health observation; `windowStartEnabled` on the wire). Default-on, and it sits UNDER `probe_enabled` rather than beside it: switching this off leaves the limits read running on its cadence, and switching `probe_enabled` off leaves this inert, so an account silenced for the observer spends nothing at a reset.
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  -- The stored observation is a PAIR, and the pair is enforced rather than asserted: a reading with
  -- no observation time cannot answer `observedAt`, and an observation time with no reading is a
  -- timestamp for nothing. Either half-populated row would make the readiness projection serve an
  -- incoherent observation, so the database refuses both instead of leaving it to every writer.
  CHECK ((health_state IS NULL) = (health_observed_at IS NULL))
);

-- Exactly one current account per provider (I-023-5) — the flag this schema calls `is_default` and
-- every surface calls the current account, one fact under two words. A partial unique index rather
-- than application-level enforcement: two concurrent `providerAccount.setCurrent` calls racing on
-- the same provider would both read "no other one" and both write one, and the resulting ambiguity
-- would be resolved silently at the next spawn by whichever row sorted first — binding a run, and
-- its spend, to an account the person did not choose, and leaving a press that moves live sessions
-- with two destinations. The database refuses the second writer instead.
CREATE UNIQUE INDEX provider_accounts_one_default_per_provider
  ON provider_accounts(provider)
  WHERE is_default = 1;

-- Exactly one account per credential home, across every provider (I-023-7). Two rows sharing a
-- home share its credentials: the daemon builds each spawn environment from this path, so a
-- duplicate reduces per-account isolation to a naming convention — one account's re-authentication
-- rewrites the other's credentials in place, and spend keyed to two identities is drawn from one.
-- Deliberately NOT scoped per provider: two providers pointed at one home is the same collision,
-- and the path is what the spawn environment carries either way. The database refuses the second
-- writer instead.
CREATE UNIQUE INDEX provider_accounts_unique_credential_home
  ON provider_accounts(credential_home_path);

-- One typed name per provider, compared ignoring case and surrounding spaces, where a name is
-- present: a second account of one provider with the same name is unrepresentable, and a register
-- or rename that would make one is refused `provideraccount.display_label_taken`.
CREATE UNIQUE INDEX provider_accounts_unique_display_label
  ON provider_accounts(provider, lower(trim(display_label)))
  WHERE display_label IS NOT NULL;
```

The newest quota reading per account and limit. A provider's quota standing is **not one window**: one pinned provider publishes **several distinct limits at a time, more than one of them over the same window length**, so a key of `(account, window length)` cannot hold them — the ones sharing a length would overwrite each other and the survivor would depend on arrival order. The limit identifier is therefore the key and the window length is an attribute of the reading, not part of its identity. Holding the newest reading durably is what lets a client that connects after a reading was taken render quota standing without waiting for the next one.

```sql
-- Owner: Plan-023
CREATE TABLE provider_account_usage_windows (
  account_id    TEXT NOT NULL
                REFERENCES provider_accounts(account_id) ON DELETE CASCADE,  -- a window reading has no meaning without its account; deregistering an account takes its readings with it
  limit_id      TEXT NOT NULL,  -- the provider's own limit identifier, carried verbatim as an untrusted provider-adjacent string. A reading that names no limit takes the reserved value 'default', so a provider publishing a single window needs no special case and the pre-Spec-025 single-window shape stays valid as the degenerate case (Spec-025 §Per-limit provider quota). NOT enumerated by a CHECK: the provider's limit set is an open, versioned vocabulary and a closed CHECK would fail a reading closed the moment a vendor adds a window.
  window_mins   INTEGER NOT NULL,  -- the reading's window length in minutes. An ATTRIBUTE, not part of the key: within one provider the limit identifier determines the length, so keying on both would admit two rows for one limit with different lengths — the same incoherence the health-pair CHECK above exists to refuse.
  label         TEXT,  -- the provider's own display label for this window where it publishes one; NULL where it does not. Display-only, never parsed, never a key.
  used_percent  REAL NOT NULL
                CHECK(used_percent >= 0),  -- utilization at `observed_at`. NOT capped at 100: a provider may report over-consumption against a soft limit, and clamping would silently misreport it. The renderer clamps for display; the store records what was observed.
  resets_at     TEXT,  -- RFC 3339 UTC when this window resets, where the provider supplies it; NULL where it does not. NULL means unknown, never "now" and never "never".
  observed_at   TEXT NOT NULL,  -- RFC 3339 UTC of the reading. This is the ordering key: where two readings key alike the later `observed_at` is current, and `source` breaks only exact ties. Ordering by arrival or by a source preference would let a stale reading mask real consumption.
  observed_credential_generation INTEGER NOT NULL
                CHECK(observed_credential_generation >= 1),  -- the account's `credential_generation` when this reading was taken, mirroring the member the account-scoped quota event already carries. A credential-home rebuild does NOT delete these rows — a quota window describes the provider-side allowance, which keeps running while a home sits empty — so this stamp is what lets a consumer render a pre-rebuild reading as stale rather than as current (Spec-025 §Per-limit provider quota). Contrast the health pair on the parent row, which a generation bump invalidates outright, because that pair describes the home itself. The CHECK carries the same floor the parent row's `credential_generation` and the wire's `CredentialGenerationSchema` both enforce, so the stamp cannot be written outside the range of the values it claims to compare against: a stamp below 1 names a generation that never existed, matches no account state, and would render its reading permanently stale rather than legibly refusing at write time. Like the parent's column it is a `STRICT` INTEGER, so a fractional stamp, which would place the reading between two generations, is refused at write.
  source        TEXT NOT NULL
                CHECK(source IN ('probe', 'run')),  -- which sanctioned source produced the reading: a deliberate read of the provider's own limits surface, or the account-scoped quota event emitted from real traffic. The background health observation is not a third value because it is not a third provenance: it performs the same deliberate read on its cadence, as another caller of it, and its readings record as 'probe' (Spec-025 §Credential-home health observation). The two values differ in COMPLETENESS, which is what consumers key on: a 'probe' reading is a whole-account read and replaces that account's stored set, while a 'run' reading is sparse and merges into it, pruning nothing it does not name.
  PRIMARY KEY (account_id, limit_id)
);
```

Spend joins to an account through the run wherever a run exists: a provider run carries the server-stamped `admittedProviderAccountId` on its `run.queued` admission record. **Two** usage kinds carry account identity directly, and both for the same reason — a figure that belongs to an account rather than to a run. `usage.rate_limit_update` does because provider quota is account-scoped and has no run to join through, and `usage.token_count` does because a turn can be spent on an account with no session at all (the window start, Spec-025 §Credential-home health observation) and because the per-turn projection below is keyed on the account rather than on the run. User identity stays off every usage row either way.

One row per turn, so the figures the person reads per account can be sliced by a day and by a model. It is a **projection** of the per-turn usage event ([Spec-005 §Usage Telemetry](../../specs/005-session-event-taxonomy-and-audit-log.md#usage-telemetry-usage_telemetry)) and not a second accountant: the same events feed it and feed the in-memory committed-spend fold, it is rebuilt like every other projection, and every figure it answers is served through the one committed-spend accessor. What it adds over the fold is an **axis**, not a second arithmetic — a running total cannot be cut by a day or a model it never kept ([Spec-025 §State And Data Implications](../../specs/025-provider-accounts-and-credential-homes.md#state-and-data-implications)).

```sql
-- Owner: Plan-023
CREATE TABLE provider_account_usage_turns (
  source_event_id TEXT NOT NULL PRIMARY KEY,  -- the id of the `usage.token_count` event this row projects. It is the key because a turn IS that event: keying on it makes the projector idempotent, so a rebuild from the log writes each turn exactly once and a rebuild is byte-equal to the original. Deliberately NO foreign key to `session_events`: a session purge deletes that log's rows, and tying the figures to those rows would let the purge reach an account's spend history — the figures outlive the rows they were derived from, and what a rebuild can no longer see it does not invent.
  account_id      TEXT NOT NULL
                  REFERENCES provider_accounts(account_id) ON DELETE CASCADE,  -- a turn's figures have no meaning without the account that paid for them; deregistering an account takes its usage rows with it, exactly as it takes its window readings
  provider        TEXT NOT NULL
                  CHECK(provider IN ('claude', 'codex')),  -- the same closed driver-id union the registry and the MCP governance tables use. Held on the row rather than joined from the account so a provider-wide slice reads one table, and it is the account's provider by construction
  occurred_at     TEXT NOT NULL,  -- RFC 3339 UTC of the turn, carried from the source event's envelope. This is what the by-day slice groups on; the day boundary is the reader's, never baked in here
  session_id      TEXT,  -- the session whose run spent this turn. NULL for a turn NO session owns -- the window-start turn Spec-025 spends on an account outside every session -- so the account's own totals include it and no session's receipt does. No foreign key, for the reason the event log's own `session_id` carries none
  run_id          TEXT,  -- the run within that session. NULL exactly where `session_id` is NULL, and also where the provider attributed the turn no further than the session
  model_id        TEXT,  -- the model the turn ran on, as the provider names it. This is what the by-model slice groups on; NULL where the provider attributed usage no further than the run, and a NULL groups as its own unattributed bucket rather than being folded into another model
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_read_tokens     INTEGER,
  cache_write_tokens    INTEGER,
  reasoning_tokens      INTEGER,  -- the five counts, each NULL where the provider reported none. NULL is NOT zero: one provider reports all five per turn and the other reports what its per-model usage block carries, so coalescing an unreported count to zero would present a partial reading as a complete one. Taken from the carrier that is complete on each leg -- on the Claude leg the result frame's PER-MODEL block, never its top-level one, which counts the outer loop alone and undercounts as soon as helper conversations run.
  cost_usd_micros INTEGER,  -- integer micro-dollars; NULL = no figure yet, which is a different fact from a cost of zero and renders as no figure at all. Both providers are priced: Claude Code's own figure where its cost basis reads list or managed, and the daemon's price table, matched by the model's exact id, for Codex and for a Claude Code model whose basis reads unknown. A turn is priced once, at completion, and never repriced; a turn on a model the price table does not carry yet is held here with no figure until the table's next fetch carries that model
  cost_source     TEXT
                  CHECK(cost_source IS NULL OR cost_source IN ('provider_reported', 'derived_exact')),  -- where the figure came from: the provider's own figure, or the daemon's price table by exact model id; the same vocabulary the source event carries. Provenance is REUSED and not re-enumerated here: a second spelling of where a number came from is a second answer to one question
  observed_credential_generation INTEGER NOT NULL
                  CHECK(observed_credential_generation >= 1),  -- the account's `credential_generation` when the turn was metered, mirroring the member the account-scoped quota event and the window readings both carry, with the same floor: a stamp below 1 names a generation that never existed. Its `STRICT` INTEGER type refuses a fractional stamp, which would sort between two whole generations.
  CHECK ((cost_usd_micros IS NULL) = (cost_source IS NULL)),  -- a figure always names where it came from, and a provenance with no figure is a source for nothing; an unlabeled number is the one thing the app never draws as money
  CHECK (run_id IS NULL OR session_id IS NOT NULL)  -- a run belongs to a session, so a row naming a run and no session describes a turn that cannot exist
);

-- The two slices the account surface draws, and nothing else reads this table by any other shape.
CREATE INDEX idx_provider_account_usage_turns_account_day
  ON provider_account_usage_turns(account_id, occurred_at);
CREATE INDEX idx_provider_account_usage_turns_account_model
  ON provider_account_usage_turns(account_id, model_id);
```

Rows are appended and never rewritten. A provider's own usage history, where it publishes one, is drawn **beside** this table with the vendor named and is never reconciled into it: two accountants counting the same tokens differently is what one source of truth exists to prevent.

## Agent Definition Tables (Plan-024)

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

## Skill Record Table (Plan-026)

The console's own record for each skill folder. A skill is its folder, and every field the screen shows besides two lives in that folder: the record holds where the skill is available and its icon, and nothing else of the skill's own. Beside those it keeps the id the folder's address uses (`skillId`, `#/skills/<id>`), kept through a rename made in the app so two folders sharing a name never share an address, and the folder's path, which on an orphaned record is the last path the folder was known at. A folder renamed or deleted outside the app leaves its record orphaned, drawn in the `Folder gone` group with its icon and availability until it is reattached to a folder or discarded; nothing is rewritten or dropped silently. It is the skill half of the record mechanism `agent_definitions` is the agent half of, read through the same file watch.

It is **configuration, not session history**: not events-canonical, not rebuilt from the event log.

```sql
-- Owner: Plan-026
CREATE TABLE skill_records (
  id                TEXT NOT NULL PRIMARY KEY,  -- daemon-minted skillId, the folder's address; stable across a rename made in the app
  origin            TEXT NOT NULL  -- which place the folder lives in
                    CHECK(origin IN ('ours', 'claude', 'codex', 'plugin')),
  plugin_name       TEXT NOT NULL DEFAULT '',  -- the installing plugin's name on a plugin's skill, which is read-only; '' on every other origin
  scope             TEXT NOT NULL DEFAULT 'global'  -- global, or one project's own
                    CHECK(scope IN ('global', 'project')),
  scope_ref         TEXT NOT NULL DEFAULT '',  -- the project record's id at 'project'; '' at 'global'
  folder_path       TEXT NOT NULL,  -- the skill's folder; on an orphaned record, the last path the folder was known at
  availability      TEXT NOT NULL  -- JSON object, one boolean per provider the app runs ({ "claude": true, "codex": false }); a skill may be off everywhere. Seeded from the origin's default when the record is made
                    CHECK(json_valid(availability) AND json_type(availability) = 'object'),
  icon              TEXT,  -- NULL = the generic skill glyph; a glyph key from the console's own icon set
  orphaned          INTEGER NOT NULL DEFAULT 0  -- 1 while the folder is renamed or deleted outside the app and the record is neither reattached nor discarded
                    CHECK(orphaned IN (0, 1)),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK((origin = 'plugin') = (plugin_name <> '')),
  CHECK((scope = 'global') = (scope_ref = ''))
);

-- One live record per folder; an orphaned record keeps its last path without holding the folder.
CREATE UNIQUE INDEX idx_skill_records_folder ON skill_records(folder_path) WHERE orphaned = 0;
```

## Attention Delivery State (Plan-016)

The attention service's entries carry the state its two deliveries beyond the app need to survive a service restart ([Spec-017 §Cross-Device Delivery](../../specs/017-notifications-and-attention-model.md#cross-device-delivery)). No table here holds a mail password, a web address or its signing secret: each is kept as its own item in the operating system's credential store and never written to a column, a reply, an event, a log or an error ([ADR-036](../../decisions/036-workflow-secrets-in-the-os-keychain.md)).

- **Each attention entry** carries a nullable `digested_at`, the instant the entry went out in an email digest, so no entry is listed twice and the digest's one timer is restored from it at start; and a nullable `web_address_state` (`pending`, `delivered` or `undelivered`) with its attempt count, so a retry to the web address survives a restart. Both live as long as the entry.
- **Each delivery channel** — the web address and the email digest — keeps one outcome row: when the last attempt ran, its result (`delivered`, `refused`, `unreachable`, `timedOut`, `signInRefused`, `notEncrypted` or `notAnAddress`), the HTTP status where there was one, and how many moments are undelivered. The row is overwritten on each attempt and removed with the channel's secret; `attention.deliveryRead` returns it.
- **The session row's `muted_at`** (§Session Directory) keeps a muted session's `Finished` and `Failed` moments out of both channels.
- **Each push to another device** keeps a `push_deliveries` row, its device one of `trusted_devices` (§Remote Control Tables).

```sql
-- Owner: Plan-016 (T3.6)
-- One row per device a push went to, so a withdrawal reaches exactly the devices that got the entry.
-- A row goes when its entry is withdrawn or 24 hours after it was sent.
CREATE TABLE push_deliveries (
  entry_id     TEXT NOT NULL,                     -- the attention entry the push announced
  device_id    TEXT NOT NULL REFERENCES trusted_devices(device_id),
  collapse_id  TEXT NOT NULL,                     -- the moment's stable id, sent as the push's collapse id, so a later push for the same moment replaces it in place
  state        TEXT NOT NULL
               CHECK(state IN ('sent', 'replaced')),  -- 'replaced' once a later push for the same moment took its place, which leaves nothing to withdraw
  sent_at      TEXT NOT NULL,
  PRIMARY KEY (entry_id, device_id)
);
```

## Remote Control Tables (Plan-025)

Each machine keeps its own verified view of the account's devices, which the channel's handshake reads, and the ports it shares with them ([Spec-027](../../specs/027-remote-control.md)). Settings › Devices lists both. The account's trust is an append-only chain of signed statements, each naming the hash of the one before it. Every machine verifies the chain itself and trusts a key only when a path of `runtimenode.added`, `device.linked` and `passkey.added` statements reaches it from its own machine key, each signed while its signer was still trusted at that point in the chain. A `device.revoked`, `runtimenode.removed` or `passkey.removed` ends the key it names at that point: a statement that key signs afterward is refused, and what it signed before stands, so every device, machine and passkey it added stays trusted. An ended key is never trusted again.

```sql
-- Owner: Plan-025
-- The verified chain, append-only. Kept until the account is gone; a forgotten device's
-- `device.revoked` stays in it.
CREATE TABLE trust_statements (
  statement_hash    TEXT PRIMARY KEY,             -- the statement's own hash, which the next statement names
  previous_hash     TEXT,                         -- the hash of the statement before it; NULL for the chain's first
  kind              TEXT NOT NULL
                    CHECK(kind IN ('device.linked', 'device.renamed', 'device.revoked',
                                   'passkey.added', 'passkey.removed',
                                   'runtimenode.added', 'runtimenode.renamed', 'runtimenode.removed')),
  statement         BLOB NOT NULL                 -- the signed statement as verified, signed by a machine key, a device key or a passkey
);

-- Owner: Plan-025
-- One row per device the chain trusts or has revoked. Kept until the account is gone; a
-- forgotten device's row goes.
CREATE TABLE trusted_devices (
  device_id               TEXT PRIMARY KEY,
  public_key              BLOB NOT NULL,
  key_algorithm           TEXT NOT NULL
                          CHECK(key_algorithm IN ('p256', 'ed25519')),  -- every public key carries its algorithm, because the Secure Enclave has no Ed25519
  name                    TEXT NOT NULL,
  platform                TEXT NOT NULL,
  trusted_by_statement    TEXT NOT NULL REFERENCES trust_statements(statement_hash),  -- the statement that trusts it
  revoked_at              TEXT,                   -- NULL while trusted
  notification_settings   TEXT,                   -- JSON: the device's switches {notifyOutsideTheApp, countOnAppIcon, kinds}, handed over by device.notificationSettingsSet; the device holds the source of truth
  push_key                BLOB,                   -- the key a push notice to this device is sealed to
  web_push_keys           TEXT,                   -- JSON: the web client's subscription keys {p256dh, auth}; NULL on every other device
  CHECK(revoked_at IS NULL OR (notification_settings IS NULL AND push_key IS NULL AND web_push_keys IS NULL))  -- the switches and push keys are kept until the device is revoked
);

-- Owner: Plan-025
-- The ports this machine shares with the account's devices: only listed ports, and only loopback,
-- forwarded through the channel. A row stays until the port is removed from the list.
CREATE TABLE shared_ports (
  port      INTEGER PRIMARY KEY
            CHECK(port BETWEEN 1 AND 65535),
  added_at  TEXT NOT NULL
);
```

## Session Search Index

The search across every session and a session's own find are answered from one FTS5 virtual table over session titles, message text, tool calls, group names and tags, SQLite's own full-text index, which the daemon's `better-sqlite3` 13.0.3 build carries against SQLite 3.53.4. It reaches every session the list holds, archived ones included, with no cap, and is kept in step with the rows it indexes by the daemon's write path. Only settled messages are indexed, never streamed chunks; a prefix index serves search as the person types; and the index is merged into one tree (FTS5's `optimize`) when the daemon is idle. A `tag:<tag>` term matches the tag and every tag nested under it through `session_tags`. A search with words alone answers in the index's BM25 order; where it also names a relation or a tag, the BM25 rank and the relation rank from `session_related` are merged by Reciprocal Rank Fusion, each list contributing 1/(60 + its rank), and the person's `Search all sessions` box gets its hits grouped by session, while the agents' `session_search` gets them grouped by project, then group, then session, each branch ordered by its best score. A common word ranked across 1,000,000 messages measured 8.2 ms at p95 on SQLite 3.50.4, inside the 50 ms budget §Session Directory (Plan-001) sets. Its DDL lands with the search reads, `session.search` across sessions and `transcript.search` within one ([api-payload-contracts §Operations Not Yet Built](../contracts/api-payload-contracts.md#operations-not-yet-built)).
