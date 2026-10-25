//! A session's provider session resumed from a conversation an earlier daemon left.

use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use tokio::time::timeout;

use super::test_opening::{record_first_provider_capabilities, test_opening_composer};
use super::{ProviderSessions, ProviderSessionsDeps};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::open_log;
use crate::provider::driver::contract::MockProviderDriver;
use crate::provider::driver::session_control::DriverResumeResult;
use crate::provider::driver::test_registry::{new_run_id, registry_of_first_provider};
use crate::provider::runtime_binding::store::{
    CreateRuntimeBindingInput, RuntimeBindingSpawnConfig, RuntimeBindingStore,
};
use crate::provider::runtime_binding::test_store::{binding_input, spawned_build};
use crate::session::run::binding_cursors::RunBindingCursors;
use crate::session::run::engine::tests::insert_running_run;
use crate::session::run::epochs::ExecutionEpochs;
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// The statements the test's read pool prepares.
const READ_STATEMENT_CAPACITY: usize = 16;

/// Bounds the open, which waits on its own lock forever when it takes it twice.
const WAIT: Duration = Duration::from_secs(5);

// Opening a session whose conversation an earlier daemon left resumes it, records the binding the
// resume minted on its predecessor's run, and records the opening run's own binding on it, all
// under the one hold the open took. Killed by the run's binding taking the session's lock again
// inside the open (the test times out), or by the relaunch left unrecorded.
#[tokio::test]
async fn open_resumes_a_conversation_and_binds_the_run_under_its_own_hold() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let session_id = test_session_id();
    let earlier_run_id = new_run_id();
    let run_id = new_run_id();
    insert_running_run(&database, session_id, earlier_run_id);
    insert_running_run(&database, session_id, run_id);
    let pool = Arc::new(DatabaseReadPool::new(
        database.path(),
        READ_STATEMENT_CAPACITY,
    ));
    let runtime_bindings = Arc::new(RuntimeBindingStore::new(
        Arc::clone(&pool),
        Arc::clone(&log.writer),
    ));
    let binding_cursors = Arc::new(RunBindingCursors::new(
        Arc::clone(&pool),
        Arc::clone(&runtime_bindings),
        Arc::new(Mutex::new(ExecutionEpochs::new(
            NonZeroUsize::new(8).expect("the cap is not zero"),
        ))),
    ));
    let predecessor_id = binding_cursors
        .create(CreateRuntimeBindingInput {
            run_id: earlier_run_id,
            ..binding_input(
                RuntimeBindingSpawnConfig::default(),
                spawned_build("1.0.0", "/opt/provider/bin"),
            )
        })
        .await
        .expect("the earlier daemon's binding is recorded")
        .id;
    let relaunched_id =
        RuntimeBindingId::new(mint_uuid_v7().to_string()).expect("a UUID is a binding id");
    let minted = relaunched_id.clone();
    let mut driver = MockProviderDriver::new();
    driver.expect_resume_session().returning(move |params| {
        assert_eq!(params.resume_handle, "conversation-1");
        let binding_id = minted.clone();
        async move {
            Ok(DriverResumeResult::Resumed {
                binding_id,
                session_position: SafeInt::new(1).expect("a position"),
                resume_handle: NonEmptyText::new("conversation-1".to_owned())
                    .expect("a resume handle"),
                spawned_version: spawned_build("1.0.1", "/opt/provider/bin"),
            })
        }
        .boxed()
    });
    let providers = Arc::new(registry_of_first_provider(Arc::new(driver)));
    record_first_provider_capabilities(&providers);
    let sessions = ProviderSessions::new(ProviderSessionsDeps {
        pool,
        writer: Arc::clone(&log.writer),
        runtime_bindings,
        binding_cursors,
        providers,
        compose_opening: test_opening_composer(),
    });

    timeout(WAIT, sessions.open(session_id, run_id))
        .await
        .expect("the open takes its own lock once")
        .expect("the conversation resumes");

    let bindings: Vec<(String, String)> = database
        .reader()
        .prepare("SELECT id, run_id FROM runtime_bindings ORDER BY created_at, id")
        .expect("the test reads the bindings")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the bindings read")
        .collect::<Result<_, _>>()
        .expect("each binding reads");
    assert_eq!(bindings.len(), 3, "{bindings:?}");
    assert!(
        bindings
            .iter()
            .any(|(id, bound_run_id)| id == relaunched_id.as_str()
                && bound_run_id == earlier_run_id.text().as_str()),
        "the relaunch is recorded on its predecessor's run: {bindings:?}"
    );
    assert!(
        bindings
            .iter()
            .any(|(id, bound_run_id)| id != predecessor_id.as_str()
                && bound_run_id == run_id.text().as_str()),
        "the opening run has its own binding: {bindings:?}"
    );
}
