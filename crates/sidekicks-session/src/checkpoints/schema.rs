//! The checkpoint tables of the daemon's one schema: one checkpoint per turn-starting prompt, the
//! versions each path took in it, the command windows its commands ran in, and each undo's saved
//! outcome by its request's key.
//!
//! These rows are their own truth, written as the turn runs and never rebuilt from the log. A
//! version names its copy by hash; the copy's bytes sit in the owner's capture folder.

use serde::Deserialize;
use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_contracts::session::restore::SessionRestoreSkipReason;
use sidekicks_store::database::schema::{SchemaPart, SchemaParts};
use sidekicks_store::database::sql_list::{sql_list_of, sql_list_of_every};
use strum::{EnumDiscriminants, IntoStaticStr, VariantArray};

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

/// What a version kept of its path's content before the change: a copy by its hash, the fact the
/// path was absent, or no copy and the skip an undo names for it. Its kind is the word the
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
    },
    /// The path was absent before the change, so an undo deletes it.
    Created,
    /// No copy was kept; an undo skips the path for `reason`.
    NotKept {
        /// The skip an undo names for the path.
        reason: SessionRestoreSkipReason,
    },
}

/// The skips a version kept without a copy carries.
pub const NOT_KEPT_REASONS: [SessionRestoreSkipReason; 1] = [SessionRestoreSkipReason::TooLarge];

/// The runs' list and the checkpoint tables' own part.
pub fn schema_parts() -> SchemaParts {
    crate::run::schema::schema_parts()
        .with_part(SchemaPart::new("checkpoints", checkpoint_schema_sql()))
}

/// The word a skip reason is stored as, its wire spelling.
pub(crate) fn skip_reason_word(reason: SessionRestoreSkipReason) -> String {
    serde_json::to_value(reason)
        .ok()
        .and_then(|word| word.as_str().map(str::to_owned))
        .expect("a skip reason serializes as its word")
}

fn checkpoint_schema_sql() -> String {
    let legs = sql_list_of_every::<CheckpointVersionLeg>();
    let kinds = sql_list_of_every::<CheckpointVersionKind>();
    let copy = <&'static str>::from(CheckpointVersionKind::Copy);
    let not_kept = <&'static str>::from(CheckpointVersionKind::NotKept);
    let not_kept_words = NOT_KEPT_REASONS.map(skip_reason_word);
    let not_kept_reasons = sql_list_of(not_kept_words.iter().map(String::as_str));
    format!(
        "
-- One row per turn-starting prompt: the point an undo goes back to, before that message.
CREATE TABLE session_checkpoints (
  checkpoint_id     TEXT PRIMARY KEY,           -- the snapshot id a client names it by
  session_id        TEXT NOT NULL,
  message_sequence  INTEGER NOT NULL CHECK(message_sequence >= 0), -- the prompt's place in the log
  run_id            TEXT NOT NULL,
  epoch             INTEGER NOT NULL CHECK(epoch >= 0),     -- the run's execution epoch
  position          INTEGER NOT NULL CHECK(position >= 0),  -- the turn's position in it
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
  tree_after     TEXT,                          -- NULL until it closes, or when that capture failed
  head_after     TEXT,
  -- Set as it closes; false names it in the dry run's uncovered commands.
  covered        INTEGER CHECK(covered IN (0, 1)),
  command        TEXT NOT NULL,
  tool_call_id   TEXT,                          -- the provider's tool call, NULL when none ran it
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  CHECK((ended_at IS NULL) = (covered IS NULL))
) STRICT;

CREATE INDEX idx_checkpoint_commands_checkpoint ON checkpoint_commands(checkpoint_id);

-- One row per change a turn recorded to a path, in the order recorded. Per path an undo puts back
-- the earliest version after its point.
CREATE TABLE checkpoint_versions (
  checkpoint_id     TEXT NOT NULL REFERENCES session_checkpoints(checkpoint_id),
  sequence          INTEGER NOT NULL CHECK(sequence >= 0), -- its order in the checkpoint
  path              TEXT NOT NULL,
  leg               TEXT NOT NULL CHECK(leg IN ({legs})),
  kind              TEXT NOT NULL CHECK(kind IN ({kinds})),
  copy_hash         TEXT,                       -- the copy's SHA-256, present exactly on a copy
  not_kept_reason   TEXT CHECK(not_kept_reason IN ({not_kept_reasons})),
  parent_real_path  TEXT NOT NULL,              -- the parent folder's real path when recorded
  window_id         TEXT REFERENCES checkpoint_commands(window_id), -- NULL on an edit
  volume_id         TEXT,                       -- the shadow's volume, NULL for the capture folder
  PRIMARY KEY (checkpoint_id, sequence),
  CHECK((kind = '{copy}') = (copy_hash IS NOT NULL)),
  CHECK((kind = '{not_kept}') = (not_kept_reason IS NOT NULL))
) STRICT;

CREATE INDEX idx_checkpoint_versions_path ON checkpoint_versions(checkpoint_id, path, sequence);

-- One row per undo request: a second request with the same key reads the first's outcome.
CREATE TABLE session_restores (
  client_idempotency_key  TEXT PRIMARY KEY,
  session_id              TEXT NOT NULL,
  outcome                 TEXT NOT NULL,        -- JSON: the undo's result as the wire carries it
  created_at              TEXT NOT NULL
) STRICT;

CREATE INDEX idx_session_restores_session ON session_restores(session_id);
"
    )
}
