//! A Codex helper reopened on the daemon's connection: Codex attaches a loaded helper only to the
//! connections that were open when the helper started, so the daemon's connection receives its
//! frames only after a `thread/resume` of it, which Codex accepts only once its parent is loaded.
//! A helper reopened after the adoption is registered on the session's service first, and one
//! re-attached after a restart is then bound to its child run and registered in the session's
//! routing, as an adoption restores a helper; a held helper's turn listed over at the adoption
//! ends as the daemon's.

use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;

use super::adoption::request_bare_thread_resume;
use crate::driver::codex::delivery::memory::{CodexBoundChildRun, CodexChildRun};
use crate::driver::codex::notification_routing::CodexRoutedFrames;
use crate::driver::codex::run::routes::CodexRunRoutes;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::calls::{CodexSessionCallDependencies, CodexSessionTask};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::history::{CodexListedTurn, read_codex_resumed_newest_turn};
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::run_control::ReattachedHelper;
use crate::usage_delta_accountant::UsageAxisCounts;

/// Reopens the helper `thread_id` on `connection` as it stands, with no setting, and answers its
/// newest turn, `None` where it holds none; Codex answers a resume that asks for its newest-turn
/// page, as this one does, with the page or a refusal, so a reply with no page holds no turn.
/// Fails as the resume does, a parent not loaded among Codex's refusals.
pub(crate) async fn reopen_codex_helper(
    connection: &CodexAppServerConnection,
    thread_id: &str,
) -> Result<Option<CodexListedTurn>, CodexError> {
    let reply = request_bare_thread_resume(connection, thread_id).await?;
    Ok(read_codex_resumed_newest_turn(&reply))
}

/// Reopens the helper `thread_id` as [`reopen_codex_helper`] does, registered on `service` as
/// session `session_id`'s first, since Codex sends a reopened helper's waiting asks right after
/// its reply and the service refuses one no session names. A refused reopen lets go of the
/// registration it made; one already there stays.
pub(crate) async fn reopen_registered_codex_helper(
    service: &CodexService,
    connection: &CodexAppServerConnection,
    session_id: SessionId,
    thread_id: &str,
) -> Result<Option<CodexListedTurn>, CodexError> {
    let was_registered = service
        .threads_of(&session_id)
        .iter()
        .any(|registered| registered == thread_id);
    service.register_thread(thread_id.to_owned(), session_id);
    let reopened = reopen_codex_helper(connection, thread_id).await;
    if reopened.is_err() && !was_registered {
        service.release_thread(thread_id);
    }
    reopened
}

/// Binds the helper `subagent_id`, whose id is its conversation's, to its child run `bound` on
/// `binding_id` for `agent_id`, so its rows and asks land on that run and its end completes it,
/// and routes the run to the helper's conversation, which an interrupt of the run reaches.
pub(crate) fn bind_codex_helper_run(
    record: &mut CodexSessionRecord,
    run_routes: &CodexRunRoutes,
    subagent_id: SubagentId,
    bound: CodexBoundChildRun,
    agent_id: AgentId,
    binding_id: RuntimeBindingId,
) {
    let thread_id = subagent_id.as_str().to_owned();
    run_routes.bind_helper_run(bound.child_run_id, record.session_id, &thread_id);
    record.delivery.child_run_by_thread_id.insert(
        thread_id,
        CodexChildRun {
            bound: Some(bound),
            agent_id,
            binding_id,
            subagent_id,
            parent_tool_call_id: None,
        },
    );
}

/// Restores a helper re-attached after a restart on the session's task, as an adoption restores
/// one it reopened: bound to its existing child run on the session's binding, then registered in
/// the session's routing beneath its conversation, its usage based on `prior_emitted`, what was
/// already metered on it. A helper the routing knows already is left as it is; a conversation no
/// run named a binding for binds no run. Answers the frames that waited for the helper.
pub(crate) async fn restore_reattached_codex_helper(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexSessionCallDependencies,
    helper: ReattachedHelper,
    prior_emitted: UsageAxisCounts,
) -> CodexRoutedFrames {
    let thread_id = helper.subagent_id.as_str().to_owned();
    if task.routing.is_helper_thread(&thread_id) {
        return CodexRoutedFrames::default();
    }
    if let Some(binding_id) = task.record.binding_id.clone() {
        let agent_id = task.record.lead_agent_id;
        bind_codex_helper_run(
            task.record,
            &dependencies.runs.run_routes,
            helper.subagent_id,
            CodexBoundChildRun {
                child_run_id: helper.run_id,
                parent_run_id: helper.parent_run_id,
                start_row_event_id: None,
            },
            agent_id,
            binding_id,
        );
    }
    task.routing
        .restore_helper_thread(
            &dependencies.forks.delivery,
            task.record,
            thread_id,
            prior_emitted,
        )
        .await
}

/// Orders `helpers` so each comes after the listed helper whose run is its parent run, otherwise
/// keeping their order. Each pass moves every helper whose parent run is no longer waiting, so it
/// takes at most as many passes as helpers; a cycle keeps the rest in their order.
pub(crate) fn order_parents_first<T>(
    helpers: Vec<T>,
    run_id: impl Fn(&T) -> RunId,
    parent_run_id: impl Fn(&T) -> Option<RunId>,
) -> Vec<T> {
    let mut ordered = Vec::with_capacity(helpers.len());
    let mut waiting = helpers;
    while !waiting.is_empty() {
        let waiting_run_ids: Vec<RunId> = waiting.iter().map(&run_id).collect();
        let (ready, held): (Vec<T>, Vec<T>) = waiting.into_iter().partition(|helper| {
            parent_run_id(helper).is_none_or(|parent| !waiting_run_ids.contains(&parent))
        });
        if ready.is_empty() {
            ordered.extend(held);
            break;
        }
        ordered.extend(ready);
        waiting = held;
    }
    ordered
}
