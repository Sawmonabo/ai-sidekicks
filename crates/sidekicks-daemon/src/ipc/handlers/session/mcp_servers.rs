//! `mcp.resource.list`, what one of a session's working servers offers to attach: the list its
//! provider reads for the daemon, or the daemon's own read over a connection made for the call,
//! a second copy of a program server or the server at its address. A server the session does not
//! read as working is refused before the provider is asked anything.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::mcp::server::McpServerStatus;
use sidekicks_contracts::session::controls::methods::{
    McpResourceList, McpResourceListRequest, McpResourceListResponse,
};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_mcp::client::McpClient;
use sidekicks_mcp::client::resources::{McpServerCopyStart, McpServerResources};
use sidekicks_mcp::status::McpServerStatusTracker;
use sidekicks_platforms::Spawner;
use sidekicks_provider::driver::mcp_server::resources::McpResourceSource;
use sidekicks_provider::spawn_environment::ReservedEnvironmentNames;
use sidekicks_session::driver_resolution::read_session_driver;

use crate::ipc::handlers::driver::{DriverMethodReadError, DriverMethodSources};

/// What the session's server methods read and act through.
pub(crate) struct McpServerMethods {
    /// The reads that resolve a session's driver, and the drivers.
    pub(crate) sources: Arc<DriverMethodSources>,
    /// What each live leg of a session last saw of its servers.
    pub(crate) statuses: Arc<McpServerStatusTracker>,
    /// The tool servers' client, which reads a server the provider lists to no one.
    pub(crate) client: Arc<McpClient>,
    /// The thread a second copy of a program server starts on.
    pub(crate) spawner: Spawner,
    /// The names no person's row may set, which a copy's environment is built under.
    pub(crate) reserved_names: Arc<ReservedEnvironmentNames>,
}

/// Registers `mcp.resource.list` over `methods`. Fails the start when it is already registered.
pub(crate) fn register_mcp_servers(
    registry: &mut MethodRegistryBuilder,
    methods: McpServerMethods,
) -> Result<(), RegistrationError> {
    let methods = Arc::new(methods);
    registry.register::<McpResourceList, _>(
        move |request: McpResourceListRequest, _context: HandlerContext| {
            let methods = Arc::clone(&methods);
            async move { list_resources(&methods, request).await }.boxed()
        },
    )
}

// The server's resources: refused `session.notFound` for a session the daemon does not hold,
// `mcp.server.notRunning` for a server no live leg of the session reads as connected or whose
// sign-in the provider holds, and `provider.unavailable` where the daemon's own read fails.
async fn list_resources(
    methods: &McpServerMethods,
    request: McpResourceListRequest,
) -> Result<McpResourceListResponse, HandlerError> {
    let McpResourceListRequest {
        session_id,
        server_name,
    } = request;
    let sources = &methods.sources;
    let (provider, _, driver) = read_session_driver::<DriverMethodReadError>(
        &sources.pool,
        &sources.providers,
        sources.read_damaged_from_sequence.as_ref(),
        session_id,
    )
    .await?;
    let is_working = methods
        .statuses
        .session_server_statuses(session_id)
        .iter()
        .any(|(name, leg)| name == &server_name && leg.status == McpServerStatus::Connected);
    if !is_working {
        return Err(DomainError::new(
            format!("{} is not working in this session", server_name.as_str()),
            RefusalCode::McpServerNotRunning,
        )
        .into());
    }
    let McpServerResources {
        resources,
        complete,
    } = match driver
        .list_mcp_resources(session_id, server_name.clone())
        .await?
    {
        McpResourceSource::Listed {
            resources,
            complete,
        } => McpServerResources {
            resources,
            complete,
        },
        McpResourceSource::Reach { binding, reach } => {
            let copy_start = McpServerCopyStart {
                spawner: &methods.spawner,
                descriptor: sources.providers.descriptor(&provider)?,
                reserved_names: &methods.reserved_names,
            };
            methods
                .client
                .list_server_resources(session_id, &binding, reach, copy_start)
                .await
                .map_err(|error| {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        server_name = server_name.as_str(),
                        "a session's tool server's resources could not be read"
                    );
                    DomainError::new(
                        format!("{}'s resources could not be read", server_name.as_str()),
                        RefusalCode::ProviderUnavailable,
                    )
                })?
        }
        McpResourceSource::SignedInByProvider => {
            return Err(DomainError::new(
                format!(
                    "{} is signed in through the provider, which keeps its sign-in to itself",
                    server_name.as_str()
                ),
                RefusalCode::McpServerNotRunning,
            )
            .into());
        }
    };
    Ok(McpResourceListResponse {
        session_id,
        server_name,
        resources,
        complete,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::mcp::server::McpServerStatus::{self, Connected, Failed};
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
    use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::controls::methods::McpResourceListRequest;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_ipc::registry::HandlerError;
    use sidekicks_mcp::binding::resolver::McpAttributionTable;
    use sidekicks_mcp::client::McpClient;
    use sidekicks_mcp::status::normalizer::{McpSessionAttribution, open_mcp_leg_status_producer};
    use sidekicks_mcp::status::open_test_tracker;
    use sidekicks_platforms::Spawner;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::mcp_server::resources::McpResourceSource;
    use sidekicks_provider::driver::mcp_server::status::{
        McpServerReading, McpServerStatusEmission, McpServerStatusProducer,
    };
    use sidekicks_provider::driver::session_control::SessionToolServer;
    use sidekicks_provider::driver::test_registry::registry_of_first_provider;
    use sidekicks_provider::spawn_environment::ReservedEnvironmentNames;
    use sidekicks_std::port_registration::PortRegistration;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, insert_lead, test_session_id,
    };

    use super::{McpServerMethods, list_resources};
    use crate::daemon::release_version::this_build_release_version;
    use crate::daemon::schema::schema_parts;
    use crate::ipc::handlers::driver::{DRIVER_METHODS_STATEMENT_CAPACITY, DriverMethodSources};

    // A session on the first provider over `driver`, whose one leg reads its `tracker` server as
    // `status`; the producer is kept, since dropping it retires the leg.
    struct Fixture {
        _database: TestDatabase,
        _leg: McpServerStatusProducer,
        methods: McpServerMethods,
        session_id: SessionId,
        server_name: McpServerName,
    }

    async fn session_reading(driver: MockProviderDriver, status: McpServerStatus) -> Fixture {
        let database = TestDatabase::new(schema_parts());
        let schema = database.opener()().expect("the test creates its database");
        let session_id = test_session_id();
        insert_session_row(&schema, session_id.text().as_str(), None, None);
        insert_lead(&database, session_id, PROVIDERS[0].id);
        let provider = ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id");
        let server_name = McpServerName::new("tracker".to_owned()).expect("a server name");
        let binding = McpServerBindingRef::User {
            provider: provider.clone(),
            server_name: server_name.clone(),
        };
        let (statuses, _subscriber, _first_observations) = open_test_tracker().await;
        let attribution = McpSessionAttribution::new(
            Arc::new(McpAttributionTable::default()),
            provider,
            None,
            &[SessionToolServer {
                binding,
                is_enabled: true,
            }],
        )
        .expect("a session in no root attributes");
        let leg = open_mcp_leg_status_producer(
            &statuses,
            attribution,
            session_id,
            RuntimeBindingId::new("leg-a".to_owned()).expect("a binding id"),
        );
        leg.report_status(McpServerStatusEmission::new(
            server_name.clone(),
            McpServerReading::Observed(status),
            None,
            None,
        ));
        let methods = McpServerMethods {
            sources: Arc::new(DriverMethodSources {
                pool: Arc::new(DatabaseReadPool::new(
                    database.path(),
                    DRIVER_METHODS_STATEMENT_CAPACITY,
                )),
                providers: Arc::new(registry_of_first_provider(Arc::new(driver))),
                read_damaged_from_sequence: Arc::new(|_: &SessionId| None),
            }),
            statuses,
            client: Arc::new(
                McpClient::new(
                    Arc::new(PortRegistration::new("questions")),
                    this_build_release_version(),
                )
                .expect("the client builds"),
            ),
            spawner: Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts"),
            reserved_names: Arc::new(ReservedEnvironmentNames::of_providers(&[])),
        };
        Fixture {
            _database: database,
            _leg: leg,
            methods,
            session_id,
            server_name,
        }
    }

    fn refusal_of(answer: Result<impl std::fmt::Debug, HandlerError>) -> (RefusalCode, String) {
        let Err(HandlerError::Refused(refusal)) = answer else {
            panic!("the list is refused: {answer:?}");
        };
        (refusal.code, refusal.message)
    }

    // A server whose sign-in the provider holds is refused as not running, its message naming the
    // sign-in, and nothing is reached. Killed by the arm answering an empty list or reaching the
    // server, and by the arm refused as unavailable.
    #[tokio::test]
    async fn a_server_signed_in_by_its_provider_is_refused_without_a_reach() {
        let mut driver = MockProviderDriver::new();
        driver
            .expect_list_mcp_resources()
            .times(1)
            .returning(|_, _| Box::pin(async { Ok(McpResourceSource::SignedInByProvider) }));
        let fixture = session_reading(driver, Connected).await;

        let answer = list_resources(
            &fixture.methods,
            McpResourceListRequest {
                session_id: fixture.session_id,
                server_name: fixture.server_name.clone(),
            },
        )
        .await;

        let (code, message) = refusal_of(answer);
        assert_eq!(code, RefusalCode::McpServerNotRunning);
        assert!(
            message.contains("sign-in"),
            "the refusal names the sign-in: {message}"
        );
    }

    // A server the session's leg reads as failed is refused as not running before the driver is
    // asked. Killed by the status gate removed or moved after the driver's call.
    #[tokio::test]
    async fn a_server_the_session_does_not_read_as_working_is_refused_before_the_driver() {
        let mut driver = MockProviderDriver::new();
        driver.expect_list_mcp_resources().never();
        let fixture = session_reading(driver, Failed).await;

        let answer = list_resources(
            &fixture.methods,
            McpResourceListRequest {
                session_id: fixture.session_id,
                server_name: fixture.server_name.clone(),
            },
        )
        .await;

        assert_eq!(refusal_of(answer).0, RefusalCode::McpServerNotRunning);
    }
}
