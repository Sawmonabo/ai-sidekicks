//! What one live process's task does with each arrival, in order: a frame of a process the slot
//! still binds opens a turn Claude Code started by itself, feeds the goal, helper and stream
//! readings, and leaves the running model and a too-long turn's cut behind it; a turn end settles
//! the turn; a request goes through the daemon's hooks or on to the requests; the exit forgets
//! everything the process held.

use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_std::mutex_lock::lock;
use tokio::time::Instant;

use super::{ClaudeRoutedFrame, ClaudeSessionArrival, ClaudeSessionArrivalHandler};
use crate::background_work::BackgroundWorkForms;
use crate::driver::claude::delivery::claude_delivery_origin;
use crate::driver::claude::delivery::dialogs::ClaudeProviderDialogs;
use crate::driver::claude::delivery::requests::{ClaudeInboundRequests, ClaudeRequestSession};
use crate::driver::claude::delivery::reviewer::ClaudeReviewerCapture;
use crate::driver::claude::delivery::stream::daemon_ends::ClaudeStreamDialogPorts;
use crate::driver::claude::delivery::stream::{
    ClaudeDeliveryStream, ClaudeSessionStream, ClaudeSessionStreams,
};
use crate::driver::claude::goals::ClaudeGoalCommands;
use crate::driver::claude::hooks::callbacks::{
    ClaudeRequestRoute, answer_background_work_check, answer_claude_request, route_claude_request,
};
use crate::driver::claude::hooks::helper_limit::ClaudeHelperLimit;
use crate::driver::claude::hooks::helper_steers::ClaudeHelperSteers;
use crate::driver::claude::hooks::pause::{ClaudeHookAnswer, ClaudeRunPauses};
use crate::driver::claude::inbox::listener::ClaudeSessionInboxes;
use crate::driver::claude::intervention::ClaudeInterventions;
use crate::driver::claude::run::controls::claude_dialog_session;
use crate::driver::claude::run::prompts::ClaudeSentPrompts;
use crate::driver::claude::run::rewind::ClaudeConversationCuts;
use crate::driver::claude::run::routes::ClaudeRunRoute;
use crate::driver::claude::run::self_started_turns::ClaudeSelfStartedTurns;
use crate::driver::claude::run::settlement::ClaudeTurnSettlement;
use crate::driver::claude::session::context_reading::ClaudeContextReadings;
use crate::driver::claude::session::controls::ClaudeSessionControls;
use crate::driver::claude::session::idle_sleep::ClaudeIdleSleep;
use crate::driver::claude::session::process::ClaudeProcessEnd;
use crate::driver::claude::session::restart::{ClaudeSessionRestarts, claude_process_exit_of};
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::tool_server_calls::ClaudeToolServerCalls;
use crate::driver::claude::session::transport::inbound::ClaudeInboundRequestEvent;
use crate::driver::delivery_dispatch::dispatch_delivery;
use crate::port::in_process_tool_servers::InProcessToolServers;
use crate::process_registry::ProviderProcessRegistry;
use crate::run::delivery::{DeliveryBinding, InboundDelivery};
use crate::run::state_entry::{RunStateEntry, RunStateReport};
use sidekicks_std::port_registration::PortRegistration;

/// What every session's task shares.
pub(crate) struct ClaudeSessionTaskServices {
    /// The stream that turns frames into the run engine's deliveries.
    pub(crate) delivery: Arc<ClaudeDeliveryStream>,
    /// Each live session's stream.
    pub(crate) streams: Arc<ClaudeSessionStreams>,
    /// The requests Claude Code holds runs on.
    pub(crate) requests: Arc<ClaudeInboundRequests>,
    /// The choices Claude Code holds a run on.
    pub(crate) dialogs: Arc<ClaudeProviderDialogs<ClaudeStreamDialogPorts>>,
    /// The reviewer's blocks.
    pub(crate) reviewer: Arc<ClaudeReviewerCapture>,
    /// The messages written and not yet reported taken.
    pub(crate) prompts: Arc<Mutex<ClaudeSentPrompts>>,
    /// Every session's pauses.
    pub(crate) pauses: Arc<Mutex<ClaudeRunPauses>>,
    /// Every session's helper limit.
    pub(crate) helpers: Arc<Mutex<ClaudeHelperLimit>>,
    /// The words waiting for each running helper.
    pub(crate) helper_steers: Arc<Mutex<ClaudeHelperSteers>>,
    /// The interventions, which hold the steers a `Send now` keeps back.
    pub(crate) interventions: Arc<ClaudeInterventions>,
    /// The goal commands waiting on each session.
    pub(crate) goals: Arc<ClaudeGoalCommands>,
    /// The runs of turns Claude Code starts by itself, and the session's slots and routes.
    pub(crate) self_started: ClaudeSelfStartedTurns,
    /// Each turn's settlement.
    pub(crate) settlement: ClaudeTurnSettlement,
    /// The cut of a turn too long to fit.
    pub(crate) cuts: Arc<ClaudeConversationCuts>,
    /// The bound on reading shell lines, which the background-work hook reads through.
    pub(crate) shell_lines: Arc<ShellLineReadingBound>,
    /// Every provider's background work, which the background-work hook refuses.
    pub(crate) background_work: Arc<BackgroundWorkForms>,
    /// The in-process tool servers, once registered.
    pub(crate) tool_servers: Arc<PortRegistration<Arc<dyn InProcessToolServers>>>,
    /// Which process runs each session, each removed at its exit.
    pub(crate) processes: Arc<ProviderProcessRegistry>,
    /// The restarts of a process that ended on its own, and the build moves a turn held back.
    pub(crate) restarts: Arc<ClaudeSessionRestarts>,
    /// The session controls, which follow the lead's command lists and reviews.
    pub(crate) controls: Arc<ClaudeSessionControls>,
    /// The wake-ups and jobs each session keeps, read off its frames.
    pub(crate) idle_sleep: Arc<ClaudeIdleSleep>,
    /// Each session's inbox, bound once its first process is up.
    pub(crate) inboxes: Arc<ClaudeSessionInboxes>,
    /// Each session's context reads, asked after the frames that call for one.
    pub(crate) context_readings: Arc<ClaudeContextReadings>,
}

/// One live process's task: its session, its stream and its in-process tool-server calls.
pub(crate) struct ClaudeSessionTask {
    services: Arc<ClaudeSessionTaskServices>,
    live: Arc<LiveClaudeSession>,
    stream: Arc<ClaudeSessionStream>,
    tool_server_calls: ClaudeToolServerCalls,
}

impl ClaudeSessionTask {
    /// The task of `live`'s process, whose frames `stream` reads.
    pub(crate) fn new(
        services: Arc<ClaudeSessionTaskServices>,
        live: Arc<LiveClaudeSession>,
        stream: Arc<ClaudeSessionStream>,
    ) -> Self {
        Self {
            services,
            live,
            stream,
            tool_server_calls: ClaudeToolServerCalls::default(),
        }
    }

    fn level(&self) -> Option<PermissionLevel> {
        lock(&self.live.settings)
            .execution_posture
            .as_ref()
            .map(ExecutionPosture::permission_level)
    }

    async fn take_frame(&self, routed: ClaudeRoutedFrame) {
        let services = &self.services;
        let live = &self.live;
        let session_id = live.session_id;
        // A process the slot no longer binds was retired by a close or a rewind.
        if !services
            .self_started
            .start
            .slots
            .binds_channel(session_id, &live.channel)
        {
            return;
        }
        let observation = &routed.frame.observation;
        let (frame_kind, text) = (observation.frame_kind.as_str(), routed.frame.text.as_str());
        services
            .idle_sleep
            .observe_frame(session_id, frame_kind, text);
        if observation.subagent_id.is_none() {
            services
                .self_started
                .open_for_frame(live, frame_kind, text, routed.turn_at_read.is_held)
                .await;
            services
                .goals
                .observe_lead_frame(session_id, frame_kind, text);
            services
                .controls
                .observe_lead_frame(session_id, frame_kind)
                .await;
        }
        // A helper's end frees the starts the helper limit held behind it.
        let admitted =
            lock(&services.helpers).observe_lifecycle(&session_id, &routed.routed.helper_lifecycle);
        for request_id in admitted {
            answer_claude_request(
                &*live.channel,
                &session_id,
                &live.admitted_provider_account_id,
                request_id,
                &ClaudeHookAnswer::Pass,
            )
            .await;
        }
        let is_reviewed = self.level() == Some(PermissionLevel::Reviewed);
        let after = services
            .delivery
            .take_frame(&self.stream, routed, is_reviewed)
            .await;
        if let Some(running_model) = after.running_model {
            lock(&live.settings).running_model = running_model;
        }
        if after.too_long_run.is_some() {
            services.cuts.cut_too_long_turn(Arc::clone(live));
        }
        if let Some(run) = after.context_read {
            services.context_readings.request_read(live, run);
        }
    }

    async fn take_request(&mut self, event: ClaudeInboundRequestEvent) {
        let services = Arc::clone(&self.services);
        let live = &self.live;
        let session_id = live.session_id;
        let level = self.level();
        let route = route_claude_request(
            event,
            &session_id,
            level,
            &mut lock(&services.pauses),
            &mut lock(&services.helpers),
            &mut lock(&services.helper_steers),
        );
        let account = &live.admitted_provider_account_id;
        match route {
            ClaudeRequestRoute::Answer { request_id, answer } => {
                answer_claude_request(&*live.channel, &session_id, account, request_id, &answer)
                    .await;
            }
            ClaudeRequestRoute::Held { helper_held } => {
                if let Some(agent_id) = helper_held {
                    self.report_helper_paused(&agent_id).await;
                }
            }
            ClaudeRequestRoute::CheckBackgroundWork { request_id, call } => {
                let answer = answer_background_work_check(
                    &services.shell_lines,
                    &services.background_work,
                    call,
                )
                .await;
                answer_claude_request(&*live.channel, &session_id, account, request_id, &answer)
                    .await;
            }
            ClaudeRequestRoute::Forward(event) => {
                let running_model = lock(&live.settings).running_model.clone();
                let session = ClaudeRequestSession {
                    stream: &self.stream,
                    dialog: claude_dialog_session(live, &running_model),
                    channel: Arc::clone(&live.channel),
                    level,
                    tool_server_calls: &self.tool_server_calls,
                    tool_servers: services.tool_servers.port().cloned(),
                };
                services.requests.take_request(&session, event).await;
            }
        }
    }

    // A helper's pause took effect as its next tool call was held, so its child run is paused.
    async fn report_helper_paused(&self, agent_id: &str) {
        let start = &self.services.self_started.start;
        let session_id = self.live.session_id;
        let Some(child_run_id) = start.routes.child_run_for(session_id, agent_id) else {
            return;
        };
        let Some(ClaudeRunRoute::Child(route)) = start.routes.route_of(child_run_id) else {
            return;
        };
        let delivery = InboundDelivery::RunLifecycle {
            binding: DeliveryBinding {
                binding_id: route.binding_id,
                operation: None,
            },
            change: RunStateReport {
                expected_state: Some(RunState::Pausing),
                ..RunStateReport::new(child_run_id, RunStateEntry::Paused)
            },
            turn_end: None,
            is_daemon_interrupt_end: false,
        };
        let origin = claude_delivery_origin(
            Some(self.stream.provider_account_id().clone()),
            Some("control_request/hook_callback"),
        );
        dispatch_delivery(&*start.dispatch, origin, delivery).await;
    }

    // The process is gone: what it held is forgotten, its stream's last rows sent, and its slot
    // let go unless a close or rewind already took it. An exit nothing asked for restarts the
    // session; a rewind's fork that took the session keeps what it holds.
    async fn end(&self, end: &ClaudeProcessEnd) {
        let services = &self.services;
        let session_id = self.live.session_id;
        let slots = &services.self_started.start.slots;
        services.delivery.end_session(&self.stream).await;
        services.streams.remove(&self.stream);
        services
            .processes
            .remove_exited(session_id, self.live.process_identity);
        if let Some(socket) = &self.live.messaging_socket {
            ClaudeSessionInboxes::remove_process_socket(session_id, socket).await;
        }
        // Set before the slot is read, so a fork that fails after this finds the exit.
        let exit = self
            .live
            .process_exit
            .get_or_init(|| claude_process_exit_of(end))
            .clone();
        let is_superseded = slots
            .live_session(session_id)
            .is_some_and(|held| !Arc::ptr_eq(&held.channel, &self.live.channel));
        if is_superseded {
            return;
        }
        services.idle_sleep.note_process_ended(session_id);
        services.requests.forget_session(session_id);
        services.settlement.handshakes.forget_handshake(session_id);
        services.dialogs.forget_session(session_id);
        services.reviewer.forget_session(session_id);
        services.goals.forget_session(session_id);
        services.interventions.forget_session(session_id);
        services.controls.forget_process(session_id).await;
        lock(&services.prompts).forget_session(session_id);
        lock(&services.pauses).forget_session(&session_id);
        lock(&services.helpers).forget_session(&session_id);
        if let Some(live) = slots.release_exited(session_id, &self.live.channel) {
            services.restarts.process_exited(live, exit).await;
        }
    }
}

// The task is dropped once it ends: after it handled its process's `Exit` arrival, or when it is
// aborted or panics, so a close waiting on it never waits on a task that is gone.
impl Drop for ClaudeSessionTask {
    fn drop(&mut self) {
        drop(self.live.task_ended.set(()));
    }
}

impl ClaudeSessionArrivalHandler for ClaudeSessionTask {
    fn arrive(&mut self, arrival: ClaudeSessionArrival) -> BoxFuture<'_, ()> {
        async move {
            match arrival {
                ClaudeSessionArrival::Frame(routed) => self.take_frame(*routed).await,
                ClaudeSessionArrival::Terminal => {
                    let is_settled = self.services.settlement.settle_turn(&self.live).await;

                    if is_settled {
                        self.services.restarts.turn_settled(&self.live);
                    }
                }
                ClaudeSessionArrival::Request(event) => self.take_request(event).await,
                ClaudeSessionArrival::Exit(end) => self.end(&end).await,
                ClaudeSessionArrival::Deliver(delivery) => {
                    self.services
                        .delivery
                        .take_own_delivery(&self.stream, delivery)
                        .await;
                }
            }
        }
        .boxed()
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.stream.next_deadline()
    }

    fn deadline_reached(&mut self, now: Instant) -> BoxFuture<'_, ()> {
        async move { self.services.delivery.deliver_due(&self.stream, now).await }.boxed()
    }
}
