//! One conversation's resume in place, run on its session's task: the call that carries it there,
//! with the binding and function legs it resumes under, and the turn ends the resume lists as over
//! that the daemon still owed the session.

use std::sync::Arc;

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;

use super::CodexWriterLeft;
use crate::driver::codex::notification_routing::CodexRoutedFrames;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::calls::{CodexSessionCallDependencies, CodexSessionTask};
use crate::driver::codex::session::establishment::{
    CodexInPlaceOutcome, CodexSessionEstablishment,
};
use crate::driver::codex::session::owed_turn_ends::end_owed_codex_turns;
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
    routed.extend(
        end_owed_codex_turns(
            &mut *task.routing,
            &dependencies.forks.delivery,
            &mut *task.record,
            &resumed.listed_turns,
        )
        .await,
    );
    (resumed.outcome, routed)
}
