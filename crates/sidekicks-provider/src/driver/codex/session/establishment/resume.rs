//! A session's conversation resumed in place on its service, after the service crashed or its
//! connection came back, or once it left the old service for a new build: the resume sent with
//! every setting the record holds, its history read back, and the record moved onto it.

use std::sync::Arc;

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;

use super::adoption::answer_codex_resumed_turns;
use super::{
    CodexInPlaceOutcome, CodexInPlaceResume, CodexResumedThread, CodexSessionEstablishment,
    compose_failed_resume, prepare_adoption, read_resumed_thread,
};
use crate::driver::codex::notification_routing::CodexRoutedFrames;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::calls::CodexSessionTask;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::thread::permission_profiles::CodexThreadPermissionProfiles;
use crate::driver::codex::thread::settings::tool_servers::CodexDaemonToolServers;
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::runtime_binding::resume::ResumeFunctionLegs;

impl CodexSessionEstablishment {
    /// Resumes the session's conversation on `service` in place, on the session's task: after its
    /// service crashed or its connection came back, or once it left the old service for a new
    /// build. The resume carries the settings the record holds now, under `binding_id`, which the
    /// caller minted and opened, the resumed conversation reporting on `function_legs`' status
    /// sink, and the conversation's turns come back with the result, so a caller can end the ones
    /// that ended unseen. A resume refused while another runtime still writes the conversation is
    /// tried again each time `writer_left` answers `true`. Every failure answers `Failed`,
    /// reported.
    pub(crate) async fn resume_in_place<WriterLeft>(
        &self,
        task: &mut CodexSessionTask<'_>,
        service: Arc<CodexService>,
        binding_id: RuntimeBindingId,
        function_legs: ResumeFunctionLegs,
        mut writer_left: impl FnMut() -> WriterLeft,
    ) -> CodexInPlaceResume
    where
        WriterLeft: Future<Output = bool>,
    {
        // Asked for before the resume, so no report of it can arrive ahead of the record knowing.
        task.record.permission_profiles =
            CodexThreadPermissionProfiles::established(&task.record.thread_settings);
        // Opened once, so every resume sent again carries the same secret.
        let resumed = match self.open_tool_servers(
            &service,
            task.record.session_id,
            task.record.callback_tools(),
        ) {
            Ok(tool_servers) => loop {
                match self
                    .resume_thread(task.record, &service, tool_servers.as_ref())
                    .await
                {
                    Err(error) if error.is_active_writer_refusal() && writer_left().await => {}
                    Ok(resumed) => break Ok((resumed, tool_servers)),
                    Err(error) => {
                        if let Some(tool_servers) = tool_servers {
                            tool_servers.rollback();
                        }
                        break Err(error);
                    }
                }
            },
            Err(error) => Err(error),
        };
        match self
            .adopt_resumed_thread(
                task,
                Arc::clone(&service),
                binding_id,
                function_legs,
                resumed,
            )
            .await
        {
            Ok(resumed) => resumed,
            Err(error) => {
                let is_service_lost = service.connection().is_err() || error.is_connection_closed();
                let result = compose_failed_resume(Some(&service), &error).await;
                CodexTransportDiagnostic::ConversationResumeFailed {
                    thread_id: task.record.thread_id.clone(),
                    error: Box::new(error),
                }
                .report();
                CodexInPlaceResume {
                    outcome: CodexInPlaceOutcome {
                        result,
                        is_service_lost,
                    },
                    listed_turns: Vec::new(),
                    status: None,
                    routed: CodexRoutedFrames::default(),
                }
            }
        }
    }

    // Moves the record onto the resumed conversation: its service, binding, status sink, turns,
    // tier and effort, its hold on the daemon's tool servers, its mode sent again, and its routing
    // band rebound on the sum already metered; the binding it retires lets go of its held presses
    // and ends its leg's status, once, where its process's end has not. The record changes only once every step that can fail is
    // done; a failure releases the conversation's registration on `service` when the resume made
    // it.
    async fn adopt_resumed_thread(
        &self,
        task: &mut CodexSessionTask<'_>,
        service: Arc<CodexService>,
        binding_id: RuntimeBindingId,
        function_legs: ResumeFunctionLegs,
        resumed: Result<(CodexResumedThread, Option<CodexDaemonToolServers>), CodexError>,
    ) -> Result<CodexInPlaceResume, CodexError> {
        let (resumed, tool_servers) = resumed?;
        let runs = answer_codex_resumed_turns(
            resumed.status,
            &resumed.listed_turns,
            group_turns_by_run(&task.record.active_turns),
        );
        let adopted = prepare_adoption(task.record, &service, &resumed, &binding_id, runs).await;
        let result = match adopted {
            Ok(adopted) => adopted,
            Err(error) => {
                if !resumed.was_held {
                    service.release_thread(&task.record.thread_id);
                }
                if let Some(tool_servers) = tool_servers {
                    tool_servers.rollback();
                }
                return Err(error);
            }
        };
        let record = &mut *task.record;
        record.service = service;
        record.daemon_tool_servers = tool_servers;
        let retired = record.binding_id.replace(binding_id);
        record.end_mcp_server_status_leg();
        record.on_mcp_server_status = function_legs.on_mcp_server_status;
        // An `Allow once` held on the retired binding's blocks can be pressed again.
        if let (Some(retired), Some(denials)) = (retired, self.dependencies.reviewer_denials.port())
        {
            denials.release_held_presses(&retired);
        }
        record.turn_boundaries = resumed
            .listed_turns
            .iter()
            .map(|listed| listed.id.clone())
            .collect();
        record.declared_output_speed = resumed.declared_output_speed;
        record.reasoning_effort = resumed.reasoning_effort;
        self.record_service_process(record.session_id, &record.service);
        self.dependencies
            .provider_commands
            .discard_listing(record.session_id);
        let thread_id = record.thread_id.clone();
        let routed = task
            .routing
            .rebind_session_thread(&self.dependencies.delivery, task.record, thread_id)
            .await;
        Ok(CodexInPlaceResume {
            outcome: CodexInPlaceOutcome {
                result,
                is_service_lost: false,
            },
            listed_turns: resumed.listed_turns,
            status: resumed.status,
            routed,
        })
    }

    // `thread/resume` with every setting the record holds, then the turn history read back page
    // by page. A reply naming another conversation fails: Codex started a replacement.
    async fn resume_thread(
        &self,
        record: &CodexSessionRecord,
        service: &CodexService,
        tool_servers: Option<&CodexDaemonToolServers>,
    ) -> Result<CodexResumedThread, CodexError> {
        let connection = service.connection()?;
        let _claim = service.begin_thread_claim();
        let reply = self
            .request_resume_with_settings(record, service, &connection, tool_servers)
            .await?;
        let was_held = service
            .threads_of(&record.session_id)
            .contains(&record.thread_id);
        // Registered before the history read, so the thread's frames reach the session from now.
        service.register_thread(record.thread_id.clone(), record.session_id);
        match read_resumed_thread(record, &connection, &reply, was_held).await {
            Ok(resumed) => Ok(resumed),
            Err(error) => {
                if !was_held {
                    service.release_thread(&record.thread_id);
                }
                Err(error)
            }
        }
    }
}

// Each run of `turns`, live turns with their runs, with its turns' ids, in the order the runs
// first appear.
fn group_turns_by_run(turns: &[(String, RunId)]) -> Vec<(RunId, Vec<&str>)> {
    let mut grouped: Vec<(RunId, Vec<&str>)> = Vec::new();
    for (turn_id, run_id) in turns {
        match grouped
            .iter_mut()
            .find(|(grouped_run, _)| grouped_run == run_id)
        {
            Some((_, turn_ids)) => turn_ids.push(turn_id),
            None => grouped.push((*run_id, vec![turn_id])),
        }
    }
    grouped
}
