//! A session's own tool servers: `session.mcpServer.subscribe`, the live list of the servers the
//! session was started with, each with its status and the session's switch, sent whole on every
//! change; `session.mcpServer.enabled.update`, the session's switch of one of them, kept with the
//! session's stored leg and carried to its live conversation by its driver; and
//! `mcp.resource.list`, what one working server offers to attach: the list its provider reads for
//! the daemon, or the daemon's own read over a connection made for the call, a second copy of a
//! program server or the server at its address. A server the session does not read as working is
//! refused before the provider is asked anything.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::mcp::event::McpSubscribeEmission;
use sidekicks_contracts::mcp::governance::McpServerStatusChangedNotice;
use sidekicks_contracts::mcp::server::{
    MCP_SERVER_STATUS_SEVERITY_ORDER, McpServerName, McpServerStatus,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::{
    McpResourceList, McpResourceListRequest, McpResourceListResponse, SessionAddressedRequest,
    SessionMcpServer, SessionMcpServerEnabledUpdate, SessionMcpServerEnabledUpdateRequest,
    SessionMcpServerEnabledUpdateResponse, SessionMcpServerList, SessionMcpServerSubscribe,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::stream::feed::{Feed, SendGate};
use sidekicks_ipc::stream::latest_value::KeyedLatestValueFeed;
use sidekicks_mcp::client::McpClient;
use sidekicks_mcp::client::resources::{McpServerCopyStart, McpServerResources};
use sidekicks_mcp::status::McpServerStatusTracker;
use sidekicks_mcp::status::notices::McpNoticeKey;
use sidekicks_platforms::Spawner;
use sidekicks_provider::driver::mcp_server::resources::McpResourceSource;
use sidekicks_provider::driver::mcp_server::session_switch::McpSessionSwitch;
use sidekicks_provider::driver::session_control::SessionToolServer;
use sidekicks_provider::spawn_environment::ReservedEnvironmentNames;
use sidekicks_session::driver_resolution::read_session_driver;
use sidekicks_session::run::stored_leg::read_session_leg;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;

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

/// Registers `session.mcpServer.subscribe`, `session.mcpServer.enabled.update` and
/// `mcp.resource.list` over `methods`, with the switches the first two share. Fails the start when
/// one is already registered.
pub(crate) fn register_mcp_servers(
    registry: &mut MethodRegistryBuilder,
    methods: McpServerMethods,
) -> Result<(), RegistrationError> {
    let methods = Arc::new(methods);
    let switches = Arc::new(SessionMcpSwitches::default());
    let following = (Arc::clone(&methods), Arc::clone(&switches));
    registry.register_subscription::<SessionMcpServerSubscribe, _>(
        move |request: SessionAddressedRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let (methods, switches) = (Arc::clone(&following.0), Arc::clone(&following.1));
            async move {
                let feed: Box<dyn Feed<Emission = SessionMcpServerList>> =
                    Box::new(follow_session_servers(methods, switches, request.session_id).await?);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )?;
    let switching = Arc::clone(&methods);
    registry.register::<SessionMcpServerEnabledUpdate, _>(
        move |request: SessionMcpServerEnabledUpdateRequest, _context: HandlerContext| {
            let (methods, switches) = (Arc::clone(&switching), Arc::clone(&switches));
            async move { switch_session_server(&methods, &switches, request).await }.boxed()
        },
    )?;
    registry.register::<McpResourceList, _>(
        move |request: McpResourceListRequest, _context: HandlerContext| {
            let methods = Arc::clone(&methods);
            async move { list_resources(&methods, request).await }.boxed()
        },
    )
}

/// What the session's switches answered and who follows them, by session: one switch at a time
/// per session, so no switch writes over another's set; whether the driver's last answer left the
/// switch waiting for the session's next turn or start; and the signal each open feed of the
/// session recomposes on.
#[derive(Default)]
struct SessionMcpSwitches {
    turns: KeyedLock<SessionId>,
    /// Never held across an await.
    sessions: Mutex<HashMap<SessionId, SessionMcpSwitchState>>,
}

/// One session's switch state.
struct SessionMcpSwitchState {
    /// Whether the driver's last answer was that the switch waits for a next turn or start.
    is_waiting: bool,
    /// Sent once per switch; each open feed holds a receiver.
    switched: watch::Sender<()>,
}

impl SessionMcpSwitches {
    /// A receiver that wakes once per switch of `session_id` made from now on.
    fn follow(&self, session_id: SessionId) -> watch::Receiver<()> {
        lock(&self.sessions)
            .entry(session_id)
            .or_insert_with(|| SessionMcpSwitchState {
                is_waiting: false,
                switched: watch::Sender::new(()),
            })
            .switched
            .subscribe()
    }

    /// Notes a switch of `session_id` and wakes its feeds: `answer` the driver's, `None` when the
    /// driver failed, which leaves whether a switch waits as it was.
    fn note_switched(&self, session_id: SessionId, answer: Option<McpSessionSwitch>) {
        let mut sessions = lock(&self.sessions);
        let state = sessions
            .entry(session_id)
            .or_insert_with(|| SessionMcpSwitchState {
                is_waiting: false,
                switched: watch::Sender::new(()),
            });
        match answer {
            Some(McpSessionSwitch::Applied) => state.is_waiting = false,
            Some(McpSessionSwitch::AtNextTurn | McpSessionSwitch::AtNextStart) => {
                state.is_waiting = true;
            }
            None => {}
        }
        state.switched.send_replace(());
        Self::forget_idle(&mut sessions, session_id);
    }

    /// Whether the driver's last answer for `session_id` left its switch waiting.
    fn is_waiting(&self, session_id: SessionId) -> bool {
        lock(&self.sessions)
            .get(&session_id)
            .is_some_and(|state| state.is_waiting)
    }

    /// Notes that `session_id`'s legs run every server as its switches say, so no row waits.
    fn note_agreed(&self, session_id: SessionId) {
        let mut sessions = lock(&self.sessions);
        if let Some(state) = sessions.get_mut(&session_id) {
            state.is_waiting = false;
        }
        Self::forget_idle(&mut sessions, session_id);
    }

    /// Drops a feed's receiver of `session_id`'s switches, then the session's state once nothing
    /// waits and no feed follows it.
    fn unfollow(&self, session_id: SessionId, receiver: watch::Receiver<()>) {
        let mut sessions = lock(&self.sessions);
        drop(receiver);
        Self::forget_idle(&mut sessions, session_id);
    }

    fn forget_idle(
        sessions: &mut HashMap<SessionId, SessionMcpSwitchState>,
        session_id: SessionId,
    ) {
        if sessions
            .get(&session_id)
            .is_some_and(|state| !state.is_waiting && state.switched.receiver_count() == 0)
        {
            sessions.remove(&session_id);
        }
    }
}

/// The detach a feed's place on the status board runs when the feed drops.
type BoardDetach = Box<dyn FnOnce() + Send>;

/// One open `session.mcpServer.subscribe`: the session's list, sent first and again after each
/// status notice of one of the session's legs and each switch of the session.
struct SessionMcpServerFeed {
    session_id: SessionId,
    methods: Arc<McpServerMethods>,
    switches: Arc<SessionMcpSwitches>,
    notices: KeyedLatestValueFeed<McpNoticeKey, McpSubscribeEmission, BoardDetach>,
    /// `None` only once the feed dropped.
    switched: Option<watch::Receiver<()>>,
    /// Whether a list is owed: at the start and after each change.
    is_list_owed: bool,
}

impl Feed for SessionMcpServerFeed {
    type Emission = SessionMcpServerList;

    fn next<'a>(
        &'a mut self,
        gate: &'a dyn SendGate,
    ) -> BoxFuture<'a, Result<Option<SessionMcpServerList>, HandlerError>> {
        async move {
            let session_id = self.session_id;
            while !self.is_list_owed {
                let switched = self
                    .switched
                    .as_mut()
                    .expect("the receiver is held until the feed drops");
                let change = tokio::select! {
                    notice = self.notices.recv() => SessionMcpChange::Notice(
                        notice?.map(|notice| names_session(&notice, session_id)),
                    ),
                    is_open = switched.changed() => SessionMcpChange::Switched(is_open.is_ok()),
                };
                match change {
                    SessionMcpChange::Notice(None) | SessionMcpChange::Switched(false) => {
                        return Ok(None);
                    }
                    SessionMcpChange::Notice(Some(is_this_session)) => {
                        self.is_list_owed = is_this_session;
                    }
                    SessionMcpChange::Switched(true) => self.is_list_owed = true,
                }
            }
            if gate.ready().await.is_err() {
                return Ok(None);
            }
            let list =
                compose_session_servers(&self.methods, &self.switches, self.session_id).await?;
            self.is_list_owed = false;
            Ok(Some(list))
        }
        .boxed()
    }
}

impl Drop for SessionMcpServerFeed {
    fn drop(&mut self) {
        if let Some(switched) = self.switched.take() {
            self.switches.unfollow(self.session_id, switched);
        }
    }
}

/// What woke a session's feed: a notice from the status board, whether it names the session, or
/// `None` once the board stopped; or a switch, `false` once the switches stopped.
enum SessionMcpChange {
    Notice(Option<bool>),
    Switched(bool),
}

// Whether `notice` is a status change of one of `session_id`'s legs or a leg of it leaving.
fn names_session(notice: &McpSubscribeEmission, session_id: SessionId) -> bool {
    match notice {
        McpSubscribeEmission::StatusChanged(
            McpServerStatusChangedNotice::SessionFeed {
                session_id: noticed,
                ..
            }
            | McpServerStatusChangedNotice::SessionEnded {
                session_id: noticed,
                ..
            },
        ) => *noticed == session_id,
        McpSubscribeEmission::StatusChanged(McpServerStatusChangedNotice::MachineProbe {
            ..
        })
        | McpSubscribeEmission::ConfigChanged(_)
        | McpSubscribeEmission::GovernanceEvent(_) => false,
    }
}

/// Opens the session's server feed: refused `session.notFound` for a session the daemon does not
/// hold, with nothing open; its place on the status board and among the session's switches are
/// taken before the first list is composed, so no change falls between.
async fn follow_session_servers(
    methods: Arc<McpServerMethods>,
    switches: Arc<SessionMcpSwitches>,
    session_id: SessionId,
) -> Result<SessionMcpServerFeed, HandlerError> {
    let sources = &methods.sources;
    read_session_driver::<DriverMethodReadError>(
        &sources.pool,
        &sources.providers,
        sources.read_damaged_from_sequence.as_ref(),
        session_id,
    )
    .await?;
    let board = Arc::clone(methods.statuses.notice_board());
    let notices = KeyedLatestValueFeed::open(|outlet| {
        let id = board.attach(outlet);
        let detach: BoardDetach = Box::new(move || board.detach(id));
        async move { Ok(detach) }
    })
    .await?;
    let switched = Some(switches.follow(session_id));
    Ok(SessionMcpServerFeed {
        session_id,
        methods,
        switches,
        notices,
        switched,
        is_list_owed: true,
    })
}

/// The tool servers `session_id`'s stored leg holds, each with its switch, with the leg's run;
/// `None` for a session that never ran. Fails as the read fails.
async fn read_session_tool_servers(
    methods: &McpServerMethods,
    session_id: SessionId,
) -> Result<Option<(RunId, Vec<SessionToolServer>)>, HandlerError> {
    let leg = read_session_leg(&methods.sources.pool, session_id)
        .await
        .map_err(|error| HandlerError::Internal(Box::new(error)))?;
    Ok(leg.map(|leg| {
        (
            leg.run_id,
            leg.spawn_config.tool_servers.unwrap_or_default(),
        )
    }))
}

/// The session's list: one row per server of its stored set, its status folded over the legs
/// that report it by severity, `unknown` where none does, and waiting while the driver's last
/// answer left the switch for a next turn or start and the legs still disagree with it. Fails as
/// the stored leg's read fails.
async fn compose_session_servers(
    methods: &McpServerMethods,
    switches: &SessionMcpSwitches,
    session_id: SessionId,
) -> Result<SessionMcpServerList, HandlerError> {
    let tool_servers = read_session_tool_servers(methods, session_id)
        .await?
        .map(|(_, tool_servers)| tool_servers)
        .unwrap_or_default();
    let readings = methods.statuses.session_server_statuses(session_id);
    let is_waiting = switches.is_waiting(session_id);
    let servers: Vec<SessionMcpServer> = tool_servers
        .iter()
        .map(|tool_server| {
            let server_name = tool_server.binding.server_name();
            let statuses: Vec<McpServerStatus> = readings
                .iter()
                .filter(|(name, _)| name == server_name)
                .map(|(_, leg)| leg.status)
                .collect();
            let status = MCP_SERVER_STATUS_SEVERITY_ORDER
                .into_iter()
                .find(|ranked| statuses.contains(ranked))
                .unwrap_or(McpServerStatus::Unknown);
            // A leg reports a server only while the server runs on it.
            let is_running = !statuses.is_empty();
            SessionMcpServer {
                server_name: server_name.clone(),
                status,
                reason: None,
                enabled: tool_server.is_enabled,
                pending_until_next_turn: is_waiting && is_running != tool_server.is_enabled,
            }
        })
        .collect();
    if is_waiting && !servers.iter().any(|server| server.pending_until_next_turn) {
        switches.note_agreed(session_id);
    }
    Ok(SessionMcpServerList {
        session_id,
        servers,
    })
}

// Switches `server_name` on or off for the session alone: refused `session.notFound` for a
// session the daemon does not hold and `mcp.server.notRunning` for a server its stored set does
// not hold, the switch only narrowing that set; the same state changes nothing; a new state goes
// to the driver with the whole set and the stored leg's run, and the session's feeds send again.
async fn switch_session_server(
    methods: &McpServerMethods,
    switches: &SessionMcpSwitches,
    request: SessionMcpServerEnabledUpdateRequest,
) -> Result<SessionMcpServerEnabledUpdateResponse, HandlerError> {
    let SessionMcpServerEnabledUpdateRequest {
        session_id,
        server_name,
        enabled,
    } = request;
    let sources = &methods.sources;
    let (_, _, driver) = read_session_driver::<DriverMethodReadError>(
        &sources.pool,
        &sources.providers,
        sources.read_damaged_from_sequence.as_ref(),
        session_id,
    )
    .await?;
    let _turn = switches.turns.acquire(session_id).await;
    let (run_id, mut tool_servers) = read_session_tool_servers(methods, session_id)
        .await?
        .ok_or_else(|| not_a_session_server(&server_name))?;
    let switched = tool_servers
        .iter_mut()
        .find(|tool_server| tool_server.binding.server_name() == &server_name)
        .ok_or_else(|| not_a_session_server(&server_name))?;
    if switched.is_enabled != enabled {
        switched.is_enabled = enabled;
        let answer = driver
            .switch_session_mcp_servers(session_id, run_id, tool_servers)
            .await;
        // A failed apply may follow a stored write, so the feeds read the set again either way.
        switches.note_switched(session_id, answer.as_ref().ok().copied());
        answer?;
    }
    Ok(SessionMcpServerEnabledUpdateResponse {
        session_id,
        server_name,
        enabled,
    })
}

// The refusal of a server the session's stored set does not hold.
fn not_a_session_server(server_name: &McpServerName) -> DomainError {
    DomainError::new(
        format!(
            "{} is not one of this session's tool servers",
            server_name.as_str()
        ),
        RefusalCode::McpServerNotRunning,
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
    use std::sync::{Arc, Mutex};

    use rusqlite::params;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::mcp::server::McpServerStatus::{self, Connected, Failed};
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
    use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::controls::methods::{
        McpResourceListRequest, SessionMcpServer, SessionMcpServerEnabledUpdateRequest,
        SessionMcpServerList,
    };
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_ipc::registry::HandlerError;
    use sidekicks_ipc::stream::feed::{CreditGate, Feed};
    use sidekicks_mcp::binding::resolver::McpAttributionTable;
    use sidekicks_mcp::client::McpClient;
    use sidekicks_mcp::status::normalizer::{McpSessionAttribution, open_mcp_leg_status_producer};
    use sidekicks_mcp::status::open_test_tracker;
    use sidekicks_platforms::Spawner;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::mcp_server::resources::McpResourceSource;
    use sidekicks_provider::driver::mcp_server::session_switch::McpSessionSwitch;
    use sidekicks_provider::driver::mcp_server::status::{
        McpServerReading, McpServerStatusEmission, McpServerStatusProducer,
    };
    use sidekicks_provider::driver::session_control::SessionToolServer;
    use sidekicks_provider::driver::test_registry::registry_of_first_provider;
    use sidekicks_provider::runtime_binding::store::RuntimeBindingStore;
    use sidekicks_provider::runtime_binding::test_store::{open_store, resumable_binding_input};
    use sidekicks_provider::spawn_environment::ReservedEnvironmentNames;
    use sidekicks_std::mutex_lock::lock;
    use sidekicks_std::port_registration::PortRegistration;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, insert_lead, test_run_id, test_session_id,
    };

    use super::{
        McpServerMethods, SessionMcpSwitches, follow_session_servers, list_resources,
        switch_session_server,
    };
    use crate::daemon::release_version::this_build_release_version;
    use crate::daemon::schema::schema_parts;
    use crate::ipc::handlers::driver::{DRIVER_METHODS_STATEMENT_CAPACITY, DriverMethodSources};

    // A session on the first provider over the driver `driver` builds on the session's binding
    // store, whose stored leg holds its `tracker` server on and whose one live leg reads it as
    // `status`; the producer is kept, since dropping it retires the leg.
    struct Fixture {
        _database: TestDatabase,
        _leg: McpServerStatusProducer,
        methods: Arc<McpServerMethods>,
        session_id: SessionId,
        server_name: McpServerName,
        binding: McpServerBindingRef,
        run_id: RunId,
    }

    async fn session_reading(
        driver: impl FnOnce(Arc<RuntimeBindingStore>) -> MockProviderDriver,
        status: McpServerStatus,
    ) -> Fixture {
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
        let tool_servers = vec![SessionToolServer {
            binding: binding.clone(),
            is_enabled: true,
        }];
        let run_id = test_run_id();
        schema
            .execute(
                "INSERT INTO runs (run_id, session_id, state, run_version)
                 VALUES (?1, ?2, 'completed', 1)",
                params![run_id.text().as_str(), session_id.text().as_str()],
            )
            .expect("the session's run is stored");
        let bindings = Arc::new(open_store(&database).await);
        let mut leg_input = resumable_binding_input(run_id, provider.clone());
        leg_input.spawn_config.tool_servers = Some(tool_servers.clone());
        bindings
            .create(leg_input)
            .await
            .expect("the session's leg is stored");
        let (statuses, _subscriber, _first_observations) = open_test_tracker().await;
        let attribution = McpSessionAttribution::new(
            Arc::new(McpAttributionTable::default()),
            provider,
            None,
            &tool_servers,
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
        let methods = Arc::new(McpServerMethods {
            sources: Arc::new(DriverMethodSources {
                pool: Arc::new(DatabaseReadPool::new(
                    database.path(),
                    DRIVER_METHODS_STATEMENT_CAPACITY,
                )),
                providers: Arc::new(registry_of_first_provider(Arc::new(driver(bindings)))),
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
        });
        Fixture {
            _database: database,
            _leg: leg,
            methods,
            session_id,
            server_name,
            binding,
            run_id,
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
        let fixture = session_reading(|_| driver, Connected).await;

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
        let fixture = session_reading(|_| driver, Failed).await;

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

    // With a feed open, switching `tracker` off calls the driver once with the whole set, `tracker`
    // off, and the stored leg's run; the feed's next list carries `tracker` off and waiting for an
    // `AtNextTurn` answer, read from the stored leg the arm wrote; switching it off again calls no
    // driver. Killed by a switch kept only in memory, by a feed not sent again, and by the same
    // state sent again.
    #[tokio::test]
    async fn a_switch_is_kept_with_the_session_and_sent_to_its_feed() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&calls);
        let fixture = session_reading(
            move |bindings| {
                let mut driver = MockProviderDriver::new();
                driver
                    .expect_switch_session_mcp_servers()
                    .times(1)
                    .returning(move |session_id, run_id, tool_servers| {
                        lock(&recorded).push((session_id, run_id, tool_servers.clone()));
                        let bindings = Arc::clone(&bindings);
                        Box::pin(async move {
                            let is_written = bindings
                                .replace_tool_servers(&run_id, &tool_servers)
                                .await
                                .expect("the arm writes the set");
                            assert!(is_written, "the run's leg holds the set");
                            Ok(McpSessionSwitch::AtNextTurn)
                        })
                    });
                driver
            },
            Connected,
        )
        .await;
        let switches = Arc::new(SessionMcpSwitches::default());
        let mut feed = follow_session_servers(
            Arc::clone(&fixture.methods),
            Arc::clone(&switches),
            fixture.session_id,
        )
        .await
        .expect("the feed opens");
        let gate = CreditGate::with_credit(1);
        let row = |enabled: bool, pending_until_next_turn: bool| SessionMcpServerList {
            session_id: fixture.session_id,
            servers: vec![SessionMcpServer {
                server_name: fixture.server_name.clone(),
                status: Connected,
                reason: None,
                enabled,
                pending_until_next_turn,
            }],
        };
        let first = feed.next(&gate).await.expect("the feed reads");
        assert_eq!(first, Some(row(true, false)));
        let switch_off = || SessionMcpServerEnabledUpdateRequest {
            session_id: fixture.session_id,
            server_name: fixture.server_name.clone(),
            enabled: false,
        };

        let switched = switch_session_server(&fixture.methods, &switches, switch_off())
            .await
            .expect("the switch is made");

        assert!(!switched.enabled);
        let off = vec![SessionToolServer {
            binding: fixture.binding.clone(),
            is_enabled: false,
        }];
        assert_eq!(
            *lock(&calls),
            vec![(fixture.session_id, fixture.run_id, off)],
            "the driver gets the whole set and the stored leg's run once"
        );
        let sent = feed.next(&gate).await.expect("the feed reads");
        assert_eq!(sent, Some(row(false, true)));
        switch_session_server(&fixture.methods, &switches, switch_off())
            .await
            .expect("the same state answers as it stands");
        assert_eq!(lock(&calls).len(), 1, "the same state calls no driver");
    }
}
