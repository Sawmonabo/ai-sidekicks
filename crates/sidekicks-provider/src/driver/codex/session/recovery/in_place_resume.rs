//! One conversation's resume in place, run on its session's task: the call that carries it there,
//! with the binding and function legs it resumes under, the turn ends the resume lists as over
//! that the daemon still owed the session, and the session's helpers reopened on the new
//! connection, each registered on its service, a held helper's owed end written as the daemon's.

use std::error::Error;
use std::sync::Arc;

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;

use super::CodexWriterLeft;
use crate::driver::codex::notification_routing::CodexRoutedFrames;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::calls::{CodexSessionCallDependencies, CodexSessionTask};
use crate::driver::codex::session::establishment::helpers::{
    order_parents_first, reopen_registered_codex_helper,
};
use crate::driver::codex::session::establishment::{
    CodexInPlaceOutcome, CodexSessionEstablishment,
};
use crate::driver::codex::session::owed_turn_ends::{
    end_owed_codex_helper_turn, end_owed_codex_turns,
};
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
}

/// Resumes the session's conversation in place on the session's task, then ends each turn the
/// session still owed an end that the resume lists as over: its `turn/completed` was sent while
/// the daemon was not connected, and Codex sends none again. Once resumed, each helper whose child
/// run is still bound is reopened, since Codex attaches a running helper only to the connections
/// open as it started, and one whose newest turn is over has its owed end routed. Answers the
/// resume's outcome and the frames its routing released.
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
    if matches!(resumed.outcome.result, DriverResumeResult::Resumed { .. }) {
        routed.extend(reopen_bound_codex_helpers(task, dependencies).await);
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
// connection, registered on its service, and routes the owed end of each whose newest turn the
// reopen shows over, which a held helper's mark writes as the daemon's. A refused reopen is logged
// and the rest go on. Answers the frames the ends produced.
async fn reopen_bound_codex_helpers(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexSessionCallDependencies,
) -> CodexRoutedFrames {
    let mut routed = CodexRoutedFrames::default();
    let record = &*task.record;
    let session_id = record.session_id;
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
        match reopen_registered_codex_helper(&service, &connection, session_id, &helper.thread_id)
            .await
        {
            Ok(Some(newest)) => routed.extend(
                end_owed_codex_helper_turn(
                    &mut *task.routing,
                    &dependencies.forks.delivery,
                    &mut *task.record,
                    &helper.thread_id,
                    &newest,
                )
                .await,
            ),
            Ok(None) => {}
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
