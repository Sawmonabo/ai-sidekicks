use std::collections::BTreeMap;
use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::params;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::machine::settings::{MachineSettings, ProviderRowValue};
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::declaration::ProviderDeclarationId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::repo::mount::ExecutionMode;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::directory::{
    ChatBindingKind, ProjectBindingKind, SessionChatBinding, SessionCreateChatRequest,
    SessionCreateProjectRequest, SessionCreateRequest, SessionCreateResponse, SessionLead,
    SessionProjectBinding,
};
use sidekicks_contracts::session::groups::SessionGroupId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::record::Record;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_platforms::real_path;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::session_control::StartingLevel;
use sidekicks_provider::driver::test_registry::registry_of_first_provider;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_store::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
};
use sidekicks_store::events::session::appender::{SessionEventAppender, UnsequencedEventEnvelope};
use sidekicks_store::events::session::followers::SessionEventFollowers;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_workspace::clone::service::CloneAttachedListener;
use sidekicks_workspace::event_emitter::WorkspaceEventEmitter;
use sidekicks_workspace::git::process::test_git_runner;
use sidekicks_workspace::git::process::test_repository::make_test_repository;
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use sidekicks_workspace::managed::service::{ManagedWorkspaceService, SessionListRefresh};
use sidekicks_workspace::repo::mount::service::RepoMountService;
use sidekicks_workspace::repo::root_resolver::RepoRootResolver;
use sidekicks_workspace::service::{WorkspaceService, WorkspaceServiceDeps};
use sidekicks_workspace::test_rows::project_and_mount_rows;
use tempfile::TempDir;
use tokio::sync::mpsc;

use super::{SessionCreateError, SessionCreation, SessionCreationDeps};
use crate::directory::row::{DirectoryEvent, directory_statements_for};
use crate::questions::schema::schema_parts;

/// The project the fixture stores, its id its attached mount's too.
const PROJECT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e81";
const OTHER_PROJECT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e91";
const FIRST_ACCOUNT: &str = "account-a";
const SECOND_ACCOUNT: &str = "account-b";

// Long enough for a create that is not held by its key's lock to reach the append.
const UNHELD_REACH_BOUND: Duration = Duration::from_millis(500);

/// The machine's settings as a test sets them.
struct StoredSettings(Mutex<MachineSettings>);

impl MachineSettingsReader for StoredSettings {
    fn read_machine_settings(
        &self,
    ) -> BoxFuture<'_, Result<MachineSettings, Box<dyn Error + Send + Sync>>> {
        let settings = self
            .0
            .lock()
            .expect("the settings are not poisoned")
            .clone();
        async move { Ok(settings) }.boxed()
    }
}

/// A sessions list nothing reads.
struct UnreadList;

impl SessionListRefresh for UnreadList {
    fn refresh_session(&self, _session_id: SessionId) {}
}

/// The creation over a database whose events write the sessions' rows, holding the project
/// `PROJECT_ID` attached at a repository, and the lead's provider with two accounts, the first
/// current, its driver starting every session read-only in Plan and picking an advisor wherever
/// the app set one of its rows.
struct Fixture {
    database: TestDatabase,
    _scratch: TempDir,
    _writes: mpsc::Receiver<sidekicks_workspace::managed::write_watcher::ManagedWorkspaceReport>,
    settings: Arc<StoredSettings>,
    managed_workspaces: Arc<ManagedWorkspaceService>,
    creation: Arc<SessionCreation>,
}

impl Fixture {
    async fn new() -> Self {
        let database = TestDatabase::new(schema_parts());
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let event_log = Arc::new(EventLogService::new(EventLogServiceDependencies {
            writer: Arc::clone(&writer),
            pool: Arc::new(DatabaseReadPool::new(
                database.path(),
                EVENT_LOG_STATEMENT_CAPACITY,
            )),
            followers: Arc::new(SessionEventFollowers::default()),
            projection_statements: Some(Box::new(|envelope: &UnsequencedEventEnvelope| {
                Ok(directory_statements_for(&DirectoryEvent::from(envelope))?)
            })),
            refuse_session_write: None,
            read_damaged_from_sequence: None,
        }));
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let scratch_root = real_path(scratch.path()).expect("the scratch folder resolves");
        let repository = make_test_repository(&test_git_runner(), &scratch_root, "app").await;
        let rows = database.reader();
        for row in project_and_mount_rows(PROJECT_ID, None) {
            rows.execute_batch(&row)
                .expect("the project and its mount are stored");
        }
        rows.execute(
            "UPDATE repo_mounts SET local_path = ?1, canonical_root = ?1 WHERE id = ?2",
            params![repository.to_string_lossy(), PROJECT_ID],
        )
        .expect("the mount points at the repository");
        for (account, is_default) in [(FIRST_ACCOUNT, 1), (SECOND_ACCOUNT, 0)] {
            rows.execute(
                "INSERT INTO provider_accounts (account_id, provider, credential_home_path, \
                 billing_mode, is_default, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, 'unknown', ?4, '2026-10-21T09:00:00.000Z', \
                 '2026-10-21T09:00:00.000Z')",
                params![
                    account,
                    PROVIDERS[0].id,
                    scratch_root.join(account).to_string_lossy(),
                    is_default
                ],
            )
            .expect("the account is stored");
        }

        let reads = Arc::new(DatabaseReadPool::new(database.path(), 64));
        let events = Arc::new(WorkspaceEventEmitter::new(Arc::clone(&event_log)));
        let workspaces = Arc::new(WorkspaceService::new(WorkspaceServiceDeps {
            reads: Arc::clone(&reads),
            events: Arc::clone(&events),
            resolver: RepoRootResolver::new(test_git_runner()),
        }));
        let mounts = Arc::new(RepoMountService::new(
            Arc::clone(&writer),
            Arc::clone(&reads),
            events,
            RepoRootResolver::new(test_git_runner()),
            MachineId::new("machine".to_owned()).expect("the id is short"),
        ));
        let (writes_sender, writes) = mpsc::channel(64);
        let managed_workspaces = Arc::new(ManagedWorkspaceService::new(
            &scratch_root,
            None,
            mounts,
            test_git_runner(),
            writes_sender,
            Arc::new(UnreadList),
            std::time::SystemTime::now(),
        ));
        let mut driver = MockProviderDriver::new();
        driver
            .expect_session_advisor_pick()
            .returning(|app_values| (!app_values.as_map().is_empty()).then(|| Some(opus())));
        driver.expect_read_starting_level().returning(|_params| {
            async {
                Ok(StartingLevel::new(
                    PermissionLevel::Readonly,
                    SessionMode::Plan,
                ))
            }
            .boxed()
        });
        let settings = Arc::new(StoredSettings(Mutex::new(MachineSettings::default())));
        // The driver's own rule stands in as one refusal: it refuses every lead that sets an effort.
        driver
            .expect_check_lead_binding()
            .returning(|params| match params.effort {
                None => Ok(()),
                Some(effort) => Err(DomainError::new(
                    "The provider does not offer that effort",
                    RefusalCode::AgentProviderAxisInvalid,
                )
                .with_detail(
                    serde_json::json!({ "agentId": params.agent_id, "axis": "effort",
                "value": effort }),
                )
                .into()),
            });
        let creation = Arc::new(SessionCreation::new(SessionCreationDeps {
            reads,
            appender: Arc::new(SessionEventAppender::new(
                event_log,
                SESSION_EVENT_VERSION.clone(),
            )),
            providers: Arc::new(registry_of_first_provider(Arc::new(driver))),
            workspaces,
            managed_workspaces: Arc::clone(&managed_workspaces),
            settings: Arc::clone(&settings) as _,
        }));
        Self {
            database,
            _scratch: scratch,
            _writes: writes,
            settings,
            managed_workspaces,
            creation,
        }
    }

    /// Sets the app's advisor row for the lead's provider, which the driver reads as a pick.
    fn pick_advisor(&self) {
        let row_id = ProviderDeclarationId::new("advisor".to_owned()).expect("a row id");
        let rows = Record::new(BTreeMap::from([(
            row_id,
            ProviderRowValue::Value(Some(FreeFormText::new(opus()).expect("a value"))),
        )]))
        .expect("no row is named __proto__");
        let mut settings = self
            .settings
            .0
            .lock()
            .expect("the settings are not poisoned");
        settings.provider_settings = Record::new(BTreeMap::from([(lead_provider(), rows)]))
            .expect("no provider is named __proto__");
    }

    fn count(&self, sql: &str) -> i64 {
        self.database
            .reader()
            .query_row(sql, [], |row| row.get(0))
            .expect("the test counts rows")
    }

    fn text(&self, sql: &str) -> Option<String> {
        self.database
            .reader()
            .query_row(sql, [], |row| row.get(0))
            .expect("the test reads a value")
    }

    fn execute(&self, sql: &str) {
        self.database
            .reader()
            .execute_batch(sql)
            .expect("the test's change is stored");
    }

    /// Puts the project back to cloning, its folder detached.
    fn start_cloning(&self) {
        self.execute(&format!(
            "UPDATE repo_mounts SET state = 'detached' WHERE id = '{PROJECT_ID}';
             UPDATE projects SET state = 'cloning', clone_url = 'https://example.com/app.git', \
             clone_outcome = 'running' WHERE id = '{PROJECT_ID}';"
        ));
    }

    /// Ends the project's clone, its folder attached again.
    fn end_cloning(&self) {
        self.execute(&format!(
            "UPDATE projects SET state = 'active', clone_url = NULL, clone_outcome = NULL \
             WHERE id = '{PROJECT_ID}';
             UPDATE repo_mounts SET state = 'attached' WHERE id = '{PROJECT_ID}';"
        ));
    }
}

fn opus() -> String {
    "opus".to_owned()
}

fn lead_provider() -> ProviderId {
    ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id is a provider id")
}

fn new_key() -> ClientUuid {
    ClientUuid::new(mint_uuid_v7().to_string()).expect("a minted UUID is a client UUID")
}

fn lead() -> SessionLead {
    SessionLead {
        provider_name: lead_provider(),
        model_id: ProviderToken::new("model-a".to_owned()).expect("the model fits"),
        effort: None,
        output_speed: None,
        options: None,
        larger_window: None,
    }
}

fn project_request(key: ClientUuid, group_id: Option<SessionGroupId>) -> SessionCreateRequest {
    SessionCreateRequest::Project(SessionCreateProjectRequest {
        client_idempotency_key: key,
        binding: SessionProjectBinding {
            kind: ProjectBindingKind::Value,
            project_id: ProjectId::new(PROJECT_ID).expect("a project id"),
            execution_mode: ExecutionMode::BoundRoot,
        },
        lead: lead(),
        group_id,
    })
}

fn chat_request(key: ClientUuid) -> SessionCreateRequest {
    SessionCreateRequest::Chat(SessionCreateChatRequest {
        client_idempotency_key: key,
        binding: SessionChatBinding {
            kind: ChatBindingKind::Value,
        },
        lead: lead(),
        group_id: None,
    })
}

fn refusal_of(error: SessionCreateError) -> DomainError {
    match HandlerError::from(error) {
        HandlerError::Refused(refusal) => refusal,
        other @ (HandlerError::Internal(_) | HandlerError::Canceled) => {
            panic!("the create is refused, not failed: {other:?}")
        }
    }
}

fn refusal_code(error: SessionCreateError) -> RefusalCode {
    refusal_of(error).code
}

// Dies to the key lock removed: the second create, run while the first is held before its append,
// mints a session of its own and the first's record of the key is refused.
#[tokio::test]
async fn two_creates_with_one_key_make_one_session() {
    let fixture = Fixture::new().await;
    let request = project_request(new_key(), None);
    let first_held = fixture.creation.created_append_pause.arm();
    let second_held = fixture.creation.created_append_pause.arm();

    let first = fixture.creation.create(request.clone());
    let second = async {
        first_held
            .reached
            .await
            .expect("the first create reaches its append");
        let second = fixture.creation.create(request);
        let release = async {
            // Only a create the key's lock does not hold reaches its own append meanwhile.
            if tokio::time::timeout(UNHELD_REACH_BOUND, second_held.reached)
                .await
                .is_ok()
            {
                second_held
                    .release
                    .send(())
                    .expect("the second create waits");
            }
            first_held.release.send(()).expect("the first create waits");
        };
        tokio::join!(second, release).0
    };
    let (first, second) = tokio::join!(first, second);

    let first: SessionCreateResponse = first.expect("the first create lands");
    let second = second.expect("the second create answers the first's session");
    assert_eq!(second.session_id, first.session_id);
    assert_eq!(first.state, SessionState::Active);
    assert_eq!(fixture.count("SELECT count(*) FROM sessions"), 1);
}

// Dies to the account guard's expected count dropped: the session is then born on the account
// that stopped being current while its `session.created` was on its way.
#[tokio::test]
async fn a_create_runs_the_lead_on_the_account_made_current_on_its_way() {
    let fixture = Fixture::new().await;
    let held = fixture.creation.created_append_pause.arm();
    let request = project_request(new_key(), None);

    let create = fixture.creation.create(request);
    let move_current = async {
        held.reached.await.expect("the create reaches its append");
        fixture.execute(&format!(
            "UPDATE provider_accounts SET is_default = 0 WHERE account_id = '{FIRST_ACCOUNT}';
             UPDATE provider_accounts SET is_default = 1 WHERE account_id = '{SECOND_ACCOUNT}';"
        ));
        held.release.send(()).expect("the create waits");
    };
    let (created, ()) = tokio::join!(create, move_current);

    let created = created.expect("the create lands");
    let second = ProviderAccountId::new(SECOND_ACCOUNT.to_owned()).expect("an account id");
    assert_eq!(created.lead.provider_account_id, Some(second));
    assert_eq!(
        fixture.text(
            "SELECT json_extract(payload, '$.mainAgent.binding.providerAccountId') \
             FROM session_events WHERE type = 'session.created'"
        ),
        Some(SECOND_ACCOUNT.to_owned())
    );
}

// Dies to the group guard dropped from `session.created`'s prelude: the session is then born and
// its activation's placement silently writes nothing.
#[tokio::test]
async fn a_group_of_another_project_is_refused_and_nothing_lands() {
    let fixture = Fixture::new().await;
    let group_id = SessionGroupId::try_from(mint_uuid_v7()).expect("a minted UUID is a group id");
    for row in project_and_mount_rows(OTHER_PROJECT_ID, None)
        .iter()
        .take(1)
    {
        fixture.execute(row);
    }
    fixture.execute(&format!(
        "INSERT INTO session_groups (id, project_id, name, name_folded, created_at) \
         VALUES ('{group_id}', '{OTHER_PROJECT_ID}', 'Other', 'other', \
         '2026-10-21T09:00:00.000Z')"
    ));

    let refused = fixture
        .creation
        .create(project_request(new_key(), Some(group_id)))
        .await
        .expect_err("a group of another project is refused");

    assert_eq!(refusal_code(refused), RefusalCode::SessionGroupRefused);
    assert_eq!(fixture.count("SELECT count(*) FROM sessions"), 0);
    assert_eq!(
        fixture.count("SELECT count(*) FROM session_create_requests"),
        0
    );
}

// Dies to a listener that answers `Ok` without finishing: the session stays provisioning.
#[tokio::test]
async fn a_session_made_while_its_project_clones_is_finished_when_the_clone_attaches() {
    let fixture = Fixture::new().await;
    fixture.start_cloning();

    let created = fixture
        .creation
        .create(project_request(new_key(), None))
        .await
        .expect("the create lands");
    assert_eq!(created.state, SessionState::Provisioning);

    fixture.end_cloning();
    fixture
        .creation
        .clone_attached(ProjectId::new(PROJECT_ID).expect("a project id"))
        .await
        .expect("the clone's sessions are finished");

    let session = created.session_id;
    assert_eq!(
        fixture.text(&format!(
            "SELECT state FROM sessions WHERE id = '{session}'"
        )),
        Some("active".to_owned())
    );
    assert_eq!(
        fixture.count(&format!(
            "SELECT count(*) FROM workspaces WHERE session_id = '{session}'"
        )),
        1
    );
}

// Dies to the removal skipped when `session.created` fails: the chat's workspace is left behind;
// and to the start's removal taking the workspace of a chat whose create runs now.
#[tokio::test]
async fn a_chat_not_born_leaves_no_workspace_and_the_start_keeps_one_being_made() {
    let fixture = Fixture::new().await;
    let managed_mounts = "SELECT count(*) FROM repo_mounts WHERE origin = 'managed'";
    // A record of the key with no session refuses the chat's own record of it.
    let key = new_key();
    let orphan = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    fixture.execute(&format!(
        "INSERT INTO session_create_requests (client_idempotency_key, session_id, execution_mode) \
         VALUES ('{}', '{orphan}', 'boundRoot')",
        key.as_str()
    ));
    fixture
        .creation
        .create(chat_request(key))
        .await
        .expect_err("the chat's session.created is refused");
    assert_eq!(fixture.count(managed_mounts), 0);

    let unborn = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    let unborn_folder = fixture
        .managed_workspaces
        .create(unborn)
        .await
        .expect("a stopped create's workspace is made")
        .path;
    let held = fixture.creation.created_append_pause.arm();
    let request = chat_request(new_key());
    let create = fixture.creation.create(request);
    let start = async {
        held.reached.await.expect("the chat reaches its append");
        fixture
            .creation
            .finish_stopped_creates()
            .await
            .expect("the stopped creates are finished");
        assert_eq!(fixture.count(managed_mounts), 1);
        held.release.send(()).expect("the chat waits");
    };
    let (created, ()) = tokio::join!(create, start);

    let created = created.expect("the chat being made is born");
    assert_eq!(created.state, SessionState::Active);
    assert!(!unborn_folder.exists());
    assert_eq!(
        fixture.count(&format!(
            "SELECT count(*) FROM repo_mounts WHERE managed_session_id = '{}'",
            created.session_id
        )),
        1
    );
}

// Dies to the level statement omitted from `session.activated`'s prelude, and to the advisor's
// birth row written unconditionally.
#[tokio::test]
async fn a_session_starts_at_its_drivers_level_and_mode_with_the_picked_advisor() {
    let fixture = Fixture::new().await;
    let unpicked = fixture
        .creation
        .create(project_request(new_key(), None))
        .await
        .expect("the create lands")
        .session_id;
    fixture.pick_advisor();
    let picked = fixture
        .creation
        .create(chat_request(new_key()))
        .await
        .expect("the create lands")
        .session_id;

    for session in [unpicked, picked] {
        assert_eq!(
            fixture.text(&format!(
                "SELECT permission_level FROM sessions WHERE id = '{session}'"
            )),
            Some("readonly".to_owned())
        );
        assert_eq!(
            fixture.text(&format!(
                "SELECT session_mode FROM session_console_state WHERE session_id = '{session}'"
            )),
            Some("plan".to_owned())
        );
    }
    let advisor = |session: SessionId| {
        fixture.text(&format!(
            "SELECT CASE advisor_set WHEN 1 THEN coalesce(advisor_model, 'off') END \
             FROM session_console_state WHERE session_id = '{session}'"
        ))
    };
    assert_eq!(advisor(unpicked), None);
    assert_eq!(advisor(picked), Some(opus()));
}

fn token(text: &str) -> ProviderToken {
    ProviderToken::new(text.to_owned()).expect("the token fits")
}

// Dies to the driver's check of the lead's binding dropped: the session is then born on an axis
// its driver refuses, to fail at its first run.
#[tokio::test]
async fn a_lead_binding_its_driver_refuses_is_refused_and_nothing_lands() {
    let fixture = Fixture::new().await;
    let SessionCreateRequest::Project(mut request) = project_request(new_key(), None) else {
        unreachable!("the request is a project's");
    };
    request.lead.effort = Some(token("max"));

    let refusal = refusal_of(
        fixture
            .creation
            .create(SessionCreateRequest::Project(request))
            .await
            .expect_err("a binding the driver refuses is refused"),
    );

    assert_eq!(refusal.code, RefusalCode::AgentProviderAxisInvalid);
    assert_eq!(fixture.count("SELECT count(*) FROM sessions"), 0);
    assert_eq!(
        fixture.count("SELECT count(*) FROM session_create_requests"),
        0
    );
}

// Dies to the provisioning guard dropped from `session.activated`'s prelude: the session archived
// while its finish ran is then set active.
#[tokio::test]
async fn a_session_archived_while_its_finish_runs_stays_archived() {
    let fixture = Fixture::new().await;
    let held = fixture.creation.activated_append_pause.arm();
    let create = fixture.creation.create(project_request(new_key(), None));
    let archive = async {
        held.reached.await.expect("the finish reaches its append");
        fixture.execute("UPDATE sessions SET state = 'archived'");
        held.release.send(()).expect("the finish waits");
    };
    let (created, ()) = tokio::join!(create, archive);

    assert_eq!(
        created.expect("the create answers").state,
        SessionState::Archived
    );
    assert_eq!(
        fixture.text("SELECT state FROM sessions"),
        Some("archived".to_owned())
    );
    assert_eq!(
        fixture.count("SELECT count(*) FROM session_events WHERE type = 'session.activated'"),
        0
    );
}

// Dies to the finish's driver lookup answered as the registry refuses it: the retry then answers
// `provider.notFound`, which the create does not declare.
#[tokio::test]
async fn a_retry_whose_lead_driver_is_gone_is_refused_on_the_provider_axis() {
    let fixture = Fixture::new().await;
    fixture.start_cloning();
    let request = project_request(new_key(), None);
    let created = fixture
        .creation
        .create(request.clone())
        .await
        .expect("the create lands");
    assert_eq!(created.state, SessionState::Provisioning);
    fixture.end_cloning();
    fixture.execute(
        "UPDATE session_events \
         SET payload = json_set(payload, '$.mainAgent.binding.providerName', 'gone') \
         WHERE type = 'session.created'",
    );

    let refused = fixture
        .creation
        .create(request)
        .await
        .expect_err("a lead whose driver is gone is refused");

    assert_eq!(refusal_code(refused), RefusalCode::AgentProviderAxisInvalid);
}

// Dies to the create run in its caller's future: the caller dropped mid-way then drops the create
// with it, which leaves the session provisioning.
#[tokio::test]
async fn a_create_whose_caller_stops_waiting_still_activates_its_session() {
    let fixture = Fixture::new().await;
    let held = fixture.creation.activated_append_pause.arm();
    let key = new_key();
    let mut create = Box::pin(fixture.creation.create(project_request(key.clone(), None)));
    tokio::select! {
        created = &mut create => panic!("the create waits at its append: {created:?}"),
        reached = held.reached => reached.expect("the finish reaches its append"),
    }
    drop(create);
    held.release
        .send(())
        .expect("the create runs on without its caller");

    // The key is held until the create's own task ends.
    let _hold = fixture.creation.key_lock.acquire(key).await;
    assert_eq!(
        fixture.text("SELECT state FROM sessions"),
        Some("active".to_owned())
    );
}
