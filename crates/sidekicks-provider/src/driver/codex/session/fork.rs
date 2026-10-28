//! Forking a session's Codex conversation and moving the session onto the fork: the whole of it
//! onto a changed config, to just before a held turn for the faster-model retry, or after a
//! recorded boundary for a rewind. A fork is a new conversation carrying every setting the session
//! holds, started in the session's mode. The session's binding is pointed at the fork before the
//! conversation the session leaves is let go, so a daemon restart never resumes a conversation the
//! session moved off; that one is let go once no command of it runs.

pub(crate) mod config_change;

use std::sync::Arc;

use serde_json::value::RawValue;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::controls::methods::SessionMode;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::compaction_wait::PendingCompactionRegistry;
use crate::driver::codex::capabilities::read_codex_service_model_catalog;
use crate::driver::codex::delivery::frames::CodexFrameDelivery;
use crate::driver::codex::delivery::frames::turns::codex_compaction_wait_key;
use crate::driver::codex::notification_routing::CodexRoutedFrames;
use crate::driver::codex::output_speed::{
    compose_codex_service_tier, read_codex_declared_tier, resolve_codex_output_speed_level,
};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::calls::CodexSessionTask;
use crate::driver::codex::session::controls::update_codex_session_mode;
use crate::driver::codex::session::conversation_release::CodexConversationRelease;
use crate::driver::codex::session::errors::{CodexError, classify_rewind_fork_failure};
use crate::driver::codex::session::history::read_codex_turns;
use crate::driver::codex::session::slots::let_go_codex_thread;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::thread::permission_profiles::CodexThreadPermissionProfiles;
use crate::driver::codex::thread::settings::{
    CodexServiceTierChange, CodexThreadSettings, compose_codex_thread_fork_params,
};
use crate::driver::codex::thread::view::{
    assert_codex_thread_profile, read_thread, read_thread_reasoning_effort,
};
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::driver::session_control::{MoveSessionToForkParams, MoveSessionToForkResult};
use crate::left_conversations::LeftConversation;
use crate::port::reviewer_denial::ReviewerDenialPort;
use crate::port::tool_server_route::ToolServerRoute;
use crate::runtime_binding::rebinder::RuntimeBindingRebinder;
use crate::runtime_binding::store::RuntimeBindingRebind;
use sidekicks_std::port_registration::PortRegistration;

const THREAD_FORK_METHOD: &str = "thread/fork";

/// The port name a failed binding write is reported under.
const RUNTIME_BINDING_STORE_PORT: &str = "runtime binding store";

/// The fallbacks a rewind's fork takes instead of moving the session.
const REWIND_NOT_FORKED: &str = "rewind-not-forked";
const REWIND_TARGET_ALREADY_REGISTERED: &str = "rewind-target-thread-already-registered";
const REWIND_DEFERRED_TURN_IN_PROGRESS: &str = "rewind-deferred-turn-in-progress";
const REWIND_TARGET_NOT_A_RECORDED_BOUNDARY: &str = "rewind-target-not-a-recorded-boundary";

/// What a fork reads and acts through beside the session's own task.
pub(crate) struct CodexForkDependencies {
    /// The frame delivery, which the frames that waited for a fork go to.
    pub(crate) delivery: Arc<CodexFrameDelivery>,
    /// Where each conversation the session leaves is held until no command of it runs.
    pub(crate) release: Arc<CodexConversationRelease>,
    /// The runtime bindings, each pointed at the conversation its session moved onto.
    pub(crate) bindings: Arc<dyn RuntimeBindingRebinder>,
    /// The route to the daemon's tool servers, once its owner registered it.
    pub(crate) tool_server_route: Arc<PortRegistration<Arc<dyn ToolServerRoute>>>,
    /// The reviewer's denials, whose held presses on a binding the fork retires are released.
    pub(crate) reviewer_denials: Arc<PortRegistration<Arc<dyn ReviewerDenialPort>>>,
    /// The compaction waits, whose wait on a conversation the session leaves ends.
    pub(crate) pending_compactions: PendingCompactionRegistry,
}

/// Where a fork keeps the conversation up to.
#[derive(Clone, Copy)]
pub(crate) enum CodexForkBoundary<'turn> {
    /// The whole conversation.
    Whole,
    /// Every turn before this one.
    BeforeTurn(&'turn str),
    /// Every turn up to this one.
    AfterTurn(&'turn str),
}

/// A fork Codex answered: its reply and the new conversation's id.
pub(crate) struct CodexForkReply {
    /// The reply as sent.
    pub(crate) reply: Box<RawValue>,
    /// The new conversation.
    pub(crate) thread_id: String,
}

/// What a fork carries: the settings and output speed of the session it is for, and the
/// conversation it forks.
pub(crate) struct CodexForkSource<'source> {
    /// Every setting the session holds.
    pub(crate) settings: &'source CodexThreadSettings,
    /// The output-speed level the session asks for.
    pub(crate) output_speed_request: Option<String>,
    /// The conversation forked.
    pub(crate) thread_id: String,
}

/// Forks the session's conversation, whole or to just before `before_turn_id`, on the settings
/// its record holds now, and moves the session onto the fork under `binding_id`; the caller holds
/// the session's slot. A config change the record owed is carried by the fork. Answers the frames
/// that waited for the fork, delivered. Fails as the fork's request, its checks or the binding's
/// write fail, with `CodexError::Transport` for a reply that names no new conversation; the
/// session stays on its conversation and still owes what it owed.
pub(crate) async fn establish_codex_fork(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexForkDependencies,
    before_turn_id: Option<&str>,
    binding_id: Option<RuntimeBindingId>,
) -> Result<CodexRoutedFrames, CodexError> {
    let was_config_fork_owed = task.record.is_config_fork_owed;
    task.record.is_config_fork_owed = false;
    let forked = fork_onto_settings(task, dependencies, before_turn_id, binding_id).await;
    if forked.is_err() {
        task.record.is_config_fork_owed |= was_config_fork_owed;
    }
    forked
}

async fn fork_onto_settings(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexForkDependencies,
    before_turn_id: Option<&str>,
    binding_id: Option<RuntimeBindingId>,
) -> Result<CodexRoutedFrames, CodexError> {
    let service = Arc::clone(&task.record.service);
    let connection = service.connection()?;
    // Frames of the fork that arrive before it is registered are held for it.
    let _claim = service.begin_thread_claim();
    let boundary = before_turn_id.map_or(CodexForkBoundary::Whole, CodexForkBoundary::BeforeTurn);
    let forked = request_codex_fork(
        record_fork_source(task.record),
        &dependencies.tool_server_route,
        &connection,
        boundary,
    )
    .await?;
    if forked.thread_id == task.record.thread_id
        || task.routing.is_metered_thread(&forked.thread_id)
    {
        return Err(CodexError::Transport {
            detail: "The Codex fork did not start a new conversation.".to_owned(),
            cause: None,
        });
    }
    let turn_ids = read_codex_fork_or_let_go(
        &task.record.thread_settings,
        task.record.session_mode,
        &service,
        &connection,
        &forked,
    )
    .await?;
    let routed = move_record_to_fork(task, dependencies, &forked, binding_id).await?;
    task.record.turn_boundaries = turn_ids;
    Ok(routed)
}

/// Forks the session's conversation after the turn at `params.position` and moves the session,
/// and the run's binding the params name, onto the fork; the caller holds the session's slot.
/// Degrades with nothing moved while a turn is live, for a position the session recorded no turn
/// at, and for a fork Codex did not start anew. Answers the frames that waited for the fork with
/// the result. Fails as the fork's request does, a build without the boundary member as
/// `CodexError::RewindBoundaryUnsupported`, and as its checks or the binding's write fail, the
/// session unchanged.
pub(crate) async fn move_codex_session_to_fork(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexForkDependencies,
    params: &MoveSessionToForkParams,
) -> Result<(MoveSessionToForkResult, CodexRoutedFrames), CodexError> {
    let no_frames = CodexRoutedFrames::default;
    if !task.record.active_turns.is_empty() {
        return Ok((degraded(REWIND_DEFERRED_TURN_IN_PROGRESS), no_frames()));
    }
    // Position 0 must not become an absent boundary, which forks the whole conversation.
    let position = usize::try_from(params.position.get()).unwrap_or(usize::MAX);
    let Some(boundary_turn_id) = position
        .checked_sub(1)
        .and_then(|index| task.record.turn_boundaries.get(index))
        .cloned()
    else {
        return Ok((degraded(REWIND_TARGET_NOT_A_RECORDED_BOUNDARY), no_frames()));
    };
    let service = Arc::clone(&task.record.service);
    let connection = service.connection()?;
    let _claim = service.begin_thread_claim();
    let forked = request_codex_fork(
        record_fork_source(task.record),
        &dependencies.tool_server_route,
        &connection,
        CodexForkBoundary::AfterTurn(&boundary_turn_id),
    )
    .await
    .map_err(classify_rewind_fork_failure)?;
    if forked.thread_id == task.record.thread_id {
        return Ok((degraded(REWIND_NOT_FORKED), no_frames()));
    }
    if task.routing.is_metered_thread(&forked.thread_id) {
        return Ok((degraded(REWIND_TARGET_ALREADY_REGISTERED), no_frames()));
    }
    let turn_ids = read_codex_fork_or_let_go(
        &task.record.thread_settings,
        task.record.session_mode,
        &service,
        &connection,
        &forked,
    )
    .await?;
    let routed =
        move_record_to_fork(task, dependencies, &forked, Some(params.binding_id.clone())).await?;
    if turn_ids.len() != position {
        CodexTransportDiagnostic::ForkTurnLedgerUnconfirmed {
            expected_turn_count: position,
            confirmed_turn_count: turn_ids.len(),
        }
        .report();
    }
    // Codex's own account of the forked history wins over the session's count.
    if turn_ids.is_empty() {
        task.record.turn_boundaries.truncate(position);
    } else {
        task.record.turn_boundaries = turn_ids;
    }
    Ok((
        MoveSessionToForkResult::Applied {
            session_position: params.position,
        },
        routed,
    ))
}

/// Points the binding of the session's first run at the conversation the session is on, recording
/// with it each conversation a fork left before the session had a binding. Fails as the binding's
/// write does, those conversations still owed to the next write.
pub(crate) async fn bind_codex_first_run(
    record: &mut CodexSessionRecord,
    bindings: &dyn RuntimeBindingRebinder,
    binding_id: &RuntimeBindingId,
) -> Result<(), CodexError> {
    if record.left_thread_ids_awaiting_binding.is_empty() {
        return Ok(());
    }
    rebind(
        bindings,
        RuntimeBindingRebind {
            binding_id: binding_id.clone(),
            resume_handle: record.thread_id.clone(),
            left_conversations: compose_left_conversations(
                record,
                &record.left_thread_ids_awaiting_binding,
            ),
        },
    )
    .await?;
    record.left_thread_ids_awaiting_binding.clear();
    Ok(())
}

/// Sends `thread/fork` of `source`'s conversation up to `boundary` with every setting it carries,
/// its output speed resolved afresh against the model's tier list, which can change, and the tool
/// servers on `tool_server_route` once its owner registered it. Fails as the catalog read or the
/// request does, and with `CodexError::Transport` for a reply that names no conversation.
pub(crate) async fn request_codex_fork(
    source: CodexForkSource<'_>,
    tool_server_route: &PortRegistration<Arc<dyn ToolServerRoute>>,
    connection: &CodexAppServerConnection,
    boundary: CodexForkBoundary<'_>,
) -> Result<CodexForkReply, CodexError> {
    let settings = source.settings;
    let output_speed = resolve_codex_output_speed_level(
        || read_codex_service_model_catalog(connection),
        &settings.model,
        source.output_speed_request,
    )
    .await
    .map_err(CodexError::Driver)?;
    let route = tool_server_route
        .port()
        .map(|route| &**route as &dyn ToolServerRoute);
    let mut fork = compose_codex_thread_fork_params(settings, route, source.thread_id);
    fork.exclude_turns = Some(true);
    fork.service_tier =
        compose_codex_service_tier(output_speed.as_deref()).map(CodexServiceTierChange);
    match boundary {
        CodexForkBoundary::Whole => {}
        CodexForkBoundary::BeforeTurn(turn_id) => fork.before_turn_id = Some(turn_id.to_owned()),
        CodexForkBoundary::AfterTurn(turn_id) => fork.last_turn_id = Some(turn_id.to_owned()),
    }
    let reply = connection.request(THREAD_FORK_METHOD, &fork).await?;
    let thread_id = read_thread(&reply, THREAD_FORK_METHOD)?.id;
    Ok(CodexForkReply { reply, thread_id })
}

/// Checks a new fork runs under the profile `settings` asks for, starts it in `session_mode` and
/// reads its turn ids, oldest first; a fork that fails any of these is let go on `service` before
/// the failure is returned.
pub(crate) async fn read_codex_fork_or_let_go(
    settings: &CodexThreadSettings,
    session_mode: SessionMode,
    service: &CodexService,
    connection: &CodexAppServerConnection,
    forked: &CodexForkReply,
) -> Result<Vec<String>, CodexError> {
    let read = async {
        assert_codex_thread_profile(&forked.reply, settings, THREAD_FORK_METHOD)?;
        // A fork starts in the session's mode before the session moves onto it.
        update_codex_session_mode(
            connection,
            &forked.thread_id,
            session_mode,
            &settings.model,
            read_thread_reasoning_effort(&forked.reply).as_deref(),
        )
        .await?;
        let turns = read_codex_turns(connection, &forked.thread_id).await?;
        Ok(turns.into_iter().map(|listed| listed.id).collect())
    };
    let turn_ids = read.await;
    if turn_ids.is_err() {
        let_go_codex_thread(service, &forked.thread_id).await;
    }
    turn_ids
}

// What a fork of the record's own conversation carries.
fn record_fork_source(record: &CodexSessionRecord) -> CodexForkSource<'_> {
    CodexForkSource {
        settings: &record.thread_settings,
        output_speed_request: record.output_speed_request.clone(),
        thread_id: record.thread_id.clone(),
    }
}

// Moves the record onto its fork: the binding first, durable before anything lets go of the
// conversation the session leaves, then the record's own view of the fork, the routing band and
// the service bound to it, the left conversation's helpers released, and that conversation let go
// once no command of it runs. The message-to-turn map is dropped, since a fork's turns carry ids
// of their own; an undo rebuilds it from the fork's history. A failed binding write lets the fork
// go, the record unchanged.
async fn move_record_to_fork(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexForkDependencies,
    forked: &CodexForkReply,
    binding_id: Option<RuntimeBindingId>,
) -> Result<CodexRoutedFrames, CodexError> {
    let pre_fork_thread_id = task.record.thread_id.clone();
    let service = Arc::clone(&task.record.service);
    record_fork_in_binding(
        task.record,
        dependencies,
        binding_id.as_ref(),
        &pre_fork_thread_id,
        &forked.thread_id,
    )
    .await?;
    let record = &mut *task.record;
    let session_id = record.session_id;
    let retired = std::mem::replace(&mut record.binding_id, binding_id);
    // An `Allow once` held on the retired binding's blocks can be pressed again.
    if let (Some(retired), Some(denials)) = (retired, dependencies.reviewer_denials.port())
        && record.binding_id.as_ref() != Some(&retired)
    {
        denials.release_held_presses(&retired);
    }
    record.thread_id.clone_from(&forked.thread_id);
    record.permission_profiles =
        CodexThreadPermissionProfiles::established(&record.thread_settings);
    record.declared_output_speed = read_codex_declared_tier(session_id, &forked.reply);
    record.reasoning_effort = read_thread_reasoning_effort(&forked.reply);
    record.turn_id_by_client_message_id.clear();
    let routed = task
        .routing
        .move_session_thread(
            &dependencies.delivery,
            task.record,
            forked.thread_id.clone(),
            &pre_fork_thread_id,
        )
        .await;
    dependencies
        .pending_compactions
        .release_binding(&codex_compaction_wait_key(task.record, &pre_fork_thread_id));
    // The helpers of the conversation the session leaves go with it, those whose commands still
    // run excepted; a side question's copy is no helper and stays.
    let routing = &*task.routing;
    dependencies
        .release
        .release_session_threads(&service, &session_id, |thread_id| {
            routing.is_helper_thread(thread_id)
        });
    service.register_thread(forked.thread_id.clone(), session_id);
    dependencies
        .release
        .let_go(&service, pre_fork_thread_id, session_id)
        .await;
    Ok(routed)
}

// Points the binding at the fork, recording the conversation the session leaves in the same write,
// so a daemon restart never resumes it. Before the session's first run there is no binding, so
// the first run's binding records it. A failed write lets the fork go.
async fn record_fork_in_binding(
    record: &mut CodexSessionRecord,
    dependencies: &CodexForkDependencies,
    binding_id: Option<&RuntimeBindingId>,
    pre_fork_thread_id: &str,
    forked_thread_id: &str,
) -> Result<(), CodexError> {
    let Some(binding_id) = binding_id else {
        record
            .left_thread_ids_awaiting_binding
            .push(pre_fork_thread_id.to_owned());
        return Ok(());
    };
    let mut left_thread_ids = record.left_thread_ids_awaiting_binding.clone();
    left_thread_ids.push(pre_fork_thread_id.to_owned());
    let rebound = rebind(
        dependencies.bindings.as_ref(),
        RuntimeBindingRebind {
            binding_id: binding_id.clone(),
            resume_handle: forked_thread_id.to_owned(),
            left_conversations: compose_left_conversations(record, &left_thread_ids),
        },
    )
    .await;
    if let Err(error) = rebound {
        let_go_codex_thread(&record.service, forked_thread_id).await;
        return Err(error);
    }
    record.left_thread_ids_awaiting_binding.clear();
    Ok(())
}

async fn rebind(
    bindings: &dyn RuntimeBindingRebinder,
    rebind: RuntimeBindingRebind,
) -> Result<(), CodexError> {
    bindings
        .rebind(rebind)
        .await
        .map_err(|cause| CodexError::PortFailed {
            port: RUNTIME_BINDING_STORE_PORT,
            cause,
        })
}

// The conversations a session left, on the account its record runs on.
fn compose_left_conversations(
    record: &CodexSessionRecord,
    thread_ids: &[String],
) -> Vec<LeftConversation> {
    thread_ids
        .iter()
        .map(|conversation_id| LeftConversation {
            session_id: record.session_id,
            provider_account_id: record.provider_account_id.clone(),
            conversation_id: conversation_id.clone(),
        })
        .collect()
}

fn degraded(fallback_action: &str) -> MoveSessionToForkResult {
    MoveSessionToForkResult::Degraded {
        fallback_action: Some(
            FreeFormText::new(fallback_action.to_owned())
                .expect("each fallback action is non-blank and within the cap"),
        ),
    }
}

#[cfg(test)]
mod tests;
