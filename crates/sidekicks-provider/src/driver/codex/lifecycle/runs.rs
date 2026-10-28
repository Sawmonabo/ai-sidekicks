//! A Codex run's calls: its start, interrupt, steer, pause and continue, a retry of its held turn
//! on a faster model, the answer to an ask it raised, `Allow once` on a block of Codex's own
//! reviewer, Codex's own review, and the skills a person picked for its message.

use std::path::Path;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::queue::QueuedSkillPick;
use sidekicks_contracts::session::id::SessionId;

use super::CodexDriver;
use crate::driver::codex::run::start::daemon_turns::CodexDaemonTurnError;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::contract::{DriverError, RespondToRequestParams, StartRunParams};
use crate::driver::run_control::{
    ApplyInterventionParams, ApplyInterventionResponse, FasterModelRetryOutcome,
    FasterModelRetryParams, InterruptRunRequest, OverrideDenialParams, PauseRunParams, PickedSkill,
    ResumeRunParams,
};
use crate::driver::session_control::StartReviewParams;

impl CodexDriver {
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
    pub(crate) async fn resume_run(&self, params: ResumeRunParams) -> Result<(), DriverError> {
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

    /// Starts Codex's own review as the session's own run.
    pub(crate) async fn start_review(&self, params: StartReviewParams) -> Result<(), DriverError> {
        let started = self
            .parts()?
            .run_start
            .start_review(params.session_id, params.target)
            .await;
        match started {
            Ok(()) => Ok(()),
            Err(CodexDaemonTurnError::Codex(error)) => Err(error.into()),
            Err(CodexDaemonTurnError::Engine(error)) => Err(DriverError::Internal(error)),
        }
    }

    /// The skills `picks` names as Codex lists them for the session, each by its name and the
    /// file it loads it from, in the order picked: the live session's listing, else a read on
    /// the service of `provider_account_id`, the account the session's runs are admitted
    /// against, over the folder the session's runs work in. Fails with
    /// [`DriverError::SkillNotListed`] for a pick Codex does not list in that folder, and as the
    /// read fails.
    pub(crate) async fn resolve_skill_picks(
        &self,
        session_id: SessionId,
        provider_account_id: Option<ProviderAccountId>,
        picks: Vec<QueuedSkillPick>,
    ) -> Result<Vec<PickedSkill>, DriverError> {
        let listed = if let Some(source) = self.views.command_source(session_id) {
            self.provider_commands
                .read_skill_files(
                    session_id,
                    &source.service,
                    Path::new(&source.working_directory),
                )
                .await?
        } else {
            let run_folder = self
                .spawn_contexts
                .require_port()
                .map_err(|error| DriverError::Internal(Box::new(error)))?
                .resolve_run_folder(session_id)
                .await
                .map_err(DriverError::Internal)?;
            let service = self
                .registry
                .service_for(provider_account_id.as_ref())
                .await?;
            service
                .ensure_started(service.dependencies().startup_timeout)
                .await?;
            self.provider_commands
                .read_skill_files(session_id, &service, &run_folder)
                .await?
        };
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
