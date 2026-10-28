//! The resume of a session no driver holds in memory, as after a daemon restart: composed from the
//! session's stored leg by the run queue's own composition, the one its opening resumes with. A
//! sleeping session's wake reads it with the timed fires the idle sleep stored for the session,
//! and `session.restart` reads it as its target.

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::session_control::ResumeSessionParams;
use sidekicks_provider::port::session_resume_reader::{SessionResume, SessionResumeReader};
use sidekicks_provider::runtime_binding::store::RuntimeBindingStoreError;
use sidekicks_queue::provider_session::{ProviderSessionError, ProviderSessions};
use sidekicks_session::idle_sleep::kept_schedules::read_stored_schedules;
use sidekicks_session::run::stored_leg::read_session_leg;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};

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
    /// SQLite refused the read of the kept schedules, or a stored one did not read.
    #[error("the session's kept schedules could not be read")]
    Schedules(#[from] rusqlite::Error),
    /// The read pool did not run the read.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
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
                Ok(composed.map(|(provider, params)| SessionRestartTarget { provider, params }))
            }
            .boxed()
        })
    }

    // The provider of the session's leg and the resume composed from it; `None` for a session with
    // no conversation to resume.
    async fn compose(
        &self,
        session_id: SessionId,
    ) -> Result<Option<(ProviderId, ResumeSessionParams)>, StoredResumeError> {
        let Some(leg) = read_session_leg(&self.pool, session_id).await? else {
            return Ok(None);
        };
        let composed = self
            .provider_sessions
            .compose_resume(session_id, &leg)
            .await?;
        Ok(Some((leg.provider_name, composed.params)))
    }
}

impl SessionResumeReader for StoredSessionResumes {
    fn read_resume(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<SessionResume>, Box<dyn Error + Send + Sync>>> {
        async move {
            let Some((_, params)) = self.compose(session_id).await? else {
                return Ok(None);
            };
            // The idle sleep's own read of every stored row, kept to this session's.
            let schedules = self
                .pool
                .read(
                    ReadLength::Short,
                    move |reader| -> Result<_, StoredResumeError> {
                        Ok(read_stored_schedules(reader)?
                            .into_iter()
                            .filter(|(stored_session_id, _)| *stored_session_id == session_id)
                            .map(|(_, schedule)| schedule)
                            .collect())
                    },
                )
                .await?;
            Ok(Some(SessionResume { params, schedules }))
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroUsize;
    use std::sync::{Arc, Mutex};

    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::idle_sleep::KeptSchedule;
    use sidekicks_provider::driver::test_registry::{new_run_id, registry_of_first_provider};
    use sidekicks_provider::port::session_resume_reader::SessionResumeReader;
    use sidekicks_provider::runtime_binding::store::{
        CreateRuntimeBindingInput, RuntimeBindingStore,
    };
    use sidekicks_provider::runtime_binding::test_store::{
        binding_input, spawn_config_on, spawned_build, test_provider_account_id,
    };
    use sidekicks_queue::provider_session::test_opening::test_opening_composer;
    use sidekicks_queue::provider_session::{ProviderSessions, ProviderSessionsDeps};
    use sidekicks_session::run::binding_cursors::RunBindingCursors;
    use sidekicks_session::run::engine::test_fixture::insert_running_run;
    use sidekicks_session::run::epochs::ExecutionEpochs;
    use sidekicks_std::keyed_lock::KeyedLock;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::events::log_service::test_fixture::open_log;

    use super::StoredSessionResumes;
    use crate::daemon::schema::schema_parts;

    /// The statements the test's read pool prepares.
    const READ_STATEMENT_CAPACITY: usize = 16;

    /// The recurring job the test stores for the session.
    const CRON: &str = "0 9 * * 1";

    // A sleeping session's resume comes back with the recurring job the idle sleep stored for it,
    // and with no other session's. Killed by a reader that answers the resume with no schedules,
    // or with every stored session's.
    #[tokio::test]
    async fn a_stored_recurring_job_comes_back_with_the_sessions_resume() {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let session_id = test_session_id();
        let run_id = new_run_id();
        insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
        insert_running_run(&database, session_id, run_id);
        let pool = Arc::new(DatabaseReadPool::new(
            database.path(),
            READ_STATEMENT_CAPACITY,
        ));
        let runtime_bindings = Arc::new(RuntimeBindingStore::new(
            Arc::clone(&pool),
            Arc::clone(&log.writer),
        ));
        runtime_bindings
            .create(CreateRuntimeBindingInput {
                run_id,
                ..binding_input(
                    spawn_config_on(test_provider_account_id()),
                    spawned_build("1.0.0", "/opt/provider/bin"),
                )
            })
            .await
            .expect("the session's leg is recorded");
        for (stored_session_id, cron) in [(session_id, CRON), (test_session_id(), "0 0 * * *")] {
            database
                .reader()
                .execute(
                    "INSERT INTO session_kept_schedules (session_id, position, cron) \
                     VALUES (?1, 0, ?2)",
                    [stored_session_id.text().as_str(), cron],
                )
                .expect("the test stores a kept schedule");
        }
        let binding_cursors = Arc::new(RunBindingCursors::new(
            Arc::clone(&pool),
            Arc::clone(&runtime_bindings),
            Arc::new(Mutex::new(ExecutionEpochs::new(
                NonZeroUsize::new(8).expect("the cap is not zero"),
            ))),
        ));
        let provider_sessions = Arc::new(ProviderSessions::new(ProviderSessionsDeps {
            pool: Arc::clone(&pool),
            writer: Arc::clone(&log.writer),
            runtime_bindings,
            binding_cursors,
            providers: Arc::new(registry_of_first_provider(Arc::new(
                MockProviderDriver::new(),
            ))),
            compose_opening: test_opening_composer(),
            transition_lock: Arc::new(KeyedLock::new()),
        }));

        let resume = StoredSessionResumes::new(pool, provider_sessions)
            .read_resume(session_id)
            .await
            .expect("the stored resume reads")
            .expect("the session has a conversation to resume");

        assert_eq!(resume.params.resume_handle, "conversation-1");
        assert_eq!(
            resume.params.provider_account_id,
            test_provider_account_id()
        );
        assert_eq!(
            resume.schedules,
            [KeptSchedule::Recurring {
                cron: CRON.to_owned(),
                next_fire_at: None,
            }]
        );
    }
}
