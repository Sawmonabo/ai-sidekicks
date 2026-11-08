//! The target of an MCP sign-in, read from its binding: the provider's declaration, the whole
//! address the binding's entry declares as its driver reads it, never the stripped one the
//! inventory serves, the client the server's owner issued, the scopes and the resource the entry
//! asks for, the `https:` address its authorization server's metadata is read at where the entry
//! names one, the binding's project root on this computer, the environment rows that fill the
//! address's variables and each provider's current account.

use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;

use reqwest::Url;
use sidekicks_contracts::machine::settings::EnvironmentRow;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::config::{McpServerAddress, McpServerConfigView};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_platforms::DistributionPath;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::sign_in::{
    McpServerAddressRead, McpServerAddressReading,
};
use sidekicks_provider::driver::mcp_server::read::McpServerSignInSettings;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::{CurrentProviderAccount, ProviderAccountReader};
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use sidekicks_workspace::project::records::ProjectRecords;

use crate::binding::resolver::attached_root_path;
use crate::errors::{McpRefusal, SignInUnsupportedReason};
use crate::inventory_service::McpInventoryService;
use crate::sign_in::service::{
    AddressedServer, OwnerIssuedClient, ProviderAccounts, SignInServer, SignInTarget,
};

/// What a sign-in's target is read from: the inventory's declarations, the providers' drivers,
/// whose reads give the whole address, the provider accounts, and the machine's settings and the
/// projects, whose environment rows fill the address's variables.
pub struct SignInTargetReads {
    inventory: Arc<McpInventoryService>,
    providers: Arc<ProviderRegistry>,
    provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
    machine_settings: Arc<dyn MachineSettingsReader>,
    projects: Arc<ProjectRecords>,
}

/// A sign-in's target as read: the target, the scopes its entry asks for and the account each
/// provider's flow runs for.
pub(crate) struct SignInTargetRead {
    /// The binding and how its server is reached.
    pub(crate) target: SignInTarget,
    /// The scopes the entry asks for; none where it names none.
    pub(crate) scopes: Vec<String>,
    /// Each provider's current account; a provider with none offers no flow.
    pub(crate) provider_accounts: ProviderAccounts,
}

impl SignInTargetReads {
    /// The reads over `inventory`, the drivers of `providers`, the accounts reader
    /// `provider_accounts` holds, the settings `machine_settings` reads and the `projects`.
    pub fn new(
        inventory: Arc<McpInventoryService>,
        providers: Arc<ProviderRegistry>,
        provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
        machine_settings: Arc<dyn MachineSettingsReader>,
        projects: Arc<ProjectRecords>,
    ) -> Self {
        Self {
            inventory,
            providers,
            provider_accounts,
            machine_settings,
            projects,
        }
    }

    /// The target of a sign-in to `binding`. Refuses `mcp.server.signInUnsupported` for a
    /// connector, whose sign-in is its account's own, for a server whose declared address does
    /// not read, for an owner's callback that is no address and for a metadata address that is no
    /// `https:` address (`unusableMetadata`), and `mcp.server.notFound` when no
    /// provider declares the binding; answers an inventory or driver failure as each answers a
    /// call, and an accounts, settings or project read that fails, or a stored project root that
    /// is no path, as a fault.
    pub(crate) async fn read(
        &self,
        binding: &McpServerBindingRef,
    ) -> Result<SignInTargetRead, HandlerError> {
        let unsupported = |reason| {
            HandlerError::Refused(
                McpRefusal::ServerSignInUnsupported {
                    binding: Box::new(binding.clone()),
                    reason,
                }
                .into(),
            )
        };
        let not_found = || {
            HandlerError::Refused(
                McpRefusal::ServerNotFound {
                    binding: Box::new(binding.clone()),
                }
                .into(),
            )
        };
        if matches!(binding, McpServerBindingRef::Connector { .. }) {
            return Err(unsupported(SignInUnsupportedReason::NotReachedAtAddress));
        }
        let provider = binding.provider();
        let declaration = self
            .inventory
            .read_declarations(provider)
            .await?
            .into_iter()
            .find(|declaration| declaration.binding == *binding)
            .ok_or_else(not_found)?;
        let provider_accounts = self.read_provider_accounts().await?;
        let root_folder = root_folder_of(binding);
        let (server, scopes, every_project_rows, project_rows) = match declaration.config {
            McpServerConfigView::Stdio { .. } => {
                (SignInServer::Stdio, Vec::new(), Vec::new(), Vec::new())
            }
            // A WebSocket address is never an `http:` or `https:` one, so it reads no address.
            McpServerConfigView::Ws { .. } => {
                return Err(unsupported(SignInUnsupportedReason::AddressUnreadable));
            }
            McpServerConfigView::Http {
                oauth_scopes,
                oauth_resource,
                ..
            }
            | McpServerConfigView::Sse {
                oauth_scopes,
                oauth_resource,
                ..
            } => {
                let Ok(driver) = self.providers.lookup(provider) else {
                    return Err(not_found());
                };
                let (every_project_rows, project_rows) =
                    self.read_environment_rows(binding).await?;
                let read = McpServerAddressRead {
                    binding: binding.clone(),
                    provider_account_id: provider_accounts.get(provider).cloned(),
                    root_folder: root_folder.clone(),
                    every_project_rows: every_project_rows.clone(),
                    project_rows: project_rows.clone(),
                };
                let address: McpServerAddress = match driver.read_mcp_server_address(read).await {
                    Ok(McpServerAddressReading::Declared(address)) => address,
                    Ok(McpServerAddressReading::Unreadable) => {
                        return Err(unsupported(SignInUnsupportedReason::AddressUnreadable));
                    }
                    // The inventory listed the binding and its entry left before this read.
                    Err(DriverError::NoPersonServerEntry(_)) => return Err(not_found()),
                    Err(error) => return Err(HandlerError::from(error)),
                };
                let settings = declaration.sign_in_settings;
                let authorization_server_metadata = match settings
                    .as_ref()
                    .and_then(|settings| settings.authorization_server_metadata_url.as_deref())
                    .map(Url::parse)
                {
                    None => None,
                    Some(Ok(metadata_address)) if metadata_address.scheme() == "https" => {
                        Some(metadata_address)
                    }
                    Some(Ok(_) | Err(_)) => {
                        return Err(unsupported(SignInUnsupportedReason::UnusableMetadata));
                    }
                };
                let asks_offline_access_where_listed = settings
                    .as_ref()
                    .is_some_and(|settings| settings.asks_offline_access_where_listed);
                let owner_client = match owner_client_of(settings) {
                    Ok(owner_client) => owner_client,
                    Err(OwnerCallbackUnparsed) => {
                        return Err(unsupported(SignInUnsupportedReason::OwnerCallbackUnserved));
                    }
                };
                (
                    SignInServer::Address(Box::new(AddressedServer::new(
                        address,
                        owner_client,
                        oauth_resource,
                        authorization_server_metadata,
                        asks_offline_access_where_listed,
                    ))),
                    oauth_scopes.unwrap_or_default(),
                    every_project_rows,
                    project_rows,
                )
            }
        };
        Ok(SignInTargetRead {
            target: SignInTarget {
                binding: binding.clone(),
                server,
                root_folder,
                every_project_rows,
                project_rows,
            },
            scopes,
            provider_accounts,
        })
    }

    // The `Every project` rows, and the rows of the project whose attached root is a `project` or
    // `local` binding's root; no project's rows for any other binding, or for a root no attached
    // project holds, as a session outside a project reads none.
    async fn read_environment_rows(
        &self,
        binding: &McpServerBindingRef,
    ) -> Result<(Vec<EnvironmentRow>, Vec<EnvironmentRow>), HandlerError> {
        let internal = |error: Box<dyn Error + Send + Sync>| HandlerError::Internal(error);
        let every_project_rows = self
            .machine_settings
            .read_machine_settings()
            .await
            .map_err(internal)?
            .environment_rows;
        let (scope_ref, place) = match binding {
            McpServerBindingRef::Project {
                scope_ref, place, ..
            }
            | McpServerBindingRef::Local {
                scope_ref, place, ..
            } => (scope_ref, place),
            McpServerBindingRef::User { .. }
            | McpServerBindingRef::Plugin { .. }
            | McpServerBindingRef::Connector { .. }
            | McpServerBindingRef::Managed { .. } => return Ok((every_project_rows, Vec::new())),
        };
        let mut project_id = None;
        for root in self
            .projects
            .read_attached_roots()
            .await
            .map_err(|error| internal(Box::new(error)))?
        {
            let root_path = attached_root_path(&root).map_err(|error| internal(Box::new(error)))?;
            if root_path.path == *scope_ref && root_path.place == *place {
                project_id = Some(root.project_id);
                break;
            }
        }
        let Some(project_id) = project_id else {
            return Ok((every_project_rows, Vec::new()));
        };
        let project_rows = self
            .projects
            .read_entry(project_id)
            .await
            .map_err(|error| internal(Box::new(error)))?
            .map(|entry| entry.environment_rows)
            .unwrap_or_default();
        Ok((every_project_rows, project_rows))
    }

    // Each registered provider's current account; a provider with none is left out.
    async fn read_provider_accounts(&self) -> Result<ProviderAccounts, HandlerError> {
        let reader = self
            .provider_accounts
            .require_port()
            .map_err(|error| HandlerError::Internal(Box::new(error)))?;
        let mut provider_accounts = ProviderAccounts::new();
        for (provider, _driver) in self.providers.drivers() {
            match reader
                .current_account(provider.clone())
                .await
                .map_err(HandlerError::Internal)?
            {
                CurrentProviderAccount::Current(provider_account_id) => {
                    provider_accounts.insert(provider.clone(), provider_account_id);
                }
                CurrentProviderAccount::NoneRegistered | CurrentProviderAccount::NoneCurrent => {}
            }
        }
        Ok(provider_accounts)
    }
}

/// An owner's callback that does not parse as an address.
struct OwnerCallbackUnparsed;

// The owner's client, built from whichever of its id and its callback the entry gives; an entry
// that gives neither builds none, and a callback that does not parse is refused.
fn owner_client_of(
    sign_in_settings: Option<McpServerSignInSettings>,
) -> Result<Option<OwnerIssuedClient>, OwnerCallbackUnparsed> {
    let Some(McpServerSignInSettings {
        client_id,
        callback_url,
        ..
    }) = sign_in_settings
    else {
        return Ok(None);
    };
    let callback_url = callback_url
        .map(|callback_url| Url::parse(&callback_url))
        .transpose()
        .map_err(|_error| OwnerCallbackUnparsed)?;
    if client_id.is_none() && callback_url.is_none() {
        return Ok(None);
    }
    Ok(Some(OwnerIssuedClient {
        client_id,
        callback_url,
    }))
}

// The folder on this computer a `project` or `local` binding's root is read at: its `scopeRef`,
// or in a WSL distribution that folder's Windows form; `None` for every other scope.
fn root_folder_of(binding: &McpServerBindingRef) -> Option<PathBuf> {
    match binding {
        McpServerBindingRef::Project {
            scope_ref, place, ..
        }
        | McpServerBindingRef::Local {
            scope_ref, place, ..
        } => Some(match place {
            Some(place) => DistributionPath {
                distro: place.distro.as_str().to_owned(),
                linux_path: scope_ref.as_str().to_owned(),
            }
            .windows_path(),
            None => PathBuf::from(scope_ref.as_str()),
        }),
        McpServerBindingRef::User { .. }
        | McpServerBindingRef::Plugin { .. }
        | McpServerBindingRef::Connector { .. }
        | McpServerBindingRef::Managed { .. } => None,
    }
}

#[cfg(test)]
pub(crate) mod tests {
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
    use sidekicks_contracts::wire::text::{BoundedText, NulFreeText};
    use sidekicks_ipc::registry::HandlerError;
    use sidekicks_provider::driver::CurrentProviderAccount;
    use sidekicks_provider::driver::contract::error::DriverError;
    use sidekicks_provider::driver::contract::sign_in::{
        McpServerAddressReading, NoPersonServerEntry,
    };
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
        database: TestDatabase,
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
                registered_test_accounts(CurrentProviderAccount::Current(
                    test_provider_account_id(),
                )),
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
    pub(crate) fn remote_declaration(
        binding: &McpServerBindingRef,
        url: &str,
    ) -> McpServerDeclaration {
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

    fn declaration(
        binding: &McpServerBindingRef,
        config: McpServerConfigView,
    ) -> McpServerDeclaration {
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
            .expect_read_mcp_server_address()
            .times(1)
            .return_once(move |_request| Box::pin(ready(answer)));
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
            asks_offline_access_where_listed: true,
        });
        let mut driver = driver_declaring(vec![declaration]);
        answer_address_read(&mut driver, Ok(declared(DECLARED_ADDRESS)));
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
                driver.expect_read_mcp_server_address().times(0);
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

    fn rows(entries: &[(&str, &str)]) -> Vec<EnvironmentRow> {
        entries
            .iter()
            .map(|(name, value)| EnvironmentRow {
                name: BoundedText::new((*name).to_owned()).expect("the test's name is bounded"),
                value: NulFreeText::new((*value).to_owned()).expect("the test's value has no NUL"),
            })
            .collect()
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
        let every_project_rows = rows(&[("API_HOST", "every.example.test")]);
        let project_rows = rows(&[("API_HOST", "project.example.test")]);
        let mut driver = driver_declaring(vec![remote_declaration(
            &binding,
            "https://docs.example.test/",
        )]);
        let asked = Arc::new(Mutex::new(None));
        let asked_by_driver = Arc::clone(&asked);
        driver
            .expect_read_mcp_server_address()
            .times(1)
            .return_once(move |request| {
                *asked_by_driver.lock().expect("never poisoned") = Some(request);
                Box::pin(ready(Ok(declared(DECLARED_ADDRESS))))
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
}
