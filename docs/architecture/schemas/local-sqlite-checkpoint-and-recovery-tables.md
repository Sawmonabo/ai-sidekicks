# Checkpoint and Recovery Tables (Plan-012)

The checkpoint and recovery tables of the daemon's one SQLite schema. The [Local SQLite Schema](local-sqlite-schema.md) holds its pragmas, its conventions and every other area.

## Checkpoints

The checkpoint tables hold one checkpoint per turn-starting prompt, the versions each path took in it, the command windows its commands ran in, the shadows of files over 10 MiB with the windows that stand on them and the session's folders on other volumes, and each undo's saved outcome by its request's key. These rows are their own truth, written as the turn runs and never rebuilt from the log. A version names its copy by hash or its shadow by id; the bytes sit on disk, never in a row.

```sql
-- Owner: Plan-012
-- One row per prompt that opened or steered a turn: the point an undo goes back to, before that
-- message.
CREATE TABLE session_checkpoints (
  checkpoint_id     TEXT PRIMARY KEY,           -- the snapshot id a client names it by
  session_id        TEXT NOT NULL,
  message_sequence  INTEGER NOT NULL CHECK(message_sequence >= 0), -- the prompt's place in the log
  run_id            TEXT NOT NULL,
  epoch             INTEGER NOT NULL CHECK(epoch >= 0),     -- the run's execution epoch
  position          INTEGER NOT NULL CHECK(position >= 0),  -- the prompt's run position
  created_at        TEXT NOT NULL,
  UNIQUE (session_id, message_sequence)
) STRICT;

-- One row per command window: the captures before and after a command the agent ran, and
-- whether its before-capture was taken before it ran.
CREATE TABLE checkpoint_commands (
  window_id      TEXT PRIMARY KEY,
  checkpoint_id  TEXT NOT NULL REFERENCES session_checkpoints(checkpoint_id),
  tree_before    TEXT,                          -- NULL when the before-capture failed
  head_before    TEXT,
  -- The captures' commits, whose trailers name the paths each left out; NULL when it failed, and
  -- the after's until the window closes.
  commit_before  TEXT,
  tree_after     TEXT,                          -- NULL until it closes, or when that capture failed
  head_after     TEXT,
  commit_after   TEXT,
  -- Set as it closes; false names it in the dry run's uncovered commands.
  covered        INTEGER CHECK(covered IN (0, 1)),
  command        TEXT NOT NULL,
  tool_call_id   TEXT,                          -- the provider's tool call, NULL when none ran it
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  CHECK((ended_at IS NULL) = (covered IS NULL))
) STRICT;

CREATE INDEX idx_checkpoint_commands_checkpoint ON checkpoint_commands(checkpoint_id);

-- One row per shadow of a file over 10 MiB, which is never hashed: its clone, or why none was
-- kept, and the facts a later capture compares to tell whether the file changed. A path holds one
-- current shadow per session; a retired one stays while a window or a version names it.
CREATE TABLE checkpoint_shadows (
  shadow_id        TEXT PRIMARY KEY,            -- also the clone's file name
  session_id       TEXT NOT NULL,
  path             TEXT NOT NULL,               -- the listed path under the checkout's real path
  clone_path       TEXT,                        -- NULL when no clone was kept
  volume_id        TEXT,                        -- set only for a clone outside the capture folder
  not_kept_reason  TEXT CHECK(not_kept_reason IN ('tooLarge', 'noPlaceOnVolume', 'failed')),
  -- The file's facts, all NULL together when the read failed; times in nanoseconds since the epoch.
  identity         TEXT,
  size             INTEGER CHECK(size >= 0),
  link_count       INTEGER CHECK(link_count >= 0),
  modified         INTEGER,
  changed          INTEGER,
  taken_at         INTEGER NOT NULL,            -- the capture's clock, nanoseconds since the epoch
  time_precision   INTEGER NOT NULL CHECK(time_precision > 0), -- the folder's, in nanoseconds
  is_current       INTEGER NOT NULL CHECK(is_current IN (0, 1)),
  CHECK((clone_path IS NULL) = (not_kept_reason IS NOT NULL)),
  CHECK(volume_id IS NULL OR clone_path IS NOT NULL),
  CHECK((identity IS NULL) = (size IS NULL) AND (size IS NULL) = (link_count IS NULL)
        AND (link_count IS NULL) = (modified IS NULL) AND (modified IS NULL) = (changed IS NULL)),
  CHECK(clone_path IS NULL OR size IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX idx_checkpoint_shadows_current ON checkpoint_shadows(session_id, path)
  WHERE is_current = 1;
CREATE INDEX idx_checkpoint_shadows_session ON checkpoint_shadows(session_id);

-- The shadows an open window's before-capture stood on.
CREATE TABLE checkpoint_window_shadows (
  window_id  TEXT NOT NULL REFERENCES checkpoint_commands(window_id),
  shadow_id  TEXT NOT NULL REFERENCES checkpoint_shadows(shadow_id),
  PRIMARY KEY (window_id, shadow_id)
) STRICT;

CREATE INDEX idx_checkpoint_window_shadows_shadow ON checkpoint_window_shadows(shadow_id);

-- The session's own folder on each other volume a clone was kept on, `<user folder>/<session id>`.
CREATE TABLE checkpoint_volume_folders (
  session_id  TEXT NOT NULL,
  folder      TEXT NOT NULL,
  volume_id   TEXT NOT NULL,
  PRIMARY KEY (session_id, folder)
) STRICT;

-- The folders a purge owes: a purged session's folder on another volume the purge could not
-- remove, such as one whose volume was absent. Kept until the hourly sweep removes the folder,
-- which deletes its row.
CREATE TABLE checkpoint_owed_folders (
  folder     TEXT PRIMARY KEY,   -- `<user folder>/<session id>`, as the session's row held it
  volume_id  TEXT NOT NULL
) STRICT;

-- One row per change a turn recorded to a path, in the order recorded. Per path an undo puts back
-- the earliest version after its point.
CREATE TABLE checkpoint_versions (
  checkpoint_id     TEXT NOT NULL REFERENCES session_checkpoints(checkpoint_id),
  sequence          INTEGER NOT NULL CHECK(sequence >= 0), -- its order in the checkpoint
  path              TEXT NOT NULL,
  leg               TEXT NOT NULL CHECK(leg IN ('edit', 'command')),
  kind              TEXT NOT NULL CHECK(kind IN ('copy', 'created', 'notKept', 'shadow')),
  copy_hash         TEXT,                       -- the copy's SHA-256, present exactly on a copy
  mode              INTEGER CHECK(mode BETWEEN 0 AND 4095), -- the file's permission bits, on a copy
  not_kept_reason   TEXT CHECK(not_kept_reason IN ('tooLarge', 'noPlaceOnVolume', 'failed')),
  parent_real_path  TEXT NOT NULL,              -- the parent folder's real path when recorded
  window_id         TEXT REFERENCES checkpoint_commands(window_id), -- NULL on an edit
  shadow_id         TEXT REFERENCES checkpoint_shadows(shadow_id), -- present exactly on a shadow
  PRIMARY KEY (checkpoint_id, sequence),
  CHECK((kind = 'copy') = (copy_hash IS NOT NULL)),
  CHECK((kind = 'copy') = (mode IS NOT NULL)),
  CHECK((kind = 'notKept') = (not_kept_reason IS NOT NULL)),
  CHECK((kind = 'shadow') = (shadow_id IS NOT NULL))
) STRICT;

CREATE INDEX idx_checkpoint_versions_path ON checkpoint_versions(checkpoint_id, path, sequence);
CREATE INDEX idx_checkpoint_versions_shadow ON checkpoint_versions(shadow_id);

-- One row per undo request: a second request in the session with the same key reads the first's
-- outcome, and another session's key never collides with it.
CREATE TABLE session_restores (
  session_id              TEXT NOT NULL,
  client_idempotency_key  TEXT NOT NULL,
  outcome                 TEXT NOT NULL,        -- JSON: the undo's result as the wire carries it
  created_at              TEXT NOT NULL,
  PRIMARY KEY (session_id, client_idempotency_key)
) STRICT;
```

## Recovery

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
