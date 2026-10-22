//! What one live process's task does with each arrival, in order: a frame of a process the slot
//! still binds opens a turn Claude Code started by itself, feeds the goal, helper and stream
//! readings, and leaves the running model and a too-long turn's cut behind it; a turn end settles
//! the turn; a request goes through the daemon's hooks or on to the requests; the exit forgets
//! everything the process held.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use tokio::time::Instant;

use super::{ClaudeRoutedFrame, ClaudeSessionArrival, ClaudeSessionArrivalHandler};
use crate::policy::shell_commands::reading_bound::ShellLineReadingBound;
use crate::provider::driver::claude::delivery::dialogs::ClaudeProviderDialogs;
use crate::provider::driver::claude::delivery::requests::{
    ClaudeInboundRequests, ClaudeRequestSession,
};
use crate::provider::driver::claude::delivery::reviewer::ClaudeReviewerCapture;
use crate::provider::driver::claude::delivery::stream::daemon_ends::ClaudeStreamDialogPorts;
use crate::provider::driver::claude::delivery::stream::{
    ClaudeDeliveryStream, ClaudeSessionStream, ClaudeSessionStreams,
};
use crate::provider::driver::claude::goals::ClaudeGoalCommands;
use crate::provider::driver::claude::hooks::callbacks::{
    ClaudeRequestRoute, answer_background_work_check, answer_claude_request, route_claude_request,
};
use crate::provider::driver::claude::hooks::helper_limit::ClaudeHelperLimit;
use crate::provider::driver::claude::hooks::helper_steers::ClaudeHelperSteers;
use crate::provider::driver::claude::hooks::pause::ClaudeRunPauses;
use crate::provider::driver::claude::intervention::{ClaudeForegroundHelpers, ClaudeInterventions};
use crate::provider::driver::claude::run::controls::claude_dialog_session;
use crate::provider::driver::claude::run::prompts::ClaudeSentPrompts;
use crate::provider::driver::claude::run::rewind::ClaudeConversationCuts;
use crate::provider::driver::claude::run::routes::ClaudeRunRoute;
use crate::provider::driver::claude::run::self_started_turns::ClaudeSelfStartedTurns;
use crate::provider::driver::claude::run::settlement::ClaudeTurnSettlement;
use crate::provider::driver::claude::session::controls::ClaudeSessionControls;
use crate::provider::driver::claude::session::permission_level::permission_level_of;
use crate::provider::driver::claude::session::process::ClaudeProcessEnd;
use crate::provider::driver::claude::session::restart::{
    ClaudeSessionRestarts, claude_process_exit_of,
};
use crate::provider::driver::claude::session::state::LiveClaudeSession;
use crate::provider::driver::claude::session::tool_server_calls::ClaudeToolServerCalls;
use crate::provider::driver::claude::session::transport::inbound::ClaudeInboundRequestEvent;
use crate::provider::port::in_process_tool_servers::InProcessToolServers;
use crate::provider::port::registration::PortRegistration;
use crate::provider::process_registry::ProviderProcessRegistry;
use crate::session::run::inbound::{DeliveryBinding, InboundDelivery};
use crate::session::run::state_change::{RunStateChange, RunStateEntry};

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
    /// The helpers running in each session's foreground.
    pub(crate) foreground_helpers: Arc<Mutex<ClaudeForegroundHelpers>>,
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
    /// The in-process tool servers, once registered.
    pub(crate) tool_servers: Arc<PortRegistration<Arc<dyn InProcessToolServers>>>,
    /// Which process runs each session, each removed at its exit.
    pub(crate) processes: Arc<ProviderProcessRegistry>,
    /// The restarts of a process that ended on its own, and the build moves a turn held back.
    pub(crate) restarts: Arc<ClaudeSessionRestarts>,
    /// The session controls, which follow the lead's command lists and reviews.
    pub(crate) controls: Arc<ClaudeSessionControls>,
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
            .map(permission_level_of)
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
        lock(&services.foreground_helpers).observe_frame(session_id, frame_kind, text);
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
        let account = live.admitted_provider_account_id.as_ref();
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
            ClaudeRequestRoute::CheckBackgroundWork {
                request_id,
                command,
            } => {
                let answer = answer_background_work_check(&services.shell_lines, command).await;
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
            change: RunStateChange {
                expected_state: Some(RunState::Pausing),
                ..RunStateChange::new(child_run_id, RunStateEntry::Paused)
            },
            turn_end: None,
            is_daemon_interrupt_end: false,
        };
        start
            .engine
            .deliver(
                self.stream.provider_account_id().cloned(),
                Some("control_request/hook_callback"),
                delivery,
            )
            .await;
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

impl ClaudeSessionArrivalHandler for ClaudeSessionTask {
    fn arrive(&mut self, arrival: ClaudeSessionArrival) -> BoxFuture<'_, ()> {
        async move {
            match arrival {
                ClaudeSessionArrival::Frame(routed) => self.take_frame(*routed).await,
                ClaudeSessionArrival::Terminal => {
                    if self.services.settlement.settle_turn(&self.live).await {
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

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
