//! One conversation's resume in place, run on its session's task: the call that carries it there,
//! with the binding and function legs it resumes under, the turn ends the resume lists as over
//! that the daemon still owed the session, the person's answers carried to the lead a restart
//! held where the person's restart brought them, and the session's helpers reopened on the new
//! connection, each registered on its service first and, after a move, unloaded on the service the
//! move left.

use std::error::Error;
use std::sync::Arc;

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use tokio::time::Instant;

use super::CodexWriterLeft;
use crate::driver::codex::notification_routing::CodexRoutedFrames;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::calls::{CodexSessionCallDependencies, CodexSessionTask};
use crate::driver::codex::session::establishment::answer_steer::CodexAnswerSteers;
use crate::driver::codex::session::establishment::continuation::CodexHeldLeadContinue;
use crate::driver::codex::session::establishment::helpers::{
    CodexReopenedHelper, order_parents_first, reopen_registered_codex_helper,
};
use crate::driver::codex::session::establishment::{
    CodexInPlaceOutcome, CodexSessionEstablishment,
};
use crate::driver::codex::session::owed_turn_ends::{
    end_owed_codex_helper_turn, end_owed_codex_turns,
};
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::driver::session_control::DriverResumeResult;
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
    /// The person's answers the session's held lead is owed, where the person's restart carries
    /// them.
    pub(crate) held_lead_continue: Option<CodexHeldLeadContinue>,
    /// Sends the answers' steer to a held lead whose continuation Codex still runs.
    pub(crate) answer_steers: Arc<CodexAnswerSteers>,
    /// The conversations a move let go on the service it left, `None` for a resume on the service
    /// the conversation already ran on.
    pub(crate) released: Option<CodexReleasedConversations>,
}

/// The conversations a move let go on the service it left, each waited for there before its
/// helper is reopened on the new service, since Codex refuses a helper's reopen while another
/// service holds it loaded.
pub(crate) struct CodexReleasedConversations {
    /// The service the move left.
    pub(crate) service: Arc<CodexService>,
    /// The conversations let go there, its lead's aside.
    pub(crate) thread_ids: Vec<String>,
    /// When the wait gives up and the reopen goes ahead, Codex deciding.
    pub(crate) deadline: Instant,
}

/// Resumes the session's conversation in place on the session's task, then ends each turn the
/// session still owed an end that the resume lists as over: its `turn/completed` was sent while
/// the daemon was not connected, and Codex sends none again. Once resumed, each helper whose child
/// run is still bound is reopened, since Codex attaches a running helper only to the connections
/// open as it started, and one whose newest turn is over has its owed end routed; one a move let go
/// is reopened once the service the move left unloaded it, or its wait ran out. The person's
/// answers the call carries go to the held lead as an adoption carries them, its answer in the
/// outcome set still running where they reached it. Answers the resume's outcome and the frames
/// its routing released.
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
        held_lead_continue,
        answer_steers,
        released,
    } = resume;
    let mut resumed = establishment
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
    if matches!(resumed.outcome.result, DriverResumeResult::Resumed { .. }) {
        if let Some(held) = &held_lead_continue
            && let Some(answer_steer) = establishment
                .continue_held_lead_in_place(
                    task.record,
                    resumed.status,
                    &resumed.listed_turns,
                    held,
                    &mut resumed.outcome.result,
                )
                .await
        {
            answer_steers.send(answer_steer, task.record.inbound.clone());
        }
        routed.extend(reopen_bound_codex_helpers(task, dependencies, released.as_ref()).await);
    }
    (resumed.outcome, routed)
}

// One helper whose child run is bound: its conversation, its child run and the run beneath which
// it runs.
#[expect(
    clippy::struct_field_names,
    reason = "each member is an id, named for what it identifies"
)]
struct BoundHelper {
    thread_id: String,
    run_id: RunId,
    parent_run_id: RunId,
}

// Reopens, parents first, each helper whose child run the record still binds on the session's
// connection, registered on its service, each `released` names first waited for on the service it
// was let go on, and routes the owed end of each whose newest turn the reopen shows over. A refused
// reopen is logged and the rest go on. Answers the frames the ends produced.
async fn reopen_bound_codex_helpers(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexSessionCallDependencies,
    released: Option<&CodexReleasedConversations>,
) -> CodexRoutedFrames {
    let mut routed = CodexRoutedFrames::default();
    let record = &*task.record;
    let session_id = record.session_id;
    let auto_memory = record.thread_settings.auto_memory;
    let service = Arc::clone(&record.service);
    let connection = match service.connection() {
        Ok(connection) => connection,
        Err(error) => {
            tracing::warn!(
                session_id = %session_id,
                error = &error as &(dyn Error + 'static),
                "the codex service went away before the session's helpers were reopened"
            );
            return routed;
        }
    };
    let bound: Vec<BoundHelper> = record
        .delivery
        .child_run_by_thread_id
        .iter()
        .filter_map(|(thread_id, child)| {
            let bound = child.bound.as_ref()?;
            Some(BoundHelper {
                thread_id: thread_id.clone(),
                run_id: bound.child_run_id,
                parent_run_id: bound.parent_run_id,
            })
        })
        .collect();
    let ordered = order_parents_first(
        bound,
        |helper| helper.run_id,
        |helper| Some(helper.parent_run_id),
    );
    for helper in ordered {
        if let Some(released) = released
            && released.thread_ids.contains(&helper.thread_id)
            && !released
                .service
                .await_unloaded(&helper.thread_id, released.deadline)
                .await
        {
            // Another client, such as a terminal the person joined, still holds it on the old
            // service; the reopen goes ahead and Codex decides.
            CodexTransportDiagnostic::ConversationUnloadTimedOut {
                thread_id: helper.thread_id.clone(),
            }
            .report();
        }
        match reopen_registered_codex_helper(
            &service,
            &connection,
            session_id,
            &helper.thread_id,
            auto_memory,
        )
        .await
        {
            Ok(CodexReopenedHelper {
                newest_turn: Some(newest),
                ..
            }) => routed.extend(
                end_owed_codex_helper_turn(
                    &mut *task.routing,
                    &dependencies.forks.delivery,
                    &mut *task.record,
                    &helper.thread_id,
                    &newest,
                )
                .await,
            ),
            Ok(CodexReopenedHelper {
                newest_turn: None, ..
            }) => {}
            Err(error) => tracing::warn!(
                session_id = %session_id,
                run_id = %helper.run_id,
                thread_id = %helper.thread_id,
                error = &error as &(dyn Error + 'static),
                "codex refused the reopen of a helper after its service's recovery"
            ),
        }
    }
    routed
}
