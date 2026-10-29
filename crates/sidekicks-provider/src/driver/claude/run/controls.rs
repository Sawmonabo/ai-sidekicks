//! The controls on a live Claude run: its interrupt, pause and continue by the daemon's own hooks,
//! taking back a message Claude Code has not read yet, answering a request or a choice Claude Code
//! holds the run on, moving a running command or helper to the background, and the person's
//! `Allow once` on a block by Claude Code's reviewer. A choice is settled before an interrupt or a
//! message goes, as Claude Code itself would settle it.

use std::sync::{Arc, Mutex};

use futures::future::try_join_all;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_std::mutex_lock::lock;

use crate::driver::attachments::{compose_message_text, resolve_message_attachments};
use crate::driver::claude::ClaudeDriver;
use crate::driver::claude::attachments::compose_claude_attachment_blocks;
use crate::driver::claude::delivery::commands::{ClaudeCommandChannels, ClaudeHeldCommand};
use crate::driver::claude::delivery::dialogs::{ClaudeDialogSession, ClaudeProviderDialogs};
use crate::driver::claude::delivery::requests::ClaudeInboundRequests;
use crate::driver::claude::delivery::reviewer::compose_claude_override_sentence;
use crate::driver::claude::delivery::stream::daemon_ends::ClaudeStreamDialogPorts;
use crate::driver::claude::hooks::callbacks::answer_claude_request;
use crate::driver::claude::hooks::helper_steers::ClaudeHelperSteers;
use crate::driver::claude::hooks::pause::ClaudeRunPauses;
use crate::driver::claude::intervention::{
    ClaudeInterventions, background_claude_task, interrupt_claude_turn,
    request_claude_background_task,
};
use crate::driver::claude::run::routes::ClaudeRunRoute;
use crate::driver::claude::run::start::{
    ClaudeDaemonTurnOpening, ClaudeRunStart, claude_attachment_failure, claude_session_unavailable,
};
use crate::driver::claude::session::errors::{
    ClaudeSessionError, ClaudeSessionUnavailableReason, record_unheard_claude_failure,
};
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::driver::claude::session::transport::user_message::{
    ClaudeUserContentBlock, ClaudeWriteAttempt, ClaudeWriteDelivery, compose_claude_user_frame,
};
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::RespondToRequestParams;
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::driver::run_control::{
    AnswerProviderChoiceParams, AnswerProviderChoiceResult, HelperTokenLimitParams,
    OverrideDenialParams, PauseRunParams, ResumeRunParams, WithdrawQueuedMessageParams,
    WithdrawQueuedMessageResult,
};
use crate::lenient_json::{lenient_object, read_lenient};
use crate::outbound_text::{OutboundText, OutboundTextOrigin};
use crate::port::running_command_publisher::RunningCommandParams;

#[derive(Default, serde::Deserialize)]
struct CancelAsyncMessageReply {
    #[serde(default, deserialize_with = "read_lenient")]
    cancelled: Option<bool>,
}

lenient_object!(CancelAsyncMessageReply);

/// The session a choice is settled on, as the dialogs read it.
pub(crate) fn claude_dialog_session<'a>(
    live: &'a LiveClaudeSession,
    running_model: &'a str,
) -> ClaudeDialogSession<'a> {
    ClaudeDialogSession {
        session_id: live.session_id,
        channel: &*live.channel,
        running_model,
        offered_models: &live.initialize.models,
        provider_account_id: &live.admitted_provider_account_id,
    }
}

/// What a choice Claude Code holds a run on is settled for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeChoiceSettling {
    /// An interrupt or an undo is about to go.
    Interrupt,
    /// A message the person sent is about to go.
    QueuedMessage,
}

/// Settles the choice `run_id` is held on before an interrupt or a message goes; what the
/// settlement delivers keeps its place among the session's frames. Answers whether that ended the
/// run. Fails as the dialogs' cancel fails.
pub(crate) async fn settle_claude_choice(
    dialogs: &ClaudeProviderDialogs<ClaudeStreamDialogPorts>,
    live: &LiveClaudeSession,
    run_id: RunId,
    settling: ClaudeChoiceSettling,
) -> Result<bool, DriverError> {
    let running_model = lock(&live.settings).running_model.clone();
    let session = claude_dialog_session(live, &running_model);
    match settling {
        ClaudeChoiceSettling::Interrupt => dialogs.settle_for_interrupt(&session, run_id).await,
        ClaudeChoiceSettling::QueuedMessage => {
            dialogs.settle_for_queued_message(&session, run_id).await
        }
    }
}

/// Interrupt, pause, continue, withdraw, background and answers on live Claude runs.
pub(crate) struct ClaudeRunControls {
    /// Starts the session's own runs, and reaches its slots, routes, streams and messages.
    pub(crate) start: ClaudeRunStart,
    /// The choices Claude Code holds a run on.
    pub(crate) dialogs: Arc<ClaudeProviderDialogs<ClaudeStreamDialogPorts>>,
    /// The requests Claude Code holds runs on.
    pub(crate) requests: Arc<ClaudeInboundRequests>,
    /// Every session's pauses, which its hooks answer from.
    pub(crate) pauses: Arc<Mutex<ClaudeRunPauses>>,
    /// The words waiting for each running helper.
    pub(crate) helper_steers: Arc<Mutex<ClaudeHelperSteers>>,
    /// The interventions, which hold the steers a `Send now` keeps back.
    pub(crate) interventions: Arc<ClaudeInterventions>,
    /// Every session's command channels, which find a command run by a process apart from the
    /// session's own.
    pub(crate) command_channels: Arc<ClaudeCommandChannels>,
}

impl ClaudeRunControls {
    /// Stops the run's turn with Claude Code's `interrupt`, its turn end then delivered
    /// `interrupted`; a refusal Claude Code holds the run on is settled `cancelled` instead, which
    /// ends the run refused, and a run apart from the session's process stops with that process.
    /// Fails `NoLiveRun` with no live run and `ControlRequestRefused` when Claude Code refuses.
    pub(crate) async fn interrupt_run(&self, run_id: RunId) -> Result<(), DriverError> {
        if self.start.routes.stop_apart_run(run_id, false) {
            return Ok(());
        }
        let live = self.start.live_session_for_run(run_id)?;
        let stream = self.start.streams.get(live.session_id);
        if settle_claude_choice(
            &self.dialogs,
            &live,
            run_id,
            ClaudeChoiceSettling::Interrupt,
        )
        .await?
        {
            return Ok(());
        }
        interrupt_claude_turn(&live, stream.as_deref(), run_id).await?;
        Ok(())
    }

    /// Pauses the lead run or a helper's child run from its next step on; the pause takes effect
    /// at the run's next hook, which reports it. Fails `NoLiveSession` with no live session.
    pub(crate) fn pause_run(&self, params: &PauseRunParams) -> Result<(), DriverError> {
        self.start.live_session(params.session_id)?;
        let mut pauses = lock(&self.pauses);
        match self.start.routes.route_of(params.run_id) {
            Some(ClaudeRunRoute::Child(route)) => {
                pauses.pause_helper(&params.session_id, &route.agent_id);
            }
            Some(ClaudeRunRoute::Lead { .. } | ClaudeRunRoute::Apart) | None => {
                pauses.pause_lead(&params.session_id, &params.run_id);
            }
        }
        Ok(())
    }

    /// Continues a run with the messages that waited for it. A helper's held calls are answered,
    /// with the messages as the person's words when there are any, each file a line naming its
    /// path; the lead's waiting messages go as user messages with their files, the first starting
    /// its next turn when its last one ended on the pause. Fails `NoLiveSession`,
    /// `SessionTurnInFlight` while another turn holds the session, as the files' read fails before
    /// anything is sent, with the run's refusal for a lead's picture Claude Code refuses, and as a
    /// write fails.
    pub(crate) async fn resume_run(&self, params: ResumeRunParams) -> Result<(), DriverError> {
        let live = self.start.live_session(params.session_id)?;
        let session_id = params.session_id;
        let attachments = &*self.start.attachments;
        if let Some(ClaudeRunRoute::Child(route)) = self.start.routes.route_of(params.run_id) {
            // A failed file lookup still continues the helper, with no words, before it surfaces,
            // so its held calls never wait on a continue that already failed.
            let words = try_join_all(params.messages.iter().map(|message| async {
                let resolved =
                    resolve_message_attachments(attachments, &session_id, &message.attachments)
                        .await?;
                Ok::<_, Box<dyn std::error::Error + Send + Sync>>(compose_message_text(
                    message.content.as_str(),
                    &resolved,
                ))
            }))
            .await;
            let steer = match &words {
                Ok(words) if !words.is_empty() => Some(words.join("\n\n")),
                Ok(_) | Err(_) => None,
            };
            let released =
                lock(&self.pauses).resume_helper(&session_id, &route.agent_id, steer.as_deref());
            for callback in released {
                answer_claude_request(
                    &*live.channel,
                    &session_id,
                    &live.admitted_provider_account_id,
                    callback.request_id,
                    &callback.answer,
                )
                .await;
            }
            words.map_err(DriverError::Internal)?;
            return Ok(());
        }
        let blocks = try_join_all(params.messages.iter().map(|message| {
            compose_claude_attachment_blocks(attachments, &session_id, &message.attachments)
        }))
        .await
        .map_err(|error| claude_attachment_failure(&live, error))?;
        // The run holds the session's turn again, so the turn its messages start ends on its
        // route; while another run or a command holds it, the messages would land in that turn.
        let is_lead = self
            .start
            .routes
            .lead_run_on(session_id)
            .is_some_and(|lead| lead.run_id == params.run_id);
        if !params.messages.is_empty() && !is_lead {
            self.start
                .routes
                .hold_turn_again(params.run_id)
                .map_err(|_refused| {
                    DriverError::from(claude_session_unavailable(
                        ClaudeSessionUnavailableReason::SessionTurnInFlight,
                        session_id,
                        Some(params.run_id),
                    ))
                })?;
        }
        lock(&self.pauses).resume_lead(&session_id);
        for (message, attachment_blocks) in params.messages.into_iter().zip(blocks) {
            self.write_message(
                &live,
                params.run_id,
                &OutboundText {
                    text: message.content.into_string(),
                    origin: OutboundTextOrigin::HumanText,
                },
                message.id.to_string(),
                attachment_blocks,
            )
            .await?;
        }
        Ok(())
    }

    /// Takes back a steer: one held behind a `Send now` is withdrawn with nothing sent; one
    /// written is `Withdrawn` before Claude Code read it, a run that went on to its next turn for
    /// that message alone then ending, and `AlreadyDelivered` once it had. Fails `NoLiveSession`
    /// and as the request fails.
    pub(crate) async fn withdraw_queued_message(
        &self,
        params: &WithdrawQueuedMessageParams,
    ) -> Result<WithdrawQueuedMessageResult, DriverError> {
        if self
            .interventions
            .withdraw_held(params.session_id, &params.client_idempotency_key)
        {
            return Ok(WithdrawQueuedMessageResult::Withdrawn {});
        }
        let live = self.start.live_session(params.session_id)?;
        let message_uuid = params.client_idempotency_key.to_string();
        let answer = live
            .channel
            .send_control_request(ClaudeControlRequest::CancelAsyncMessage {
                message_uuid: message_uuid.clone(),
            })
            .await?;
        let reply: CancelAsyncMessageReply = answer
            .response
            .and_then(|response| serde_json::from_str(response.get()).ok())
            .unwrap_or_default();
        if reply.cancelled != Some(true) {
            return Ok(WithdrawQueuedMessageResult::AlreadyDelivered {});
        }
        let steered_run_id = lock(&self.start.prompts).withdraw(params.session_id, &message_uuid);
        if let (Some(run_id), Some(stream)) =
            (steered_run_id, self.start.streams.get(params.session_id))
        {
            stream.release_carried_turn(run_id);
        }
        Ok(WithdrawQueuedMessageResult::Withdrawn {})
    }

    /// Answers one request Claude Code holds a run on, the lead's or a helper's, under its own id.
    /// Fails `NoLiveRun` and as the requests' answer fails.
    pub(crate) async fn respond_to_request(
        &self,
        params: RespondToRequestParams,
    ) -> Result<(), DriverError> {
        let live = self.start.live_session_for_run(params.run_id)?;
        self.requests
            .respond(&live, &params.request_id, params.response)
            .await?;
        Ok(())
    }

    /// Sends the person's answer to a choice a run is held on. Fails `NoLiveSession` and as the
    /// dialogs' answer fails.
    pub(crate) async fn answer_provider_choice(
        &self,
        params: &AnswerProviderChoiceParams,
    ) -> Result<AnswerProviderChoiceResult, DriverError> {
        let live = self.start.live_session(params.session_id)?;
        let running_model = lock(&live.settings).running_model.clone();
        self.dialogs
            .answer(&claude_dialog_session(&live, &running_model), params)
            .await
    }

    /// Sends the sentence Claude Code's own `Allow once` sends, which retries nothing itself, to
    /// the run the block was made in: a helper reads it at its next tool call or as it finishes;
    /// the lead's session takes it into its running turn, or as its own run while no run holds its
    /// turn. Fails for a denial the daemon never kept in Claude Code's shape, `NoLiveRun` for a run
    /// apart from the session's process, and as the write or the run's start fails.
    pub(crate) async fn override_denial(
        &self,
        params: &OverrideDenialParams,
    ) -> Result<(), DriverError> {
        let sentence =
            compose_claude_override_sentence(&params.provider_denial).ok_or_else(|| {
                DriverError::Internal("the denial is not in Claude Code's shape".into())
            })?;
        match self.start.routes.route_of(params.run_id) {
            Some(ClaudeRunRoute::Child(route)) => {
                lock(&self.helper_steers).push(route.session_id, &route.agent_id, sentence);
                return Ok(());
            }
            Some(ClaudeRunRoute::Apart) => {
                return Err(ClaudeSessionError::Unavailable {
                    reason: ClaudeSessionUnavailableReason::NoLiveRun,
                    detail: None,
                    session_id: Some(params.session_id),
                    run_id: Some(params.run_id),
                }
                .into());
            }
            Some(ClaudeRunRoute::Lead { .. }) | None => {}
        }
        // The person's `Allow once` writes it, so it carries the human origin.
        let text = OutboundText {
            text: sentence,
            origin: OutboundTextOrigin::HumanText,
        };
        self.write_to_lead(params.session_id, text).await
    }

    /// Stops a running command with Claude Code's `stop_task` to the process that runs it, the
    /// session's own or one apart from it such as a staged review's, answering once Claude Code
    /// acknowledged it; the command's row ends on the task's own notification, and the run that
    /// started it is then told the person stopped it. Fails `NoLiveSession` and as Claude Code
    /// refuses or the request fails.
    pub(crate) async fn stop_command(
        &self,
        params: &RunningCommandParams,
    ) -> Result<(), DriverError> {
        let task_id = params.command_id.as_str();
        let stop = || ClaudeControlRequest::StopTask {
            task_id: task_id.to_owned(),
        };
        if let Some(apart) = self
            .command_channels
            .apart_command(params.session_id, task_id)
        {
            apart.process.send_control_request(stop()).await?;
            self.tell_command_stopped(params.session_id, &apart.command, Some(&*apart.process))
                .await;
            return Ok(());
        }
        let live = self.start.live_session(params.session_id)?;
        // Read before the stop, whose notification lets the command go.
        let held = self
            .start
            .streams
            .get(params.session_id)
            .and_then(|stream| stream.held_command(task_id));
        live.channel.send_control_request(stop()).await?;
        if let Some(held) = held {
            self.tell_command_stopped(params.session_id, &held, None)
                .await;
        }
        Ok(())
    }

    /// Moves a running command to the background through the tool call that started it, on the
    /// process that runs it, and answers whether it moved: `false` for a command whose call
    /// Claude Code never named. Fails as `background_task` fails.
    pub(crate) async fn move_command_to_background(
        &self,
        params: &RunningCommandParams,
    ) -> Result<bool, DriverError> {
        let task_id = params.command_id.as_str();
        if let Some(apart) = self
            .command_channels
            .apart_command(params.session_id, task_id)
        {
            let Some(tool_use_id) = apart.command.tool_use_id else {
                return Ok(false);
            };
            return Ok(request_claude_background_task(&*apart.process, &tool_use_id).await?);
        }
        let tool_use_id = self
            .start
            .streams
            .get(params.session_id)
            .and_then(|stream| stream.held_command(task_id))
            .and_then(|held| held.tool_use_id);
        let Some(tool_use_id) = tool_use_id else {
            return Ok(false);
        };
        Ok(self
            .background_task(params.session_id, &tool_use_id)
            .await?)
    }

    // Tells the run that started the stopped `command` that the person stopped it, in the daemon's
    // own words: a helper at its next tool call, a process apart from the session's own (`apart`)
    // in its running turn, and the lead in its running turn or as its own run while no run holds
    // its turn. The stop stands whether or not the words reach it, so a failed write is recorded.
    async fn tell_command_stopped(
        &self,
        session_id: SessionId,
        command: &ClaudeHeldCommand,
        apart: Option<&dyn ClaudeProcessChannel>,
    ) {
        let named = command
            .start
            .line
            .clone()
            .unwrap_or_else(|| command.start.name.as_str().to_owned());
        let sentence = format!("The user stopped `{named}`.");
        if let Some(ClaudeRunRoute::Child(route)) = self.start.routes.route_of(command.start.run_id)
        {
            lock(&self.helper_steers).push(route.session_id, &route.agent_id, sentence);
            return;
        }
        let text = OutboundText {
            text: sentence,
            origin: OutboundTextOrigin::SystemNarration,
        };
        let told = match apart {
            Some(process) => {
                let frame =
                    compose_claude_user_frame(&text, mint_uuid_v7().to_string(), Vec::new());
                match process.write_user_frame(frame).await {
                    ClaudeWriteAttempt::Written => Ok(()),
                    ClaudeWriteAttempt::Failed { cause, .. } => {
                        Err(ClaudeSessionError::InputUnwritable(cause).into())
                    }
                }
            }
            None => self.write_to_lead(session_id, text).await,
        };
        if let Err(error) = told {
            record_unheard_claude_failure(
                DriverDiagnosticKind::ProcessReportFailed,
                session_id,
                "the stopped command's message",
                &error,
            );
        }
    }

    // Writes `text` into the lead's running turn, or starts the session's own run with it while
    // no run holds its turn. Fails `NoLiveSession` and as the write or the run's start fails.
    async fn write_to_lead(
        &self,
        session_id: SessionId,
        text: OutboundText,
    ) -> Result<(), DriverError> {
        let message_uuid = mint_uuid_v7().to_string();
        let Some(lead) = self.start.routes.lead_run_on(session_id) else {
            self.start
                .start_daemon_turn(
                    session_id,
                    ClaudeDaemonTurnOpening::Text {
                        text,
                        message_id: message_uuid,
                        attachment_blocks: Vec::new(),
                    },
                )
                .await?;
            return Ok(());
        };
        let live = self.start.live_session(session_id)?;
        self.write_message(&live, lead.run_id, &text, message_uuid, Vec::new())
            .await
    }

    /// Stops a helper at its token limit: its next tool use, and each after, is denied with the
    /// reason it reads, so it reports and finishes while its lead goes on. Fails `NoLiveSession`.
    pub(crate) fn stop_helper_at_token_limit(
        &self,
        params: &HelperTokenLimitParams,
    ) -> Result<(), DriverError> {
        self.start.live_session(params.session_id)?;
        lock(&self.pauses)
            .stop_helper_at_token_limit(params.session_id, params.subagent_id.as_str());
        Ok(())
    }

    /// Moves the foreground work one tool call started (a command, a helper) to the background
    /// and answers whether any moved: `false` when the call matched no foreground work. Fails
    /// `NoLiveSession` and as the request fails, refused where background tasks are turned off.
    pub(crate) async fn background_task(
        &self,
        session_id: SessionId,
        tool_use_id: &str,
    ) -> Result<bool, ClaudeSessionError> {
        let live = self.start.live_session(session_id)?;
        background_claude_task(&live, tool_use_id).await
    }

    // Writes one message for `run_id`, recorded before the write since Claude Code may report it
    // taken first; a write that never left is dropped again.
    async fn write_message(
        &self,
        live: &LiveClaudeSession,
        run_id: RunId,
        text: &OutboundText,
        message_uuid: String,
        attachment_blocks: Vec<ClaudeUserContentBlock>,
    ) -> Result<(), DriverError> {
        let session_id = live.session_id;
        lock(&self.start.prompts).record_written(session_id, run_id, &message_uuid, false);
        let frame = compose_claude_user_frame(text, message_uuid.clone(), attachment_blocks);
        match live.channel.write_user_frame(frame).await {
            ClaudeWriteAttempt::Written => Ok(()),
            ClaudeWriteAttempt::Failed {
                delivery: ClaudeWriteDelivery::Unsent,
                cause,
            } => {
                lock(&self.start.prompts).record_dropped(session_id, &message_uuid);
                Err(ClaudeSessionError::InputUnwritable(cause).into())
            }
            ClaudeWriteAttempt::Failed {
                delivery: ClaudeWriteDelivery::Indeterminate,
                cause,
            } => Err(DriverError::Internal(Box::new(cause))),
        }
    }
}

impl ClaudeDriver {
    /// Stops a running command once Claude Code acknowledges its `stop_task`. Fails
    /// `NoLiveSession` and as the request fails.
    pub(crate) async fn stop_command(
        &self,
        params: RunningCommandParams,
    ) -> Result<(), DriverError> {
        self.live_run_controls(params.session_id)?
            .stop_command(&params)
            .await
    }

    /// Moves a running command to the background, answering whether it moved. Fails
    /// `NoLiveSession` and as the request fails.
    pub(crate) async fn move_command_to_background(
        &self,
        params: RunningCommandParams,
    ) -> Result<bool, DriverError> {
        self.live_run_controls(params.session_id)?
            .move_command_to_background(&params)
            .await
    }

    /// Stops a helper at its token limit by denying its tool uses from the next on. Fails
    /// `NoLiveSession`.
    pub(crate) fn stop_helper_at_token_limit(
        &self,
        params: &HelperTokenLimitParams,
    ) -> Result<(), DriverError> {
        self.live_run_controls(params.session_id)?
            .stop_helper_at_token_limit(params)
    }

    // The run controls of a session that may be live; none are composed before any session is.
    fn live_run_controls(&self, session_id: SessionId) -> Result<&ClaudeRunControls, DriverError> {
        self.composed_parts()
            .map(|parts| &parts.run_controls)
            .ok_or_else(|| {
                claude_session_unavailable(
                    ClaudeSessionUnavailableReason::NoLiveSession,
                    session_id,
                    None,
                )
                .into()
            })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sidekicks_contracts::command::CommandId;
    use sidekicks_contracts::provider::driver::capabilities::{
        CredentialPolicyRef, ExecutionPosture,
    };
    use sidekicks_contracts::run::subagent::SubagentId;

    use crate::driver::claude::hooks::pause::ClaudeHookAnswer;
    use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedWrite};
    use crate::driver::claude::session::scripted::daemon_services::PortCall;
    use crate::driver::claude::session::scripted::{
        SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, settle,
    };
    use crate::driver::run_control::{
        HELPER_TOKEN_LIMIT_REASON, HelperTokenLimitParams, OverrideDenialParams,
    };
    use crate::port::running_command_publisher::RunningCommandParams;

    fn running_command(session: &ScriptedSession, command_id: &str) -> RunningCommandParams {
        RunningCommandParams {
            session_id: session.session_id,
            binding_id: binding_id("lead"),
            command_id: CommandId::new(command_id.to_owned()).expect("a command id"),
        }
    }

    // Killed by a stop that answers before Claude Code acknowledged it, so a refused stop reads
    // done, by a stop naming anything but the command's task, and by an acknowledged stop the
    // lead's turn is not told of in the daemon's words, or a refused one it is.
    #[tokio::test(start_paused = true)]
    async fn a_stop_answers_only_once_claude_code_acknowledged_it() {
        let session = ScriptedSession::new().await;
        session.hold_lead_turn("lead");
        session.frame(&json!({
            "type": "assistant",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "message": {
                "id": "message-1",
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "call-1", "name": "Bash",
                     "input": {"command": "sleep 100"}},
                ],
            },
        }));
        session.frame(&json!({
            "type": "system",
            "subtype": "task_started",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "task_id": "task-1",
            "task_type": "local_bash",
            "tool_use_id": "call-1",
        }));
        settle().await;
        let controls = &session.parts.run_controls;
        session.channel.answer("stop_task", ScriptedAnswer::Refused);

        let refused = controls
            .stop_command(&running_command(&session, "task-1"))
            .await;
        let stopped = controls
            .stop_command(&running_command(&session, "task-1"))
            .await;

        assert!(refused.is_err(), "a refused stop fails");
        assert!(stopped.is_ok(), "an acknowledged stop answers");
        let requests = session.channel.control_requests();
        assert_eq!(requests.len(), 2);
        assert!(
            requests
                .iter()
                .all(|request| request["subtype"] == "stop_task" && request["task_id"] == "task-1")
        );
        let told = session.channel.user_frames();
        assert_eq!(told.len(), 1);
        assert!(
            told[0]
                .to_string()
                .contains("The user stopped `sleep 100`.")
        );
        assert_eq!(told[0]["client_composed"], json!(true));
    }

    // Killed by moving a command to the background by its task id instead of the tool call that
    // started it, which Claude Code's request matches, and by asking for a command it never named.
    #[tokio::test(start_paused = true)]
    async fn a_command_moves_to_the_background_through_the_call_that_started_it() {
        let session = ScriptedSession::new().await;
        session.hold_lead_turn("lead");
        session.frame(&json!({
            "type": "assistant",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "message": {
                "id": "message-1",
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "call-b", "name": "Bash",
                     "input": {"command": "sleep 100"}},
                ],
            },
        }));
        session.frame(&json!({
            "type": "system",
            "subtype": "task_started",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "task_id": "task-b",
            "task_type": "local_bash",
            "tool_use_id": "call-b",
            "description": "sleep 100",
        }));
        settle().await;
        let controls = &session.parts.run_controls;

        let unnamed = controls
            .move_command_to_background(&running_command(&session, "task-unnamed"))
            .await
            .expect("an unnamed command is answered");
        let moved = controls
            .move_command_to_background(&running_command(&session, "task-b"))
            .await
            .expect("the request is answered");

        assert!(!unnamed, "a command Claude Code never named does not move");
        assert!(moved, "the named command moves");
        let requests = session.channel.control_requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["subtype"], "background_tasks");
        assert_eq!(requests[0]["tool_use_id"], "call-b");
    }

    // Killed by a token limit that leaves the helper's next tool use allowed, by one that stops
    // the lead too, and by a denial that does not carry the reason the helper reads.
    #[tokio::test(start_paused = true)]
    async fn a_helper_at_its_token_limit_is_denied_its_next_tool_use() {
        let session = ScriptedSession::new().await;
        let lead = session.hold_lead_turn("lead");
        let helper = session.bind_helper(lead, "helper");
        session
            .parts
            .run_controls
            .stop_helper_at_token_limit(&HelperTokenLimitParams {
                session_id: session.session_id,
                run_id: helper,
                subagent_id: SubagentId::new("helper".to_owned()).expect("a subagent id"),
            })
            .expect("the session is live");
        let before_tool = |agent_id: Option<&str>| {
            let mut input = json!({
                "hook_event_name": "PreToolUse",
                "tool_name": "Bash",
                "tool_use_id": "call-1",
                "tool_input": {"command": "ls"},
            });
            if let (Some(input), Some(agent_id)) = (input.as_object_mut(), agent_id) {
                input.insert("agent_id".to_owned(), json!(agent_id));
            }
            json!({
                "subtype": "hook_callback",
                "callback_id": "sidekicks-pause-before-tool",
                "input": input,
            })
        };

        session.request("helper-tool", &before_tool(Some("helper")));
        session.request("lead-tool", &before_tool(None));
        settle().await;

        let answers: Vec<_> = session
            .channel
            .writes()
            .into_iter()
            .filter_map(|write| match write {
                ScriptedWrite::Answer { request_id, answer } => Some((request_id, answer)),
                ScriptedWrite::Control(_) | ScriptedWrite::User(_) | ScriptedWrite::Terminate => {
                    None
                }
            })
            .collect();
        let answer_to = |request_id: &str| {
            answers
                .iter()
                .find(|(answered, _)| answered == request_id)
                .map(|(_, answer)| answer.to_string())
                .expect("the hook is answered")
        };
        let helper_answer = answer_to("helper-tool");
        assert!(helper_answer.contains(r#""permissionDecision":"deny""#));
        assert!(helper_answer.contains(HELPER_TOKEN_LIMIT_REASON));
        assert!(!answer_to("lead-tool").contains("deny"));
    }

    // Killed by attributing a helper's block to the lead run, and by writing the `Allow once` for
    // it into the lead's turn instead of handing it to the helper; and by writing the lead's
    // `Allow once` without the human origin, or marked as the daemon's own words.
    #[tokio::test(start_paused = true)]
    async fn a_helpers_block_and_its_allow_once_stay_the_helpers() {
        let session = ScriptedSession::new().await;
        session
            .live
            .settings
            .lock()
            .expect("the settings' lock holds")
            .execution_posture = Some(ExecutionPosture::Reviewed {
            credential_policy_ref: CredentialPolicyRef::new("policy".to_owned())
                .expect("a test policy reference fits"),
            writable_roots: Vec::new(),
        });
        let lead = session.hold_lead_turn("lead");
        let helper = session.bind_helper(lead, "helper");
        let tool_input = json!({"command": "rm -rf build"});
        session.request(
            "denied",
            &json!({
                "subtype": "hook_callback",
                "callback_id": "sidekicks-permission-denied",
                "input": {
                    "hook_event_name": "PermissionDenied",
                    "agent_id": "helper",
                    "tool_name": "Bash",
                    "tool_use_id": "call-1",
                    "tool_input": tool_input,
                    "reason": "it deletes the build",
                },
            }),
        );
        settle().await;
        assert_eq!(session.ports.calls(), [PortCall::Denial(helper)]);

        session
            .parts
            .run_controls
            .override_denial(&OverrideDenialParams {
                session_id: session.session_id,
                run_id: helper,
                provider_denial: serde_json::value::to_raw_value(&json!({
                    "tool_name": "Bash",
                    "tool_input": tool_input,
                    "tool_use_id": "call-1",
                }))
                .expect("a denial serializes"),
            })
            .await
            .expect("the override reaches the helper");

        assert_eq!(
            session.channel.user_frames(),
            Vec::<serde_json::Value>::new()
        );
        let answer = session
            .helper_steers
            .lock()
            .expect("the helper steers' lock holds")
            .answer_after_tool(session.session_id, Some("helper"));
        assert!(matches!(
            answer,
            ClaudeHookAnswer::AddContext { context, .. }
                if context.contains("Permission granted for: Bash(rm -rf build)")
        ));

        session
            .parts
            .run_controls
            .override_denial(&OverrideDenialParams {
                session_id: session.session_id,
                run_id: lead,
                provider_denial: serde_json::value::to_raw_value(&json!({
                    "tool_name": "Bash",
                    "tool_input": tool_input,
                    "tool_use_id": "call-2",
                }))
                .expect("a denial serializes"),
            })
            .await
            .expect("the override reaches the lead's turn");

        let frames = session.channel.user_frames();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["origin"], json!({"kind": "human"}));
        assert_eq!(frames[0].get("client_composed"), None);
    }
}
