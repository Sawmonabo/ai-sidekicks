# Spec-013: Persistence And Recovery

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `013` |
| **Slug** | `persistence-and-recovery` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Data Architecture](../architecture/data-architecture.md), [Run State Machine](../domain/run-state-machine.md), [Session Event Taxonomy And Audit Log](../specs/005-session-event-taxonomy-and-audit-log.md) |
| **Implementation Plan** | [Plan-012: Persistence And Recovery](../plans/012-persistence-and-recovery.md) |

## Purpose

Define the persistence contract that allows restart recovery, rebuilds, and durable local execution truth.

## Scope

This spec covers local persistence, shared coordination persistence, recovery rules, and rebuild expectations.

## Non-Goals

- Full operations procedures
- Detailed schema design
- Provider-driver internal persistence formats

## Domain Dependencies

- [Session Model](../domain/session-model.md)
- [Run State Machine](../domain/run-state-machine.md)
- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)

## Architectural Dependencies

- [Data Architecture](../architecture/data-architecture.md)
- [Observability Architecture](../architecture/observability-architecture.md)
- [ADR-003: Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)
- [ADR-004: SQLite Local State And Postgres Control Plane](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)

## Required Behavior

- Each runtime node must persist canonical local execution state in a durable local store.
- The default local execution store must be SQLite with WAL and foreign keys enabled.
- The default shared control-plane store must be Postgres or an equivalent relational store.
- Canonical local execution data must include session events, queue state, approvals, runtime bindings, command receipts, and the file checkpoints a restore reads from.
- **The daemon keeps a file checkpoint store per session.** Before the agent or any of its children edits a file — `Write`, `Edit`, `MultiEdit` and `NotebookEdit` on Claude Code, `apply_patch` on Codex — and at every prompt that starts a turn, the daemon copies that file aside as it was, one copy per content version, through the pre-tool hook it registers to hold a run for a pause: one mechanism, never a second interception path. A file created since the checkpoint is recorded as new and removed on undo. The copies are held with the session **outside the checkout**, so they never appear in a diff and survive a working-folder move; a chat's managed workspace is its checkout, so a chat's copies sit outside that workspace too. Every checkpoint of a session is kept for the session's life, removed only by an undo or by deleting the session or its data, and the checkpoints survive a resume and a restart. They are the only thing a file restore reads from, on every provider. A checkpoint copy holds an edit at most 5 ms at the 99th percentile for a file up to 1 MiB, on a 5,000-file checkout and a session of up to 10,000 edits over 1,700 files, and a turn-boundary snapshot takes at most 150 ms, from a copy of the index, at the turn boundary only. The copies are part of the session's own data: they are deleted whole when the session is purged and retained when it is archived, as a chat's managed workspace is ([Spec-001 §Required Behavior](./001-session-core.md#required-behavior)), and provable destruction of their contents is never claimed.
- **What a shell command writes is inside the store, on both providers.** Around every command an agent or any of its children runs, the daemon captures the working folder twice, itself and outside every sandbox: before the command starts, holding the start until the capture is written, and when it ends, holding nothing. On Claude Code the daemon's command wrapper runs as `CLAUDE_CODE_SHELL_PREFIX`, after Claude Code's permission decision: it signals `starting`, waits for `go`, which the daemon answers once the before-capture is written, and signals `exited` with the exit code as it exits. On Codex the daemon's relay in front of `codex exec-server` holds an approved `process/start` until the before-capture is written and forwards `process/exited` at once. A command an agent types into one of the session's shells is captured by the daemon itself, before it writes the command, holding the write until the capture is written, and at the command's end mark. Every path that differs between the two captures enters the store as an ordinary copy under the checkpoint of the prompt that started the turn — its content before the command, or, for a file the command created, a record that it is new and is removed on undo — so the dry run, the restore and the skip rules hold unchanged for both legs. For each path changed after a point, the earliest version recorded after that point supplies its content, whichever leg recorded it. A capture that fails, or a service that does not acknowledge `starting` within 10 s, lets the command run uncovered; the wait counts against the Bash call's own timeout, so a 5 s timeout moves the command to the background. The dry run names such a command `ran while the service could not capture it`. Budget: before a command, at most 125 ms median (200 ms at the 99th percentile) on a 5,000-file checkout and at most 350 ms median (450 ms at the 99th percentile) on 50,000 files; after it, about 1.2 ms per changed file, off the agent's path.
- **Every git capture lives in its owner's capture folder, never the person's `.git`.** Each owner — a session, or a workflow run — has one capture folder, and the per-command captures, the turn snapshots and a workflow run's points are written into it, with their refs inside it. A capture is a git tree written from the owner's scratch index, seeded once from a copy of the repository's own index and kept between captures so only what changed is hashed, with only `GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY` set, so every object it writes lands in the folder; diffs and before-images read it with the repository's objects as an alternate. At the owner's first capture, and at any capture whose HEAD moved since the previous one, the objects HEAD's tree lacks are packed into the folder, so a `git gc` in the repository never takes one. Each kept point pins the person's own commit it stood on under `refs/sidekicks/base/<owner id>/` in the repository, one ref per distinct commit; nothing else is written into the person's `.git`. The service's hourly sweep, and a bulk delete, repack each folder from its own objects only, never on the edit or the turn path, and the owner's purge deletes the folder and its pins. The recipe is [Spec-008 §Turn-Boundary Snapshots](./008-worktree-lifecycle-and-execution-modes.md#turn-boundary-snapshots)'s.
- **Large files and ignored folders.** A file over 10 MiB is never hashed into a capture: the daemon keeps a copy-on-write clone of it, which takes no space until the file changes, and at a command's after-capture a large file whose size or times changed has that clone as its store copy. On a volume that cannot clone (ext4, NTFS), a large file a command changed is never copied and is named `too large to keep`, so no command waits on a large copy. Folders the project ignores are never put back by an ordinary undo; the dry run names them instead. Files a command wrote outside the working folder or inside a submodule are not put back, and the dry run says so.
- **Two sessions in one folder keep their changes apart.** Captures of one working folder run one at a time, across every session working in it, so no command starts inside another's capture. An undo puts back only what its own session changed — its edit tools' copies and its own commands' windows. A path in that set that another session also changed since the point is named `also changed by <session>` and left as it is unless the person includes it; a path only the other session changed never enters the undo.
- **The conversation half of an undo is the provider's own cut.** A point before the conversation's last compaction is undone the same way as any other point, and the undo holds after a restart; how the daemon gets there on each provider stays inside the daemon, the session keeps its identity, and nothing on the screen names a provider session, a copy or a restart ([Spec-003 §Driver-Level Rollback Mechanics](./003-queue-steer-pause-resume.md#driver-level-rollback-mechanics)). A turn too long to fit even after compaction is cut at once with the same verb — `rewind_conversation` on Claude Code, `thread/revert` on Codex — and handed back as a failed send.
- Restart recovery must attempt:
  1. projection rebuild from canonical events
  2. restoration of runtime bindings
  3. resumption or explicit failure transition for in-flight runs
- A rebuild must be possible without client memory or ad hoc transcript reconstruction.
- The daemon never waits for a screen. A screen that falls behind is dropped for, and the next frame that fits tells it so; it repairs from the daemon's record by cursor, and past a gap of 1,024 events by a snapshot read. Once a screen that fell behind has caught up on its queue, the daemon sends it one frame with no changes, carrying the drop mark and the newest cursor, so a session that goes quiet right after a drop still tells the screen it is behind.

## Default Behavior

- Local mutable operations are blocked if the local durable store is unavailable.
- Recovery runs automatically on daemon startup before new mutable work is accepted.
- Recovery prefers adopting existing live provider sessions where possible before using stored resume handles.
- Projection reconstruction completes strictly before any provider-facing action: daemon startup finishes rebuilding a session's read state from the local log — and the recovery classification that depends on it — before any resume, reconciliation probe, or driver dispatch consumes that state, and the session takes no write until then; acting on a partially reconstructed projection is the ordering fault this gate closes.

## Fallback Behavior

- If a persisted driver handle cannot be resumed, the affected run must transition to `failed` with visible recovery failure detail rather than silently disappearing or restarting as a new run.
- On a resume that succeeds (`DriverResumeResult.status: 'resumed'` — a resume that fails follows the preceding bullet), the driver-reported normalized `sessionPosition` ([Spec-004 §Fallback Behavior](004-provider-driver-contract-and-capabilities.md#fallback-behavior)) is compared against the daemon's recorded position, and nothing is decided on the person's behalf except the read-only case. **They agree:** the session continues. **The provider is ahead** — its record holds turns or tool calls the daemon never wrote down: the daemon reads the missing part from the provider's own record (Claude Code's session file; Codex's `thread/turns/list` and `thread/items/list`) and checks whether it only read. A part that only read is added to the transcript as the provider recorded it and the session continues, with one faint row, `Added 2 steps from Claude Code's record after the restart`, recorded as `run.recovery_steps_added {count, provider}` so it survives a reload. Any other part, one whose content cannot be read included, halts the run in `waiting_for_input` with a `recovery-needed` `RecoveryCondition`, under the added rows, on one question, `Claude Code did more than this session recorded before the restart.`, with two choices: `Keep what it did` adds the rows and keeps the files it changed; `Undo to before it` cuts the conversation at the last point both records agree on, through the provider's own cut (Codex's `thread/revert`, Claude Code's `rewind_conversation`, or the fork and restart past a compaction), and restores the files from the checkpoint store for that point. **The daemon is ahead** — the provider's record is missing turns the daemon holds: the run halts on `Claude Code's record is missing the last 3 turns.`, with two choices: `Continue from Claude Code's record` keeps the daemon's extra rows visible, marked `not in the agent's context`; `Continue with a hand-over` opens a new conversation with the hand-over brief, the provider switch's own path. On Codex every line reads `Codex` in the provider's place. The choice goes back as `run.recoveryResolve` and is recorded as `run.recovery_resolved`. The halt surfaces on the existing owner-visible channels — the run's own `waiting_for_input` state carrying `recovery-needed` and its one question, read over the run-state subscription ([Spec-003](003-queue-steer-pause-resume.md)) and answered through `run.recoveryResolve`, and the `blocked` recovery state on `daemon.status.read` (§Interfaces And Contracts) — never a new notification surface. In the session the question is drawn as a waiting card where the run stopped, the way an approval card is, with its question and two choices in the words above, and the run takes an entry in the attention list, in amber because a person is needed. The daemon's log stays authoritative ([ADR-016](../decisions/016-shared-event-sourcing-scope.md)): provider steps enter it only as rows the daemon appends, the daemon never silently re-emits locally recorded events into the provider session, never silently discards provider-side events, and never replays a crashed run into a fresh session.
- If an undo has to skip a file, the dry run names the count before anything moves and says which file and why — a symbolic link, a hard link, something that is not a file, a file whose folder moved, `too large to keep`, or `changed by a git command that moved the branch`, a file a command changed while HEAD moved, which put back against the moved branch would turn its commits into uncommitted reversals — and the rest are still put back. A skip is never silent and never cancels the undo. Whenever a command ran after the point, the dry run also carries two lines: `Folders the project ignores are not put back: <folders>.` and `Files a command wrote outside this worktree or inside a submodule are not put back.`
- **Damaged history heals first and never stops the rest of the app.** After a restart, a session whose stored history cannot be rebuilt is repaired before anything is given up: the daemon copies the database and its write-ahead log aside untouched, rebuilds that session's projection again from its events, and, where the file itself is damaged, recovers it into a fresh file with SQLite's own recovery (`sqlite3_recover`), checking the result with `PRAGMA integrity_check` before using it. Where the person keeps backups (§Backup Policy), a session the newest backup holds more readable events of takes its events from that backup instead; with no backup, or one that cannot be read, the recovery alone heals it. The service checks the file's structure with `PRAGMA quick_check` at every start but a new file's, off the main thread. After a clean stop that left the file as it was, or any run that ended without one, a crash of the machine or a power loss included, it opens at once and checks beside its work, since SQLite keeps every committed transaction across a crash and the service's checkpoints flush the drive; a file something else changed since a clean stop, or with no record of the last run, holds every write until the check finds it sound. A check that cannot run never fails a working service: writes go, the service reads as degraded with the reason in its log, and its next start checks again before it writes. While a damaged file is repaired the service answers that it is repairing, with how many of the damaged file's session events it has recovered while it can count them, and the app waits for it. Damage the check or any read or write meets stops the service, and its next start repairs the file before anything opens it. A file the recovery cannot heal is left as it is, never written, and the service does not start; its log names why and where the copy is. The same damage is copied aside once, however many starts meet it.
- **A session whose event still cannot be read opens at its last good point** — every event before the first damaged one — read-only, with one line at the top of its conversation, `History after <time> is damaged. This session shows everything up to it.`, and two actions: `Continue from here`, which makes that point the session's end so it takes new work again, and `Delete session`. The damaged events are kept aside with the copy, never deleted by the repair. `Continue from here` rewrites nothing: it appends one event at the log's next sequence naming the damaged range, and every read and every rebuild of the session skips that range from then on, so the damaged rows stay where they are as the quarantine ([ADR-016](../decisions/016-shared-event-sourcing-scope.md)).
- **A session with no readable event at all** shows in the list as `Damaged` with `Delete session` only.
- **Only that session refuses writes;** every other session and the rest of the app keep working, and Settings › Runtime names each damaged session. The whole service refuses writes only until the restart's recovery pass has listed the sessions it must rebuild, a write that names no session (a project's, a folder's or a worktree's, which can reach any session) until the pass ends, and every write while the local store is unavailable (§Default Behavior); a session the pass is still rebuilding refuses every write but the pass's own until it is rebuilt and the runs the restart left are settled, while every other session takes its writes.
- If shared control-plane storage is unavailable, local execution may continue for the machine's sessions, but operations that write shared control-plane state must fail explicitly.

## Interfaces And Contracts

- The node's recovery state — healthy, rebuilding, degraded, or blocked — is a `recovery` field on `daemon.status.read`, which Settings › Runtime and `sidekicks daemon status` already call; there is no separate recovery read. Its session list names each damaged session: `degraded` with its last good point (the last readable event's sequence and time, and the first damaged sequence), or `damaged` when no event of it can be read. A write to such a session, or to one the pass is still rebuilding, is refused `session.write_refused`; a write before the pass has listed what it rebuilds, one that names no session while the pass runs, or any while the store is unavailable, is refused `daemon.write_refused`.
- **The two actions on a damaged session** are `session.recoveryContinue {sessionId}` (`Continue from here`), which appends `recovery.damaged_events_skipped {sessionId, fromSequence, toSequence}` and rebuilds the session from what is left, and `session.recoveryDelete {sessionId}` (`Delete session`), which deletes the session's data whole. Each is refused `session.recovery_refused` for a session that is not damaged, and `Continue from here` also for one with no readable event.
- `EventsReadAfterSequence` must read authoritative events after a known sequence position.
- `ProjectionRebuild` must be idempotent.
- `RuntimeBindingRead` must expose the data needed to attempt session adoption or resume.
- **The dry run is `session.restorePreview`, and it answers before any undo happens.** It takes the undo's own request — the session, a `target` that is a message's stable identity or a snapshot's, never a numeric or provider position, and a `scope` — and changes nothing. Its answer carries the files the undo would put back and the lines across them, every file it would skip with its reason (§Fallback Behavior), the agents started after the point that would stop, the commands still running that the undo would stop, the ignored folders it will not put back, whether any command ran after the point, each command after the point that ran uncovered, named `ran while the service could not capture it`, and the paths another session working in the same folder also changed since the point. The screen draws it as a count — `Put back 3 files · 41 lines · 1 skipped` — each skipped file and its reason in the count's hover title; when it finds no file to put back, the screen draws no count. No undo runs without one.
- **A checkpoint holds one copy per content version of a file, and a file created since the checkpoint is recorded as new.** The dry run names such a file as one the undo will remove, and the undo removes it, so the working folder after an undo holds what it held at that point and nothing the agent added since.
- **The undo is `session.restore`, in one of its scopes, addressed by a message or by a snapshot**: `conversation-and-files` (`Undo to here`, and `Restore conversation and files` in the rewind menu), `conversation` and `files`; [Spec-003 §Interfaces And Contracts](./003-queue-steer-pause-resume.md#interfaces-and-contracts) owns its request and its result. The conversation cut is the bound provider's own rewind verb — neither of which touches a file ([Spec-003 §Driver-Level Rollback Mechanics](./003-queue-steer-pause-resume.md#driver-level-rollback-mechanics)) — and the files are always the file checkpoint store of §Required Behavior — a different thing from this spec's write-ahead-log checkpointing, which is about the local store's own durability — on both providers, so the two halves are never confused for one another. An undo aimed at a snapshot reads from this same store, the snapshot naming the point to return to ([Spec-008 §Turn-Boundary Snapshots](./008-worktree-lifecycle-and-execution-modes.md#turn-boundary-snapshots)); `session.snapshotList` lists a session's snapshots from its capture folder, one git read per inspector open. An undo that would stop agents or commands started after its target asks first, on the terms [Spec-003 §Required Behavior](./003-queue-steer-pause-resume.md#required-behavior) sets out, which owns that question for every undo and for the pencil's resend alike; it stops those commands, takes their after-captures, and then restores.
- **An undo reports what it did as one row.** Every outcome is one stored event, `session.restore_finished`, carrying what applied and the cause of what did not; `run.rolled_back` records the conversation cut alone. When every part asked for applied, the row reads `Restored to before <the message's first words>`, `Restored to <snapshot name>`, or `Files restored to before <…>` for files alone. When part applied, the row names the part that did and the part that did not with its cause — `Restored to before <…> · files not restored · <cause>` or `Files restored to before <…> · conversation not restored · <cause>` (`Restored to <snapshot name>` and `Files restored to <snapshot name>` for a snapshot). When nothing applied, it reads `Undo failed · <cause>`, and the conversation and the files are as they were. The turns after the point stay in the transcript marked superseded only when the conversation went back ([Spec-011 §Required Behavior](./011-transcript-and-reasoning.md#required-behavior)); the cause is the daemon's own, in words.
- **Recovery after a restart:** `run.recoveryResolve {runId, choice: keep_provider | undo_to_agreed | continue_provider | hand_over}` carries the person's answer to §Fallback Behavior's question and is recorded as `run.recovery_resolved`; a read-only surplus added with no question is recorded as `run.recovery_steps_added {count, provider}`.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## Idempotency Protocol

A side-effecting tool call must not execute twice, and a restart re-executes none. The daemon records each through a **two-phase command receipt**: `accept` → `execute` → terminal-status, with each phase committed in its own SQLite transaction. A tool call is uniquely identified by `command_id`.

### Two-Phase Receipt Commit

```sql
-- Phase 1: accept (one transaction)
BEGIN;
  INSERT INTO command_receipts
    (id, command_id, run_id, status, created_at)
    VALUES (?, ?, ?, 'accepted', now());
COMMIT;

-- Phase 2: execute (one transaction, optimistic compare-and-set)
BEGIN;
  UPDATE command_receipts
    SET started_at = now()
    WHERE id = ? AND started_at IS NULL;
  -- rowcount = 1 → this worker owns the execution; rowcount = 0 → another worker
  -- already claimed the receipt, abort this attempt without invoking the tool.
COMMIT;
-- side-effecting tool call happens here, outside any DB transaction

-- Phase 3: terminal-status (one transaction)
BEGIN;
  UPDATE command_receipts
    SET status = ?, completed_at = now()
    WHERE id = ?;
  -- status ∈ {'completed','failed'}; 'rejected' is only set at accept-time.
COMMIT;
```

The `UPDATE ... SET started_at = now() WHERE started_at IS NULL` in Phase 2 is an **optimistic compare-and-set primitive**. Under SQLite WAL mode it is serializable on the row's page, so exactly one concurrent caller observes a rowcount of 1 and proceeds to invoke the tool; all others observe 0 and abort without invoking. This closes the double-execution window when two workers race to claim the same receipt.

### In-Flight Receipts After A Restart

A receipt whose Phase 2 started but never reached Phase 3 — `started_at IS NOT NULL AND completed_at IS NULL` — is an in-flight receipt.

The in-flight-receipt sweep runs **only at daemon startup**, per [§Default Behavior](#default-behavior) ("Recovery runs automatically on daemon startup before new mutable work is accepted"). While the daemon is running, an in-flight marker denotes a live worker that owns the receipt and is actively invoking the tool; another worker MUST NOT re-claim it. The optimistic CAS in Phase 2 covers the narrow concurrent-boot race (for example a supervisor restarting the daemon twice in quick succession); it is **not** a general garbage-collector for long-running in-flight executions. A receipt stuck in-flight across a fully-live daemon is treated as a bug, not a recovery input.

The sweep re-executes no command. A receipt that persisted a durable MCP **task handle** — which the daemon's one MCP client writes to the receipt before anything else — resolves, for a server reached at an address, by polling `tasks/get` to a terminal status and reading the recorded outcome via `tasks/result`: never re-executed and nothing asked of the person, its real recorded outcome delivered once. Every other in-flight receipt halts the affected run with a `recovery-needed` condition per [Spec-004 § Fallback Behavior](004-provider-driver-contract-and-capabilities.md#fallback-behavior) and asks the person: a receipt with no task handle; a task on a stdio server, which ends with the daemon; a purged or expired task; and a task observed in `input_required`, which awaits interaction the sweep cannot supply, its handle preserved for the person.

### References

- [Local SQLite Schema § Command Receipts](../architecture/schemas/local-sqlite-schema.md) — `command_receipts` table and two-phase columns

## Writer Concurrency

All writes to the local SQLite event log pass through a **single writer worker** isolated on a Node.js worker thread. This is a platform requirement, not a stylistic choice: the `node:worker_threads` documentation excludes native-addon-backed objects from `postMessage`-transferable values, so a `better-sqlite3` `Database` handle cannot be shared across threads ([nodejs.org/docs/latest-v24.x/api/worker_threads.html](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html), fetched 2026-04-19; reinforced by [better-sqlite3 `docs/threads.md`](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/threads.md)). Each worker opens its own connection; only the designated writer worker holds a connection opened in read-write mode.

The per-session append lock orders a session's writes and nothing more: a write queued under it may not have committed when the next holder reads, so every read that decides a write goes inside that write as a guarded statement, whose row count refuses the whole write when the state it read has moved.

### Driver Pin

V1 pins **`better-sqlite3@13.0.3`** exact as the local SQLite driver. 13.0.3 was released 2026-08-05 ([better-sqlite3 `v13.0.3` release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.3)), is the first Node-API line — eight `prebuilds/<platform>-<arch>.node` binaries bundled in the published tarball, ABI-independent across Node and Electron, with no `prebuild-install` — and embeds SQLite **3.53.4**. Its published `engines.node >= 22` **overstates the real floor**: the prebuilds are compiled against Node-API 10, declared by the package's own `binding.gyp` (`'defines': ['NAPI_VERSION=10', …]` — [`binding.gyp` at `v13.0.3`](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/binding.gyp)), and Node exposes Node-API 10 only from 22.14.0 / 23.6.0 ([nodejs.org/docs/latest-v24.x/api/n-api.html#node-api-version-matrix](https://nodejs.org/docs/latest-v24.x/api/n-api.html#node-api-version-matrix), fetched 2026-09-01; the `NODE_API_SUPPORTED_VERSION_MAX` bump 9 → 10 lands in v22.14.0). **What a Node-API-9 host does with it is stated at two grades, deliberately.** Node's _documented_ behavior is a refusal at load: `NewEnv` in [`src/node_api.cc`](https://github.com/nodejs/node/blob/v22.14.0/src/node_api.cc) calls `ThrowNodeApiVersionError`, so `require()` throws a named `Error` reading that the module "requires Node-API version 10, but this version of Node.js only supports version 9 add-ons". What this repository _observed_ on 2026-09-01 (first-party) was harder — a `SIGSEGV` with no diagnostic at the first `new Database()` rather than that throw ([ADR-021](../decisions/021-v1-toolchain-selection.md), 2026-09-01) — and it is recorded as an observation of one host, never as Node's contract. The floor does not turn on which of the two a given host produces: on either, a Node-API-9 host cannot load this binding, which is why the driver needs Node 22.14.0 or later; the packages' `engines.node` floor of `>=24.21.0` meets it. The pin is **exact** rather than a caret because the 13.0.x line's own history is the reason for the version chosen: 13.0.0 / 13.0.1 **abort the process** under this repo's worker-terminate shape — the upstream report's own word, reproduced here on 13.0.1 and closed on 13.0.3 ([WiseLibs/better-sqlite3#1507](https://github.com/WiseLibs/better-sqlite3/issues/1507), fixed in 13.0.2); the `SIGABRT` an abort raises is our reading of it and not a signal the report names, so a range that could resolve below 13.0.2 would resolve to a binding this daemon crashes on. Recommended Node runtime is 24 LTS. The built-in `node:sqlite` module is not used: on Node 24.15.0 LTS and Node 25.9.0 Current its stability index read `1.2 — Release candidate` ([nodejs.org/docs/latest-v24.x/api/sqlite.html](https://nodejs.org/docs/latest-v24.x/api/sqlite.html), fetched 2026-04-19), short of Stability 2 (Stable).

**Upgrade policy.** The pin is exact, so nothing inside the 13.0.x line is auto-applied; any move off `13.0.3` — patch, minor, or major — must be explicitly re-evaluated against the pragma overrides in §Pragmas and the `.backup()` atomicity contract in §Backup Policy before the pin moves. Since V1's durability posture depends on `synchronous = FULL` and on the undocumented fsync behavior of `.backup()`, a bump that changed either behavior would be invisible without this gate. **§Pragmas, verified by readback under 13.0.3 / SQLite 3.53.4:** a connection reopening an existing WAL database reads `synchronous = 1` (NORMAL) before the override — the compiled `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1` this section's rationale rests on, confirmed present in the 13.x build's `PRAGMA compile_options` beside `DEFAULT_SYNCHRONOUS=2` — and after the four statements reads back exactly `journal_mode = wal`, `synchronous = 2`, `foreign_keys = 1`, `busy_timeout = 5000`. The override is therefore load-bearing: without it the connection runs at NORMAL. **§Backup Policy, probed directly:** `Database.prototype.backup` is a Promise-returning method, a WAL source copies to a destination whose `integrity_check` is `ok` with every row present, a mutation made on the same connection while the backup is in flight is reflected in the copy (the WiseLibs-documented behavior the Daily Full Backup section relies on), and the post-backup one-shot `PRAGMA wal_checkpoint(TRUNCATE)` truncates the log to zero bytes. 13.x does not document destination or parent-directory fsync, so the four-step publish sequence and the single-runner lock below stand.

### Pragmas

The writer worker sets the following pragmas on first connection:

```sql
PRAGMA journal_mode = WAL;      -- concurrent readers during writes
PRAGMA synchronous = FULL;      -- override better-sqlite3 default (NORMAL) for chain-of-custody durability
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA secure_delete = ON;      -- deleted content is overwritten with zeros, so a deleted session leaves no readable freed page
```

The `synchronous = FULL` override is load-bearing. The `better-sqlite3` bundled distribution compiles with `SQLITE_DEFAULT_SYNCHRONOUS=1` (NORMAL), which the maintainers note trades _"a slight loss of durability"_ for WAL throughput ([better-sqlite3 `docs/performance.md`](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md), fetched 2026-04-19). That trade-off is unacceptable for `session_events` because it is the canonical record a rebuild reads from: an acknowledged write that is lost is a session fact gone for good.

### Bounded Queue and Batched Transactions

The writer worker consumes events from a bounded in-memory queue. The queue cap is `10_000` events and batches flush at `50` events OR `10 ms`, whichever fires first. Each batch runs under one `db.transaction(fn)` call — the `better-sqlite3` primitive that commits atomically on return and rolls back on throw ([API docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md), fetched 2026-04-19). Each write in a batch runs in its own savepoint, so a refused write rolls back alone; a batch-level failure — a commit that fails, or SQLite ending the transaction itself — fails every write in the batch. A workflow tick's events are one write, never split across batches; a write carrying more events than the queue cap is refused.

### Backpressure

When the queue is at cap, enqueue semantics dispatch on event category:

- **Canonical state-change events** (every event type tracked by Spec-005 as canonical — `run_lifecycle.*`, `tool_activity.*`, `approval_*`, and all others) — the enqueuing call awaits an internal promise that resolves once the next batch drains; the event is never dropped and the write path never returns a silent failure.
- **`assistant.thinking_update` only** — dropped at enqueue, with a per-session 1/s-rate-limited `event_dropped` counter emitted via the observability path (not the event log). The counter is tagged `session_id` and `event_type` so the person can tell drops in one session from drops in another. Per [Spec-005](005-session-event-taxonomy-and-audit-log.md) `assistant.thinking_update` is a non-canonical narration stream; drops preserve end-to-end run semantics.

No other event type is dropped.

### Alerting

The daemon samples the queue depth every second and alerts at **80% of queue cap** (8_000 of 10_000): at this threshold it writes a `persistence_backpressure` warning to its service log, tagged by `session_id` (populated if the saturating event carries one) and `event_category`. Sustained backpressure on state-change events eventually surfaces as user-visible run-progression latency, so the alert fires well before queue exhaustion.

### References

- [Node.js worker_threads](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html) — platform constraint mandating per-worker native-addon handles
- [better-sqlite3 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) — `.backup()`, `db.transaction(fn)`, pragma surface (v13.0.3 released 2026-08-05). Node-API floor for that pin: [`binding.gyp` at `v13.0.3`](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/binding.gyp) declares `NAPI_VERSION=10`; the [Node-API version matrix](https://nodejs.org/docs/latest-v24.x/api/n-api.html#node-api-version-matrix) maps 10 to Node `v22.14.0+` / `23.6.0+`; and [`src/node_api.cc` at `v22.14.0`](https://github.com/nodejs/node/blob/v22.14.0/src/node_api.cc) carries `ThrowNodeApiVersionError` — the documented failure for a too-new Node-API module is a load-time throw, not a crash
- [better-sqlite3 performance](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md) — default `synchronous=NORMAL` trade-off
- [better-sqlite3 threads](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/threads.md) — per-worker connection pattern
- [Node.js node:sqlite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) — Stability `1.2 — Release candidate` on Node 24 LTS, read 2026-04-19

## Clock Handling

Session events carry two timestamps: `occurred_at` (RFC 3339 wall-clock UTC) for display and audit export, and `monotonic_ns` (BIGINT nanoseconds from a monotonic source) for ordering within a single daemon's event log.

### Monotonic Source

`monotonic_ns` is produced by `process.hrtime.bigint()`. Per the Node.js documentation: _"The `bigint` version of the `process.hrtime()` method returning the current high-resolution real time in nanoseconds as a `bigint`"_ ([nodejs.org/docs/latest-v24.x/api/process.html#processhrtimebigint](https://nodejs.org/docs/latest-v24.x/api/process.html#processhrtimebigint), fetched 2026-04-19). The underlying `process.hrtime()` docs add the load-bearing guarantee: _"These times are relative to an arbitrary time in the past, and not related to the time of day and therefore not subject to clock drift."_

**Semantics.** `monotonic_ns` is not a UNIX timestamp. Its zero point is unspecified and changes on every daemon restart. It serves exactly two purposes: (a) stable within-daemon event ordering when the wall clock jumps (NTP step, VM resume, a manual clock change by the person); (b) precise duration measurements between events produced by the same daemon process.

**Out-of-scope explicitly.** `monotonic_ns` is **not** a cross-daemon ordering primitive. See [data-architecture.md §Event-Sourcing Scope](../architecture/data-architecture.md#event-sourcing-scope) on why per-daemon `sequence` and `monotonic_ns` do not induce a total order across daemons. Hybrid Logical Clocks (HLC) are out-of-scope for V1 per [ADR-016](../decisions/016-shared-event-sourcing-scope.md): ordering is daemon-authoritative per user, with no shared event log to order against.

### Wall-Clock Format

`occurred_at` is an ISO 8601 / RFC 3339 string with millisecond precision and `Z` suffix: `YYYY-MM-DDTHH:mm:ss.sssZ`. This is the exact output of `Date.prototype.toISOString()` (ECMA-262 §21.4.4.36) and is unambiguous to any RFC 3339 parser ([datatracker.ietf.org/doc/html/rfc3339](https://datatracker.ietf.org/doc/html/rfc3339), fetched 2026-04-19). Per RFC 3339 §5.6 the grammar permits `Z` or numeric `±HH:MM`; this spec mandates uppercase `Z`.

### References

- [Node.js process.hrtime.bigint()](https://nodejs.org/docs/latest-v24.x/api/process.html#processhrtimebigint) — monotonic nanosecond source; "not subject to clock drift"
- [RFC 3339 §5.6](https://datatracker.ietf.org/doc/html/rfc3339) — wall-clock format grammar
- [ADR-016](../decisions/016-shared-event-sourcing-scope.md) — daemon-authoritative event ordering

## Backup Policy

Backups are the person's choice. `Back up automatically`, on Settings › Runtime, is off by default, and nothing is backed up until the person turns it on or presses `Back up now`; the switch and the folder are kept in the machine's settings file. While backups are on, the local store can be restored with at most 25 hours of staleness (§Restore SLO). The policy has these parts: the WAL checkpoint cadence, which runs whether backups are on or off; the daily backup and what it holds; retention; the folder; and the restore. Every background job here is a job on the service's one scheduler: each job registers with its cadence, its condition and its budget, two jobs never run at once, a job that cannot run under its condition waits for the next moment it can, and nothing the scheduler runs removes anything a person could see.

### WAL Checkpoint Cadence

The daemon runs WAL checkpoints under two triggers, both **PASSIVE mode**:

- **Page-driven (auto)** — SQLite's built-in autocheckpoint fires when the WAL reaches `1000` pages (the default for `PRAGMA wal_autocheckpoint` confirmed at [sqlite.org/pragma.html#pragma_wal_autocheckpoint](https://sqlite.org/pragma.html#pragma_wal_autocheckpoint), last-updated 2025-11-13, fetched 2026-04-22). Per the same page — _"All automatic checkpoints are PASSIVE."_
- **Time-driven (explicit)** — the daemon runs `PRAGMA wal_checkpoint(PASSIVE)` every 5 minutes, always, as a job on the service's one scheduler, run through the writer worker. PASSIVE is the only mode that, per [sqlite.org/wal.html](https://sqlite.org/wal.html) §3.2, _"does as much work as it can without interfering with other database connections"_ — it never invokes the busy-handler callback and does not block readers or writers. FULL, RESTART, and TRUNCATE each either block writers or contend with readers.

On backup completion the daemon runs a one-shot `PRAGMA wal_checkpoint(TRUNCATE)` to reclaim the WAL file's on-disk footprint. TRUNCATE is the only mode that truncates the log file to zero bytes (wal_checkpoint_v2.html). Running TRUNCATE opportunistically (tied to backup) keeps the steady-state cadence strictly PASSIVE and avoids stalling the writer under normal load. The purge deletes with `secure_delete` on and checkpoints with `TRUNCATE` once its transaction commits, so the zeroed pages reach the database file and the log keeps no earlier copy of them ([Spec-020 §Ordering And Atomicity](020-data-retention-export-and-deletion.md#ordering-and-atomicity)). After each `Delete old data`, a scheduler job repacks the file — `PRAGMA wal_checkpoint(TRUNCATE)`, then `VACUUM` — while no turn runs, its saving measured before and after.

### Daily Full Backup

While `Back up automatically` is on, the backup runs as a job on the service's scheduler: daily, at the first moment of the day with no turn running, or 25 hours after the last run at the latest, and again right after every `Delete old data`. `Back up now` (`daemon.backupStart`) runs it at once, whether the switch is on or off. A run never stops or delays work; a run that fails keeps the backups there are, Runtime reads `The last backup did not finish: <reason>`, and the next run tries again. The database is copied whole with `better-sqlite3.backup(destination)` — a Promise-returning method that wraps the SQLite Online Backup API ([better-sqlite3 `docs/api.md`](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md), fetched 2026-04-19). Per WiseLibs' docs: _"You can continue to use the database normally while a backup is in progress. If the same database connection mutates the database while performing a backup, those mutations will be reflected in the backup automatically."_ This matches the single-writer-worker model; multi-connection concurrent writes are not permitted in V1 so the alternate _"backup forcefully restarted"_ path does not apply.

**Atomicity.** The SQLite Online Backup API holds a shared lock on the source database during each step and an _"exclusive lock on the destination file"_ for the full duration ([sqlite.org/c3ref/backup_finish.html](https://sqlite.org/c3ref/backup_finish.html), fetched 2026-04-19). WiseLibs' documentation does not specify whether `.backup()` fsyncs the destination or the parent directory. The daemon MUST therefore mandate the following publish sequence at the implementation layer:

1. Write to a same-filesystem staging path `<target>.tmp`.
2. `fsync()` the staging file descriptor.
3. `rename(<target>.tmp, <target>)` — atomic on a single filesystem per [`rename(2)`](https://man7.org/linux/man-pages/man2/rename.2.html).
4. `fsync()` the parent directory file descriptor — required for directory-entry durability per [`fsync(2)`](https://man7.org/linux/man-pages/man2/fsync.2.html): _"Calling `fsync()` does not necessarily ensure that the entry in the directory containing the file has also reached disk. For that an explicit `fsync()` on a file descriptor for the directory is also needed."_

A single-runner lock (`<backups-dir>/backup.lock` opened with `O_EXCL|O_CREAT`) prevents concurrent backup invocations from racing on the destination's exclusive lock.

**What a backup holds.** What the person would lose with the disk: the service's database, copied online as above; the machine's settings file; each chat session's managed workspace; each kept session's file checkpoint copies; each kept session's conversation files in every account home it ran in; and the agent memory folder, `~/.ai-sidekicks/agent-memory/`, the only copy of what every agent has learned, on every platform, which a restore puts back. A backup is a plain copy of these. It never holds a credential, a package cache, a diagnostic log, a project's own repository or its worktrees: the person's repository is backed up by its own remote. The database is copied whole each run; everything else is kept as one mirror, each run copying only the files whose size or modification time changed and removing the files of the sessions `Delete old data` removed. Beside each copy a manifest records the time, the app and service versions, the counts and the sizes, and on a Windows computer the side that wrote it, Windows or the distribution's name. Budget: under 1 s of processor time per 256 MiB of store, and a run writes at most the bytes the day's sessions wrote.

**What the service reports.** `daemon.backupRead` returns the last run, the folder, the total size, each backup with its time, its size and the app version that wrote it; Runtime's line reads `Last backup today at 3:12 AM · 1.4 GB`, `No backup yet`, or the failed run's line. The events `backup.completed`, `backup.failed` and `backup.restored` land on the service's own session.

### Retention

Retention of the database copies follows a GFS-structured rolling window: **7 daily + 4 weekly**, for a steady-state maximum of 11 database copies plus any in-progress staging files and the single `backup.lock`. Daily copies older than 7 days are pruned; weekly copies (one per ISO week, promoted from that week's Monday daily) older than 4 weeks are pruned. This is a project convention, not a named-in-literature retention standard — chosen to bracket the restore bound of §Restore SLO plus one week. The mirror is one copy, not a set of generations. A session removed by `Delete old data` leaves the mirror at the next run, which starts right after the delete, and stays only in database copies taken before the delete, until they age out, at most four weeks; while backups are on, the delete's confirm says so: `Backups taken before this delete keep these sessions for up to four weeks.`

Pruning runs as part of the daily backup workflow after the new backup succeeds; no stand-alone pruner process is needed.

### Filesystem Layout

**Where backups go.** Backups go to `<home>/.ai-sidekicks/backups` by default, or to a folder the person picks with `Choose…` beside `Back up to`, which changes it whether the switch is on or off. On a Windows computer whose service runs in a WSL 2 distribution, the default is the Windows home's `.ai-sidekicks\backups`, reached from the distribution through the drive mount, because removing or resetting a distribution deletes its disk with everything on it; the backups then outlive the distribution and stay where they are when the service moves between Windows and the distribution. With drive mounts off, the backup's files travel over the service's channel and its Windows half writes them; the folder never falls back into the distribution. A folder the person picks can be an external drive or a synced folder, which is how a backup leaves the machine: the service never uploads a backup itself. While the folder is on the service's own disk, Runtime says what that protects against: `Backups on this disk undo a bad update or a mistaken delete. Only a folder on another drive protects against losing the disk.`

**Each backup's folder.** Each backup is one folder inside the backups folder, holding its database copy as `daemon.db` with its manifest, `manifest.json`, beside it; the newest backup is the one whose manifest's `takenAt` is latest.

**Permissions.** The backups folder MUST be created with mode `0700` on POSIX (owner-only read/write/execute).

### Restore

`Restore…` lists the backups in the chosen folder, each with its time, its size and the app version that wrote it (`today at 3:12 AM · 1.4 GB · version 0.1.0`) and `Restore`. Restoring one stops the service — the in-place confirm names the work that stops, as `Stop` does: `Restore the backup from today at 3:12 AM? Work in flight stops, and nothing new starts until the service is running again from that backup.` under `Cancel` and `Restore`, settling with `The background service is restarting from that backup.` — replaces the service's database, settings file, chat workspaces, checkpoint copies, conversation files and agent memory folder with the backup's, and starts the service again. The service cannot replace its own store while it runs, so the app's main process performs the restore (`daemon.requestRestore(backupId)`). `sidekicks db restore <backup>` does the same on a machine with no app, refused while the service holds the data folder.

Restoring on the machine that wrote it needs nothing more. A restore on another computer reads the backup directly; the person then signs in to providers and links devices again.

A backup restored on the other side of a Windows computer — written on Windows and restored in a WSL 2 distribution, or the reverse — is told apart by the side its manifest records, and after the replace the service runs the take-in a move between sides runs, so every stored path comes back in this side's form; a Windows computer is one machine whichever side runs its service, so it is a restore on the machine that wrote it. A restored session whose conversation file is newer than its database copy resumes through §Fallback Behavior's rule for a diverged record; one whose conversation file is missing continues the way a provider switch does, with the hand-over brief.

### Restore SLO

While backups are on, data staleness on restore is bounded at **≤ 25 hours**: a run starts at the first moment of the day with no turn running, or 25 hours after the last run at the latest, so the worst case is a loss just before the next run. Faster RPO is available via WAL replay from the most recent checkpoint (bounded at ≤ 5 minutes by the time-driven cadence) when the on-disk WAL is salvageable; the 25-hour bound governs the case where the filesystem is lost. With backups off there is no copy to restore from, and Runtime's line reads `No backup yet`.

### References

- [sqlite.org/backup.html](https://sqlite.org/backup.html) — Online Backup API semantics
- [sqlite.org/c3ref/backup_finish.html](https://sqlite.org/c3ref/backup_finish.html) — destination-side exclusive lock
- [sqlite.org/c3ref/wal_checkpoint_v2.html](https://sqlite.org/c3ref/wal_checkpoint_v2.html) — checkpoint mode semantics (PASSIVE / FULL / RESTART / TRUNCATE)
- [sqlite.org/pragma.html#pragma_wal_autocheckpoint](https://sqlite.org/pragma.html#pragma_wal_autocheckpoint) — 1000-page default (last-updated 2025-11-13)
- [better-sqlite3 API — `.backup()`](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) — Promise-returning wrapper
- [`fsync(2)`](https://man7.org/linux/man-pages/man2/fsync.2.html) — parent-directory fsync requirement
- [`rename(2)`](https://man7.org/linux/man-pages/man2/rename.2.html) — same-filesystem atomicity
- [Local Persistence Repair And Restore §Backup Constraints](../operations/local-persistence-repair-and-restore.md#backup-constraints) — what a backup holds and how to restore one

## State And Data Implications

- Local canonical event data and command receipts are the basis for rebuilds and idempotency.
- Shared control-plane data remains separate from local execution truth.
- Recovery outcomes must be surfaced into canonical event history and operational telemetry.
- A session's file checkpoint copies and its capture folder live with that session outside any checkout and grow no table; they are retained when the session is archived, held in every backup, and deleted with the session when it is purged, the capture folder with its base pins. A workflow run's capture folder is kept while the run's record exists.
- A chat's managed workspace — the git-initialized folder the daemon creates in the same step as the chat, at `<home>/.ai-sidekicks/workspaces/<session-id>`, registered as a mount with a managed origin, the session record's `shape` reading `chat` — is the chat's checkout. It is deleted whole when its session is purged, kept while the session is archived, skipped by the worktree sweep, and held in every backup.
- `Delete old data` is the only deletion of sessions besides `Delete session` on a session whose history is damaged, both whole sessions at a time; it moves a transcript's earliest cursor only for the sessions it removes, and a kept session keeps its data until it is deleted. Nothing the service runs on its own removes anything a person could see.

## Example Flows

- `Example: The daemon restarts during a blocked approval state. The startup rebuild recreates the session projection, restores the pending approval, and resumes the session in a recoverable waiting state.`
- `Example: A provider session cannot be resumed. The daemon records a recovery failure outcome, transitions the run to failed with provider failure detail and recovery-needed condition, and leaves the run visible to the person for intervention.`

## Implementation Notes

- Recovery is a first-class product behavior, not only a repair tool someone runs by hand.
- SQLite durability settings are part of the correctness contract for local execution.
- Projection rebuild logic should be testable in isolation from live provider transports.

## Pitfalls To Avoid

- Treating client cache as sufficient for recovery
- Silently dropping in-flight run state after restart
- Using one undifferentiated store for both local execution and shared control-plane truth

## Acceptance Criteria

- [ ] Local node restart can rebuild session projections and restore pending queue or approval state.
- [ ] Local mutable work is blocked when canonical local persistence is unavailable.
- [ ] Recovery failure is visible and auditable rather than silent.
- [ ] A session with a damaged event opens at its last good point with the damaged rows still stored, `Continue from here` lets it take new work, and every other session takes writes throughout.
- [ ] An undo puts back every file its dry run named, what an agent's edit tools and what its shell commands wrote alike, on both providers; names every file it skipped with the reason; and still finds its checkpoints after a daemon restart.
- [ ] No capture writes an object or a ref into the person's `.git` other than the base pins, and an undo in a folder two sessions share puts back only its own session's changes.
- [ ] After a restart, a provider record ahead by steps that only read is added with its row and the session continues; any other mismatch, a part whose content cannot be read included, halts on one question with its named choices.
- [ ] With `Back up automatically` off, nothing is backed up; a backup holds no credential, and a restore on another computer reads it directly, after which the person signs in to providers and links devices again.

## Snapshot Compaction

- Correctness never depends on snapshot compaction, and no compaction has to run on a schedule.

## References

- [Data Architecture](../architecture/data-architecture.md)
- [Observability Architecture](../architecture/observability-architecture.md)
- [Session Event Taxonomy And Audit Log](../specs/005-session-event-taxonomy-and-audit-log.md)
