//! Every frame a Claude Code session's process wrote becomes the run engine's deliveries, on the
//! session's own task and in frame order, on the binding of the run holding the session's turn:
//! the turn's opening, its markers, its message and tool rows, the text and thinking Claude Code
//! streams as stored pieces of their message, the provider's status, warnings and model switches,
//! a helper's child run, the turn's end, the session's running commands, the usage each thread
//! spent, and what the working line and the context ring read. A frame of a turn no daemon run
//! holds is recorded and dropped.

pub(crate) mod daemon_ends;
mod helper_runs;
mod members;
mod rows;
mod run_end;
mod session;
mod taken_messages;
mod tasks;

use std::error::Error;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use sidekicks_contracts::event::usage::ModelRerouteScope;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::events::{
    ProviderWarningSource, SessionNotice, SessionNoticePostedPayload,
};
use sidekicks_contracts::session::events::SessionProviderStatusReportedPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::TurnTasksUpdate;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;
use tokio::time::Instant;

use self::daemon_ends::ClaudeStreamDialogPorts;
use self::members::read_frame_members;
pub(crate) use self::session::{ClaudeSessionStream, ClaudeSessionStreams};
use crate::command::running_set::RunningCommandSets;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::dialogs::ClaudeProviderDialogs;
use crate::driver::claude::delivery::messages::{
    ClaudeMessageFrame, ClaudeMessageRow, ClaudeMessageRowKind, read_claude_assistant_rows,
    read_claude_user_rows,
};
use crate::driver::claude::delivery::reviewer::ClaudeReviewerCapture;
use crate::driver::claude::delivery::run_readings::{ClaudeMessageKey, ClaudeRowDelivery};
use crate::driver::claude::delivery::streamed_blocks::ClaudeStreamedRun;
use crate::driver::claude::delivery::system::{
    read_claude_api_retry, read_claude_assistant_refusal, read_claude_model_reroute,
    read_claude_provider_status, read_claude_refusal_without_fallback, read_claude_warning,
    read_claude_worker_shutdown_reason,
};
use crate::driver::claude::delivery::turn_end::ClaudeTerminalReason;
use crate::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::driver::claude::hooks::pause::ClaudeRunPauses;
use crate::driver::claude::rate_limit_windows::{
    ClaudeUsageProbeModels, read_claude_quota_windows,
};
use crate::driver::claude::run::routes::{ClaudeBoundRun, ClaudeRunRoutes};
use crate::driver::claude::session::arrivals::ClaudeRoutedFrame;
use crate::driver::claude::session::context_reading::{
    ClaudeContextReadings, claude_exceeded_window_row,
};
use crate::driver::claude::session::transport::declarations::ClaudeMessageUsageObservation;
use crate::driver::claude::spent_retries_signal::classify_claude_spent_retries;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, OnceReportedDiagnostics,
};
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::run_host::RunHost;
use crate::port::running_command_publisher::RunningCommandPublisher as _;
use crate::port::turn_reading_publisher::TurnReadingPublisher;
use crate::port::usage_sink::UsageSink;
use crate::record_readers::read_non_empty_string;
use crate::run::delivery::{DeliveryBinding, InboundDelivery, LateAppendableRow, RunMarker};
use crate::run::state_entry::{RunStateEntry, RunStateReport};
use crate::thread_frame_router::ThreadFrameRoute;
use sidekicks_std::port_registration::PortRegistration;

/// Reports that Claude Code took a message the daemon handed: the session, the message's own id
/// and the run it was taken by.
pub(crate) type ClaudeMessageTaken = Arc<dyn Fn(SessionId, &str, RunId) + Send + Sync>;

/// What the stream delivers through and reads each session's state from.
pub(crate) struct ClaudeStreamDependencies {
    /// The run engine, which opens, counts and ends each turn.
    pub(crate) engine: Arc<dyn RunHost>,
    /// The run engine's dispatch, which takes each delivery.
    pub(crate) dispatch: Arc<dyn InboundDispatch>,
    /// The runs bound to each session.
    pub(crate) routes: Arc<ClaudeRunRoutes>,
    /// The choices Claude Code holds a run on.
    pub(crate) dialogs: Arc<ClaudeProviderDialogs<ClaudeStreamDialogPorts>>,
    /// Each run's pause.
    pub(crate) pauses: Arc<Mutex<ClaudeRunPauses>>,
    /// The reviewer's blocks, captured at a reviewed turn's end.
    pub(crate) reviewer: Arc<ClaudeReviewerCapture>,
    /// The queue's report that a handed message was taken.
    pub(crate) message_taken: ClaudeMessageTaken,
    /// Where the account's quota windows go once the usage record is registered.
    pub(crate) usage: Arc<PortRegistration<Arc<dyn UsageSink>>>,
    /// The model each account's latest limits read named for its weekly window over one model.
    pub(crate) usage_probe_models: Arc<ClaudeUsageProbeModels>,
    /// Every session's running commands, which the task frames report to once registered.
    pub(crate) command_output: Arc<PortRegistration<Arc<RunningCommandSets>>>,
    /// Where the working line's readings go once registered.
    pub(crate) turn_readings: Arc<PortRegistration<Arc<dyn TurnReadingPublisher>>>,
    /// Each session's context reads, which a lead message's usage reads mid-turn on.
    pub(crate) context: Arc<ClaudeContextReadings>,
}

/// What a frame left for the session's task to do beyond its deliveries.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ClaudeFrameAfter {
    /// The model the session moved to for the rest of it, which every later process starts on.
    pub(crate) running_model: Option<String>,
    /// The run whose turn did not fit the context window even after compaction, whose message
    /// Claude Code keeps until it is cut.
    pub(crate) too_long_run: Option<RunId>,
    /// A context read the frame calls for, with the run whose turn, compaction or model switch it
    /// follows; `Some(None)` after `system/init`, which follows no run.
    pub(crate) context_read: Option<Option<ClaudeBoundRun>>,
}

/// Turns each delivered frame of every session into the run engine's deliveries.
pub(crate) struct ClaudeDeliveryStream {
    dependencies: ClaudeStreamDependencies,
}

impl ClaudeDeliveryStream {
    /// A stream delivering through `dependencies`.
    pub(crate) fn new(dependencies: ClaudeStreamDependencies) -> Self {
        Self { dependencies }
    }

    /// Takes one frame the reader routed off `session`'s process, whole and untrusted, on the
    /// session's task. Only a frame the router projects, routes with no identity or carves out as
    /// a helper's request is delivered; what routing read off any frame (a helper's start or end,
    /// the usage it metered, a settled output speed) is delivered whatever its route, and a
    /// helper's own calls and tasks are read for the session's running commands.
    /// `is_reviewed` says the session runs reviewed, whose turn end captures the reviewer's blocks.
    pub(crate) async fn take_frame(
        &self,
        session: &ClaudeSessionStream,
        routed: ClaudeRoutedFrame,
        is_reviewed: bool,
    ) -> ClaudeFrameAfter {
        let ClaudeRoutedFrame {
            frame,
            routed,
            is_turn_ending,
            turn_at_read,
        } = routed;
        let mut after = ClaudeFrameAfter::default();
        if let Some(settled) = routed.settled_output_speed
            && let Err(error) = self
                .dependencies
                .engine
                .record_settled_output_speed(session.session_id, settled.run_id, settled.state)
                .await
        {
            report_engine_failure(session, "the settled output speed", &*error);
        }
        for emission in routed.helper_lifecycle {
            self.deliver_helper_lifecycle(session, turn_at_read.lead.clone(), emission)
                .await;
        }
        self.record_metered(session, turn_at_read.lead.as_ref(), routed.metered)
            .await;
        let frame_kind = frame.observation.frame_kind.as_str();
        // The router quarantined every kind the census leaves out, but a `result`, before it came
        // here.
        let Some(kind) = ClaudeWireFrameKind::read(frame_kind) else {
            return after;
        };
        let is_helper_frame = matches!(routed.route, ThreadFrameRoute::ChildTranscript { .. });
        if !is_helper_frame
            && !matches!(
                routed.route,
                ThreadFrameRoute::Project
                    | ThreadFrameRoute::RouteConnectionScoped
                    | ThreadFrameRoute::CarveOutInteractiveRequest { .. }
            )
        {
            return after;
        }
        let Some(members) = read_frame_members(&frame.text) else {
            return after;
        };
        // A command or tool-server task, the lead's or a helper's, may end after its turn did.
        if kind.is_task() {
            self.take_task_frame(session, &kind, &frame.text, &members, turn_at_read.lead)
                .await;
            return after;
        }
        // A helper's own message carries no row of the session's, only the lines of its calls.
        if is_helper_frame {
            if kind == ClaudeWireFrameKind::Assistant
                && let Ok(message) = serde_json::from_str::<ClaudeMessageFrame>(&frame.text)
            {
                session.lock().command_tasks.observe_calls(&message);
            }
            return after;
        }
        let released = session.lock().buffer.flush_expired(Instant::now());
        self.send_rows(session, released, None).await;
        if matches!(
            kind,
            ClaudeWireFrameKind::SystemInit | ClaudeWireFrameKind::SystemStatus
        ) && let Some(mode) = read_non_empty_string(&members, "permissionMode")
        {
            session.lock().permission_mode = Some(mode.to_owned());
        }
        if kind == ClaudeWireFrameKind::CommandLifecycle {
            self.read_command_lifecycle(session, &members);
            return after;
        }
        // The account's quota, whichever turn it came on.
        if kind == ClaudeWireFrameKind::RateLimitEvent {
            self.record_quota_windows(session, &members).await;
            return after;
        }
        let is_result = kind.is_result();
        // The reader released the turn as it read a turn-ending `result`, so that frame ends the
        // turn the stream opened; any other frame belongs to the run that held the turn as it was
        // read, the reader being ahead of this task.
        let open_turn = is_result
            .then(|| session.lock().turn.clone())
            .flatten()
            .map(|turn| ClaudeBoundRun {
                run_id: turn.run_id,
                binding_id: turn.binding_id,
            });
        let Some(lead) = open_turn
            .or(turn_at_read.lead)
            .or_else(|| self.dependencies.routes.lead_run_on(session.session_id))
        else {
            // A frame of a turn no daemon run holds, such as one Claude Code started itself
            // whose run never opened; the process's own start is still read for its context.
            if kind == ClaudeWireFrameKind::SystemInit {
                after.context_read = Some(None);
            }
            record_unmapped(
                session,
                &session.unheld_reports,
                frame_kind,
                UNHELD_FRAME_REASON,
            );
            return after;
        };
        if let ClaudeWireFrameKind::ResultUnlisted { .. } = kind {
            record_unmapped(
                session,
                &session.unlisted_result_reports,
                frame_kind,
                "a `result` of a subtype the census does not list, or of none, ends its turn as \
                 a failure naming the subtype or its absence",
            );
        }
        self.open_turn(session, &lead).await;
        if self.dependencies.dialogs.observe_turn_frame(lead.run_id) {
            // An answer no write or check settled reached Claude Code, which runs the turn again.
            let running = RunStateReport {
                expected_state: Some(RunState::WaitingForInput),
                ..RunStateReport::new(
                    lead.run_id,
                    RunStateEntry::Running {
                        execution_posture: None,
                    },
                )
            };
            self.send(
                session,
                InboundDelivery::RunLifecycle {
                    binding: bound(&lead),
                    change: running,
                    turn_end: None,
                    is_daemon_interrupt_end: false,
                },
                Some(frame_kind),
            )
            .await;
        }
        if is_result {
            if is_turn_ending {
                if is_too_long_for_window(&members) {
                    let row = claude_exceeded_window_row(session.session_id, lead.run_id);
                    self.send_row(session, &lead, row, frame_kind).await;
                }
                after.context_read = Some(Some(lead.clone()));
                after.too_long_run = self
                    .end_turn(
                        session,
                        &lead,
                        &Value::Object(members),
                        &kind,
                        routed.route,
                        is_reviewed,
                    )
                    .await;
            }
            return after;
        }
        match kind {
            ClaudeWireFrameKind::SystemInit => {
                after.context_read = Some(None);
                self.mark_initialized(session, &lead, read_non_empty_string(&members, "model"))
                    .await;
            }
            ClaudeWireFrameKind::SystemCompactBoundary => {
                after.context_read = Some(Some(lead));
            }
            ClaudeWireFrameKind::SystemStatus => {
                if let Some(status) = read_claude_provider_status(&members) {
                    let row = LateAppendableRow::SessionProviderStatusReported(
                        SessionProviderStatusReportedPayload {
                            session_id: session.session_id,
                            run_id: Some(lead.run_id),
                            provider: DESCRIPTOR.provider_id(),
                            status,
                            detail: None,
                            source_epoch: None,
                            source_position: None,
                        },
                    );
                    self.send_row(session, &lead, row, frame_kind).await;
                }
            }
            ClaudeWireFrameKind::SystemWorkerShuttingDown => {
                let marker = RunMarker::WorkerShuttingDown {
                    run_id: lead.run_id,
                    reason: read_claude_worker_shutdown_reason(&members),
                };
                self.send_marker(session, &lead, marker, Some(frame_kind))
                    .await;
            }
            ClaudeWireFrameKind::SystemApiRetry => {
                let retried = read_claude_api_retry(&members, session.session_id, lead.run_id);
                let row = LateAppendableRow::UsageApiRequestRetried(retried);
                self.send_row(session, &lead, row, frame_kind).await;
                mark_retries_spent(session, members);
            }
            // Claude Code maps its `api_error` onto the retry announcement, which alone is a
            // retried request.
            ClaudeWireFrameKind::SystemApiError => mark_retries_spent(session, members),
            ClaudeWireFrameKind::SystemInformational => {
                if let Some(text) = read_claude_warning(&members) {
                    let notice =
                        SessionNoticePostedPayload::Notice(SessionNotice::ProviderWarning {
                            session_id: session.session_id,
                            source: ProviderWarningSource::Warning,
                            text,
                            details: None,
                        });
                    self.send(
                        session,
                        InboundDelivery::SessionNotice {
                            session_id: session.session_id,
                            notice,
                        },
                        Some(frame_kind),
                    )
                    .await;
                }
            }
            ClaudeWireFrameKind::SystemModelRefusalFallback
            | ClaudeWireFrameKind::SystemModelFallback
            | ClaudeWireFrameKind::SystemModelConsentFallback => {
                // Another model took the refused turn, which Claude Code retracts: no refusal.
                if kind == ClaudeWireFrameKind::SystemModelRefusalFallback {
                    session.lock().refusal = None;
                }
                after.running_model = self.reroute(session, &lead, frame_kind, &members).await;
                after.context_read = Some(Some(lead));
            }
            ClaudeWireFrameKind::SystemModelRefusalNoFallback => {
                session.lock().refusal = read_claude_refusal_without_fallback(&members);
            }
            ClaudeWireFrameKind::SystemPermissionDenied => {
                if let (Some(tool_call_id), Some(message)) = (
                    read_non_empty_string(&members, "tool_use_id"),
                    read_non_empty_string(&members, "message"),
                ) {
                    session
                        .lock()
                        .failed_call_words
                        .insert(tool_call_id.to_owned(), message.to_owned());
                }
            }
            ClaudeWireFrameKind::StreamEvent => self.stream_event(session, &lead, &frame.text),
            ClaudeWireFrameKind::Assistant => {
                let usage = frame.observation.message_usage.as_ref();
                self.assistant(session, &lead, &frame.text, &members, usage)
                    .await;
            }
            ClaudeWireFrameKind::User => self.user(session, &lead, &frame.text, &members).await,
            // Read above: the tasks, a sent message's fate, the quota and the turn's end.
            ClaudeWireFrameKind::SystemTaskStarted
            | ClaudeWireFrameKind::SystemTaskUpdated
            | ClaudeWireFrameKind::SystemTaskNotification
            | ClaudeWireFrameKind::SystemBackgroundTasksChanged
            | ClaudeWireFrameKind::CommandLifecycle
            | ClaudeWireFrameKind::RateLimitEvent
            | ClaudeWireFrameKind::ResultSuccess
            | ClaudeWireFrameKind::ResultErrorMaxTurns
            | ClaudeWireFrameKind::ResultErrorMaxBudgetUsd
            | ClaudeWireFrameKind::ResultErrorDuringExecution
            | ClaudeWireFrameKind::ResultErrorMaxStructuredOutputRetries
            | ClaudeWireFrameKind::ResultUnlisted { .. }
            // Routing took the whole `/` list as it read the frame.
            | ClaudeWireFrameKind::SystemCommandsChanged
            // Kinds that add no row; each variant says why.
            | ClaudeWireFrameKind::SystemHookStarted
            | ClaudeWireFrameKind::SystemHookProgress
            | ClaudeWireFrameKind::SystemHookResponse
            | ClaudeWireFrameKind::SystemNotification
            | ClaudeWireFrameKind::SystemFilesPersisted
            | ClaudeWireFrameKind::SystemToolUseSummary
            | ClaudeWireFrameKind::SystemMemoryRecall
            | ClaudeWireFrameKind::SystemLocalCommandOutput
            | ClaudeWireFrameKind::SystemTaskProgress
            // Control traffic takes the request path or settles a call, never this reader.
            | ClaudeWireFrameKind::ControlRequestCanUseTool
            | ClaudeWireFrameKind::ControlRequestElicitation
            | ClaudeWireFrameKind::ControlRequestRequestUserDialog
            | ClaudeWireFrameKind::ControlRequestHookCallback
            | ClaudeWireFrameKind::ControlRequestMcpMessage
            | ClaudeWireFrameKind::ControlRequestMcpSetServers
            | ClaudeWireFrameKind::ControlRequestInterrupt
            | ClaudeWireFrameKind::ControlRequestSetPermissionMode
            | ClaudeWireFrameKind::ControlRequestSetModel
            | ClaudeWireFrameKind::ControlRequestGetUsage
            | ClaudeWireFrameKind::ControlRequestGetContextUsage
            | ClaudeWireFrameKind::ControlRequestGetSessionCost
            | ClaudeWireFrameKind::ControlRequestListModels
            | ClaudeWireFrameKind::ControlRequestGetBinaryVersion
            | ClaudeWireFrameKind::ControlRequestApplyFlagSettings
            | ClaudeWireFrameKind::ControlRequestRewindFiles
            | ClaudeWireFrameKind::ControlResponseSuccess
            | ClaudeWireFrameKind::ControlResponseError => {}
        }
        after
    }

    /// Sends the pieces and held rows whose time has come at `now`, as the session's timer fires.
    pub(crate) async fn deliver_due(&self, session: &ClaudeSessionStream, now: Instant) {
        let (pieces, released, turn) = {
            let mut readings = session.lock();
            (
                readings.streamed_blocks.due(now),
                readings.buffer.flush_expired(now),
                readings.turn.clone(),
            )
        };
        self.send_rows(session, released, None).await;
        if let Some(turn) = turn {
            self.send_pieces(session, &turn.binding_id, pieces).await;
        }
    }

    /// Releases what the session streamed and buffered, as its process is gone, and forgets its
    /// readings; the exit path ends the run its turn was on.
    pub(crate) async fn end_session(&self, session: &ClaudeSessionStream) {
        let (pieces, released, turn) = {
            let mut readings = session.lock();
            (
                readings.streamed_blocks.end_all(),
                readings.buffer.flush_all(Instant::now()),
                readings.turn.clone(),
            )
        };
        if let Some(turn) = turn {
            self.send_pieces(session, &turn.binding_id, pieces).await;
        }
        self.send_rows(session, released, None).await;
        {
            let mut readings = session.lock();
            readings.daemon_ended.clear();
            readings.carried_ends.clear();
            readings.now_steers.clear();
            readings.turn = None;
            readings.command_tasks.forget();
            readings.tool_server_tasks.forget();
        }
        // The process's commands ended with it.
        if let Some(sets) = self.dependencies.command_output.port() {
            sets.provider_exited(session.session_id);
        }
        self.dependencies.context.forget_session(session.session_id);
    }

    async fn mark_initialized(
        &self,
        session: &ClaudeSessionStream,
        lead: &ClaudeBoundRun,
        model: Option<&str>,
    ) {
        if !session.lock().initialized_runs.insert(lead.run_id) {
            return;
        }
        let marker = RunMarker::ProviderInitialized {
            run_id: lead.run_id,
            provider: DESCRIPTOR.provider_id(),
            model: model.and_then(|model| FreeFormText::new(model.to_owned()).ok()),
        };
        self.send_marker(session, lead, marker, Some("system/init"))
            .await;
    }

    // A model switch's row; a session-long one answers the model every later process starts on.
    async fn reroute(
        &self,
        session: &ClaudeSessionStream,
        lead: &ClaudeBoundRun,
        frame_kind: &str,
        members: &Map<String, Value>,
    ) -> Option<String> {
        let reroute =
            read_claude_model_reroute(frame_kind, members, session.session_id, lead.run_id)?;
        let running_model = (reroute.scope == ModelRerouteScope::Session)
            .then(|| reroute.to_model.as_str().to_owned());
        self.send_row(
            session,
            lead,
            LateAppendableRow::AgentTurnRerouted(reroute),
            frame_kind,
        )
        .await;
        running_model
    }

    // An assistant message's rows, its calls' lines and task-list changes, its step, and the
    // mid-turn context reading its `usage` gives.
    async fn assistant(
        &self,
        session: &ClaudeSessionStream,
        lead: &ClaudeBoundRun,
        text: &str,
        members: &Map<String, Value>,
        usage: Option<&ClaudeMessageUsageObservation>,
    ) {
        let error = read_non_empty_string(members, "error");
        self.dependencies
            .dialogs
            .observe_assistant_error(lead.run_id, error)
            .await;
        let Ok(frame) = serde_json::from_str::<ClaudeMessageFrame>(text) else {
            return;
        };
        let (pieces, rows, counts_step, tasks) = {
            let mut readings = session.lock();
            readings.command_tasks.observe_calls(&frame);
            let tasks = readings.turn_readings.observe_calls(&frame);
            // As Claude Code reads a turn, its last refused message is the turn's refusal.
            if let Some(refusal) = read_claude_assistant_refusal(members) {
                readings.refusal = Some(refusal);
            }
            let rows = read_claude_assistant_rows(
                &frame,
                session.session_id,
                lead.run_id,
                &mut readings.open_tool_calls,
                Instant::now(),
            );
            // A step is one message carrying a tool call, the unit Claude Code's own bound counts.
            let counts_step = rows.iter().any(is_tool_call)
                && frame.provider_message_id().is_some_and(|message_id| {
                    readings.counted_step_messages.insert(message_id.to_owned())
                });
            let (pieces, unstreamed) = readings.streamed_blocks.finish(&frame, rows);
            let key = frame
                .uuid()
                .map(|uuid| ClaudeMessageKey::Uuid(uuid.to_owned()));
            let rows = unstreamed
                .into_iter()
                .map(|row| ClaudeRowDelivery::of_message(&lead.binding_id, row, key.clone()))
                .collect::<Vec<_>>();
            (pieces, rows, counts_step, tasks)
        };
        if let Some(tasks) = tasks {
            self.publish_turn_tasks(session, tasks);
        }
        self.send_pieces(session, &lead.binding_id, pieces).await;
        self.admit_rows(session, rows, "assistant").await;
        if counts_step && let Err(error) = self.dependencies.engine.count_step(lead.run_id).await {
            report_engine_failure(session, "a step", &*error);
        }
        if let Some(usage) = usage
            && let Some(row) =
                self.dependencies
                    .context
                    .read_mid_turn(session.session_id, lead.run_id, usage)
        {
            self.send_row(session, lead, row, "assistant").await;
        }
    }

    async fn user(
        &self,
        session: &ClaudeSessionStream,
        lead: &ClaudeBoundRun,
        text: &str,
        members: &Map<String, Value>,
    ) {
        let Ok(frame) = serde_json::from_str::<ClaudeMessageFrame>(text) else {
            return;
        };
        let (rows, tasks) = {
            let mut guard = session.lock();
            let readings = &mut *guard;
            let reading = read_claude_user_rows(
                &frame,
                session.session_id,
                lead.run_id,
                &mut readings.open_tool_calls,
                readings.tool_server_tasks.held_call_ids(),
                Instant::now(),
            );
            readings.failed_call_words.extend(reading.failed_results);
            let tasks = readings.turn_readings.observe_results(&frame);
            let key = frame
                .uuid()
                .map(|uuid| ClaudeMessageKey::Uuid(uuid.to_owned()));
            let rows = reading
                .rows
                .into_iter()
                .map(|row| ClaudeRowDelivery::of_message(&lead.binding_id, row, key.clone()))
                .collect::<Vec<_>>();
            (rows, tasks)
        };
        if let Some(tasks) = tasks {
            self.publish_turn_tasks(session, tasks);
        }
        // Claude Code echoes each message it took off its input with the uuid it was sent under;
        // a helper's replay carries its parent call and was never handed.
        if members.get("isReplay").and_then(Value::as_bool) == Some(true)
            && members.get("parent_tool_use_id").is_none_or(Value::is_null)
            && let Some(uuid) = frame.uuid()
        {
            self.report_taken(session, uuid);
        }
        self.admit_rows(session, rows, "user").await;
    }

    // A streamed piece waits for its interval, which the session's timer sends; the tokens the
    // turn received go to the working line at once.
    fn stream_event(&self, session: &ClaudeSessionStream, lead: &ClaudeBoundRun, text: &str) {
        let run = ClaudeStreamedRun {
            session_id: session.session_id,
            run_id: lead.run_id,
        };
        let usage = {
            let mut readings = session.lock();
            readings.streamed_blocks.observe(text, run, Instant::now());
            readings.turn_readings.observe_stream_event(text)
        };
        if let (Some(usage), Some(publisher)) = (usage, self.dependencies.turn_readings.port()) {
            publisher.publish_turn_usage(session.session_id, usage);
        }
    }

    // Sends the turn's whole task list to the working line, once its readings are registered.
    fn publish_turn_tasks(&self, session: &ClaudeSessionStream, tasks: TurnTasksUpdate) {
        if let Some(publisher) = self.dependencies.turn_readings.port() {
            publisher.publish_turn_tasks(session.session_id, tasks);
        }
    }

    // The quota windows the account's limits frame reports, recorded on the account the process
    // runs on; a refused record is reported.
    async fn record_quota_windows(
        &self,
        session: &ClaudeSessionStream,
        members: &Map<String, Value>,
    ) {
        let Some(sink) = self.dependencies.usage.port() else {
            return;
        };
        let windows = read_claude_quota_windows(
            members,
            &self.dependencies.usage_probe_models,
            &session.provider_account_id,
        );
        if let Err(error) = sink
            .record_quota_windows(
                DESCRIPTOR.provider_id(),
                session.provider_account_id.clone(),
                windows,
            )
            .await
        {
            report_engine_failure(session, "the quota windows", &*error);
        }
    }
}

// A run's binding with no tool call.
fn bound(run: &ClaudeBoundRun) -> DeliveryBinding<'static> {
    DeliveryBinding {
        binding_id: run.binding_id.clone(),
        operation: None,
    }
}

fn is_tool_call(row: &ClaudeMessageRow) -> bool {
    matches!(
        row.row,
        ClaudeMessageRowKind::Session {
            row: LateAppendableRow::AgentToolCallInvoked(_),
            ..
        }
    )
}

// Why a frame of a turn no daemon run holds is dropped.
const UNHELD_FRAME_REASON: &str = "a frame of a turn no daemon run holds has no binding to be \
                                   attributed on, so it is dropped with this record";

// Reports the first frame of each kind in `reports` the reader has no row for, a frame no daemon
// run holds or a `result` of an unlisted subtype; a kind the build sends every turn would
// otherwise log on every frame.
fn record_unmapped(
    session: &ClaudeSessionStream,
    reports: &Mutex<OnceReportedDiagnostics>,
    frame_kind: &str,
    disposition_reason: &str,
) {
    lock(reports).report(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: Some(session.provider_account_id.clone()),
        kind: DriverDiagnosticKind::UnmappedWireKind,
        raw_wire_type: Some(frame_kind.to_owned()),
        disposition_reason: disposition_reason.to_owned(),
        details: Map::from_iter([(
            "sessionId".to_owned(),
            Value::from(session.session_id.to_string()),
        )]),
    });
}

// Marks the session's retries spent when a retry frame says Claude Code gave up retrying.
fn mark_retries_spent(session: &ClaudeSessionStream, members: Map<String, Value>) {
    if classify_claude_spent_retries(&Value::Object(members)).is_some() {
        session.lock().is_retries_spent = true;
    }
}

fn report_engine_failure(
    session: &ClaudeSessionStream,
    what: &'static str,
    error: &(dyn Error + 'static),
) {
    tracing::warn!(
        session_id = %session.session_id,
        what,
        error,
        "the run engine could not take what a Claude Code session reported"
    );
}

// Whether a `result` ended its turn because the conversation no longer fits the window.
fn is_too_long_for_window(members: &Map<String, Value>) -> bool {
    read_non_empty_string(members, "terminal_reason")
        .and_then(|reason| ClaudeTerminalReason::from_str(reason).ok())
        .is_some_and(ClaudeTerminalReason::is_too_long)
}

#[cfg(test)]
mod tests;
