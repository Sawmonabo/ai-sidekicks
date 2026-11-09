//! A session's whole conversation, every run of it, as one plain text file under a one-line header
//! per turn, kept in a session's own storage folder: the planning transcript a hand-off gives its
//! fresh session, so deleting the planning session never breaks it, and the transcript a
//! hand-over brief points at.
//!
//! - The file is rendered from the canonical fold as the log is read, one hydrated page at a time,
//!   and a body too long for a page is written a frame at a time, so memory holds one page and the
//!   segment being written, never the session.
//! - Each attempt writes under a temporary name of its own, removed on any failure, and the whole
//!   file then takes its name without replacing one already there, so a reader never meets half a
//!   file and two attempts, a late one included, leave one whole copy.
//! - The storage folder goes with its session's purge.

use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::Connection;
use sidekicks_artifact::attachment_resolver::read_manifest_file_name;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::queued::AgentRunQueuedPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::hand_over::canonical_transcript::{
    CanonicalToolResultOutcome, CanonicalToolResultProvenance, CanonicalTranscriptFoldError,
    CanonicalTranscriptRole, CanonicalTranscriptSegment, shown_tool_result_body,
};
use sidekicks_provider::hand_over::session_transcript::{
    SessionTranscriptError, SessionTranscriptSink, stream_session_transcript,
};
use sidekicks_session::queue_store::QueueItemReader;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::file::publish_without_replacing::publish_without_replacing;
use sidekicks_std::missing_entry::MissingEntry as _;
use sidekicks_std::random_hex::random_hex;
use sidekicks_store::data_folder::session_storage_folder;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::read::DamagedFromSequenceReader;

pub(crate) mod brief;

/// The planning transcript's file name in the fresh session's storage folder.
pub(crate) const PLANNING_TRANSCRIPT_FILE_NAME: &str = "planning-transcript.txt";

// How many random bytes name one attempt's temporary file.
const ATTEMPT_NAME_BYTES: usize = 8;

/// Why a transcript file could not be written.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TranscriptFileError {
    /// The read pool is closed, a connection did not open, or the read did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The transcript could not be read or written; the attempt's temporary file is removed, and
    /// a failure to remove it rides beside the cause.
    #[error(transparent)]
    Render(#[from] Box<CleanupFailures<TranscriptRenderError, io::Error>>),
    /// The whole file could not be given its name; its temporary file is removed, and a failure to
    /// remove it rides beside the cause.
    #[error("the transcript file could not be given its name")]
    Publish(#[source] CleanupFailures<io::Error>),
}

/// Why rendering a transcript into its temporary file stopped.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TranscriptRenderError {
    /// The session's log could not be read, or a row did not read as its type's.
    #[error(transparent)]
    Fold(#[from] CanonicalTranscriptFoldError),
    /// A message's queued item or one of its files' manifests could not be read.
    #[error("a message's attachments could not be read")]
    Attachments(#[source] rusqlite::Error),
    /// The system gave no random bytes to name the attempt's temporary file.
    #[error("the transcript file's temporary name could not be made")]
    TemporaryName(#[source] getrandom::Error),
    /// The storage folder or the temporary file could not be made or written.
    #[error("the transcript file could not be written")]
    Write(#[from] io::Error),
}

/// Writes a session's transcript as a file into a session's storage folder.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the plan verdict's hand-off and the provider switch's hand-over brief write \
                  session transcripts"
    )
)]
pub(crate) struct TranscriptFileWriter {
    reads: Arc<DatabaseReadPool>,
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    data_folder: PathBuf,
    /// Holds an attempt once its file is written, before it takes its name.
    #[cfg(test)]
    publish_pause: sidekicks_std::pause_point::PausePoint,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the plan verdict's hand-off and the provider switch's hand-over brief write \
                  session transcripts"
    )
)]
impl TranscriptFileWriter {
    /// A writer reading through `reads`, stopping a damaged session's reads where
    /// `read_damaged_from_sequence` answers, and writing under `data_folder`.
    pub(crate) fn new(
        reads: Arc<DatabaseReadPool>,
        read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
        data_folder: PathBuf,
    ) -> Self {
        Self {
            reads,
            read_damaged_from_sequence,
            data_folder,
            #[cfg(test)]
            publish_pause: sidekicks_std::pause_point::PausePoint::default(),
        }
    }

    /// Writes `planning_session_id`'s transcript as [`PLANNING_TRANSCRIPT_FILE_NAME`] in
    /// `fresh_session_id`'s storage folder and answers the file's path. A file already there is
    /// left as it is. Fails when the log cannot be read or the file cannot be written or named,
    /// leaving no temporary file and nothing under the file's name.
    pub(crate) async fn write_planning_transcript(
        &self,
        planning_session_id: SessionId,
        fresh_session_id: SessionId,
    ) -> Result<PathBuf, TranscriptFileError> {
        self.write_file(
            planning_session_id,
            fresh_session_id,
            PLANNING_TRANSCRIPT_FILE_NAME,
            None,
        )
        .await
    }

    /// Writes `source_session_id`'s transcript as `file_name` in `storage_session_id`'s storage
    /// folder and answers the file's path: the whole of it, or with `after_sequence` only the runs
    /// created after that sequence. A file already there is left as it is. Fails when the log
    /// cannot be read or the file cannot be written or named, leaving no temporary file and nothing
    /// under the file's name.
    pub(crate) async fn write_file(
        &self,
        source_session_id: SessionId,
        storage_session_id: SessionId,
        file_name: &str,
        after_sequence: Option<i64>,
    ) -> Result<PathBuf, TranscriptFileError> {
        let storage_folder = session_storage_folder(&self.data_folder, &storage_session_id);
        let file_path = storage_folder.join(file_name);
        let temporary_stem = Path::new(file_name)
            .file_stem()
            .map_or_else(String::new, |stem| stem.to_string_lossy().into_owned());
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        let read_file_path = file_path.clone();
        let written = self
            .reads
            .read(ReadLength::Long, move |connection| {
                write_temporary_file(
                    connection,
                    &*read_damaged_from_sequence,
                    source_session_id,
                    after_sequence,
                    &read_file_path,
                    &temporary_stem,
                )
                .map_err(TranscriptFileError::from)
            })
            .await?;
        let Some(temporary_path) = written else {
            return Ok(file_path);
        };
        #[cfg(test)]
        self.publish_pause.pass().await;
        publish_without_replacing(&temporary_path, &file_path)
            .await
            .map_err(TranscriptFileError::Publish)?;
        Ok(file_path)
    }
}

/// Removes session `session_id`'s storage folder under `data_folder` and everything in it; a
/// session that has none changes nothing. Fails with the removal's failure.
pub(crate) async fn remove_session_storage_folder(
    data_folder: &Path,
    session_id: SessionId,
) -> io::Result<()> {
    let folder = session_storage_folder(data_folder, &session_id);
    sidekicks_std::file::remove_tree_awaited(&folder).await
}

// Renders `source_session_id`'s transcript, past `after_sequence` where given, into a new file
// beside `file_path`, named `<temporary_stem>.<this attempt's own>.tmp`, and answers its path,
// `None` when `file_path` is already there. A failure removes the file it made.
fn write_temporary_file(
    connection: &Connection,
    read_damaged_from_sequence: &DamagedFromSequenceReader,
    source_session_id: SessionId,
    after_sequence: Option<i64>,
    file_path: &Path,
    temporary_stem: &str,
) -> Result<Option<PathBuf>, Box<CleanupFailures<TranscriptRenderError, io::Error>>> {
    let unmade = |failure: TranscriptRenderError| {
        Box::new(CleanupFailures::new(failure, Vec::new(), RENDERING))
    };
    let storage_folder = file_path
        .parent()
        .expect("a file in a storage folder has a parent");
    if fs::symlink_metadata(file_path)
        .none_if_missing()
        .map_err(|failure| unmade(failure.into()))?
        .is_some()
    {
        return Ok(None);
    }
    fs::create_dir_all(storage_folder).map_err(|failure| unmade(failure.into()))?;
    let attempt = random_hex(ATTEMPT_NAME_BYTES)
        .map_err(|failure| unmade(TranscriptRenderError::TemporaryName(failure)))?;
    let temporary_path = storage_folder.join(format!("{temporary_stem}.{attempt}.tmp"));
    // A new file only, so an attempt never writes into another's.
    let file = File::options()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|failure| unmade(failure.into()))?;
    match render_transcript(
        connection,
        read_damaged_from_sequence,
        source_session_id,
        after_sequence,
        file,
    ) {
        Ok(()) => Ok(Some(temporary_path)),
        Err(failure) => {
            let removal_failures = fs::remove_file(&temporary_path).err().into_iter().collect();
            Err(Box::new(CleanupFailures::new(
                failure,
                removal_failures,
                RENDERING,
            )))
        }
    }
}

// What a rendering failure names as its operation.
const RENDERING: &str = "writing a transcript file";

// Streams `session_id`'s transcript, past `after_sequence` where given, into `file` and flushes
// it to disk.
fn render_transcript(
    connection: &Connection,
    read_damaged_from_sequence: &DamagedFromSequenceReader,
    session_id: SessionId,
    after_sequence: Option<i64>,
    file: File,
) -> Result<(), TranscriptRenderError> {
    let mut sink = TranscriptFileSink {
        text: PlainTranscript::new(BufWriter::new(file)),
        attachments: AttachmentNames {
            connection,
            session_id,
        },
        run: RunHeader::default(),
        turn_role: None,
    };
    stream_session_transcript(
        connection,
        read_damaged_from_sequence,
        &session_id,
        after_sequence,
        &mut sink,
    )
    .map_err(|failure| match failure {
        SessionTranscriptError::Fold(failure) => TranscriptRenderError::Fold(failure),
        SessionTranscriptError::Sink(failure) => failure,
    })?;
    sink.text
        .into_inner()
        .into_inner()
        .map_err(io::IntoInnerError::into_error)?
        .sync_all()?;
    Ok(())
}

/// Who a run's turns are headed by: the session's own runs name the person and the agent, a
/// helper's run its agent where the run names one.
#[derive(Clone, Debug, Default)]
struct RunHeader {
    number: u64,
    helper: Option<HelperName>,
}

/// A helper run's agent, by the name it was resolved under; `None` for a provider's own subagent.
#[derive(Clone, Debug)]
struct HelperName(Option<String>);

impl RunHeader {
    // The header of `queued`'s run, numbered `number`.
    fn of(number: u64, queued: &AgentRunQueuedPayload) -> Self {
        let helper = queued.parent_run_id().map(|_| {
            HelperName(match queued {
                AgentRunQueuedPayload::SessionAgent(_) => None,
                AgentRunQueuedPayload::ResolvedAgent(payload) => {
                    Some(payload.resolved_agent.name.as_str().to_owned())
                }
            })
        });
        Self { number, helper }
    }

    // The header line of a turn of `role` in this run.
    fn turn_line(&self, role: CanonicalTranscriptRole) -> String {
        let number = self.number;
        match (&self.helper, role) {
            (Some(HelperName(Some(name))), _) => format!("[helper {name} \u{b7} run {number}]"),
            (Some(HelperName(None)), _) => format!("[helper \u{b7} run {number}]"),
            (None, CanonicalTranscriptRole::User) => format!("[person \u{b7} run {number}]"),
            (None, CanonicalTranscriptRole::Assistant) => format!("[agent \u{b7} run {number}]"),
        }
    }
}

/// Plain transcript text written as it is handed on: a header line opens each turn, a blank line
/// sets each turn and each segment apart, and every block ends with a line break.
struct PlainTranscript<Out> {
    out: Out,
    has_written: bool,
    is_turn_start: bool,
    ends_in_line_break: bool,
}

impl<Out: Write> PlainTranscript<Out> {
    fn new(out: Out) -> Self {
        Self {
            out,
            has_written: false,
            is_turn_start: false,
            ends_in_line_break: true,
        }
    }

    fn into_inner(self) -> Out {
        self.out
    }

    /// Opens a turn under `header`, a blank line before it unless it is the first.
    fn open_turn(&mut self, header: &str) -> io::Result<()> {
        if self.has_written {
            self.raw("\n")?;
        }
        self.line(header)?;
        self.is_turn_start = true;
        Ok(())
    }

    /// Writes `segment` whole.
    fn segment(&mut self, segment: &CanonicalTranscriptSegment) -> io::Result<()> {
        self.open_segment(segment, false)?;
        self.end_line()
    }

    /// Writes `segment`'s label and its text so far, leaving the line open for its body's frames
    /// where `is_body_following`.
    fn open_segment(
        &mut self,
        segment: &CanonicalTranscriptSegment,
        is_body_following: bool,
    ) -> io::Result<()> {
        if !self.is_turn_start {
            self.raw("\n")?;
        }
        self.is_turn_start = false;
        let (body, is_content_unavailable) = match segment {
            CanonicalTranscriptSegment::Text {
                text,
                is_content_unavailable,
                ..
            } => (text.as_str(), *is_content_unavailable),
            CanonicalTranscriptSegment::Reasoning { text, .. } => {
                self.line("Reasoning:")?;
                (text.as_str(), false)
            }
            CanonicalTranscriptSegment::ToolCall {
                tool_call_id,
                tool_name,
                arguments_json,
                is_content_unavailable,
                ..
            } => {
                self.line(&format!("Tool call {tool_name} ({tool_call_id})"))?;
                (arguments_json.as_str(), *is_content_unavailable)
            }
            CanonicalTranscriptSegment::ToolResult {
                outcome,
                provenance,
                end_cause,
                text,
                is_content_unavailable,
                ..
            } => {
                self.line(&tool_result_line(*outcome, *provenance))?;
                let shown = if is_body_following {
                    text.as_str()
                } else {
                    shown_tool_result_body(text, *end_cause)
                };
                (shown, *is_content_unavailable)
            }
        };
        if is_content_unavailable {
            return self.line("[unavailable]");
        }
        self.raw(body)
    }

    /// Writes the next frame of an open segment's body.
    fn frame(&mut self, frame: &str) -> io::Result<()> {
        self.raw(frame)
    }

    /// Ends the open line, if one is open.
    fn end_line(&mut self) -> io::Result<()> {
        if self.ends_in_line_break {
            return Ok(());
        }
        self.raw("\n")
    }

    /// Writes `text` as a line of its own.
    fn line(&mut self, text: &str) -> io::Result<()> {
        self.end_line()?;
        self.raw(text)?;
        self.raw("\n")
    }

    fn raw(&mut self, text: &str) -> io::Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        self.out.write_all(text.as_bytes())?;
        self.has_written = true;
        self.ends_in_line_break = text.ends_with('\n');
        Ok(())
    }
}

// A tool result's label: how it ended, and whether the pairing repair made it.
fn tool_result_line(
    outcome: CanonicalToolResultOutcome,
    provenance: CanonicalToolResultProvenance,
) -> String {
    let outcome = outcome.as_str();
    match provenance {
        CanonicalToolResultProvenance::Provider => format!("Tool result ({outcome})"),
        CanonicalToolResultProvenance::Repaired => format!("Tool result ({outcome}, repaired)"),
    }
}

/// The names of the files a person's message carried, read from its queued item and the
/// session's manifests on the transcript's own connection.
struct AttachmentNames<'reader> {
    connection: &'reader Connection,
    session_id: SessionId,
}

impl AttachmentNames<'_> {
    /// The names of the files the message queued as `queue_item_id` was sent with, in staging
    /// order; a file whose manifest records no name is named by its id.
    fn of(&self, queue_item_id: &QueueItemId) -> Result<Vec<String>, TranscriptRenderError> {
        let item = QueueItemReader::new(self.connection)
            .get(queue_item_id)
            .map_err(TranscriptRenderError::Attachments)?;
        let Some(attachments) = item
            .as_ref()
            .and_then(|item| item.body.as_message())
            .and_then(|message| message.attachments.as_ref())
        else {
            return Ok(Vec::new());
        };
        attachments
            .0
            .iter()
            .map(|artifact_id| {
                let name = read_manifest_file_name(self.connection, &self.session_id, artifact_id)
                    .map_err(TranscriptRenderError::Attachments)?;
                Ok(name.unwrap_or_else(|| artifact_id.text().as_str().to_owned()))
            })
            .collect()
    }
}

/// Renders the transcript into the file as each piece is handed on.
struct TranscriptFileSink<'reader> {
    text: PlainTranscript<BufWriter<File>>,
    attachments: AttachmentNames<'reader>,
    run: RunHeader,
    turn_role: Option<CanonicalTranscriptRole>,
}

impl SessionTranscriptSink for TranscriptFileSink<'_> {
    type Error = TranscriptRenderError;

    fn open_run(
        &mut self,
        number: u64,
        queued: &AgentRunQueuedPayload,
    ) -> Result<(), TranscriptRenderError> {
        self.run = RunHeader::of(number, queued);
        Ok(())
    }

    fn open_turn(&mut self, role: CanonicalTranscriptRole) -> Result<(), TranscriptRenderError> {
        self.turn_role = Some(role);
        Ok(self.text.open_turn(&self.run.turn_line(role))?)
    }

    fn segment(
        &mut self,
        segment: CanonicalTranscriptSegment,
    ) -> Result<(), TranscriptRenderError> {
        self.text.segment(&segment)?;
        if let (
            Some(CanonicalTranscriptRole::User),
            CanonicalTranscriptSegment::Text {
                queue_item_id: Some(queue_item_id),
                ..
            },
        ) = (self.turn_role, &segment)
        {
            for name in self.attachments.of(queue_item_id)? {
                self.text.line(&format!("[attachment {name}]"))?;
            }
        }
        Ok(())
    }

    fn open_streamed_segment(
        &mut self,
        head: CanonicalTranscriptSegment,
    ) -> Result<(), TranscriptRenderError> {
        Ok(self.text.open_segment(&head, true)?)
    }

    fn body_frame(&mut self, frame: &str) -> Result<(), TranscriptRenderError> {
        Ok(self.text.frame(frame)?)
    }

    fn close_streamed_segment(&mut self) -> Result<(), TranscriptRenderError> {
        Ok(self.text.end_line()?)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;

    use rusqlite::params;
    use serde_json::json;
    use sidekicks_artifact::schema::ARTIFACT_STATEMENT_CAPACITY;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_store::data_folder::session_storage_folder;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::events::session::read::HYDRATED_PAGE_TEXT_BYTES;
    use sidekicks_store::events::test_log::{AT, SessionTestLog};

    use super::{PLANNING_TRANSCRIPT_FILE_NAME, TranscriptFileWriter};

    fn run_queued(log: &SessionTestLog, run_id: RunId, parent_run_id: Option<RunId>) {
        let mut payload = json!({
            "sessionId": log.session_id,
            "runId": run_id,
            "runVersion": 0,
            "newState": "queued",
            "agentId": mint_uuid_v7().to_string(),
            "admittedProviderAccountId": "account-1",
        });
        if let Some(parent_run_id) = parent_run_id {
            payload["parentRunId"] = json!(parent_run_id);
            payload["reachedBy"] = json!("providerSubagent");
        }
        log.write(
            json!({ "type": "agent.run.queued", "payload": payload }),
            None,
        );
    }

    fn tool_row(log: &SessionTestLog, event_type: &str, body: Option<&str>) {
        log.write(
            json!({
                "type": event_type,
                "payload": {
                    "sessionId": log.session_id,
                    "runId": log.run_id,
                    "toolName": "read",
                    "toolCallId": "call-1",
                },
            }),
            body,
        );
    }

    // The planning session's log: the lead's run with the person's message carrying two files,
    // one whose manifest is gone, the agent's reasoning, a call, a result whose body is gone and
    // a reply; a run with no row; and a helper's run whose one reply is longer than a page.
    // Answers the file the log renders to.
    fn plan_session(log: &SessionTestLog) -> String {
        let named = mint_uuid_v7().to_string();
        let gone = mint_uuid_v7().to_string();
        log.writer
            .execute(
                "INSERT INTO artifact_manifests (id, session_id, artifact_type, content_hash, \
                 size_bytes, metadata, created_at) VALUES (?1, ?2, 'file', ?3, 5, ?4, ?5)",
                params![
                    named,
                    log.session_id.text().as_str(),
                    format!("sha256:{}", "0".repeat(64)),
                    json!({ "fileName": "sketch.png" }).to_string(),
                    AT,
                ],
            )
            .expect("the manifest is written");
        let queue_item_id = mint_uuid_v7().to_string();
        log.writer
            .execute(
                "INSERT INTO queue_items (id, session_id, state, payload, target_run_id, \
                 position, created_at, updated_at) VALUES (?1, ?2, 'admitted', ?3, ?4, 0, ?5, ?5)",
                params![
                    queue_item_id,
                    log.session_id.text().as_str(),
                    json!({
                        "kind": "message",
                        "content": "Plan the change",
                        "attachments": [named, gone],
                    })
                    .to_string(),
                    log.run_id.text().as_str(),
                    AT,
                ],
            )
            .expect("the queue item is written");
        run_queued(log, log.run_id, None);
        log.write(
            json!({
                "type": "user.message.sent",
                "payload": {
                    "sessionId": log.session_id,
                    "queueItemId": queue_item_id,
                    "runId": log.run_id,
                    "actor": "person",
                    "message": "Plan the change",
                },
            }),
            None,
        );
        log.piece(
            "agent.thinking.updated",
            log.run_id,
            "t1",
            None,
            "Reading the code.",
            AT,
        );
        tool_row(log, "agent.toolCall.invoked", Some(r#"{"path":"a.rs"}"#));
        tool_row(log, "agent.toolCall.completed", None);
        log.reply("m1", None, "Here is the plan.");
        let empty = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        run_queued(log, empty, None);
        let helper = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        run_queued(log, helper, Some(log.run_id));
        let long_reply = "0123456789abcdef".repeat(
            usize::try_from(HYDRATED_PAGE_TEXT_BYTES).expect("a page's text fits") / 16 + 1024,
        );
        log.piece("agent.message.sent", helper, "m2", None, &long_reply, AT);
        format!(
            "[person \u{b7} run 1]\nPlan the change\n[attachment sketch.png]\n[attachment {gone}]\n\
             \n[agent \u{b7} run 1]\nReasoning:\nReading the code.\n\
             \nTool call read (call-1)\n{{\"path\":\"a.rs\"}}\n\
             \nTool result (succeeded)\n[unavailable]\n\
             \nHere is the plan.\n\
             \n[helper \u{b7} run 3]\n{long_reply}\n"
        )
    }

    fn entries(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(folder)
            .expect("the storage folder reads")
            .map(|entry| {
                entry
                    .expect("the entry reads")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        names
    }

    // Killed by the file written into the planning session's storage, by a file written under its
    // final name before it is whole, by two attempts sharing one temporary name, and by a write
    // that replaces a file already there.
    #[tokio::test]
    async fn the_transcript_is_one_whole_file_in_the_fresh_sessions_storage() {
        let log = SessionTestLog::new(crate::daemon::schema::schema_parts());
        let expected = plan_session(&log);
        let data_folder = tempfile::tempdir().expect("the data folder is made");
        let writer = Arc::new(TranscriptFileWriter::new(
            Arc::new(DatabaseReadPool::new(
                log.database.path(),
                ARTIFACT_STATEMENT_CAPACITY,
            )),
            Arc::new(|_: &SessionId| None),
            data_folder.path().to_path_buf(),
        ));
        let planning = log.session_id;
        let fresh = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
        let storage = session_storage_folder(data_folder.path(), &fresh);
        let file_path = storage.join(PLANNING_TRANSCRIPT_FILE_NAME);

        // The first attempt is held once its file is written, before it takes its name.
        let held = writer.publish_pause.arm();
        let first = tokio::spawn({
            let writer = Arc::clone(&writer);
            async move { writer.write_planning_transcript(planning, fresh).await }
        });
        held.reached.await.expect("the first attempt is held");
        let first_entries = entries(&storage);
        assert_eq!(first_entries.len(), 1, "{first_entries:?}");
        assert_ne!(first_entries[0], PLANNING_TRANSCRIPT_FILE_NAME);

        let second = writer
            .write_planning_transcript(planning, fresh)
            .await
            .expect("the second attempt writes");
        assert_eq!(second, file_path);
        assert_eq!(
            entries(&storage),
            [
                first_entries[0].clone(),
                PLANNING_TRANSCRIPT_FILE_NAME.to_owned()
            ],
            "the first attempt's file is its own"
        );
        held.release.send(()).expect("the first attempt waits");
        let first = first
            .await
            .expect("the first attempt ends")
            .expect("the first attempt answers the file");

        assert_eq!(first, file_path);
        assert_eq!(entries(&storage), [PLANNING_TRANSCRIPT_FILE_NAME]);
        assert_eq!(
            fs::read_to_string(&file_path).expect("the file reads"),
            expected
        );
        assert!(!session_storage_folder(data_folder.path(), &planning).exists());

        fs::write(&file_path, "kept\n").expect("the file is changed");
        writer
            .write_planning_transcript(planning, fresh)
            .await
            .expect("a write with the file there answers it");
        assert_eq!(
            fs::read_to_string(&file_path).expect("the file reads"),
            "kept\n"
        );
    }
}
