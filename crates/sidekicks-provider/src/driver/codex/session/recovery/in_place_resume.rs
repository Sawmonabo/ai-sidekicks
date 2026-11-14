//! One conversation's resume in place, run on its session's task: the call that carries it there,
//! with the binding and function legs it resumes under, the turn ends the resume lists as over
//! that the daemon still owed the session, the person's answers carried to the lead a restart
//! held where the person's restart brought them, and the session's helpers reopened on the new
//! connection, each registered on its service first and, after a move, reopened by a call of its
//! own once the service that holds it loaded unloaded it, so the resume answers once the lead is
//! back; a later move takes over the waits an earlier one left.

use std::collections::HashMap;
use std::error::Error;
use std::sync::Arc;

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use tokio::sync::watch;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::CodexWriterLeft;
use crate::driver::codex::notification_routing::CodexRoutedFrames;
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceId};
use crate::driver::codex::session::calls::{CodexSessionCallDependencies, CodexSessionTask};
use crate::driver::codex::session::establishment::answer_steer::CodexAnswerSteers;
use crate::driver::codex::session::establishment::continuation::CodexHeldLeadContinue;
use crate::driver::codex::session::establishment::helpers::{
    CodexReopenedHelper, order_parents_first, reopen_registered_codex_helper,
};
use crate::driver::codex::session::establishment::{
    CodexInPlaceOutcome, CodexSessionEstablishment,
};
use crate::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInbound};
use crate::driver::codex::session::owed_turn_ends::{
    end_owed_codex_helper_turn, end_owed_codex_turns,
};
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
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

/// The conversations a move let go, each waited for on the service that holds it loaded, off the
/// session's task, before its helper is reopened on the new service, since Codex refuses a
/// helper's reopen while another service holds it loaded.
pub(crate) struct CodexReleasedConversations {
    /// Each conversation let go, its lead's aside, by the service that holds it loaded: the one
    /// the move left, or the one an earlier move left for a helper it still waited for.
    pub(crate) loaded_on: HashMap<String, Arc<CodexService>>,
    /// When the wait gives up and the reopen goes ahead, Codex deciding.
    pub(crate) deadline: Instant,
    /// The driver's tracked tasks, which the waits run on.
    pub(crate) tasks: TaskTracker,
}

/// The helpers a move still waits to reopen, which the session's record keeps, each by its
/// conversation with the service that holds it loaded, `None` where none does. Dropped, as a
/// later move takes them over or the record goes, it ends every one of those waits.
#[derive(Default)]
pub(crate) struct CodexHelperReopenWaits {
    /// Ends the waits, set as this drops.
    stop: CancellationToken,
    /// Each helper not reopened yet, with the service that holds it loaded.
    loaded_on_by_thread_id: HashMap<String, Option<Arc<CodexService>>>,
}

impl Drop for CodexHelperReopenWaits {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

/// Ends the waits an earlier move left on `record` and answers each helper they had not reopened
/// that a service still holds loaded, by that service, for the move that takes them over; run on
/// the session's task before that move lets the session's conversations go, so a reopen that ran
/// first is let go with them and one queued after is passed over.
pub(crate) fn take_codex_helper_reopen_waits(
    record: &mut CodexSessionRecord,
) -> HashMap<String, Arc<CodexService>> {
    let mut waits = std::mem::take(&mut record.helper_reopen_waits);
    std::mem::take(&mut waits.loaded_on_by_thread_id)
        .into_iter()
        .filter_map(|(thread_id, loaded_on)| Some((thread_id, loaded_on?)))
        .collect()
}

/// Resumes the session's conversation in place on the session's task, then ends each turn the
/// session still owed an end that the resume lists as over: its `turn/completed` was sent while
/// the daemon was not connected, and Codex sends none again. Once resumed, each helper whose child
/// run is still bound is reopened, since Codex attaches a running helper only to the connections
/// open as it started, and one whose newest turn is over has its owed end routed; after a move,
/// each is reopened by a call of its own on the session's task once the service that holds it
/// unloaded it, or its wait ran out, so no call to the session waits behind an unload, and a move
/// whose new service was lost reopens them so on the service the record still names. The person's
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
    let is_resumed = matches!(resumed.outcome.result, DriverResumeResult::Resumed { .. });
    if is_resumed
        && let Some(held) = &held_lead_continue
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
    match released {
        // A move whose new service was lost keeps the record on the service it was on, so the
        // helpers it let go are reopened there; any other failure lets the record go.
        Some(released) if is_resumed || resumed.outcome.is_service_lost => {
            reopen_released_codex_helpers(task, released);
        }
        None if is_resumed => routed.extend(reopen_bound_codex_helpers(task, dependencies).await),
        Some(_) | None => {}
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

// The helpers whose child runs the record still binds, parents first.
fn list_bound_codex_helpers(task: &CodexSessionTask<'_>) -> Vec<BoundHelper> {
    let bound = task
        .record
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
    order_parents_first(
        bound,
        |helper| helper.run_id,
        |helper| Some(helper.parent_run_id),
    )
}

// The session's connection, or `None`, logged, when its service went away.
fn read_session_connection(task: &CodexSessionTask<'_>) -> Option<Arc<CodexAppServerConnection>> {
    match task.record.service.connection() {
        Ok(connection) => Some(connection),
        Err(error) => {
            tracing::warn!(
                session_id = %task.record.session_id,
                error = &error as &(dyn Error + 'static),
                "the codex service went away before the session's helpers were reopened"
            );
            None
        }
    }
}

// Reopens, parents first, each helper whose child run the record still binds on the session's
// connection, registered on its service, and routes the owed end of each whose newest turn the
// reopen shows over. A refused reopen is logged and the rest go on. Answers the frames the ends
// produced.
async fn reopen_bound_codex_helpers(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexSessionCallDependencies,
) -> CodexRoutedFrames {
    let mut routed = CodexRoutedFrames::default();
    let Some(connection) = read_session_connection(task) else {
        return routed;
    };
    for helper in list_bound_codex_helpers(task) {
        routed.extend(reopen_bound_codex_helper(task, dependencies, &connection, &helper).await);
    }
    routed
}

// Waits, off the session's task, for each conversation `released` names to unload on the service
// that holds it loaded, or its deadline, each helper on a task of its own, then queues that
// helper's reopen on the session's service as a call of its own once its parent's is queued, so a
// parent is loaded before its helper is reopened and no helper waits on another's unload. The
// record keeps the waits, which end with it or once a later move takes them over.
fn reopen_released_codex_helpers(
    task: &mut CodexSessionTask<'_>,
    released: CodexReleasedConversations,
) {
    let inbound = task.record.inbound.clone();
    let reopen_on = task.record.service.id();
    let CodexReleasedConversations {
        mut loaded_on,
        deadline,
        tasks,
    } = released;
    let mut waits = CodexHelperReopenWaits::default();
    let mut queued_by_run_id: HashMap<RunId, watch::Receiver<bool>> = HashMap::new();
    // Parents first, so each parent's signal is there before its helpers look for it.
    for helper in list_bound_codex_helpers(task) {
        let (queued, is_queued) = watch::channel(false);
        let parent_queued = queued_by_run_id.get(&helper.parent_run_id).cloned();
        queued_by_run_id.insert(helper.run_id, is_queued);
        let unloading_on = loaded_on.remove(&helper.thread_id);
        waits
            .loaded_on_by_thread_id
            .insert(helper.thread_id.clone(), unloading_on.clone());
        let inbound = inbound.clone();
        let wait = async move {
            let thread_id = helper.thread_id;
            let is_unloaded = match unloading_on {
                Some(service) => service.await_unloaded(&thread_id, deadline).await,
                None => true,
            };
            if !is_unloaded {
                // Another client, such as a terminal the person joined, still holds it on the
                // service it was let go on; the reopen goes ahead and Codex decides.
                CodexTransportDiagnostic::ConversationUnloadTimedOut {
                    thread_id: thread_id.clone(),
                }
                .report();
            }
            if let Some(mut parent_queued) = parent_queued {
                // A parent whose task ended without queuing its reopen lets its helpers go ahead.
                let _parent_ended = parent_queued
                    .wait_for(|is_queued| *is_queued)
                    .await
                    .map(drop);
            }
            let call = CodexSessionCall::ReopenHelper {
                thread_id,
                service_id: reopen_on,
            };
            // The session's task ended where the push fails, so no helper of it is reopened.
            if inbound.push(CodexSessionInbound::Call(call)) {
                // A parent with no helper waiting on it has no one to tell.
                let _unwatched = queued.send(true);
            }
        };
        let stop = waits.stop.clone();
        tasks.spawn(async move {
            // The stop first, so a wait taken over or left with its record reads nothing more.
            tokio::select! {
                biased;
                () = stop.cancelled() => {}
                () = wait => {}
            }
        });
    }
    task.record.helper_reopen_waits = waits;
}

/// Reopens the helper `thread_id` on the session's connection, a move's unload wait over, where
/// the session still runs on the service `service_id` the move reopens it on, the record still
/// waits to reopen it and still binds its child run, and routes its owed end where its newest
/// turn is over. A refused reopen is logged. Answers the frames the end produced.
pub(crate) async fn reopen_released_codex_helper(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexSessionCallDependencies,
    thread_id: &str,
    service_id: CodexServiceId,
) -> CodexRoutedFrames {
    // The session moved on to another service, or a later move took the wait over.
    if task.record.service.id() != service_id
        || task
            .record
            .helper_reopen_waits
            .loaded_on_by_thread_id
            .remove(thread_id)
            .is_none()
    {
        return CodexRoutedFrames::default();
    }
    let Some(helper) = list_bound_codex_helpers(task)
        .into_iter()
        .find(|helper| helper.thread_id == thread_id)
    else {
        // Its child run ended while its unload was waited for.
        return CodexRoutedFrames::default();
    };
    let Some(connection) = read_session_connection(task) else {
        return CodexRoutedFrames::default();
    };
    reopen_bound_codex_helper(task, dependencies, &connection, &helper).await
}

// Reopens one bound helper on `connection`, registered on the session's service, and routes its
// owed end where the reopen shows its newest turn over; a refused reopen is logged.
async fn reopen_bound_codex_helper(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexSessionCallDependencies,
    connection: &CodexAppServerConnection,
    helper: &BoundHelper,
) -> CodexRoutedFrames {
    let record = &*task.record;
    let session_id = record.session_id;
    let auto_memory = record.thread_settings.auto_memory;
    let service = Arc::clone(&record.service);
    match reopen_registered_codex_helper(
        &service,
        connection,
        session_id,
        &helper.thread_id,
        auto_memory,
    )
    .await
    {
        Ok(CodexReopenedHelper {
            newest_turn: Some(newest),
            ..
        }) => {
            end_owed_codex_helper_turn(
                &mut *task.routing,
                &dependencies.forks.delivery,
                &mut *task.record,
                &helper.thread_id,
                &newest,
            )
            .await
        }
        Ok(CodexReopenedHelper {
            newest_turn: None, ..
        }) => CodexRoutedFrames::default(),
        Err(error) => {
            tracing::warn!(
                session_id = %session_id,
                run_id = %helper.run_id,
                thread_id = %helper.thread_id,
                error = &error as &(dyn Error + 'static),
                "codex refused the reopen of a helper after its service's recovery"
            );
            CodexRoutedFrames::default()
        }
    }
}
