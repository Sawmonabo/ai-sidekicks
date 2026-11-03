//! The hand-over brief's export: the old provider's own summary, taken through its driver on a
//! throwaway copy of the session, and the session's whole transcript written as one plain file
//! beside the brief in the session's own storage folder, for the new provider to open with its own
//! file tools. Each export writes a file of its own, so a brief never points at an older one.

#![cfg_attr(
    not(test),
    expect(dead_code, reason = "the provider switch's hand-over brief")
)]

use std::path::PathBuf;

use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::session_control::{
    DriverHandoverBriefResult, ExportHandoverBriefParams,
};
use sidekicks_std::random_hex::random_hex;

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
/// the summary is taken. Fails as the summary, the file's name or the file fails; a failed summary
/// writes no file.
pub(crate) async fn export_hand_over_brief(
    driver: &dyn ProviderDriver,
    writer: &TranscriptFileWriter,
    params: ExportHandoverBriefParams,
) -> Result<HandOverBriefExport, HandOverBriefExportError> {
    let session_id = params.session_id;
    let summary = driver.export_handover_brief(params).await?;
    let export_name = random_hex(EXPORT_NAME_BYTES).map_err(HandOverBriefExportError::FileName)?;
    let transcript_file = writer
        .write_file(
            session_id,
            session_id,
            &format!("{HAND_OVER_TRANSCRIPT_FILE_STEM}-{export_name}.txt"),
        )
        .await?;
    Ok(HandOverBriefExport {
        summary,
        transcript_file,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;

    use futures::FutureExt as _;
    use serde_json::{Map, json};
    use sidekicks_artifact::schema::ARTIFACT_STATEMENT_CAPACITY;
    use sidekicks_contracts::agent::definition::AgentId;
    use sidekicks_contracts::agent::definition::binding::ProviderToken;
    use sidekicks_contracts::provider::driver::declared_loss::DeclaredLossKind;
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
    use sidekicks_store::events::test_log::SessionTestLog;

    use super::{HAND_OVER_TRANSCRIPT_FILE_STEM, export_hand_over_brief};
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

        let first = export_hand_over_brief(&driver, &writer, export_params(session_id))
            .await
            .expect("the brief exports");
        let second = export_hand_over_brief(&driver, &writer, export_params(session_id))
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
}
