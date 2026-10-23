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

use crate::mutex_lock::lock;
use crate::provider::driver::attachments::{compose_message_text, resolve_message_attachments};
use crate::provider::driver::claude::attachments::compose_claude_attachment_blocks;
use crate::provider::driver::claude::delivery::dialogs::{
    ClaudeDialogSession, ClaudeProviderDialogs,
};
use crate::provider::driver::claude::delivery::requests::ClaudeInboundRequests;
use crate::provider::driver::claude::delivery::reviewer::compose_claude_override_sentence;
use crate::provider::driver::claude::delivery::stream::daemon_ends::ClaudeStreamDialogPorts;
use crate::provider::driver::claude::hooks::callbacks::answer_claude_request;
use crate::provider::driver::claude::hooks::helper_steers::ClaudeHelperSteers;
use crate::provider::driver::claude::hooks::pause::ClaudeRunPauses;
use crate::provider::driver::claude::intervention::{
    ClaudeInterventions, background_claude_task, interrupt_claude_turn,
};
use crate::provider::driver::claude::run::routes::ClaudeRunRoute;
use crate::provider::driver::claude::run::start::{
    ClaudeDaemonTurnOpening, ClaudeRunStart, claude_session_unavailable,
};
use crate::provider::driver::claude::session::errors::{
    ClaudeSessionError, ClaudeSessionUnavailableReason,
};
use crate::provider::driver::claude::session::state::LiveClaudeSession;
use crate::provider::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::provider::driver::claude::session::transport::user_message::{
    ClaudeUserContentBlock, ClaudeWriteAttempt, ClaudeWriteDelivery, compose_claude_user_frame,
};
use crate::provider::driver::contract::{DriverError, RespondToRequestParams};
use crate::provider::driver::run_control::{
    AnswerProviderChoiceParams, AnswerProviderChoiceResult, OverrideDenialParams, PauseRunParams,
    ResumeRunParams, WithdrawQueuedMessageParams, WithdrawQueuedMessageResult,
};
use crate::provider::lenient_json::{lenient_object, read_lenient};
use crate::provider::outbound_text::{OutboundText, OutboundTextOrigin};

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
        provider_account_id: live.admitted_provider_account_id.as_ref(),
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
    /// anything is sent, and as a write fails.
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
                    live.admitted_provider_account_id.as_ref(),
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
        .map_err(|error| DriverError::Internal(Box::new(error)))?;
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
        let message_uuid = mint_uuid_v7().to_string();
        let Some(lead) = self.start.routes.lead_run_on(params.session_id) else {
            self.start
                .start_daemon_turn(
                    params.session_id,
                    ClaudeDaemonTurnOpening::Text {
                        text,
                        message_id: message_uuid,
                        attachment_blocks: Vec::new(),
                    },
                )
                .await?;
            return Ok(());
        };
        let live = self.start.live_session(params.session_id)?;
        self.write_message(&live, lead.run_id, &text, message_uuid, Vec::new())
            .await
    }

    /// Moves the foreground work one tool call started (a command, a helper) to the background
    /// and answers whether any moved: `false` when the call matched no foreground work. Fails
    /// `NoLiveSession` and as the request fails, refused where background tasks are turned off.
    #[expect(
        dead_code,
        reason = "the `agent.command.background` handler moves foreground work through it"
    )]
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

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sidekicks_contracts::provider::driver::capabilities::{
        CredentialPolicyRef, ExecutionPosture,
    };

    use crate::provider::driver::claude::hooks::pause::ClaudeHookAnswer;
    use crate::provider::driver::claude::session::scripted::daemon_services::PortCall;
    use crate::provider::driver::claude::session::scripted::{ScriptedSession, settle};
    use crate::provider::driver::run_control::OverrideDenialParams;

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
