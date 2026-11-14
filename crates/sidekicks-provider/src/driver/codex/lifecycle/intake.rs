//! One Codex session's task, the only reader of its queue: it holds the session's record, routing
//! band and turn waits, and handles each frame, ask and call in arrival order. A frame first opens
//! the run of a turn Codex started by itself, then feeds the speed, effort and profile readings,
//! then is routed and delivered; what its delivery reports is applied after: each context-window
//! reading filed on its turn's run, the queue told of each steer Codex echoed, each ended turn's
//! route retired, its end recorded where no run moved, its pause or continue acted on and its owed
//! fork let go, each turn's readings and the session's context reading published, and the spend it
//! metered recorded in metering order. Each settled step publishes the session's context reading
//! again with no usage when its model or window changed. The driver's own calls on the record take
//! their place among the frames too. Each completed response the export states is passed over
//! where the stream stated it, else held until its turn settles and two export intervals pass, then
//! passed over or priced; a session let go, or whose task ends, first takes the rollout lines its
//! service's launches hold for it, then decides every one it holds.
//!
//! A full usage queue holds the task until the sink takes a batch, so no spend is lost: while the
//! database writer stalls, this session's frames, asks and calls wait behind it, as every other
//! write of the session would. Its inbound queue stays unbounded, since the connection's reader
//! serves every session of the service, and is logged as it grows past each depth mark.

use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::unix_time::read_unix_time_ms;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::driver::codex::delivery::frames::turns::codex_compaction_wait_key;
use crate::driver::codex::event_normalizer::{
    CODEX_ITEM_COMPLETED_METHOD, CODEX_THREAD_SETTINGS_UPDATED_METHOD, CODEX_TURN_COMPLETED_METHOD,
    CODEX_TURN_STARTED_METHOD,
};
use crate::driver::codex::lifecycle::CodexDriverParts;
use crate::driver::codex::lifecycle::account_move::CodexBindingMove;
use crate::driver::codex::lifecycle::intake::routed_frames::{
    CodexRoutedFramesIntake, apply_codex_routed_frames,
};
use crate::driver::codex::mcp::live_switch::switch_codex_session_servers;
use crate::driver::codex::notification_routing::{CodexRoutedFrames, CodexSessionRouting};
use crate::driver::codex::output_speed::observe_codex_output_speed_frame;
use crate::driver::codex::pricing::CodexRecorderPricing;
use crate::driver::codex::run::self_started_turns::open_codex_self_started_turn;
use crate::driver::codex::run::turn_end_waiters::{CodexRecordExit, CodexTurnEndWaiters};
use crate::driver::codex::server_requests::{
    CodexInboundServerRequest, CodexServerRequestDecision,
};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::calls::{CodexSessionTask, run_codex_session_call};
use crate::driver::codex::session::context_reading::{
    CodexFixedStart, CodexSessionContextReadings,
};
use crate::driver::codex::session::controls::{
    move_codex_permission_level, observe_codex_reasoning_effort, update_codex_session_mode,
};
use crate::driver::codex::session::inbound::{
    CodexAccountMove, CodexSessionCall, CodexSessionInboundHandler, CodexSessionInboundReceiver,
    drain_codex_session_inbound,
};
use crate::driver::codex::session::lifecycle_call::{
    CodexConversationReading, CodexLifecycleCall, CodexRunningCommandReading,
};
use crate::driver::codex::session::slots::{CodexSessionLetGo, let_go_codex_session};
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::session::thread_turns::{
    CodexEndedTurn, CodexSettledTurn, CodexThreadTurns, TurnFrame,
};
use crate::driver::codex::telemetry::held_responses::{CodexExportedResponse, CodexHeldResponses};
use crate::driver::codex::thread::permission_profiles;
use crate::driver::codex::transport::connection::{CodexForgottenRequest, read_codex_object};
use crate::driver::codex::transport::diagnostics::{CodexDeliveryPort, CodexTransportDiagnostic};
use crate::driver::contract::error::DriverError;
use crate::port::usage_sink::MeteredUsage;

mod held;
pub(crate) mod routed_frames;

/// How many batches of metered spend a session's recorder holds while its sink is busy; past
/// that the session's task waits for room.
pub(super) const USAGE_RECORDER_QUEUE: usize = 256;

/// A session's usage recorder ended while its session still metered spend.
#[derive(Debug, thiserror::Error)]
#[error("the usage recorder ended, so {lost} metered deltas were not recorded")]
struct UsageRecorderEnded {
    lost: usize,
}

/// Codex's signal that the skills it lists for a conversation changed.
const CODEX_SKILLS_CHANGED_METHOD: &str = "skills/changed";

/// One session's task: its record until it is let go, its routing band and its turn waits.
pub(crate) struct CodexSessionIntake {
    session_id: SessionId,
    record: Option<CodexSessionRecord>,
    routing: CodexSessionRouting,
    waiters: CodexTurnEndWaiters,
    parts: Arc<CodexDriverParts>,
    context_readings: CodexSessionContextReadings,
    // The live turn of each thread the session's stream carries, whose settle feeds its launch's
    // export status and decides the exported responses held on it.
    thread_turns: CodexThreadTurns,
    // The exported responses the stream may yet state, held until each can be told apart.
    held: CodexHeldResponses,
    // The session's one usage recorder, fed in metering order with the account moves between the
    // spends; opened at the first spend metered once the usage service registered, and ended when
    // the session's task ends.
    usage_recorder: Option<mpsc::Sender<UsageRecorderItem>>,
}

// What the session's usage recorder takes, in metering order: spend, with the service and folder
// whose region prices it, or a move of the session's bindings onto another account, made once the
// spend before it is recorded.
enum UsageRecorderItem {
    Usage(Vec<MeteredUsage>, Arc<CodexService>, PathBuf),
    AccountMove(CodexBindingMove),
}

impl CodexSessionIntake {
    /// The task of `record`'s session, routing through `routing`, its conversation taking its fixed
    /// start as `fixed_start` says, with the record's view shown now, so the session reads live as
    /// soon as its opening returns, before the task first runs.
    pub(crate) fn new(
        record: CodexSessionRecord,
        routing: CodexSessionRouting,
        parts: Arc<CodexDriverParts>,
        fixed_start: CodexFixedStart,
    ) -> Self {
        parts.views.show(&record);
        let session_id = record.session_id;
        Self {
            session_id,
            record: Some(record),
            routing,
            waiters: CodexTurnEndWaiters::default(),
            parts,
            context_readings: CodexSessionContextReadings::new(session_id, fixed_start),
            thread_turns: CodexThreadTurns::default(),
            held: CodexHeldResponses::default(),
            usage_recorder: None,
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
        // Every sender is gone with the record still held, so nothing settles a held turn now.
        self.take_held_rollouts().await;
        let held = self.held.take_all();
        self.decide_held_responses(held).await;
    }

    // What applying a delivery's report acts through, borrowed from the driver's parts.
    fn routed_frames_intake(parts: &CodexDriverParts) -> CodexRoutedFramesIntake<'_> {
        CodexRoutedFramesIntake {
            ports: &parts.ports,
            engine: &parts.engine,
            run_routes: &parts.run_routes,
            run_control: &parts.run_control,
            config_forks: &parts.config_forks,
            delivery: &parts.delivery,
        }
    }

    // What a delivery reported, applied in delivery order; the session's context reading
    // published from each usage report, and the spend it metered recorded.
    async fn apply(&mut self, routed: CodexRoutedFrames) {
        let Some(record) = self.record.as_mut() else {
            return;
        };
        let parts = &self.parts;
        for reading in &routed.context_windows {
            self.context_readings.publish_report(parts, record, reading);
        }
        // A metered delta is a request its thread's live turn made, or the turn that settled
        // before its reading was released, whose export check is armed again; a replay or a
        // reading that changed nothing meters none.
        for delta in &routed.metered_usage {
            if let Some(settled) = self.thread_turns.request_made(&delta.thread_id) {
                arm_export_check(record, &settled);
            }
        }
        let usage =
            apply_codex_routed_frames(&Self::routed_frames_intake(parts), record, routed).await;
        self.record_usage(usage).await;
    }

    // Hands `usage` to the session's recorder, which records each delta in metering order on the
    // driver's tasks; a full queue holds the session's task until it has room, so nothing is
    // dropped. The sink stops a run past its limit on a task of its own, so it never waits on
    // this one.
    async fn record_usage(&mut self, usage: Vec<MeteredUsage>) {
        let Some(record) = &self.record else {
            return;
        };
        if usage.is_empty() {
            return;
        }
        let provider_account_id = record.provider_account_id.clone();
        let session_id = self.session_id;
        let report = move |error: Box<dyn std::error::Error + Send + Sync>| {
            CodexTransportDiagnostic::PortDeliveryFailed {
                provider_account_id: Some(provider_account_id.clone()),
                port: CodexDeliveryPort::Usage,
                session_id: Some(session_id),
                error,
            }
            .report();
        };
        if self.usage_recorder.is_none() {
            // Before the usage service registers its record there is nothing to record into.
            let Some(sink) = self.parts.ports.usage.port().map(Arc::clone) else {
                return;
            };
            let (sender, mut items) = mpsc::channel::<UsageRecorderItem>(USAGE_RECORDER_QUEUE);
            let report = report.clone();
            let bindings = Arc::clone(&self.parts.runtime_bindings);
            let account_moves = Arc::clone(&self.parts.ports.session_account_moves);
            let mut pricing = CodexRecorderPricing::new(Arc::clone(&self.parts.pricing));
            self.parts.tasks.spawn(async move {
                while let Some(item) = items.recv().await {
                    match item {
                        UsageRecorderItem::Usage(batch, service, folder) => {
                            pricing
                                .record(&*sink, batch, &service, &folder, &report)
                                .await;
                        }
                        UsageRecorderItem::AccountMove(binding_move) => {
                            binding_move.land(&*bindings, &account_moves).await;
                        }
                    }
                }
            });
            self.usage_recorder = Some(sender);
        }
        let Some(recorder) = &self.usage_recorder else {
            return;
        };
        let folder = record.thread_settings.working_directory.clone();
        let item = UsageRecorderItem::Usage(usage, Arc::clone(&record.service), folder);
        if let Err(refused) = recorder.send(item).await {
            let lost = match refused.0 {
                UsageRecorderItem::Usage(batch, ..) => batch.len(),
                UsageRecorderItem::AccountMove(_) => 0,
            };
            report(Box::new(UsageRecorderEnded { lost }));
        }
    }

    // Moves the session onto `account_move`'s account at this place among its frames: its record
    // at once, and its bindings, the lead's and the record's own, once every spend metered before
    // is recorded, so that spend stays on the account it left.
    async fn move_account(&mut self, account_move: CodexAccountMove) {
        let record = self
            .record
            .as_mut()
            .map(|record| (&mut record.provider_account_id, record.binding_id.as_ref()));
        let item = UsageRecorderItem::AccountMove(CodexBindingMove::plan(
            self.session_id,
            record,
            account_move,
        ));
        let unsent = match &self.usage_recorder {
            Some(recorder) => recorder.send(item).await.err().map(|refused| refused.0),
            None => Some(item),
        };
        // No recorder runs, so no spend waits before the move.
        if let Some(UsageRecorderItem::AccountMove(binding_move)) = unsent {
            binding_move
                .land(
                    &*self.parts.runtime_bindings,
                    &self.parts.ports.session_account_moves,
                )
                .await;
        }
    }

    // The waits each item may have answered settled, and the record's view shown as it stands.
    fn settle(&mut self) {
        if let Some(record) = &self.record {
            self.waiters.settle(record);
            self.parts.views.show(record);
            self.context_readings
                .publish_settings_change(&self.parts, record);
        }
    }

    async fn handle_frame(&mut self, method: String, params: Box<RawValue>) {
        let parts = Arc::clone(&self.parts);
        self.note_exporting();
        // Before a side question's divert, so the hold knows its copy's turns too.
        let ended = self.thread_turns.observe(&method, &params, Instant::now());
        // The session's own live turn, which an unplaced reviewer request may be given to; a
        // copy's or a helper's start leaves it as it is.
        if method == CODEX_TURN_STARTED_METHOD
            && let Some(record) = &self.record
            && read_codex_object::<TurnFrame>(params.get())
                .and_then(|frame| frame.thread_id)
                .is_some_and(|thread_id| thread_id == record.thread_id)
            && let Some(turn_id) = self.thread_turns.live_turn(&record.thread_id)
        {
            record.service.dependencies().exports.turn_started(
                record.service.id(),
                record.session_id,
                turn_id,
                read_unix_time_ms(),
            );
        }
        if let Some(diverted) = parts.side_questions.divert(&method, &params) {
            if let Some(usage) = diverted.usage
                && self
                    .routing
                    .streamed_responses()
                    .record(&usage.delta.thread_id, usage.delta.axis_deltas)
            {
                // The copy's turn made the request, so its settle below arms an export check.
                if let (Some(settled), Some(record)) = (
                    self.thread_turns.request_made(&usage.delta.thread_id),
                    &self.record,
                ) {
                    arm_export_check(record, &settled);
                }
                self.record_usage(vec![usage]).await;
            }
            self.settle_ended(ended);
            return;
        }
        if self.record.is_none() {
            self.settle_ended(ended);
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
                context_readings: &self.context_readings,
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
        // After the frames its completion released apply, so their readings count toward it.
        self.settle_ended(ended);
        if let (Some(turn_id), Some(record)) = (step_turn_id, self.record.as_mut()) {
            parts.run_control.observe_step_end(record, &turn_id);
        }
    }

    // Whether the session's launch exports, read before each frame and call, so the stream keeps
    // a ledger of its responses only while an export's twin can arrive.
    fn note_exporting(&mut self) {
        if let Some(record) = &self.record {
            let exports = &record.service.dependencies().exports;
            let is_exporting = exports.is_exporting(record.service.id());
            self.routing
                .streamed_responses()
                .set_exporting(is_exporting);
        }
    }

    // A turn a frame ended: the responses held on it may be decided and the ledger's priced ones
    // filed on it expire; a settled one's settle, as it stands once its released frames applied,
    // goes to the export status, which a replaced one never reported, and ends its place in the
    // launch's joins.
    fn settle_ended(&mut self, ended: Option<CodexEndedTurn>) {
        let (thread_id, turn_id, is_settled) = match ended {
            Some(CodexEndedTurn::Settled(settled)) => (settled.thread_id, settled.turn_id, true),
            Some(CodexEndedTurn::Replaced { thread_id, turn_id }) => (thread_id, turn_id, false),
            None => return,
        };
        self.held.turn_settled(&thread_id, &turn_id);
        self.routing
            .streamed_responses()
            .turn_settled(&thread_id, &turn_id);
        let Some(record) = &self.record else {
            return;
        };
        if is_settled
            && let Some(settled) = self.thread_turns.hand_off_settled(&thread_id, &turn_id)
        {
            arm_export_check(record, &settled);
            if thread_id == record.thread_id {
                record.service.dependencies().exports.turn_ended(
                    record.service.id(),
                    record.session_id,
                    &turn_id,
                    read_unix_time_ms(),
                );
            }
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
            CodexLifecycleCall::SwitchToolServers {
                tool_servers,
                reply,
            } => {
                let switched =
                    switch_codex_session_servers(record, &parts.config_forks, tool_servers);
                let _unheard = reply.send(switched);
            }
            CodexLifecycleCall::MoveMode { mode, reply } => {
                // A service on its way back resumes the conversation in the mode the record holds.
                let moved = if record.service.is_coming_back() {
                    Ok(())
                } else {
                    match record.service.connection() {
                        Ok(connection) => update_codex_session_mode(
                            &connection,
                            &record.thread_id,
                            mode,
                            &record.thread_settings.model,
                            record.reasoning_effort.as_deref(),
                        )
                        .await
                        .map_err(|error| {
                            error.refused_as(
                                RefusalCode::SessionModeNotOffered,
                                "Codex refused the mode",
                            )
                        }),
                        Err(error) => Err(error),
                    }
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
            CodexLifecycleCall::ReadConversation { reply } => {
                let _unheard = reply.send(CodexConversationReading {
                    connection: record.service.connection(),
                    provider_account_id: record.provider_account_id.clone(),
                    thread_id: record.thread_id.clone(),
                    wait_key: codex_compaction_wait_key(record, &record.thread_id),
                });
            }
            CodexLifecycleCall::ReadRunningCommand { item_id, reply } => {
                let reading = record
                    .delivery
                    .running_command_by_item_id
                    .get(&item_id)
                    .map(|command| CodexRunningCommandReading {
                        connection: record.service.connection(),
                        thread_id: command.thread_id.clone(),
                        terminal_process_id: command.terminal_process_id.clone(),
                    });
                let _unheard = reply.send(reading);
            }
        }
    }

    // Lets the record go on the task: its routes, waits and conversation, then its place on every
    // service it was attached to and its view.
    async fn let_go(&mut self, exit: CodexRecordExit) {
        // Decided while the record still files them, since no held turn settles past here.
        self.take_held_rollouts().await;
        let held = self.held.take_all();
        self.decide_held_responses(held).await;
        let Some(record) = self.record.take() else {
            return;
        };
        if let Some(turn_id) = self.thread_turns.live_turn(&record.thread_id) {
            let exports = &record.service.dependencies().exports;
            exports.turn_ended(
                record.service.id(),
                self.session_id,
                turn_id,
                read_unix_time_ms(),
            );
        }
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

    fn side_question_released(&mut self, thread_id: String) {
        // The copy's stopped turn's completion reaches no session, so its turn ends here.
        if let Some(turn_id) = self.thread_turns.end_live_turn(&thread_id) {
            self.settle_ended(Some(CodexEndedTurn::Replaced { thread_id, turn_id }));
        }
    }

    fn call(&mut self, call: CodexSessionCall) -> BoxFuture<'_, ()> {
        async move {
            self.note_exporting();
            if matches!(call, CodexSessionCall::DropTurns { .. }) {
                // The process that ran the session's turns ended, so none of them settles.
                let ended_at_ms = read_unix_time_ms();
                let live_turns: Vec<(String, String)> =
                    self.thread_turns.take_live_turns().collect();
                for (thread_id, turn_id) in live_turns {
                    self.held.turn_settled(&thread_id, &turn_id);
                    self.routing
                        .streamed_responses()
                        .turn_settled(&thread_id, &turn_id);
                    if let Some(record) = &self.record {
                        let exports = &record.service.dependencies().exports;
                        exports.turn_ended(
                            record.service.id(),
                            record.session_id,
                            &turn_id,
                            ended_at_ms,
                        );
                    }
                }
            }
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
                    context_readings: &self.context_readings,
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

    fn account_moved(&mut self, account_move: CodexAccountMove) -> BoxFuture<'_, ()> {
        self.move_account(account_move).boxed()
    }

    fn exported_response(&mut self, exported: CodexExportedResponse) -> BoxFuture<'_, ()> {
        self.hold_exported_response(exported).boxed()
    }

    fn next_deadline(&self) -> Option<Instant> {
        let delivery = self
            .record
            .as_ref()
            .and_then(|record| record.delivery.next_deadline());
        delivery.into_iter().chain(self.held.next_decision()).min()
    }

    fn deadline_reached(&mut self, now: Instant) -> BoxFuture<'_, ()> {
        async move {
            if let Some(record) = self.record.as_mut() {
                self.parts.delivery.deliver_due(record, now).await;
            }
            let due = self.held.take_due(now);
            self.decide_held_responses(due).await;
        }
        .boxed()
    }
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
        .chain(
            record
                .delivery
                .starting_turns
                .iter()
                .map(|starting| starting.run_id),
        );
    for run_id in held {
        if !runs.contains(&run_id) {
            runs.push(run_id);
        }
    }
    runs
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

// Hands `settled` to its launch's export status, which arms a check where the turn made a request.
fn arm_export_check(record: &CodexSessionRecord, settled: &CodexSettledTurn) {
    record.service.dependencies().exports.turn_settled(
        record.service.id(),
        settled.made_request,
        settled.started_at,
    );
}

// The turn an `item/completed` names, whose step it ended.
fn read_step_turn_id(params: &RawValue) -> Option<String> {
    read_codex_object::<TurnFrame>(params.get())?
        .turn_id
        .filter(|turn_id| !turn_id.is_empty())
}
