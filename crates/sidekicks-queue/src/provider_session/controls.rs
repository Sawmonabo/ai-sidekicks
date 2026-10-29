//! The session controls that act on a session's provider process: its level and mode moves, and
//! the resume material a side question's copy is forked from. A move reads where the process
//! stands from its driver under the session's transition lock: a process that runs, or that the
//! driver brings back itself, takes the move first; a session with none takes it from the store
//! when its next process opens.

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_provider::driver::contract::SessionProcessState;
use sidekicks_provider::driver::session_control::{
    ResumeSessionParams, UpdatePermissionLevelParams, UpdateSessionModeParams,
};
use sidekicks_provider::run::posture::compose_execution_posture;
use sidekicks_provider::runtime_binding::store::mint_runtime_binding_id;
use sidekicks_session::console_state::session_mode_change_statement;
use sidekicks_session::directory::lookups::{SessionWriteError, write_while_session_exists};
use sidekicks_session::permission_level::{
    permission_level_change_statement, read_session_permission_level,
};
use sidekicks_session::run::stored_leg::read_session_leg;
use sidekicks_store::database::connection::read_pool::ReadLength;

use super::resume::ComposedResume;
use super::{OpenedProcess, ProviderSessionError, ProviderSessions};

/// What a side question is asked from: the session's binding its usage is recorded on, and the
/// resume material its copy is forked from.
pub struct SideQuestionSource {
    /// The binding of the session's newest conversation.
    pub binding_id: RuntimeBindingId,
    /// That conversation, composed as a resume of it is.
    pub resume: ResumeSessionParams,
}

impl ProviderSessions {
    /// Moves the session to `level` and stores it, unless it stands there already. A process that
    /// runs, or that its driver brings back, is moved first, so the record never names a level the
    /// provider refused; a store that fails then moves it back and fails. A session with no
    /// process stores the level, which its next process opens at. Fails as the driver's move fails,
    /// with nothing changed, with [`ProviderSessionError::Closed`] or
    /// [`ProviderSessionError::BeingDeleted`] for a closed session, and with
    /// [`ProviderSessionError::LevelNotStored`] carrying `session.notFound` for one gone meanwhile.
    pub async fn change_level(
        &self,
        session_id: SessionId,
        level: PermissionLevel,
    ) -> Result<(), ProviderSessionError> {
        let _hold = self.deps.transition_lock.acquire(session_id).await;
        self.refuse_ended(session_id).await?;
        let stored = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, ProviderSessionError>(read_session_permission_level(reader, &session_id)?)
            })
            .await?;
        if stored == level {
            return Ok(());
        }
        let (opened, driver) = match self.process_state(session_id)? {
            Some(OpenedProcess {
                state: SessionProcessState::Live | SessionProcessState::Restarting,
                opened,
                driver,
            }) => (opened, driver),
            Some(OpenedProcess {
                state: SessionProcessState::Down,
                ..
            })
            | None => {
                return self
                    .record_level(session_id, level)
                    .await
                    .map_err(|cause| ProviderSessionError::LevelNotStored { session_id, cause });
            }
        };
        let posture = compose_execution_posture(level, opened.git_folder.clone());
        let moved = UpdatePermissionLevelParams {
            session_id,
            execution_posture: posture.clone(),
        };
        driver.update_permission_level(moved).await?;
        self.set_posture(session_id, posture);
        let Err(stored_error) = self.record_level(session_id, level).await else {
            return Ok(());
        };
        let back = UpdatePermissionLevelParams {
            session_id,
            execution_posture: opened.execution_posture.clone(),
        };
        match driver.update_permission_level(back).await {
            Ok(()) => {
                self.set_posture(session_id, opened.execution_posture);
                Err(ProviderSessionError::LevelNotStored {
                    session_id,
                    cause: stored_error,
                })
            }
            Err(moved_back) => Err(ProviderSessionError::LevelNotMovedBack {
                session_id,
                stored: stored_error,
                moved_back,
            }),
        }
    }

    /// Moves the session to `mode` and stores it, unless it stands there already, as
    /// [`ProviderSessions::change_level`] moves a level: a process that runs, or that its driver
    /// brings back, is moved first and moved back when the store fails; a session with no process
    /// stores the mode, which its next process opens in. Fails as the driver's move fails, with
    /// nothing changed, as the level's move fails for a closed session, and with
    /// [`ProviderSessionError::ModeNotStored`] carrying `session.notFound` for one gone meanwhile.
    pub async fn change_mode(
        &self,
        session_id: SessionId,
        mode: SessionMode,
    ) -> Result<(), ProviderSessionError> {
        let _hold = self.deps.transition_lock.acquire(session_id).await;
        self.refuse_ended(session_id).await?;
        let stored = self.read_mode(session_id).await?;
        if stored == mode {
            return Ok(());
        }
        let driver = match self.process_state(session_id)? {
            Some(OpenedProcess {
                state: SessionProcessState::Live | SessionProcessState::Restarting,
                driver,
                ..
            }) => driver,
            Some(OpenedProcess {
                state: SessionProcessState::Down,
                ..
            })
            | None => {
                return self
                    .record_mode(session_id, mode)
                    .await
                    .map_err(|cause| ProviderSessionError::ModeNotStored { session_id, cause });
            }
        };
        driver
            .update_session_mode(UpdateSessionModeParams { session_id, mode })
            .await?;
        let Err(stored_error) = self.record_mode(session_id, mode).await else {
            return Ok(());
        };
        let back = UpdateSessionModeParams {
            session_id,
            mode: stored,
        };
        match driver.update_session_mode(back).await {
            Ok(()) => Err(ProviderSessionError::ModeNotStored {
                session_id,
                cause: stored_error,
            }),
            Err(moved_back) => Err(ProviderSessionError::ModeNotMovedBack {
                session_id,
                stored: stored_error,
                moved_back,
            }),
        }
    }

    /// What a side question's throwaway copy is forked from and recorded on: the session's newest
    /// conversation, composed as a resume of it is, whether or not a process runs it, since the
    /// driver forks the live process where one runs, and that conversation's binding, which the
    /// copy's usage is recorded on. `None` for a session that never ran. Fails as the leg's read or
    /// the opening's composition fails.
    pub async fn side_question_source(
        &self,
        session_id: SessionId,
    ) -> Result<Option<SideQuestionSource>, ProviderSessionError> {
        let Some(leg) = read_session_leg(&self.deps.pool, session_id).await? else {
            return Ok(None);
        };
        // The copy runs under no binding of the session's; the id only fills the material.
        let ComposedResume { params, .. } = self
            .compose_resume(session_id, &leg, mint_runtime_binding_id())
            .await?;
        Ok(Some(SideQuestionSource {
            binding_id: leg.id,
            resume: params,
        }))
    }

    // Stores `level` while the session has a directory row.
    async fn record_level(
        &self,
        session_id: SessionId,
        level: PermissionLevel,
    ) -> Result<(), SessionWriteError> {
        let statement = permission_level_change_statement(&session_id, level);
        write_while_session_exists(&self.deps.writer, &session_id, statement)
            .await
            .map(drop)
    }

    // Stores `mode` while the session has a directory row.
    async fn record_mode(
        &self,
        session_id: SessionId,
        mode: SessionMode,
    ) -> Result<(), SessionWriteError> {
        let statement =
            session_mode_change_statement(&session_id, mode, WireInstant::now().as_str());
        write_while_session_exists(&self.deps.writer, &session_id, statement)
            .await
            .map(drop)
    }
}
