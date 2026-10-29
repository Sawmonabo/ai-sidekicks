//! The database file as a start opens it and a stop closes it. A file a run found damaged is
//! repaired first, while the run folder's socket answers that the daemon is repairing; one the
//! repair cannot heal fails the start, naming why and where its copy aside is, and a stop during
//! the repair ends the start, the file left for the next. The writer then opens the file, and its
//! structural check runs beside the daemon at every start but the first. After any end of the last
//! run, clean or not, writes go at once, since nothing but a checkpoint the storage did not flush
//! damages the file and the writer's checkpoints flush it; a file something else changed since the
//! last run, or with no record of one, holds every write until the check finds it sound. A check
//! that cannot run leaves the daemon taking writes, reading as degraded, and the file unvouched, so
//! the next start checks it before it writes again. Damage the check or any read or write meets
//! marks the store failed and ends the writer at once, so no later write reaches the file and the
//! writer's close skips the checkpoint that would fold the log into it; the daemon then stops,
//! recording the damage beside the file, and its next start repairs it before anything opens it.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::pin::pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};

use jiff::Timestamp;
use sidekicks_approval::reviewer_denials::REVIEWER_DENIALS_STATEMENT_CAPACITY;
use sidekicks_approval::rules::APPROVAL_RULES_STATEMENT_CAPACITY;
use sidekicks_approval::store::APPROVAL_REQUEST_READER_STATEMENT_CAPACITY;
use sidekicks_artifact::plans::service::PLANS_STATEMENT_CAPACITY;
use sidekicks_artifact::schema::ARTIFACT_STATEMENT_CAPACITY;
use sidekicks_ipc::caller_process::contract::CallerProcessReader;
use sidekicks_platforms::DaemonRunFolder;
use sidekicks_provider::driver::capabilities::writer::DRIVER_CAPABILITIES_WRITER_STATEMENT_CAPACITY;
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_provider::runtime_binding::store::RUNTIME_BINDING_STORE_STATEMENT_CAPACITY;
use sidekicks_queue::provider_session::PROVIDER_SESSIONS_STATEMENT_CAPACITY;
use sidekicks_recovery::damaged_history::DAMAGED_HISTORY_STATEMENT_CAPACITY;
use sidekicks_recovery::database_file::check::{DatabaseFileCheck, DatabaseFileCheckAnswer};
use sidekicks_recovery::database_file::copy::DatabaseFileCopier;
use sidekicks_recovery::database_file::last_run::{
    LastRunEnd, LastRunError, forget_last_run, read_last_run_end, record_clean_stop,
    record_run_start,
};
use sidekicks_recovery::database_file::repair::{
    DatabaseFileRepairFailure, DatabaseFileRepairOptions,
};
use sidekicks_recovery::database_file::sqlite_shell::SqliteShell;
use sidekicks_recovery::projection_rebuild::PROJECTION_REBUILD_STATEMENT_CAPACITY;
use sidekicks_recovery::restart_settle::RESTART_SETTLE_STATEMENT_CAPACITY;
use sidekicks_recovery::session_write_refusal::refuse_session_event;
use sidekicks_recovery::startup::STARTUP_RECOVERY_STATEMENT_CAPACITY;
use sidekicks_recovery::status::RecoveryStatusTracker;
use sidekicks_session::auto_title::SESSION_AUTO_TITLE_STATEMENT_CAPACITY;
use sidekicks_session::changes::SESSION_CHANGES_STATEMENT_CAPACITY;
use sidekicks_session::conversation_purge::CONVERSATION_PURGE_STATEMENT_CAPACITY;
use sidekicks_session::convert::SESSION_CONVERSION_STATEMENT_CAPACITY;
use sidekicks_session::create::SESSION_CREATION_STATEMENT_CAPACITY;
use sidekicks_session::directory::list_feed::rows::SESSION_LIST_ROWS_STATEMENT_CAPACITY;
use sidekicks_session::directory::provider_port::SESSION_DIRECTORY_PROVIDER_PORT_STATEMENT_CAPACITY;
use sidekicks_session::directory::row::{DirectoryEvent, directory_statements_for};
use sidekicks_session::directory::run_activity::PROJECT_SESSION_ACTIVITY_STATEMENT_CAPACITY;
use sidekicks_session::draft_store::SESSION_DRAFT_STORE_STATEMENT_CAPACITY;
use sidekicks_session::interventions::service::INTERVENTION_SERVICE_STATEMENT_CAPACITY;
use sidekicks_session::links::service::SESSION_LINK_SERVICE_STATEMENT_CAPACITY;
use sidekicks_session::questions::projection::question_projection_statements;
use sidekicks_session::questions::service::QUESTION_STATEMENT_CAPACITY;
use sidekicks_session::related::ranking::RELATED_RANKING_STATEMENT_CAPACITY;
use sidekicks_session::review_note::store::REVIEW_NOTE_STORE_STATEMENT_CAPACITY;
use sidekicks_session::run::binding_cursors::RUN_BINDING_CURSORS_STATEMENT_CAPACITY;
use sidekicks_session::run::engine::RUN_ENGINE_STATEMENT_CAPACITY;
use sidekicks_session::run::folders::SESSION_LIVE_RUN_FOLDERS_STATEMENT_CAPACITY;
use sidekicks_session::run::live_bindings::LIVE_RUN_BINDINGS_STATEMENT_CAPACITY;
use sidekicks_session::run::live_count::count_live_runs_after_commits;
use sidekicks_session::run::pause::RUN_PAUSE_STATEMENT_CAPACITY;
use sidekicks_session::run::provider_choice::PROVIDER_CHOICE_STATEMENT_CAPACITY;
use sidekicks_session::search::files::service::FILE_SEARCH_STATEMENT_CAPACITY;
use sidekicks_session::search::index::outbox::OUTBOX_STATEMENT_CAPACITY;
use sidekicks_session::service::SESSION_SERVICE_STATEMENT_CAPACITY;
use sidekicks_session::tags::SESSION_TAG_SERVICE_STATEMENT_CAPACITY;
use sidekicks_session::working_folder::SESSION_WORKING_FOLDERS_STATEMENT_CAPACITY;
use sidekicks_std::bounded_wait::wait_within;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::file::atomic_write::AtomicWriteError;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadPool, DatabaseReadPoolCloseError,
};
use sidekicks_store::database::connection::writer_open::{DatabaseOpenError, open_database};
use sidekicks_store::database::damage::{
    DatabaseDamageWatch, is_database_damage_error, record_database_damage,
};
use sidekicks_store::database::schema::DatabaseSchema;
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::database::wal_truncation::WriteAheadLogTruncation;
use sidekicks_store::database::writer::{
    DatabaseWriter, DatabaseWriterOpenError, DatabaseWriterOptions, ThreadJoinError,
    WriteFailureListener, WriterCloseError, WritesHeldError,
};
use sidekicks_store::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies, ProjectionError,
};
use sidekicks_store::events::session::appender::UnsequencedEventEnvelope;
use sidekicks_store::events::session::followers::SessionEventFollowers;
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use sidekicks_store::machine::registry::MACHINE_REGISTRY_STATEMENT_CAPACITY;
use sidekicks_workflow::definitions::drafts::WORKFLOW_DRAFT_STORE_STATEMENT_CAPACITY;
use sidekicks_workflow::definitions::kept_values::WORKFLOW_KEPT_VALUE_STORE_STATEMENT_CAPACITY;
use sidekicks_workflow::definitions::library::WORKFLOW_LIBRARY_STATEMENT_CAPACITY;
use sidekicks_workflow::definitions::store::WORKFLOW_DEFINITION_STORE_STATEMENT_CAPACITY;
use sidekicks_workflow::definitions::versions::history::WORKFLOW_VERSIONS_STATEMENT_CAPACITY;
use sidekicks_workflow::runs::attention::WORKFLOW_RUN_ATTENTION_STATEMENT_CAPACITY;
use sidekicks_workflow::runs::deletion::WORKFLOW_RUN_DELETION_STATEMENT_CAPACITY;
use sidekicks_workflow::runs::step_payload::WORKFLOW_STEP_PAYLOAD_STATEMENT_CAPACITY;
use sidekicks_workflow::runs::store::WORKFLOW_RUN_STORE_STATEMENT_CAPACITY;
use sidekicks_workspace::clone::requests::CLONE_REQUESTS_STATEMENT_CAPACITY;
use sidekicks_workspace::execution_root::EXECUTION_ROOT_SERVICE_STATEMENT_CAPACITY;
use sidekicks_workspace::folder::usage::REPO_FOLDER_USAGE_STATEMENT_CAPACITY;
use sidekicks_workspace::git::turn_snapshot::service::TURN_SNAPSHOT_PRUNE_STATEMENT_CAPACITY;
use sidekicks_workspace::git::worktree::creation::WORKTREE_CREATOR_STATEMENT_CAPACITY;
use sidekicks_workspace::git::worktree::occupancy::MOUNT_OCCUPANCY_STATEMENT_CAPACITY;
use sidekicks_workspace::git::worktree::removed_store::REMOVED_WORKTREE_STORE_STATEMENT_CAPACITY;
use sidekicks_workspace::git::worktree::service::WORKTREE_SERVICE_STATEMENT_CAPACITY;
use sidekicks_workspace::git::worktree::status::WORKTREE_STATUS_READER_STATEMENT_CAPACITY;
use sidekicks_workspace::git::worktree::unfinished_discards::UNFINISHED_DISCARD_STATEMENT_CAPACITY;
use sidekicks_workspace::project::records::PROJECT_RECORDS_STATEMENT_CAPACITY;
use sidekicks_workspace::repo::mount::health::REPO_MOUNT_HEALTH_REPROBE_STATEMENT_CAPACITY;
use sidekicks_workspace::repo::mount::reattach::REPO_MOUNT_REATTACH_SERVICE_STATEMENT_CAPACITY;
use sidekicks_workspace::repo::mount::service::REPO_MOUNT_SERVICE_STATEMENT_CAPACITY;
use sidekicks_workspace::run_setup_gates::execution_root::EXECUTION_ROOT_SETUP_GATE_STATEMENT_CAPACITY;
use sidekicks_workspace::service::WORKSPACE_SERVICE_STATEMENT_CAPACITY;
use tokio::sync::{oneshot, watch};
use tokio::task::{JoinError, JoinHandle};
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;

use crate::bootstrap::SecureDefaults;
use crate::daemon::backup::run::BACKUP_STATEMENT_CAPACITY;
use crate::daemon::configuration::DAEMON_CONFIGURATION_STATEMENT_CAPACITY;
use crate::daemon::process::supervision::ProcessStateTracker;
use crate::daemon::repairing_socket::{
    DatabaseFileRepairEnd, RepairingSocketDeps, RepairingSocketError,
    repair_database_file_while_answering,
};
use crate::daemon::retention_methods::RETENTION_STATEMENT_CAPACITY;
use crate::daemon::schema::schema_parts;
use crate::data_acts::purge::rows::SESSION_PURGE_STATEMENT_CAPACITY;
use crate::ipc::handlers::approval::APPROVAL_METHODS_STATEMENT_CAPACITY;
use crate::ipc::handlers::driver::DRIVER_METHODS_STATEMENT_CAPACITY;

/// The statements each read connection keeps prepared: every reading service's set, summed, so a
/// statement stays prepared on whichever connection a read borrows. A service whose set holds
/// another's counts it inside its own.
pub(crate) const READ_POOL_STATEMENT_CAPACITY: usize = APPROVAL_METHODS_STATEMENT_CAPACITY
    + APPROVAL_REQUEST_READER_STATEMENT_CAPACITY
    + APPROVAL_RULES_STATEMENT_CAPACITY
    + ARTIFACT_STATEMENT_CAPACITY
    + BACKUP_STATEMENT_CAPACITY
    + CLONE_REQUESTS_STATEMENT_CAPACITY
    + CONVERSATION_PURGE_STATEMENT_CAPACITY
    + DAEMON_CONFIGURATION_STATEMENT_CAPACITY
    + DAMAGED_HISTORY_STATEMENT_CAPACITY
    + DRIVER_CAPABILITIES_WRITER_STATEMENT_CAPACITY
    + DRIVER_METHODS_STATEMENT_CAPACITY
    + EVENT_LOG_STATEMENT_CAPACITY
    + EXECUTION_ROOT_SERVICE_STATEMENT_CAPACITY
    + EXECUTION_ROOT_SETUP_GATE_STATEMENT_CAPACITY
    + FILE_SEARCH_STATEMENT_CAPACITY
    + INTERVENTION_SERVICE_STATEMENT_CAPACITY
    + LIVE_RUN_BINDINGS_STATEMENT_CAPACITY
    + MACHINE_REGISTRY_STATEMENT_CAPACITY
    + MOUNT_OCCUPANCY_STATEMENT_CAPACITY
    + OUTBOX_STATEMENT_CAPACITY
    + PLANS_STATEMENT_CAPACITY
    + PROJECT_RECORDS_STATEMENT_CAPACITY
    + PROJECT_SESSION_ACTIVITY_STATEMENT_CAPACITY
    + PROJECTION_REBUILD_STATEMENT_CAPACITY
    + PROVIDER_CHOICE_STATEMENT_CAPACITY
    + PROVIDER_SESSIONS_STATEMENT_CAPACITY
    + QUESTION_STATEMENT_CAPACITY
    + RELATED_RANKING_STATEMENT_CAPACITY
    + REMOVED_WORKTREE_STORE_STATEMENT_CAPACITY
    + REPO_FOLDER_USAGE_STATEMENT_CAPACITY
    + REPO_MOUNT_HEALTH_REPROBE_STATEMENT_CAPACITY
    + REPO_MOUNT_REATTACH_SERVICE_STATEMENT_CAPACITY
    + REPO_MOUNT_SERVICE_STATEMENT_CAPACITY
    + RESTART_SETTLE_STATEMENT_CAPACITY
    + RETENTION_STATEMENT_CAPACITY
    + REVIEW_NOTE_STORE_STATEMENT_CAPACITY
    // The reviewer denials' set and the run engine's each hold the run agent reader's.
    + REVIEWER_DENIALS_STATEMENT_CAPACITY
    + RUN_BINDING_CURSORS_STATEMENT_CAPACITY
    + RUN_ENGINE_STATEMENT_CAPACITY
    + RUN_PAUSE_STATEMENT_CAPACITY
    + RUNTIME_BINDING_STORE_STATEMENT_CAPACITY
    + SESSION_AUTO_TITLE_STATEMENT_CAPACITY
    + SESSION_CHANGES_STATEMENT_CAPACITY
    + SESSION_CONVERSION_STATEMENT_CAPACITY
    + SESSION_CREATION_STATEMENT_CAPACITY
    + SESSION_DIRECTORY_PROVIDER_PORT_STATEMENT_CAPACITY
    + SESSION_DRAFT_STORE_STATEMENT_CAPACITY
    + SESSION_LINK_SERVICE_STATEMENT_CAPACITY
    + SESSION_LIST_ROWS_STATEMENT_CAPACITY
    + SESSION_LIVE_RUN_FOLDERS_STATEMENT_CAPACITY
    + SESSION_PURGE_STATEMENT_CAPACITY
    + SESSION_SERVICE_STATEMENT_CAPACITY
    + SESSION_TAG_SERVICE_STATEMENT_CAPACITY
    + SESSION_WORKING_FOLDERS_STATEMENT_CAPACITY
    + STARTUP_RECOVERY_STATEMENT_CAPACITY
    + TURN_SNAPSHOT_PRUNE_STATEMENT_CAPACITY
    + UNFINISHED_DISCARD_STATEMENT_CAPACITY
    + WORKFLOW_DEFINITION_STORE_STATEMENT_CAPACITY
    + WORKFLOW_DRAFT_STORE_STATEMENT_CAPACITY
    + WORKFLOW_KEPT_VALUE_STORE_STATEMENT_CAPACITY
    + WORKFLOW_LIBRARY_STATEMENT_CAPACITY
    + WORKFLOW_RUN_ATTENTION_STATEMENT_CAPACITY
    + WORKFLOW_RUN_DELETION_STATEMENT_CAPACITY
    + WORKFLOW_RUN_STORE_STATEMENT_CAPACITY
    + WORKFLOW_STEP_PAYLOAD_STATEMENT_CAPACITY
    + WORKFLOW_VERSIONS_STATEMENT_CAPACITY
    + WORKSPACE_SERVICE_STATEMENT_CAPACITY
    + WORKTREE_CREATOR_STATEMENT_CAPACITY
    + WORKTREE_SERVICE_STATEMENT_CAPACITY
    + WORKTREE_STATUS_READER_STATEMENT_CAPACITY;

/// How the writer's open fails, as [`DatabaseWriter::open`] reports the schema's opener.
type WriterOpenFailure =
    DatabaseWriterOpenError<CleanupFailures<DatabaseOpenError, rusqlite::Error>>;

/// What a start needs to open the database file.
pub(crate) struct DatabaseFileStart<'a> {
    /// The database file.
    pub(crate) database_path: PathBuf,
    /// The data folder, which the repair's copies aside go into.
    pub(crate) data_folder: PathBuf,
    /// The search index's folder, which a replaced file drops.
    pub(crate) index_folder_path: PathBuf,
    /// The daemon's SQLite shell, which a repair recovers the file with.
    pub(crate) shell: &'a SqliteShell,
    /// The `database copy` mode every copy of the repair runs in.
    pub(crate) copier: &'a DatabaseFileCopier,
    /// The time a new copy aside is named for.
    pub(crate) now: Timestamp,
    /// Where the person keeps backups, which a repair reads the newest of.
    pub(crate) backup_folder: PathBuf,
    /// The run folder the repairing socket binds in.
    pub(crate) run_folder: &'a DaemonRunFolder,
    /// The checked socket path the repairing socket binds.
    pub(crate) secure_defaults: &'a SecureDefaults,
    /// Reads which process is at the client's end of each connection the repair answers on.
    pub(crate) caller_process_reader: Arc<dyn CallerProcessReader>,
    /// Where the daemon is in its own life, marked degraded when the file cannot be checked.
    pub(crate) process_state: Arc<ProcessStateTracker>,
    /// The system's stop request, which ends a repair under way.
    pub(crate) stop: &'a CancellationToken,
}

/// Why the database file did not open; the file is left as it was found.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DatabaseFileOpenError {
    /// The repair could not run, or its socket could not be bound.
    #[error("the database file's repair could not run")]
    Repair(#[source] RepairingSocketError),
    /// The file is damaged and its repair could not heal it; it is left as it was.
    #[error(
        "The database file is damaged and could not be repaired: {failure}. Its files are copied \
         aside in {}.",
        aside_folder.display()
    )]
    SavedSessionsUnrepaired {
        /// The folder the damaged files are copied aside in.
        aside_folder: PathBuf,
        /// Why the repair failed.
        #[source]
        failure: DatabaseFileRepairFailure,
    },
    /// The file holds another build's schema, which this build never migrates.
    #[error("the database at {} holds the schema of another build", path.display())]
    SavedSessionsFromAnotherVersion {
        /// The database file.
        path: PathBuf,
    },
    /// A stop came while the file was repaired.
    #[error("a stop came while the database file was repaired")]
    Stopped(DaemonStopIntent),
    /// The last run's record could not be read or written.
    #[error(transparent)]
    LastRun(#[from] LastRunError),
    /// The file is too damaged to open; its damage is recorded, beside the record's own failure
    /// when that failed, so the next start repairs it.
    #[error("the database file is damaged; the next start repairs it")]
    Damaged(#[source] CleanupFailures<WriterOpenFailure, AtomicWriteError>),
    /// The writer could not open the file.
    #[error(transparent)]
    Writer(WriterOpenFailure),
}

/// Why a step of the database file's close failed; every other step still ran.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DatabaseFileCloseFailure {
    /// The task that acts on the check's answer ended before it finished.
    #[error("the database file's check ended before its answer was acted on")]
    Check(#[source] JoinError),
    /// The check had not ended within the stop's bound, so the writer closed beside its open
    /// connection, which keeps the write-ahead log whole for the next open to replay.
    #[error(
        "the database file's check had not ended within the stop's bound, so its connection \
         outlived the writer's"
    )]
    CheckStillRunning,
    /// The log's truncation had not ended within the stop's bound, so the writer closed while it
    /// still waited on it.
    #[error("the write-ahead log's truncation had not ended within the stop's bound")]
    TruncationStillRunning,
    /// The damage found could not be recorded, so the next start's check must find it again.
    #[error(
        "recording the damage to the database file failed, so the next start's check must find \
         it again"
    )]
    DamageRecord(#[source] AtomicWriteError),
    /// A read connection did not close cleanly.
    #[error(transparent)]
    ReadPool(DatabaseReadPoolCloseError),
    /// The writer's connection or thread did not end cleanly.
    #[error(transparent)]
    Writer(Arc<CleanupFailures<WriterCloseError, ThreadJoinError>>),
    /// The clean stop could not be recorded, so the next start checks the file before it writes.
    #[error("the database file's clean stop could not be recorded")]
    CleanStop(#[source] LastRunError),
}

/// The open database file and everything that reads or writes it.
pub(crate) struct DatabaseFile {
    /// The database file.
    pub(crate) database_path: PathBuf,
    /// The one writer.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The one read pool every reading service shares.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// Learns of damage the check or any read or write meets.
    pub(crate) damage: Arc<DatabaseDamageWatch>,
    /// Where the daemon stands in its recovery from the last restart.
    pub(crate) status: Arc<RecoveryStatusTracker>,
    /// The sole append path for every session's events.
    pub(crate) event_log: Arc<EventLogService>,
    /// The followers every committed event is published to.
    pub(crate) followers: Arc<SessionEventFollowers>,
    /// The count of live runs, read after each commit.
    pub(crate) live_runs: watch::Receiver<u32>,
    /// Truncates the write-ahead log, asked once the check has answered and after each purge.
    pub(crate) truncation: Arc<WriteAheadLogTruncation>,
    /// Where each damaged session's log stops being readable, as the recovery status says.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    check: CheckFollower,
    // Ends the writer once damage is found; aborted with the file.
    damage_follower: AbortOnDropHandle<()>,
    // Whether the last run's record or a sound check vouches for the file, so a clean stop may
    // be recorded.
    is_vouched: Arc<AtomicBool>,
}

/// Repairs the file when a run recorded damage to it, opens it and starts its check. Fails with
/// [`DatabaseFileOpenError::SavedSessionsUnrepaired`] when the file is damaged and its repair
/// could not heal it, with [`DatabaseFileOpenError::SavedSessionsFromAnotherVersion`] when it holds
/// another build's schema, with [`DatabaseFileOpenError::Damaged`] when it is too damaged to open,
/// which is recorded so the next start repairs it, and with [`DatabaseFileOpenError::Stopped`]
/// when a stop ended the repair.
pub(crate) async fn open_database_file(
    start: DatabaseFileStart<'_>,
) -> Result<DatabaseFile, DatabaseFileOpenError> {
    let DatabaseFileStart {
        database_path,
        data_folder,
        index_folder_path,
        shell,
        copier,
        now,
        backup_folder,
        run_folder,
        secure_defaults,
        caller_process_reader,
        process_state,
        stop,
    } = start;
    // The daemon's whole schema, which the repair readies a fresh file with and the writer opens.
    let schema = schema_parts().into_schema();
    // Before anything opens the file, so a repaired file replaces it whole.
    let repaired = repair_database_file_while_answering(RepairingSocketDeps {
        options: &DatabaseFileRepairOptions {
            database_path: &database_path,
            data_folder: &data_folder,
            index_folder_path: &index_folder_path,
            shell,
            copier,
            schema: &schema,
            now,
        },
        backup_folder: &backup_folder,
        run_folder,
        secure_defaults,
        caller_process_reader,
        stop,
    })
    .await
    .map_err(DatabaseFileOpenError::Repair)?;
    match repaired {
        DatabaseFileRepairEnd::Continued => {}
        DatabaseFileRepairEnd::Unrepaired {
            aside_folder,
            failure,
        } => {
            return Err(DatabaseFileOpenError::SavedSessionsUnrepaired {
                aside_folder,
                failure,
            });
        }
        DatabaseFileRepairEnd::Stopped(intent) => {
            return Err(DatabaseFileOpenError::Stopped(intent));
        }
    }
    let last_run = read_last_run_end(&database_path).await?;
    // A run that ends uncleanly leaves its record, which vouches for the file at the next start;
    // an unvouched file keeps the last run's record until its check finds it sound.
    let is_vouched = if last_run == LastRunEnd::Unknown {
        tracing::info!(
            "the database file changed since the service's last run, or holds no record of one; \
             writes wait for the file's check"
        );
        false
    } else {
        record_run_start(&database_path).await?;
        true
    };
    let (writes_release, writes_held_until) = if is_vouched {
        (None, None)
    } else {
        let (release, held_until) = oneshot::channel();
        (Some(release), Some(held_until))
    };
    let damage = Arc::new(DatabaseDamageWatch::new());
    let status = Arc::new(RecoveryStatusTracker::new());
    let listener_writer = Arc::new(OnceLock::new());
    let (after_commit, live_runs) = count_live_runs_after_commits();
    let writer = open_writer(
        &database_path,
        schema,
        DatabaseWriterOptions {
            writes_held_until,
            on_write_failed: Some(report_write_damage(
                Arc::clone(&damage),
                Arc::clone(&status),
                Arc::clone(&listener_writer),
            )),
            after_commit: Some(after_commit),
        },
    )
    .await?;
    listener_writer
        .set(Arc::downgrade(&writer))
        .expect("only the open sets the writer its listener ends");
    let is_vouched = Arc::new(AtomicBool::new(is_vouched));
    let truncation = Arc::new(WriteAheadLogTruncation::new(Arc::clone(&writer)));
    // A new file has nothing to check. The check starts after the writer's open, which rebuilds a
    // crashed run's log index under locks the check's own open would be refused by.
    let check = if last_run == LastRunEnd::NewFile {
        CheckFollower::none()
    } else {
        CheckFollower::start(CheckAnswerDeps {
            database_path: database_path.clone(),
            writes_release,
            damage: Arc::clone(&damage),
            process_state,
            is_vouched: Arc::clone(&is_vouched),
            truncation: Arc::clone(&truncation),
        })
    };
    let pool = Arc::new(DatabaseReadPool::new(
        database_path.clone(),
        READ_POOL_STATEMENT_CAPACITY,
    ));
    let damage_follower = AbortOnDropHandle::new(tokio::spawn(follow_damage(
        Arc::clone(&damage),
        Arc::clone(&status),
        Arc::clone(&writer),
    )));
    let followers = Arc::new(SessionEventFollowers::default());
    let read_damaged_from_sequence: Arc<DamagedFromSequenceReader> = Arc::new({
        let status = Arc::clone(&status);
        move |session_id| status.read_damaged_from_sequence(session_id)
    });
    let event_log = Arc::new(EventLogService::new(EventLogServiceDependencies {
        writer: Arc::clone(&writer),
        pool: Arc::clone(&pool),
        followers: Arc::clone(&followers),
        projection_statements: Some(Box::new(session_projection_statements)),
        refuse_session_write: Some(Box::new({
            let status = Arc::clone(&status);
            move |session_id, event_type| refuse_session_event(&status, session_id, event_type)
        })),
        read_damaged_from_sequence: Some(Arc::clone(&read_damaged_from_sequence)),
    }));
    Ok(DatabaseFile {
        database_path,
        writer,
        pool,
        damage,
        status,
        event_log,
        followers,
        live_runs,
        truncation,
        read_damaged_from_sequence,
        check,
        damage_follower,
        is_vouched,
    })
}

/// Closes the database file once the work that reads and writes it has ended: the check first, then
/// the damage found recorded, its writer ended if nothing has ended it yet, then the log's
/// truncation stopped; then the read pool before the writer, so the writer is the last to close the
/// file and folds the write-ahead log into it, except an ended writer, which is joined first and
/// skips that checkpoint, so a damaged file's log stays for the repair; damage the drain meets is
/// recorded after the writer's close. The check, the truncation and the writer's drain all end
/// within `remaining`, counted from the call; a check or truncation still running then is a
/// failure, and the close goes on without it. The clean stop is recorded only for a file vouched
/// for, with no damage found, no write left unfinished, no failure here and `is_stop_failed` false.
/// Answers each step's failure, every step having run.
pub(crate) async fn close_database_file(
    file: DatabaseFile,
    remaining: Duration,
    is_stop_failed: bool,
) -> Vec<DatabaseFileCloseFailure> {
    let closing_started = Instant::now();
    let DatabaseFile {
        database_path,
        writer,
        pool,
        damage,
        status,
        truncation,
        check,
        damage_follower,
        is_vouched,
        ..
    } = file;
    let left = || remaining.saturating_sub(closing_started.elapsed());
    let mut failures = Vec::new();
    // The check's connection closes first, so the writer is the last to close the file. Writes
    // still held stay held until the writer has closed, which fails them as closed while held.
    let writes_release = match wait_within(pin!(check.stop()), left(), None).await {
        Some(Ok(writes_release)) => writes_release,
        Some(Err(failure)) => {
            failures.push(DatabaseFileCloseFailure::Check(failure));
            None
        }
        None => {
            failures.push(DatabaseFileCloseFailure::CheckStillRunning);
            None
        }
    };
    let found_before_drain = damage.found();
    if let Some(found) = found_before_drain {
        stop_writes_for_damage(found, &status, &writer);
        record_damage(&database_path, found, &mut failures).await;
    }
    // Before the writer closes, so no truncation waits on a closed writer.
    if wait_within(pin!(truncation.stop()), left(), None)
        .await
        .is_none()
    {
        failures.push(DatabaseFileCloseFailure::TruncationStillRunning);
    }
    let was_ended = writer.is_ended();
    let unfinished = if was_ended {
        let unfinished = close_writer(&writer, left(), &mut failures).await;
        close_pool(&pool, &mut failures).await;
        unfinished
    } else {
        close_pool(&pool, &mut failures).await;
        close_writer(&writer, left(), &mut failures).await
    };
    drop(writes_release);
    // Kept through the close, so damage a read meets during the drain still ends the writer.
    drop(damage_follower);
    // Damage the drain met, which the listener has already ended the writer for.
    if found_before_drain.is_none()
        && let Some(found) = damage.found()
    {
        record_damage(&database_path, found, &mut failures).await;
    }
    let is_clean = is_vouched.load(Ordering::Acquire)
        && !damage.is_found()
        && !was_ended
        && unfinished == 0
        && failures.is_empty()
        && !is_stop_failed;
    if is_clean && let Err(failure) = record_clean_stop(&database_path).await {
        failures.push(DatabaseFileCloseFailure::CleanStop(failure));
    }
    failures
}

// Records `found` beside the file at `database_path`, keeping the record's failure.
async fn record_damage(
    database_path: &Path,
    found: &str,
    failures: &mut Vec<DatabaseFileCloseFailure>,
) {
    if let Err(failure) = record_database_damage(database_path, found).await {
        failures.push(DatabaseFileCloseFailure::DamageRecord(failure));
    }
}

// Opens the writer on the file at `database_path` with `schema`. A file holding another build's
// schema fails as that; one too damaged to open has its damage recorded, so the next start repairs
// it.
async fn open_writer(
    database_path: &Path,
    schema: DatabaseSchema,
    options: DatabaseWriterOptions,
) -> Result<Arc<DatabaseWriter>, DatabaseFileOpenError> {
    let opened_path = database_path.to_path_buf();
    let opener = move || open_database(&opened_path, &schema);
    let failure = match DatabaseWriter::open(opener, options).await {
        Ok(writer) => return Ok(Arc::new(writer)),
        Err(failure) => failure,
    };
    if let DatabaseWriterOpenError::Open(open_failure) = &failure
        && let DatabaseOpenError::SchemaFromAnotherBuild { path } =
            open_failure.original().original()
    {
        return Err(DatabaseFileOpenError::SavedSessionsFromAnotherVersion { path: path.clone() });
    }
    if !is_database_damage_error(&failure) {
        return Err(DatabaseFileOpenError::Writer(failure));
    }
    let record_failures = record_database_damage(database_path, &describe_error(&failure))
        .await
        .err()
        .into_iter()
        .collect();
    Err(DatabaseFileOpenError::Damaged(CleanupFailures::new(
        failure,
        record_failures,
        "recording the damage to the database file",
    )))
}

// The statements the projections kept in each event's own write take for `envelope`: the session's
// directory row first, which the others' rows refer to, then the questions' queued answers.
fn session_projection_statements(
    envelope: &UnsequencedEventEnvelope,
) -> Result<Vec<WriteStatement>, ProjectionError> {
    let mut statements = directory_statements_for(&DirectoryEvent::from(envelope))?;
    statements.extend(question_projection_statements(envelope));
    Ok(statements)
}

/// Why the writer ended: the database file is damaged, so it takes no write.
#[derive(Debug, thiserror::Error)]
#[error("the database file is damaged, so no write is taken: {0}")]
struct DatabaseFileDamaged(String);

// Waits for damage to be found, then stops the writes to the file and logs that the daemon stops
// for the repair.
async fn follow_damage(
    damage: Arc<DatabaseDamageWatch>,
    status: Arc<RecoveryStatusTracker>,
    writer: Arc<DatabaseWriter>,
) {
    let found = damage.when_found().await;
    stop_writes_for_damage(found, &status, &writer);
    tracing::error!(
        damage = found,
        "the database file is damaged; the service stops and its next start repairs the file"
    );
}

// Marks the store failed and ends the writer, so no later write reaches the damaged file and its
// close skips the checkpoint, leaving the files as they were found; a writer already ended stays
// as it is.
fn stop_writes_for_damage(found: &str, status: &RecoveryStatusTracker, writer: &DatabaseWriter) {
    status.mark_store_failed();
    writer.end(Arc::new(DatabaseFileDamaged(found.to_owned())));
}

// Tells `damage` of each failure SQLite raised for a write, and for damage stops the writes at
// once, on the write queue's task, so the batches after it and the close's checkpoint never reach
// the damaged file. The writer is set after its open and held through a `Weak`, so the listener
// never keeps it open.
fn report_write_damage(
    damage: Arc<DatabaseDamageWatch>,
    status: Arc<RecoveryStatusTracker>,
    writer: Arc<OnceLock<Weak<DatabaseWriter>>>,
) -> WriteFailureListener {
    Box::new(move |failure| {
        damage.report(failure);
        if is_database_damage_error(failure)
            && let Some(writer) = writer.get().and_then(Weak::upgrade)
        {
            let found = damage.found().expect("the report has recorded the damage");
            stop_writes_for_damage(found, &status, &writer);
        }
    })
}

// Closes the read pool, keeping its failure.
async fn close_pool(pool: &DatabaseReadPool, failures: &mut Vec<DatabaseFileCloseFailure>) {
    if let Err(failure) = pool.close().await {
        failures.push(DatabaseFileCloseFailure::ReadPool(failure));
    }
}

// Closes the writer within `drain_within`, keeping its failure; answers the writes it left
// unfinished.
async fn close_writer(
    writer: &DatabaseWriter,
    drain_within: Duration,
    failures: &mut Vec<DatabaseFileCloseFailure>,
) -> usize {
    match writer.close(Some(drain_within)).await {
        Ok(0) => 0,
        Ok(unfinished) => {
            tracing::warn!(
                unfinished,
                "the stop's drain bound passed; writes never committed"
            );
            unfinished
        }
        Err(failure) => {
            failures.push(DatabaseFileCloseFailure::Writer(failure));
            0
        }
    }
}

/// Lets the writer's held writes go, or refuses them.
type WritesRelease = oneshot::Sender<Result<(), WritesHeldError>>;

/// The task that acts on the check's answer, and the stop that ends the check.
struct CheckFollower {
    stop: CancellationToken,
    /// Answers the hold's release when the answer let no writes go.
    task: Option<JoinHandle<Option<WritesRelease>>>,
}

/// What the check's answer acts on.
struct CheckAnswerDeps {
    database_path: PathBuf,
    /// Lets the held writes go; `None` when the file was vouched for and nothing is held.
    writes_release: Option<WritesRelease>,
    damage: Arc<DatabaseDamageWatch>,
    process_state: Arc<ProcessStateTracker>,
    is_vouched: Arc<AtomicBool>,
    truncation: Arc<WriteAheadLogTruncation>,
}

impl CheckFollower {
    // A new file's: there is nothing to check.
    fn none() -> Self {
        Self {
            stop: CancellationToken::new(),
            task: None,
        }
    }

    // Starts the check of the file and the task acting on its answer.
    fn start(deps: CheckAnswerDeps) -> Self {
        let check = DatabaseFileCheck::start(deps.database_path.clone());
        let stop = CancellationToken::new();
        let task = tokio::spawn(follow_check(check, stop.clone(), deps));
        Self {
            stop,
            task: Some(task),
        }
    }

    // Ends the check if it still runs, which stops its walk within one page, and waits for the
    // check's thread to end and its answer to have been acted on; answers the hold's release when
    // the answer let no writes go.
    async fn stop(self) -> Result<Option<WritesRelease>, JoinError> {
        self.stop.cancel();
        match self.task {
            Some(task) => task.await,
            None => Ok(None),
        }
    }
}

// Waits for the check's answer; a stop ends the check and waits for its answer too, so the check's
// connection has closed before the file's other connections do. Then acts on the answer: a sound
// file vouched for, its writes let go and its log's truncation asked for, damage told to the
// watch, and a check that could not run leaving the daemon degraded, its writes let go, its log's
// truncation asked for and the file unvouched. Answers the hold's release when no writes were let
// go, so the hold ends only with the writer's close.
async fn follow_check(
    mut check: DatabaseFileCheck,
    stop: CancellationToken,
    deps: CheckAnswerDeps,
) -> Option<WritesRelease> {
    let check_started = Instant::now();
    let answered = tokio::select! {
        biased;
        answer = check.answer() => Some(answer),
        () = stop.cancelled() => None,
    };
    let answer = if let Some(answer) = answered {
        answer
    } else {
        check.stop();
        check.answer().await
    };
    let CheckAnswerDeps {
        database_path,
        writes_release,
        damage,
        process_state,
        is_vouched,
        truncation,
    } = deps;
    match answer {
        Ok(DatabaseFileCheckAnswer::Sound) => {
            tracing::info!(
                check_ms = check_started.elapsed().as_millis(),
                "the database file's check found it sound"
            );
            if !is_vouched.load(Ordering::Acquire) {
                match record_run_start(&database_path).await {
                    Ok(()) => is_vouched.store(true, Ordering::Release),
                    Err(failure) => tracing::warn!(
                        error = &failure as &(dyn Error + 'static),
                        "recording that the database file was found sound failed, so the next \
                         start checks it before it writes again"
                    ),
                }
            }
            release_writes(writes_release);
            truncation.request();
            None
        }
        // The held writes never reach a damaged file: the damage's follower ends the writer.
        Ok(DatabaseFileCheckAnswer::Damaged(found)) => {
            tracing::warn!(damage = %found, "the database file's check found it damaged");
            damage.find(found);
            writes_release
        }
        Ok(DatabaseFileCheckAnswer::Stopped) => writes_release,
        Err(failure) => {
            tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                "the database file could not be checked, so the service takes writes unchecked \
                 and its next start checks the file again"
            );
            process_state.mark_degraded();
            release_writes(writes_release);
            truncation.request();
            // A file the last run vouched for is vouched for no longer.
            if is_vouched.swap(false, Ordering::AcqRel)
                && let Err(failure) = forget_last_run(&database_path).await
            {
                tracing::warn!(
                    error = &failure as &(dyn Error + 'static),
                    "removing the record of the last run failed, so the next start may write \
                     before its check answers"
                );
            }
            None
        }
    }
}

// Lets the held writes go, when any are held.
fn release_writes(writes_release: Option<WritesRelease>) {
    if let Some(release) = writes_release
        && release.send(Ok(())).is_err()
    {
        tracing::debug!("the database writer had closed before its held writes were let go");
    }
}

#[cfg(test)]
mod tests;
