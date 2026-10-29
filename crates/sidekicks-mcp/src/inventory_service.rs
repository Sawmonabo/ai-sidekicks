//! The MCP server inventory: every binding each provider's driver reads, joined with its status,
//! what the binding store keeps for it and its server's newest tools, as `mcp.server.list` and
//! `mcp.server.read` answer it. Each read reads every source again and keeps nothing between
//! reads: a refresh's probe readings go to the status tracker, which the next read reads.

use std::sync::Arc;

use futures::future::{join_all, try_join_all};
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::inventory::{
    McpAnsweredInventoryEntry, McpOverrideOrigin, McpServerIdempotencyClass,
    McpServerInventoryEntry, McpStoreUnavailableInventoryEntry, McpToolOverride, McpToolReading,
    McpToolSetting,
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
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::mcp_server::read::{
    McpProbeReading, McpProbeScope, McpServerToolDefaults, McpServersReadRequest,
};
use sidekicks_provider::driver::mcp_server::status::McpServerReading;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_workspace::project::records::{ProjectReadError, ProjectRecords};

use crate::binding::resolver::{
    McpAccountsAsked, McpAttributionTable, McpBindingRow, attached_root_path, resolve_binding_rows,
};
use crate::binding::store::{McpBindingKey, McpBindingStore, PROJECT_SWITCH_SCOPES};
use crate::errors::McpRefusal;
use crate::status::McpServerStatusTracker;
use crate::status::machine_probe::{
    McpMachineProbeGate, McpMachineProbeTurn, wait_for_machine_probe,
};

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
/// attached projects, the binding store, the bindings' statuses, the attribution table each read
/// refreshes and the gate that keeps one machine probe per provider.
pub struct McpInventorySources {
    /// The registered providers, each with its driver.
    pub providers: Arc<ProviderRegistry>,
    /// The read pool the provider accounts are read on.
    pub reads: Arc<DatabaseReadPool>,
    /// The meter the accounts read's time is charged to.
    pub meter: ProcessorMeter,
    /// The attached projects, whose roots each driver reads.
    pub projects: Arc<ProjectRecords>,
    /// The bindings' switches, tool overrides and per-project switches.
    pub store: McpBindingStore,
    /// Each binding's status and its server's newest tool names.
    pub tracker: Arc<McpServerStatusTracker>,
    /// Which binding a server name a session reports resolves to, replaced at each read.
    pub attribution: Arc<McpAttributionTable>,
    /// Which providers a machine probe runs for.
    pub probe_gate: Arc<McpMachineProbeGate>,
}

/// Why the inventory did not answer: a binding it does not hold, or a source that could not be
/// read. A list fails only with a source's failure.
#[derive(Debug, thiserror::Error)]
pub enum McpInventoryError {
    /// No provider declares the binding asked for.
    #[error(transparent)]
    Refused(Box<McpRefusal>),
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

impl From<McpRefusal> for McpInventoryError {
    fn from(refusal: McpRefusal) -> Self {
        Self::Refused(Box::new(refusal))
    }
}

/// The inventory `mcp.server.list` and `mcp.server.read` answer from. It keeps nothing between
/// reads.
pub struct McpInventoryService {
    sources: McpInventorySources,
}

/// The sources one read shares across its providers: the attached roots and every account.
struct McpInventoryContext {
    attached_roots: Vec<PlacedPath>,
    accounts: Vec<AccountHome>,
}

impl McpInventoryService {
    /// An inventory over `sources`.
    pub fn new(sources: McpInventorySources) -> Self {
        Self { sources }
    }

    /// Every binding each provider declares, in the providers' order. A refresh has each driver
    /// read again what it keeps between reads and probe every binding it can, one probe per
    /// provider at a time: a refresh that finds its provider's probe running waits for it and
    /// reads what it recorded. Fails as a source cannot be read.
    pub async fn list(
        &self,
        request: &McpServerListRequest,
    ) -> Result<Vec<McpServerInventoryEntry>, McpInventoryError> {
        let is_refresh = request.refresh == Some(true);
        let context = self.read_context().await?;
        let providers = try_join_all(self.sources.providers.drivers().map(|(provider, driver)| {
            self.list_provider(provider, driver.as_ref(), &context, is_refresh)
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
    pub async fn read(
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
            .read_provider_rows(
                provider,
                driver.as_ref(),
                &context,
                false,
                McpProbeScope::None,
            )
            .await?;
        entries
            .into_iter()
            .find(|(entry_key, _entry)| *entry_key == key)
            .map(|(_key, entry)| entry)
            .ok_or_else(|| not_found().into())
    }

    /// Fills the attribution table from one read per provider of what it loads at each attached
    /// root, with no account, no probe and no refresh, so a leg that reports before any list
    /// resolves its servers; the status tracker's readings stay as they are. A provider whose read
    /// fails keeps the table as it was and is logged; a failed read of the attached roots fills
    /// nothing and is logged.
    pub async fn fill_attribution(&self) {
        let attached_roots = match self.read_attached_roots().await {
            Ok(roots) => roots,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the attached roots could not be read, so no MCP server name was attributed"
                );
                return;
            }
        };
        join_all(self.sources.providers.drivers().map(|(provider, driver)| {
            let request = McpServersReadRequest {
                attached_roots: Vec::clone(&attached_roots),
                provider_account_ids: Vec::new(),
                is_refresh: false,
                probe: McpProbeScope::None,
                emulated_local_bindings: Vec::new(),
            };
            async move {
                let stamp = self.sources.attribution.stamp_read();
                match driver.read_mcp_servers(request).await {
                    Ok(reading) => {
                        self.sources.attribution.replace_provider_loaded(
                            provider,
                            &reading,
                            McpAccountsAsked::NotAsked,
                            stamp,
                        );
                    }
                    Err(error) => tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        provider = provider.as_str(),
                        "the provider's MCP servers could not be read, so their names resolve \
                         as the last read left them"
                    ),
                }
            }
        }))
        .await;
    }

    // One provider's rows for a list: with no probe, or on a refresh the provider's one probe
    // through the gate, a refresh that finds it running reading after it ends without a probe or a
    // refresh of its own, since the running one refreshed what the driver keeps.
    async fn list_provider(
        &self,
        provider: &ProviderId,
        driver: &dyn ProviderDriver,
        context: &McpInventoryContext,
        is_refresh: bool,
    ) -> Result<Vec<(McpBindingKey, McpServerInventoryEntry)>, McpInventoryError> {
        if !is_refresh {
            return self
                .read_provider_rows(provider, driver, context, false, McpProbeScope::None)
                .await;
        }
        match self.sources.probe_gate.enter(provider) {
            McpMachineProbeTurn::Run(_hold) => {
                self.read_provider_rows(
                    provider,
                    driver,
                    context,
                    true,
                    McpProbeScope::EveryBinding,
                )
                .await
            }
            McpMachineProbeTurn::Wait(running) => {
                wait_for_machine_probe(running).await;
                self.read_provider_rows(provider, driver, context, false, McpProbeScope::None)
                    .await
            }
        }
    }

    // The attached roots and the accounts, read once for every provider of one read.
    async fn read_context(&self) -> Result<McpInventoryContext, McpInventoryError> {
        let (attached_roots, accounts) = tokio::join!(
            self.read_attached_roots(),
            read_account_homes(&self.sources.reads, &self.sources.meter)
        );
        Ok(McpInventoryContext {
            attached_roots: attached_roots?,
            accounts: accounts.map_err(McpInventoryError::Accounts)?,
        })
    }

    // The attached projects' roots.
    async fn read_attached_roots(&self) -> Result<Vec<PlacedPath>, McpInventoryError> {
        self.sources
            .projects
            .read_attached_roots()
            .await
            .map_err(McpInventoryError::Projects)?
            .iter()
            .map(attached_root_path)
            .collect::<Result<_, _>>()
            .map_err(McpInventoryError::ProjectRoot)
    }

    /// Reads `provider`'s bindings through `driver`, asking it to probe the bindings `probe`
    /// names, the store's `local` bindings among them, and, on `is_refresh`, to read again what it
    /// keeps; this is the one read a probe trigger calls. Each row is keyed by its binding. The
    /// attribution table takes the provider's reading unless a later read already replaced it, a
    /// refresh then has the driver ask its live sessions again, each probe reading the driver
    /// answers lands in [`Self::keep_probe_readings`], and, where this read is the newest, the
    /// tracker forgets the probe reading of every binding of the provider the rows no longer hold. Fails as the driver's read fails; a store that does
    /// not answer gives each row the store-unavailable arm and forgets no probe reading, since
    /// without it the emulated `local` rows are not listed.
    async fn read_provider_rows(
        &self,
        provider: &ProviderId,
        driver: &dyn ProviderDriver,
        context: &McpInventoryContext,
        is_refresh: bool,
        probe: McpProbeScope,
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
        // The store is read first, since the driver probes the `local` bindings it keeps.
        let stored = self
            .sources
            .store
            .read_provider_bindings(provider)
            .await
            .inspect_err(|error| {
                tracing::warn!(
                    error = error as &(dyn std::error::Error + 'static),
                    provider = provider.as_str(),
                    "the MCP binding store did not answer; the inventory serves its rows without \
                     what the store keeps"
                );
            })
            .ok();
        let request = McpServersReadRequest {
            attached_roots: context.attached_roots.clone(),
            provider_account_ids,
            is_refresh,
            probe,
            emulated_local_bindings: stored
                .as_ref()
                .map(|stored| stored.local_bindings.clone())
                .unwrap_or_default(),
        };
        let stamp = self.sources.attribution.stamp_read();
        let reading =
            driver
                .read_mcp_servers(request)
                .await
                .map_err(|source| McpInventoryError::Driver {
                    provider: provider.clone(),
                    source,
                })?;
        let is_newest = self.sources.attribution.replace_provider_loaded(
            provider,
            &reading,
            McpAccountsAsked::Asked,
            stamp,
        );
        if is_refresh {
            // Asked once the table holds this read, so each reply resolves against it.
            driver.reread_live_mcp_statuses().await;
        }
        self.keep_probe_readings(&reading.probe_readings);
        let rows: Vec<(McpBindingKey, McpBindingRow)> =
            resolve_binding_rows(&reading, stored.as_ref())
                .into_iter()
                .map(|row| (McpBindingKey::of(&row.declaration.binding), row))
                .collect();
        if is_newest && stored.is_some() {
            let listed = rows.iter().map(|(key, _row)| key.clone()).collect();
            self.sources.tracker.forget_probes_of(provider, &listed);
        }
        Ok(rows
            .into_iter()
            .map(|(key, row)| {
                let entry = self.entry(&key, row);
                (key, entry)
            })
            .collect())
    }

    /// Records in the status tracker each probe reading that observed its server, with its error
    /// text and tool names; a switched-off reading leaves the binding's newest reading as it was.
    fn keep_probe_readings(&self, readings: &[McpProbeReading]) {
        for reading in readings {
            match reading.reading {
                McpServerReading::Observed(status) => self.sources.tracker.record_probe(
                    &reading.binding,
                    status,
                    reading.failure_text.clone(),
                    reading.tool_names.clone(),
                ),
                McpServerReading::SwitchedOff => {}
            }
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
        let organization_managed = declaration.organization_managed;
        let provider_enabled = config_enabled(&config);
        let Some(stored) = stored else {
            let binding_store_unavailable = True::default();
            let enabled = (!declaration.is_switch_kept_by_daemon).then_some(provider_enabled);
            // Where the per-project switch lives in the store, the driver's roots alone would read
            // as switched off nowhere else, so the member is absent.
            let disabled_in = if PROJECT_SWITCH_SCOPES.contains(&key.scope) {
                None
            } else {
                unique_places(declaration.disabled_in)
            };
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
                    organization_managed,
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
                .chain(
                    stored
                        .switched_off_in
                        .into_iter()
                        .map(McpOverrideOrigin::Placed),
                )
                .collect(),
        );
        let tools = tool_readings(
            status_reading.tool_names,
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
                organization_managed,
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
fn unique_places(
    places: Vec<McpOverrideOrigin>,
) -> Option<UniqueList<McpOverrideOrigin, 1, { usize::MAX }>> {
    let mut unique: Vec<McpOverrideOrigin> = Vec::with_capacity(places.len());
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
mod tests;
