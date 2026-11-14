//! The shadow rows of files over 10 MiB, which are never hashed: each shadow's clone or why none
//! was kept with the facts a later capture compares, the shadows an open window's before-capture
//! stood on, the retired shadows nothing uses any more, the session's own folders on other volumes,
//! and the folders a purge owes on volumes that were absent. Each write is a statement for the
//! caller's own write; the clones' bytes sit on disk, never in a row.

use std::borrow::Cow;
use std::sync::LazyLock;
use std::time::Duration;

use rusqlite::types::{Type, Value as SqlValue};
use rusqlite::{Connection, Row, named_params};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::{IdError, UuidText, UuidTextForm, mint_uuid_v7};
use sidekicks_platforms::{EntryIdentity, FileFacts, VolumeId};
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::{
    closed_word, optional_text_column, text_column, unsigned_integer_column,
};

use crate::checkpoints::schema::NotKeptReason;
use crate::checkpoints::store::CommandWindowId;

// The path's earlier current shadow, if any, is retired in the same write first.
const INSERT_CURRENT_SHADOW_SQL: &str = "INSERT INTO checkpoint_shadows
  (shadow_id, session_id, path, clone_path, volume_id, not_kept_reason, identity, size,
   link_count, modified, changed, taken_at, time_precision, is_current)
  VALUES (@shadowId, @sessionId, @path, @clonePath, @volumeId, @notKeptReason, @identity, @size,
          @linkCount, @modified, @changed, @takenAt, @timePrecision, 1)";

const RETIRE_CURRENT_SHADOW_SQL: &str = "UPDATE checkpoint_shadows SET is_current = 0
  WHERE session_id = @sessionId AND path = @path AND is_current = 1";

/// The condition a shadow row, named `shadows`, meets while it is retired, linked to no window and
/// named by no version.
macro_rules! unused_shadow {
    () => {
        "shadows.is_current = 0
   AND NOT EXISTS (SELECT 1 FROM checkpoint_window_shadows AS links
                    WHERE links.shadow_id = shadows.shadow_id)
   AND NOT EXISTS (SELECT 1 FROM checkpoint_versions AS versions
                    WHERE versions.shadow_id = shadows.shadow_id)"
    };
}

// The guard sits in the statement itself, so a shadow that became used is refused, never deleted.
const DELETE_UNUSED_SHADOW_SQL: &str = concat!(
    "DELETE FROM checkpoint_shadows AS shadows WHERE shadows.shadow_id = @shadowId AND ",
    unused_shadow!()
);

const LINK_WINDOW_SHADOW_SQL: &str =
    "INSERT INTO checkpoint_window_shadows (window_id, shadow_id) VALUES (@windowId, @shadowId)";

const UNLINK_WINDOW_SHADOWS_SQL: &str =
    "DELETE FROM checkpoint_window_shadows WHERE window_id = @windowId";

// A folder already kept for the session is kept as it is.
const INSERT_VOLUME_FOLDER_SQL: &str =
    "INSERT INTO checkpoint_volume_folders (session_id, folder, volume_id)
  VALUES (@sessionId, @folder, @volumeId)
  ON CONFLICT DO NOTHING";

const INSERT_OWED_FOLDER_SQL: &str =
    "INSERT INTO checkpoint_owed_folders (folder, volume_id) VALUES (@folder, @volumeId)";

const DELETE_OWED_FOLDER_SQL: &str = "DELETE FROM checkpoint_owed_folders WHERE folder = @folder";

/// A select of the shadow columns [`shadow_of`] reads, in its order, with `$tail` joined on.
macro_rules! select_shadows {
    ($($tail:tt)+) => {
        concat!(
            "SELECT shadows.shadow_id, shadows.session_id, shadows.path, shadows.clone_path,
       shadows.volume_id, shadows.not_kept_reason, shadows.identity, shadows.size,
       shadows.link_count, shadows.modified, shadows.changed, shadows.taken_at,
       shadows.time_precision
  FROM checkpoint_shadows AS shadows ",
            $($tail)+
        )
    };
}

const CURRENT_SHADOWS_SQL: &str = select_shadows!(
    "WHERE shadows.session_id = @sessionId AND shadows.is_current = 1 ORDER BY shadows.path"
);

const WINDOW_SHADOWS_SQL: &str = select_shadows!(
    "JOIN checkpoint_window_shadows AS links ON links.shadow_id = shadows.shadow_id
 WHERE links.window_id = @windowId
 ORDER BY shadows.path"
);

const UNUSED_SHADOWS_SQL: &str = select_shadows!(
    "WHERE shadows.session_id = @sessionId AND ",
    unused_shadow!(),
    " ORDER BY shadows.path"
);

// A session marked for its purge is left to the purge, which removes its clones' folder whole.
static SESSIONS_WITH_UNUSED_SHADOWS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT DISTINCT shadows.session_id FROM checkpoint_shadows AS shadows
 WHERE {}
   AND NOT EXISTS (SELECT 1 FROM sessions
                    WHERE sessions.id = shadows.session_id AND sessions.state = '{}')
 ORDER BY shadows.session_id",
        unused_shadow!(),
        <&'static str>::from(SessionState::PurgeRequested)
    )
});

const VOLUME_FOLDERS_SQL: &str = "SELECT folder, volume_id FROM checkpoint_volume_folders
  WHERE session_id = @sessionId ORDER BY folder";

const EVERY_VOLUME_FOLDER_SQL: &str = "SELECT folder, volume_id, session_id
  FROM checkpoint_volume_folders ORDER BY session_id, folder";

const OWED_FOLDERS_SQL: &str =
    "SELECT folder, volume_id FROM checkpoint_owed_folders ORDER BY folder";

/// The daemon-minted id of one shadow, which its row, the versions and windows naming it, and its
/// clone's file name carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ShadowId(UuidTextForm);

impl ShadowId {
    /// A fresh shadow id.
    pub fn mint() -> Self {
        Self(UuidTextForm::from(mint_uuid_v7()))
    }

    /// Its lowercase UUID text, as the rows keep it and its clone is named.
    pub fn text(&self) -> UuidText {
        self.0.text()
    }

    /// Reads a stored shadow id back; refuses anything but the UUID text form.
    pub(super) fn parse(text: &str) -> Result<Self, IdError> {
        UuidTextForm::new(text).map(Self)
    }
}

/// What a shadow kept of its file: a clone, or why none was kept.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShadowContent {
    /// A copy-on-write clone of the file.
    Cloned {
        /// Where the clone sits.
        clone_path: FilesystemPath,
        /// The volume holding the clone when it sits outside the capture folder, `None` inside it.
        volume_id: Option<VolumeId>,
    },
    /// No clone was kept, for `reason`.
    NotKept {
        /// Why no clone was kept.
        reason: NotKeptReason,
    },
}

/// One shadow of a file over 10 MiB, taken at a capture: what it kept and the facts a later
/// capture compares to tell whether the file changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shadow {
    /// The shadow.
    pub shadow_id: ShadowId,
    /// The session whose capture took it.
    pub session_id: SessionId,
    /// The file: the checkout's real path joined with its listed path.
    pub path: FilesystemPath,
    /// Its clone, or why none was kept.
    pub content: ShadowContent,
    /// The file's facts at the capture, `None` when their read failed. Its times are stored in
    /// nanoseconds since the epoch, saturating at `i64`'s range.
    pub facts: Option<FileFacts>,
    /// The capture's clock when it was taken, stored in nanoseconds, saturating at `i64`'s range.
    pub taken_at: jiff::Timestamp,
    /// The folder's time precision, which tells a time too close to `taken_at` to trust; stored in
    /// nanoseconds, saturating at `i64::MAX`.
    pub time_precision: Duration,
}

/// The session's own folder on a volume other than its capture folder's, which holds its clones
/// there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VolumeFolder {
    /// The volume.
    pub volume_id: VolumeId,
    /// The folder, `<user folder>/<session id>`.
    pub folder: FilesystemPath,
}

/// The row of `shadow`, its path's current shadow in its session. Refused by SQLite when the
/// path already holds a current shadow there, so the write retires that one first.
pub fn insert_current_shadow_statement(shadow: &Shadow) -> WriteStatement {
    let (clone_path, volume_id, not_kept_reason) = match &shadow.content {
        ShadowContent::Cloned {
            clone_path,
            volume_id,
        } => (
            Some(clone_path.as_str()),
            volume_id.as_ref().map(ToString::to_string),
            None,
        ),
        ShadowContent::NotKept { reason } => (None, None, Some(<&'static str>::from(*reason))),
    };
    let facts = shadow.facts.as_ref();
    let identity = facts.map(|facts| facts.identity.to_string());
    WriteStatement {
        sql: Cow::Borrowed(INSERT_CURRENT_SHADOW_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@shadowId", shadow.shadow_id.text().as_str()),
            text_binding("@sessionId", shadow.session_id.text().as_str()),
            text_binding("@path", shadow.path.as_str()),
            nullable_text_binding("@clonePath", clone_path),
            nullable_text_binding("@volumeId", volume_id.as_deref()),
            nullable_text_binding("@notKeptReason", not_kept_reason),
            nullable_text_binding("@identity", identity.as_deref()),
            integer_binding("@size", facts.map(|facts| saturating(facts.size))),
            integer_binding(
                "@linkCount",
                facts.map(|facts| saturating(facts.link_count)),
            ),
            integer_binding("@modified", facts.map(|facts| saturating(facts.modified))),
            integer_binding("@changed", facts.map(|facts| saturating(facts.changed))),
            integer_binding(
                "@takenAt",
                Some(saturating(shadow.taken_at.as_nanosecond())),
            ),
            integer_binding(
                "@timePrecision",
                Some(saturating(shadow.time_precision.as_nanos())),
            ),
        ]),
        expected_row_count: Some(1),
    }
}

/// The retire of `session_id`'s current shadow of `path`, which stays while a window or a version
/// names it. Refused when the path holds no current shadow in that session, since its caller reads
/// the current shadows first.
pub fn retire_current_shadow_statement(
    session_id: SessionId,
    path: &FilesystemPath,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RETIRE_CURRENT_SHADOW_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@path", path.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The delete of the row of `shadow_id` while it is retired, linked to no window and named by no
/// version; refused otherwise, as when the shadow became used since it was read.
pub fn delete_unused_shadow_statement(shadow_id: ShadowId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(DELETE_UNUSED_SHADOW_SQL),
        bindings: StatementBindings::Named(vec![text_binding(
            "@shadowId",
            shadow_id.text().as_str(),
        )]),
        expected_row_count: Some(1),
    }
}

/// The link of an open window to a shadow its before-capture stood on. Refused by SQLite when the
/// window or the shadow has no row, or the link is already kept.
pub fn link_window_shadow_statement(
    window_id: CommandWindowId,
    shadow_id: ShadowId,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(LINK_WINDOW_SHADOW_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@windowId", window_id.text().as_str()),
            text_binding("@shadowId", shadow_id.text().as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The removal of every link of `window_id` to a shadow, as the window closes; writes nothing for
/// a window that linked none.
pub fn unlink_window_shadows_statement(window_id: CommandWindowId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(UNLINK_WINDOW_SHADOWS_SQL),
        bindings: StatementBindings::Named(vec![text_binding(
            "@windowId",
            window_id.text().as_str(),
        )]),
        expected_row_count: None,
    }
}

/// The row of `session_id`'s folder `folder`; a folder already kept for the session writes
/// nothing.
pub fn insert_volume_folder_statement(
    session_id: SessionId,
    folder: &VolumeFolder,
) -> WriteStatement {
    let volume_id = folder.volume_id.to_string();
    WriteStatement {
        sql: Cow::Borrowed(INSERT_VOLUME_FOLDER_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@folder", folder.folder.as_str()),
            text_binding("@volumeId", &volume_id),
        ]),
        expected_row_count: None,
    }
}

/// The row of `folder`, owed by its purged session until its volume is back, written in the write
/// that deletes the folder's row in its session. Refused by SQLite when the folder is already
/// owed, which no purge meets, since a folder is named for its one session.
pub fn insert_owed_folder_statement(folder: &VolumeFolder) -> WriteStatement {
    let volume_id = folder.volume_id.to_string();
    WriteStatement {
        sql: Cow::Borrowed(INSERT_OWED_FOLDER_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@folder", folder.folder.as_str()),
            text_binding("@volumeId", &volume_id),
        ]),
        expected_row_count: Some(1),
    }
}

/// The delete of the owed row of `folder`, once the folder is gone; writes nothing for a folder
/// owed by no row.
pub fn delete_owed_folder_statement(folder: &FilesystemPath) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(DELETE_OWED_FOLDER_SQL),
        bindings: StatementBindings::Named(vec![text_binding("@folder", folder.as_str())]),
        expected_row_count: None,
    }
}

/// `session_id`'s current shadows, by path. Fails as SQLite does, or when a stored column does not
/// read.
pub fn current_shadows(
    connection: &Connection,
    session_id: SessionId,
) -> rusqlite::Result<Vec<Shadow>> {
    connection
        .prepare_cached(CURRENT_SHADOWS_SQL)?
        .query_map(
            named_params! { "@sessionId": session_id.text().as_str() },
            shadow_of,
        )?
        .collect()
}

/// The shadows `window_id`'s before-capture stood on, current or retired since, by path. Fails as
/// SQLite does, or when a stored column does not read.
pub fn window_shadows(
    connection: &Connection,
    window_id: CommandWindowId,
) -> rusqlite::Result<Vec<Shadow>> {
    connection
        .prepare_cached(WINDOW_SHADOWS_SQL)?
        .query_map(
            named_params! { "@windowId": window_id.text().as_str() },
            shadow_of,
        )?
        .collect()
}

/// `session_id`'s shadows that are retired, linked to no window and named by no version, by path.
/// The caller removes each one's clone only after its delete committed, so a row never names a
/// clone that is gone. Fails as SQLite does, or when a stored column does not read.
pub fn unused_shadows(
    connection: &Connection,
    session_id: SessionId,
) -> rusqlite::Result<Vec<Shadow>> {
    connection
        .prepare_cached(UNUSED_SHADOWS_SQL)?
        .query_map(
            named_params! { "@sessionId": session_id.text().as_str() },
            shadow_of,
        )?
        .collect()
}

/// The sessions, none marked for its purge, holding a shadow that is retired, linked to no window
/// and named by no version, in id order. Fails as SQLite does, or when a stored id does not read.
pub fn sessions_with_unused_shadows(connection: &Connection) -> rusqlite::Result<Vec<SessionId>> {
    connection
        .prepare_cached(&SESSIONS_WITH_UNUSED_SHADOWS_SQL)?
        .query_map([], |row| text_column(row, 0, |text| SessionId::new(&text)))?
        .collect()
}

/// `session_id`'s own folders on other volumes, by folder. Fails as SQLite does, or when a stored
/// column does not read.
pub fn volume_folders(
    connection: &Connection,
    session_id: SessionId,
) -> rusqlite::Result<Vec<VolumeFolder>> {
    connection
        .prepare_cached(VOLUME_FOLDERS_SQL)?
        .query_map(
            named_params! { "@sessionId": session_id.text().as_str() },
            volume_folder_of,
        )?
        .collect()
}

/// Every session's own folders on other volumes, by session and then folder. Fails as SQLite does,
/// or when a stored column does not read.
pub fn every_volume_folder(
    connection: &Connection,
) -> rusqlite::Result<Vec<(SessionId, VolumeFolder)>> {
    connection
        .prepare_cached(EVERY_VOLUME_FOLDER_SQL)?
        .query_map([], |row| {
            Ok((
                text_column(row, 2, |text| SessionId::new(&text))?,
                volume_folder_of(row)?,
            ))
        })?
        .collect()
}

/// The folders purges still owe on volumes that were absent, by folder. Fails as SQLite does, or
/// when a stored column does not read.
pub fn owed_folders(connection: &Connection) -> rusqlite::Result<Vec<VolumeFolder>> {
    connection
        .prepare_cached(OWED_FOLDERS_SQL)?
        .query_map([], volume_folder_of)?
        .collect()
}

fn integer_binding(name: &'static str, value: Option<i64>) -> (Cow<'static, str>, SqlValue) {
    (Cow::Borrowed(name), SqlValue::from(value))
}

/// `value` as a stored INTEGER, held at `i64`'s bound when past it.
fn saturating<Integer>(value: Integer) -> i64
where
    Integer: TryInto<i64> + PartialOrd + Default,
{
    let is_negative = value < Integer::default();
    value
        .try_into()
        .unwrap_or(if is_negative { i64::MIN } else { i64::MAX })
}

// Reads a folder and its volume id, in that order.
fn volume_folder_of(row: &Row<'_>) -> rusqlite::Result<VolumeFolder> {
    Ok(VolumeFolder {
        folder: text_column(row, 0, FilesystemPath::new)?,
        volume_id: text_column(row, 1, |text| text.parse::<VolumeId>())?,
    })
}

// Reads the columns `select_shadows!` takes, in its order. A stored size, link count and time
// precision are never negative, so `unsigned_integer_column` reads each as unsigned.
fn shadow_of(row: &Row<'_>) -> rusqlite::Result<Shadow> {
    let content = match optional_text_column(row, 3, FilesystemPath::new)? {
        Some(clone_path) => ShadowContent::Cloned {
            clone_path,
            volume_id: optional_text_column(row, 4, |text| text.parse::<VolumeId>())?,
        },
        None => ShadowContent::NotKept {
            reason: text_column(row, 5, closed_word)?,
        },
    };
    let facts = match optional_text_column(row, 6, |text| text.parse::<EntryIdentity>())? {
        Some(identity) => Some(FileFacts {
            identity,
            size: unsigned_integer_column(row, 7)?,
            link_count: unsigned_integer_column(row, 8)?,
            modified: i128::from(row.get::<_, i64>(9)?),
            changed: i128::from(row.get::<_, i64>(10)?),
        }),
        None => None,
    };
    let taken_at =
        jiff::Timestamp::from_nanosecond(i128::from(row.get::<_, i64>(11)?)).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(11, Type::Integer, error.into())
        })?;
    Ok(Shadow {
        shadow_id: text_column(row, 0, |text| ShadowId::parse(&text))?,
        session_id: text_column(row, 1, |text| SessionId::new(&text))?,
        path: text_column(row, 2, FilesystemPath::new)?,
        content,
        facts,
        taken_at,
        time_precision: Duration::from_nanos(unsigned_integer_column(row, 12)?),
    })
}
