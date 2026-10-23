//! Every frame a Claude Code session's process wrote becomes the run engine's deliveries, on the
//! session's own task and in frame order, on the binding of the run holding the session's turn:
//! the turn's opening, its markers, its message and tool rows, the text and thinking Claude Code
//! streams as stored pieces of their message, the provider's status, warnings and model switches,
//! a helper's child run, and the turn's end. A frame of a turn no daemon run holds is recorded and
//! dropped.

pub(crate) mod daemon_ends;
mod helper_runs;
mod rows;
mod run_end;
mod taken_messages;

use std::collections::HashMap;
use std::error::Error;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{Map, Value};
use sidekicks_contracts::event::usage::ModelRerouteScope;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::events::{
    ProviderWarningSource, SessionNotice, SessionNoticePostedPayload,
};
use sidekicks_contracts::session::events::SessionProviderStatusReportedPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::{MAX_SAFE_INTEGER, SafeInt};
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::time::Instant;

use crate::mutex_lock::lock;
use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::delivery::dialogs::ClaudeProviderDialogs;
use crate::provider::driver::claude::delivery::messages::{
    ClaudeMessageFrame, ClaudeMessageRow, ClaudeMessageRowKind, read_claude_assistant_rows,
    read_claude_user_rows,
};
use crate::provider::driver::claude::delivery::reviewer::ClaudeReviewerCapture;
use crate::provider::driver::claude::delivery::run_engine::ClaudeRunEngine;
use crate::provider::driver::claude::delivery::run_readings::{
    ClaudeMessageKey, ClaudeRowDelivery, ClaudeStreamSession,
};
use crate::provider::driver::claude::delivery::streamed_blocks::ClaudeStreamedRun;
use crate::provider::driver::claude::delivery::system::{
    read_claude_api_retry, read_claude_assistant_refusal, read_claude_model_reroute,
    read_claude_provider_status, read_claude_refusal_without_fallback, read_claude_warning,
    read_claude_worker_shutdown_reason,
};
use crate::provider::driver::claude::delivery::turn_end::read_claude_result_message_uuids;
use crate::provider::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::provider::driver::claude::hooks::pause::ClaudeRunPauses;
use crate::provider::driver::claude::rate_limit_windows::{
    ClaudeUsageProbeModels, read_claude_quota_windows,
};
use crate::provider::driver::claude::run::prompts::ClaudeSentPrompts;
use crate::provider::driver::claude::run::routes::{ClaudeBoundRun, ClaudeRunRoutes};
use crate::provider::driver::claude::session::arrivals::{
    ClaudeArrivalSender, ClaudeRoutedFrame, ClaudeTurnAtRead,
};
use crate::provider::driver::claude::spent_retries_signal::classify_claude_spent_retries;
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, OnceReportedDiagnostics,
};
use crate::provider::port::registration::PortRegistration;
use crate::provider::port::usage_sink::UsageSink;
use crate::provider::record_readers::read_non_empty_string;
use crate::provider::thread_frame_router::ThreadFrameRoute;
use crate::session::run::engine::RunMarker;
use crate::session::run::inbound::rows::LateAppendableRow;
use crate::session::run::inbound::{DeliveryBinding, InboundDelivery};
use crate::session::run::state_change::{RunStateChange, RunStateEntry};

use daemon_ends::ClaudeStreamDialogPorts;

/// Reports that Claude Code took a message the daemon handed: the session, the message's own id
/// and the run it was taken by.
pub(crate) type ClaudeMessageTaken = Arc<dyn Fn(SessionId, &str, RunId) + Send + Sync>;

/// What the stream delivers through and reads each session's state from.
pub(crate) struct ClaudeStreamDependencies {
    /// The run engine.
    pub(crate) engine: Arc<dyn ClaudeRunEngine>,
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
}

/// What a frame left for the session's task to do beyond its deliveries.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ClaudeFrameAfter {
    /// The model the session moved to for the rest of it, which every later process starts on.
    pub(crate) running_model: Option<String>,
    /// The run whose turn did not fit the context window even after compaction, whose message
    /// Claude Code keeps until it is cut.
    pub(crate) too_long_run: Option<RunId>,
}

/// One session's stream while its process runs: its readings, behind one lock never held across
/// an await, and its queue.
pub(crate) struct ClaudeSessionStream {
    session_id: SessionId,
    provider_account_id: Option<ProviderAccountId>,
    step_bound: Option<SafeInt<1>>,
    readings: Mutex<ClaudeStreamSession>,
    arrivals: ClaudeArrivalSender,
    routes: Arc<ClaudeRunRoutes>,
    prompts: Arc<Mutex<ClaudeSentPrompts>>,
    // The kinds of the frames no daemon run held, already logged on this process's connection.
    diagnostics: Mutex<OnceReportedDiagnostics>,
    // How many turns the run engine could not number have ended.
    unnumbered_turns: AtomicU64,
}

impl ClaudeSessionStream {
    /// A stream for the process running on `provider_account_id`'s home, counting each turn's
    /// steps against `step_bound` and queuing onto `arrivals`.
    pub(crate) fn new(
        provider_account_id: Option<ProviderAccountId>,
        step_bound: Option<SafeInt<1>>,
        arrivals: ClaudeArrivalSender,
        routes: Arc<ClaudeRunRoutes>,
        prompts: Arc<Mutex<ClaudeSentPrompts>>,
    ) -> Self {
        Self {
            session_id: arrivals.session_id(),
            readings: Mutex::new(ClaudeStreamSession::new(provider_account_id.clone())),
            provider_account_id,
            step_bound,
            arrivals,
            routes,
            prompts,
            diagnostics: Mutex::default(),
            unnumbered_turns: AtomicU64::new(0),
        }
    }

    // A terminal gate version for one more turn the run engine could not number, past every
    // turn number, so no two such turns share one.
    fn unnumbered_turn_version(&self) -> u64 {
        MAX_SAFE_INTEGER + 1 + self.unnumbered_turns.fetch_add(1, Ordering::Relaxed)
    }

    /// The session.
    pub(crate) fn session_id(&self) -> SessionId {
        self.session_id
    }

    /// The bound on each turn's steps the process was started with.
    pub(crate) fn step_bound(&self) -> Option<SafeInt<1>> {
        self.step_bound
    }

    /// The session's queue.
    pub(crate) fn arrivals(&self) -> &ClaudeArrivalSender {
        &self.arrivals
    }

    /// The account the process runs on; `None` on the machine's own home.
    pub(crate) fn provider_account_id(&self) -> Option<&ProviderAccountId> {
        self.provider_account_id.as_ref()
    }

    /// Whether the lead `result` in `text` ends the session's turn, read on the process's reader.
    /// A `result` naming no steer written `now` while one waits is Claude Code's abort for that
    /// steer and ends nothing; one naming it ends the turn and settles the steer. A run with a
    /// steer still waiting keeps the turn through the settlement the reader then makes, since
    /// Claude Code starts its next turn with that steer; the turn's end on the session's task
    /// decides whether the run goes on into it.
    pub(crate) fn is_turn_ending(&self, text: &str) -> bool {
        let is_ending = {
            let mut readings = self.lock();
            if readings.now_steers.is_empty() {
                true
            } else {
                let named = read_claude_result_message_uuids(text);
                let before = readings.now_steers.len();
                readings
                    .now_steers
                    .retain(|uuid| !named.iter().any(|named| named == uuid));
                readings.now_steers.len() < before
            }
        };
        if !is_ending {
            return false;
        }
        let lead = self.routes.lead_run_on(self.session_id);
        let carried = lead.filter(|lead| self.lock_prompts().has_untaken_steer(lead.run_id));
        if let Some(lead) = &carried {
            self.routes.carry_turn_over(lead.run_id);
        }
        self.lock().reader_carried_run = carried.map(|lead| lead.run_id);
        true
    }

    /// The session's turn now, which the reader stamps on each frame as it reads it.
    pub(crate) fn turn_at_read(&self) -> ClaudeTurnAtRead {
        ClaudeTurnAtRead {
            lead: self.routes.lead_run_on(self.session_id),
            is_held: self.routes.is_turn_held(self.session_id),
        }
    }

    /// Records a steer written with Claude Code's `now` mark, whose turn's own `result` alone ends
    /// the turn; recorded before the write.
    pub(crate) fn mark_now_steer(&self, message_uuid: &str) {
        self.lock().now_steers.insert(message_uuid.to_owned());
    }

    /// Takes back a `now` steer that never reached Claude Code, or that it dropped.
    pub(crate) fn unmark_now_steer(&self, message_uuid: &str) {
        self.lock().now_steers.remove(message_uuid);
    }

    /// Marks a close the daemon asked for, so the turn end it provokes carries it.
    pub(crate) fn signal_intended_close(&self) {
        self.lock().gate.signal_intended_close();
    }

    /// The permission mode the process last reported it runs in, if any.
    pub(crate) fn permission_mode(&self) -> Option<String> {
        self.lock().permission_mode.clone()
    }

    /// When the stream's timed work next comes due: a streamed piece's interval or a held tool
    /// result's pairing timeout.
    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        let readings = self.lock();
        match (
            readings.streamed_blocks.next_deadline(),
            readings.buffer.next_release(),
        ) {
            (Some(piece), Some(held)) => Some(piece.min(held)),
            (piece, held) => piece.or(held),
        }
    }

    fn lock(&self) -> MutexGuard<'_, ClaudeStreamSession> {
        lock(&self.readings)
    }

    fn lock_prompts(&self) -> MutexGuard<'_, ClaudeSentPrompts> {
        lock(&self.prompts)
    }
}

/// Every live session's stream, by session.
#[derive(Default)]
pub(crate) struct ClaudeSessionStreams {
    streams: Mutex<HashMap<SessionId, Arc<ClaudeSessionStream>>>,
}

impl ClaudeSessionStreams {
    /// Keeps `stream` as its session's, replacing a process's that came before.
    pub(crate) fn insert(&self, stream: Arc<ClaudeSessionStream>) {
        self.lock().insert(stream.session_id, stream);
    }

    /// The session's stream, if its process runs.
    pub(crate) fn get(&self, session_id: SessionId) -> Option<Arc<ClaudeSessionStream>> {
        self.lock().get(&session_id).cloned()
    }

    /// Forgets the session's stream, if it is still `stream`: a successor's is kept.
    pub(crate) fn remove(&self, stream: &Arc<ClaudeSessionStream>) {
        let mut streams = self.lock();
        if streams
            .get(&stream.session_id)
            .is_some_and(|kept| Arc::ptr_eq(kept, stream))
        {
            streams.remove(&stream.session_id);
        }
    }

    // The stream holding the daemon's end of `run_id`, wherever the run is now routed.
    fn holding_daemon_end(&self, run_id: RunId) -> Option<Arc<ClaudeSessionStream>> {
        self.lock()
            .values()
            .find(|stream| stream.lock().daemon_ended.contains_key(&run_id))
            .cloned()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<SessionId, Arc<ClaudeSessionStream>>> {
        lock(&self.streams)
    }
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
    /// a settled output speed) is delivered whatever its route. `is_reviewed` says the session
    /// runs reviewed, whose turn end captures the reviewer's blocks.
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
            report_engine_failure(session, "the settled output speed", &error);
        }
        for emission in routed.helper_lifecycle {
            self.deliver_helper_lifecycle(session, turn_at_read.lead.clone(), emission)
                .await;
        }
        if !matches!(
            routed.route,
            ThreadFrameRoute::Project
                | ThreadFrameRoute::RouteConnectionScoped
                | ThreadFrameRoute::CarveOutInteractiveRequest { .. }
        ) {
            return after;
        }
        let frame_kind = frame.observation.frame_kind.as_str();
        // The router quarantined every kind the census leaves out, but a `result`, before it came
        // here.
        let Some(kind) = ClaudeWireFrameKind::read(frame_kind) else {
            return after;
        };
        let Ok(Value::Object(members)) = serde_json::from_str::<Value>(&frame.text) else {
            return after;
        };
        let released = session.lock().buffer.flush_expired(Instant::now());
        self.send_rows(session, released, None).await;
        if matches!(
            kind,
            ClaudeWireFrameKind::SystemInit | ClaudeWireFrameKind::SystemStatus
        ) && let Some(mode) = read_non_empty_string(&members, "permissionMode")
        {
            session.lock().permission_mode = Some(mode.to_owned());
        }
        // A background helper ends on its own route, also after the turn that started it ended.
        if kind == ClaudeWireFrameKind::SystemTaskNotification {
            self.end_helper(session, &members).await;
            return after;
        }
        if kind == ClaudeWireFrameKind::CommandLifecycle {
            self.read_command_lifecycle(session, &members);
            return after;
        }
        // The account's quota, whichever turn it came on.
        if kind == ClaudeWireFrameKind::RateLimitEvent {
            if let Some(sink) = self.dependencies.usage.port() {
                sink.record_quota_windows(
                    DESCRIPTOR.provider_id(),
                    session.provider_account_id.clone(),
                    read_claude_quota_windows(
                        &members,
                        &self.dependencies.usage_probe_models,
                        session.provider_account_id.as_ref(),
                    ),
                );
            }
            return after;
        }
        let is_result = kind.is_result();
        if let ClaudeWireFrameKind::ResultUnlisted { .. } = kind {
            record_unmapped(
                session,
                frame_kind,
                "a `result` of a subtype the census does not list ends its turn as a failure \
                 carrying the subtype",
            );
        }
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
            // whose run never opened.
            record_unmapped(session, frame_kind, UNHELD_FRAME_REASON);
            return after;
        };
        self.open_turn(session, &lead).await;
        if self.dependencies.dialogs.observe_turn_frame(lead.run_id) {
            // An answer no write or check settled reached Claude Code, which runs the turn again.
            let running = RunStateChange {
                expected_state: Some(RunState::WaitingForInput),
                ..RunStateChange::new(
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
                after.too_long_run = self
                    .end_turn(
                        session,
                        &lead,
                        &Value::Object(members),
                        routed.route,
                        is_reviewed,
                    )
                    .await;
            }
            return after;
        }
        match kind {
            ClaudeWireFrameKind::SystemInit => {
                self.mark_initialized(session, &lead, read_non_empty_string(&members, "model"))
                    .await;
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
            ClaudeWireFrameKind::StreamEvent => stream_event(session, &lead, &frame.text),
            ClaudeWireFrameKind::Assistant => {
                self.assistant(session, &lead, &frame.text, &members).await;
            }
            ClaudeWireFrameKind::User => self.user(session, &lead, &frame.text, &members).await,
            // Read above: a helper's end, a sent message's fate, the quota and the turn's end.
            ClaudeWireFrameKind::SystemTaskNotification
            | ClaudeWireFrameKind::CommandLifecycle
            | ClaudeWireFrameKind::RateLimitEvent
            | ClaudeWireFrameKind::ResultSuccess
            | ClaudeWireFrameKind::ResultErrorMaxTurns
            | ClaudeWireFrameKind::ResultErrorMaxBudgetUsd
            | ClaudeWireFrameKind::ResultErrorDuringExecution
            | ClaudeWireFrameKind::ResultErrorMaxStructuredOutputRetries
            | ClaudeWireFrameKind::ResultUnlisted { .. }
            // A helper's start and moves, read off the frame before it reaches the reader.
            | ClaudeWireFrameKind::SystemTaskStarted
            | ClaudeWireFrameKind::SystemTaskUpdated
            // Kinds that add no row; each variant says why.
            | ClaudeWireFrameKind::SystemCompactBoundary
            | ClaudeWireFrameKind::SystemHookStarted
            | ClaudeWireFrameKind::SystemHookProgress
            | ClaudeWireFrameKind::SystemHookResponse
            | ClaudeWireFrameKind::SystemNotification
            | ClaudeWireFrameKind::SystemFilesPersisted
            | ClaudeWireFrameKind::SystemToolUseSummary
            | ClaudeWireFrameKind::SystemMemoryRecall
            | ClaudeWireFrameKind::SystemLocalCommandOutput
            | ClaudeWireFrameKind::SystemTaskProgress
            | ClaudeWireFrameKind::SystemBackgroundTasksChanged
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
        let mut readings = session.lock();
        readings.daemon_ended.clear();
        readings.carried_ends.clear();
        readings.now_steers.clear();
        readings.turn = None;
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

    async fn assistant(
        &self,
        session: &ClaudeSessionStream,
        lead: &ClaudeBoundRun,
        text: &str,
        members: &Map<String, Value>,
    ) {
        let error = read_non_empty_string(members, "error");
        self.dependencies
            .dialogs
            .observe_assistant_error(lead.run_id, error)
            .await;
        let Ok(frame) = serde_json::from_str::<ClaudeMessageFrame>(text) else {
            return;
        };
        let (pieces, rows, counts_step) = {
            let mut readings = session.lock();
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
            (pieces, rows, counts_step)
        };
        self.send_pieces(session, &lead.binding_id, pieces).await;
        self.admit_rows(session, rows, "assistant").await;
        if counts_step && let Err(error) = self.dependencies.engine.count_step(lead.run_id).await {
            report_engine_failure(session, "a step", &error);
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
        let rows = {
            let mut readings = session.lock();
            let reading = read_claude_user_rows(
                &frame,
                session.session_id,
                lead.run_id,
                &mut readings.open_tool_calls,
                Instant::now(),
            );
            readings.failed_call_words.extend(reading.failed_results);
            let key = frame
                .uuid()
                .map(|uuid| ClaudeMessageKey::Uuid(uuid.to_owned()));
            reading
                .rows
                .into_iter()
                .map(|row| ClaudeRowDelivery::of_message(&lead.binding_id, row, key.clone()))
                .collect::<Vec<_>>()
        };
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

// Reports the first frame of each kind the reader has no row for, a frame no daemon run holds or a
// `result` of an unlisted subtype; a kind the build sends every turn would otherwise log on every
// frame.
fn record_unmapped(session: &ClaudeSessionStream, frame_kind: &str, disposition_reason: &str) {
    lock(&session.diagnostics).report(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: session.provider_account_id.clone(),
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

// A streamed piece waits for its interval; the session's timer sends it.
fn stream_event(session: &ClaudeSessionStream, lead: &ClaudeBoundRun, text: &str) {
    let run = ClaudeStreamedRun {
        session_id: session.session_id,
        run_id: lead.run_id,
    };
    session
        .lock()
        .streamed_blocks
        .observe(text, run, Instant::now());
}

#[cfg(test)]
mod tests;
