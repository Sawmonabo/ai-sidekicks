//! The resume of a session no driver holds in memory, as after a daemon restart: composed from the
//! session's stored leg by the run queue's own composition, the one its opening, its restart and
//! its wake resume with, the timed fires the idle sleep stored for the session among its params,
//! under a binding minted here whose cursor the driver opens before it resumes, and with no
//! function legs, which the driver asks the session directory for. A driver reads it for a session
//! it holds nothing for.

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::session_control::ResumeSessionParams;
use sidekicks_provider::port::session_resume_reader::SessionResumeReader;
use sidekicks_provider::runtime_binding::store::mint_runtime_binding_id;
use sidekicks_queue::provider_session::ProviderSessions;
use sidekicks_queue::provider_session::resume::ComposedResume;
use sidekicks_session::run::stored_leg::read_session_leg;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;

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
}

impl SessionResumeReader for StoredSessionResumes {
    fn read_resume(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<ResumeSessionParams>, Box<dyn Error + Send + Sync>>> {
        async move {
            let Some(leg) = read_session_leg(&self.pool, session_id).await? else {
                return Ok(None);
            };
            let ComposedResume { params, .. } = self
                .provider_sessions
                .compose_resume(session_id, &leg, mint_runtime_binding_id())
                .await?;
            Ok(Some(params))
        }
        .boxed()
    }
}
