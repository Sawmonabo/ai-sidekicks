# Local SQLite Schema

Canonical schema for the local daemon's SQLite database. Each machine keeps its own instance.

The database is one schema, created whole when the daemon first opens it. There are no numbered migrations and no upgrade steps: a feature that needs a table or a column adds it to this schema, and to the schema's test, in the change that builds the feature. Every table is `STRICT`, so each column is typed `INTEGER`, `REAL`, `TEXT`, `BLOB` or `ANY`, JSON is stored as `TEXT`, and a value that cannot be stored losslessly in its column's type is refused on write rather than kept under a looser affinity. A primary-key column of a `STRICT` table is `NOT NULL` whether or not it says so ([SQLite, STRICT Tables](https://www.sqlite.org/stricttables.html)).

**Storage boundary:** Machine-scoped execution truth and recovery data. See [Data Architecture](../data-architecture.md).

Nine areas keep their tables in files of their own, beside this one:

- [Session Tables (Plan-001)](local-sqlite-session-tables.md)
- [Session Search Index Tables (ADR-041)](local-sqlite-session-search-tables.md)
- [Workspace and Git Tables (Plan-006, Plan-007, Plan-008)](local-sqlite-workspace-and-git-tables.md)
- [Orchestration Tables (Plan-013)](local-sqlite-orchestration-tables.md)
- [Workflow Tables (Plan-014)](local-sqlite-workflow-tables.md)
- [MCP Governance Tables (Plan-022)](local-sqlite-mcp-governance-tables.md)
- [Provider Account Tables (Plan-023)](local-sqlite-provider-account-tables.md)
- [Agent Definition Tables (Plan-024)](local-sqlite-agent-definition-tables.md)
- [Remote Control Tables (Plan-025)](local-sqlite-remote-control-tables.md)

## Pragmas

```sql
PRAGMA busy_timeout = 5000;     -- first, so a second daemon opening the same fresh file waits out the first one's switch to WAL rather than failing busy
PRAGMA journal_mode = WAL;      -- concurrent readers during writes
PRAGMA synchronous = FULL;      -- set explicitly, for durability (see Spec-013 §Pragmas)
PRAGMA checkpoint_fullfsync = ON; -- on macOS a checkpoint syncs with the drive's full flush (F_FULLFSYNC), so a power cut cannot damage the file; no effect elsewhere
PRAGMA foreign_keys = ON;
PRAGMA secure_delete = ON;      -- deleted content is overwritten with zeros, so a deleted session leaves no readable freed page
PRAGMA cache_size = -2000;      -- on every connection, read-only ones included: SQLite's own 2,000 KiB page cache
PRAGMA cell_size_check = ON;    -- on every connection: each b-tree page is checked as it is first read from disk, so a damaged page fails the read that meets it rather than spreading
PRAGMA trusted_schema = OFF;    -- on every connection: the schema calls only SQLite's own built-in functions
PRAGMA optimize = 0x10002;      -- on the writer, once at open after the schema step; the daily PRAGMA optimize is a scheduler job
```

The transaction that creates the schema writes its fingerprint, the first 31 bits of the BLAKE3 hash of the schema's text, into `PRAGMA user_version`, and every open of a file that already holds the schema compares the two and refuses a file another build made, never migrating it.

---

## Session Events (Plan-001, extended by Plans 004, 012)

```sql
-- Owner: Plan-001 | Extended by: Plan-004 (event taxonomy), Plan-025 (received-row provenance marker), Plan-012 (projection cursors)
CREATE TABLE session_events (
  id                     TEXT PRIMARY KEY,           -- ULID or UUID
  session_id             TEXT NOT NULL,              -- real session ULID/UUID, or a reserved daemon-scope sentinel for daemon-scope events (no FK; see Spec-005 §Daemon-Scope Event Binding)
  sequence               INTEGER NOT NULL,           -- monotonic per session
  occurred_at            TEXT NOT NULL,              -- RFC 3339 UTC with ms precision (wall-clock; display + audit)
  monotonic_ns           INTEGER NOT NULL,           -- nanoseconds since the daemon's start on std::time::Instant at emit; within-daemon ordering only (see Spec-013 §Clock Handling)
  category               TEXT NOT NULL,              -- e.g. 'runLifecycle', 'agentOutput', 'toolActivity'
  type                   TEXT NOT NULL,              -- specific event type within category
  actor                  TEXT,                       -- the payload's own actor: the device a connection sent the event from, the agent_id, or 'daemon' on an intervention the daemon made itself; NULL when the payload names none
  payload                TEXT NOT NULL DEFAULT '{}', -- JSON event payload
  content_payload        BLOB,                       -- Agent- and tool-generated prose (Spec-005 §Agent Output + §Tool Activity): the agent message body, the reasoning-update body, tool-call arguments / result / error bodies, and the provider's own denial an `approval.reviewer.denied` row keeps for `Allow once` (Claude Code's action as its `PermissionDenied` hook received it, Codex's review as Codex sent it). Stored as written, never encrypted by the app. A body of 1 KiB or more is compressed with zstd at level 3, and the encoding is recorded in the payload as `contentEncoding: "zstd"`; a smaller body is stored as its UTF-8 bytes. NULL on every row whose event type carries no prose, eventMaintenance rows among them. This column is machine-authored session work product (Spec-020 §PII Data Map).
  correlation_id         TEXT,                       -- links related events
  causation_id           TEXT,                       -- parent event that caused this one
  version                TEXT NOT NULL DEFAULT '1.0'
                         CHECK (version GLOB '[0-9]*.[0-9]*'), -- semver "MAJOR.MINOR" per ADR-017 §Decision #1
                                                               -- (never INTEGER; comparison must parse MAJOR/MINOR as ints —
                                                               -- lexical TEXT comparison is unsafe, e.g. "1.10" < "1.9")
  run_id                 TEXT,                       -- the run the event belongs to, set by the append from the typed event for every event type that carries one; NULL otherwise
  run_version            INTEGER,                    -- the run's progression counter the event was written at, set by the append beside run_id for every event type that carries one; NULL otherwise
  turn_number            INTEGER,                    -- the turn's number within its run, from 1, set by the append beside run_id for the turn start and the three turn ends; NULL otherwise
  UNIQUE(session_id, sequence)
) STRICT;

CREATE INDEX idx_session_events_type ON session_events(session_id, type);
CREATE INDEX idx_session_events_skipped ON session_events(session_id) WHERE type = 'session.damagedEvents.skipped';
-- One run's events of one type in log order, for the reads that seed a run's turns and that find a live run's agent and newest touch.
CREATE INDEX idx_session_events_run ON session_events(session_id, type, run_id, sequence) WHERE run_id IS NOT NULL;
-- One run's events that name an actor, in log order, for the read that finds who acts for a run.
CREATE INDEX idx_session_events_run_actor ON session_events(session_id, run_id, sequence) WHERE run_id IS NOT NULL AND actor IS NOT NULL;
CREATE INDEX idx_session_events_correlation ON session_events(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE UNIQUE INDEX idx_session_events_run_terminal_once ON session_events(run_id, run_version) WHERE category = 'runLifecycle' AND type IN ('agent.run.completed', 'agent.run.interrupted', 'agent.run.stopped', 'agent.run.failed');
-- Every started turn gets exactly one end (Spec-005 §Run Lifecycle).
CREATE UNIQUE INDEX idx_session_events_turn_end_once ON session_events(run_id, turn_number) WHERE category = 'runLifecycle' AND type IN ('agent.turn.completed', 'agent.turn.interrupted', 'agent.turn.failed');
-- A turn number starts once in its run.
CREATE UNIQUE INDEX idx_session_events_turn_start_once ON session_events(run_id, turn_number) WHERE category = 'runLifecycle' AND type = 'agent.turn.started';

-- Projection-level terminal-key CHECK (Spec-005 at-most-once terminal emission; assigned to the Plan-004
-- schema work). A CHECK sees only the row being written, never the row an UPDATE replaces, so the guard is a
-- trigger trio: abort any terminal runLifecycle write whose run_id or run_version is NULL. The BEFORE UPDATE leg keys off OLD (the row WAS terminal) and aborts a value-changing key rewrite (NEW key IS NOT OLD, null-safe) or a category/type de-scope — either frees the index entry for a duplicate terminal. The promote leg rejects re-typing any non-terminal row INTO the guarded set (terminal rows are INSERT-only): an OLD-keyed guard alone would let a null-keyed promotion slip both legs and the NULL-distinct UNIQUE index.
CREATE TRIGGER trg_run_terminal_key_insert BEFORE INSERT ON session_events
WHEN NEW.category = 'runLifecycle'
  AND NEW.type IN ('agent.run.completed', 'agent.run.interrupted', 'agent.run.stopped', 'agent.run.failed')
  AND (NEW.run_id IS NULL OR NEW.run_version IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a terminal run row requires a run_id and a run_version');
END;
CREATE TRIGGER trg_run_terminal_key_update BEFORE UPDATE OF run_id, run_version, category, type ON session_events
WHEN OLD.category = 'runLifecycle'
  AND OLD.type IN ('agent.run.completed', 'agent.run.interrupted', 'agent.run.stopped', 'agent.run.failed')
  AND (NEW.run_id IS NOT OLD.run_id OR NEW.run_version IS NOT OLD.run_version OR NEW.category IS NOT OLD.category OR NEW.type IS NOT OLD.type)
BEGIN
  SELECT RAISE(ABORT, 'a terminal run row keeps its run_id, run_version, category and type');
END;
CREATE TRIGGER trg_run_terminal_key_promote BEFORE UPDATE OF category, type ON session_events
WHEN NOT (OLD.category = 'runLifecycle' AND OLD.type IN ('agent.run.completed', 'agent.run.interrupted', 'agent.run.stopped', 'agent.run.failed'))
  AND NEW.category = 'runLifecycle'
  AND NEW.type IN ('agent.run.completed', 'agent.run.interrupted', 'agent.run.stopped', 'agent.run.failed')
BEGIN
  SELECT RAISE(ABORT, 'a row cannot become a terminal run row by UPDATE; terminal rows are insert-only');
END;

-- The same trio guards idx_session_events_turn_end_once on (run_id, turn_number): a turn end's NULL run_id or turn_number
-- would pass the index, so the insert is refused, a committed turn end keeps its key, and no row becomes a turn end by UPDATE.
CREATE TRIGGER trg_turn_end_key_insert BEFORE INSERT ON session_events
WHEN NEW.category = 'runLifecycle'
  AND NEW.type IN ('agent.turn.completed', 'agent.turn.interrupted', 'agent.turn.failed')
  AND (NEW.run_id IS NULL OR NEW.turn_number IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a turn end row requires a run_id and a turn_number');
END;
CREATE TRIGGER trg_turn_end_key_update BEFORE UPDATE OF run_id, turn_number, category, type ON session_events
WHEN OLD.category = 'runLifecycle'
  AND OLD.type IN ('agent.turn.completed', 'agent.turn.interrupted', 'agent.turn.failed')
  AND (NEW.run_id IS NOT OLD.run_id OR NEW.turn_number IS NOT OLD.turn_number OR NEW.category IS NOT OLD.category OR NEW.type IS NOT OLD.type)
BEGIN
  SELECT RAISE(ABORT, 'a turn end row keeps its run_id, turn_number, category and type');
END;
CREATE TRIGGER trg_turn_end_key_promote BEFORE UPDATE OF category, type ON session_events
WHEN NOT (OLD.category = 'runLifecycle' AND OLD.type IN ('agent.turn.completed', 'agent.turn.interrupted', 'agent.turn.failed'))
  AND NEW.category = 'runLifecycle'
  AND NEW.type IN ('agent.turn.completed', 'agent.turn.interrupted', 'agent.turn.failed')
BEGIN
  SELECT RAISE(ABORT, 'a row cannot become a turn end row by UPDATE; turn end rows are insert-only');
END;

-- The same trio guards idx_session_events_turn_start_once on (run_id, turn_number): a turn start's NULL run_id or turn_number
-- would pass the index, so the insert is refused, a committed turn start keeps its key, and no row becomes a turn start by UPDATE.
CREATE TRIGGER trg_turn_start_key_insert BEFORE INSERT ON session_events
WHEN NEW.category = 'runLifecycle'
  AND NEW.type = 'agent.turn.started'
  AND (NEW.run_id IS NULL OR NEW.turn_number IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a turn start row requires a run_id and a turn_number');
END;
CREATE TRIGGER trg_turn_start_key_update BEFORE UPDATE OF run_id, turn_number, category, type ON session_events
WHEN OLD.category = 'runLifecycle'
  AND OLD.type = 'agent.turn.started'
  AND (NEW.run_id IS NOT OLD.run_id OR NEW.turn_number IS NOT OLD.turn_number OR NEW.category IS NOT OLD.category OR NEW.type IS NOT OLD.type)
BEGIN
  SELECT RAISE(ABORT, 'a turn start row keeps its run_id, turn_number, category and type');
END;
CREATE TRIGGER trg_turn_start_key_promote BEFORE UPDATE OF category, type ON session_events
WHEN NOT (OLD.category = 'runLifecycle' AND OLD.type = 'agent.turn.started')
  AND NEW.category = 'runLifecycle'
  AND NEW.type = 'agent.turn.started'
BEGIN
  SELECT RAISE(ABORT, 'a row cannot become a turn start row by UPDATE; turn start rows are insert-only');
END;
```

**Terminal-exactly-once backstop.** The `idx_session_events_run_terminal_once` partial unique index is the schema-level terminal-exactly-once backstop (Plan-004): a duplicate terminal `runLifecycle` row for the same `(run_id, run_version)` epoch fails loud with a `UNIQUE` violation; rows with a NULL `run_id` or `run_version` bypass it (SQLite NULL-distinctness), so the Plan-002 terminal emitter enforces the non-null-key precondition this index backstops. The run keys are real columns the append writes from the typed event, so the index, the triggers and the run reads (`idx_session_events_run`) read columns and no write parses its payload for them, and `STRICT` typing holds `run_id` to text and `run_version` to an integer, per the `RunId` string / any-run-progression-counter payload contract in [Spec-005 §Run Lifecycle](../../specs/005-session-event-taxonomy-and-audit-log.md#run-lifecycle-runlifecycle). The engine semantics this backstop relies on are load-bearing, and each is cited to the official SQLite documentation: [partial indexes](https://sqlite.org/partialindex.html) (the `WHERE category = 'runLifecycle' AND type IN (…)` filter), [UNIQUE-index enforcement](https://sqlite.org/lang_createindex.html#unique_indexes), [NULL-distinctness](https://sqlite.org/nulls.html) (two NULLs are distinct for UNIQUE purposes, so NULL-key rows bypass the constraint) and [STRICT tables](https://www.sqlite.org/stricttables.html). Beside it the schema carries the `trg_run_terminal_key_insert` / `trg_run_terminal_key_update` / `trg_run_terminal_key_promote` trigger trio — the projection-level CHECK-equivalent Spec-005's at-most-once-terminal-emission rule assigns to this schema work — which aborts terminal `runLifecycle` writes whose `run_id` or `run_version` is NULL. The INSERT leg closes the NULL-distinctness bypass the UNIQUE index cannot catch; the UPDATE leg (`BEFORE UPDATE OF run_id, run_version, category, type`, keyed off `OLD` so a row that WAS terminal cannot escape by mutation) aborts a **value-changing key rewrite** (`NEW` key `IS NOT` `OLD`, null-safe — an UPDATE rewriting `(R,7)` to another non-null pair would otherwise free the index entry for a duplicate terminal) and a **`category`/`type` de-scope** (flipping a terminal row out of the guarded set is the same escape). The promote leg closes the inverse escape: an UPDATE re-typing a non-terminal row INTO the guarded set is rejected outright — terminal rows are INSERT-only — so a null-keyed promotion cannot slip past the OLD-keyed update leg and the NULL-distinct UNIQUE index (Plan-004 schema work).

**Turn once backstops.** `idx_session_events_turn_end_once` holds a turn to one end: a second `agent.turn.completed`, `agent.turn.interrupted` or `agent.turn.failed` row for the same `(run_id, turn_number)` fails loud with a `UNIQUE` violation. The run engine's emission gate, keyed by run and turn number, drops a duplicate report before it reaches the write, and this index is the backstop behind it. A row with a NULL `run_id` or `turn_number` would pass the index, as a NULL run key would pass the terminal one, so the turn-end trio guards it as the terminal trio guards its index: `trg_turn_end_key_insert` refuses a turn-end insert missing either, `trg_turn_end_key_update` refuses an update that clears, rewrites or de-scopes a committed turn end's key, and `trg_turn_end_key_promote` refuses re-typing any other row into a turn end, so turn ends are insert-only. A turn end is the one row a run's log can take after the run's terminal row, a provider report that arrived late written once as that turn's end, so the terminal index does not cover it ([Spec-005 §Run Lifecycle](../../specs/005-session-event-taxonomy-and-audit-log.md#run-lifecycle-runlifecycle)). `idx_session_events_turn_start_once` holds a turn number to one start: the run engine numbers each `agent.turn.started` its run's newest start plus one, read inside the write, and a start that raced another to the same number is refused and numbered again. A row with a NULL `run_id` or `turn_number` would pass that index too, so the turn-start trio guards it the same way: `trg_turn_start_key_insert` refuses a turn-start insert missing either, `trg_turn_start_key_update` refuses an update that clears, rewrites or de-scopes a committed turn start's key, and `trg_turn_start_key_promote` refuses re-typing any other row into a turn start, so turn starts are insert-only.

**Content payload (machine-authored prose).** `content_payload` is the durable home for the prose the _machine_ side of a session produces — the agent message body, the reasoning-update body, and tool-call arguments / result / error bodies. It exists because [ADR-027](../../decisions/027-canonical-transcript-is-authoritative.md) rules the daemon's canonical transcript authoritative for the content of a provider session, and a projection rebuilt from `session_events` can only be authoritative for content the rows actually hold. It holds machine-authored session work product ([Spec-020 §PII Data Map](../../specs/020-data-retention-export-and-deletion.md#pii-data-map)), stored plain like every other column. A body of 1 KiB or more is compressed with zstd at level 3 before it is written, and the encoding is recorded in the payload as `contentEncoding`, so every reader decodes it through the daemon's one codec (`crates/sidekicks-daemon/src/events/content/codec.rs`); a smaller body is stored as its UTF-8 bytes.

**Long bodies.** Unlike a person's message, `content_payload` admits machine-scale text: a tool result is routinely a file dump or a command's whole stdout. A body is kept whole, never truncated, refused or dropped, and a client fetches a long one on demand through the daemon's read rather than receiving it inside the event. Nothing removes a body in the background: a session's rows, bodies included, are kept until the person deletes the session with `Delete old data` ([Spec-005 §Event Compaction Policy](../../specs/005-session-event-taxonomy-and-audit-log.md#event-compaction-policy)).

**Purge.** Deleting a session deletes its rows outright, `content_payload` with them, with `secure_delete` on (§Pragmas), so the freed pages hold nothing readable.

**Relay disposition — the column stays on its machine.** `content_payload` is **never relayed**: the bytes stay on the machine that wrote them, and a linked device reads a body only through the daemon's read, paired with the event and never merged into `payload` ([Spec-005 §Agent Output](../../specs/005-session-event-taxonomy-and-audit-log.md#agent-output-agentoutput)).

**A second machine holding a body is unreachable in V1.** A session executes on exactly one bound machine ([Spec-027 §Required Behavior](../../specs/027-remote-control.md#required-behavior)), and every row in that session's log is authored by that machine. No other daemon holds a row of this session, so there is no projection anywhere that would show a body it does not hold.

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
) STRICT;

CREATE INDEX idx_session_snapshots_session ON session_snapshots(session_id, as_of_sequence);
```

---

## Runs (Plan-002)

The run's state is event-sourced: each `agent.run.*` state change, and each applied or degraded intervention, writes this row in the same write as its event, so the row always equals a rebuild from the log. It is the read `getRun` answers from, and the row a state change's guarded swap moves.

```sql
-- Owner: Plan-002
CREATE TABLE runs (
  run_id         TEXT NOT NULL PRIMARY KEY,
  session_id     TEXT NOT NULL,
  parent_run_id  TEXT,                          -- NULL on a lead run
  reached_by     TEXT                           -- how a child run was reached; NULL on a lead run
                 CHECK(reached_by IS NULL
                   OR reached_by IN ('providerSubagent', 'bridgeRun', 'workflowStep')),
  is_apart       INTEGER NOT NULL DEFAULT 0     -- 1 on a run whose turn runs in a process of its own; such a run is never the lead run
                 CHECK(is_apart IN (0, 1)),
  state          TEXT NOT NULL
    CHECK(state IN ('queued', 'starting', 'running', 'waitingForApproval', 'waitingForInput',
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
                  CHECK(state IN ('queued', 'admitted', 'superseded', 'canceled', 'notDelivered')),
  not_delivered_reason TEXT                    -- why a notDelivered item was not delivered: it waited past the
                  CHECK(not_delivered_reason IN ('timedOut', 'failed')),  -- daemon's own delivery timeout, or its delivery failed outright
  payload         TEXT NOT NULL DEFAULT '{}', -- JSON: context, metadata, identifiers, and the item's
                                              -- body, a person's send or an orchestration-authored
                                              -- prompt (a workflow step's input, an orchestrated
                                              -- child-run prompt), as plain text (Plan-002 T1.4,
                                              -- Spec-003). Every drain-selection field is its own
                                              -- column (state, target_run_id, session_id,
                                              -- child_handle, position).
  target_run_id   TEXT,                       -- the run a user message is delivered into; NULL on an
                                              -- orchestration-authored item, which is admitted as a new run
  device_id       TEXT,                       -- the device a person's message came from (the machine's own
                                              -- screen or a linked device's channel), found from the
                                              -- connection at acceptance; NULL on an orchestration-authored
                                              -- item, the system's own (Queue And Intervention Model)
  child_handle    TEXT,                       -- the child whose queue holds the item, the handle the queue
                                              -- verbs name it by; NULL on the lead's queue
  position        INTEGER NOT NULL CHECK(position >= 0),  -- the item's place in its queue's order, lowest
                                              -- first: send order until agent.queueItem.reorder replaces it, and an
                                              -- edit takes the place of the item it supersedes
  client_idempotency_key TEXT,                -- the send's own key, so a retried send returns the saved item;
                                              -- NULL on an orchestration-authored item
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK((state = 'notDelivered') = (not_delivered_reason IS NOT NULL)),  -- a notDelivered item always says why
  UNIQUE(session_id, client_idempotency_key)  -- SQLite treats each NULL as distinct, so only sends dedupe
) STRICT;

CREATE INDEX idx_queue_items_session_state ON queue_items(session_id, state);
CREATE INDEX idx_queue_items_target_run ON queue_items(target_run_id) WHERE target_run_id IS NOT NULL;

-- Owner: Plan-002 (rejection_reason) | Extended by: Spec-004 (client_idempotency_key intervention dedupe)
CREATE TABLE interventions (
  id                     TEXT PRIMARY KEY,
  target_run_id          TEXT NOT NULL,
  type                   TEXT NOT NULL
                         CHECK(type IN ('interrupt', 'fasterModelRetry')),
  state                  TEXT NOT NULL DEFAULT 'requested'
                         CHECK(state IN ('requested', 'accepted', 'applied', 'rejected', 'degraded', 'expired', 'failed')),
  payload                TEXT NOT NULL DEFAULT '{}', -- JSON: the request's own fields, as plain text — a person's interrupt's `pending`, `deliverFirst` and optional `reason`, the daemon's own stop's `limit` (`stepLimit`, `spendLimit` or `tokenLimit`) and `turnNumber` (the turn it cut, where it cut one), a faster-model retry's `expectedTurnId` and `model`. A message the person sends mid-turn is a queue send, so its words sit on `queue_items.payload`, never here (Spec-003 §Required Behavior)
  expected_run_version   INTEGER NOT NULL,           -- MANDATORY fail-closed comparand (Spec-003 §Interfaces And Contracts / Plan-002 D-002-2)
  client_idempotency_key TEXT NOT NULL,              -- MANDATORY requester-generated UUID (a client's, or the daemon's own for its own stop); return-or-conflict intervention dedupe (Spec-004 §Required Behavior)
  device_id              TEXT,                       -- the device the intervention came from (the machine's own screen or a linked device's channel), found from the connection at acceptance; NULL means the daemon's own stop (Queue And Intervention Model)
  rejection_reason       TEXT,                       -- machine-readable rejected cause (provider.capability.unsupported foremost) — durable across a retry: the reply carries no result, so a retry that returns the saved reply reconstructs rejectionReason from this column (Plan-002 T1.4/T3.13)
  fallback_action        TEXT,                       -- the fallback a degraded intervention took; NULL in every other state
  failure_reason         TEXT,                       -- what a failed dispatch threw (a daemon error's code, else its message), the restart that kept it from completing, or the run's end and continue that kept it from being sent, so a retry's saved reply carries the same failureReason; NULL in every other state
  created_at             TEXT NOT NULL,
  resolved_at            TEXT,
  UNIQUE(target_run_id, client_idempotency_key)      -- identical retry returns the saved result; key reuse with a differing payload rejects as agent.intervention.idempotencyConflict (Spec-003 §Interfaces And Contracts) — distinct grain from command_receipts.command_id (per-command crash-recovery dedupe)
) STRICT;

CREATE INDEX idx_interventions_run ON interventions(target_run_id);
CREATE INDEX idx_interventions_state ON interventions(state) WHERE state IN ('requested', 'accepted');

-- Owner: Plan-002 | Extended by: Plan-012 (recovery + two-phase idempotency protocol); Plan-003 (nullable mcp_task_id and mcp_task_generation — MCP Tasks durable recovery handle — and delivered)
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
  -- `recoveryNeeded`. Spec-013 recovery reads this handle and polls tasks/get to a terminal status, then reads the result (tasks/result on 2025-11-25, inline on 2026-07-28)
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
  -- (both observed widths are pinned by the executable hazard proof, a test of the daemon's
  -- task-handle recorder in crates/sidekicks-daemon/src/provider/mcp/) — so the row
  -- would store a handle the receiver never issued.
  mcp_task_id       TEXT                          -- NULL default; MCP Tasks durable recovery handle
                    CHECK (mcp_task_id IS NULL OR (length(mcp_task_id) > 0 AND length(mcp_task_id) <= 256 AND instr(mcp_task_id, char(0)) = 0)),
  -- The task's generation, set exactly when mcp_task_id is and in the same statement, because ext-tasks
  -- resumes a task from its generation.
  mcp_task_generation TEXT CHECK (mcp_task_generation IN ('v1', 'v2')),
  delivered         INTEGER NOT NULL DEFAULT 0     -- 1 once a task-augmented call's result has reached the conversation, by steering a running turn or starting one, so a result that arrives after a daemon restart is delivered once
                    CHECK (delivered IN (0, 1)),
  created_at        TEXT NOT NULL,
  CHECK ((mcp_task_generation IS NULL) = (mcp_task_id IS NULL))
) STRICT;

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
-- Provider-output defense-in-depth CHECK constraints (Plan-003 T2.1): contract_version and
-- resume_handle are provider-declared strings persisted at the write seam. The
-- DB CHECK layer bounds the SQLite-expressible part (length + NUL-rejection);
-- semver-shape validation is NOT expressible as a pure-SQLite CHECK and is
-- enforced at the write seam's garde check (T2.2 runtime_bindings) using the
-- `semver` crate. The 4096/64 length literals are the canonical bounds that
-- the T2.2 write-path guard reuses, so the two layers stay consistent.
CREATE TABLE runtime_bindings (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  provider_name         TEXT NOT NULL,            -- e.g. 'claude', 'codex'
  contract_version    TEXT NOT NULL             -- canonical, identifying semver of driver contract (build metadata rejected by the T2.2 write-path garde check)
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
) STRICT;

CREATE INDEX idx_runtime_bindings_run ON runtime_bindings(run_id);

-- Owner: Plan-003
-- Each conversation a session left on its provider: the one a fork moved it off,
-- or the one a daemon restart's resume forked away from. Written in the same
-- write as the binding's new resume_handle. The whole-session purge deletes every
-- row's conversation: a Codex conversation through the service's own
-- `thread/delete` once the thread is unloaded, a Claude Code transcript from the
-- account's config folder.
CREATE TABLE left_conversations (
  session_id           TEXT NOT NULL,
  provider_name          TEXT NOT NULL,           -- 'claude' or 'codex'
  provider_account_id  TEXT,                    -- NULL on the machine's default home
  conversation_id      TEXT NOT NULL            -- provider-owned, bounded as resume_handle is
                       CHECK (length(conversation_id) > 0 AND length(conversation_id) <= 4096 AND instr(conversation_id, char(0)) = 0),
  left_at              TEXT NOT NULL,
  PRIMARY KEY (provider_name, conversation_id)
) STRICT;

CREATE INDEX idx_left_conversations_session ON left_conversations(session_id);

-- Owner: Plan-003
CREATE TABLE driver_capabilities (
  provider_name       TEXT NOT NULL,
  capability_flag   TEXT NOT NULL
                    CHECK(capability_flag IN (
                      'resume', 'steer', 'interactiveRequests', 'mcp',
                      'toolCalls', 'reasoningStream', 'modelMutation',
                      'structuredOutput', 'rollback', 'sessionFork', 'sessionGoals',
                      'callbackTools', 'subagents', 'contextCompaction',
                      'providerCommands', 'outputSpeed'
                    )),
  supported         INTEGER NOT NULL DEFAULT 0
                    CHECK(supported IN (0, 1)),
                    -- The capability_flag CHECK lists every flag the capability union declares. Every provider_name holds one
                    -- row per flag, supported=0 where the driver does not declare it (undeclared = unsupported,
                    -- I-003-2), because the hydrator's exact-cardinality guard refuses a cache whose row count
                    -- differs from the union's.
  refreshed_at      TEXT NOT NULL,
  PRIMARY KEY (provider_name, capability_flag)
) STRICT;

-- Owner: Plan-003
-- Per-tool metadata, cached so Settings › MCP servers shows each tool's declared idempotency_class
-- without round-tripping the driver; recovery never branches on it (Spec-004 §Required Behavior). Normalized per-tool rows
-- mirror the per-flag-row shape of driver_capabilities.
CREATE TABLE driver_tools (
  provider_name        TEXT NOT NULL,
  tool_name          TEXT NOT NULL,
  idempotency_class  TEXT NOT NULL
                     CHECK(idempotency_class IN (
                       'idempotent', 'compensable', 'manualReconcileOnly'
                     )),
  description        TEXT,
  refreshed_at       TEXT NOT NULL,
  PRIMARY KEY (provider_name, tool_name)
) STRICT;

-- Owner: Plan-003
-- Per-driver capability-contract metadata. The capability cache is keyed by provider_name
-- (driver_capabilities + driver_tools are per-driver children); this parent row holds the
-- single per-driver contract_version so cold-start hydration can reconstruct
-- GetCapabilitiesResult = { capabilities: { flags, contractVersion }, tools } WITHOUT
-- round-tripping the driver (Spec-004 §Recovery Consequences cache-as-source-of-truth). Distinct from
-- runtime_bindings.contract_version, which records the version bound to a specific run.
-- Provider-output defense-in-depth CHECK (Plan-003 T2.1): `contract_version`
-- mirrors the `runtime_bindings.contract_version` bound (length + NUL-rejection,
-- 64-char ceiling). Semver-shape validation lives at the T2.4 write-path garde
-- check (the `semver` crate) — not expressible as a pure-SQLite CHECK.
-- `contract_version` is a CANONICAL, IDENTIFYING semver string: build metadata
-- (SemVer §10, non-identifying) is rejected by the T2.4 write-path garde check, so
-- two byte-different strings can never denote the same contract version (which
-- would otherwise report a changed capability snapshot on a non-change).
CREATE TABLE driver_contract_meta (
  provider_name         TEXT PRIMARY KEY,
  contract_version    TEXT NOT NULL             -- canonical, identifying semver of the driver's advertised capability contract (build metadata rejected by the T2.4 write-path garde check)
                      CHECK (length(contract_version) > 0 AND length(contract_version) <= 64 AND instr(contract_version, char(0)) = 0),
  cli_version_raw     TEXT                      -- cached `cliVersion.rawVersion` from the last capability refresh (Spec-004 §Required Behavior); NULL until the first refresh writes it
                      CHECK (cli_version_raw IS NULL OR (length(cli_version_raw) > 0 AND length(cli_version_raw) <= 128 AND instr(cli_version_raw, char(0)) = 0)),
  cli_version_semver  TEXT                      -- cached `cliVersion.parsedVersion`; NULL where the printed version does not parse. Cold-start hydration MUST treat a NULL `cli_version_raw` as a cache miss and refresh from the driver — the required `GetCapabilitiesResult.cliVersion` is never fabricated from cache
                      CHECK ((cli_version_raw IS NOT NULL OR cli_version_semver IS NULL) AND (cli_version_semver IS NULL OR (length(cli_version_semver) > 0 AND length(cli_version_semver) <= 64 AND instr(cli_version_semver, char(0)) = 0))),
  refreshed_at        TEXT NOT NULL             -- last contract-meta write: every capability-refresh write, plus the eventless cli_version pair-only currency refresh, so it may lead driver_capabilities.refreshed_at
) STRICT;
```

The build-metadata rejection above is grounded in the SemVer specification itself: per [Semantic Versioning 2.0.0 §10](https://semver.org/#spec-item-10), "Build metadata MUST be ignored when determining version precedence. Thus two versions that differ only in the build metadata, have the same precedence." Because `1.2.3+build.5` and `1.2.3+build.6` denote the SAME contract version under that precedence rule, persisting them as byte-distinct `contract_version` strings would let a non-change masquerade as a change. The shared write-path garde check (`assertValidContractVersion`, invoked from both the T2.2 `runtime_bindings` and T2.4 `driver_contract_meta` write paths) therefore REJECTS — rather than strips/normalizes — any value carrying build metadata, keeping the stored value byte-identical to what was validated and both `contract_version` columns canonical-identifying.

**Cloud tasks.** `cloud_tasks` holds one row per task a session sent to its provider's own cloud (`cloud.task.start`), read by `cloud.task.subscribe` and `cloud.task.read`. Each row belongs to its session and records the task's state exactly as the provider last reported it, never a state the daemon inferred: on Codex `pending`, `ready`, `applied` or `error`, and on Claude Code `submitted` for the task's whole life, because Claude Code's command line reports no later state. Each row also keeps the task's environment label, from which [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.31 reads the project's last Codex environment back. [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) owns the row's columns.

---

## Daemon Configuration (Plan-005)

The service's machine-wide configuration and its two retention bounds, read by the daemon's own modules and changed over the wire only through `daemon.config.read`, `daemon.config.update`, `daemon.retention.read` and `daemon.retention.update` ([Plan-005](../../plans/005-local-ipc-and-daemon-control.md) T-005r-1-9 and T-005r-1-10). A `NULL` is the setting's own unbounded state: `No limit`, `Never ask`, `Unlimited` or no cap. The row is written whole when the store is created: the listener port starts at the daemon's one default constant ([Workflow Graph Model §Entry node and the V1 trigger surface (SA-34)](../../domain/workflow-graph-model.md#entry-node-and-the-v1-trigger-surface-sa-34)), and every other column at its default or `NULL`.

```sql
-- Owner: Plan-005
-- One row, written whole when the store is created; each update changes one value.
CREATE TABLE daemon_configuration (
  singleton                      INTEGER PRIMARY KEY CHECK (singleton = 1),
  keep_diagnostic_logs_days      INTEGER NOT NULL DEFAULT 7 CHECK (keep_diagnostic_logs_days >= 1),
  keep_sessions_days             INTEGER NOT NULL DEFAULT 90 CHECK (keep_sessions_days >= 1),
  -- Created at the daemon's one default listener port, a constant chosen from a range no common
  -- developer tool uses, never a free port picked when the row is written.
  workflow_listener_port         INTEGER NOT NULL CHECK (workflow_listener_port BETWEEN 1 AND 65535),
  run_time_limit_minutes         INTEGER CHECK (run_time_limit_minutes IN (30, 60, 240, 720, 1440)),
  workflow_chain_ask_after_runs  INTEGER DEFAULT 100
                                 CHECK (workflow_chain_ask_after_runs IN (25, 100, 500, 2000)),
  max_steps_per_turn             INTEGER CHECK (max_steps_per_turn >= 1),
  spend_limit_usd_micros         INTEGER CHECK (spend_limit_usd_micros >= 0),
  tokens_per_run                 INTEGER CHECK (tokens_per_run >= 1),
  tool_memory_cap_bytes          INTEGER CHECK (tool_memory_cap_bytes >= 1),
  package_cache_limit_bytes      INTEGER CHECK (package_cache_limit_bytes >= 1),
  record_traces                  INTEGER NOT NULL DEFAULT 0 CHECK (record_traces IN (0, 1)),
  record_provider_messages       INTEGER NOT NULL DEFAULT 0 CHECK (record_provider_messages IN (0, 1))
) STRICT;
```

---

## Artifact Tables (Plan-011)

```sql
-- Owner: Plan-011
CREATE TABLE artifact_manifests (
  id                 TEXT PRIMARY KEY,             -- UUIDv7, minted by the daemon
  session_id         TEXT NOT NULL,
  run_id             TEXT,
  -- The device the request that made it came from; NULL for an artifact the daemon produced.
  created_by         TEXT,
  -- A client's publish's own key, so a resent publish answers this manifest; NULL otherwise.
  client_idempotency_key TEXT,
  artifact_type      TEXT NOT NULL
                     CHECK(artifact_type IN ('file', 'diff', 'summary', 'log', 'design',
                                             'workflowOutput')),
  content_hash       TEXT NOT NULL,                -- the payload's SHA-256, 'sha256:<hex>'
  size_bytes         INTEGER NOT NULL,             -- the payload's length, measured by the daemon
  metadata           TEXT NOT NULL DEFAULT '{}',   -- JSON: the file name and the media type
  -- A chat's file or folder: its path in the managed workspace; NULL for every other artifact.
  workspace_path     TEXT,
  -- Counts from 1 within (session_id, workspace_path); 1 for every other artifact.
  version_number     INTEGER NOT NULL DEFAULT 1 CHECK(version_number >= 1),
  plan_id            TEXT,                         -- the plan record whose text this is; NULL otherwise
  created_at         TEXT NOT NULL                 -- RFC 3339 UTC, ms precision
) STRICT;

CREATE INDEX idx_artifact_manifests_session ON artifact_manifests(session_id);
CREATE INDEX idx_artifact_manifests_run ON artifact_manifests(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_artifact_manifests_hash ON artifact_manifests(content_hash);
-- SQLite treats each NULL as distinct, so only a client's publishes dedupe.
CREATE UNIQUE INDEX idx_artifact_manifests_client_idempotency_key
  ON artifact_manifests(session_id, client_idempotency_key);
CREATE UNIQUE INDEX idx_artifact_manifests_path_version
  ON artifact_manifests(session_id, workspace_path, version_number) WHERE workspace_path IS NOT NULL;
CREATE INDEX idx_artifact_manifests_plan ON artifact_manifests(plan_id) WHERE plan_id IS NOT NULL;

-- Owner: Plan-011
-- Where a manifest's payload is stored. Written in the manifest's own transaction, after it.
CREATE TABLE artifact_payload_refs (
  id              TEXT PRIMARY KEY,
  manifest_id     TEXT NOT NULL REFERENCES artifact_manifests(id),
  storage_path    TEXT NOT NULL,                  -- the content store's key
  media_type      TEXT NOT NULL,                  -- read from the payload's bytes
  size_bytes      INTEGER NOT NULL,
  pixel_width     INTEGER,                        -- read from a picture's header at ingest, EXIF
  pixel_height    INTEGER,                        -- orientation applied; NULL unless the bytes are a picture
  created_at      TEXT NOT NULL                   -- RFC 3339 UTC, ms precision
) STRICT;

CREATE INDEX idx_artifact_payload_refs_manifest ON artifact_payload_refs(manifest_id);
-- How many references name a storage key is counted on every reclaim decision.
CREATE INDEX idx_artifact_payload_refs_storage_path ON artifact_payload_refs(storage_path);
```

> **The OCI manifest envelope.** `artifact_manifests.size_bytes` (OCI manifest-descriptor `size`) realizes the OCI envelope per D-011-1. An artifact is never changed in place: no manifest or payload-ref row is ever updated. A chat's file or folder is the group of manifests sharing `(session_id, workspace_path)`, each write a new manifest with the group's next `version_number`; a folder is one manifest at its creation, of media type `inode/directory` over the empty payload, so it keeps both `NOT NULL` columns. A plan is one manifest per `plan.proposed`, `plan_id` set, and its word lives on the plan record (`plans`, §Approval Tables), which the list joins; a fresh session's seed plan is a second manifest in that session over the same bytes. **`content_hash`/`size_bytes` are `NOT NULL`:** a content-addressed manifest's `digest` is intrinsic to its identity (I-011-1), and each producer (Plan-011 Task 2 `artifact.ingest.*`, Task 3 ArtifactPublish) computes the SHA-256 + byte length from its own payload and inserts its manifest with both columns set in the same transaction as the payload-ref — the two are independent producers, each writing its own manifest (so the `artifactId` `artifact.ingest.*` returns resolves from the ingest-written manifest, not a later publish), so neither is ever NULL and no payload-less manifest is ever read — this is 1:1 with the **required** `digest`/`size` fields on the `ArtifactManifest` wire shape ([api-payload-contracts.md](../contracts/api-payload-contracts.md)). The file name lives in `metadata`, which the wire carries as `ArtifactManifest.metadata`.

---

## Approval Tables (Plan-009)

The canonical approval categories: `toolExecution`, `fileWrite`, `networkAccess`, `destructiveGit`, `gate`. A plan, a question and a tool server's own MCP elicitation are not approvals: a plan is one `plan.proposed` record answered by `plan.resolve`, and a question or elicitation is one `question.asked` record answered by `question.resolve`, outside the approval pipeline. Codex's own approval of a tool-server call, an elicitation marked `_meta.codex_approval_kind: "mcp_tool_call"`, is a `toolExecution` approval.

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
                          'toolExecution', 'fileWrite', 'networkAccess', 'destructiveGit',
                          'gate'                                                  -- mirrors Spec-010 canonical enum
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
                                              -- answered. Moving the session's permission level leaves an open
                                              -- request pending for the person; only the person's answer lands
                                              -- 'approved' or 'rejected', and only an interrupt or any other end of
                                              -- its run and the provider process ending land 'canceled'. Nothing on
                                              -- this table is left for a sweep to settle and silence is never read
                                              -- as either a grant or a denial (Spec-010 §Required Behavior)
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL         -- last state-transition instant (a cancel carries no resolution row)
) STRICT;

CREATE INDEX idx_approval_requests_run ON approval_requests(run_id);
CREATE INDEX idx_approval_requests_session ON approval_requests(session_id);
CREATE INDEX idx_approval_requests_state ON approval_requests(state) WHERE state = 'pending';
CREATE UNIQUE INDEX idx_approval_requests_ask ON approval_requests(run_id, ask_id) WHERE ask_id IS NOT NULL;
-- UNIQUE (run_id, ask_id): one approval row per ask id. The daemon mints the id once for each
-- provider ask it takes, and a provider ask delivered again while it is held is matched to the held
-- one in memory, so no second row is minted for it (Spec-010 one ask↔one approval)

-- Owner: Plan-009
CREATE TABLE approval_resolutions (
  request_id               TEXT PRIMARY KEY REFERENCES approval_requests(id),
                                              -- PK = the durable wire id (approvalRequestId): enforces the 1:1 decision row
                                              -- and keeps every column event-derivable for a rebuild here or on a peer (I-009-9).
                                              -- The first answer from any device settles the request.
  device_id                TEXT NOT NULL,     -- the answering device, the one whose connection carried the answer; a card
                                              -- answered elsewhere reads it as `Answered on <device>` (Spec-027 §Required Behavior)
  client_resolution_id     TEXT NOT NULL,     -- minted by the answering client and echoed on the resolution event; the same
                                              -- id sent again is answered with this row, any other answer is refused
  decision                 TEXT NOT NULL
                           CHECK(decision IN ('approved', 'rejected')),
  effective_scope          TEXT NOT NULL,     -- granted scope; = request scope unless the answer narrowed it (Spec-010 §Required Behavior);
                                              -- never broader than requested (domain invariant; Phase-2 enforced)
  remembered_scope_kind    TEXT               -- 'session' | 'project' when the answer made a rule, written with the rule's own
                                              -- record once its provider kept it; NULL for a one-time answer and for a rule
                                              -- its provider did not keep (Spec-010 §Interfaces And Contracts)
                           CHECK(remembered_scope_kind IS NULL OR remembered_scope_kind IN ('session', 'project')),
  remembered_scope_pattern TEXT,              -- the derived subject of that rule, nullable
  edited_action            TEXT,              -- the command or path as the person corrected it on the card, which is what
                                              -- runs (approval.approved.editedAction); NULL for an answer that changed
                                              -- nothing and for every decline
  resolved_at              TEXT NOT NULL,
  CHECK((remembered_scope_kind IS NULL) = (remembered_scope_pattern IS NULL)), -- a rule names its subject
  CHECK(edited_action IS NULL OR decision = 'approved')
) STRICT;

-- Owner: Plan-009
CREATE TABLE approval_correction_uses (
  request_id   TEXT PRIMARY KEY,              -- the approved card whose corrected command or path its provider's next ask
                                              -- carried out, one row each, so the correction runs once, across a restart too.
                                              -- No REFERENCES: the requests are rebuilt from the log, and this row outlives
                                              -- a rebuild; a session purge deletes it
  session_id   TEXT NOT NULL,
  used_at      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_approval_correction_uses_session ON approval_correction_uses(session_id);

-- Owner: Plan-009
CREATE TABLE reviewer_denials (
  denial_id        TEXT PRIMARY KEY,          -- the denialId its approval.reviewer.denied names
  session_id       TEXT NOT NULL,
  provider_denial  TEXT NOT NULL              -- JSON: the provider's own record of the block, whole, written in the
                                              -- block's approval.reviewer.denied write; `Allow once` hands it back from here
) STRICT;

CREATE INDEX idx_reviewer_denials_session ON reviewer_denials(session_id);

-- Owner: Plan-009
-- The plan record, rebuilt from plan.proposed, plan.accepted, plan.handedOff, plan.kept and
-- plan.hold.ended. The plan's artifact is never changed; its state word is read here.
CREATE TABLE plans (
  id                TEXT PRIMARY KEY,  -- PlanId
  session_id        TEXT NOT NULL,     -- the planning session
  run_id            TEXT NOT NULL,
  artifact_id       TEXT NOT NULL REFERENCES artifact_manifests(id),
  title             TEXT NOT NULL,     -- the plan's first heading
  holds_request     INTEGER NOT NULL CHECK(holds_request IN (0, 1)), -- a held provider request waits on the verdict
  state             TEXT NOT NULL DEFAULT 'waiting'
                    CHECK(state IN ('waiting', 'accepted', 'handedOff', 'open')),
  fresh_session_id  TEXT,              -- set exactly when state = 'handedOff'
  resolved_by       TEXT,              -- the device whose verdict landed; NULL while pending and after plan.hold.ended
  resolved_at       TEXT,
  created_at        TEXT NOT NULL,
  CHECK((state = 'handedOff') = (fresh_session_id IS NOT NULL))
) STRICT;

CREATE INDEX idx_plans_session ON plans(session_id);
CREATE INDEX idx_plans_fresh_session ON plans(fresh_session_id) WHERE fresh_session_id IS NOT NULL;
-- A run's end reads the plans it still holds.
CREATE INDEX idx_plans_waiting_run ON plans(run_id) WHERE state = 'waiting';

-- Owner: Plan-010
-- The question record, rebuilt from question.asked, question.canceled, the user.message.sent that
-- answers it and the admission of a queued answer. Its pages stay in its question.asked event,
-- read from there when an answer is checked; a secret answer is stored nowhere.
CREATE TABLE questions (
  id                TEXT PRIMARY KEY,  -- QuestionId
  session_id        TEXT NOT NULL,
  run_id            TEXT,              -- the run that holds it, or
  wait_id           TEXT,              -- the workflow wait that holds it
  is_agent_waiting  INTEGER NOT NULL CHECK(is_agent_waiting IN (0, 1)), -- 0: a queued message answers it
  state             TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open', 'answered', 'canceled')),
  CHECK((run_id IS NULL) <> (wait_id IS NULL))
) STRICT;

CREATE INDEX idx_questions_session ON questions(session_id);
CREATE INDEX idx_questions_open_run ON questions(run_id) WHERE state = 'open';

-- Owner: Plan-010
-- Each queued message answering a question its agent does not wait for: inserted by the
-- user.message.sent naming it, deleted when the item is canceled or superseded; the item's
-- agent.queueItem.admitted answers the question and deletes every pairing of it, so of two
-- devices answering at once the first admitted wins.
CREATE TABLE question_answer_items (
  queue_item_id  TEXT PRIMARY KEY,
  question_id    TEXT NOT NULL REFERENCES questions(id)
) STRICT;

CREATE INDEX idx_question_answer_items_question ON question_answer_items(question_id);
```

The daemon keeps no table of approval rules: the providers keep them ([Spec-010 §Default Behavior](../../specs/010-approvals-permissions-and-trust-boundaries.md#default-behavior)), and a session's own answers are its `approval_resolutions` rows and its `approval.rule.remembered` and `approval.rule.revoked` events, which the inspector's `Rules` reads beside the providers' own rules.

---

## Credential Policy Reference (Plan-009)

A run's `executionPosture.credentialPolicyRef` is a plain reference naming the credential deny list the daemon handed the provider for that run ([Spec-010 §Required Behavior](../../specs/010-approvals-permissions-and-trust-boundaries.md#required-behavior) posture semantics). It rides the `agent.run.running` posture in `session_events` and needs no table of its own: deleting a session deletes it with the session's rows.

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
) STRICT;

-- Owner: Plan-012. The sessions a restart rebuilds: every session with events
-- has a cursor, written with each event, so only one not current needs a rebuild.
CREATE INDEX idx_projection_cursors_not_current ON projection_cursors(session_id)
  WHERE state <> 'current';

-- Owner: Plan-012
CREATE TABLE recovery_checkpoints (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  checkpoint_type TEXT NOT NULL,              -- e.g. 'full', 'incremental'
  as_of_sequence  INTEGER NOT NULL,
  state_blob      BLOB NOT NULL,
  created_at      TEXT NOT NULL
) STRICT;

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
) STRICT;

-- One live record per folder; an orphaned record keeps its last path without holding the folder.
CREATE UNIQUE INDEX idx_skill_records_folder ON skill_records(folder_path) WHERE orphaned = 0;
```

## Attention Delivery State (Plan-016)

The attention service's entries carry the state its two deliveries beyond the app need to survive a service restart ([Spec-017 §Cross-Device Delivery](../../specs/017-notifications-and-attention-model.md#cross-device-delivery)). No table here holds a mail password, a web address or its signing secret: each is kept as its own item in the operating system's credential store and never written to a column, a reply, an event, a log or an error ([ADR-036](../../decisions/036-workflow-secrets-in-the-os-keychain.md)).

- **Each attention entry** carries a nullable `digested_at`, the instant the entry went out in an email digest, so no entry is listed twice and the digest's one timer is restored from it at start; and a nullable `web_address_state` (`pending`, `delivered` or `undelivered`) with its attempt count, so a retry to the web address survives a restart. Both live as long as the entry.
- **Each delivery channel** — the web address and the email digest — keeps one outcome row: when the last attempt ran, its result (`delivered`, `refused`, `unreachable`, `timedOut`, `signInRefused`, `notEncrypted` or `notAnAddress`), the HTTP status where there was one, and how many moments are undelivered. The row is overwritten on each attempt and removed with the channel's secret; `attention.delivery.list` returns it.
- **The session row's `muted_at`** ([Session Tables §Session Directory](local-sqlite-session-tables.md#session-directory-plan-001)) keeps a muted session's `Finished` and `Failed` moments out of both channels.
- **Each push to another device** keeps a `push_deliveries` row, its device one of `trusted_devices` ([Remote Control Tables §The Account's Devices](local-sqlite-remote-control-tables.md#the-accounts-devices)).

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
) STRICT;
```
