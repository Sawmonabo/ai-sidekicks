//! A session's conversation resumed from its stored leg: composed from the session's lead, handed
//! to the driver's resume, a restart or the idle sleep's wake, and recorded as the session's
//! opening, so the next message opens nothing again.

use std::error::Error;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_provider::driver::contract::SpawnedVersionBindingCarriers;
use sidekicks_provider::driver::idle_sleep::SessionSleepState;
use sidekicks_provider::driver::session_control::{DriverResumeResult, ResumeSessionParams};
use sidekicks_provider::left_conversations::LeftConversation;
use sidekicks_provider::runtime_binding::resume::compose_resume_session_params;
use sidekicks_provider::runtime_binding::store::{RuntimeBinding, RuntimeBindingRelaunch};
use sidekicks_session::console_state::read_session_mode;
use sidekicks_session::idle_sleep::kept_schedules::read_session_schedules;
use sidekicks_session::idle_sleep::openings::SessionProcessWaker;
use sidekicks_session::run::stored_leg::read_session_leg;
use sidekicks_store::database::connection::read_pool::ReadLength;

use crate::provider_session::{OpenedSession, ProviderSessionError, ProviderSessions, posture_of};

/// A session's resume composed from its stored leg: the params its driver resumes it with, and
/// what the resumed process is recorded with once the driver answers.
pub struct ComposedResume {
    /// The params the session's driver resumes it with.
    pub params: ResumeSessionParams,
    /// What the resumed process is recorded with.
    pub opening: ResumedOpening,
}

/// The leg a resume continues, and the posture and git folder the resumed process runs at.
pub struct ResumedOpening {
    leg: RuntimeBinding,
    execution_posture: ExecutionPosture,
    git_folder: FilesystemPath,
}

/// What a driver answered a resume or a restart with once the conversation came up.
pub struct ResumedLeg {
    /// The binding the driver minted.
    pub binding_id: RuntimeBindingId,
    /// The conversation the session runs on now.
    pub resume_handle: NonEmptyText,
    /// The build the resumed process spawned.
    pub spawned_version: SpawnedVersionBindingCarriers,
}

impl ProviderSessions {
    /// The resume of `session_id`'s conversation from its stored `leg`, composed from the
    /// session's lead as it stands now on the account the leg ran on, at its mode and level, with
    /// the timed fires the idle sleep stored for it. Fails as the composition, the posture or the
    /// read of the mode or the timed fires fails, and with
    /// [`ProviderSessionError::NotResumable`] for a leg with no conversation.
    pub async fn compose_resume(
        &self,
        session_id: SessionId,
        leg: RuntimeBinding,
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
            &leg,
            opening.create_params.model.clone(),
            opening.create_params.larger_window,
            mode,
            execution_posture.clone(),
            opening.create_params.options.clone(),
            opening.create_params.row_values.clone(),
            (opening.function_legs_for)(&leg.id),
            kept_schedules,
        )?;
        Ok(ComposedResume {
            params,
            opening: ResumedOpening {
                leg,
                execution_posture,
                git_folder: opening.git_folder,
            },
        })
    }

    // The session's conversation is resumed in a fresh process from its stored `leg` and
    // recorded as its opening.
    pub(super) async fn resume_leg(
        &self,
        session_id: SessionId,
        leg: RuntimeBinding,
    ) -> Result<(), ProviderSessionError> {
        let ComposedResume { params, opening } = self.compose_resume(session_id, leg).await?;
        let driver = self.deps.providers.lookup(&opening.leg.provider_name)?;
        match driver.resume_session(params).await? {
            DriverResumeResult::Resumed {
                binding_id,
                resume_handle,
                spawned_version,
                ..
            } => {
                let resumed = ResumedLeg {
                    binding_id,
                    resume_handle,
                    spawned_version,
                };
                self.record_resumed(session_id, opening, resumed).await
            }
            DriverResumeResult::Failed {
                recovery_condition,
                provider_failure_detail,
            } => Err(ProviderSessionError::ResumeRefused {
                session_id,
                recovery_condition,
                provider_failure_detail,
            }),
        }
    }

    /// Records the conversation a driver's resume or restart of `session_id` brought up as the
    /// session's opening: the minted binding carries the leg's cursor on, a conversation the
    /// provider continued in a new one is left behind, and the idle sleep follows the session
    /// awake. The caller holds the session's transition lock. Fails as the binding's record fails.
    pub async fn record_resumed(
        &self,
        session_id: SessionId,
        opening: ResumedOpening,
        resumed: ResumedLeg,
    ) -> Result<(), ProviderSessionError> {
        let ResumedOpening {
            leg,
            execution_posture,
            git_folder,
        } = opening;
        let ResumedLeg {
            binding_id,
            resume_handle,
            spawned_version,
        } = resumed;
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
        self.deps
            .binding_cursors
            .record_relaunch(RuntimeBindingRelaunch {
                predecessor_id: leg.id.clone(),
                binding_id,
                resume_handle: resume_handle.as_str().to_owned(),
                spawned_version,
                left_conversations,
            })
            .await?;
        self.record_opened(
            session_id,
            OpenedSession {
                provider: leg.provider_name,
                execution_posture,
                git_folder,
            },
        );
        Ok(())
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
