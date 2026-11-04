//! The hand-over brief's export and composition. The export takes the old provider's own summary
//! through its driver on a throwaway copy of the session and writes the session's transcript as
//! one plain file beside the brief in the session's own storage folder, for the new provider to
//! open with its own file tools; each export writes a file of its own, so a brief never points at
//! an older one. The composition frames that summary with the working folder's branch and changes
//! read from disk and the session's steps and newest exchanges read from its log, at that moment.

#![cfg_attr(
    not(test),
    expect(dead_code, reason = "the provider switch's hand-over brief")
)]

use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::session_control::{
    DriverHandoverBriefResult, ExportHandoverBriefParams,
};
use sidekicks_provider::hand_over::brief::frame::{
    BriefCoverage, BriefFrame, BriefFrameParts, BriefHistory, ComposedBrief, WorkingDiff,
};
use sidekicks_provider::hand_over::canonical_transcript::CanonicalTranscriptFoldError;
use sidekicks_provider::hand_over::session_transcript::{
    SessionTranscriptError, stream_session_transcript,
};
use sidekicks_std::random_hex::random_hex;
use sidekicks_store::database::connection::read_pool::{DatabaseReadError, ReadLength};
use sidekicks_workspace::git::process::{GitCall, GitError, GitOutput, GitRunner, background_read};
use sidekicks_workspace::working_folder::{WorkingFolderReadError, read_working_folder};

use crate::hand_over::{TranscriptFileError, TranscriptFileWriter};

/// How a hand-over transcript's file name starts, before the export's own part.
pub(crate) const HAND_OVER_TRANSCRIPT_FILE_STEM: &str = "hand-over-transcript";

// How many random bytes name one export's transcript file.
const EXPORT_NAME_BYTES: usize = 8;

/// What a hand-over brief is composed from: the old provider's summary and the transcript file
/// beside it.
#[derive(Debug)]
pub(crate) struct HandOverBriefExport {
    /// The summary, which of the provider's own or the template's it is, and what it lost.
    pub(crate) summary: DriverHandoverBriefResult,
    /// The session's whole transcript, as one plain file in its storage folder.
    pub(crate) transcript_file: PathBuf,
}

/// Why a hand-over brief could not be exported.
#[derive(Debug, thiserror::Error)]
pub(crate) enum HandOverBriefExportError {
    /// The old provider's driver could not take the summary.
    #[error(transparent)]
    Summary(#[from] DriverError),
    /// The system gave no random bytes to name the transcript file.
    #[error("the hand-over transcript's name could not be made")]
    FileName(#[source] getrandom::Error),
    /// The transcript file could not be written.
    #[error(transparent)]
    Transcript(#[from] TranscriptFileError),
}

/// Takes `params`' session's summary through `driver`, then writes the session's transcript as a
/// new file in its storage folder through `writer`, so the file holds the log as it stands once
/// the summary is taken: the whole conversation, or with `after_sequence` the runs created after
/// it, which a move back to a provider the session ran on passes. Fails as the summary, the file's
/// name or the file fails; a failed summary writes no file.
pub(crate) async fn export_hand_over_brief(
    driver: &dyn ProviderDriver,
    writer: &TranscriptFileWriter,
    params: ExportHandoverBriefParams,
    after_sequence: Option<i64>,
) -> Result<HandOverBriefExport, HandOverBriefExportError> {
    let session_id = params.session_id;
    let summary = driver.export_handover_brief(params).await?;
    let export_name = random_hex(EXPORT_NAME_BYTES).map_err(HandOverBriefExportError::FileName)?;
    let transcript_file = writer
        .write_file(
            session_id,
            session_id,
            &format!("{HAND_OVER_TRANSCRIPT_FILE_STEM}-{export_name}.txt"),
            after_sequence,
        )
        .await?;
    Ok(HandOverBriefExport {
        summary,
        transcript_file,
    })
}

/// Why a hand-over brief could not be composed; the move it was for then fails.
#[derive(Debug, thiserror::Error)]
pub(crate) enum HandOverBriefComposeError {
    /// The read pool is closed, a connection did not open, or a read did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The session's working folder could not be read.
    #[error(transparent)]
    WorkingFolder(#[from] WorkingFolderReadError),
    /// The session has no working folder in place, so there is no branch or change to read.
    #[error("the session has no working folder to read its branch and changes from")]
    NoWorkingFolder,
    /// git could not read the working folder's branch, status or diff.
    #[error("the working folder's branch or changes could not be read")]
    Git(#[source] GitError),
    /// The session's log could not be read, or a row did not read as its type's.
    #[error(transparent)]
    Transcript(#[from] CanonicalTranscriptFoldError),
}

/// Composes the hand-over brief of `session_id` for a target model whose context window is
/// `target_context_window_tokens`, around `export`, this move's summary and the transcript file
/// it wrote from the same `after_sequence`: `None` on a move to a provider the session has not
/// run on, else the sequence after which a move back's brief begins. It reads the working folder
/// once, its branch, status and diff through `git` once each, and the session's log in one pass
/// through `writer`'s reads. Fails when any of those reads fails.
pub(crate) async fn compose_hand_over_brief(
    writer: &TranscriptFileWriter,
    git: &GitRunner,
    session_id: SessionId,
    export: &HandOverBriefExport,
    target_context_window_tokens: u64,
    after_sequence: Option<i64>,
) -> Result<ComposedBrief, HandOverBriefComposeError> {
    let working = writer
        .reads
        .read(ReadLength::Short, move |connection| {
            Ok::<_, HandOverBriefComposeError>(read_working_folder(connection, &session_id)?)
        })
        .await?;
    let folder = working
        .working_folder
        .ok_or(HandOverBriefComposeError::NoWorkingFolder)?;
    let place = working.place.as_ref();
    let (branch, status, diff) = tokio::join!(
        git.run(
            place,
            GitCall::read(background_read(&folder, &["branch", "--show-current"]))
        ),
        git.run(
            place,
            GitCall::live_index_read(&folder, &["status", "--short"])
        ),
        // The counts and the patch in one read, so a diff past the budget costs no second one.
        git.run(
            place,
            GitCall::live_index_read(&folder, &["diff", "HEAD", "--stat", "--patch"])
        ),
    );
    let branch = output_text(&branch.map_err(HandOverBriefComposeError::Git)?);
    let status = output_text(&status.map_err(HandOverBriefComposeError::Git)?);
    let diff = match diff {
        Ok(output) => Some(output_text(&output)),
        // A repository with no commit has no HEAD to diff against; any other failure stands.
        Err(failure @ GitError::Exited { .. }) => {
            let head = GitCall::read(background_read(
                &folder,
                &["rev-parse", "--verify", "--quiet", "HEAD"],
            ));
            match git.run(place, head).await {
                Err(GitError::Exited { .. }) => None,
                Ok(_) => return Err(HandOverBriefComposeError::Git(failure)),
                Err(other) => return Err(HandOverBriefComposeError::Git(other)),
            }
        }
        Err(failure) => return Err(HandOverBriefComposeError::Git(failure)),
    };

    let summary = export.summary.summary.clone();
    let read_damaged_from_sequence = Arc::clone(&writer.read_damaged_from_sequence);
    let history = writer
        .reads
        .read(ReadLength::Long, move |connection| {
            let mut history = BriefHistory::new(summary);
            stream_session_transcript(
                connection,
                &*read_damaged_from_sequence,
                &session_id,
                after_sequence,
                &mut history,
            )
            .map_err(|failure| match failure {
                SessionTranscriptError::Fold(failure) => {
                    HandOverBriefComposeError::Transcript(failure)
                }
                SessionTranscriptError::Sink(never) => match never {},
            })?;
            Ok::<_, HandOverBriefComposeError>(history)
        })
        .await?;

    let diff = match &diff {
        Some(output) => {
            let (stat, patch) = split_stat_and_patch(output);
            WorkingDiff::AgainstHead { stat, patch }
        }
        None => WorkingDiff::NoCommitYet,
    };
    let parts = BriefFrameParts {
        coverage: match after_sequence {
            None => BriefCoverage::WholeConversation,
            Some(_) => BriefCoverage::SinceLastTurn,
        },
        summary: &export.summary.summary,
        summary_losses: &export.summary.declared_losses,
        branch: &branch,
        status: &status,
        diff,
        transcript_file: &export.transcript_file,
    };
    Ok(BriefFrame::for_context_window(target_context_window_tokens).render(&parts, history))
}

// What git printed, as text.
fn output_text(output: &GitOutput) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

// `git diff --stat --patch`'s output cut into its per-file counts and its patch, which starts at
// its first `diff --git` line; a count line starts with a space, so it never reads as one.
fn split_stat_and_patch(output: &str) -> (&str, &str) {
    match output.find("\ndiff --git ") {
        Some(end) => (&output[..end], &output[end + 1..]),
        None => (output, ""),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;

    use futures::FutureExt as _;
    use rusqlite::params;
    use serde_json::{Map, json};
    use sidekicks_artifact::schema::ARTIFACT_STATEMENT_CAPACITY;
    use sidekicks_contracts::agent::definition::AgentId;
    use sidekicks_contracts::agent::definition::binding::ProviderToken;
    use sidekicks_contracts::provider::driver::declared_loss::DeclaredLossKind;
    use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceState};
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::controls::methods::SessionMode;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::record::Record;
    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::session_control::{
        DriverHandoverBriefResult, ExportHandoverBriefParams, HandoverSummaryKind,
        ResumeSessionParams,
    };
    use sidekicks_provider::runtime_binding::store::mint_runtime_binding_id;
    use sidekicks_provider::runtime_binding::test_store::test_provider_account_id;
    use sidekicks_store::data_folder::session_storage_folder;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::events::test_log::SessionTestLog;
    use sidekicks_workspace::git::process::test_git_runner;
    use sidekicks_workspace::git::process::test_repository::{
        commit_empty, git_in, make_test_repository,
    };
    use sidekicks_workspace::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};

    use super::{
        HAND_OVER_TRANSCRIPT_FILE_STEM, HandOverBriefExport, compose_hand_over_brief,
        export_hand_over_brief,
    };
    use crate::hand_over::TranscriptFileWriter;

    fn export_params(session_id: SessionId) -> ExportHandoverBriefParams {
        ExportHandoverBriefParams {
            session_id,
            binding_id: mint_runtime_binding_id(),
            resume: ResumeSessionParams {
                session_id,
                binding_id: mint_runtime_binding_id(),
                agent_id: AgentId::new(&mint_uuid_v7().to_string())
                    .expect("a minted UUID is an agent id"),
                resume_handle: "conversation".to_owned(),
                model: ProviderToken::new("opus".to_owned()).expect("the model fits"),
                larger_window: None,
                runtime_metadata: Map::new(),
                mode: SessionMode::Build,
                execution_posture: None,
                output_speed: None,
                options: Vec::new(),
                row_values: Record::default(),
                callback_tools: None,
                subagent_policy: None,
                tool_servers: None,
                output_schema: None,
                provider_account_id: test_provider_account_id(),
                on_mcp_server_status: None,
                kept_schedules: Vec::new(),
                live_runs: Vec::new(),
                held_run_continue: None,
            },
        }
    }

    // Killed by the file written inside the brief's projection, or anywhere but the session's own
    // storage folder, and by a second export that points at the first's file.
    #[tokio::test]
    async fn the_transcript_file_lands_beside_the_brief_in_the_sessions_storage() {
        let log = SessionTestLog::new(crate::daemon::schema::schema_parts());
        log.write(
            json!({ "type": "agent.run.queued", "payload": {
                "sessionId": log.session_id,
                "runId": log.run_id,
                "runVersion": 0,
                "newState": "queued",
                "agentId": mint_uuid_v7().to_string(),
                "admittedProviderAccountId": "account-1",
            }}),
            None,
        );
        log.reply("m1", None, "Here is the plan.");
        let data_folder = tempfile::tempdir().expect("the data folder is made");
        let writer = TranscriptFileWriter::new(
            Arc::new(DatabaseReadPool::new(
                log.database.path(),
                ARTIFACT_STATEMENT_CAPACITY,
            )),
            Arc::new(|_: &SessionId| None),
            data_folder.path().to_path_buf(),
        );
        let summary = DriverHandoverBriefResult {
            summary: "1. The goal of this work.".to_owned(),
            kind: HandoverSummaryKind::Template,
            declared_losses: vec![DeclaredLossKind::ConversationHistorySummarized],
        };
        let mut driver = MockProviderDriver::new();
        let session_id = log.session_id;
        let answered = summary.clone();
        driver
            .expect_export_handover_brief()
            .withf(move |params| params.session_id == session_id)
            .times(2)
            .returning(move |_params| futures::future::ready(Ok(answered.clone())).boxed());

        let first = export_hand_over_brief(&driver, &writer, export_params(session_id), None)
            .await
            .expect("the brief exports");
        let second = export_hand_over_brief(&driver, &writer, export_params(session_id), None)
            .await
            .expect("a second brief exports");

        assert_eq!(first.summary, summary);
        let storage = session_storage_folder(data_folder.path(), &session_id);
        for export in [&first, &second] {
            assert_eq!(export.transcript_file.parent(), Some(storage.as_path()));
            let name = export
                .transcript_file
                .file_name()
                .expect("the file has a name")
                .to_string_lossy();
            assert!(name.starts_with(HAND_OVER_TRANSCRIPT_FILE_STEM), "{name}");
            assert_eq!(
                fs::read_to_string(&export.transcript_file).expect("the file reads"),
                "[agent \u{b7} run 1]\nHere is the plan.\n"
            );
        }
        assert_ne!(first.transcript_file, second.transcript_file);
    }

    // A run of the session, `run_id`, with one completed `read` call `tool_call_id`.
    fn run_with_call(log: &SessionTestLog, run_id: RunId, tool_call_id: &str) {
        log.write(
            json!({ "type": "agent.run.queued", "payload": {
                "sessionId": log.session_id,
                "runId": run_id,
                "runVersion": 0,
                "newState": "queued",
                "agentId": mint_uuid_v7().to_string(),
                "admittedProviderAccountId": "account-1",
            }}),
            None,
        );
        for (event_type, body) in [
            ("agent.toolCall.invoked", "{\"path\":\"a.txt\"}"),
            ("agent.toolCall.completed", "file text"),
        ] {
            log.write(
                json!({ "type": event_type, "payload": {
                    "sessionId": log.session_id,
                    "runId": run_id,
                    "toolName": "read",
                    "toolCallId": tool_call_id,
                }}),
                Some(body),
            );
        }
    }

    // Killed by the diff or the branch read from anything but the folder on disk, by the
    // transcript file left out of section 5, and by the start ignored.
    #[tokio::test]
    async fn the_brief_carries_the_folders_changes_and_starts_where_it_is_told() {
        let log = SessionTestLog::new(crate::daemon::schema::schema_parts());
        insert_session_row(&log.writer, log.session_id.text().as_str(), None, None);
        let git = test_git_runner();
        let scratch = tempfile::tempdir().expect("the scratch folder is made");
        let repository = make_test_repository(&git, scratch.path(), "app").await;
        fs::write(repository.join("a.txt"), "one\n").expect("the file is written");
        git_in(&git, &repository, &["add", "a.txt"]).await;
        commit_empty(&git, &repository, "add a.txt").await;
        fs::write(repository.join("a.txt"), "two\n").expect("the file is changed");
        let mount_id = mint_uuid_v7().to_string();
        for row in project_and_mount_rows(&mount_id, None) {
            log.writer
                .execute_batch(&row)
                .expect("the project and its mount are stored");
        }
        log.writer
            .execute(
                "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, \
                 state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    mint_uuid_v7().to_string(),
                    log.session_id.text().as_str(),
                    mount_id,
                    <&'static str>::from(ExecutionMode::BoundRoot),
                    repository.to_str().expect("the repository's path is text"),
                    <&'static str>::from(WorkspaceState::Ready),
                    PARENT_ROWS_AT,
                ],
            )
            .expect("the workspace is stored");
        run_with_call(&log, log.run_id, "call-before");
        let (start, _) = log.reply("m1", None, "Done before the move.");
        run_with_call(
            &log,
            RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
            "call-after",
        );
        let data_folder = tempfile::tempdir().expect("the data folder is made");
        let writer = TranscriptFileWriter::new(
            Arc::new(DatabaseReadPool::new(
                log.database.path(),
                ARTIFACT_STATEMENT_CAPACITY,
            )),
            Arc::new(|_: &SessionId| None),
            data_folder.path().to_path_buf(),
        );
        let export = HandOverBriefExport {
            summary: DriverHandoverBriefResult {
                summary: "1. The goal of this work.".to_owned(),
                kind: HandoverSummaryKind::Template,
                declared_losses: vec![DeclaredLossKind::ConversationHistorySummarized],
            },
            transcript_file: PathBuf::from("/data/sessions/s/hand-over-transcript-1.txt"),
        };

        let whole = compose_hand_over_brief(&writer, &git, log.session_id, &export, 200_000, None)
            .await
            .expect("the brief composes");
        let since =
            compose_hand_over_brief(&writer, &git, log.session_id, &export, 200_000, Some(start))
                .await
                .expect("the brief composes");

        assert!(whole.text.contains("Branch: `main`"), "{}", whole.text);
        assert!(
            whole.text.contains("`git status --short`:\n\n M a.txt"),
            "{}",
            whole.text
        );
        assert!(whole.text.contains("-one\n+two"), "{}", whole.text);
        assert!(
            whole
                .text
                .contains("one plain file at `/data/sessions/s/hand-over-transcript-1.txt`")
        );
        assert!(
            since
                .text
                .starts_with("This conversation went on elsewhere since your last turn")
        );
        assert_eq!(
            steps_of(&whole.text),
            "- read: {\"path\":\"a.txt\"} \u{2192} succeeded\n\
             - read: {\"path\":\"a.txt\"} \u{2192} succeeded"
        );
        assert_eq!(
            steps_of(&since.text),
            "- read: {\"path\":\"a.txt\"} \u{2192} succeeded"
        );
    }

    // A brief's section 3, its step lines.
    fn steps_of(text: &str) -> &str {
        text.split("## 3. Every earlier step, one line each, with its output left out")
            .nth(1)
            .and_then(|rest| rest.split("## 4.").next())
            .expect("the steps section is there")
            .trim()
    }
}
