//! What one live process's task does with each arrival, in order: a frame of a process the slot
//! still binds opens a turn Claude Code started by itself, feeds the goal, helper and stream
//! readings, and leaves the running model and a too-long turn's cut behind it; a turn end settles
//! the turn; a request goes through the daemon's hooks or on to the requests, an edit's copy or a
//! command's window and its answer spawned off the task, a command's window closed off it at its
//! post-tool hook, and a shell call the background-work hook denies left with no note or window;
//! the exit forgets everything the process held. What no closer reached is closed at its caller's
//! end: the lead's foreground commands at its turn's end, a helper's at the helper's end, and
//! every command of the process, background ones too, at the process's end.

use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_std::scheduler::Scheduler;
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
use crate::driver::claude::goals::endings::ClaudeGoalEndings;
use crate::driver::claude::hooks::callbacks::{
    ClaudeRequestRoute, ClaudeToolCapture, answer_background_work_check, answer_claude_request,
    route_claude_request, route_helper_start, route_helper_wake, route_message_target,
};
use crate::driver::claude::hooks::command_capture::{ClaudeCommandOwner, ClaudeCommandWindows};
use crate::driver::claude::hooks::edit_checkpoint::keep_copy_then_answer;
use crate::driver::claude::hooks::helper_limit::ClaudeHelperLimit;
use crate::driver::claude::hooks::helper_steers::ClaudeHelperSteers;
use crate::driver::claude::hooks::hold_renewal::arm_hold_renewal;
use crate::driver::claude::hooks::pause::{ClaudeHookAnswer, ClaudeRunPauses};
use crate::driver::claude::inbox::listener::ClaudeSessionInboxes;
use crate::driver::claude::intervention::ClaudeInterventions;
use crate::driver::claude::run::controls::claude_dialog_session;
use crate::driver::claude::run::prompts::ClaudeSentPrompts;
use crate::driver::claude::run::rewind::ClaudeConversationCuts;
use crate::driver::claude::run::self_started_turns::ClaudeSelfStartedTurns;
use crate::driver::claude::run::settlement::ClaudeTurnSettlement;
use crate::driver::claude::session::context_reading::ClaudeContextReadings;
use crate::driver::claude::session::controls::ClaudeSessionControls;
use crate::driver::claude::session::idle_sleep::ClaudeIdleSleep;
use crate::driver::claude::session::process::ClaudeProcessEnd;
use crate::driver::claude::session::restart::ClaudeSessionRestarts;
use crate::driver::claude::session::restart::ended_process::claude_process_exit_of;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::tool_server_calls::ClaudeToolServerCalls;
use crate::driver::claude::session::transport::inbound::ClaudeInboundRequestEvent;
use crate::driver::claude::telemetry::ClaudeExports;
use crate::driver::delivery_dispatch::dispatch_delivery;
use crate::port::agent_tree_lookup::AgentTreeLookup;
use crate::port::edit_checkpoint::EditCheckpoint;
use crate::port::in_process_tool_servers::InProcessToolServers;
use crate::pricing::receiver::bearers::TelemetryHolderId;
use crate::process_registry::ProviderProcessRegistry;
use crate::run::delivery::{DeliveryBinding, InboundDelivery};
use crate::run::state_entry::{RunStateEntry, RunStateReport};
use crate::thread_frame_router::SubagentLifecycleEventType;

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
    /// Each session's goal as its endings leave it.
    pub(crate) goal_endings: Arc<ClaudeGoalEndings>,
    /// The runs of turns Claude Code starts by itself, and the session's slots and routes.
    pub(crate) self_started: ClaudeSelfStartedTurns,
    /// Each turn's settlement.
    pub(crate) settlement: ClaudeTurnSettlement,
    /// The cut of a turn too long to fit.
    pub(crate) cuts: Arc<ClaudeConversationCuts>,
    /// The bound on reading shell lines, which the background-work hook reads through.
    pub(crate) shell_lines: Arc<ShellLineReadingBound>,
    /// The program's scheduler, which renews a held helper's call before Claude Code's bound.
    pub(crate) scheduler: Arc<Scheduler>,
    /// Every provider's background work, which the background-work hook refuses.
    pub(crate) background_work: Arc<BackgroundWorkForms>,
    /// The in-process tool servers, once registered.
    pub(crate) tool_servers: Arc<PortRegistration<Arc<dyn InProcessToolServers>>>,
    /// The session's agent tree, once registered, which the message-target check reads a
    /// helper's stored stop from and the helper-wake check whether it has ended.
    pub(crate) agent_tree_lookup: Arc<PortRegistration<Arc<dyn AgentTreeLookup>>>,
    /// The copy kept before each edit a passed pre-tool hook lets run, once registered.
    pub(crate) edit_checkpoint: Arc<PortRegistration<Arc<dyn EditCheckpoint>>>,
    /// The windows of the commands that run with no wrapper, opened at their pre-tool hooks and
    /// closed at their post-tool hooks, with the notes of the shell calls the wrapper runs.
    pub(crate) command_windows: Arc<ClaudeCommandWindows>,
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
    /// Each session process's export, which its streamed usage and lead `result`s feed and its
    /// end decides.
    pub(crate) exports: Arc<ClaudeExports>,
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

    // The holder the process's telemetry token was minted for, its spawn sequence.
    fn export_holder(&self) -> TelemetryHolderId {
        TelemetryHolderId::new(self.live.process_identity.spawn_sequence)
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
        let is_turn_ending = routed.is_turn_ending;
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
            if let Some(servers) = observation
                .handshake
                .as_ref()
                .and_then(|handshake| handshake.mcp_servers.as_ref())
            {
                live.report_mcp_servers(servers, frame_kind);
            }
        }
        // A helper's end, or a counted call answered with no helper started, frees the starts the
        // helper limit held behind it.
        let admitted = lock(&services.helpers).observe_lifecycle(
            &session_id,
            &routed.routed.helper_lifecycle,
            &observation.answered_call_ids,
        );
        for emission in &routed.routed.helper_lifecycle {
            if emission.event_type == SubagentLifecycleEventType::Completed {
                let helper = ClaudeCommandOwner::Helper(emission.subagent_id.clone());
                self.close_remaining_commands(&helper);
            }
        }
        for request_id in admitted {
            answer_claude_request(
                &*live.channel,
                &session_id,
                &live.admitted_provider_account_id(),
                request_id,
                &ClaudeHookAnswer::Pass,
            )
            .await;
        }
        let lead_costs = (observation.subagent_id.is_none())
            .then(|| observation.model_costs.clone())
            .flatten();
        let holder = self.export_holder();
        for reading in &routed.routed.metered {
            services.exports.streamed(holder, &reading.delta);
        }
        let lead = routed.turn_at_read.lead.clone();
        let is_reviewed = self.level() == Some(PermissionLevel::Reviewed);
        let after = services
            .delivery
            .take_frame(&self.stream, routed, is_reviewed)
            .await;
        if is_turn_ending {
            self.close_remaining_commands(&ClaudeCommandOwner::Lead);
        }
        if let Some(running_model) = after.running_model {
            lock(&live.settings).running_model = running_model;
        }
        if after.too_long_run.is_some() {
            services.cuts.cut_too_long_turn(Arc::clone(live));
        }
        if let Some(run) = after.context_read {
            services.context_readings.request_read(live, run);
        }
        // A server still starting or unread is asked after once per turn, off the session's task.
        if is_turn_ending && live.is_any_mcp_server_unsettled() {
            let live = Arc::clone(live);
            tokio::spawn(async move { live.read_mcp_status().await });
        }
        // Claude Code states each model's spend at every lead `result`, a steer's mid-turn one too.
        if let Some(model_costs) = lead_costs {
            services.exports.result_stated(holder);
            let thread_id = &live.provider_session_id;
            let delivery = &services.delivery;
            delivery
                .price_result(&self.stream, model_costs, lead, thread_id)
                .await;
        }
    }

    async fn take_request(&mut self, event: ClaudeInboundRequestEvent) {
        let services = Arc::clone(&self.services);
        let session_id = self.live.session_id;
        let level = self.level();
        let route = route_claude_request(
            event,
            &session_id,
            level,
            &mut lock(&services.pauses),
            &mut lock(&services.helpers),
            &mut lock(&services.helper_steers),
        );
        self.take_route(route, level).await;
    }

    // Answers, holds or hands on one request as its route says; a helper start's, a message
    // target's or a helper wake's check settles into an answer or a hold, taken in its turn. An
    // edit's copy or a command's open, and its answer, are spawned, so the task takes its next
    // arrival meanwhile; the spawned answer ends at its write, failing as any late answer does. A
    // post-tool hook takes its window first, then is answered, and the window's close is spawned.
    async fn take_route(&mut self, route: ClaudeRequestRoute, level: Option<PermissionLevel>) {
        let services = Arc::clone(&self.services);
        let live = &self.live;
        let session_id = live.session_id;
        let account = &live.admitted_provider_account_id();
        match route {
            ClaudeRequestRoute::CheckHelperStart {
                request_id,
                agent_id,
                helper_call,
            } => {
                let posture = lock(&live.settings).execution_posture.clone();
                let settled = route_helper_start(
                    posture.as_ref(),
                    &services.pauses,
                    &session_id,
                    request_id,
                    agent_id,
                )
                .await;
                // Kept before the hook is answered, so the start it allows finds it; a denied call
                // starts no helper.
                let is_denied = matches!(
                    settled,
                    ClaudeRequestRoute::Answer {
                        answer: ClaudeHookAnswer::Deny { .. },
                        ..
                    }
                );
                if let Some(helper_call) = helper_call
                    && !is_denied
                {
                    self.stream.record_helper_call(helper_call);
                }
                Box::pin(self.take_route(settled, level)).await;
            }
            ClaudeRequestRoute::CheckMessageTarget {
                request_id,
                agent_id,
                to,
            } => {
                let settled = route_message_target(
                    services.agent_tree_lookup.port().cloned(),
                    &services.pauses,
                    &session_id,
                    request_id,
                    agent_id,
                    to,
                )
                .await;
                Box::pin(self.take_route(settled, level)).await;
            }
            ClaudeRequestRoute::CheckHelperWake {
                request_id,
                agent_id,
                tool_use_id,
                to,
            } => {
                let settled = route_helper_wake(
                    services.agent_tree_lookup.port().cloned(),
                    &services.pauses,
                    &services.helpers,
                    &session_id,
                    request_id,
                    agent_id.as_deref(),
                    &tool_use_id,
                    &to,
                )
                .await;
                Box::pin(self.take_route(settled, level)).await;
            }
            ClaudeRequestRoute::ForgetHelperCall {
                request_id,
                call_id,
            } => {
                if let Some(call_id) = call_id {
                    self.stream.forget_helper_call(&call_id);
                }
                answer_claude_request(
                    &*live.channel,
                    &session_id,
                    account,
                    request_id,
                    &ClaudeHookAnswer::Pass,
                )
                .await;
            }
            ClaudeRequestRoute::Answer { request_id, answer } => {
                answer_claude_request(&*live.channel, &session_id, account, request_id, &answer)
                    .await;
            }
            ClaudeRequestRoute::CaptureBeforeTool {
                request_id,
                capture: ClaudeToolCapture::Edit(edit),
            } => {
                let edit_checkpoint = services.edit_checkpoint.port().cloned();
                let channel = Arc::clone(&live.channel);
                let account = account.clone();
                tokio::spawn(async move {
                    keep_copy_then_answer(
                        edit_checkpoint.as_ref(),
                        &*channel,
                        &account,
                        request_id,
                        edit,
                    )
                    .await;
                });
            }
            ClaudeRequestRoute::CaptureBeforeTool {
                request_id,
                capture: ClaudeToolCapture::Command(target),
            } => {
                // In before the spawn, so a closer taken next on this task finds it.
                let opening =
                    services
                        .command_windows
                        .begin_open(session_id, live.process_identity, target);
                let command_windows = Arc::clone(&services.command_windows);
                let channel = Arc::clone(&live.channel);
                let account = account.clone();
                tokio::spawn(async move {
                    command_windows
                        .open_then_answer(opening, &*channel, &account, request_id)
                        .await;
                });
            }
            ClaudeRequestRoute::CaptureAfterTool {
                request_id,
                tool_use_id,
                end,
            } => {
                let closing =
                    services
                        .command_windows
                        .take_post_hook(session_id, &tool_use_id, end);
                answer_claude_request(
                    &*live.channel,
                    &session_id,
                    account,
                    request_id,
                    &ClaudeHookAnswer::Pass,
                )
                .await;
                if let Some(closing) = closing {
                    services.command_windows.close(closing);
                }
            }
            ClaudeRequestRoute::Held { helper } => {
                if let Some(helper) = helper {
                    if helper.has_taken_effect {
                        self.report_helper_paused(&helper.agent_id).await;
                    }
                    arm_hold_renewal(
                        &services.scheduler,
                        &services.pauses,
                        &services.self_started.start.slots,
                        &self.stream,
                        session_id,
                        helper.agent_id,
                    );
                }
            }
            ClaudeRequestRoute::CheckBackgroundWork {
                request_id,
                call,
                tool_use_id,
                agent_id,
            } => {
                let answer = answer_background_work_check(
                    &services.shell_lines,
                    &services.background_work,
                    call,
                )
                .await;
                // A pre-tool hook's deny reaches no refusal a closer reads, so the call's note or
                // window is taken here, before Claude Code reads the deny.
                if let (ClaudeHookAnswer::Deny { .. }, Some(tool_use_id)) = (&answer, tool_use_id)
                    && let Some(closing) = services.command_windows.take_refused(
                        session_id,
                        live.process_identity,
                        agent_id,
                        &tool_use_id,
                    )
                {
                    services.command_windows.close(closing);
                }
                answer_claude_request(&*live.channel, &session_id, account, request_id, &answer)
                    .await;
            }
            // A withdrawn helper call starts no helper, whichever of its hooks was withdrawn.
            ClaudeRequestRoute::Withdrawn {
                request_id,
                held_call_id,
            } => {
                if let Some(call_id) = held_call_id {
                    self.stream.forget_helper_call(&call_id);
                }
                self.stream.forget_helper_call_of_request(&request_id);
                let withdrawal = ClaudeInboundRequestEvent::Cancel { request_id };
                Box::pin(self.take_route(ClaudeRequestRoute::Forward(withdrawal), level)).await;
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

    // Closes the windows of this process's commands `owner` names that no closer reached.
    fn close_remaining_commands(&self, owner: &ClaudeCommandOwner) {
        let windows = &self.services.command_windows;
        let live = &self.live;
        for closing in windows.take_remaining(live.session_id, live.process_identity, owner) {
            windows.close(closing);
        }
    }

    // A helper's pause took effect as its next tool call was held, so its child run is paused.
    async fn report_helper_paused(&self, agent_id: &str) {
        let start = &self.services.self_started.start;
        let session_id = self.live.session_id;
        let Some((child_run_id, route)) = start.routes.child_route_for(session_id, agent_id) else {
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
            Some(self.stream.provider_account_id()),
            Some("control_request/hook_callback"),
        );
        dispatch_delivery(&*start.dispatch, origin, delivery).await;
    }

    // The process is gone: its MCP server leg ends, what it held is forgotten, its stream's last
    // rows sent, its held tool-server calls settled, or only traced as the daemon stops, and its
    // slot let go unless a close or rewind already took it. An exit nothing asked for restarts the
    // session; a rewind's fork that took the session keeps what it holds, its held calls included.
    async fn end(&self, end: &ClaudeProcessEnd) {
        let services = &self.services;
        let session_id = self.live.session_id;
        let slots = &services.self_started.start.slots;
        // Every process end ends its leg, a superseded one's included.
        self.live.end_mcp_server_leg();
        let held = services.delivery.end_session(&self.stream).await;
        services.streams.remove(&self.stream);
        services
            .processes
            .remove_exited(session_id, self.live.process_identity);
        // A superseded process's commands end with it; a fork's stay open.
        self.close_remaining_commands(&ClaudeCommandOwner::Process);
        if let Some(socket) = &self.live.messaging_socket {
            ClaudeSessionInboxes::remove_process_socket(session_id, socket).await;
        }
        // Set before the slot is read, so a fork that fails after this finds the exit.
        let exit = self
            .live
            .process_exit
            .get_or_init(|| claude_process_exit_of(end))
            .clone();
        let is_stopped = services.restarts.is_stopped();
        if !is_stopped {
            services.delivery.price_process_end(&self.stream).await;
        }
        services
            .exports
            .process_ended(self.export_holder(), !is_stopped)
            .await;
        let is_superseded = slots
            .live_session(session_id)
            .is_some_and(|held| !Arc::ptr_eq(&held.channel, &self.live.channel));
        if is_superseded {
            return;
        }
        if services.restarts.is_stopped() {
            services
                .delivery
                .trace_stop_endings(&self.stream, held)
                .await;
        } else {
            services.delivery.settle_exit(&self.stream, held).await;
        }
        services.idle_sleep.note_process_ended(session_id);
        services.requests.forget_session(session_id);
        services.settlement.handshakes.forget_handshake(session_id);
        services.dialogs.forget_session(session_id);
        services.reviewer.forget_session(session_id);
        services.goals.forget_session(session_id);
        services.goal_endings.forget_session(session_id);
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
                    self.stream.forget_lead_helper_calls();
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
