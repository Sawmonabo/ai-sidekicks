//! The MCP server inventory: every binding each provider's driver reads, joined with its status,
//! what the binding store keeps for it and its server's newest tools, as `mcp.server.list` and
//! `mcp.server.read` answer it. Each read reads every source again, so nothing here is a copy of a
//! provider's config; only each binding's newest tool names are kept between reads.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use futures::future::try_join_all;
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::inventory::{
    McpAnsweredInventoryEntry, McpServerIdempotencyClass, McpServerInventoryEntry,
    McpStoreUnavailableInventoryEntry, McpToolOverride, McpToolReading, McpToolSetting,
};
use sidekicks_contracts::mcp::server::requests::McpServerListRequest;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpToolName};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::True;
use sidekicks_contracts::wire::list::UniqueList;
use sidekicks_contracts::wire::text::TextError;
use sidekicks_provider::account_homes::{AccountHome, AccountHomesReadError, read_account_homes};
use sidekicks_provider::driver::contract::{DriverError, ProviderDriver};
use sidekicks_provider::driver::mcp_server::read::{
    McpProbeReading, McpProbeTarget, McpServerToolDefaults, McpServersReadRequest,
};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_workspace::project::records::{ProjectReadError, ProjectRecords};

use crate::binding::resolver::{
    McpAttributionTable, McpBindingRow, attached_root_path, resolve_binding_rows,
};
use crate::binding::store::{McpBindingKey, McpBindingStore};
use crate::errors::McpRefusal;
use crate::status::McpServerStatusTracker;

/// Builds the arm of the inventory entry `$entry` for `$binding`, the binding's identity moved into
/// the arm beside the named locals.
macro_rules! entry_for_binding {
    ($entry:ident, $binding:expr, { $($member:ident),* $(,)? }) => {
        match $binding {
            McpServerBindingRef::User {
                provider,
                server_name,
            } => $entry::User {
                provider,
                server_name,
                $($member,)*
            },
            McpServerBindingRef::Project {
                provider,
                scope_ref,
                place,
                server_name,
            } => $entry::Project {
                provider,
                scope_ref,
                place,
                server_name,
                $($member,)*
            },
            McpServerBindingRef::Local {
                provider,
                scope_ref,
                place,
                server_name,
            } => $entry::Local {
                provider,
                scope_ref,
                place,
                server_name,
                $($member,)*
            },
            McpServerBindingRef::Plugin {
                provider,
                scope_ref,
                server_name,
            } => $entry::Plugin {
                provider,
                scope_ref,
                server_name,
                $($member,)*
            },
            McpServerBindingRef::Connector {
                provider,
                scope_ref,
                server_name,
            } => $entry::Connector {
                provider,
                scope_ref,
                server_name,
                $($member,)*
            },
            McpServerBindingRef::Managed {
                provider,
                server_name,
            } => $entry::Managed {
                provider,
                server_name,
                $($member,)*
            },
        }
    };
}

/// What the inventory reads: the providers' drivers, the database the accounts are read from, the
/// attached projects, the binding store, the bindings' statuses and the attribution table each
/// read refreshes.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's mcp.server.list and mcp.server.read handlers build it"
    )
)]
pub(crate) struct McpInventorySources {
    /// The registered providers, each with its driver.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// The read pool the provider accounts are read on.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The meter the accounts read's time is charged to.
    pub(crate) meter: ProcessorMeter,
    /// The attached projects, whose roots each driver reads.
    pub(crate) projects: Arc<ProjectRecords>,
    /// The bindings' switches, tool overrides and per-project switches.
    pub(crate) store: McpBindingStore,
    /// Each binding's status.
    pub(crate) tracker: Arc<McpServerStatusTracker>,
    /// Which binding a server name a session reports resolves to, replaced at each read.
    pub(crate) attribution: Arc<McpAttributionTable>,
}

/// Why the inventory did not answer: a binding it does not hold, or a source that could not be
/// read. A list fails only with a source's failure.
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpInventoryError {
    /// No provider declares the binding asked for.
    #[error(transparent)]
    Refused(#[from] McpRefusal),
    /// The attached projects could not be read.
    #[error("the attached projects could not be read")]
    Projects(#[source] ProjectReadError),
    /// An attached project's stored root is no path a driver reads.
    #[error("an attached project's root is not a readable path")]
    ProjectRoot(#[source] TextError),
    /// The provider accounts could not be read.
    #[error("the provider accounts could not be read")]
    Accounts(#[source] AccountHomesReadError),
    /// A stored provider account's id is not an account id.
    #[error("a stored provider account's id is not an account id")]
    AccountId,
    /// A provider's driver could not read its MCP servers.
    #[error("the {} driver could not read its MCP servers", .provider.as_str())]
    Driver {
        /// The provider.
        provider: ProviderId,
        /// The driver's failure.
        #[source]
        source: DriverError,
    },
}

/// The inventory `mcp.server.list` and `mcp.server.read` answer from. It keeps only each binding's
/// newest tool names between reads, bounded by the bindings the providers declare.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's mcp.server.list and mcp.server.read handlers call it"
    )
)]
pub(crate) struct McpInventoryService {
    sources: McpInventorySources,
    /// The tool names each binding's newest reading listed, kept for the reads that bring none.
    newest_tool_names: Mutex<HashMap<McpBindingKey, Vec<McpToolName>>>,
}

/// The sources one read shares across its providers: the attached roots and every account.
struct McpInventoryContext {
    attached_roots: Vec<PlacedPath>,
    accounts: Vec<AccountHome>,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's mcp.server.list and mcp.server.read handlers call it"
    )
)]
impl McpInventoryService {
    /// An inventory over `sources`, holding no tool names yet.
    pub(crate) fn new(sources: McpInventorySources) -> Self {
        Self {
            sources,
            newest_tool_names: Mutex::new(HashMap::new()),
        }
    }

    /// Every binding each provider declares, in the providers' order; a refresh has each driver
    /// read again what it keeps between reads. Fails as a source cannot be read.
    pub(crate) async fn list(
        &self,
        request: &McpServerListRequest,
    ) -> Result<Vec<McpServerInventoryEntry>, McpInventoryError> {
        let is_refresh = request.refresh == Some(true);
        let context = self.read_context().await?;
        let providers = try_join_all(self.sources.providers.drivers().map(|(provider, driver)| {
            self.read_provider_rows(provider, driver.as_ref(), &context, is_refresh, Vec::new())
        }))
        .await?;
        Ok(providers
            .into_iter()
            .flatten()
            .map(|(_key, entry)| entry)
            .collect())
    }

    /// The binding `binding` names. Refuses with [`McpRefusal::ServerNotFound`] where its
    /// provider is not registered or does not declare it, and fails as a source cannot be read.
    pub(crate) async fn read(
        &self,
        binding: &McpServerBindingRef,
    ) -> Result<McpServerInventoryEntry, McpInventoryError> {
        let key = McpBindingKey::of(binding);
        let not_found = || McpRefusal::ServerNotFound {
            binding: binding.clone(),
        };
        let (provider, driver) = self
            .sources
            .providers
            .drivers()
            .find(|(provider, _driver)| **provider == key.provider)
            .ok_or_else(not_found)?;
        let context = self.read_context().await?;
        let entries = self
            .read_provider_rows(provider, driver.as_ref(), &context, false, Vec::new())
            .await?;
        entries
            .into_iter()
            .find(|(entry_key, _entry)| *entry_key == key)
            .map(|(_key, entry)| entry)
            .ok_or_else(|| not_found().into())
    }

    // The attached roots and the accounts, read once for every provider of one read.
    async fn read_context(&self) -> Result<McpInventoryContext, McpInventoryError> {
        let (roots, accounts) = tokio::join!(
            self.sources.projects.read_attached_roots(),
            read_account_homes(&self.sources.reads, &self.sources.meter)
        );
        let attached_roots = roots
            .map_err(McpInventoryError::Projects)?
            .iter()
            .map(attached_root_path)
            .collect::<Result<_, _>>()
            .map_err(McpInventoryError::ProjectRoot)?;
        Ok(McpInventoryContext {
            attached_roots,
            accounts: accounts.map_err(McpInventoryError::Accounts)?,
        })
    }

    /// Reads `provider`'s bindings through `driver`, asking it to probe `probe_targets` and, on
    /// `is_refresh`, to read again what it keeps; this is the one read a probe trigger calls. Each
    /// row is keyed by its binding. The attribution table takes the provider's roots, and each
    /// probe reading the driver answers lands in [`Self::keep_probe_readings`]. Fails as the
    /// driver's read fails; a store that does not answer gives each row the store-unavailable arm.
    async fn read_provider_rows(
        &self,
        provider: &ProviderId,
        driver: &dyn ProviderDriver,
        context: &McpInventoryContext,
        is_refresh: bool,
        probe_targets: Vec<McpProbeTarget>,
    ) -> Result<Vec<(McpBindingKey, McpServerInventoryEntry)>, McpInventoryError> {
        let provider_account_ids = context
            .accounts
            .iter()
            .filter(|account| account.provider == provider.as_str())
            .map(|account| {
                ProviderAccountId::new(account.account_id.clone())
                    .ok_or(McpInventoryError::AccountId)
            })
            .collect::<Result<_, _>>()?;
        let request = McpServersReadRequest {
            attached_roots: context.attached_roots.clone(),
            provider_account_ids,
            is_refresh,
            probe_targets,
        };
        let (reading, stored) = tokio::join!(
            driver.read_mcp_servers(request),
            self.sources.store.read_provider_bindings(provider)
        );
        let reading = reading.map_err(|source| McpInventoryError::Driver {
            provider: provider.clone(),
            source,
        })?;
        self.sources
            .attribution
            .replace_provider_loaded(provider, &reading.roots);
        self.keep_probe_readings(&reading.probe_readings);
        let stored = stored
            .inspect_err(|error| {
                tracing::warn!(
                    error = error as &(dyn std::error::Error + 'static),
                    provider = provider.as_str(),
                    "the MCP binding store did not answer; the inventory serves its rows without \
                     what the store keeps"
                );
            })
            .ok();
        let rows = resolve_binding_rows(&reading, stored.as_ref());
        let keys: HashSet<McpBindingKey> = rows
            .iter()
            .map(|row| McpBindingKey::of(&row.declaration.binding))
            .collect();
        lock(&self.newest_tool_names)
            .retain(|key, _tool_names| key.provider != *provider || keys.contains(key));
        Ok(rows
            .into_iter()
            .map(|row| {
                let key = McpBindingKey::of(&row.declaration.binding);
                let entry = self.entry(&key, row);
                (key, entry)
            })
            .collect())
    }

    /// Keeps the tool names of each binding a probe reading names, its newest reading.
    fn keep_probe_readings(&self, readings: &[McpProbeReading]) {
        let mut newest_tool_names = lock(&self.newest_tool_names);
        for reading in readings {
            newest_tool_names.insert(
                McpBindingKey::of(&reading.binding),
                reading.tool_names.clone(),
            );
        }
    }

    // One row's inventory entry: the declaration and the status, and what the store keeps where
    // it answered.
    fn entry(&self, key: &McpBindingKey, row: McpBindingRow) -> McpServerInventoryEntry {
        let McpBindingRow {
            declaration,
            stored,
        } = row;
        let status_reading = self.sources.tracker.reading(key);
        let server_binding_id = key.server_binding_id();
        let config = declaration.config;
        let status = status_reading.status;
        let legs = (!status_reading.legs.is_empty()).then_some(status_reading.legs);
        let observed_at = status_reading.observed_at;
        let superseded_in = unique_places(declaration.superseded_in);
        let provider_enabled = config_enabled(&config);
        let Some(stored) = stored else {
            let binding_store_unavailable = True::default();
            let enabled = (!declaration.is_switch_kept_by_daemon).then_some(provider_enabled);
            let disabled_in = unique_places(declaration.disabled_in);
            return McpServerInventoryEntry::StoreUnavailable(entry_for_binding!(
                McpStoreUnavailableInventoryEntry,
                declaration.binding,
                {
                    server_binding_id,
                    config,
                    status,
                    legs,
                    observed_at,
                    superseded_in,
                    disabled_in,
                    binding_store_unavailable,
                    enabled,
                }
            ));
        };
        let enabled = if declaration.is_switch_kept_by_daemon {
            stored.enabled_override.unwrap_or(provider_enabled)
        } else {
            provider_enabled
        };
        let disabled_in = unique_places(
            declaration
                .disabled_in
                .into_iter()
                .chain(stored.switched_off_in)
                .collect(),
        );
        let tool_names = lock(&self.newest_tool_names)
            .get(key)
            .cloned()
            .unwrap_or_default();
        let tools = tool_readings(
            tool_names,
            &declaration.tool_defaults,
            &stored.tool_overrides,
        );
        let binding_store_unavailable = None;
        McpServerInventoryEntry::Answered(entry_for_binding!(
            McpAnsweredInventoryEntry,
            declaration.binding,
            {
                server_binding_id,
                config,
                status,
                legs,
                observed_at,
                superseded_in,
                disabled_in,
                binding_store_unavailable,
                enabled,
                tools,
            }
        ))
    }
}

/// Whether a declaration's own config leaves its server on: its `enabled` member, on where it
/// sets none, as every provider reads an entry without one.
fn config_enabled(config: &McpServerConfigView) -> bool {
    let (McpServerConfigView::Stdio { enabled, .. }
    | McpServerConfigView::Http { enabled, .. }
    | McpServerConfigView::Sse { enabled, .. }) = config;
    enabled.unwrap_or(true)
}

/// `places` without repeats, in their first order; absent where none is left.
fn unique_places(places: Vec<PlacedPath>) -> Option<UniqueList<PlacedPath, 1, { usize::MAX }>> {
    let mut unique: Vec<PlacedPath> = Vec::with_capacity(places.len());
    for place in places {
        if !unique.contains(&place) {
            unique.push(place);
        }
    }
    UniqueList::new(unique)
}

/// Each tool of a server with its settings in force: the tools its newest reading names, then each
/// tool an override names that the reading does not, so a person's setting on a tool the server
/// stopped offering still shows. A facet an override sets reads its value with the server's own
/// beside it; every other facet reads the server's own.
fn tool_readings(
    mut tool_names: Vec<McpToolName>,
    defaults: &McpServerToolDefaults,
    overrides: &[McpToolOverride],
) -> Vec<McpToolReading> {
    for tool_override in overrides {
        if !tool_names.contains(&tool_override.tool_name) {
            tool_names.push(tool_override.tool_name.clone());
        }
    }
    tool_names
        .into_iter()
        .map(|tool_name| {
            let tool_override = overrides
                .iter()
                .find(|tool_override| tool_override.tool_name == tool_name);
            McpToolReading {
                enabled: setting(
                    tool_override.and_then(|tool_override| tool_override.enabled),
                    defaults.is_tool_enabled(&tool_name),
                ),
                approval_mode: setting(
                    tool_override.and_then(|tool_override| tool_override.approval_mode),
                    defaults.tool_approval_mode(&tool_name),
                ),
                idempotency_class: setting(
                    tool_override.and_then(|tool_override| tool_override.idempotency_class),
                    McpServerIdempotencyClass::Value,
                ),
                tool_name,
            }
        })
        .collect()
}

/// A facet's setting in force: the override's value with `server_value` beside it, else
/// `server_value`.
fn setting<OverrideValue, ServerValue>(
    override_value: Option<OverrideValue>,
    server_value: ServerValue,
) -> McpToolSetting<OverrideValue, ServerValue> {
    match override_value {
        Some(value) => McpToolSetting::Override {
            value,
            server_value,
        },
        None => McpToolSetting::Server {
            value: server_value,
        },
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, OnceLock};

    use futures::FutureExt;
    use futures::future::ready;
    use rstest::rstest;
    use rusqlite::{Connection, params};
    use sidekicks_contracts::mcp::server::config::McpServerConfigView;
    use sidekicks_contracts::mcp::server::inventory::{
        McpAnsweredInventoryEntry, McpServerIdempotencyClass, McpServerInventoryEntry,
        McpToolReading, McpToolSetting,
    };
    use sidekicks_contracts::mcp::server::requests::McpServerListRequest;
    use sidekicks_contracts::mcp::server::{
        McpApprovalMode, McpServerBindingRef, McpServerName, McpServerStatus, McpToolName,
    };
    use sidekicks_contracts::project::ProjectId;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::mcp_server::read::{
        McpProbeReading, McpServerDeclaration, McpServerPolicy, McpServerToolDefaults,
        ProviderMcpServersReading,
    };
    use sidekicks_provider::driver::mcp_server::status::McpServerReading;
    use sidekicks_provider::driver::test_registry::registry_of_first_provider;
    use sidekicks_std::scheduler::budget::ProcessorMeter;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
    use sidekicks_workspace::project::records::{
        ProjectRecords, ProjectSessionActivity, ProjectSessionFacts,
    };

    use super::{McpInventoryService, McpInventorySources};
    use crate::binding::resolver::McpAttributionTable;
    use crate::binding::store::{McpBindingStore, open_first_observation_drain};
    use crate::schema::schema_parts;
    use crate::status::McpServerStatusTracker;
    use crate::status::notices::McpNoticeBoard;

    /// The statements a read connection keeps prepared: the store's, the accounts' and the roots'.
    const READ_STATEMENT_CAPACITY: usize = 8;

    /// No project has a session; the inventory reads only the attached roots.
    struct NoProjectSessions;

    impl ProjectSessionActivity for NoProjectSessions {
        fn read_session_facts(
            &self,
            _reader: &Connection,
            _project_ids: Option<&[ProjectId]>,
        ) -> rusqlite::Result<Vec<ProjectSessionFacts>> {
            Ok(Vec::new())
        }
    }

    /// Which of the inventory's two reads the test asks.
    enum InventoryRead {
        List,
        Read,
    }

    fn tool(name: &str) -> McpToolName {
        McpToolName::new(name.to_owned()).expect("a tool name")
    }

    fn docs_binding(provider: &ProviderId) -> McpServerBindingRef {
        McpServerBindingRef::User {
            provider: provider.clone(),
            server_name: McpServerName::new("docs".to_owned()).expect("a server name"),
        }
    }

    /// The driver's reading: one `user` server whose newest reading lists two tools.
    fn reading_of(binding: McpServerBindingRef) -> ProviderMcpServersReading {
        ProviderMcpServersReading {
            declarations: vec![McpServerDeclaration {
                binding: binding.clone(),
                config: McpServerConfigView::Stdio {
                    command: "docs-server".to_owned(),
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
                sign_in_client: None,
                is_switch_kept_by_daemon: true,
                tool_defaults: McpServerToolDefaults::with_approval_mode(McpApprovalMode::Auto),
            }],
            roots: Vec::new(),
            is_machine_managed: false,
            server_policy: McpServerPolicy::default(),
            account_servers: Vec::new(),
            probe_readings: vec![McpProbeReading {
                binding,
                reading: McpServerReading::Observed(McpServerStatus::Connected),
                failure_text: None,
                tool_names: vec![tool("search"), tool("delete")],
            }],
        }
    }

    /// A tool whose override sets a facet reads the override's value with the server's own value
    /// beside it, and a tool with none reads the server's own; through the list and through one
    /// binding's read. Killed by the override join dropped, which reads a person's deny as allowed.
    #[rstest]
    #[case::list(InventoryRead::List)]
    #[case::read(InventoryRead::Read)]
    #[tokio::test]
    async fn an_overrides_value_wins_and_keeps_the_servers_own_value(
        #[case] inventory_read: InventoryRead,
    ) {
        let database = TestDatabase::new(schema_parts());
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            READ_STATEMENT_CAPACITY,
        ));
        let store = McpBindingStore::new(writer, Arc::clone(&reads));
        let (outlet, _drain) = open_first_observation_drain(store.clone()).await;
        let provider_of_registry: Arc<OnceLock<ProviderId>> = Arc::new(OnceLock::new());
        let mut driver = MockProviderDriver::new();
        let provider_of_driver = Arc::clone(&provider_of_registry);
        driver.expect_read_mcp_servers().returning(move |_request| {
            let provider = provider_of_driver
                .get()
                .expect("the registry names the provider");
            ready(Ok(reading_of(docs_binding(provider)))).boxed()
        });
        let providers = Arc::new(registry_of_first_provider(Arc::new(driver)));
        let (provider, _driver) = providers.drivers().next().expect("one provider");
        let provider = provider.clone();
        provider_of_registry
            .set(provider.clone())
            .expect("the provider is named once");
        database
            .reader()
            .execute(
                "INSERT INTO mcp_server_bindings
                   (provider, scope, server_name, first_observed_at, updated_at)
                 VALUES (?1, 'user', 'docs', 't', 't')",
                params![provider.as_str()],
            )
            .expect("the binding's row is stored");
        database
            .reader()
            .execute(
                "INSERT INTO mcp_tool_overrides
                   (provider, scope, server_name, tool_name, enabled, created_at, updated_at)
                 VALUES (?1, 'user', 'docs', 'delete', 0, 't', 't')",
                params![provider.as_str()],
            )
            .expect("the person's deny is stored");
        let service = McpInventoryService::new(McpInventorySources {
            providers,
            reads: Arc::clone(&reads),
            meter: ProcessorMeter::default(),
            projects: Arc::new(ProjectRecords::new(reads, Arc::new(NoProjectSessions))),
            store,
            tracker: Arc::new(McpServerStatusTracker::new(
                Arc::new(McpNoticeBoard::default()),
                outlet,
            )),
            attribution: Arc::new(McpAttributionTable::default()),
        });

        let entry = match inventory_read {
            InventoryRead::List => {
                let entries = service
                    .list(&McpServerListRequest { refresh: None })
                    .await
                    .expect("the inventory lists");
                let [entry] = <[_; 1]>::try_from(entries).expect("one entry");
                entry
            }
            InventoryRead::Read => service
                .read(&docs_binding(&provider))
                .await
                .expect("the binding is read"),
        };

        let McpServerInventoryEntry::Answered(McpAnsweredInventoryEntry::User { tools, .. }) =
            &entry
        else {
            panic!("the user binding's answered entry: {entry:?}");
        };
        let server_reading = |tool_name: &str, enabled| McpToolReading {
            tool_name: tool(tool_name),
            enabled,
            approval_mode: McpToolSetting::Server {
                value: McpApprovalMode::Auto,
            },
            idempotency_class: McpToolSetting::Server {
                value: McpServerIdempotencyClass::Value,
            },
        };
        assert_eq!(
            *tools,
            [
                server_reading("search", McpToolSetting::Server { value: true }),
                server_reading(
                    "delete",
                    McpToolSetting::Override {
                        value: false,
                        server_value: true,
                    }
                ),
            ]
        );
    }
}
