# Session Tables (Plan-001)

The session tables of the daemon's one SQLite schema: the session directory, one row per session the daemon hosts with its groups, links, tags, related lists and the create and convert requests a retry resumes from, and each session's console state. The [Local SQLite Schema](local-sqlite-schema.md) holds its pragmas, its conventions and every other area.

## Session Directory (Plan-001)

The daemon keeps one row per session it hosts in `sessions`, the directory that `session.subscribe` and `session.read` answer from. [Spec-001 §State And Data Implications](../../specs/001-session-core.md#state-and-data-implications) owns the row, and the `CREATE TABLE sessions` block below declares every column. The columns other services read:

- `shape` — whether the session is a chat, bound to its own managed workspace, or a session in an attached project. It is set when the session is created and changes only when a chat is converted to a project. The sessions list groups by it, and it reaches clients as `shape` on `session.read` and `session.subscribe`.
- `place` — where the session runs, the place's wire JSON (`"windows"` or `{"distro":"Ubuntu"}`) on a Windows computer, NULL on macOS and Linux, as `projects.place` and `repo_mounts.place` are stored ([Workspace and Git Tables](local-sqlite-workspace-and-git-tables.md)). Written from `session.created` and never changed, so a rebuild restores it from that event; it reaches clients as `place` on `session.read`, on `session.create`'s answer and on `session.created`.
- `muted_at` — RFC 3339 UTC; NULL while the session is not muted. `session.muted` sets it and `session.unmuted` clears it, and a rebuild restores it from those events; it reaches clients as `muted` on `session.read` and `session.subscribe`. While it is set, the session's `Finished` and `Failed` moments reach no channel and no device; `Waiting on you` and a workflow's Notify step are never silenced by it. The attention service reads it when it writes an entry.
- `group_id` — the one group of its project the session sits in; NULL for a session in no group and for every chat. Indexed (`idx_sessions_group`), because the sessions list and search read a group's sessions by it. An archived session keeps it.
- `pending_working_folder` — the folder a `session.workingFolder.update` move goes to, applied at the active run's next boundary; NULL while no move waits. Written by the session service with no event of its own, so a rebuild, which rewrites only the row's event-derived columns, keeps it; it reaches clients as `pendingWorkingFolder` on `session.read`, and a purge keeps every worktree a pending move names.
- `permission_level` — the session's permission level, which the run queue's admission reads: every process the session opens or resumes starts at it. `session.create` writes the level the provider's own settings give for the session's project ([Spec-010 §Default Behavior](../../specs/010-approvals-permissions-and-trust-boundaries.md#default-behavior)); the column's `yolo` is that read's answer when they set none. `session.permissionLevel.update` writes it once an open session's provider has taken the level, under the lock the session's opening takes, so the process never runs at another level than the stored one. Written with no event of its own, so a rebuild keeps it.

A session's groups, links and tags are the three layers of [Spec-001 §Groups, Links And Tags](../../specs/001-session-core.md#groups-links-and-tags): one place in the list, any number of relationships, any number of categories. All three are row-canonical daemon state written by the session service and the session tools, not rebuilt from the event log, and removed with their session.

```sql
-- Owner: Plan-001
CREATE TABLE session_groups (
  rowid        INTEGER PRIMARY KEY,        -- declared, so a VACUUM keeps the search index's keys
  id           TEXT NOT NULL UNIQUE,
  project_id   TEXT NOT NULL,              -- the project record the group belongs to; a chat has no groups
  name         TEXT NOT NULL,              -- the person's own casing, for display
  name_folded  TEXT NOT NULL,              -- the full-Unicode case fold of name, written by the store on every insert and rename
  created_at   TEXT NOT NULL
) STRICT;

-- A group's name is unique in its project ignoring case, on the stored fold key, the same rule
-- agent definition names follow.
CREATE UNIQUE INDEX idx_session_groups_name_folded ON session_groups(project_id, name_folded);

CREATE TABLE sessions (
  rowid                      INTEGER PRIMARY KEY,  -- declared, so a VACUUM keeps the search index's keys
  id                         TEXT NOT NULL UNIQUE,
  shape                      TEXT NOT NULL CHECK (shape IN ('chat', 'project')),
  state                      TEXT NOT NULL
                             CHECK (state IN ('provisioning', 'active', 'archived', 'closed', 'purgeRequested')),
  name                       TEXT,                  -- NULL while unnamed
  first_message_preview      TEXT,                  -- the first user message's opening, cut to the session name's bound
  branch                     TEXT,
  pinned_at                  TEXT,                  -- NULL while not pinned; pinned rows sort by it
  muted_at                   TEXT,                  -- NULL while not muted
  scratch_for_definition_id  TEXT,                  -- the agent definition a scratch session tries
  parent_session_id          TEXT,                  -- the session a fork was taken from
  place                      TEXT,
  -- How the session's most recent run to end its working time left it. The session reads waiting
  -- while any of its runs waits, else running while any works, else this.
  last_run_outcome           TEXT NOT NULL DEFAULT 'idle'
                             CHECK (last_run_outcome IN ('done', 'failed', 'idle')),
  created_at                 TEXT NOT NULL,         -- RFC 3339 UTC, ms precision
  updated_at                 TEXT NOT NULL,
  last_activity_at           TEXT NOT NULL,
  group_id                   TEXT REFERENCES session_groups(id),
  pending_working_folder     TEXT,
  permission_level           TEXT NOT NULL DEFAULT 'yolo'
                             CHECK (permission_level IN ('readonly', 'ask', 'reviewed', 'sandboxed', 'yolo'))
) STRICT;

CREATE INDEX idx_sessions_group ON sessions(group_id);
-- The list's shape grouping and the chats count.
CREATE INDEX idx_sessions_shape_state ON sessions(shape, state);

-- One row per pair of sessions and kind. The daemon writes or bumps a row when the event that makes it
-- is recorded, never by a rescan. Rows name sessions by id, so a rename changes none. Only a 'related'
-- row is ever deleted (the person's or an agent's Unlink); the others record what happened.
CREATE TABLE session_links (
  source_session_id  TEXT NOT NULL,
  target_session_id  TEXT NOT NULL,
  kind               TEXT NOT NULL
                     CHECK (kind IN ('started', 'copiedFrom', 'messaged', 'asked', 'mentioned', 'related')),
  use_count          INTEGER NOT NULL DEFAULT 1 CHECK (use_count >= 1),  -- messaged counts the messages traded
  first_at           TEXT NOT NULL,
  last_at            TEXT NOT NULL,          -- the 30-day halving of a link's weight is measured from here
  PRIMARY KEY (source_session_id, target_session_id, kind)
) STRICT;

CREATE INDEX idx_session_links_target ON session_links(target_session_id, source_session_id);

-- Any number of tags per session, across projects, nested with '/'. The fold key makes a tag match
-- ignoring case, and a prefix match on it finds a parent's children ('billing' finds 'billing/stripe').
CREATE TABLE session_tags (
  rowid       INTEGER PRIMARY KEY,           -- declared, so a VACUUM keeps the search index's keys
  session_id  TEXT NOT NULL,
  tag         TEXT NOT NULL,                 -- as written, for display
  tag_folded  TEXT NOT NULL,
  UNIQUE (session_id, tag_folded)
) STRICT;

-- Covers the tags in use, which `Add tag` suggests: one spelling per fold, read from the index alone.
CREATE INDEX idx_session_tags_tag ON session_tags(tag_folded, tag);

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
) STRICT;

CREATE INDEX idx_session_related_score ON session_related(session_id, score DESC);
-- A purge deletes the entries naming the purged session from every other session's list.
CREATE INDEX idx_session_related_related ON session_related(related_session_id);

-- Each session.create's idempotency key, the session it made and where that session works: its
-- project (NULL for a chat, which works in its own managed mount), its execution mode and the group
-- it asked for (NULL for none, and for every chat). Written in the session.created write, so a
-- retry with the key, or the daemon's start, finishes a session left provisioning; a session made
-- in a project still cloning is finished once the clone attaches it.
CREATE TABLE session_create_requests (
  client_idempotency_key  TEXT NOT NULL PRIMARY KEY,
  session_id              TEXT NOT NULL UNIQUE,
  project_id              TEXT,
  execution_mode          TEXT NOT NULL
    CHECK (execution_mode IN ('boundRoot', 'provisionedWorktree')),
  group_id                TEXT
) STRICT;

-- A project's sessions, which its rules reach, found by the project they were made in.
CREATE INDEX idx_session_create_requests_project ON session_create_requests(project_id);

-- A chat's conversion: the session.convert key it runs under, which the latest request that
-- resumed it takes over, the project mount it attached and the working tree it copies into.
-- Written as soon as the mount is, so a retry resumes onto that mount and into that working tree,
-- and answered from session.converted once that lands. One per chat.
CREATE TABLE session_convert_requests (
  client_idempotency_key  TEXT NOT NULL PRIMARY KEY,
  session_id              TEXT NOT NULL UNIQUE,
  repo_mount_id           TEXT NOT NULL,
  working_tree            TEXT NOT NULL
) STRICT;

-- Each workspace file a conversion has dealt with, recorded as its copy lands: copied, or not
-- copied with the reason. A resumed conversion skips every path here and counts from these rows;
-- the files not copied are read a page at a time by session.conversion.skippedFile.list.
CREATE TABLE session_convert_files (
  session_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  outcome     TEXT NOT NULL
    CHECK (outcome IN ('copied', 'repositoryHasFile', 'repositoryPathNotAFolder', 'link',
      'specialFile')),
  PRIMARY KEY (session_id, path)
) STRICT, WITHOUT ROWID;
```

Budget, at 10,000 sessions, 1,000,000 indexed messages, 100,000 links and 30,000 tags, measured on the daemon's own build: a related list under 1 ms and a search under 50 ms at p95. Measured with SQLite 3.53.4 on an Apple M1 Pro at 10,000 sessions and 100,000 links: a stored related list read in 0.128 ms at p95, about 20 stored rows per session, and the re-score after one new link took 55 ms of wall time at p95 in the background. The re-score runs on a blocking thread (`spawn_blocking`), off the runtime's two workers; one session's scoring is not split.

A conversion records each file as its copy lands without waiting for that record before the next copy, with at most 100 records waiting at once, so the writer folds them into shared batches. Measured on the same build, converting a chat of 1 KiB files in 100 folders took 0.36 s at 1,000 files and 29 s at 100,000 files; awaiting each record would give every file a commit of its own.

---

## Session Console State (Plan-001)

The daemon's own session-scoped store for what a session holds outside its event log. [Spec-001 §State And Data Implications](../../specs/001-session-core.md#state-and-data-implications) declares the composer draft, its staged attachments and the review notes left on a file's lines durable here, so that a half-written message, its files and an unsent review reach the person's other devices. The staged files' columns are defined with the verbs that write them, `session.attachment.add` / `session.attachment.remove` ([api-payload-contracts §Operations Not Yet Built](../contracts/api-payload-contracts.md#operations-not-yet-built)). The first block below holds the draft, which `session.draft.update` writes, and the columns the spawn path reads: the session's own step bound and a Claude Code session's own advisor. The second holds the review notes, which `session.reviewNote.add` / `session.reviewNote.update` / `session.reviewNote.delete` write ([Gitflow Payload Contracts](../contracts/gitflow-payloads.md)).

It is **configuration, not session history**: it is not events-canonical and is not rebuilt from the event log. A session's step bound is a preference the person set, so a log that can rebuild what a turn did has nothing to say about it.

```sql
-- Owner: Plan-001
-- One row per session, so a half-typed message survives a restart and reaches the person's other
-- devices. An empty draft is no row: Send deletes it.
CREATE TABLE session_drafts (
  session_id  TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  updated_at  TEXT NOT NULL                     -- RFC 3339 UTC, ms precision
) STRICT;

CREATE TABLE session_console_state (
  session_id          TEXT NOT NULL PRIMARY KEY,  -- one row per session: written at `session.create` for a Claude Code session (its advisor), and for any other session on the first press that needs it
  max_steps_per_turn  INTEGER
                      CHECK (max_steps_per_turn IS NULL OR max_steps_per_turn >= 1),  -- this session's OWN bound on how many steps one turn may take. NULL = no session override, so the machine's own Runtime value applies, and where that is unset each provider does what it does on its own ([Spec-003 §The Step Bound On A Turn](../../specs/003-queue-steer-pause-resume.md#the-step-bound-on-a-turn)). The floor is 1 because a bound of zero would forbid the turn it bounds; the ceiling is the person's, since Claude Code and Codex publish none. The MACHINE-wide value is not here: it belongs to the Runtime settings page, so one number has one home on each side of the override
  advisor_model       TEXT,  -- a Claude Code session's own advisor: the model, or NULL when it is off. Copied at `session.create` from the app's pick on Claude Code's declared `Advisor` row, kept in the machine settings file's `providerSettings`, where one is set, else from the `advisorModel` Claude Code's own settings resolve for the session's project, and NULL where none sets one; changed only by `/advisor` in this session, each change appending `session.advisor.changed`; a later change to the default never reaches it
  session_mode        TEXT NOT NULL DEFAULT 'build'
                      CHECK (session_mode IN ('build', 'plan')),  -- the composer's Build or Plan mode, written `plan` at `session.create` where Claude Code's own `permissions.defaultMode` resolves to `plan`, and otherwise once the provider has taken a `session.mode.update`; a restart's resume opens in it
  updated_at          TEXT NOT NULL
) STRICT;
```

The number is carried onto a spawn through `runtime_bindings.spawn_config` and counted by the daemon per turn on every provider, a Claude Code process also started with the number plus one as `--max-turns`, a backstop the daemon's interrupt comes before; a change reaches the session's next turn and never the turn in flight. The mode is read when a restart resumes the session, so a session left in Plan comes back in Plan. The advisor rides the same path: every Claude Code process started for the session (after a restart, a resume or a provider switch, and a helper the bridge starts) reads `advisor_model` at launch.

```sql
-- Owner: Plan-008
CREATE TABLE session_review_notes (
  session_id            TEXT NOT NULL,
  note_id               TEXT NOT NULL,
  scope                 TEXT NOT NULL
                        CHECK (scope IN ('changes', 'branch', 'changeRequest')),
  base                  TEXT NOT NULL,
  head_commit_id        TEXT,
  working_tree_blob_id  TEXT,
  request_number        INTEGER CHECK (request_number IS NULL OR request_number >= 1),
  path                  TEXT NOT NULL,
  old_path              TEXT,                   -- the file's earlier path when it was renamed
  side                  TEXT NOT NULL CHECK (side IN ('added', 'removed')),
  line                  INTEGER NOT NULL CHECK (line >= 1),
  start_line            INTEGER CHECK (start_line IS NULL OR start_line BETWEEN 1 AND line),
  quote                 TEXT NOT NULL,          -- the line's text when the note was added
  body                  TEXT NOT NULL,
  created_at            TEXT NOT NULL,          -- RFC 3339 UTC, ms precision
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (session_id, note_id),
  CHECK ((head_commit_id IS NULL) <> (working_tree_blob_id IS NULL))
) STRICT, WITHOUT ROWID;
```

A note is held here until it is composed into the draft as a steer, posted with a review or discarded. Whether its line is still there (`stranded`) is read from git on each read and never stored: `quote` is taken from that side's file at the note's comparison, and the note reads stranded once that line is gone from the file or no longer says what `quote` holds. The session's purge deletes its notes in the same write as its other rows.
