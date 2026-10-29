//! The session controls that act on a session's provider process: its level and mode moves, the
//! follow of a level or mode its provider reported moving to, and the resume material a side
//! question's copy is forked from. A move reads where the process stands from its driver under the
//! session's transition lock: a process that runs, or that the driver brings back itself, takes the
//! move first; a session with none takes it from the store when its next process opens. Each move
//! is stored with the `LevelMoved` notice every client reads the session's level and mode from.

use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::controls::events::{SessionNotice, SessionNoticePostedPayload};
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_provider::driver::contract::SessionProcessState;
use sidekicks_provider::driver::session_control::{
    ResumeSessionParams, UpdatePermissionLevelParams, UpdateSessionModeParams,
};
use sidekicks_provider::run::posture::{compose_execution_posture, resolve_posture};
use sidekicks_provider::runtime_binding::store::mint_runtime_binding_id;
use sidekicks_session::console_state::{read_session_mode, session_mode_change_statement};
use sidekicks_session::directory::lookups::session_exists_statement;
use sidekicks_session::permission_level::{
    permission_level_change_statement, read_session_permission_level,
};
use sidekicks_session::run::state_change::refused_statement_index;
use sidekicks_session::run::stored_leg::read_session_leg;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::events::log_service::EventAppendError;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventDraft, SessionEventEmitError, SessionEventLinkage,
};

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

/// Why a level or mode move was not stored with the notice that tells every client of it; nothing
/// of its write is kept.
#[derive(Debug, thiserror::Error)]
pub enum MoveRecordError {
    /// The session took no write: `session.notFound` for one gone meanwhile, or its history's own
    /// refusal while it is rebuilt or damaged.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The notice was not drafted, or its write was not kept.
    #[error(transparent)]
    Emit(#[from] SessionEventEmitError),
}

impl ProviderSessions {
    /// Moves the session to `level` and stores it with the `LevelMoved` notice, unless it stands
    /// there already. A process that runs, or that its driver brings back, is moved first, so the
    /// record never names a level the provider refused, and its live runs move with it; a store
    /// that fails then moves both back and fails. A session with no process stores the level,
    /// which its next process opens at.
    /// Fails with [`ProviderSessionError::PostureRefused`] for a level whose posture does not
    /// resolve and as the driver's move fails, both with nothing changed, with
    /// [`ProviderSessionError::Closed`] or [`ProviderSessionError::BeingDeleted`] for a closed
    /// session, and with [`ProviderSessionError::LevelNotStored`] carrying `session.notFound` for
    /// one gone meanwhile.
    pub async fn change_level(
        &self,
        session_id: SessionId,
        level: PermissionLevel,
    ) -> Result<(), ProviderSessionError> {
        let _hold = self.deps.transition_lock.acquire(session_id).await;
        self.refuse_ended(session_id).await?;
        let (stored, session_mode) = self.read_controls(session_id).await?;
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
                self.record_level(session_id, level, session_mode)
                    .await
                    .map_err(|cause| ProviderSessionError::LevelNotStored { session_id, cause })?;
                // Its next process opens at the stored level, which its runs are requested at.
                self.deps.execution_postures.forget_session(&session_id);
                return Ok(());
            }
        };
        let posture = compose_execution_posture(level, opened.git_folder.clone());
        let resolved = resolve_posture(&posture)
            .await
            .map_err(|cause| ProviderSessionError::PostureRefused { session_id, cause })?;
        let moved = UpdatePermissionLevelParams {
            session_id,
            execution_posture: posture.clone(),
            is_provider_reported: false,
        };
        driver.update_permission_level(moved).await?;
        self.set_posture(session_id, posture);
        self.deps
            .execution_postures
            .move_session(&session_id, resolved);
        let Err(stored_error) = self.record_level(session_id, level, session_mode).await else {
            return Ok(());
        };
        let back = UpdatePermissionLevelParams {
            session_id,
            execution_posture: opened.execution_posture.clone(),
            is_provider_reported: false,
        };
        match driver.update_permission_level(back).await {
            Ok(()) => {
                match resolve_posture(&opened.execution_posture).await {
                    Ok(resolved_back) => self
                        .deps
                        .execution_postures
                        .move_session(&session_id, resolved_back),
                    // The old level's root is gone too: no posture to carry the runs back to, so
                    // each later run's gate resolves the one it was requested at.
                    Err(_unresolved) => self.deps.execution_postures.forget_session(&session_id),
                }
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

    /// Moves the session to `mode` and stores it with the `LevelMoved` notice, unless it stands
    /// there already, as
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
        let (level, stored) = self.read_controls(session_id).await?;
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
                    .record_mode(session_id, level, mode)
                    .await
                    .map_err(|cause| ProviderSessionError::ModeNotStored { session_id, cause });
            }
        };
        driver
            .update_session_mode(UpdateSessionModeParams {
                session_id,
                mode,
                is_provider_reported: false,
            })
            .await?;
        let Err(stored_error) = self.record_mode(session_id, level, mode).await else {
            return Ok(());
        };
        let back = UpdateSessionModeParams {
            session_id,
            mode: stored,
            is_provider_reported: false,
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

    /// Follows the level or mode the session's live process reported moving to on its own, read
    /// from its driver's newest report under the session's transition lock, so a report that lands
    /// during another move is read once that move is stored. A reported level moves the process's
    /// posture, its live runs and the stored level as [`ProviderSessions::change_level`] does, the
    /// driver told the move is the provider's own; a reported planning mode moves the stored mode
    /// the same way. Each is stored with the `LevelMoved` notice. A report the store already
    /// matches, none, or a process no longer live moves nothing: a process gone takes the stored
    /// level when it opens again. Fails as [`ProviderSessions::change_level`] fails before its
    /// driver moves, as the driver's move fails, and with [`ProviderSessionError::LevelNotStored`]
    /// or [`ProviderSessionError::ModeNotStored`] when the store fails, the process left where the
    /// provider moved it.
    pub async fn follow_reported_level(
        &self,
        session_id: SessionId,
    ) -> Result<(), ProviderSessionError> {
        let _hold = self.deps.transition_lock.acquire(session_id).await;
        self.refuse_ended(session_id).await?;
        let Some(OpenedProcess {
            state: SessionProcessState::Live,
            opened,
            driver,
        }) = self.process_state(session_id)?
        else {
            return Ok(());
        };
        let Some(reported) = driver.reported_level(&session_id) else {
            return Ok(());
        };
        let (stored_level, stored_mode) = self.read_controls(session_id).await?;
        let Some(level) = reported.level else {
            if reported.session_mode == stored_mode {
                return Ok(());
            }
            driver
                .update_session_mode(UpdateSessionModeParams {
                    session_id,
                    mode: reported.session_mode,
                    is_provider_reported: true,
                })
                .await?;
            return self
                .record_mode(session_id, stored_level, reported.session_mode)
                .await
                .map_err(|cause| ProviderSessionError::ModeNotStored { session_id, cause });
        };
        if level == stored_level {
            return Ok(());
        }
        let posture = compose_execution_posture(level, opened.git_folder);
        let resolved = resolve_posture(&posture)
            .await
            .map_err(|cause| ProviderSessionError::PostureRefused { session_id, cause })?;
        driver
            .update_permission_level(UpdatePermissionLevelParams {
                session_id,
                execution_posture: posture.clone(),
                is_provider_reported: true,
            })
            .await?;
        self.set_posture(session_id, posture);
        self.deps
            .execution_postures
            .move_session(&session_id, resolved);
        self.record_level(session_id, level, stored_mode)
            .await
            .map_err(|cause| ProviderSessionError::LevelNotStored { session_id, cause })
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

    // The level and the mode the session stands at, as stored.
    async fn read_controls(
        &self,
        session_id: SessionId,
    ) -> Result<(PermissionLevel, SessionMode), ProviderSessionError> {
        self.deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, ProviderSessionError>((
                    read_session_permission_level(reader, &session_id)?,
                    read_session_mode(reader, &session_id)?,
                ))
            })
            .await
    }

    // Stores `level`, the session's mode standing at `session_mode`.
    async fn record_level(
        &self,
        session_id: SessionId,
        level: PermissionLevel,
        session_mode: SessionMode,
    ) -> Result<(), MoveRecordError> {
        let change = permission_level_change_statement(&session_id, level);
        self.record_move(session_id, change, level, session_mode, None)
            .await
    }

    // Stores `session_mode`, the session's level standing at `level`.
    async fn record_mode(
        &self,
        session_id: SessionId,
        level: PermissionLevel,
        session_mode: SessionMode,
    ) -> Result<(), MoveRecordError> {
        let moved_at = WireInstant::now();
        let change = session_mode_change_statement(&session_id, session_mode, moved_at.as_str());
        self.record_move(session_id, change, level, session_mode, Some(moved_at))
            .await
    }

    // Writes `change` with the `LevelMoved` notice of the session at `level` and `session_mode`,
    // in one write kept only while the session has a directory row.
    async fn record_move(
        &self,
        session_id: SessionId,
        change: WriteStatement,
        level: PermissionLevel,
        session_mode: SessionMode,
        occurred_at: Option<WireInstant>,
    ) -> Result<(), MoveRecordError> {
        let notice = SessionNotice::LevelMoved {
            session_id,
            level,
            session_mode,
        };
        let draft = SessionEventDraft::of_session(
            session_id,
            &SessionEvent::SessionNoticePosted(SessionNoticePostedPayload::Notice(notice)),
        )
        .map_err(SessionEventEmitError::from)?;
        let linkage = SessionEventLinkage {
            occurred_at,
            // The existence check first, so its refusal reads as the session gone.
            transactional_prelude: vec![session_exists_statement(&session_id), change],
            ..SessionEventLinkage::default()
        };
        match self.deps.appender.append(draft, linkage).await {
            Ok(_receipt) => Ok(()),
            Err(SessionEventAppendError::Append(EventAppendError::SessionWriteRefused(
                refusal,
            ))) => Err(DomainError::from(refusal).into()),
            Err(failure) if refused_statement_index(&failure) == Some(0) => {
                Err(session_not_found(&session_id).into())
            }
            Err(failure) => Err(SessionEventEmitError::from(failure).into()),
        }
    }
}
