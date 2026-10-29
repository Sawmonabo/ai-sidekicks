//! The resume of a session no driver holds in memory, as after a daemon restart: composed from the
//! session's stored leg by the run queue's own composition, the one its opening and its wake resume
//! with, the timed fires the idle sleep stored for the session among its params. A driver reads it
//! for a session it holds nothing for, and `session.restart` reads it as its target.

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::session_control::ResumeSessionParams;
use sidekicks_provider::port::session_resume_reader::SessionResumeReader;
use sidekicks_provider::runtime_binding::store::RuntimeBindingStoreError;
use sidekicks_queue::provider_session::resume::ComposedResume;
use sidekicks_queue::provider_session::{ProviderSessionError, ProviderSessions};
use sidekicks_session::run::stored_leg::read_session_leg;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;

use crate::ipc::handlers::session::restart::{RestartTargetReader, SessionRestartTarget};

/// Why a session's stored resume could not be read.
#[derive(Debug, thiserror::Error)]
enum StoredResumeError {
    /// The session's bindings could not be read.
    #[error(transparent)]
    Leg(#[from] RuntimeBindingStoreError),
    /// The resume could not be composed from the session's lead.
    #[error(transparent)]
    Compose(#[from] ProviderSessionError),
}

/// The stored resumes, each composed through the run queue's provider sessions.
pub(crate) struct StoredSessionResumes {
    pool: Arc<DatabaseReadPool>,
    provider_sessions: Arc<ProviderSessions>,
}

impl StoredSessionResumes {
    /// The resumes read through `pool` and composed by `provider_sessions`.
    pub(crate) fn new(
        pool: Arc<DatabaseReadPool>,
        provider_sessions: Arc<ProviderSessions>,
    ) -> Self {
        Self {
            pool,
            provider_sessions,
        }
    }

    /// `session.restart`'s targets over `resumes`: the provider the session's leg ran on and the
    /// resume composed from it, `None` for a session that never ran; a failed read or composition
    /// is answered as a fault inside the daemon.
    pub(crate) fn compose_restart_targets(resumes: &Arc<Self>) -> RestartTargetReader {
        let resumes = Arc::clone(resumes);
        Arc::new(move |session_id| {
            let resumes = Arc::clone(&resumes);
            async move {
                let composed = resumes
                    .compose(session_id)
                    .await
                    .map_err(|error| HandlerError::Internal(Box::new(error)))?;
                Ok(composed.map(|(provider, composed)| {
                    let ComposedResume { params, opening } = composed;
                    let provider_sessions = Arc::clone(&resumes.provider_sessions);
                    SessionRestartTarget {
                        provider,
                        params,
                        record: Box::new(move |resumed| {
                            async move {
                                provider_sessions
                                    .record_resumed(session_id, opening, resumed)
                                    .await
                                    .map_err(|error| HandlerError::Internal(Box::new(error)))
                            }
                            .boxed()
                        }),
                    }
                }))
            }
            .boxed()
        })
    }

    // The provider of the session's leg and the resume composed from it; `None` for a session with
    // no conversation to resume.
    async fn compose(
        &self,
        session_id: SessionId,
    ) -> Result<Option<(ProviderId, ComposedResume)>, StoredResumeError> {
        let Some(leg) = read_session_leg(&self.pool, session_id).await? else {
            return Ok(None);
        };
        let provider = leg.provider_name.clone();
        let composed = self
            .provider_sessions
            .compose_resume(session_id, leg)
            .await?;
        Ok(Some((provider, composed)))
    }
}

impl SessionResumeReader for StoredSessionResumes {
    fn read_resume(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<ResumeSessionParams>, Box<dyn Error + Send + Sync>>> {
        async move {
            let composed = self.compose(session_id).await?;
            Ok(composed.map(|(_, ComposedResume { params, .. })| params))
        }
        .boxed()
    }
}
