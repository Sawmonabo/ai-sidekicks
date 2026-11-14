//! The checkpoint tables of the daemon's one schema: one checkpoint per prompt that opened or
//! steered a turn, the versions each path took in it, the command windows its commands ran in, the
//! shadows of files over 10 MiB with the windows that stand on them and the session's folders on
//! other volumes, the folders a purge still owes on volumes that were absent, and each undo's saved
//! outcome by its request's key.
//!
//! These rows are their own truth, written as the turn runs and never rebuilt from the log. A
//! version names its copy by hash or its shadow by id; the bytes sit on disk, never in a row.

use serde::Deserialize;
use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_contracts::session::restore::SessionRestoreSkipReason;
use sidekicks_store::database::schema::{SchemaPart, SchemaParts};
use sidekicks_store::database::sql_list::sql_list_of_every;
use strum::{EnumDiscriminants, IntoStaticStr, VariantArray};

use crate::checkpoints::store::shadows::ShadowId;

/// Which leg recorded a version, as the `checkpoint_versions.leg` column holds it: a file tool's
/// edit, copied before the write, or a command's change, read from its window's captures.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, VariantArray, IntoStaticStr)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum CheckpointVersionLeg {
    /// A file tool's edit.
    Edit,
    /// A command's change.
    Command,
}

/// Why no copy of a path's content was kept, as the `not_kept_reason` columns hold it: a file over
/// 10 MiB no clone could hold, a path that was no regular file before the change, or a failed read
/// or clone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, VariantArray, IntoStaticStr)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum NotKeptReason {
    /// A file over 10 MiB on a disk that cannot clone it.
    TooLarge,
    /// A file over 10 MiB whose checkout is its volume's top, so no place on that volume could hold
    /// its clone.
    NoPlaceOnVolume,
    /// The path was a symbolic link before the change.
    SymbolicLink,
    /// The path was a pipe, a socket, a device or a folder before the change.
    NotARegularFile,
    /// The file's read or clone failed for another reason.
    Failed,
}

impl NotKeptReason {
    /// The skip an undo names for a path that kept no copy for this reason: a large file no clone
    /// held, or a path that was no regular file. `None` for a failed read or clone, which the undo
    /// names under its failed files instead.
    pub fn skip_reason(self) -> Option<SessionRestoreSkipReason> {
        match self {
            Self::TooLarge => Some(SessionRestoreSkipReason::TooLarge),
            Self::NoPlaceOnVolume => Some(SessionRestoreSkipReason::NoPlaceOnVolume),
            Self::SymbolicLink => Some(SessionRestoreSkipReason::SymbolicLink),
            Self::NotARegularFile => Some(SessionRestoreSkipReason::NotARegularFile),
            Self::Failed => None,
        }
    }
}

/// What a version kept of its path's content before the change: a copy by its hash, the fact the
/// path was absent, a large file's shadow, or no copy and why. Its kind is the word the
/// `checkpoint_versions.kind` column holds.
#[derive(Clone, Debug, PartialEq, Eq, EnumDiscriminants)]
#[strum_discriminants(
    name(CheckpointVersionKind),
    doc = "Which content a version kept, as the `checkpoint_versions.kind` column holds it.",
    derive(Deserialize, IntoStaticStr, VariantArray),
    serde(rename_all = "camelCase"),
    strum(serialize_all = "camelCase")
)]
pub enum CheckpointVersionContent {
    /// The content before the change, copied under its SHA-256.
    Copy {
        /// The copy's SHA-256, which names its file under the capture folder.
        hash: Sha256Hex,
        /// The mode an undo puts back with the bytes: copies of one content are shared, so the
        /// copy's own mode is the first copier's.
        mode: CopyMode,
    },
    /// The path was absent before the change, so an undo deletes it.
    Created,
    /// No copy was kept, for `reason`.
    NotKept {
        /// Why no copy was kept.
        reason: NotKeptReason,
    },
    /// The content before the change, kept as the clone its shadow names, for a file over 10 MiB,
    /// which is never hashed.
    Shadow {
        /// The shadow whose clone holds the content.
        shadow_id: ShadowId,
    },
}

/// The mode a copy is put back with: the executable bit alone, all a command's capture tree holds,
/// or the permission bits (`mode & 0o7777`) an edit's copy reads from the file. An undo puts either
/// back with the bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CopyMode {
    /// Whether the file was executable, as git keeps it.
    Executable(bool),
    /// The file's permission bits.
    Permissions(u32),
}

/// The runs' list and the checkpoint tables' own part.
pub fn schema_parts() -> SchemaParts {
    crate::run::schema::schema_parts()
        .with_part(SchemaPart::new("checkpoints", checkpoint_schema_sql()))
}

fn checkpoint_schema_sql() -> String {
    let legs = sql_list_of_every::<CheckpointVersionLeg>();
    let kinds = sql_list_of_every::<CheckpointVersionKind>();
    let copy = <&'static str>::from(CheckpointVersionKind::Copy);
    let not_kept = <&'static str>::from(CheckpointVersionKind::NotKept);
    let shadow = <&'static str>::from(CheckpointVersionKind::Shadow);
    let not_kept_reasons = sql_list_of_every::<NotKeptReason>();
    format!(
        "
-- One row per prompt that opened or steered a turn, and per turn start no new prompt opened: the
-- point an undo goes back to, before that message or that turn.
CREATE TABLE session_checkpoints (
  checkpoint_id     TEXT PRIMARY KEY,           -- the snapshot id a client names it by
  session_id        TEXT NOT NULL,
  message_sequence  INTEGER NOT NULL CHECK(message_sequence >= 0), -- the prompt's place in the log
  run_id            TEXT NOT NULL,
  turn_number       INTEGER NOT NULL CHECK(turn_number >= 1),  -- the turn it opened or steered
  -- The queue item a turn's start was opened with where no message of its own stands at the row:
  -- a review, or a message an earlier turn sent; NULL on a prompt's row and a provider's turn.
  turn_opening_id   TEXT,
  epoch             INTEGER NOT NULL CHECK(epoch >= 0),     -- the run's execution epoch
  position          INTEGER NOT NULL CHECK(position >= 0),  -- the prompt's run position
  created_at        TEXT NOT NULL,
  UNIQUE (session_id, message_sequence)
) STRICT;

-- A turn's checkpoints, its start's first, which an undo to a steer reads its turn's start by.
CREATE INDEX idx_session_checkpoints_turn ON session_checkpoints(run_id, turn_number, position);

-- One row per command window: the captures before and after a command the agent ran, and
-- whether its before-capture was taken before it ran.
CREATE TABLE checkpoint_commands (
  window_id        TEXT PRIMARY KEY,
  checkpoint_id    TEXT NOT NULL REFERENCES session_checkpoints(checkpoint_id),
  -- The before-capture's tree, its commit, the repository's common git folder it went into, and
  -- a JSON array of the folders the project ignored then, each an absolute path: all four NULL
  -- exactly when the before-capture failed.
  tree_before      TEXT,
  head_before      TEXT,
  -- The captures' commits, whose trailers name the paths each left out; the after's is NULL until
  -- the window closes, or when that capture failed.
  commit_before    TEXT,
  git_common_dir   TEXT,
  ignored_folders  TEXT,
  tree_after       TEXT,                        -- NULL until it closes, or when that capture failed
  head_after       TEXT,
  commit_after     TEXT,
  -- Set as it closes; false names it in the dry run's uncovered commands.
  covered          INTEGER CHECK(covered IN (0, 1)),
  command          TEXT NOT NULL,
  tool_call_id     TEXT,                        -- the provider's tool call, NULL when none ran it
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  CHECK((ended_at IS NULL) = (covered IS NULL)),
  CHECK((tree_before IS NULL) = (commit_before IS NULL)
        AND (commit_before IS NULL) = (git_common_dir IS NULL)
        AND (git_common_dir IS NULL) = (ignored_folders IS NULL))
) STRICT;

CREATE INDEX idx_checkpoint_commands_checkpoint ON checkpoint_commands(checkpoint_id);
-- The windows a stop left open, which the next start settles.
CREATE INDEX idx_checkpoint_commands_open ON checkpoint_commands(checkpoint_id)
  WHERE ended_at IS NULL;

-- One row per shadow of a file over 10 MiB, which is never hashed: its clone, or why none was
-- kept, and the facts a later capture compares to tell whether the file changed. A path holds one
-- current shadow per session; a retired one stays while a window or a version names it.
CREATE TABLE checkpoint_shadows (
  shadow_id        TEXT PRIMARY KEY,            -- also the clone's file name
  session_id       TEXT NOT NULL,
  path             TEXT NOT NULL,               -- the listed path under the checkout's real path
  clone_path       TEXT,                        -- NULL when no clone was kept
  volume_id        TEXT,                        -- set only for a clone outside the capture folder
  not_kept_reason  TEXT CHECK(not_kept_reason IN ({not_kept_reasons})),
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

-- A purged session's folder on another volume that was absent when the purge ran; removed,
-- and its row deleted, once that volume is back.
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
  leg               TEXT NOT NULL CHECK(leg IN ({legs})),
  kind              TEXT NOT NULL CHECK(kind IN ({kinds})),
  copy_hash         TEXT,                       -- the copy's SHA-256, present exactly on a copy
  -- A copy's mode, exactly one of the two: the executable bit a command's capture tree holds, or
  -- the permission bits an edit's copy read.
  is_executable     INTEGER CHECK(is_executable IN (0, 1)),
  permissions       INTEGER CHECK(permissions BETWEEN 0 AND 4095),
  not_kept_reason   TEXT CHECK(not_kept_reason IN ({not_kept_reasons})),
  parent_real_path  TEXT NOT NULL,              -- the parent folder's real path when recorded
  window_id         TEXT REFERENCES checkpoint_commands(window_id), -- NULL on an edit
  shadow_id         TEXT REFERENCES checkpoint_shadows(shadow_id), -- present exactly on a shadow
  tool_call_id      TEXT,                       -- the provider's tool call that made an edit version
  PRIMARY KEY (checkpoint_id, sequence),
  CHECK((kind = '{copy}') = (copy_hash IS NOT NULL)),
  CHECK(CASE WHEN kind = '{copy}' THEN (is_executable IS NULL) <> (permissions IS NULL)
             ELSE is_executable IS NULL AND permissions IS NULL END),
  CHECK(window_id IS NULL OR tool_call_id IS NULL),
  CHECK((kind = '{not_kept}') = (not_kept_reason IS NOT NULL)),
  CHECK((kind = '{shadow}') = (shadow_id IS NOT NULL))
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

-- An undo's conversation cut, recorded once the cut applied, so a retry under the same key never
-- cuts again and finishes the files to the checkpoint the cut read.
CREATE TABLE session_restore_cuts (
  session_id              TEXT NOT NULL,
  client_idempotency_key  TEXT NOT NULL,
  checkpoint_id           TEXT NOT NULL,        -- the checkpoint the undo's files go back to
  files_outcome           TEXT,                 -- JSON: what the files' put-back did, once it ended
  created_at              TEXT NOT NULL,
  PRIMARY KEY (session_id, client_idempotency_key)
) STRICT;

-- An undo's edited message, kept from before its cut until its hold is let go; a row a stop left
-- goes back into the session's draft at the next start.
CREATE TABLE session_restore_resends (
  session_id              TEXT NOT NULL,
  client_idempotency_key  TEXT NOT NULL,
  resend                  TEXT NOT NULL,        -- JSON: the edited message as the wire carries it
  created_at              TEXT NOT NULL,
  PRIMARY KEY (session_id, client_idempotency_key)
) STRICT;
"
    )
}
