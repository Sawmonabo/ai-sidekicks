//! One conversation's resume in place, run on its session's task: the call that carries it there,
//! with the binding and function legs it resumes under, and the turn ends the resume lists as over
//! that the daemon still owed the session.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;

use super::CodexWriterLeft;
use crate::driver::codex::event_normalizer::CODEX_TURN_COMPLETED_METHOD;
use crate::driver::codex::notification_routing::CodexRoutedFrames;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::calls::{CodexSessionCallDependencies, CodexSessionTask};
use crate::driver::codex::session::establishment::{
    CodexInPlaceOutcome, CodexSessionEstablishment,
};
use crate::driver::codex::transport::connection::read_codex_object;
use crate::driver::codex::turn_evidence::CodexTurnStatus;
use crate::runtime_binding::resume::ResumeFunctionLegs;

/// One resume in place, as a call carries it to the session's task.
pub(crate) struct CodexInPlaceResumeCall {
    /// The establishment that resumes it.
    pub(crate) establishment: Arc<CodexSessionEstablishment>,
    /// The service it resumes on.
    pub(crate) service: Arc<CodexService>,
    /// The binding it resumes under, its cursor already open.
    pub(crate) binding_id: RuntimeBindingId,
    /// The function legs the session directory answered for the binding, which the resumed
    /// conversation reports on.
    pub(crate) function_legs: ResumeFunctionLegs,
    /// Whether a refusing writer let the conversation go.
    pub(crate) writer_left: CodexWriterLeft,
}

/// Resumes the session's conversation in place on the session's task, then ends each turn the
/// session still owed an end that the resume lists as over: its `turn/completed` was sent while
/// the daemon was not connected, and Codex sends none again. Answers the resume's outcome and the
/// frames its routing released.
pub(crate) async fn resume_codex_session_in_place(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexSessionCallDependencies,
    resume: CodexInPlaceResumeCall,
) -> (CodexInPlaceOutcome, CodexRoutedFrames) {
    let CodexInPlaceResumeCall {
        establishment,
        service,
        binding_id,
        function_legs,
        writer_left,
    } = resume;
    let resumed = establishment
        .resume_in_place(task, service, binding_id, function_legs, writer_left)
        .await;
    let mut routed = resumed.routed;
    for listed in resumed.listed_turns {
        let is_owed = task.record.active_turn_run(&listed.id).is_some()
            || task.record.ending_turn_ids().contains(&listed.id.as_str());
        if !is_owed || is_turn_in_progress(&listed.turn) {
            continue;
        }
        let Some(params) = compose_turn_completed_params(&task.record.thread_id, &listed.turn)
        else {
            continue;
        };
        let ended = task
            .routing
            .route_notification(
                &dependencies.forks.delivery,
                task.record,
                CODEX_TURN_COMPLETED_METHOD.to_owned(),
                params,
            )
            .await;
        routed.extend(ended);
    }
    (resumed.outcome, routed)
}

// Whether a listed turn still runs.
fn is_turn_in_progress(turn: &RawValue) -> bool {
    #[derive(Deserialize)]
    struct ListedTurnStatus {
        status: Option<String>,
    }
    read_codex_object::<ListedTurnStatus>(turn.get())
        .and_then(|listed| listed.status)
        .and_then(|status| CodexTurnStatus::read(&status))
        == Some(CodexTurnStatus::InProgress)
}

// The params of the `turn/completed` Codex sent for a listed turn: the conversation and the turn.
fn compose_turn_completed_params(thread_id: &str, turn: &RawValue) -> Option<Box<RawValue>> {
    let thread_id = serde_json::to_string(thread_id).ok()?;
    RawValue::from_string(format!(
        r#"{{"threadId":{thread_id},"turn":{}}}"#,
        turn.get()
    ))
    .ok()
}
