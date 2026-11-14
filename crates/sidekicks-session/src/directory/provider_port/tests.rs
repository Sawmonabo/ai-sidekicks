//! The port's opening's tool servers and helper policy, its relaunch record, its run folder, its
//! git folder and a spawn context's memory switch.

use std::collections::BTreeMap;
use std::error::Error;
use std::ffi::OsStr;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::settings::{MachineSettings, ProviderKnobs};
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::{
    McpApprovalMode, McpBindingScope, McpServerBindingRef, McpServerName, McpServerStatus,
};
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::record::Record;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_ipc::stream::feed::{CreditGate, Feed};
use sidekicks_mcp::binding::resolver::McpAttributionTable;
use sidekicks_mcp::binding::session_tool_servers::McpSessionToolServers;
use sidekicks_mcp::binding::store::{MCP_BINDING_STORE_STATEMENT_CAPACITY, McpBindingStore};
use sidekicks_mcp::status::open_test_tracker;
use sidekicks_platforms::Spawner;
use sidekicks_provider::driver::mcp_server::read::{
    McpServerDeclaration, McpServerPolicy, McpServerToolDefaults, ProviderMcpServersReading,
};
use sidekicks_provider::driver::mcp_server::status::{McpServerReading, McpServerStatusEmission};
use sidekicks_provider::driver::ports::SessionRelaunchListener;
use sidekicks_provider::driver::session_control::{
    DriverResumeResult, SessionToolServer, SubagentPolicy,
};
use sidekicks_provider::driver::test_registry::TestProviderAccounts;
use sidekicks_provider::driver::{
    CurrentProviderAccount, PROVIDERS, ProviderAccountReader, SessionSpawnContextResolver,
};
use sidekicks_provider::left_conversations::read_left_conversations;
use sidekicks_provider::runtime_binding::store::{
    CreateRuntimeBindingInput, RUNTIME_BINDING_STORE_STATEMENT_CAPACITY, RuntimeBindingSpawnConfig,
    RuntimeBindingStore, mint_runtime_binding_id,
};
use sidekicks_provider::runtime_binding::test_store::{
    binding_input, spawn_config_on, spawned_build, test_provider_account_id,
};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{
    TestDatabase, insert_lead, test_run_id, test_session_id,
};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_workspace::git::process::test_repository::make_test_repository;
use sidekicks_workspace::git::process::{GitCall, GitLimits, GitRunner, test_git_runner};
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use sidekicks_workspace::project::records::{
    PROJECT_RECORDS_STATEMENT_CAPACITY, ProjectRecords, ProjectSessionActivity, ProjectSessionFacts,
};
use sidekicks_workspace::test_rows::project_and_mount_rows;

use super::{
    GitFolderUnavailable, OpeningToolServers, SESSION_DIRECTORY_PROVIDER_PORT_STATEMENT_CAPACITY,
    SessionDirectoryProviderPort, SessionDirectoryProviderPortDeps, SessionGitFolder,
};
use crate::agents::projection::test_fixture::{binding, write_log_row};
use crate::console_state::auto_memory_change_statement;
use crate::run::binding_cursors::{RUN_BINDING_CURSORS_STATEMENT_CAPACITY, RunBindingCursors};
use crate::run::engine::test_fixture::insert_run;
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

// A settings file whose one knob set is `Helpers at once` at `limit`, on `provider`.
struct HelpersAtOnce {
    provider: ProviderId,
    limit: SafeInt<0>,
}

impl MachineSettingsReader for HelpersAtOnce {
    fn read_machine_settings(
        &self,
    ) -> BoxFuture<'_, Result<MachineSettings, Box<dyn Error + Send + Sync>>> {
        let knobs = ProviderKnobs {
            helpers_at_once: Some(Some(self.limit)),
            ..ProviderKnobs::default()
        };
        let provider_knobs = Record::new(BTreeMap::from([(self.provider.clone(), knobs)]))
            .expect("a provider id is never `__proto__`");
        async move {
            Ok(MachineSettings {
                provider_knobs,
                ..MachineSettings::default()
            })
        }
        .boxed()
    }
}

// A port over a session whose leg runs on `conversation-1`, with the tracker's stream of the
// bindings it first observes and its accounts port registered by the test that reads an account.
struct PortOverLeg<FirstObservations> {
    port: SessionDirectoryProviderPort,
    pool: Arc<DatabaseReadPool>,
    epochs: Arc<Mutex<ExecutionEpochs>>,
    leg_id: RuntimeBindingId,
    first_observations: FirstObservations,
    mcp_attribution: Arc<McpAttributionTable>,
    provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
}

// A port over a session whose leg was stored with `spawn_config`.
async fn port_over_a_leg(
    database: &TestDatabase,
    session_id: SessionId,
    git: GitRunner,
    spawn_config: RuntimeBindingSpawnConfig,
    settings: Arc<dyn MachineSettingsReader>,
) -> PortOverLeg<impl Feed<Emission = McpServerBindingRef>> {
    // One writer for the file, as the daemon keeps one.
    let writer = Arc::new(
        DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database"),
    );
    let run_id = test_run_id();
    insert_run(database, session_id, run_id, "running");
    let pool = Arc::new(DatabaseReadPool::new(
        database.path(),
        SESSION_DIRECTORY_PROVIDER_PORT_STATEMENT_CAPACITY
            + RUN_BINDING_CURSORS_STATEMENT_CAPACITY
            + PROJECT_RECORDS_STATEMENT_CAPACITY
            + MCP_BINDING_STORE_STATEMENT_CAPACITY
            + RUNTIME_BINDING_STORE_STATEMENT_CAPACITY,
    ));
    let store = RuntimeBindingStore::new(Arc::clone(&pool), Arc::clone(&writer));
    let epochs = Arc::new(Mutex::new(ExecutionEpochs::new(
        NonZeroUsize::new(8).expect("the cap is not zero"),
    )));
    let binding_cursors = Arc::new(RunBindingCursors::new(
        Arc::clone(&pool),
        Arc::new(|_: &SessionId| None),
        Arc::new(store),
        Arc::clone(&epochs),
    ));
    let leg = CreateRuntimeBindingInput {
        run_id,
        ..binding_input(spawn_config, spawned_build("1.0.0", "/opt/provider/bin"))
    };
    let leg_id = leg.id.clone();
    binding_cursors
        .create(session_id, leg)
        .await
        .expect("the leg is recorded");
    // The session is in no project, so its relaunch's leg attributes at no root.
    let (mcp_status, _subscriber, first_observations) = open_test_tracker().await;
    let mcp_attribution = Arc::new(McpAttributionTable::default());
    let mcp_store = McpBindingStore::new(writer, Arc::clone(&pool));
    let provider_accounts = Arc::new(PortRegistration::new("provider accounts"));
    let port = SessionDirectoryProviderPort::new(SessionDirectoryProviderPortDeps {
        pool: Arc::clone(&pool),
        read_damaged_from_sequence: Arc::new(|_: &SessionId| None),
        binding_cursors,
        git,
        settings,
        project_records: Arc::new(ProjectRecords::new(Arc::clone(&pool), Arc::new(Unread))),
        provider_accounts: Arc::clone(&provider_accounts),
        mcp_status,
        mcp_attribution: Arc::clone(&mcp_attribution),
        mcp_tool_servers: Arc::new(McpSessionToolServers::new(
            Arc::clone(&mcp_attribution),
            mcp_store,
        )),
    });
    PortOverLeg {
        port,
        pool,
        epochs,
        leg_id,
        first_observations,
        mcp_attribution,
        provider_accounts,
    }
}

// A relaunch's `Resumed` on `binding_id`, running conversation `resume_handle`, naming no runs.
fn resumed_on(binding_id: RuntimeBindingId, resume_handle: &str) -> DriverResumeResult {
    DriverResumeResult::Resumed {
        binding_id,
        session_position: SafeInt::new(1).expect("a position"),
        resume_handle: NonEmptyText::new(resume_handle.to_owned()).expect("a resume handle"),
        spawned_version: spawned_build("1.1.0", "/opt/provider/bin"),
        runs: Vec::new(),
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
    } = port_over_a_leg(
        &database,
        session_id,
        test_git_runner(),
        spawn_config_on(test_provider_account_id()),
        Arc::new(Unread),
    )
    .await;
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
        ..
    } = port_over_a_leg(
        &database,
        session_id,
        test_git_runner(),
        spawn_config_on(test_provider_account_id()),
        Arc::new(Unread),
    )
    .await;
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

// A relaunch that keeps the leg's binding attributes `github`, reported over an empty table, to
// the binding the leg's stored set sent under that name, which the tracker then hands on as first
// observed. Killed by a relaunch composing no set (the report is held, nothing is handed on).
#[tokio::test]
async fn a_relaunch_resolves_the_set_its_binding_stored() {
    let database = TestDatabase::new(schema_parts());
    let session_id = test_session_id();
    let server_name = McpServerName::new("github".to_owned()).expect("a server name");
    let user_github = McpServerBindingRef::User {
        provider: ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id is a provider id"),
        server_name: server_name.clone(),
    };
    let PortOverLeg {
        port,
        mut first_observations,
        ..
    } = port_over_a_leg(
        &database,
        session_id,
        test_git_runner(),
        RuntimeBindingSpawnConfig {
            tool_servers: Some(vec![SessionToolServer {
                binding: user_github.clone(),
                is_enabled: true,
            }]),
            ..spawn_config_on(test_provider_account_id())
        },
        Arc::new(Unread),
    )
    .await;

    let producer = port
        .compose_relaunch_legs(session_id, mint_runtime_binding_id())
        .await
        .expect("the relaunch's legs compose")
        .on_mcp_server_status
        .expect("a session with a leg has a producer");
    producer.report_status(McpServerStatusEmission::new(
        server_name,
        McpServerReading::Observed(McpServerStatus::Connected),
        None,
        None,
    ));

    let first_observed = first_observations
        .next(&CreditGate::with_credit(1))
        .now_or_never();
    assert!(
        matches!(&first_observed, Some(Ok(Some(binding))) if *binding == user_github),
        "{first_observed:?}"
    );
    drop(producer);
}

// A resume's opening sends the set its leg stored, with no wait. An opening at `/repos/app` of a
// driver that takes a set waits on the attribution table's first fill, then sends the person's
// `user` binding on, the project's own binding of that root off as the daemon's switch keeps it,
// and leaves another project's binding out; a driver that takes no set gets none, with no wait.
// Killed by an opening that sends no set, by one composed before the fill, by a set that keeps
// every project's bindings, by a set that ignores the store's switch, by a set composed for a
// driver that takes none, and by a resume's opening that composes a set or waits on the fill in
// place of sending the set its leg stored.
#[rstest]
#[case::taking_a_set(true)]
#[case::taking_none(false)]
#[tokio::test]
async fn an_opening_sends_the_persons_servers_at_its_root(#[case] takes_tool_servers: bool) {
    let descriptor = PROVIDERS
        .iter()
        .find(|descriptor| descriptor.takes_session_tool_servers == takes_tool_servers)
        .expect("a provider of each kind");
    let database = TestDatabase::new(schema_parts());
    let session_id = test_session_id();
    let PortOverLeg {
        port,
        mcp_attribution,
        ..
    } = port_over_a_leg(
        &database,
        session_id,
        test_git_runner(),
        spawn_config_on(test_provider_account_id()),
        Arc::new(Unread),
    )
    .await;
    let connection = database.reader();
    store_session_and_mount(&connection, session_id);
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let repository = make_test_repository(&test_git_runner(), folder.path(), "app").await;
    let fs_root = repository.to_string_lossy().into_owned();
    insert_workspace(
        &connection,
        session_id,
        "live",
        WorkspaceState::Ready,
        Some(&fs_root),
        &json!({}),
        "2026-10-14T09:30:00.000Z",
    );
    insert_lead(&database, session_id, descriptor.id);
    let provider = ProviderId::new(descriptor.id.to_owned()).expect("a table id is a provider id");
    let project_binding = |root: &str, name: &str| McpServerBindingRef::Project {
        provider: provider.clone(),
        scope_ref: FilesystemPath::new(root.to_owned()).expect("a test path is a path"),
        place: None,
        server_name: McpServerName::new(name.to_owned()).expect("a server name"),
    };
    let user_docs = McpServerBindingRef::User {
        provider: provider.clone(),
        server_name: McpServerName::new("docs".to_owned()).expect("a server name"),
    };
    let app_tracker = project_binding("/repos/app", "tracker");
    let declaration = |binding: &McpServerBindingRef| McpServerDeclaration {
        binding: binding.clone(),
        config: McpServerConfigView::Stdio {
            command: "server".to_owned(),
            args: None,
            env_var_names: None,
            enabled: None,
            required: None,
            startup_timeout_sec: None,
            tool_timeout_sec: None,
        },
        superseded_in: Vec::new(),
        disabled_in: Vec::new(),
        is_read_only: false,
        sign_in_settings: None,
        is_switch_kept_by_daemon: true,
        tool_defaults: McpServerToolDefaults::with_approval_mode(McpApprovalMode::Auto),
        organization_managed: None,
    };
    connection
        .execute(
            "INSERT INTO mcp_server_bindings (provider, scope, scope_ref, scope_place, \
             server_name, enabled_override, first_observed_at, updated_at) \
             VALUES (?1, ?2, '/repos/app', '', 'tracker', 0, ?3, ?3)",
            params![
                provider.as_str(),
                <&'static str>::from(McpBindingScope::Project),
                "2026-10-14T09:30:00.000Z"
            ],
        )
        .expect("the daemon's switch of the project's server is stored");
    // A resume's opening, before any fill, sends the set its leg stored as stored, at once.
    let stored = vec![SessionToolServer {
        binding: project_binding("/repos/other", "mail"),
        is_enabled: true,
    }];
    let resumed = tokio::time::timeout(
        SETTLE_BOUND,
        port.compose_opening(
            session_id,
            test_provider_account_id(),
            OpeningToolServers::Stored(Some(stored.clone())),
        ),
    )
    .await
    .expect("a stored set waits on no fill")
    .expect("the session resumes");
    assert_eq!(resumed.create_params.tool_servers, Some(stored));
    let mut opening = std::pin::pin!(port.compose_opening(
        session_id,
        test_provider_account_id(),
        OpeningToolServers::Composed,
    ));

    if takes_tool_servers {
        assert!(
            tokio::time::timeout(HELD_BOUND, opening.as_mut())
                .await
                .is_err(),
            "the opening waits on the table's first fill"
        );
        mcp_attribution.replace_with_reading(
            &provider,
            &ProviderMcpServersReading {
                declarations: [
                    &user_docs,
                    &app_tracker,
                    &project_binding("/repos/other", "mail"),
                ]
                .into_iter()
                .map(declaration)
                .collect(),
                roots: Vec::new(),
                is_machine_managed: false,
                server_policy: McpServerPolicy::default(),
                account_servers: Vec::new(),
                probe_readings: Vec::new(),
                failed_roots: Vec::new(),
            },
        );
    }
    let opening = tokio::time::timeout(SETTLE_BOUND, opening)
        .await
        .expect("the opening settles")
        .expect("the session opens");

    let expected = takes_tool_servers.then(|| {
        vec![
            SessionToolServer {
                binding: user_docs,
                is_enabled: true,
            },
            SessionToolServer {
                binding: app_tracker,
                is_enabled: false,
            },
        ]
    });
    assert_eq!(opening.create_params.tool_servers, expected);
}

/// How long an opening is watched to stay held before the table's first fill.
const HELD_BOUND: Duration = Duration::from_millis(200);

/// How long an opening may take once nothing holds it.
const SETTLE_BOUND: Duration = Duration::from_secs(5);

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
    let PortOverLeg { port, .. } = port_over_a_leg(
        &database,
        session_id,
        test_git_runner(),
        spawn_config_on(test_provider_account_id()),
        Arc::new(Unread),
    )
    .await;
    let connection = database.reader();
    store_session_and_mount(&connection, session_id);
    insert_workspace(
        &connection,
        session_id,
        "live",
        WorkspaceState::Ready,
        fs_root,
        &metadata,
        "2026-10-14T09:30:00.000Z",
    );
    insert_workspace(
        &connection,
        session_id,
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

// A session with no folder named yet and one whose folder git refuses, as once its worktree is
// deleted, read as unavailable, a refusal; any other failure, here git not found, fails the read.
// Killed by either unavailable case answered as a failure, and by every failure answered as
// unavailable.
#[rstest]
#[case::no_folder_named(false, true, Some("noRunFolder"))]
#[case::folder_gone(true, true, Some("refused"))]
#[case::git_not_found(true, false, None)]
#[tokio::test]
async fn a_git_folder_that_is_gone_or_not_named_is_unavailable(
    #[case] is_folder_named: bool,
    #[case] is_git_found: bool,
    #[case] unavailable: Option<&str>,
) {
    let database = TestDatabase::new(schema_parts());
    let session_id = test_session_id();
    let git = if is_git_found {
        test_git_runner()
    } else {
        GitRunner::new(
            Spawner::new(tokio::runtime::Handle::current()).expect("the spawner thread starts"),
            None,
            Arc::from([]),
            GitLimits::DAEMON,
        )
    };
    let PortOverLeg { port, .. } = port_over_a_leg(
        &database,
        session_id,
        git,
        spawn_config_on(test_provider_account_id()),
        Arc::new(Unread),
    )
    .await;
    let connection = database.reader();
    store_session_and_mount(&connection, session_id);
    let folder = tempfile::tempdir().expect("the test makes a folder");
    if is_folder_named {
        let fs_root = folder.path().to_string_lossy().into_owned();
        insert_workspace(
            &connection,
            session_id,
            "live",
            WorkspaceState::Ready,
            Some(&fs_root),
            &json!({}),
            "2026-10-14T09:30:00.000Z",
        );
    }
    if is_git_found {
        folder.close().expect("the folder is removed");
    }

    let read = port.read_git_folder(session_id).await;

    let answered = match &read {
        Ok(SessionGitFolder::Unavailable(GitFolderUnavailable::NoRunFolder)) => Some("noRunFolder"),
        Ok(SessionGitFolder::Unavailable(GitFolderUnavailable::Refused(_))) => Some("refused"),
        Ok(SessionGitFolder::Available(_)) | Err(_) => None,
    };
    assert_eq!(answered, unavailable, "{read:?}");
    if unavailable.is_none() {
        assert!(read.is_err(), "{read:?}");
    }
}

// A spawn context carries the session's own `Auto memory` switch, unset where the person never set
// it. Killed by the switch left off the read (every case reads unset) and by a fixed value.
#[rstest]
#[case::never_set(None)]
#[case::off(Some(false))]
#[case::on(Some(true))]
#[tokio::test]
async fn a_spawn_context_carries_the_sessions_memory_switch(#[case] auto_memory: Option<bool>) {
    let database = TestDatabase::new(schema_parts());
    let session_id = test_session_id();
    let PortOverLeg {
        port,
        provider_accounts,
        ..
    } = port_over_a_leg(
        &database,
        session_id,
        test_git_runner(),
        spawn_config_on(test_provider_account_id()),
        Arc::new(Unread),
    )
    .await;
    let connection = database.reader();
    store_session_and_mount(&connection, session_id);
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let fs_root = folder.path().to_string_lossy().into_owned();
    insert_workspace(
        &connection,
        session_id,
        "live",
        WorkspaceState::Ready,
        Some(&fs_root),
        &json!({}),
        "2026-10-14T09:30:00.000Z",
    );
    let accounts: Arc<dyn ProviderAccountReader> = Arc::new(TestProviderAccounts::holding_folder(
        CurrentProviderAccount::Current(test_provider_account_id()),
        Some(folder.path().to_path_buf()),
    ));
    provider_accounts
        .register(accounts)
        .expect("the accounts reader registers");
    // Git refuses a removed folder, so the git folder reads as none.
    folder.close().expect("the folder is removed");
    if let Some(is_enabled) = auto_memory {
        DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens")
            .write(vec![auto_memory_change_statement(
                &session_id,
                is_enabled,
                "2026-10-14T09:30:00.000Z",
            )])
            .await
            .expect("the switch is written");
    }

    let context = port
        .resolve_spawn_context(session_id, test_provider_account_id())
        .await
        .expect("the spawn context resolves");

    assert_eq!(context.auto_memory, auto_memory);
}

// An opening carries the helper policy of `Helpers at once` as set for the lead's provider: unset
// there, with `0` set for another provider, it runs helpers with no limit, `0` there runs none,
// and a count there is that limit. Killed by the policy left out, by the knob read for another
// provider, by the knob never read, and by a count read as no limit or as helpers switched off.
#[rstest]
#[case::set_for_another_provider(1, 0, SubagentPolicy::Enabled {
    helpers_at_once: None,
    definitions: Vec::new(),
})]
#[case::zero_for_the_leads_provider(0, 0, SubagentPolicy::Disabled {})]
#[case::a_count_for_the_leads_provider(0, 3, SubagentPolicy::Enabled {
    helpers_at_once: SafeInt::new(3),
    definitions: Vec::new(),
})]
#[tokio::test]
async fn compose_opening_carries_the_leads_providers_helpers_at_once(
    #[case] knob_provider: usize,
    #[case] limit: u64,
    #[case] expected: SubagentPolicy,
) {
    let database = TestDatabase::new(schema_parts());
    let session_id = test_session_id();
    let settings = HelpersAtOnce {
        provider: ProviderId::new(PROVIDERS[knob_provider].id.to_owned())
            .expect("a registered provider id"),
        limit: SafeInt::new(limit).expect("a small count is a limit"),
    };
    let PortOverLeg { port, .. } = port_over_a_leg(
        &database,
        session_id,
        test_git_runner(),
        spawn_config_on(test_provider_account_id()),
        Arc::new(settings),
    )
    .await;
    let connection = database.reader();
    store_session_and_mount(&connection, session_id);
    let folder = tempfile::tempdir().expect("the test makes a folder");
    test_git_runner()
        .run(
            None,
            GitCall::read([OsStr::new("init"), folder.path().as_os_str()]),
        )
        .await
        .expect("the repository is made");
    let fs_root = folder.path().to_string_lossy().into_owned();
    insert_workspace(
        &connection,
        session_id,
        "live",
        WorkspaceState::Ready,
        Some(&fs_root),
        &json!({}),
        "2026-10-14T09:30:00.000Z",
    );
    let lead_binding = binding(PROVIDERS[0].id, "model-a");
    let lead = json!({ "agentId": mint_uuid_v7().to_string(), "binding": lead_binding });
    write_log_row(
        &connection,
        session_id,
        0,
        (
            SessionEventType::SessionCreated,
            &json!({ "mainAgent": lead }),
        ),
        None,
        "2026-10-14T09:00:00.000Z",
    );

    let opening = port
        .compose_opening(
            session_id,
            test_provider_account_id(),
            OpeningToolServers::Composed,
        )
        .await
        .expect("the opening composes");

    assert_eq!(opening.create_params.subagent_policy, Some(expected));
}

// The id of the project and of its mount, which a project's reads parse as ids.
const PROJECT_AND_MOUNT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e80";

// Stores `session_id`'s row and the project mount its workspaces are of.
fn store_session_and_mount(connection: &Connection, session_id: SessionId) {
    insert_session_row(connection, session_id.text().as_str(), None, None);
    for row in project_and_mount_rows(PROJECT_AND_MOUNT_ID, None) {
        connection
            .execute_batch(&row)
            .expect("the project and its mount are stored");
    }
}

// Stores a workspace `id` of `session_id` in `state`, prepared at `fs_root` where it names one.
fn insert_workspace(
    connection: &Connection,
    session_id: SessionId,
    id: &str,
    state: WorkspaceState,
    fs_root: Option<&str>,
    metadata: &Value,
    at: &str,
) {
    connection
        .execute(
            "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, \
             state, metadata, created_at, updated_at) \
             VALUES (?1, ?2, ?8, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                id,
                session_id.text().as_str(),
                <&'static str>::from(ExecutionMode::BoundRoot),
                fs_root,
                <&'static str>::from(state),
                metadata.to_string(),
                at,
                PROJECT_AND_MOUNT_ID
            ],
        )
        .expect("the test stores a workspace");
}
