//! Readies a repair's fresh file in the daemon's own SQLite shell, each step a child process a
//! stop ends at once, while the daemon goes on answering that it is repairing; on a file of several
//! gigabytes the full integrity check alone takes minutes. Where a copy of the newest backup's
//! database sits beside the file and holds this build's schema, each session whose readable events
//! that backup holds more of takes its events, snapshots and recovery checkpoints from it; a backup
//! that cannot be read, or that another build made, heals nothing, and the log says why it was
//! passed over. The fresh file must then hold exactly this build's tables, indexes, triggers and
//! views, each with this build's text; the rows the recovery could place in no table leave it,
//! every session is marked for a rebuild from its events, the file takes this build's schema
//! fingerprint so the next open takes it, and it must pass the full integrity check. Each step that
//! writes runs with foreign keys on, as the daemon's connections run.

use std::collections::BTreeSet;
use std::error::Error;
use std::fmt::Write as _;
use std::num::ParseIntError;
use std::path::Path;
use std::sync::LazyLock;

use rusqlite::Connection;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use sidekicks_contracts::session::event_cursor::START_OF_LOG_POSITION;
use tokio::task::JoinError;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::database::schema::recovery::ProjectionCursorState;
use crate::database::schema::{DAEMON_SCHEMA_FINGERPRINT, DAEMON_SCHEMA_SQL};
use crate::database::statement::DATABASE_NOW_SQL;
use crate::recovery::database_file::aside_copy::database_file_name;
use crate::recovery::database_file::check::SOUND_ROW;
use crate::recovery::database_file::sqlite_shell::{
    SqliteShell, SqliteShellRunError, SqliteShellScript, quote_sql_identifier, quote_sql_text,
};
use crate::recovery::database_file::store_folder;
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// The fresh file a repair readies, the backup copy it may take sessions from, and the shell its
/// steps run in.
pub struct FreshFilePreparation<'a> {
    /// The daemon's SQLite shell.
    pub shell: &'a SqliteShell,
    /// The fresh file the recovery wrote.
    pub fresh_path: &'a Path,
    /// A copy of the newest backup's database beside the file, or `None` with none.
    pub backup_copy_path: Option<&'a Path>,
}

/// Why the fresh file could not be readied, or [`FreshFileError::Stopped`] when a stop ended it.
#[derive(Debug, thiserror::Error)]
pub enum FreshFileError {
    /// A step's shell could not start or failed.
    #[error(transparent)]
    Shell(#[from] SqliteShellRunError),
    /// A stop ended a step, once its shell had exited.
    #[error("the fresh file's readying was stopped")]
    Stopped,
    /// A step's rows did not read.
    #[error("the SQLite shell's rows {step} do not read")]
    Rows {
        /// What the step was doing.
        step: &'static str,
        /// Why its rows did not read.
        #[source]
        source: serde_json::Error,
    },
    /// A step answered something other than the number it writes.
    #[error("the SQLite shell answered {answer:?} {step}")]
    Answer {
        /// What the step was doing.
        step: &'static str,
        /// What it answered.
        answer: String,
        /// Why it is no number.
        #[source]
        source: ParseIntError,
    },
    /// This build's schema could not be built in memory to compare the fresh file with.
    #[error("this build's schema could not be built to compare the recovered file with")]
    Schema(#[source] rusqlite::Error),
    /// The blocking task that built this build's schema ended before it finished.
    #[error("the task building this build's schema ended before it finished")]
    Interrupted(#[source] JoinError),
    /// The fresh file lacks an object of this build's schema, or holds one the schema does not,
    /// each named by its type and name.
    #[error("the recovered file {}", describe_schema_difference(.missing, .extra))]
    SchemaDiffers {
        /// The objects this build's schema holds that the fresh file lacks or holds otherwise.
        missing: Vec<String>,
        /// The objects the fresh file holds that this build's schema does not, or holds otherwise.
        extra: Vec<String>,
    },
    /// The full integrity check found the fresh file damaged.
    #[error("the recovered file fails its integrity check: {0}")]
    Integrity(String),
}

// The tables `.recover` puts rows in that it found no table for, matched with `ESCAPE '\'`; the
// aside copy keeps their bytes.
const LOST_AND_FOUND_TABLE_PATTERN: &str = r"lost\_and\_found%";

// The stored columns of an event, every one but none SQLite computes, in the append's order.
const STORED_EVENT_COLUMNS: &str = "id, session_id, sequence, occurred_at, monotonic_ns, category,
  type, actor, payload, correlation_id, causation_id, version, content_payload, run_id,
  run_version, turn_number";

const SNAPSHOT_COLUMNS: &str = "id, session_id, as_of_sequence, state_blob, created_at";

const CHECKPOINT_COLUMNS: &str =
    "id, session_id, checkpoint_type, as_of_sequence, state_blob, created_at";

// What every step that writes runs first: foreign keys checked as the daemon's connections check
// them.
const WRITING_STEP_PREAMBLE: &str = "PRAGMA foreign_keys = ON;\n";

// What a read of a file's schema fingerprint answers.
const READ_FINGERPRINT_SQL: &str = "PRAGMA user_version;\n";

// Every table, index, trigger and view but SQLite's own and the recovery's tables of lost rows,
// by type, name and stored text.
const SELECT_SCHEMA_OBJECTS_SQL: &str = r"SELECT type, name, sql FROM main.sqlite_schema
  WHERE name NOT LIKE 'sqlite\_%' ESCAPE '\' AND name NOT LIKE 'lost\_and\_found%' ESCAPE '\'";

// The fresh file's schema objects, then the recovery's tables of lost rows, each row saying which.
static SELECT_SCHEMA_AND_LOST_TABLES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"SELECT 'object' AS kind, type, name, sql FROM ({SELECT_SCHEMA_OBJECTS_SQL})
UNION ALL
SELECT 'lost', type, name, NULL FROM main.sqlite_schema
  WHERE type = 'table' AND name LIKE '{LOST_AND_FOUND_TABLE_PATTERN}' ESCAPE '\';
"
    )
});

// The most new cursors one statement writes.
const CURSOR_ROWS_PER_STATEMENT: usize = 500;

// What each step is doing, as a failure names it.
const READING_BACKUP_FINGERPRINT_STEP: &str = "reading the newest backup's schema fingerprint";
const TAKING_BACKUP_SESSIONS_STEP: &str = "taking sessions from the newest backup";
const READING_SCHEMA_STEP: &str = "reading the fresh file's schema";
const LISTING_CURSORLESS_STEP: &str = "listing the sessions the recovery left without a cursor";
const MARKING_STEP: &str = "dropping the lost rows and marking every session for a rebuild";
const CHECKING_INTEGRITY_STEP: &str = "checking the fresh file's integrity";

// One object of a file's schema: its type, name and stored text.
type SchemaObject = (String, String, Option<String>);

// A row of the fresh file's schema as the shell writes it: an object of the schema, or a table of
// rows the recovery placed nowhere.
#[derive(Deserialize)]
struct SchemaRow {
    kind: SchemaRowKind,
    #[serde(rename = "type")]
    object_type: String,
    name: String,
    sql: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum SchemaRowKind {
    Object,
    Lost,
}

#[derive(Deserialize)]
struct CursorlessSessionRow {
    session_id: String,
}

/// Takes each session the backup copy holds more readable events of from it, then readies the
/// fresh file, and answers how many sessions came from the backup. Fails with
/// [`FreshFileError::SchemaDiffers`] or [`FreshFileError::Integrity`] when the file is not this
/// build's or is damaged, with the step's failure when a step fails, and with
/// [`FreshFileError::Stopped`] once `stop` fires and the step's shell has exited.
pub async fn prepare_fresh_file(
    preparation: &FreshFilePreparation<'_>,
    stop: &CancellationToken,
) -> Result<u64, FreshFileError> {
    let sessions_from_backup = match preparation.backup_copy_path {
        Some(backup_copy_path) => {
            take_richer_sessions_from_backup(preparation, backup_copy_path, stop).await?
        }
        None => 0,
    };
    let lost_tables = refuse_schema_difference(preparation, stop).await?;
    drop_lost_tables_and_mark_stale(preparation, &lost_tables, stop).await?;
    refuse_failed_integrity(preparation, stop).await?;
    Ok(sessions_from_backup)
}

// Answers how many sessions came from the backup. A backup another build made, or one that cannot
// be read, is passed over with a line in the log, and its step's transaction rolls back whole.
async fn take_richer_sessions_from_backup(
    preparation: &FreshFilePreparation<'_>,
    backup_copy_path: &Path,
    stop: &CancellationToken,
) -> Result<u64, FreshFileError> {
    match read_backup_fingerprint(preparation, backup_copy_path, stop).await {
        Ok(fingerprint) if fingerprint == i64::from(*DAEMON_SCHEMA_FINGERPRINT) => {}
        Ok(fingerprint) => {
            warn!(
                fingerprint,
                "the newest backup was made by another build and was passed over"
            );
            return Ok(0);
        }
        Err(FreshFileError::Stopped) => return Err(FreshFileError::Stopped),
        Err(error) => {
            log_passed_over_backup(&error);
            return Ok(0);
        }
    }
    let copy_name = match database_file_name(backup_copy_path) {
        Ok(copy_name) => copy_name,
        Err(error) => {
            log_passed_over_backup(&error);
            return Ok(0);
        }
    };
    // The shell runs in the copy's folder and attaches the copy by its bare name, which is UTF-8,
    // so a folder whose name is not reaches the shell only as its working folder. The `database
    // shell` mode must keep the working folder its parent gives it, or the name resolves elsewhere.
    let script = format!(
        "{WRITING_STEP_PREAMBLE}ATTACH DATABASE {} AS backup;\n{}",
        quote_sql_text(copy_name),
        take_richer_sessions_sql()
    );
    let taken = run_step(
        preparation,
        &script,
        SqliteShellScript {
            step: TAKING_BACKUP_SESSIONS_STEP,
            is_read_only: false,
            is_json: false,
            working_folder: Some(store_folder(backup_copy_path)),
        },
        stop,
    )
    .await
    .and_then(|output| last_line_count(&output, TAKING_BACKUP_SESSIONS_STEP));
    match taken {
        Ok(count) => Ok(count),
        Err(FreshFileError::Stopped) => Err(FreshFileError::Stopped),
        Err(error) => {
            log_passed_over_backup(&error);
            Ok(0)
        }
    }
}

// The backup copy's schema fingerprint, read read-only through the shell.
async fn read_backup_fingerprint(
    preparation: &FreshFilePreparation<'_>,
    backup_copy_path: &Path,
    stop: &CancellationToken,
) -> Result<i64, FreshFileError> {
    let output = preparation
        .shell
        .run_script(
            backup_copy_path,
            READ_FINGERPRINT_SQL,
            SqliteShellScript {
                step: READING_BACKUP_FINGERPRINT_STEP,
                is_read_only: true,
                is_json: false,
                working_folder: None,
            },
            stop,
        )
        .await
        .map_err(|error| step_failure(error, stop))?;
    let answer = output.trim();
    answer.parse().map_err(|source| FreshFileError::Answer {
        step: READING_BACKUP_FINGERPRINT_STEP,
        answer: answer.to_owned(),
        source,
    })
}

/// Logs why the newest backup could not be read and was passed over.
pub(crate) fn log_passed_over_backup(error: &(dyn Error + 'static)) {
    warn!(
        error,
        "the newest backup could not be read and was passed over"
    );
}

// Each session whose readable events the backup holds more of than the fresh file, kept for the
// step's statements, and then the backup's events, snapshots and recovery checkpoints of each in
// place of the fresh file's, the events in sequence order so their rowids keep the log's order in
// the session. A snapshot names the event it reflects, so it goes and comes with its events, and a
// checkpoint names its sequence as a snapshot does. Ends by writing how many sessions came from
// the backup.
fn take_richer_sessions_sql() -> String {
    format!(
        "CREATE TEMP TABLE richer_sessions AS
  SELECT backup_counts.session_id AS session_id
    FROM (SELECT session_id, COUNT(*) FILTER (WHERE json_valid(payload)) AS readable
            FROM backup.session_events GROUP BY session_id) AS backup_counts
    LEFT JOIN (SELECT session_id, COUNT(*) FILTER (WHERE json_valid(payload)) AS readable
                 FROM main.session_events GROUP BY session_id) AS fresh_counts
      ON fresh_counts.session_id = backup_counts.session_id
   WHERE backup_counts.readable > COALESCE(fresh_counts.readable, 0);
BEGIN;
DELETE FROM main.session_snapshots
  WHERE session_id IN (SELECT session_id FROM temp.richer_sessions);
DELETE FROM main.recovery_checkpoints
  WHERE session_id IN (SELECT session_id FROM temp.richer_sessions);
DELETE FROM main.session_events
  WHERE session_id IN (SELECT session_id FROM temp.richer_sessions);
INSERT INTO main.session_events ({STORED_EVENT_COLUMNS})
  SELECT {STORED_EVENT_COLUMNS} FROM backup.session_events
   WHERE session_id IN (SELECT session_id FROM temp.richer_sessions)
   ORDER BY session_id, sequence;
INSERT INTO main.session_snapshots ({SNAPSHOT_COLUMNS})
  SELECT {SNAPSHOT_COLUMNS} FROM backup.session_snapshots
   WHERE session_id IN (SELECT session_id FROM temp.richer_sessions);
INSERT INTO main.recovery_checkpoints ({CHECKPOINT_COLUMNS})
  SELECT {CHECKPOINT_COLUMNS} FROM backup.recovery_checkpoints
   WHERE session_id IN (SELECT session_id FROM temp.richer_sessions);
COMMIT;
SELECT COUNT(*) FROM temp.richer_sessions;
"
    )
}

// The fresh file's tables, indexes, triggers and views must be this build's, each with this
// build's text: both sides are SQLite's stored text, since SQLite stores a statement's text
// normalized, and the shell and the daemon link one SQLite release. Answers the recovery's tables
// of lost rows.
async fn refuse_schema_difference(
    preparation: &FreshFilePreparation<'_>,
    stop: &CancellationToken,
) -> Result<Vec<String>, FreshFileError> {
    let output = run_step(
        preparation,
        &SELECT_SCHEMA_AND_LOST_TABLES_SQL,
        read_only_json(READING_SCHEMA_STEP),
        stop,
    )
    .await?;
    let mut fresh: BTreeSet<SchemaObject> = BTreeSet::new();
    let mut lost_tables = Vec::new();
    for row in json_rows::<SchemaRow>(&output, READING_SCHEMA_STEP)? {
        match row.kind {
            SchemaRowKind::Object => {
                fresh.insert((row.object_type, row.name, row.sql));
            }
            SchemaRowKind::Lost => lost_tables.push(row.name),
        }
    }
    let built = tokio::task::spawn_blocking(build_schema_objects)
        .await
        .map_err(FreshFileError::Interrupted)?
        .map_err(FreshFileError::Schema)?;
    let named = |objects: BTreeSet<&SchemaObject>| -> Vec<String> {
        objects
            .into_iter()
            .map(|(object_type, name, _)| format!("{object_type} {name}"))
            .collect()
    };
    let missing = named(built.difference(&fresh).collect());
    let extra = named(fresh.difference(&built).collect());
    if missing.is_empty() && extra.is_empty() {
        Ok(lost_tables)
    } else {
        Err(FreshFileError::SchemaDiffers { missing, extra })
    }
}

// This build's schema objects, built in a database in memory.
fn build_schema_objects() -> rusqlite::Result<BTreeSet<SchemaObject>> {
    let schema = Connection::open_in_memory()?;
    schema.execute_batch(&DAEMON_SCHEMA_SQL)?;
    let mut statement = schema.prepare(SELECT_SCHEMA_OBJECTS_SQL)?;
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect()
}

// The rows of the recovery's tables of lost rows stay in the aside copy, so the live file keeps
// no table the schema does not name. Every session with events is marked for a rebuild: its cursor
// goes stale, and one the recovery lost is written stale. The file then takes this build's schema
// fingerprint, all in one transaction.
async fn drop_lost_tables_and_mark_stale(
    preparation: &FreshFilePreparation<'_>,
    lost_tables: &[String],
    stop: &CancellationToken,
) -> Result<(), FreshFileError> {
    let cursorless_sessions: Vec<String> = json_rows::<CursorlessSessionRow>(
        &run_step(
            preparation,
            "SELECT DISTINCT session_id FROM session_events
  WHERE NOT EXISTS (SELECT 1 FROM projection_cursors
                     WHERE projection_cursors.session_id = session_events.session_id);
",
            read_only_json(LISTING_CURSORLESS_STEP),
            stop,
        )
        .await?,
        LISTING_CURSORLESS_STEP,
    )?
    .into_iter()
    .map(|row| row.session_id)
    .collect();
    let mut script = format!("{WRITING_STEP_PREAMBLE}BEGIN;\n");
    for table in lost_tables {
        writeln!(
            script,
            "SELECT COUNT(*) FROM {};",
            quote_sql_identifier(table)
        )
        .expect("a String takes every write");
    }
    for table in lost_tables {
        writeln!(script, "DROP TABLE {};", quote_sql_identifier(table))
            .expect("a String takes every write");
    }
    let stale = <&str>::from(ProjectionCursorState::Stale);
    writeln!(
        script,
        "UPDATE projection_cursors
  SET state = '{stale}', updated_at = {DATABASE_NOW_SQL}
  WHERE EXISTS (SELECT 1 FROM session_events
                 WHERE session_events.session_id = projection_cursors.session_id);"
    )
    .expect("a String takes every write");
    for sessions in cursorless_sessions.chunks(CURSOR_ROWS_PER_STATEMENT) {
        let rows: Vec<String> = sessions
            .iter()
            .map(|session_id| {
                format!(
                    "({}, {}, {START_OF_LOG_POSITION}, '{stale}', {DATABASE_NOW_SQL})",
                    quote_sql_text(&mint_uuid_v7().to_string()),
                    quote_sql_text(session_id)
                )
            })
            .collect();
        writeln!(
            script,
            "INSERT INTO projection_cursors (id, session_id, last_sequence, state, updated_at)
  VALUES {};",
            rows.join(", ")
        )
        .expect("a String takes every write");
    }
    writeln!(
        script,
        "PRAGMA user_version = {};\nCOMMIT;",
        *DAEMON_SCHEMA_FINGERPRINT
    )
    .expect("a String takes every write");
    let output = run_step(
        preparation,
        &script,
        SqliteShellScript {
            step: MARKING_STEP,
            is_read_only: false,
            is_json: false,
            working_folder: None,
        },
        stop,
    )
    .await?;
    for (table, count) in lost_tables.iter().zip(output.lines()) {
        let rows: u64 = count
            .trim()
            .parse()
            .map_err(|source| FreshFileError::Answer {
                step: MARKING_STEP,
                answer: count.to_owned(),
                source,
            })?;
        info!(
            table = table.as_str(),
            rows, "the recovery found rows it could place in no table; they stay in the copy aside"
        );
    }
    Ok(())
}

async fn refuse_failed_integrity(
    preparation: &FreshFilePreparation<'_>,
    stop: &CancellationToken,
) -> Result<(), FreshFileError> {
    let output = run_step(
        preparation,
        "PRAGMA integrity_check;\n",
        SqliteShellScript {
            step: CHECKING_INTEGRITY_STEP,
            is_read_only: true,
            is_json: false,
            working_folder: None,
        },
        stop,
    )
    .await?;
    let lines: Vec<&str> = output.trim().lines().collect();
    if lines == [SOUND_ROW] {
        Ok(())
    } else {
        Err(FreshFileError::Integrity(lines.join("; ")))
    }
}

// Runs `script` on the fresh file; a failure once `stop` fired is the stop.
async fn run_step(
    preparation: &FreshFilePreparation<'_>,
    script: &str,
    options: SqliteShellScript<'_>,
    stop: &CancellationToken,
) -> Result<String, FreshFileError> {
    preparation
        .shell
        .run_script(preparation.fresh_path, script, options, stop)
        .await
        .map_err(|error| step_failure(error, stop))
}

fn step_failure(error: SqliteShellRunError, stop: &CancellationToken) -> FreshFileError {
    if stop.is_cancelled() {
        FreshFileError::Stopped
    } else {
        FreshFileError::Shell(error)
    }
}

fn read_only_json(step: &'static str) -> SqliteShellScript<'static> {
    SqliteShellScript {
        step,
        is_read_only: true,
        is_json: true,
        working_folder: None,
    }
}

// The shell writes nothing in its JSON form for a query that answers no row.
fn json_rows<Row: DeserializeOwned>(
    output: &str,
    step: &'static str,
) -> Result<Vec<Row>, FreshFileError> {
    if output.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_slice(output.as_bytes())
        .map_err(|source| FreshFileError::Rows { step, source })
}

// The count a step writes on its last line.
fn last_line_count(output: &str, step: &'static str) -> Result<u64, FreshFileError> {
    let answer = output.trim().lines().last().unwrap_or_default();
    answer.parse().map_err(|source| FreshFileError::Answer {
        step,
        answer: answer.to_owned(),
        source,
    })
}

// What the fresh file lacks and holds against this build's schema, in words.
fn describe_schema_difference(missing: &[String], extra: &[String]) -> String {
    let lacks = (!missing.is_empty()).then(|| format!("lacks {}", missing.join(", ")));
    let holds = (!extra.is_empty())
        .then(|| format!("holds {} as this build's schema does not", extra.join(", ")));
    [lacks, holds]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" and ")
}
