//! `Export all data`: everything the service keeps for the person written into a new folder they
//! picked, one export at a time. `sessions/<id>.jsonl` holds each session's events in the
//! canonical shape with every body decoded, then its queue items and interventions as stored;
//! `files/<session id>/<manifest id>/<name>` each file the session's artifacts hold;
//! `accounts.json` each provider account's provider, name and plan, and no credential;
//! `README.txt` a line for each part. Sessions are read a page of bounded text at a time and
//! written as they are read, and a body too long for a page is written a frame at a time, so
//! memory stays bounded whatever the store holds. The export writes one line to the service log,
//! when it begins, naming its folder, which is how an export a restart cut short is found. A failed
//! export removes its folder, so trying again into the same folder starts clean.

use std::collections::HashMap;
use std::convert::Infallible;
use std::error::Error;
use std::fs::{self, File};
use std::io::{self, BufWriter, Write as _};
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use sidekicks_contracts::daemon::data::{DataExportJobId, DataExportProgress};
use sidekicks_contracts::error::ERROR_MESSAGE_MAX_LEN;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

use crate::artifacts::payload_store::{ContentHash, PayloadStore};
use crate::artifacts::validation::FILE_NAME_MEMBER;
use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::error_description::describe_error;
use crate::events::content::codec::{BodyStreamError, no_decoder_read_failure};
use crate::events::content::read::{
    StoredEventContentRow, hydrate_stored_event, joined_content_length,
};
use crate::events::session::read::{
    DamagedFromSequenceReader, SessionEventReads, SessionLogReadError, UnloadedBodyEvent,
    malformed_body,
};
use crate::text_cut::cut_to_code_points;

const SESSIONS_FOLDER_NAME: &str = "sessions";

const FILES_FOLDER_NAME: &str = "files";

const ACCOUNTS_FILE_NAME: &str = "accounts.json";

const README_FILE_NAME: &str = "README.txt";

// What each part of the folder is, one line each.
const README_LINES: &[&str] = &[
    "sessions/  Each session's events, one JSON object per line in the order they happened, \
     each with its whole text; then the session's queued messages (\"queueItem\") and \
     interventions (\"intervention\") as the app kept them.",
    "files/  Each session's files: a folder per session, and in it a folder per file holding the \
     file under its own name.",
    "accounts.json  Each provider account's provider, name and plan. No sign-in, token or other \
     credential is in this folder.",
];

const SESSION_IDS_SQL: &str = "SELECT id FROM sessions ORDER BY rowid";

const QUEUE_ITEMS_SQL: &str = "SELECT id, state, payload, created_at, updated_at FROM queue_items \
     WHERE session_id = ?1 ORDER BY created_at, id";

const INTERVENTIONS_SQL: &str = "SELECT intervention.id, intervention.target_run_id, \
     intervention.type, intervention.state, intervention.payload, intervention.created_at, \
     intervention.resolved_at FROM interventions AS intervention \
     JOIN runs AS run ON run.run_id = intervention.target_run_id \
     WHERE run.session_id = ?1 ORDER BY intervention.created_at, intervention.id";

const ARTIFACT_FILES_SQL: &str = "SELECT id, json_extract(metadata, ?2), content_hash \
     FROM artifact_manifests WHERE session_id = ?1 ORDER BY created_at, id";

// Only these columns are read: the registry's other columns stay out of the folder.
const ACCOUNTS_SQL: &str = "SELECT provider, coalesce(display_label, observed_account_email), \
     observed_account_plan FROM provider_accounts ORDER BY created_at, account_id";

/// What an export reads.
pub(crate) struct DataExportDeps {
    /// The daemon's database readers.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The sequence a damaged session's reads stop before.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    /// The artifact store, whose payloads `files/` copies.
    pub(crate) payloads: Arc<PayloadStore>,
}

/// Why an export could not start.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DataExportStartRefusal {
    /// Another export runs.
    #[error("another export is running")]
    AlreadyRunning(DataExportJobId),
    /// The folder named already exists.
    #[error("the export's folder already exists")]
    DestinationExists,
    /// The folder cannot be made where it was named: its parent is missing or not writable.
    #[error("the export's folder cannot be made there")]
    DestinationNotWritable(#[source] io::Error),
    /// The system refused to make the folder for another reason.
    #[error("the export's folder could not be made")]
    Folder(#[source] io::Error),
}

/// Why an export did not finish.
#[derive(Debug, thiserror::Error)]
enum ExportError {
    #[error("the store could not be read")]
    Read(#[from] DatabaseReadError),
    #[error("the store could not be read")]
    Query(#[from] rusqlite::Error),
    #[error("a session's events could not be read")]
    Log(#[from] SessionLogReadError),
    #[error("a stored row is not what the app writes")]
    Stored(#[source] Box<dyn Error + Send + Sync>),
    #[error("the export's folder could not be written")]
    Write(#[from] io::Error),
    #[error("a record could not be written as JSON")]
    Json(#[from] serde_json::Error),
    #[error("the export's folder could not be measured")]
    Measure(#[source] io::Error),
}

// The running export's hold on the one export slot: dropped, it frees the slot before the export's
// end is published, so a client that sees the end can start the next at once, and a task that
// panicked frees it too and publishes the failure.
struct RunningExport {
    jobs: Arc<Mutex<ExportJobs>>,
    progress: watch::Sender<DataExportProgress>,
    ended: Option<DataExportProgress>,
}

impl RunningExport {
    // Frees the slot and publishes `ended`.
    fn end(mut self, ended: DataExportProgress) {
        self.ended = Some(ended);
    }
}

impl Drop for RunningExport {
    fn drop(&mut self) {
        self.jobs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .running = None;
        let ended = self
            .ended
            .take()
            .unwrap_or_else(|| DataExportProgress::Failed {
                message: FreeFormText::new("The export stopped unexpectedly.".to_owned())
                    .expect("the message is text without NUL"),
            });
        self.progress.send_replace(ended);
    }
}

// One export this run of the service started: its progress and its stop.
struct ExportJob {
    progress: watch::Sender<DataExportProgress>,
    stop: CancellationToken,
}

#[derive(Default)]
struct ExportJobs {
    running: Option<DataExportJobId>,
    jobs: HashMap<DataExportJobId, ExportJob>,
}

/// The service's exports: the one running, and each this run started, for its last state.
pub(crate) struct DataExports {
    deps: Arc<DataExportDeps>,
    jobs: Arc<Mutex<ExportJobs>>,
}

impl DataExports {
    /// The exports, reading through `deps`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start makes the exports once the store is open"
        )
    )]
    pub(crate) fn new(deps: DataExportDeps) -> Self {
        Self {
            deps: Arc::new(deps),
            jobs: Arc::new(Mutex::new(ExportJobs::default())),
        }
    }

    /// Makes the folder at `destination`, private from the moment it exists, and starts an export
    /// into it. Refused while another runs, when the folder already exists, when its parent is
    /// missing or not writable, and when the system refuses the make otherwise, leaving no folder.
    pub(crate) fn start(
        &self,
        destination: PathBuf,
    ) -> Result<DataExportJobId, DataExportStartRefusal> {
        let mut jobs = self.jobs.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(running) = jobs.running {
            return Err(DataExportStartRefusal::AlreadyRunning(running));
        }
        match sidekicks_platforms::create_new_private_folder(&destination) {
            Ok(()) => {}
            Err(failure) if failure.kind() == io::ErrorKind::AlreadyExists => {
                return Err(DataExportStartRefusal::DestinationExists);
            }
            Err(failure)
                if matches!(
                    failure.kind(),
                    io::ErrorKind::NotFound
                        | io::ErrorKind::NotADirectory
                        | io::ErrorKind::PermissionDenied
                        | io::ErrorKind::ReadOnlyFilesystem
                ) =>
            {
                return Err(DataExportStartRefusal::DestinationNotWritable(failure));
            }
            Err(failure) => return Err(DataExportStartRefusal::Folder(failure)),
        }
        let job_id = DataExportJobId::try_from(mint_uuid_v7()).expect("a minted UUID is a job id");
        let zero = SafeInt::new(0).expect("zero is a safe integer");
        let (progress, _) = watch::channel(DataExportProgress::Running {
            sessions_exported: zero,
            sessions_total: zero,
        });
        let stop = CancellationToken::new();
        jobs.running = Some(job_id);
        jobs.jobs.insert(
            job_id,
            ExportJob {
                progress: progress.clone(),
                stop: stop.clone(),
            },
        );
        tracing::info!(folder = %destination.display(), "An export began");
        let deps = Arc::clone(&self.deps);
        let running = RunningExport {
            jobs: Arc::clone(&self.jobs),
            progress: progress.clone(),
            ended: None,
        };
        tokio::spawn(async move {
            let ended = run_export(&deps, &destination, &progress, &stop).await;
            running.end(ended);
        });
        Ok(job_id)
    }

    /// The progress of `job_id` as it changes, `None` for a job this run did not start.
    pub(crate) fn follow(
        &self,
        job_id: DataExportJobId,
    ) -> Option<watch::Receiver<DataExportProgress>> {
        let jobs = self.jobs.lock().unwrap_or_else(PoisonError::into_inner);
        jobs.jobs.get(&job_id).map(|job| job.progress.subscribe())
    }

    /// Stops `job_id` once its current session is written; a finished job stays as it ended.
    /// Answers `false` for a job this run did not start.
    pub(crate) fn cancel(&self, job_id: DataExportJobId) -> bool {
        let jobs = self.jobs.lock().unwrap_or_else(PoisonError::into_inner);
        jobs.jobs
            .get(&job_id)
            .map(|job| job.stop.cancel())
            .is_some()
    }
}

/// Whether `progress` is where an export ends.
pub(crate) fn is_finished(progress: &DataExportProgress) -> bool {
    !matches!(progress, DataExportProgress::Running { .. })
}

// The export into `destination`, answering how it ended.
async fn run_export(
    deps: &DataExportDeps,
    destination: &Path,
    progress: &watch::Sender<DataExportProgress>,
    stop: &CancellationToken,
) -> DataExportProgress {
    let written = match write_export(deps, destination, progress, stop).await {
        Ok(()) if stop.is_cancelled() => {
            return DataExportProgress::Canceled {
                path: folder_path(destination),
            };
        }
        Ok(()) => folder_bytes(destination.to_path_buf()).await,
        Err(failure) => Err(failure),
    };
    match written {
        Ok(total_bytes) => DataExportProgress::Completed {
            path: folder_path(destination),
            total_bytes: SafeInt::new(total_bytes).expect("an export's bytes are a safe integer"),
        },
        Err(failure) => {
            let removed = destination.to_path_buf();
            let removal = match tokio::task::spawn_blocking(move || {
                sidekicks_platforms::remove_tree(&removed)
            })
            .await
            {
                Ok(removal) => removal,
                Err(failure) => Err(io::Error::other(failure)),
            };
            if let Err(removal_failure) = removal {
                tracing::warn!(
                    folder = %destination.display(),
                    error = &removal_failure as &(dyn Error + 'static),
                    "the failed export's folder could not be removed"
                );
            }
            let message = describe_error(&failure);
            DataExportProgress::Failed {
                message: FreeFormText::new(
                    cut_to_code_points(&message, ERROR_MESSAGE_MAX_LEN).to_owned(),
                )
                .expect("a failure's description is text without NUL"),
            }
        }
    }
}

async fn write_export(
    deps: &DataExportDeps,
    destination: &Path,
    progress: &watch::Sender<DataExportProgress>,
    stop: &CancellationToken,
) -> Result<(), ExportError> {
    let session_ids = deps.reads.read(ReadLength::Long, read_session_ids).await?;
    let total = session_count(session_ids.len());
    let sessions_folder = destination.join(SESSIONS_FOLDER_NAME);
    let files_folder = destination.join(FILES_FOLDER_NAME);
    fs::create_dir_all(&sessions_folder)?;
    fs::create_dir_all(&files_folder)?;
    for (exported, session_id) in session_ids.into_iter().enumerate() {
        if stop.is_cancelled() {
            return Ok(());
        }
        progress.send_replace(DataExportProgress::Running {
            sessions_exported: session_count(exported),
            sessions_total: total,
        });
        let sessions_folder = sessions_folder.clone();
        let files_folder = files_folder.clone();
        let payloads = Arc::clone(&deps.payloads);
        let read_damaged_from_sequence = Arc::clone(&deps.read_damaged_from_sequence);
        let stop = stop.clone();
        deps.reads
            .read(ReadLength::Long, move |connection| {
                write_session(
                    connection,
                    &session_id,
                    &sessions_folder,
                    &*read_damaged_from_sequence,
                    &stop,
                )?;
                write_session_files(connection, &session_id, &files_folder, &payloads)
            })
            .await?;
    }
    let accounts = deps.reads.read(ReadLength::Short, read_accounts).await?;
    let mut accounts_json = serde_json::to_vec_pretty(&accounts)?;
    accounts_json.push(b'\n');
    fs::write(destination.join(ACCOUNTS_FILE_NAME), accounts_json)?;
    fs::write(
        destination.join(README_FILE_NAME),
        README_LINES.join("\n\n") + "\n",
    )?;
    Ok(())
}

fn session_count(count: usize) -> SafeInt<0> {
    u64::try_from(count)
        .ok()
        .and_then(SafeInt::new)
        .expect("a count of sessions is a safe integer")
}

fn read_session_ids(connection: &Connection) -> Result<Vec<SessionId>, ExportError> {
    let texts = connection
        .prepare_cached(SESSION_IDS_SQL)?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    texts
        .iter()
        .map(|text| SessionId::new(text).map_err(|failure| ExportError::Stored(failure.into())))
        .collect()
}

// Writes `sessions/<id>.jsonl`: the session's events a page at a time, a body too long for a page
// a frame at a time, then its queue items and interventions. A cancel stops it between pages.
fn write_session(
    connection: &Connection,
    session_id: &SessionId,
    sessions_folder: &Path,
    read_damaged_from_sequence: &DamagedFromSequenceReader,
    stop: &CancellationToken,
) -> Result<(), ExportError> {
    let path = sessions_folder.join(format!("{}.jsonl", session_id.text().as_str()));
    let mut file = BufWriter::new(File::create(path)?);
    let reads = SessionEventReads::new(connection, read_damaged_from_sequence);
    // One snapshot for the session, so a body a page names is still there when it is read.
    let snapshot = reads.snapshot()?;
    let mut after_position = -1;
    loop {
        if stop.is_cancelled() {
            break;
        }
        let page = reads.read_page_hydrated(session_id, after_position)?;
        let Some(last) = page.last_sequence() else {
            break;
        };
        after_position = last;
        for event in &page.events {
            write_line(&mut file, event)?;
        }
        if let Some(unloaded) = page.oversized {
            write_streamed_line(&mut file, connection, unloaded)?;
        }
    }
    for queue_item in read_queue_items(connection, session_id)? {
        write_line(&mut file, &queue_item)?;
    }
    for intervention in read_interventions(connection, session_id)? {
        write_line(&mut file, &intervention)?;
    }
    snapshot.commit()?;
    file.into_inner()
        .map_err(io::IntoInnerError::into_error)?
        .sync_all()?;
    Ok(())
}

fn write_line(file: &mut BufWriter<File>, record: &impl Serialize) -> Result<(), ExportError> {
    serde_json::to_writer(&mut *file, record)?;
    file.write_all(b"\n")?;
    Ok(())
}

// The member that holds a hydrated event's body, as JSON writes it with an empty body.
const EMPTY_BODY_MEMBER: &[u8] = b"\"body\":\"\"";

// Writes `unloaded`'s line as `write_line` would write it with its body whole, reading the body
// a frame at a time: the line is written with an empty body up to the body's opening quote, then
// each frame's text escaped as JSON escapes it, then the rest of the line. A frame ends between
// characters, so escaping it alone escapes it as the whole body would be.
fn write_streamed_line(
    file: &mut BufWriter<File>,
    connection: &Connection,
    unloaded: UnloadedBodyEvent,
) -> Result<(), ExportError> {
    let UnloadedBodyEvent { event, pieces } = unloaded;
    let shell = serde_json::to_vec(&hydrate_stored_event(StoredEventContentRow {
        envelope: event.clone(),
        content_payload: Some(String::new()),
        content_length: joined_content_length(&pieces),
    }))?;
    // The body is the line's last text member, so its empty form is the last match.
    let body_start = shell
        .windows(EMPTY_BODY_MEMBER.len())
        .rposition(|member| member == EMPTY_BODY_MEMBER)
        .expect("a line with an available body holds its body member")
        + EMPTY_BODY_MEMBER.len()
        - 1;
    file.write_all(&shell[..body_start])?;
    let mut escaped = Vec::new();
    for piece in &pieces {
        let ControlFlow::Continue(()) = piece
            .stream(connection, |frame| {
                escaped.clear();
                serde_json::to_writer(&mut escaped, frame).map_err(io::Error::from)?;
                // The frame's text, without the quotes JSON writes around a string.
                file.write_all(&escaped[1..escaped.len() - 1])?;
                Ok(ControlFlow::<Infallible>::Continue(()))
            })
            .map_err(|error| match error {
                BodyStreamError::Read(error) => ExportError::Query(error),
                BodyStreamError::NoDecoder => ExportError::Query(no_decoder_read_failure()),
                BodyStreamError::Write(error) => ExportError::Write(error),
                damaged @ BodyStreamError::Damaged(_) => {
                    ExportError::Log(malformed_body(&event, damaged).into())
                }
            })?;
    }
    file.write_all(&shell[body_start..])?;
    file.write_all(b"\n")?;
    Ok(())
}

/// A session's line that is no event: a queued message or an intervention, as stored.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum KeptRecord {
    QueueItem {
        id: String,
        state: String,
        payload: Value,
        created_at: String,
        updated_at: String,
    },
    #[serde(rename_all = "camelCase")]
    Intervention {
        id: String,
        target_run_id: String,
        r#type: String,
        state: String,
        payload: Value,
        created_at: String,
        resolved_at: Option<String>,
    },
}

fn stored_json(text: &str) -> Result<Value, ExportError> {
    serde_json::from_str(text).map_err(|failure| ExportError::Stored(failure.into()))
}

fn read_queue_items(
    connection: &Connection,
    session_id: &SessionId,
) -> Result<Vec<KeptRecord>, ExportError> {
    let rows = connection
        .prepare_cached(QUEUE_ITEMS_SQL)?
        .query_map([session_id.text().as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(id, state, payload, created_at, updated_at)| {
            Ok(KeptRecord::QueueItem {
                id,
                state,
                payload: stored_json(&payload)?,
                created_at,
                updated_at,
            })
        })
        .collect()
}

fn read_interventions(
    connection: &Connection,
    session_id: &SessionId,
) -> Result<Vec<KeptRecord>, ExportError> {
    let rows = connection
        .prepare_cached(INTERVENTIONS_SQL)?
        .query_map([session_id.text().as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(
            |(id, target_run_id, r#type, state, payload, created_at, resolved_at)| {
                Ok(KeptRecord::Intervention {
                    id,
                    target_run_id,
                    r#type,
                    state,
                    payload: stored_json(&payload)?,
                    created_at,
                    resolved_at,
                })
            },
        )
        .collect()
}

// Copies each file the session's artifacts hold into `files/<session id>/<manifest id>/`, under
// its own name with any folder part dropped; a payload the store no longer holds is told in the
// service log and skipped.
fn write_session_files(
    connection: &Connection,
    session_id: &SessionId,
    files_folder: &Path,
    payloads: &PayloadStore,
) -> Result<(), ExportError> {
    let rows = connection
        .prepare_cached(ARTIFACT_FILES_SQL)?
        .query_map(
            [session_id.text().as_str(), &format!("$.{FILE_NAME_MEMBER}")],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (manifest_id, file_name, content_hash) in rows {
        let content_hash = ContentHash::from_stored(content_hash)
            .map_err(|failure| ExportError::Stored(failure.into()))?;
        let name = file_name
            .as_deref()
            .and_then(|name| Path::new(name).file_name())
            .map_or_else(|| manifest_id.clone().into(), ToOwned::to_owned);
        let folder = files_folder
            .join(session_id.text().as_str())
            .join(&manifest_id);
        fs::create_dir_all(&folder)?;
        match fs::copy(payloads.object_path_of(&content_hash), folder.join(name)) {
            Ok(_bytes) => {}
            Err(failure) if failure.kind() == io::ErrorKind::NotFound => tracing::warn!(
                manifest = %manifest_id,
                "An export left out a file the store no longer holds"
            ),
            Err(failure) => return Err(failure.into()),
        }
    }
    Ok(())
}

/// One provider account as the export writes it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportedAccount {
    provider: String,
    name: Option<String>,
    plan: Option<String>,
}

fn read_accounts(connection: &Connection) -> Result<Vec<ExportedAccount>, ExportError> {
    Ok(connection
        .prepare_cached(ACCOUNTS_SQL)?
        .query_map([], |row| {
            Ok(ExportedAccount {
                provider: row.get(0)?,
                name: row.get(1)?,
                plan: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

fn folder_path(folder: &Path) -> FilesystemPath {
    FilesystemPath::new(folder.to_string_lossy().into_owned())
        .expect("a folder the export made is a path")
}

// The bytes of every file under `folder`. Fails when an entry cannot be read, or when the walk's
// task does not finish.
async fn folder_bytes(folder: PathBuf) -> Result<u64, ExportError> {
    tokio::task::spawn_blocking(move || {
        let mut total_bytes = 0;
        for entry in WalkDir::new(folder) {
            let metadata = entry.and_then(|entry| entry.metadata())?;
            if metadata.is_file() {
                total_bytes += metadata.len();
            }
        }
        Ok::<_, walkdir::Error>(total_bytes)
    })
    .await
    .map_err(|failure| ExportError::Measure(io::Error::other(failure)))?
    .map_err(|failure| ExportError::Measure(failure.into()))
}

#[cfg(test)]
mod tests;
