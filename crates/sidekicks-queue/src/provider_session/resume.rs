//! A session's conversation resumed from its stored leg: composed from the session's lead, handed
//! to the driver's resume at its first admission or the idle sleep's wake, or to its restart after
//! the process ended and stayed down, under a binding minted here whose cursor opens before the
//! driver runs, and recorded as the session's opening, so the next message opens nothing again.

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::capabilities::DriverCapabilityFlag;
use sidekicks_provider::driver::idle_sleep::SessionSleepState;
use sidekicks_provider::driver::session_control::{DriverResumeResult, ResumeSessionParams};
use sidekicks_provider::left_conversations::LeftConversation;
use sidekicks_provider::runtime_binding::resume::{
    ResumeFunctionLegs, compose_resume_session_params,
};
use sidekicks_provider::runtime_binding::store::{
    RuntimeBinding, RuntimeBindingRelaunch, mint_runtime_binding_id,
};
use sidekicks_session::console_state::read_session_mode;
use sidekicks_session::idle_sleep::kept_schedules::read_session_schedules;
use sidekicks_session::idle_sleep::openings::SessionProcessWaker;
use sidekicks_session::run::stored_leg::read_session_leg;
use sidekicks_store::database::connection::read_pool::ReadLength;

use crate::provider_session::{
    OpenedSession, ProviderSessionError, ProviderSessions, close_unrecorded, posture_of,
};

/// A session's resume composed from its stored leg: the params its driver resumes it with, with no
/// function legs, the posture and git folder the resumed process runs at, and the legs a caller
/// that starts the process under its own binding opens for it.
pub struct ComposedResume {
    /// The params the session's driver resumes it with; they carry no function legs, so composing
    /// them opens no status leg, and a driver that asks the session directory for its legs, or a
    /// side question's copy, which runs under no binding of the session's, holds none.
    pub params: ResumeSessionParams,
    // The posture of the level the session stands at.
    execution_posture: ExecutionPosture,
    // The git folder each level's posture is built on.
    git_folder: FilesystemPath,
    // Opens the function legs of a binding: called only by a relaunch that hands them to the
    // driver, since each call opens a status leg.
    function_legs_for: Arc<dyn Fn(&RuntimeBindingId) -> ResumeFunctionLegs + Send + Sync>,
}

// Which of the driver's verbs brings a session's conversation back in a fresh process: the resume
// of a session's first admission or wake, or the restart of a process that ended and stayed down.
#[derive(Clone, Copy)]
enum Relaunch {
    Resume,
    Restart,
}

impl ProviderSessions {
    /// The resume of `session_id`'s conversation from its stored `leg` under `binding_id`,
    /// composed from the session's lead as it stands now on the account the leg ran on, at the
    /// level it stands at, in the mode it was last moved to and with the timed fires the idle
    /// sleep stored for it, under `binding_id`, with no function legs. Fails as the composition, the
    /// posture or the read of the mode or the timed fires fails, and with
    /// [`ProviderSessionError::NotResumable`] for a leg with no conversation.
    pub async fn compose_resume(
        &self,
        session_id: SessionId,
        leg: &RuntimeBinding,
        binding_id: RuntimeBindingId,
    ) -> Result<ComposedResume, ProviderSessionError> {
        // The resume runs on the account the leg ran on, read back from its spawn record.
        let opening = self
            .compose(session_id, leg.spawn_config.provider_account_id.clone())
            .await?;
        let execution_posture = posture_of(session_id, &opening)?;
        let (mode, kept_schedules) = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, ProviderSessionError>((
                    read_session_mode(reader, &session_id)?,
                    read_session_schedules(reader, session_id)?,
                ))
            })
            .await?;
        let params = compose_resume_session_params(
            session_id,
            opening.create_params.agent_id,
            leg,
            binding_id.clone(),
            opening.create_params.model,
            opening.create_params.larger_window,
            mode,
            execution_posture.clone(),
            opening.create_params.options,
            opening.create_params.row_values,
            ResumeFunctionLegs::default(),
            kept_schedules,
        )?;
        Ok(ComposedResume {
            params,
            execution_posture,
            git_folder: opening.git_folder,
            function_legs_for: opening.function_legs_for,
        })
    }

    /// Starts the session's provider process again after it ended and stayed down, its newest
    /// conversation brought back through the driver's restart as an opening's resume brings it
    /// back, and keeps the session open in this process, the idle sleep following it awake. Fails
    /// with [`ProviderSessionError::Closed`] or [`ProviderSessionError::BeingDeleted`] for an ended
    /// session, [`ProviderSessionError::NoConversation`] for one with none to resume,
    /// [`ProviderSessionError::Provider`] when no driver answers its provider or the driver cannot
    /// resume, the driver never called, [`ProviderSessionError::ResumeRefused`] for a restart the
    /// provider refused, and as the composition, the driver or the binding's record fails.
    pub async fn restart(&self, session_id: SessionId) -> Result<(), ProviderSessionError> {
        let _hold = self.deps.transition_lock.acquire(session_id).await;
        self.refuse_ended(session_id).await?;
        let leg = read_session_leg(&self.deps.pool, session_id)
            .await?
            .ok_or(ProviderSessionError::NoConversation { session_id })?;
        self.deps
            .providers
            .check_capability(&leg.provider_name, DriverCapabilityFlag::Resume)?;
        let opened = self.relaunch(session_id, leg, Relaunch::Restart).await?;
        self.record_opened(session_id, opened);
        Ok(())
    }

    // The session's conversation is resumed in a fresh process from its stored `leg` and recorded
    // as its opening.
    pub(super) async fn resume_leg(
        &self,
        session_id: SessionId,
        leg: RuntimeBinding,
    ) -> Result<(), ProviderSessionError> {
        let opened = self.relaunch(session_id, leg, Relaunch::Resume).await?;
        self.record_opened(session_id, opened);
        Ok(())
    }

    // Brings `leg`'s conversation back in a fresh process through `relaunch`, under a binding
    // minted here whose cursor carries on where the leg's stands, opened before the driver runs,
    // since the provider delivers under it at once, and recorded once the driver answers; a
    // process whose record fails is closed. A process already up that answers on its own binding
    // records nothing.
    async fn relaunch(
        &self,
        session_id: SessionId,
        leg: RuntimeBinding,
        relaunch: Relaunch,
    ) -> Result<OpenedSession, ProviderSessionError> {
        let minted_id = mint_runtime_binding_id();
        let ComposedResume {
            mut params,
            execution_posture,
            git_folder,
            function_legs_for,
        } = self
            .compose_resume(session_id, &leg, minted_id.clone())
            .await?;
        params.on_mcp_server_status = function_legs_for(&minted_id).on_mcp_server_status;
        let driver = self.deps.providers.lookup(&leg.provider_name)?;
        self.deps
            .binding_cursors
            .open_relaunch(session_id, &leg, minted_id.clone())
            .await?;
        let answered = match relaunch {
            Relaunch::Resume => driver.resume_session(params).await,
            Relaunch::Restart => driver.restart_session(params).await,
        };
        let answer = match answered {
            Ok(answer) => answer,
            Err(error) => {
                self.deps.binding_cursors.forget_binding(&minted_id);
                return Err(error.into());
            }
        };
        let (binding_id, resume_handle, spawned_version) = match answer {
            DriverResumeResult::Resumed {
                binding_id,
                resume_handle,
                spawned_version,
                ..
            } => (binding_id, resume_handle, spawned_version),
            DriverResumeResult::Failed {
                recovery_condition,
                provider_failure_detail,
            } => {
                self.deps.binding_cursors.forget_binding(&minted_id);
                return Err(ProviderSessionError::ResumeRefused {
                    session_id,
                    provider: leg.provider_name,
                    recovery_condition,
                    provider_failure_detail,
                });
            }
        };
        if binding_id == minted_id {
            // A provider that continued the conversation in a new one left the old one behind.
            let left_conversations = leg
                .resume_handle
                .as_ref()
                .filter(|handle| handle.as_str() != resume_handle.as_str())
                .map(|handle| LeftConversation {
                    session_id,
                    provider_account_id: leg.spawn_config.provider_account_id.clone(),
                    conversation_id: handle.clone(),
                })
                .into_iter()
                .collect();
            let recorded = self
                .deps
                .binding_cursors
                .record_relaunch(RuntimeBindingRelaunch {
                    predecessor_id: leg.id.clone(),
                    binding_id,
                    resume_handle: resume_handle.as_str().to_owned(),
                    spawned_version,
                    left_conversations,
                })
                .await;
            if let Err(unrecorded) = recorded {
                return Err(close_unrecorded(driver.as_ref(), session_id, unrecorded).await);
            }
        } else {
            // A process already up answered on the binding that brought it up, which has its
            // cursor and its row.
            self.deps.binding_cursors.forget_binding(&minted_id);
        }
        Ok(OpenedSession {
            provider: leg.provider_name,
            execution_posture,
            git_folder,
        })
    }

    // Brings `session_id`'s process up for the idle sleep under the session's transition lock.
    async fn wake(&self, session_id: SessionId) -> Result<SessionSleepState, ProviderSessionError> {
        let _hold = self.deps.transition_lock.acquire(session_id).await;
        // Read under the lock, so a close that took it first refuses the wake.
        self.refuse_ended(session_id).await?;
        let opened = self
            .lock_opened()
            .get(&session_id)
            .map(|opened| opened.provider.clone());
        if let Some(provider) = opened {
            let driver = self.deps.providers.lookup(&provider)?;
            return Ok(driver.wake_session(session_id).await?);
        }
        let leg = read_session_leg(&self.deps.pool, session_id)
            .await?
            .ok_or(ProviderSessionError::NoConversation { session_id })?;
        self.resume_leg(session_id, leg).await?;
        Ok(SessionSleepState::Awake)
    }
}

impl SessionProcessWaker for ProviderSessions {
    fn wake_process(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<SessionSleepState, Box<dyn Error + Send + Sync>>> {
        async move { self.wake(session_id).await.map_err(Into::into) }.boxed()
    }
}
