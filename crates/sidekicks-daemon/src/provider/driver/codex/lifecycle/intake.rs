//! One Codex session's task, the only reader of its queue: it holds the session's record, routing
//! band and turn waits, and handles each frame, ask and call in arrival order. A frame first opens
//! the run of a turn Codex started by itself, then feeds the speed, effort and profile readings,
//! then is routed and delivered; what its delivery reports is applied after: each context-window
//! reading filed on its turn's run, each steer Codex echoed taken from the queue once, each ended
//! turn's route retired, its end recorded where no run moved, its pause or continue acted on and
//! its owed fork let go, and the spend it metered recorded. The driver's own calls on the record
//! take their place among the frames too.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::event::usage::UsageContextWindowUpdatedPayload;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemNotDeliveredReason;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::provider::driver::codex::delivery::frames::turns::codex_compaction_wait_key;
use crate::provider::driver::codex::delivery::frames::{CodexFrameDelivery, find_turn_run_id};
use crate::provider::driver::codex::event_normalizer::{
    CODEX_ITEM_COMPLETED_METHOD, CODEX_THREAD_SETTINGS_UPDATED_METHOD,
    CODEX_THREAD_TOKEN_USAGE_METHOD, CODEX_TURN_COMPLETED_METHOD,
};
use crate::provider::driver::codex::lifecycle::CodexDriverParts;
use crate::provider::driver::codex::notification_routing::{
    CodexContextWindowReading, CodexRoutedFrames, CodexSessionRouting,
};
use crate::provider::driver::codex::output_speed::observe_codex_output_speed_frame;
use crate::provider::driver::codex::run::control::CodexRunControl;
use crate::provider::driver::codex::run::routes::CodexRunRoutes;
use crate::provider::driver::codex::run::self_started_turns::open_codex_self_started_turn;
use crate::provider::driver::codex::run::steer::{
    remember_codex_prompt_hook_run, take_blocked_codex_steers, take_echoed_codex_steer,
};
use crate::provider::driver::codex::run::turn_end_waiters::{CodexRecordExit, CodexTurnEndWaiters};
use crate::provider::driver::codex::server_requests::{
    CodexInboundServerRequest, CodexServerRequestDecision,
};
use crate::provider::driver::codex::session::calls::{
    CodexSessionTask, ask_codex_session, run_codex_session_call,
};
use crate::provider::driver::codex::session::controls::{
    move_codex_permission_level, observe_codex_reasoning_effort, update_codex_session_mode,
};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::provider::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInbound, CodexSessionInboundHandler, CodexSessionInboundReceiver,
    CodexSessionInboundSender, drain_codex_session_inbound,
};
use crate::provider::driver::codex::session::lifecycle_call::{
    CodexCompactionReading, CodexLifecycleCall,
};
use crate::provider::driver::codex::session::slots::{CodexSessionLetGo, let_go_codex_session};
use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::thread::permission_profiles;
use crate::provider::driver::codex::transport::connection::{
    CodexForgottenRequest, read_codex_object,
};
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::ports::DriverPorts;
use crate::provider::usage_delta_accountant::WindowTelemetry;
use crate::session::run::engine::RunEngine;
use crate::session::run::inbound::rows::LateAppendableRow;
use crate::session::run::inbound::{DeliveryBinding, InboundDelivery};

/// Codex's signal that the skills it lists for a conversation changed.
const CODEX_SKILLS_CHANGED_METHOD: &str = "skills/changed";

/// Runs the driver's own call `compose` builds on the session's task `inbound` reaches and
/// answers its reply. Fails with `CodexError::Transport` once the session's task let its record
/// go.
pub(crate) async fn call_codex_lifecycle<Answer>(
    inbound: &CodexSessionInboundSender,
    compose: impl FnOnce(oneshot::Sender<Answer>) -> CodexLifecycleCall,
) -> Result<Answer, CodexError> {
    ask_codex_session(inbound, |reply| {
        CodexSessionInbound::Lifecycle(compose(reply))
    })
    .await
}

/// One session's task: its record until it is let go, its routing band and its turn waits.
pub(crate) struct CodexSessionIntake {
    session_id: SessionId,
    record: Option<CodexSessionRecord>,
    routing: CodexSessionRouting,
    waiters: CodexTurnEndWaiters,
    parts: Arc<CodexDriverParts>,
}

impl CodexSessionIntake {
    /// The task of `record`'s session, routing through `routing`.
    pub(crate) fn new(
        record: CodexSessionRecord,
        routing: CodexSessionRouting,
        parts: Arc<CodexDriverParts>,
    ) -> Self {
        Self {
            session_id: record.session_id,
            record: Some(record),
            routing,
            waiters: CodexTurnEndWaiters::default(),
            parts,
        }
    }

    /// Applies what the session's opening released, then drains its queue until every sender is
    /// gone.
    pub(crate) async fn run(
        mut self,
        receiver: CodexSessionInboundReceiver,
        routed: CodexRoutedFrames,
    ) {
        self.apply(routed).await;
        self.settle();
        drain_codex_session_inbound(receiver, &mut self).await;
    }

    // What a delivery reported, applied in delivery order.
    async fn apply(&mut self, routed: CodexRoutedFrames) {
        let Some(record) = self.record.as_mut() else {
            return;
        };
        let parts = &self.parts;
        apply_codex_routed_frames(
            &CodexRoutedFramesIntake {
                ports: &parts.ports,
                engine: &parts.engine,
                run_routes: &parts.run_routes,
                run_control: &parts.run_control,
                config_forks: &parts.config_forks,
                delivery: &parts.delivery,
            },
            record,
            routed,
        )
        .await;
    }

    // The waits each item may have answered settled, and the record's view shown as it stands.
    fn settle(&mut self) {
        if let Some(record) = &self.record {
            self.waiters.settle(record);
            self.parts.views.show(record);
        }
    }

    async fn handle_frame(&mut self, method: String, params: Box<RawValue>) {
        let parts = Arc::clone(&self.parts);
        if let Some(diverted) = parts.side_questions.divert(&method, &params) {
            if let (Some(usage), Some(sink)) = (diverted.usage, parts.ports.usage.port()) {
                sink.record_metered(usage.session_id, usage.delta);
            }
            return;
        }
        let Some(record) = self.record.as_mut() else {
            return;
        };
        open_codex_self_started_turn(
            &mut CodexSessionTask {
                record,
                routing: &mut self.routing,
                waiters: &mut self.waiters,
            },
            &parts.calls.runs,
            &parts.self_started,
            &method,
            &params,
        )
        .await;
        if method == CODEX_SKILLS_CHANGED_METHOD {
            parts.provider_commands.refresh(self.session_id);
        }
        observe_codex_session_frame(record, &method, &params);
        for settled in observe_codex_output_speed_frame(record, &method, &params) {
            parts.run_start.record_settled_output_speed(settled).await;
        }
        let step_turn_id = (method == CODEX_ITEM_COMPLETED_METHOD)
            .then(|| read_step_turn_id(&params))
            .flatten();
        let routed = self
            .routing
            .route_notification(&parts.delivery, record, method, params)
            .await;
        self.apply(routed).await;
        if let (Some(turn_id), Some(record)) = (step_turn_id, self.record.as_mut()) {
            parts.run_control.observe_step_end(record, &turn_id);
        }
    }

    async fn handle_lifecycle(&mut self, call: CodexLifecycleCall) {
        let Some(record) = self.record.as_mut() else {
            // A dropped reply tells the caller the record is gone.
            return;
        };
        let parts = Arc::clone(&self.parts);
        match call {
            CodexLifecycleCall::BeginClose { reply } => {
                self.routing.gate().signal_intended_close();
                let _unheard = reply.send(read_held_runs(record));
            }
            CodexLifecycleCall::LetGo { exit, reply } => {
                self.let_go(exit).await;
                let _unheard = reply.send(());
            }
            CodexLifecycleCall::MoveLevel { params, reply } => {
                let moved = move_codex_permission_level(record, &parts.config_forks, &params).await;
                let _unheard = reply.send(moved);
            }
            CodexLifecycleCall::MoveMode { mode, reply } => {
                let moved = match record.service.connection() {
                    Ok(connection) => {
                        update_codex_session_mode(
                            &connection,
                            &record.thread_id,
                            mode,
                            &record.thread_settings.model,
                            record.reasoning_effort.as_deref(),
                        )
                        .await
                    }
                    Err(error) => Err(error),
                };
                if moved.is_ok() {
                    // A resume and a move send the mode again.
                    record.session_mode = mode;
                }
                let _unheard = reply.send(moved);
            }
            CodexLifecycleCall::AskSideQuestion { params, reply } => {
                let asked = parts.side_questions.ask(record, &params).await;
                let _unheard = reply.send(asked);
            }
            CodexLifecycleCall::ReadCompaction { reply } => {
                let _unheard = reply.send(CodexCompactionReading {
                    connection: record.service.connection(),
                    provider_account_id: record.provider_account_id.clone(),
                    thread_id: record.thread_id.clone(),
                    wait_key: codex_compaction_wait_key(record, &record.thread_id),
                });
            }
        }
    }

    // Lets the record go on the task: its routes, waits and conversation, then its place on every
    // service it was attached to and its view.
    async fn let_go(&mut self, exit: CodexRecordExit) {
        let Some(record) = self.record.take() else {
            return;
        };
        let parts = &self.parts;
        let_go_codex_session(
            &record,
            &CodexSessionLetGo {
                run_routes: &parts.run_routes,
                release: &parts.release,
                pending_compactions: &parts.pending_compactions,
                provider_commands: &parts.provider_commands,
            },
        )
        .await;
        parts.establishment.let_go_service_process(self.session_id);
        record.service.detach_session(&self.session_id);
        for service in parts.registry.services() {
            service.detach_session(&self.session_id);
        }
        // No turn of a record that left will end, so nothing waits on one.
        self.waiters.abandon(self.session_id, exit);
        parts.views.remove(self.session_id);
    }
}

impl CodexSessionInboundHandler for CodexSessionIntake {
    fn frame(&mut self, method: String, params: Box<RawValue>) -> BoxFuture<'_, ()> {
        async move {
            self.handle_frame(method, params).await;
            self.settle();
        }
        .boxed()
    }

    fn ask(
        &mut self,
        request: CodexInboundServerRequest,
        decision: oneshot::Sender<Result<CodexServerRequestDecision, DriverError>>,
    ) -> BoxFuture<'_, ()> {
        async move {
            // A record let go refuses the ask through its dropped decision.
            if let Some(record) = &self.record {
                self.parts.ask_intake.take(record, request, decision).await;
            }
        }
        .boxed()
    }

    fn asks_withdrawn(&mut self, dropped: Vec<CodexForgottenRequest>) -> BoxFuture<'_, ()> {
        async move {
            // A record let go took its asks' cards with it.
            let Some(record) = &self.record else {
                return;
            };
            for request in dropped {
                self.parts.hand_off.withdraw(
                    self.session_id,
                    record.provider_account_id.clone(),
                    &request.request_id,
                    request.ask_kind,
                );
            }
        }
        .boxed()
    }

    fn held_thread(&mut self, thread_id: String, is_held: bool) {
        self.routing.hold_thread(thread_id, is_held);
    }

    fn call(&mut self, call: CodexSessionCall) -> BoxFuture<'_, ()> {
        async move {
            // A dropped reply tells the caller the record is gone.
            let Some(record) = self.record.as_mut() else {
                return;
            };
            let parts = Arc::clone(&self.parts);
            let routed = Box::pin(run_codex_session_call(
                call,
                &mut CodexSessionTask {
                    record,
                    routing: &mut self.routing,
                    waiters: &mut self.waiters,
                },
                &parts.calls,
            ))
            .await;
            self.apply(routed).await;
            self.settle();
        }
        .boxed()
    }

    fn lifecycle(&mut self, call: CodexLifecycleCall) -> BoxFuture<'_, ()> {
        async move {
            self.handle_lifecycle(call).await;
            self.settle();
        }
        .boxed()
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.record
            .as_ref()
            .and_then(|record| record.delivery.next_deadline())
    }

    fn deadline_reached(&mut self, now: Instant) -> BoxFuture<'_, ()> {
        async move {
            if let Some(record) = self.record.as_mut() {
                self.parts.delivery.deliver_due(record, now).await;
            }
        }
        .boxed()
    }
}

/// What applying a delivery's report acts through, borrowed from the driver's parts.
pub(crate) struct CodexRoutedFramesIntake<'parts> {
    /// The queue's intake of taken, refused and given-back messages, and the usage record.
    pub(crate) ports: &'parts DriverPorts,
    /// The run engine an ended turn's end is recorded in.
    pub(crate) engine: &'parts Arc<RunEngine>,
    /// The run routes an ended turn's route is retired from.
    pub(crate) run_routes: &'parts CodexRunRoutes,
    /// The run control an ended turn's pause or continue is acted on through.
    pub(crate) run_control: &'parts Arc<CodexRunControl>,
    /// The config forks an ended turn lets an owed fork go on.
    pub(crate) config_forks: &'parts Arc<CodexConfigForks>,
    /// The frame delivery a context-window reading's row goes out through.
    pub(crate) delivery: &'parts CodexFrameDelivery,
}

/// Applies what a delivery reported on `record`'s session, in delivery order: each
/// context-window reading filed on its run before any turn's end retires the route, each steer
/// Codex echoed taken from the queue once, each prompt's hook runs remembered, and for each ended
/// turn its blocked steers refused and those a pause or a retry dropped given back, its end
/// recorded where no run moved, its route retired, its pause or continue acted on and its owed
/// fork let go; then the spend it metered recorded.
pub(crate) async fn apply_codex_routed_frames(
    intake: &CodexRoutedFramesIntake<'_>,
    record: &mut CodexSessionRecord,
    routed: CodexRoutedFrames,
) {
    let session_id = record.session_id;
    // Each reading's run is read before a turn's end in the same batch retires its route.
    for reading in routed.context_windows {
        file_context_window(intake, record, reading).await;
    }
    for dispatch in routed.dispatches {
        for taken in dispatch.taken_messages {
            let Some(message_id) =
                take_echoed_codex_steer(record, &taken.turn_id, &taken.client_message_id)
            else {
                continue;
            };
            let run_id = record
                .active_turn_run(&taken.turn_id)
                .or_else(|| record.interrupted_turn_run(&taken.turn_id));
            // Before the queue registers its intake there is no queue to tell.
            if let (Some(run_id), Some(listener)) = (run_id, intake.ports.message_taken.port()) {
                listener.message_taken(session_id, &message_id.to_string(), run_id);
            }
        }
        for hook_run in dispatch.prompt_hook_runs {
            remember_codex_prompt_hook_run(record, hook_run);
        }
        for ended in dispatch.turns_ended {
            // Before the queue registers its intake there is no queue to tell.
            let steers = take_blocked_codex_steers(record, &ended.turn_id, ended.ending);
            if let Some(listener) = intake.ports.message_refused.port() {
                for (message_id, words) in steers.refused {
                    listener.message_refused(
                        session_id,
                        &message_id.to_string(),
                        QueueItemNotDeliveredReason::RefusedByHook { words },
                    );
                }
            }
            if let Some(listener) = intake.ports.message_given_back.port() {
                for message_id in steers.dropped {
                    listener.message_given_back(session_id, &message_id.to_string());
                }
            }
            if let Some(turn_end) = ended.turn_end {
                record_turn_end(intake.engine, ended.run_id, turn_end).await;
            }
            // By turn id, never run id, so a stale end cannot retire a newer turn.
            intake.run_routes.retire_turn_route(record, &ended.turn_id);
            record.forget_interrupted_run(&ended.turn_id);
            // A pause's stopped turn is let go first, so an owed fork starts here, ahead of its
            // continue.
            intake
                .run_control
                .observe_turn_ended(record, &ended.turn_id)
                .await;
            intake.config_forks.note_turn_settled(record);
        }
    }
    if let Some(usage) = intake.ports.usage.port() {
        for delta in routed.metered_usage {
            usage.record_metered(session_id, delta);
        }
    }
}

// Writes the end of a turn that moved no run; a failed write is logged, the turn already gone.
async fn record_turn_end(
    engine: &Arc<RunEngine>,
    run_id: RunId,
    turn_end: crate::session::run::engine::turns::ProviderTurnEnd,
) {
    match engine.record_turn_end(run_id, turn_end).await {
        Ok(written) => {
            if let Some(error) = written.resend_failure {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    %run_id,
                    "a step limit's interrupt owed after a codex turn's end could not be handed"
                );
            }
        }
        Err(error) => tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            %run_id,
            "the end of a codex turn that moved no run could not be recorded"
        ),
    }
}

// Files a context-window reading of the session's conversation on the run holding its turn, on
// that run's binding, else on the session's, which a run's turn start adopts, since the delivery
// of a turn's end in the same batch already let the run's binding go; a reading no run holds
// files with no run. One with no binding to file on is dropped, logged.
async fn file_context_window(
    intake: &CodexRoutedFramesIntake<'_>,
    record: &CodexSessionRecord,
    reading: CodexContextWindowReading,
) {
    let run_id = reading
        .turn_id
        .as_deref()
        .and_then(|turn_id| find_turn_run_id(record, turn_id))
        .map(|(run_id, _ending)| run_id);
    let binding_id = run_id
        .and_then(|run_id| intake.run_routes.binding_for(run_id))
        .map(|binding| binding.binding_id)
        .or_else(|| record.binding_id.clone());
    let Some(binding_id) = binding_id else {
        tracing::debug!("a codex context-window reading has no binding to file on");
        return;
    };
    let (window_source, exceeded, counts) = match reading.window {
        WindowTelemetry::Counted {
            window_source,
            exceeded,
            window_used_tokens,
            window_max_tokens,
        } => (
            window_source,
            exceeded,
            SafeInt::new(window_used_tokens).zip(SafeInt::new(window_max_tokens)),
        ),
        WindowTelemetry::CountsAbsent {
            window_source,
            exceeded,
        } => (window_source, exceeded, None),
    };
    let row = LateAppendableRow::UsageContextWindowUpdated(UsageContextWindowUpdatedPayload {
        session_id: record.session_id,
        run_id,
        window_used_tokens: counts.map(|(used, _max)| used),
        window_max_tokens: counts.map(|(_used, max)| max),
        window_source,
        exceeded,
        model_id: None,
        subagent_id: None,
        source_epoch: None,
        source_position: None,
    });
    let delivery = InboundDelivery::SessionRow {
        binding: DeliveryBinding {
            binding_id,
            operation: None,
        },
        row,
        content: None,
    };
    // A refused row is reported by the send.
    let _filed = intake
        .delivery
        .send(record, delivery, CODEX_THREAD_TOKEN_USAGE_METHOD)
        .await;
}

// Every run the record still holds a turn of, live, starting or ending, each once.
fn read_held_runs(record: &CodexSessionRecord) -> Vec<RunId> {
    let mut runs: Vec<RunId> = Vec::new();
    let held = record
        .active_turns
        .iter()
        .map(|(_, run_id)| *run_id)
        .chain(
            record
                .interrupted_run_by_turn_id
                .iter()
                .map(|(_, run_id)| *run_id),
        )
        .chain(
            record
                .paused_run_id_by_interrupted_turn_id
                .values()
                .copied(),
        )
        .chain(record.delivery.retried_run_id_by_turn_id.values().copied())
        .chain(record.delivery.starting_turn_run_ids.iter().copied());
    for run_id in held {
        if !runs.contains(&run_id) {
            runs.push(run_id);
        }
    }
    runs
}

// The members of a frame the intake reads a turn id from.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnFrame {
    thread_id: Option<String>,
    turn_id: Option<String>,
    turn: Option<EndedTurn>,
}

#[derive(Deserialize)]
struct EndedTurn {
    id: Option<String>,
}

/// Reads into `record` what a frame of its conversation says of the session before the frame is
/// routed: a turn's end remembered as settled, a settings change's reasoning effort and permission
/// profile.
pub(crate) fn observe_codex_session_frame(
    record: &mut CodexSessionRecord,
    method: &str,
    params: &RawValue,
) {
    match method {
        CODEX_TURN_COMPLETED_METHOD => {
            if let Some(turn_id) = read_ended_turn_id(record, params) {
                record.remember_settled_turn(turn_id);
            }
        }
        CODEX_THREAD_SETTINGS_UPDATED_METHOD => {
            observe_codex_reasoning_effort(record, method, params);
            permission_profiles::correct_codex_permission_profile_drift(
                &mut record.permission_profiles,
                &record.service,
                &record.thread_id,
                &record.thread_settings,
                params,
            );
        }
        _ => {}
    }
}

// The turn a `turn/completed` of the session's own conversation ended.
fn read_ended_turn_id(record: &CodexSessionRecord, params: &RawValue) -> Option<String> {
    let frame = read_codex_object::<TurnFrame>(params.get())?;
    if frame.thread_id.as_deref() != Some(record.thread_id.as_str()) {
        return None;
    }
    frame.turn?.id.filter(|turn_id| !turn_id.is_empty())
}

// The turn an `item/completed` names, whose step it ended.
fn read_step_turn_id(params: &RawValue) -> Option<String> {
    read_codex_object::<TurnFrame>(params.get())?
        .turn_id
        .filter(|turn_id| !turn_id.is_empty())
}
