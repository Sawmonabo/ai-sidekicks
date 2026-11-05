//! A Codex run's calls: its session's settle, its start, interrupt, steer, pause and continue, a
//! retry of its held turn on a faster model, the answer to an ask it raised, `Allow once` on a
//! block of Codex's own reviewer, the skills a person picked for its message, and the source its
//! session's command list is read from.

use std::path::Path;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::queue::QueuedSkillPick;
use sidekicks_contracts::session::id::SessionId;

use super::CodexDriver;
use crate::driver::codex::commands::CodexCommandSource;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::{
    RespondToRequestParams, SessionProcessState, StartRunParams,
};
use crate::driver::error_causes::session_process_unavailable;
use crate::driver::ports::resolve_run_folder;
use crate::driver::run_control::{
    ApplyInterventionParams, ApplyInterventionResponse, FasterModelRetryOutcome,
    FasterModelRetryParams, InterruptRunRequest, OverrideDenialParams, PauseRunParams, PickedSkill,
    ResumeRunOutcome, ResumeRunParams,
};

impl CodexDriver {
    /// Waits until the session's conversation settled: a service on its way back is waited for,
    /// then the resume or establishment in flight on the session. Answers once the session reads
    /// live; fails `provider.unavailable` once it reads down.
    pub(crate) async fn settle_session(&self, session_id: SessionId) -> Result<(), DriverError> {
        loop {
            if let Some(service) = self.views.service(session_id) {
                service.when_back().await;
            }
            self.slots.settle(session_id).await;
            match self.session_process_state(session_id) {
                SessionProcessState::Live => return Ok(()),
                SessionProcessState::Down => {
                    return Err(DriverError::from(session_process_unavailable(session_id)));
                }
                // An establishment claimed, or a service gone back, since the waits answered.
                SessionProcessState::Restarting => {}
            }
        }
    }

    /// Starts one run's turn on its session's conversation; see the run start.
    pub(crate) async fn start_run(&self, params: StartRunParams) -> Result<(), DriverError> {
        Ok(self.parts()?.run_start.start_run(params).await?)
    }

    /// Interrupts the run's live turn; a run with no turn in flight answers at once.
    pub(crate) async fn interrupt_run(
        &self,
        params: InterruptRunRequest,
    ) -> Result<(), DriverError> {
        self.parts()?
            .run_control
            .interrupt_run(params.run_id)
            .await?;
        Ok(())
    }

    /// Delivers a steer or carries out an interrupt on a live run.
    pub(crate) async fn apply_intervention(
        &self,
        params: ApplyInterventionParams,
    ) -> Result<ApplyInterventionResponse, DriverError> {
        self.parts()?.interventions.apply_intervention(params).await
    }

    /// Pauses the run at its live turn's next step end.
    pub(crate) async fn pause_run(&self, params: PauseRunParams) -> Result<(), DriverError> {
        Ok(self.parts()?.run_control.pause_run(params).await?)
    }

    /// Continues a paused or pausing run with the messages that waited for it.
    pub(crate) async fn resume_run(
        &self,
        params: ResumeRunParams,
    ) -> Result<ResumeRunOutcome, DriverError> {
        self.parts()?.run_control.resume_run(params).await
    }

    /// Stops the held turn and sends its message again on the faster model.
    pub(crate) async fn retry_turn_on_faster_model(
        &self,
        params: FasterModelRetryParams,
    ) -> Result<FasterModelRetryOutcome, DriverError> {
        Ok(self.parts()?.retries.retry(params).await?)
    }

    /// Answers one ask Codex raised on a run, on the service its session's conversation is loaded
    /// on. Fails with `CodexError::Transport` for a run or session no longer live.
    pub(crate) async fn respond_to_request(
        &self,
        params: RespondToRequestParams,
    ) -> Result<(), DriverError> {
        let parts = self.parts()?;
        let not_live = || CodexError::Transport {
            detail: format!("No live Codex run for \"{}\".", params.run_id),
            cause: None,
        };
        let session_id = parts
            .run_routes
            .session_id_for(params.run_id)
            .ok_or_else(not_live)?;
        let service = parts.views.service(session_id).ok_or_else(not_live)?;
        let inbound = parts.slots.require_live(session_id)?;
        parts
            .hand_off
            .answer(&service, &inbound, session_id, params)
            .await
    }

    /// `Allow once` on a block of Codex's own reviewer.
    pub(crate) async fn override_denial(
        &self,
        params: OverrideDenialParams,
    ) -> Result<(), DriverError> {
        Ok(self.parts()?.controls.override_denial(params).await?)
    }

    /// What `session_id`'s command list is read from: the live session's own source, else the
    /// service of `provider_account_id`, the account the session's runs are admitted against,
    /// started if it is not, over the folder the session's runs work in, with no run. Fails as the
    /// folder cannot be resolved and as the service cannot start.
    pub(super) async fn resolve_command_source(
        &self,
        session_id: SessionId,
        provider_account_id: ProviderAccountId,
    ) -> Result<CodexCommandSource, DriverError> {
        if let Some(source) = self.views.command_source(session_id) {
            return Ok(source);
        }
        let run_folder = resolve_run_folder(&self.spawn_contexts, session_id).await?;
        let service = self.registry.service_for(&provider_account_id).await?;
        service
            .ensure_started(service.dependencies().startup_timeout)
            .await?;
        Ok(CodexCommandSource {
            session_id,
            service,
            provider_account_id,
            working_directory: run_folder.to_string_lossy().into_owned(),
            run_id: None,
        })
    }

    /// The skills `picks` names as Codex lists them for the session, each by its name and the
    /// file it loads it from, in the order picked, read from the session's command source. Fails
    /// with [`DriverError::SkillNotListed`] for a pick Codex does not list in that folder, and as
    /// the read fails.
    pub(crate) async fn resolve_skill_picks(
        &self,
        session_id: SessionId,
        provider_account_id: ProviderAccountId,
        picks: Vec<QueuedSkillPick>,
    ) -> Result<Vec<PickedSkill>, DriverError> {
        let source = self
            .resolve_command_source(session_id, provider_account_id)
            .await?;
        let listed = self.provider_commands.read_skill_files(&source).await?;
        picks
            .iter()
            .map(|pick| {
                listed
                    .iter()
                    .find(|skill| {
                        skill.name.as_str() == pick.name.as_str()
                            && Path::new(skill.path.as_str()).parent()
                                == Some(Path::new(pick.folder_path.as_str()))
                    })
                    .cloned()
                    .ok_or_else(|| DriverError::SkillNotListed(pick.clone()))
            })
            .collect()
    }
}
