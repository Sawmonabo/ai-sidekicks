use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures::future::ready;
use rstest::rstest;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::settings::{EnvironmentRow, MachineSettings};
use sidekicks_contracts::mcp::server::config::{McpServerAddress, McpServerConfigView};
use sidekicks_contracts::mcp::server::{McpApprovalMode, McpServerBindingRef, McpServerName};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::CurrentProviderAccount;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::sign_in::{McpServerAddressReading, NoPersonServerEntry};
use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
use sidekicks_provider::driver::mcp_server::read::{
    McpServerDeclaration, McpServerPolicy, McpServerSignInSettings, McpServerToolDefaults,
    ProviderMcpServersReading,
};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::test_registry::{
    first_provider, registered_test_accounts, registry_of_first_providers,
};
use sidekicks_provider::runtime_binding::test_store::test_provider_account_id;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_workspace::machine_settings::FixedMachineSettings;
use sidekicks_workspace::project::records::ProjectRecords;
use sidekicks_workspace::project::test_doubles::NoSessions;
use sidekicks_workspace::test_rows::project_and_mount_rows;

use reqwest::Url;

use super::{SignInTargetReads, root_folder_of};
use crate::errors::SignInUnsupportedReason;
use crate::inventory_service::McpInventoryService;
use crate::mutation::receipts::tests::receipts_over_a_database;
use crate::sign_in::service::SignInServer;
use crate::status::notices::McpNoticeBoard;
use crate::test_inventory::open_test_inventory;

/// The whole address the test entry declares, its user name and query kept.
const DECLARED_ADDRESS: &str = "https://user@docs.example.test/mcp?key=k";

/// The project a test attaches at `/repos/app`, its id its mount's too.
const PROJECT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e81";

/// The real inventory over a test's drivers, with the database, writer, read pool and board
/// under it, which a sign-in's target and its receipts are read from.
pub(crate) struct TestSources {
    /// The registered providers, each answered by its test driver.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// The inventory over them.
    pub(crate) inventory: Arc<McpInventoryService>,
    /// The writer the receipts and the binding store go through.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The read pool the receipts and the binding store are read on.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The board the inventory's tracker sends on.
    pub(crate) board: Arc<McpNoticeBoard>,
    /// The database under them, which a test stores rows in.
    pub(crate) database: TestDatabase,
}

impl TestSources {
    /// The target reads over these sources, the accounts answering the test account as every
    /// provider's current one and the machine's settings their defaults, with no rows.
    pub(crate) fn target_reads(&self) -> SignInTargetReads {
        self.target_reads_over(MachineSettings::default())
    }

    /// The target reads over these sources, as [`Self::target_reads`] reads them, the
    /// machine's settings answering `settings`.
    pub(crate) fn target_reads_over(&self, settings: MachineSettings) -> SignInTargetReads {
        SignInTargetReads::new(
            Arc::clone(&self.inventory),
            Arc::clone(&self.providers),
            registered_test_accounts(CurrentProviderAccount::Current(test_provider_account_id())),
            Arc::new(FixedMachineSettings(settings)),
            Arc::new(ProjectRecords::new(
                Arc::clone(&self.reads),
                Arc::new(NoSessions),
            )),
        )
    }
}

/// Fresh sources whose registry holds the table's first providers, answered by `drivers` in
/// order.
pub(crate) async fn test_sources(drivers: Vec<Arc<dyn ProviderDriver>>) -> TestSources {
    let (database, _receipts, writer, reads) = receipts_over_a_database().await;
    let providers = Arc::new(registry_of_first_providers(drivers));
    let board = Arc::new(McpNoticeBoard::default());
    let inventory = open_test_inventory(
        Arc::clone(&providers),
        Arc::clone(&writer),
        Arc::clone(&reads),
        Arc::clone(&board),
    )
    .await;
    TestSources {
        providers,
        inventory: inventory.service,
        writer,
        reads,
        board,
        database,
    }
}

fn server_name(name: &str) -> McpServerName {
    McpServerName::new(name.to_owned()).expect("a server name")
}

/// The first provider's `user` binding of the server `docs`.
pub(crate) fn docs_binding() -> McpServerBindingRef {
    McpServerBindingRef::User {
        provider: first_provider(),
        server_name: server_name("docs"),
    }
}

/// A declaration of `binding` reached over streamable HTTP at the stripped address `url`.
pub(crate) fn remote_declaration(binding: &McpServerBindingRef, url: &str) -> McpServerDeclaration {
    declaration(
        binding,
        McpServerConfigView::Http {
            url: url.to_owned(),
            url_query_param_names: None,
            header_names: None,
            bearer_token_env_var: None,
            env_http_headers: None,
            oauth_scopes: None,
            oauth_resource: None,
            enabled: None,
            required: None,
            startup_timeout_sec: None,
            tool_timeout_sec: None,
        },
    )
}

/// A declaration of `binding` as a program the provider starts.
pub(crate) fn program_declaration(binding: &McpServerBindingRef) -> McpServerDeclaration {
    declaration(
        binding,
        McpServerConfigView::Stdio {
            command: "docs-server".to_owned(),
            args: None,
            env_var_names: None,
            enabled: None,
            required: None,
            startup_timeout_sec: None,
            tool_timeout_sec: None,
        },
    )
}

fn declaration(binding: &McpServerBindingRef, config: McpServerConfigView) -> McpServerDeclaration {
    McpServerDeclaration {
        binding: binding.clone(),
        config,
        superseded_in: Vec::new(),
        disabled_in: Vec::new(),
        is_read_only: false,
        sign_in_settings: None,
        is_switch_kept_by_daemon: true,
        tool_defaults: McpServerToolDefaults::with_approval_mode(McpApprovalMode::Auto),
        organization_managed: None,
    }
}

/// A driver whose every server read declares `declarations`.
pub(crate) fn driver_declaring(declarations: Vec<McpServerDeclaration>) -> MockProviderDriver {
    let mut driver = MockProviderDriver::new();
    driver.expect_read_mcp_servers().returning(move |_request| {
        Box::pin(ready(Ok(ProviderMcpServersReading {
            declarations: declarations.clone(),
            roots: Vec::new(),
            is_machine_managed: false,
            server_policy: McpServerPolicy::default(),
            account_servers: Vec::new(),
            probe_readings: Vec::new(),
        })))
    });
    driver
}

/// Has `driver` answer one address read with `answer`.
pub(crate) fn answer_address_read(
    driver: &mut MockProviderDriver,
    answer: Result<McpServerAddressReading, DriverError>,
) {
    driver
        .expect_read_mcp_server_addresses()
        .times(1)
        .return_once(move |_requests| Box::pin(ready(vec![answer])));
}

fn declared(address: &str) -> McpServerAddressReading {
    McpServerAddressReading::Declared(McpServerAddress::new(address).expect("a server address"))
}

// Killed by an address built from the declaration's stripped `url`, and by the driver's read
// skipped.
#[tokio::test]
async fn a_remote_binding_is_read_at_the_address_its_entry_declares() {
    let binding = docs_binding();
    let mut driver = driver_declaring(vec![remote_declaration(
        &binding,
        "https://docs.example.test/",
    )]);
    answer_address_read(&mut driver, Ok(declared(DECLARED_ADDRESS)));
    let sources = test_sources(vec![Arc::new(driver)]).await;

    let read = sources
        .target_reads()
        .read(&binding)
        .await
        .expect("the target reads");

    let SignInServer::Address(server) = &read.target.server else {
        panic!("a remote binding is reached at an address");
    };
    assert_eq!(server.address.as_str(), DECLARED_ADDRESS);
}

// An entry naming both client halves, an `https:` metadata address and its scopes reads as a
// target holding them, and an `http:` metadata address is refused as unusable. Killed by the
// metadata address dropped from the target, and by the scheme check dropped.
#[rstest]
#[case::https("https://auth.example.test/meta", None)]
#[case::http(
    "http://auth.example.test/meta",
    Some(SignInUnsupportedReason::UnusableMetadata)
)]
#[tokio::test]
async fn the_sign_in_settings_of_an_entry_reach_its_target(
    #[case] metadata_address: &str,
    #[case] refusal: Option<SignInUnsupportedReason>,
) {
    let binding = docs_binding();
    let mut declaration = remote_declaration(&binding, "https://docs.example.test/");
    if let McpServerConfigView::Http { oauth_scopes, .. } = &mut declaration.config {
        *oauth_scopes = Some(vec!["read".to_owned()]);
    }
    declaration.sign_in_settings = Some(McpServerSignInSettings {
        client_id: Some("owner-client".to_owned()),
        callback_url: Some("http://localhost:8080/callback".to_owned()),
        authorization_server_metadata_url: Some(metadata_address.to_owned()),
        callback_port: None,
        asks_offline_access_where_listed: true,
    });
    let mut driver = driver_declaring(vec![declaration]);
    answer_address_read(&mut driver, Ok(declared(DECLARED_ADDRESS)));
    driver
        .expect_read_mcp_owner_client_secret()
        .return_once(|_request| Box::pin(ready(Ok(None))));
    let sources = test_sources(vec![Arc::new(driver)]).await;

    let read = sources.target_reads().read(&binding).await;

    let read = match (read, refusal) {
        (Ok(read), None) => read,
        (Err(HandlerError::Refused(refused)), Some(reason)) => {
            assert_eq!(refused.code, RefusalCode::McpServerSignInUnsupported);
            assert!(
                refused.message.contains(&reason.to_string()),
                "{}",
                refused.message
            );
            return;
        }
        (read, _) => panic!("the read answered {:?}", read.err()),
    };
    let SignInServer::Address(server) = &read.target.server else {
        panic!("a remote binding is reached at an address");
    };
    assert_eq!(
        server
            .authorization_server_metadata
            .as_ref()
            .map(Url::as_str),
        Some(metadata_address)
    );
    let owner_client = server.owner_client.as_ref().expect("the owner's client");
    assert_eq!(owner_client.client_id.as_deref(), Some("owner-client"));
    assert_eq!(
        owner_client.callback_url.as_ref().map(Url::as_str),
        Some("http://localhost:8080/callback")
    );
    assert_eq!(read.scopes, ["read"]);
}

/// A binding a test case reads the target of.
#[derive(Clone, Copy, Debug)]
enum TargetCase {
    /// A connector of the test account.
    Connector,
    /// A remote server whose address does not read.
    Unreadable,
    /// A binding no declaration names.
    Gone,
    /// A remote server whose entry left before the address read.
    EntryLeft,
    /// A program the provider starts.
    Program,
}

// Each case names the code it answers, `None` for a target read as a program, and the reads
// it must not make. Killed by an address read for a connector (`connector`), a launch at an
// address that did not read (`unreadable`), an address read for a binding the inventory does
// not hold (`gone`), the driver's missing entry passed through as a fault (`entry_left`), and
// an address asked of a program's driver (`program`).
#[rstest]
#[case::connector(TargetCase::Connector, Some(RefusalCode::McpServerSignInUnsupported))]
#[case::unreadable(TargetCase::Unreadable, Some(RefusalCode::McpServerSignInUnsupported))]
#[case::gone(TargetCase::Gone, Some(RefusalCode::McpServerNotFound))]
#[case::entry_left(TargetCase::EntryLeft, Some(RefusalCode::McpServerNotFound))]
#[case::program(TargetCase::Program, None)]
#[tokio::test]
async fn a_binding_no_sign_in_reaches_is_refused(
    #[case] case: TargetCase,
    #[case] expected: Option<RefusalCode>,
) {
    let docs = docs_binding();
    let remote = || vec![remote_declaration(&docs, "https://docs.example.test/")];
    let (binding, mut driver, address_answer) = match case {
        TargetCase::Connector => {
            let mut driver = MockProviderDriver::new();
            driver.expect_read_mcp_servers().times(0);
            let connector = McpServerBindingRef::Connector {
                provider: first_provider(),
                scope_ref: test_provider_account_id(),
                server_name: server_name("docs"),
            };
            (connector, driver, None)
        }
        TargetCase::Unreadable => (
            docs.clone(),
            driver_declaring(remote()),
            Some(Ok(McpServerAddressReading::Unreadable)),
        ),
        TargetCase::Gone => {
            let other = McpServerBindingRef::User {
                provider: first_provider(),
                server_name: server_name("other"),
            };
            let declarations = vec![remote_declaration(&other, "https://other.example.test/")];
            (docs.clone(), driver_declaring(declarations), None)
        }
        TargetCase::EntryLeft => {
            let left = NoPersonServerEntry {
                binding: docs.clone(),
            };
            (
                docs.clone(),
                driver_declaring(remote()),
                Some(Err(left.into())),
            )
        }
        TargetCase::Program => (
            docs.clone(),
            driver_declaring(vec![program_declaration(&docs)]),
            None,
        ),
    };
    match address_answer {
        Some(answer) => answer_address_read(&mut driver, answer),
        None => {
            driver.expect_read_mcp_server_addresses().times(0);
        }
    }
    let sources = test_sources(vec![Arc::new(driver)]).await;

    let code = match sources.target_reads().read(&binding).await {
        Ok(read) => {
            assert!(matches!(read.target.server, SignInServer::Stdio));
            None
        }
        Err(HandlerError::Refused(refusal)) => Some(refusal.code),
        Err(error) => panic!("the read failed: {error:?}"),
    };
    assert_eq!(code, expected);
}

// The address read the driver receives and the target both carry the `Every project` rows
// for a `project` and a `user` binding, and the rows of the project attached at the binding's
// root only for the `project` binding. Killed by the project's rows never read (`project`),
// by a project's rows read for a binding with no project (`user`), and by the `Every project`
// rows dropped from the read or the target (both).
#[rstest]
#[case::project(json!({ "scope": "project", "scopeRef": "/repos/app" }), true)]
#[case::user(json!({ "scope": "user" }), false)]
#[tokio::test]
async fn a_target_read_carries_its_bindings_environment_rows(
    #[case] mut binding: serde_json::Value,
    #[case] is_in_project: bool,
) {
    binding["provider"] = json!(first_provider().as_str());
    binding["serverName"] = json!("docs");
    let binding: McpServerBindingRef = serde_json::from_value(binding).expect("a binding");
    let every_project_rows = EnvironmentRow::test_rows(&[("API_HOST", "every.example.test")]);
    let project_rows = EnvironmentRow::test_rows(&[("API_HOST", "project.example.test")]);
    let mut driver = driver_declaring(vec![remote_declaration(
        &binding,
        "https://docs.example.test/",
    )]);
    let asked = Arc::new(Mutex::new(None));
    let asked_by_driver = Arc::clone(&asked);
    driver
        .expect_read_mcp_server_addresses()
        .times(1)
        .return_once(move |mut requests| {
            *asked_by_driver.lock().expect("never poisoned") = requests.pop();
            Box::pin(ready(vec![Ok(declared(DECLARED_ADDRESS))]))
        });
    let sources = test_sources(vec![Arc::new(driver)]).await;
    let connection = sources.database.reader();
    for row in project_and_mount_rows(PROJECT_ID, None) {
        connection
            .execute_batch(&row)
            .expect("the project and its mount are stored");
    }
    connection
        .execute(
            "UPDATE projects SET environment_rows = ?1 WHERE id = ?2",
            params![
                serde_json::to_string(&project_rows).expect("the rows serialize"),
                PROJECT_ID
            ],
        )
        .expect("the project's rows are stored");

    let read = sources
        .target_reads_over(MachineSettings {
            environment_rows: every_project_rows.clone(),
            ..MachineSettings::default()
        })
        .read(&binding)
        .await
        .expect("the target reads");

    let expected_project_rows = if is_in_project {
        project_rows
    } else {
        Vec::new()
    };
    let address_read = asked
        .lock()
        .expect("never poisoned")
        .take()
        .expect("the driver is asked for the address");
    assert_eq!(address_read.every_project_rows, every_project_rows);
    assert_eq!(address_read.project_rows, expected_project_rows);
    assert_eq!(read.target.every_project_rows, every_project_rows);
    assert_eq!(read.target.project_rows, expected_project_rows);
}

// Killed by the place ignored (`local_in_wsl` reads `/home/me/repo`), and by a root given to a
// binding with none.
#[rstest]
#[case::user(json!({ "scope": "user" }), None)]
#[case::project(json!({ "scope": "project", "scopeRef": "/repo" }), Some("/repo"))]
#[case::local_in_wsl(
    json!({ "scope": "local", "scopeRef": "/home/me/repo", "place": { "distro": "Ubuntu" } }),
    Some(r"\\wsl.localhost\Ubuntu\home\me\repo")
)]
#[case::plugin(json!({ "scope": "plugin", "scopeRef": "docs-plugin" }), None)]
#[case::managed(json!({ "scope": "managed" }), None)]
fn a_project_root_is_read_on_this_computer(
    #[case] mut binding: serde_json::Value,
    #[case] expected: Option<&str>,
) {
    binding["provider"] = json!(first_provider().as_str());
    binding["serverName"] = json!("docs");
    let binding: McpServerBindingRef = serde_json::from_value(binding).expect("a binding");
    assert_eq!(root_folder_of(&binding), expected.map(PathBuf::from));
}
