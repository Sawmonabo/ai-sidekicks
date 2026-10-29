//! The port's relaunch record and its run folder.

use std::error::Error;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::machine::settings::MachineSettings;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_mcp::binding::resolver::McpAttributionTable;
use sidekicks_mcp::status::open_test_tracker;
use sidekicks_provider::driver::SessionSpawnContextResolver;
use sidekicks_provider::driver::ports::SessionRelaunchListener;
use sidekicks_provider::driver::session_control::DriverResumeResult;
use sidekicks_provider::left_conversations::read_left_conversations;
use sidekicks_provider::runtime_binding::store::{
    CreateRuntimeBindingInput, mint_runtime_binding_id,
};
use sidekicks_provider::runtime_binding::test_store::{
    binding_input, open_store, spawn_config_on, spawned_build, test_provider_account_id,
};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_run_id, test_session_id};
use sidekicks_workspace::git::process::test_git_runner;
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use sidekicks_workspace::project::records::{
    PROJECT_RECORDS_STATEMENT_CAPACITY, ProjectRecords, ProjectSessionActivity, ProjectSessionFacts,
};
use sidekicks_workspace::test_rows::project_and_mount_rows;

use super::{
    SESSION_DIRECTORY_PROVIDER_PORT_STATEMENT_CAPACITY, SessionDirectoryProviderPort,
    SessionDirectoryProviderPortDeps,
};
use crate::run::binding_cursors::{RUN_BINDING_CURSORS_STATEMENT_CAPACITY, RunBindingCursors};
use crate::run::engine::test_fixture::insert_running_run;
use crate::run::epochs::ExecutionEpochs;
use crate::run::schema::schema_parts;
use crate::run::stored_leg::read_session_leg;

// A relaunch reads neither the projects nor the settings.
struct Unread;

impl ProjectSessionActivity for Unread {
    fn read_session_facts(
        &self,
        _reader: &Connection,
        _project_ids: Option<&[ProjectId]>,
    ) -> rusqlite::Result<Vec<ProjectSessionFacts>> {
        Ok(Vec::new())
    }
}

impl MachineSettingsReader for Unread {
    fn read_machine_settings(
        &self,
    ) -> BoxFuture<'_, Result<MachineSettings, Box<dyn Error + Send + Sync>>> {
        async { Ok(MachineSettings::default()) }.boxed()
    }
}

// A port over a session whose leg runs on `conversation-1`.
struct PortOverLeg {
    port: SessionDirectoryProviderPort,
    pool: Arc<DatabaseReadPool>,
    epochs: Arc<Mutex<ExecutionEpochs>>,
    leg_id: RuntimeBindingId,
}

async fn port_over_a_leg(database: &TestDatabase, session_id: SessionId) -> PortOverLeg {
    let store = open_store(database).await;
    let run_id = test_run_id();
    insert_running_run(database, session_id, run_id);
    let pool = Arc::new(DatabaseReadPool::new(
        database.path(),
        SESSION_DIRECTORY_PROVIDER_PORT_STATEMENT_CAPACITY
            + RUN_BINDING_CURSORS_STATEMENT_CAPACITY
            + PROJECT_RECORDS_STATEMENT_CAPACITY,
    ));
    let epochs = Arc::new(Mutex::new(ExecutionEpochs::new(
        NonZeroUsize::new(8).expect("the cap is not zero"),
    )));
    let binding_cursors = Arc::new(RunBindingCursors::new(
        Arc::clone(&pool),
        Arc::new(store),
        Arc::clone(&epochs),
    ));
    let leg = CreateRuntimeBindingInput {
        run_id,
        ..binding_input(
            spawn_config_on(test_provider_account_id()),
            spawned_build("1.0.0", "/opt/provider/bin"),
        )
    };
    let leg_id = leg.id.clone();
    binding_cursors
        .create(session_id, leg)
        .await
        .expect("the leg is recorded");
    // The session is in no project, so its relaunch opens no leg on the tracker.
    let (mcp_status, _, _) = open_test_tracker().await;
    let port = SessionDirectoryProviderPort::new(SessionDirectoryProviderPortDeps {
        pool: Arc::clone(&pool),
        read_damaged_from_sequence: Arc::new(|_: &SessionId| None),
        binding_cursors,
        git: test_git_runner(),
        settings: Arc::new(Unread),
        project_records: Arc::new(ProjectRecords::new(Arc::clone(&pool), Arc::new(Unread))),
        provider_accounts: Arc::new(PortRegistration::new("provider accounts")),
        mcp_status,
        mcp_attribution: Arc::new(McpAttributionTable::default()),
    });
    PortOverLeg {
        port,
        pool,
        epochs,
        leg_id,
    }
}

// A relaunch's `Resumed` on `binding_id`, running conversation `resume_handle`.
fn resumed_on(binding_id: RuntimeBindingId, resume_handle: &str) -> DriverResumeResult {
    DriverResumeResult::Resumed {
        binding_id,
        session_position: SafeInt::new(1).expect("a position"),
        resume_handle: NonEmptyText::new(resume_handle.to_owned()).expect("a resume handle"),
        spawned_version: spawned_build("1.1.0", "/opt/provider/bin"),
    }
}

// The relaunch's cursor is open once the opening answers, before the resume's result, and its
// binding is recorded as the session's leg. Killed by the opening that opens no cursor, by the
// handle comparison inverted, which records the conversation the leg still runs on as left, or
// none for one it left; and by a relaunch whose binding is not recorded.
#[rstest]
#[case::moved_to_a_new_conversation("conversation-2", Some("conversation-1"))]
#[case::kept_its_conversation("conversation-1", None)]
#[tokio::test]
async fn a_relaunch_records_its_binding_and_the_conversation_it_left(
    #[case] resumed_handle: &str,
    #[case] left: Option<&str>,
) {
    let database = TestDatabase::new(schema_parts());
    let session_id = test_session_id();
    let PortOverLeg {
        port, pool, epochs, ..
    } = port_over_a_leg(&database, session_id).await;
    let binding_id = mint_runtime_binding_id();

    port.open_relaunch_binding(session_id, binding_id.clone())
        .await
        .expect("the relaunch's cursor opens");
    assert!(lock(&epochs).binding(&binding_id).is_ok());
    port.session_relaunched(session_id, resumed_on(binding_id.clone(), resumed_handle))
        .await
        .expect("the relaunch is recorded");

    let leg = read_session_leg(&pool, session_id)
        .await
        .expect("the leg reads")
        .expect("the session has a leg");
    assert_eq!(
        leg.id, binding_id,
        "the relaunch's binding is the session's leg"
    );
    let left_conversations = read_left_conversations(&database.reader(), &session_id)
        .expect("the left conversations read");
    assert_eq!(
        left_conversations
            .iter()
            .map(|record| record.conversation.conversation_id.as_str())
            .collect::<Vec<_>>(),
        left.into_iter().collect::<Vec<_>>(),
    );
}

// A relaunch that failed, or that the process already up on the leg answered, records nothing
// and forgets the cursor its opening opened, the leg's kept. Killed by the leg check dropped
// (the leg's binding, already open, is opened again and the relaunch fails, or it is recorded a
// second time), and by the opened cursor kept.
#[rstest]
#[case::answered_on_the_leg(true)]
#[case::failed(false)]
#[tokio::test]
async fn a_relaunch_that_records_nothing_forgets_its_opened_cursor(#[case] is_answered: bool) {
    let database = TestDatabase::new(schema_parts());
    let session_id = test_session_id();
    let PortOverLeg {
        port,
        pool,
        epochs,
        leg_id,
    } = port_over_a_leg(&database, session_id).await;
    let opened_id = mint_runtime_binding_id();

    port.open_relaunch_binding(session_id, opened_id.clone())
        .await
        .expect("the relaunch's cursor opens");
    let result = if is_answered {
        resumed_on(leg_id.clone(), "conversation-1")
    } else {
        DriverResumeResult::Failed {
            recovery_condition: RecoveryCondition::RecoveryNeeded,
            provider_failure_detail: FreeFormText::new("the test's resume fails".to_owned())
                .expect("a failure detail"),
        }
    };
    port.session_relaunched(session_id, result)
        .await
        .expect("the relaunch's result is taken");

    let leg = read_session_leg(&pool, session_id)
        .await
        .expect("the leg reads")
        .expect("the session has a leg");
    assert_eq!(leg.id, leg_id, "the leg stays the session's leg");
    assert!(
        read_left_conversations(&database.reader(), &session_id)
            .expect("the left conversations read")
            .is_empty(),
        "no conversation is left"
    );
    let epochs = lock(&epochs);
    assert!(
        epochs.binding(&opened_id).is_err(),
        "the opened cursor is forgotten"
    );
    assert!(
        epochs.binding(&leg_id).is_ok(),
        "the leg's cursor stays open"
    );
}

// The run folder is the session's newest live workspace's prepared root, else the folder it
// was bound to, else the checkout holding it, an archived workspace passed over. Killed by a
// `COALESCE` arm dropped and by the archived filter dropped.
#[rstest]
#[case::prepared(Some("/work/prepared"), json!({"boundRoot": "/work/bound"}), "/work/prepared")]
#[case::bound(
    None,
    json!({"boundRoot": "/work/bound", "checkoutRoot": "/work/checkout"}),
    "/work/bound"
)]
#[case::checkout(None, json!({"checkoutRoot": "/work/checkout"}), "/work/checkout")]
#[tokio::test]
async fn the_run_folder_reads_the_newest_live_workspace(
    #[case] fs_root: Option<&str>,
    #[case] metadata: Value,
    #[case] expected: &str,
) {
    let database = TestDatabase::new(schema_parts());
    let session_id = test_session_id();
    let PortOverLeg { port, .. } = port_over_a_leg(&database, session_id).await;
    let connection = database.reader();
    insert_session_row(&connection, session_id.text().as_str(), None, None);
    for row in project_and_mount_rows("mount", None) {
        connection
            .execute_batch(&row)
            .expect("the project and its mount are stored");
    }
    let insert_workspace =
        |id: &str, state: WorkspaceState, fs_root: Option<&str>, metadata: &Value, at: &str| {
            connection
                .execute(
                    "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, \
                 fs_root, state, metadata, created_at, updated_at) \
                 VALUES (?1, ?2, 'mount', ?3, ?4, ?5, ?6, ?7, ?7)",
                    params![
                        id,
                        session_id.text().as_str(),
                        <&'static str>::from(ExecutionMode::BoundRoot),
                        fs_root,
                        <&'static str>::from(state),
                        metadata.to_string(),
                        at
                    ],
                )
                .expect("the test stores a workspace");
        };
    insert_workspace(
        "live",
        WorkspaceState::Ready,
        fs_root,
        &metadata,
        "2026-10-14T09:30:00.000Z",
    );
    insert_workspace(
        "archived",
        WorkspaceState::Archived,
        Some("/work/archived"),
        &json!({}),
        "2026-10-15T09:30:00.000Z",
    );

    let folder = port
        .resolve_run_folder(session_id)
        .await
        .expect("the run folder reads");

    assert_eq!(folder, PathBuf::from(expected));
}
