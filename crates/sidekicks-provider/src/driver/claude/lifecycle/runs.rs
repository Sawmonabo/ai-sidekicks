//! A run on Claude Code: its start, the person's controls on it, the requests and choices it
//! raises, the session goal, the context compaction, and the command list and the agents the
//! session offers, a live session's as its process declared them and a resting one's read afresh.

use sidekicks_contracts::provider::driver::commands::{
    ProviderCommandBinding, ProviderCommandBindingGroup,
};
use sidekicks_contracts::provider::driver::compaction::AgentRunContextCompactResponse;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;

use super::ClaudeDriver;
use crate::driver::claude::compaction::compact_claude_context;
use crate::driver::claude::handshake_register::compose_resting_command_entries;
use crate::driver::claude::session::ultracode::{
    apply_claude_ultracode, requested_claude_ultracode,
};
use crate::driver::contract::error::DriverError;
use crate::driver::contract::known_names::{KnownNamesParams, ProviderAgent, ProviderKnownNames};
use crate::driver::contract::params_and_results::{
    CompactContextParams, ListProviderCommandsParams, RespondToRequestParams, RunOpeningItem,
    StartRunParams,
};
use crate::driver::contract::plan_verdict::{
    AnswerPlanParams, PlanVerdictAnswer, answer_plan_holding_no_request,
};
use crate::driver::ports::resolve_run_folder;
use crate::driver::run_control::{
    AnswerProviderChoiceParams, AnswerProviderChoiceResult, ApplyInterventionParams,
    ApplyInterventionResponse, InterruptRunRequest, OverrideDenialParams, PauseRunParams,
    ResumeRunOutcome, ResumeRunParams, WithdrawQueuedMessageParams, WithdrawQueuedMessageResult,
};
use crate::driver::session_control::{
    ClearSessionGoalParams, DriverGoalResult, SetSessionGoalParams, SubagentDefinition,
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

    /// Answers the person's verdict on a plan: the request Claude Code holds open for it with the
    /// verdict's answer, `NotHeld` once it was answered or withdrawn, and a plan holding no request
    /// as every provider answers one. Fails `NoLiveSession` for a held request no live process
    /// serves, and as the answer's write or the mode move fails.
    pub(crate) async fn answer_plan(
        &self,
        params: AnswerPlanParams,
    ) -> Result<PlanVerdictAnswer, DriverError> {
        if !params.holds_request {
            return answer_plan_holding_no_request(self, params).await;
        }
        let parts = self.parts()?;
        let requests = &parts.run_controls.requests;
        let Some((request_id, admission)) =
            requests.held_plan_request(params.session_id, params.plan_id)
        else {
            return Ok(PlanVerdictAnswer::NotHeld {});
        };
        let live = parts.run_start.live_session(params.session_id)?;
        requests
            .answer_held_plan(&live, &request_id, admission, params.verdict)
            .await?;
        Ok(PlanVerdictAnswer::Answered {
            follow_up_message: None,
        })
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
    pub(crate) async fn resume_run(
        &self,
        params: ResumeRunParams,
    ) -> Result<ResumeRunOutcome, DriverError> {
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
        Ok(compact_claude_context(&live, &parts.run_start, &self.pending_compactions).await?)
    }

    /// The session's commands, as one group carrying the params' run and binding: a live session's
    /// as its process declared them, once any restart in flight settles; a resting session's from a
    /// process that keeps nothing, started in the folder its runs work in on the binding's account,
    /// which concurrent reads of the session on that account share and none keeps. Fails as the
    /// live list fails, as the folder or the account's environment cannot be read, and as a
    /// session's start fails where the read fails.
    pub(crate) async fn list_provider_commands(
        &self,
        params: ListProviderCommandsParams,
    ) -> Result<ProviderCommandBindingGroup, DriverError> {
        let (group, _agents) = self
            .read_listing(params.session_id, params.binding, params.run_id, &[])
            .await?;
        Ok(group)
    }

    /// Every name the session knows on Claude Code: the entries `list_provider_commands` lists and
    /// the agents the process offers, a live session's as its `initialize` reply declared them and
    /// a resting session's from the one process its command list starts, offered the params'
    /// helpers. Fails as `list_provider_commands` fails.
    pub(crate) async fn list_known_names(
        &self,
        params: KnownNamesParams,
    ) -> Result<ProviderKnownNames, DriverError> {
        let (group, agents) = self
            .read_listing(
                params.session_id,
                params.binding,
                None,
                &params.subagent_definitions,
            )
            .await?;
        Ok(ProviderKnownNames {
            entries: group.entries,
            agents,
        })
    }

    // The session's command group with `run_id` and `binding`, and the agents it offers: a live
    // session's as its process declared them, once any restart in flight settles; a resting
    // session's from one process that keeps nothing, offered `offered` as its agents, which
    // concurrent reads offering the same helpers share and none keeps.
    async fn read_listing(
        &self,
        session_id: SessionId,
        binding: ProviderCommandBinding,
        run_id: Option<RunId>,
        offered: &[SubagentDefinition],
    ) -> Result<(ProviderCommandBindingGroup, Vec<ProviderAgent>), DriverError> {
        let parts = self.parts()?;
        let handshakes = &parts.run_start.handshakes;
        if let Some(live) = parts.slots().live_after_transitions(session_id).await {
            let group =
                handshakes.enumerate_provider_commands(session_id, binding, run_id, &live)?;
            return Ok((group, live.initialize.agents.clone()));
        }
        let provider_account_id = binding.provider_account_id.clone();
        let run_folder = resolve_run_folder(&self.sources.ports.spawn_contexts, session_id).await?;
        let environment = self
            .sources
            .account_environment(&provider_account_id)
            .await?;
        let helpers = offered.to_vec();
        let listing = handshakes
            .join_resting_listing_read(session_id, provider_account_id.clone(), offered, || {
                self.starts.read_session_listing(
                    environment,
                    run_folder,
                    provider_account_id,
                    helpers,
                )
            })
            .await?;
        let group = ProviderCommandBindingGroup {
            run_id,
            entries: compose_resting_command_entries(session_id, &binding, &listing.commands),
            binding,
        };
        Ok((group, listing.agents))
    }

    /// Sets the session goal with Claude Code's own `/goal`, at once even while the lead's run
    /// works, where Claude Code runs it when that turn ends; a session with no live process has
    /// its process opened for it.
    pub(crate) async fn set_session_goal(
        &self,
        params: SetSessionGoalParams,
    ) -> Result<DriverGoalResult, DriverError> {
        self.send_goal(params.session_id, Some(&params.goal_text))
            .await
    }

    /// Clears the session goal, at once even while the lead's run works; a session with no live
    /// process has its process opened for it.
    pub(crate) async fn clear_session_goal(
        &self,
        params: ClearSessionGoalParams,
    ) -> Result<DriverGoalResult, DriverError> {
        self.send_goal(params.session_id, None).await
    }

    // Sends `/goal` with `goal_text`, or its clear with none: as the session's own run, which opens
    // its process where none is live, or onto the lead's run that holds its turn.
    async fn send_goal(
        &self,
        session_id: SessionId,
        goal_text: Option<&str>,
    ) -> Result<DriverGoalResult, DriverError> {
        let parts = self.parts()?;
        let live = parts.run_start.slots.live_session(session_id);
        parts
            .goals
            .send(session_id, live.as_deref(), &parts.run_controls, goal_text)
            .await
    }
}
