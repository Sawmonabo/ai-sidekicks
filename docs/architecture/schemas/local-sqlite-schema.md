# Local SQLite Schema

Canonical schema for the local daemon's SQLite database. Each runtime node maintains its own instance.

The database is one schema, created whole when the daemon first opens it. There are no numbered migrations and no upgrade steps: a feature that needs a table or a column adds it to this schema, and to the schema's test, in the change that builds the feature. Every table is `STRICT`, so each column is typed `INTEGER`, `REAL`, `TEXT`, `BLOB` or `ANY`, JSON is stored as `TEXT`, and a value that cannot be stored losslessly in its column's type is refused on write rather than kept under a looser affinity. A primary-key column of a `STRICT` table is `NOT NULL` whether or not it says so ([SQLite, STRICT Tables](https://www.sqlite.org/stricttables.html)).

**Storage boundary:** Machine-scoped execution truth and recovery data. See [Data Architecture](../data-architecture.md).

Five areas keep their tables in files of their own, beside this one:

- [Orchestration Tables (Plan-013)](local-sqlite-orchestration-tables.md)
- [Workflow Tables (Plan-014)](local-sqlite-workflow-tables.md)
- [MCP Governance Tables (Plan-022)](local-sqlite-mcp-governance-tables.md)
- [Provider Account Tables (Plan-023)](local-sqlite-provider-account-tables.md)
- [Agent Definition Tables (Plan-024)](local-sqlite-agent-definition-tables.md)

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
  actor                  TEXT,                       -- the payload's own actor: the device a connection sent the event from, the agent_id, or 'daemon' on an intervention the daemon made itself; NULL when the payload names none
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

**Content payload (machine-authored prose).** `content_payload` is the durable home for the prose the _machine_ side of a session produces — the assistant message body, the reasoning-update body, and tool-call arguments / result / error bodies. It exists because [ADR-027](../../decisions/027-canonical-transcript-is-authoritative.md) rules the daemon's canonical transcript authoritative for the content of a provider session, and a projection rebuilt from `session_events` can only be authoritative for content the rows actually hold. It holds machine-authored session work product ([Spec-020 §PII Data Map](../../specs/020-data-retention-export-and-deletion.md#pii-data-map)), stored plain like every other column. A body of 1 KiB or more is compressed with raw deflate at level 6 before it is written, and the encoding is recorded in the payload so a reader inflates it; a smaller body is stored as it is.

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
-- under the session's id, so a read is one indexed lookup. Only the sessions it links to directly are
-- stored, each scored with the two-step paths that also reach it, since every row of the list names a
-- link. A new link re-scores, in the background after its event is written, only the two sessions it
-- joins and their neighbors.
CREATE TABLE session_related (
  session_id          TEXT NOT NULL,
  related_session_id  TEXT NOT NULL,
  score               REAL NOT NULL,
  PRIMARY KEY (session_id, related_session_id)
);

CREATE INDEX idx_session_related_score ON session_related(session_id, score DESC);

-- Each session.create's idempotency key, the session it made and where that session works: its
-- mount, its execution mode and the group it asked for (NULL for none, and for every chat). Written
-- in the session.created write, so a retry with the key, or the daemon's start, finishes a session
-- left provisioning.
CREATE TABLE session_create_requests (
  client_idempotency_key  TEXT NOT NULL PRIMARY KEY,
  session_id              TEXT NOT NULL UNIQUE,
  repo_mount_id           TEXT NOT NULL,
  execution_mode          TEXT NOT NULL
    CHECK (execution_mode IN ('bound-root', 'provisioned-worktree')),
  group_id                TEXT
) STRICT;

-- A chat's conversion: the session.convert key it runs under, which the latest request that
-- resumed it takes over, and the project mount it attached. Written as soon as the mount is, so a
-- retry resumes onto that mount, and answered from session.converted once that lands. One per chat.
CREATE TABLE session_convert_requests (
  client_idempotency_key  TEXT NOT NULL PRIMARY KEY,
  session_id              TEXT NOT NULL UNIQUE,
  repo_mount_id           TEXT NOT NULL
) STRICT;

-- Each workspace file a conversion has dealt with, recorded as its copy lands: copied, or not
-- copied with the reason. A resumed conversion skips every path here and counts from these rows;
-- the files not copied are read a page at a time by session.convertSkippedFileList.
CREATE TABLE session_convert_files (
  session_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  outcome     TEXT NOT NULL
    CHECK (outcome IN ('copied', 'repository_has_file', 'repository_path_not_a_folder', 'link',
      'special_file')),
  PRIMARY KEY (session_id, path)
) STRICT, WITHOUT ROWID;
```

Budget, at 10,000 sessions, 1,000,000 indexed messages, 100,000 links and 30,000 tags, measured on the daemon's own build: a related list under 1 ms and a search under 50 ms at p95. Measured on the daemon's build (SQLite 3.53.4, Apple M1 Pro) at 10,000 sessions and 100,000 links: a stored related list read in 0.128 ms at p95, about 20 stored rows per session, and the re-score after one new link took 55 ms of wall time at p95 in the background, yielding to the event loop every 2 ms between sessions; one session's scoring is not split, and the longest turn of the daemon's main thread measured 12 ms (6 to 10 ms at p95).

A conversion records each file as its copy lands without waiting for that record before the next copy, with at most 100 records waiting at once, so the writer folds them into shared batches. Measured on the same build, converting a chat of 1 KiB files in 100 folders took 0.36 s and 68 writer batches at 1,000 files and 29 s at 100,000 files; awaiting each record would hold every file for the writer's 10 ms batch window, 12.6 s at 1,000 files.

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

## Runs (Plan-002)

The run's state is event-sourced: each `run.*` state change, and each applied or degraded intervention, writes this row in the same write as its event, so the row always equals a rebuild from the log. It is the read `getRun` answers from, and the row a state change's guarded swap moves.

```sql
-- Owner: Plan-002
CREATE TABLE runs (
  run_id         TEXT NOT NULL PRIMARY KEY,
  session_id     TEXT NOT NULL,
  parent_run_id  TEXT,                          -- NULL on a lead run
  reached_by     TEXT                           -- how a child run was reached; NULL on a lead run
                 CHECK(reached_by IS NULL
                   OR reached_by IN ('provider_subagent', 'bridge_run', 'workflow_step')),
  state          TEXT NOT NULL
    CHECK(state IN ('queued', 'starting', 'running', 'waiting_for_approval', 'waiting_for_input',
                    'pausing', 'paused', 'completed', 'interrupted', 'stopped', 'failed')),
  run_version    INTEGER NOT NULL CHECK(run_version >= 0)  -- counts every progression (Plan-002 D-002-1)
) STRICT;

CREATE INDEX idx_runs_session ON runs(session_id);
CREATE INDEX idx_runs_parent ON runs(parent_run_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX idx_runs_live ON runs(state)               -- the runs a restart settles
  WHERE state NOT IN ('completed', 'interrupted', 'stopped', 'failed');
```

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
                         CHECK(state IN ('requested', 'accepted', 'applied', 'rejected', 'degraded', 'expired', 'failed')),
  payload                TEXT NOT NULL DEFAULT '{}', -- JSON: type-specific fields, a steer's text among them as plain text (Spec-003 §Required Behavior)
  expected_run_version   INTEGER NOT NULL,           -- MANDATORY fail-closed comparand (Spec-003 §Interfaces And Contracts / Plan-002 D-002-2)
  client_idempotency_key TEXT NOT NULL,              -- MANDATORY requester-generated UUID (a client's, or the daemon's own for its own stop); return-or-conflict intervention dedupe (Spec-004 §Required Behavior)
  device_id              TEXT,                       -- the device the intervention came from (the machine's own screen or a linked device's channel), found from the connection at acceptance; NULL means the daemon's own stop (Queue And Intervention Model)
  rejection_reason       TEXT,                       -- machine-readable rejected cause (driver.capability_unsupported foremost) — durable across a retry: the reply carries no result, so a retry that returns the saved reply reconstructs rejectionReason from this column (Plan-002 T1.4/T3.13)
  fallback_action        TEXT,                       -- the fallback a degraded intervention took; NULL in every other state
  failure_reason         TEXT,                       -- what a failed dispatch threw (a daemon error's code, else its message), so a retry's saved reply carries the same failureReason; NULL in every other state
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
                  CHECK(state IN ('preparing', 'ready', 'busy', 'stale', 'archived')),
  metadata        TEXT NOT NULL DEFAULT '{}', -- JSON; lastError detail on a failed mode switch (Spec-007); boundRoot: admitted bind origin — the bound-root execution-root carrier, never cleared by a new preparation (Spec-007/Spec-008)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_workspaces_session ON workspaces(session_id);
CREATE INDEX idx_workspaces_repo ON workspaces(repo_mount_id);
-- A session has one live workspace on a mount, so binding it again answers that one; an archived
-- row is history and does not count.
CREATE UNIQUE INDEX idx_workspaces_live_session_mount
  ON workspaces(session_id, repo_mount_id) WHERE state <> 'archived';

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

The search across every session and a session's own find are answered from the daemon's own full-text index on Tantivy over session titles, message text, tool calls, group names and tags. The index lives outside this database and is built from it: every write that changes searchable text adds a row to an outbox table here in the same transaction, the daemon applies the outbox to the index in batches and deletes the rows each durable index commit holds, and a crash replays what the index has not committed ([ADR-041](../../decisions/041-session-search-on-tantivy.md)). It reaches every session the list holds, archived ones included, with no cap. Only settled messages are indexed, never streamed chunks; prefix fields of one to four characters serve search as the person types; and the index merges its segments when the daemon is idle. A `tag:<tag>` term matches the tag and every tag nested under it through `session_tags`. A search with words alone answers in BM25 order (k1 1.2, b 0.75, a word in half or more of the rows weighted 1e-6); where it also names a tag, the BM25 rank and the tag rank (the tagged sessions, most recently active first) are merged by Reciprocal Rank Fusion, each list contributing 1/(60 + its rank); the person's box names no session, so `session_related` takes no part, and the person's `Search all sessions` box gets its hits grouped by session, while the agents' `session_search` gets them grouped by project, then group, then session, each branch ordered by its best score. The outbox is `session_search_outbox`, written by triggers on `session_events` (a settled message or tool call as it is appended), `sessions` (a title, a move between groups, a purge), `session_groups` (a name, a deletion) and `session_tags`. It copies no text: the search thread reads each row's text as this database holds it when a batch is read, at most 50,000 outbox rows or 16 MiB of text, ending a batch at a deleted session or group, and a row gone by then leaves the index. An index row's key is its source row's rowid times four plus its kind's slot (`event` 0, `title` 1, `group` 2, `tag` 3), and its owner is a session's rowid in `sessions` or, for a group name, the group's rowid in `session_groups`; nothing vacuums this database, so those rowids never move. A missing or unreadable index, or one whose last applied outbox id is past any id this outbox has given (an index built from another database), is rebuilt from this database on the search thread while the daemon serves; that thread then ends, so the build's memory goes with it, and a fresh search thread opens the index. A search's later pages read the index as its first page did; because a source table gives a deleted row's rowid to the next row it inserts, `session_search_rowid_floors` logs every delete that lowers an indexed table's highest rowid, with the new highest, and a later page credits a held row only while its source rowid is no higher than every highest rowid logged since that view, so a row at a rowid a later row took is passed over like a purged one. The source tables insert without naming a rowid and never `REPLACE`, whose deletes fire no trigger. A held search is let go after 5 minutes unpaged or 30 minutes in all, and past 16 held the least recently paged goes first; a cursor of a search let go is refused `session.search_cursor_unresolvable`.

```sql
CREATE TABLE session_search_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- never reused, so the id an index commit records always means the same row
  index_key  INTEGER NOT NULL,                   -- source rowid * 4 + the kind's slot
  kind       TEXT NOT NULL CHECK (kind IN ('event', 'title', 'group', 'tag')),
  owner_key  INTEGER NOT NULL,                   -- sessions.rowid, or session_groups.rowid for a group name
  -- 'row': read the row at index_key again; 'owner': the session or group at index_key left with
  -- every row it owns; 'members': read the group's members again
  operation  TEXT NOT NULL CHECK (operation IN ('row', 'owner', 'members'))
) STRICT;

CREATE TABLE session_search_rowid_floors (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,                  -- the index rows the table's rows source
  highest_rowid  INTEGER NOT NULL                -- the table's highest rowid after the delete; 0 when empty
) STRICT;

-- A search by tag and words reads each tagged session's rowid and last activity from here alone.
CREATE INDEX idx_sessions_activity ON sessions(id, last_activity_at);
```
