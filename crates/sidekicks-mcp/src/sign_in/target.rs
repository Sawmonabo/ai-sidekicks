//! The target of an MCP sign-in, read from its binding: the provider's declaration, the whole
//! address the binding's entry declares as its driver reads it, never the stripped one the
//! inventory serves, the client the server's owner issued, the scopes the entry asks for, the
//! binding's project root on this computer and each provider's current account.

use std::path::PathBuf;
use std::sync::Arc;

use reqwest::Url;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::config::{McpServerAddress, McpServerConfigView};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_platforms::DistributionPath;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::sign_in::{
    McpServerAddressRead, McpServerAddressReading,
};
use sidekicks_provider::driver::mcp_server::read::McpServerSignInClient;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::{CurrentProviderAccount, ProviderAccountReader};
use sidekicks_std::port_registration::PortRegistration;

use crate::errors::{McpRefusal, SignInUnsupportedReason};
use crate::inventory_service::McpInventoryService;
use crate::sign_in::service::{
    AddressedServer, OwnerIssuedClient, ProviderAccounts, SignInServer, SignInTarget,
};

/// What a sign-in's target is read from: the inventory's declarations, the providers' drivers,
/// whose reads give the whole address, and the provider accounts.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the sign-in commands that read it"
    )
)]
pub(crate) struct SignInTargetReads {
    inventory: Arc<McpInventoryService>,
    providers: Arc<ProviderRegistry>,
    provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
}

/// A sign-in's target as read: the target, the scopes its entry asks for and the account each
/// provider's flow runs for.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the sign-in commands that read it"
    )
)]
pub(crate) struct SignInTargetRead {
    /// The binding and how its server is reached.
    pub(crate) target: SignInTarget,
    /// The scopes the entry asks for; none where it names none.
    pub(crate) scopes: Vec<String>,
    /// Each provider's current account; a provider with none offers no flow.
    pub(crate) provider_accounts: ProviderAccounts,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the sign-in commands that read it"
    )
)]
impl SignInTargetReads {
    /// The reads over `inventory`, the drivers of `providers` and the accounts reader
    /// `provider_accounts` holds.
    pub(crate) fn new(
        inventory: Arc<McpInventoryService>,
        providers: Arc<ProviderRegistry>,
        provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
    ) -> Self {
        Self {
            inventory,
            providers,
            provider_accounts,
        }
    }

    /// The target of a sign-in to `binding`. Refuses `mcp.server.signInUnsupported` for a
    /// connector, whose sign-in is its account's own, for a server whose declared address does
    /// not read and for an owner's callback that is no address, and `mcp.server.notFound` when no
    /// provider declares the binding; answers an inventory or driver failure as each answers a
    /// call, and an accounts read that fails as a fault.
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
        let (server, scopes) = match declaration.config {
            McpServerConfigView::Stdio { .. } => (SignInServer::Stdio, Vec::new()),
            // A WebSocket address is never an `http:` or `https:` one, so it reads no address.
            McpServerConfigView::Ws { .. } => {
                return Err(unsupported(SignInUnsupportedReason::AddressUnreadable));
            }
            McpServerConfigView::Http { oauth_scopes, .. }
            | McpServerConfigView::Sse { oauth_scopes, .. } => {
                let Ok(driver) = self.providers.lookup(provider) else {
                    return Err(not_found());
                };
                let read = McpServerAddressRead {
                    binding: binding.clone(),
                    provider_account_id: provider_accounts.get(provider).cloned(),
                    root_folder: root_folder.clone(),
                };
                let address: McpServerAddress = match driver.read_mcp_server_address(read).await {
                    Ok(McpServerAddressReading::Declared(address)) => address,
                    Ok(
                        McpServerAddressReading::Unreadable
                        | McpServerAddressReading::ReadByProviderOnly,
                    ) => return Err(unsupported(SignInUnsupportedReason::AddressUnreadable)),
                    // The inventory listed the binding and its entry left before this read.
                    Err(DriverError::NoPersonServerEntry(_)) => return Err(not_found()),
                    Err(error) => return Err(HandlerError::from(error)),
                };
                let owner_client = match owner_client_of(declaration.sign_in_client) {
                    Ok(owner_client) => owner_client,
                    Err(OwnerCallbackUnparsed) => {
                        return Err(unsupported(SignInUnsupportedReason::OwnerCallbackUnserved));
                    }
                };
                (
                    SignInServer::Address(AddressedServer::new(address, owner_client)),
                    oauth_scopes.unwrap_or_default(),
                )
            }
        };
        Ok(SignInTargetRead {
            target: SignInTarget {
                binding: binding.clone(),
                server,
                root_folder,
            },
            scopes,
            provider_accounts,
        })
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

// The owner's client, built when the entry gives both its id and a callback that parses; any
// other entry builds none.
fn owner_client_of(
    sign_in_client: Option<McpServerSignInClient>,
) -> Result<Option<OwnerIssuedClient>, OwnerCallbackUnparsed> {
    let Some(McpServerSignInClient {
        client_id: Some(client_id),
        callback_url: Some(callback_url),
    }) = sign_in_client
    else {
        return Ok(None);
    };
    let callback_url = Url::parse(&callback_url).map_err(|_error| OwnerCallbackUnparsed)?;
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
    use std::sync::Arc;

    use futures::future::ready;
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::mcp::server::config::{McpServerAddress, McpServerConfigView};
    use sidekicks_contracts::mcp::server::{McpApprovalMode, McpServerBindingRef, McpServerName};
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_ipc::registry::HandlerError;
    use sidekicks_provider::driver::contract::error::DriverError;
    use sidekicks_provider::driver::contract::sign_in::{
        McpServerAddressReading, NoPersonServerEntry,
    };
    use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
    use sidekicks_provider::driver::mcp_server::read::{
        McpServerDeclaration, McpServerPolicy, McpServerToolDefaults, ProviderMcpServersReading,
    };
    use sidekicks_provider::driver::registry::ProviderRegistry;
    use sidekicks_provider::driver::test_registry::{
        registered_test_accounts, registry_of_first_providers,
    };
    use sidekicks_provider::driver::{CurrentProviderAccount, PROVIDER_REGISTRATIONS};
    use sidekicks_provider::runtime_binding::test_store::test_provider_account_id;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::DatabaseWriter;
    use sidekicks_store::database::writer::test_file::TestDatabase;

    use super::{SignInTargetReads, root_folder_of};
    use crate::inventory_service::McpInventoryService;
    use crate::mutation::receipts::tests::receipts_over_a_database;
    use crate::sign_in::service::SignInServer;
    use crate::status::notices::McpNoticeBoard;
    use crate::test_inventory::open_test_inventory;

    /// The whole address the test entry declares, its user name and query kept.
    const DECLARED_ADDRESS: &str = "https://user@docs.example.test/mcp?key=k";

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
        _database: TestDatabase,
    }

    impl TestSources {
        /// The target reads over these sources, the accounts answering the test account as every
        /// provider's current one.
        pub(crate) fn target_reads(&self) -> SignInTargetReads {
            SignInTargetReads::new(
                Arc::clone(&self.inventory),
                Arc::clone(&self.providers),
                registered_test_accounts(CurrentProviderAccount::Current(
                    test_provider_account_id(),
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
            _database: database,
        }
    }

    /// The provider the test registry registers first.
    fn first_provider() -> ProviderId {
        ProviderId::new(PROVIDER_REGISTRATIONS[0].descriptor.id.to_owned()).expect("a provider id")
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

    fn program_declaration(binding: &McpServerBindingRef) -> McpServerDeclaration {
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
            sign_in_client: None,
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
