//! A run on Claude Code: its start, the person's controls on it, the requests and choices it
//! raises, the session goal, the context compaction and the command list it reads.

use sidekicks_contracts::provider::driver::commands::ProviderCommandBindingGroup;
use sidekicks_contracts::provider::driver::compaction::AgentRunContextCompactResponse;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;

use super::ClaudeDriver;
use crate::driver::claude::compaction::compact_claude_context;
use crate::driver::claude::session::ultracode::{
    apply_claude_ultracode, requested_claude_ultracode,
};
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::{
    CompactContextParams, ListProviderCommandsParams, RespondToRequestParams, RunOpeningItem,
    StartRunParams,
};
use crate::driver::run_control::{
    AnswerProviderChoiceParams, AnswerProviderChoiceResult, ApplyInterventionParams,
    ApplyInterventionResponse, InterruptRunRequest, OverrideDenialParams, PauseRunParams,
    ResumeRunParams, WithdrawQueuedMessageParams, WithdrawQueuedMessageResult,
};
use crate::driver::session_control::{
    ClearSessionGoalParams, DriverGoalResult, SetSessionGoalParams,
};
use crate::outbound_text::{OutboundText, OutboundTextOrigin};

impl ClaudeDriver {
    /// Waits until the session's process no longer comes back on its own; see the restarts'
    /// settle.
    pub(crate) async fn settle_session(&self, session_id: SessionId) -> Result<(), DriverError> {
        self.parts()?.restarts.settle(session_id).await
    }

    /// Starts one run's turn on the session's live process: a message's words as typed with its
    /// files, or Claude Code's own review of the changes the item names. A process started with
    /// another step bound than the session's is relaunched on its conversation, and an Ultracode
    /// value the process does not hold is applied, both before the turn starts. Fails as the
    /// relaunch or the apply fails, and as the turn's or the review's start fails.
    pub(crate) async fn start_run(&self, params: StartRunParams) -> Result<(), DriverError> {
        let parts = self.parts()?;
        let session_id = params.opening.session_id;
        if let Some(live) = parts.slots().live_session(session_id) {
            let started_bound = parts
                .establishment
                .streams
                .get(session_id)
                .map(|stream| stream.step_bound());
            if started_bound.is_some_and(|started| started != params.step_bound) {
                parts.restarts.relaunch_for_step_bound(&live).await?;
            }
        }
        if let Some(is_on) = requested_claude_ultracode(&params.options)
            && let Some(live) = parts.slots().live_session(session_id)
            && lock(&live.settings).ultracode_requested != Some(is_on)
        {
            let reading = apply_claude_ultracode(&*live.channel, is_on).await?;
            let mut settings = lock(&live.settings);
            settings.ultracode_requested = Some(is_on);
            if reading.is_some() {
                settings.ultracode = reading;
            }
        }
        match &params.opening.item {
            RunOpeningItem::Message {
                content,
                attachments,
                ..
            } => {
                let text = OutboundText {
                    text: content.as_str().to_owned(),
                    origin: OutboundTextOrigin::HumanText,
                };
                parts.run_start.start_run(&params, &text, attachments).await
            }
            RunOpeningItem::Review { target } => {
                parts
                    .session_controls
                    .start_queued_review(&params, *target)
                    .await
            }
        }
    }

    /// Interrupts one run.
    pub(crate) async fn interrupt_run(
        &self,
        params: InterruptRunRequest,
    ) -> Result<(), DriverError> {
        self.parts()?
            .run_controls
            .interrupt_run(params.run_id)
            .await
    }

    /// Delivers a steer or carries out an interrupt on a live run.
    pub(crate) async fn apply_intervention(
        &self,
        params: ApplyInterventionParams,
    ) -> Result<ApplyInterventionResponse, DriverError> {
        self.parts()?.interventions.apply_intervention(params).await
    }

    /// Answers one request the run raised.
    pub(crate) async fn respond_to_request(
        &self,
        params: RespondToRequestParams,
    ) -> Result<(), DriverError> {
        self.parts()?.run_controls.respond_to_request(params).await
    }

    /// `Allow once` on a block Claude Code's own reviewer made.
    pub(crate) async fn override_denial(
        &self,
        params: OverrideDenialParams,
    ) -> Result<(), DriverError> {
        self.parts()?.run_controls.override_denial(&params).await
    }

    /// Stops the run after the step in flight.
    pub(crate) fn pause_run(&self, params: &PauseRunParams) -> Result<(), DriverError> {
        self.parts()?.run_controls.pause_run(params)
    }

    /// Continues a paused or pausing run with its waiting messages.
    pub(crate) async fn resume_run(&self, params: ResumeRunParams) -> Result<(), DriverError> {
        self.parts()?.run_controls.resume_run(params).await
    }

    /// Takes back a steer Claude Code has not read yet.
    pub(crate) async fn withdraw_queued_message(
        &self,
        params: WithdrawQueuedMessageParams,
    ) -> Result<WithdrawQueuedMessageResult, DriverError> {
        self.parts()?
            .run_controls
            .withdraw_queued_message(&params)
            .await
    }

    /// Answers a choice Claude Code holds the run on.
    pub(crate) async fn answer_provider_choice(
        &self,
        params: AnswerProviderChoiceParams,
    ) -> Result<AnswerProviderChoiceResult, DriverError> {
        self.parts()?
            .run_controls
            .answer_provider_choice(&params)
            .await
    }

    /// Compacts the live session's context with Claude Code's own `/compact`.
    pub(crate) async fn compact_context(
        &self,
        params: CompactContextParams,
    ) -> Result<AgentRunContextCompactResponse, DriverError> {
        let parts = self.parts()?;
        let live = parts.run_start.live_session(params.session_id)?;
        Ok(compact_claude_context(
            &live,
            &parts.run_start.handshakes,
            &parts.run_start.routes,
            &self.pending_compactions,
        )
        .await?)
    }

    /// The live session's commands and skills as its process declared them.
    pub(crate) fn list_provider_commands(
        &self,
        params: ListProviderCommandsParams,
    ) -> Result<ProviderCommandBindingGroup, DriverError> {
        let parts = self.parts()?;
        let live = parts.run_start.live_session(params.session_id)?;
        Ok(parts.run_start.handshakes.enumerate_provider_commands(
            params.session_id,
            params.binding,
            params.run_id,
            &live,
        )?)
    }

    /// Sets the session goal on the live process with Claude Code's own `/goal`.
    pub(crate) async fn set_session_goal(
        &self,
        params: SetSessionGoalParams,
    ) -> Result<DriverGoalResult, DriverError> {
        self.send_goal(params.session_id, Some(&params.goal_text))
            .await
    }

    /// Clears the session goal on the live process.
    pub(crate) async fn clear_session_goal(
        &self,
        params: ClearSessionGoalParams,
    ) -> Result<DriverGoalResult, DriverError> {
        self.send_goal(params.session_id, None).await
    }

    // Sends `/goal` with `goal_text`, or its clear with none, on the session's live process.
    async fn send_goal(
        &self,
        session_id: SessionId,
        goal_text: Option<&str>,
    ) -> Result<DriverGoalResult, DriverError> {
        let parts = self.parts()?;
        let live = parts.run_start.live_session(session_id)?;
        parts
            .goals
            .send(
                &live,
                &parts.run_start.handshakes,
                &parts.run_start,
                goal_text,
            )
            .await
    }
}
