//! The MCP server inventory: every binding each provider's driver reads, joined with its status,
//! what the binding store keeps for it and its server's newest tools, as `mcp.server.list` and
//! `mcp.server.read` answer it. Each read reads every source again and keeps nothing between
//! reads: a refresh's probe readings go to the status tracker, which the next read reads.

use std::sync::Arc;

use futures::future::join_all;
use sidekicks_contracts::error::ERROR_MESSAGE_MAX_LEN;
use sidekicks_contracts::mcp::server::inventory::{
    McpAnsweredInventoryEntry, McpOverrideOrigin, McpServerIdempotencyClass,
    McpServerInventoryEntry, McpStoreUnavailableInventoryEntry, McpToolOverride, McpToolReading,
    McpToolSetting,
};
use sidekicks_contracts::mcp::server::requests::{
    McpProviderReadFailure, McpServerListRequest, McpServerListResponse,
};
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpToolName};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::True;
use sidekicks_contracts::wire::list::UniqueList;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_contracts::wire::text::{TextError, is_ecmascript_whitespace};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::redaction::{sanitize_failure_chain, sanitize_failure_reason};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::account::homes::{AccountHome, AccountHomesReadError, read_account_homes};
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::mcp_server::read::{
    McpProbeReading, McpProbeScope, McpServerDeclaration, McpServerToolDefaults,
    McpServersReadRequest,
};
use sidekicks_provider::driver::mcp_server::status::McpServerReading;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_workspace::project::records::{ProjectReadError, ProjectRecords};

use crate::binding::binding_arm;
use crate::binding::resolver::{
    McpAccountsAsked, McpAttributionTable, McpBindingRow, attached_root_path, resolve_binding_rows,
};
use crate::binding::store::{
    McpBindingKey, McpBindingLanding, McpBindingStore, PROJECT_SWITCH_SCOPES,
};
use crate::errors::McpRefusal;
use crate::status::McpServerStatusTracker;
use crate::status::machine_probe::{
    McpMachineProbeGate, McpMachineProbeTurn, wait_for_machine_probe,
};

/// What the inventory reads: the providers' drivers, the database the accounts are read from, the
/// attached projects, the binding store, the bindings' statuses, the attribution table each read
/// refreshes and the gate that keeps one machine probe per provider.
pub struct McpInventorySources {
    /// The registered providers, each with its driver.
    pub providers: Arc<ProviderRegistry>,
    /// The read pool the provider accounts are read on.
    pub reads: Arc<DatabaseReadPool>,
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
/// read. A list fails only with the failure of a source every provider shares.
#[derive(Debug, thiserror::Error)]
pub enum McpInventoryError {
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
    /// A stored account of the provider has an id that is not an account id.
    #[error("a stored {} account's id is not an account id", .provider.as_str())]
    AccountId {
        /// The provider.
        provider: ProviderId,
    },
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

impl From<McpInventoryError> for HandlerError {
    /// The reply to an inventory failure: a refusal by its code, a driver's read as the driver's
    /// error answers a call, and every other source that could not be read a fault inside the
    /// daemon.
    fn from(error: McpInventoryError) -> Self {
        match error {
            McpInventoryError::Refused(refusal) => Self::Refused(DomainError::from(refusal)),
            McpInventoryError::Driver { source, .. } => Self::from(source),
            fault @ (McpInventoryError::Projects(_)
            | McpInventoryError::ProjectRoot(_)
            | McpInventoryError::Accounts(_)
            | McpInventoryError::AccountId { .. }) => Self::Internal(Box::new(fault)),
        }
    }
}

/// The inventory `mcp.server.list` and `mcp.server.read` answer from. It keeps nothing between
/// reads.
pub struct McpInventoryService {
    sources: McpInventorySources,
}

/// The sources one read shares across its providers: each attached project with its root, the
/// roots the read adds besides and every account.
struct McpInventoryContext {
    attached_projects: Vec<(ProjectId, PlacedPath)>,
    extra_roots: Vec<PlacedPath>,
    accounts: Vec<AccountHome>,
}

impl McpInventoryContext {
    // Every root the drivers read: the attached projects', then the ones the read adds.
    fn attached_roots(&self) -> Vec<PlacedPath> {
        self.attached_projects
            .iter()
            .map(|(_project_id, root)| root)
            .chain(&self.extra_roots)
            .cloned()
            .collect()
    }
}

impl McpInventoryService {
    /// An inventory over `sources`.
    pub fn new(sources: McpInventorySources) -> Self {
        Self { sources }
    }

    /// Every binding each provider declares, in the providers' order, each provider read on its
    /// own: a provider whose driver's read fails, or one of whose stored accounts has an id that is
    /// not one, is named with its cause beside the others' rows.
    /// A refresh has each driver read again what it keeps between reads and probe every binding
    /// it can, one probe per provider at a time: a refresh that finds its provider's probe running
    /// waits for it and reads what it recorded. Fails as a source every provider shares cannot be
    /// read.
    pub async fn list(
        &self,
        request: &McpServerListRequest,
    ) -> Result<McpServerListResponse, McpInventoryError> {
        let is_refresh = request.refresh == Some(true);
        let context = self.read_context().await?;
        let providers = join_all(self.sources.providers.drivers().map(|(provider, driver)| {
            self.list_provider(provider, driver.as_ref(), &context, is_refresh)
        }))
        .await;
        let mut servers = Vec::new();
        let mut failed_providers = Vec::new();
        for rows in providers {
            match rows {
                Ok(rows) => servers.extend(rows.into_iter().map(|(_key, entry)| entry)),
                Err(McpInventoryError::Driver { provider, source }) => {
                    failed_providers.push(name_failed_provider(provider, &source));
                }
                Err(ref error @ McpInventoryError::AccountId { ref provider }) => {
                    failed_providers.push(name_failed_provider(provider.clone(), error));
                }
                Err(
                    error @ (McpInventoryError::Refused(_)
                    | McpInventoryError::Projects(_)
                    | McpInventoryError::ProjectRoot(_)
                    | McpInventoryError::Accounts(_)),
                ) => return Err(error),
            }
        }
        Ok(McpServerListResponse {
            servers,
            failed_providers,
        })
    }

    /// The binding `binding` names. Refuses with [`McpRefusal::ServerNotFound`] where its
    /// provider is not registered or does not declare it, and fails as a source cannot be read.
    pub async fn read(
        &self,
        binding: &McpServerBindingRef,
    ) -> Result<McpServerInventoryEntry, McpInventoryError> {
        self.read_binding(binding, None).await
    }

    /// The binding `landing` names, read as [`Self::read`] reads it with `landing`'s row laid over
    /// what the store keeps, for a change's answer read before that row commits.
    pub(crate) async fn read_landed(
        &self,
        landing: McpBindingLanding<'_>,
    ) -> Result<McpServerInventoryEntry, McpInventoryError> {
        self.read_binding(landing.binding, Some(landing)).await
    }

    // The binding `binding` names, with `landing`'s row laid over what the store keeps.
    async fn read_binding(
        &self,
        binding: &McpServerBindingRef,
        landing: Option<McpBindingLanding<'_>>,
    ) -> Result<McpServerInventoryEntry, McpInventoryError> {
        let key = McpBindingKey::of(binding);
        let not_found = || McpRefusal::ServerNotFound {
            binding: Box::new(binding.clone()),
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
                landing,
            )
            .await?;
        entries
            .into_iter()
            .find(|(entry_key, _entry)| *entry_key == key)
            .map(|(_key, entry)| entry)
            .ok_or_else(|| not_found().into())
    }

    /// Every declaration `provider` holds across the attached roots and its accounts, read as a
    /// list reads it, with no probe and no refresh; a provider that is not registered declares
    /// none. Fails as a source or the provider's driver cannot be read.
    pub(crate) async fn read_declarations(
        &self,
        provider: &ProviderId,
    ) -> Result<Vec<McpServerDeclaration>, McpInventoryError> {
        let Some((provider, driver)) = self
            .sources
            .providers
            .drivers()
            .find(|(registered, _driver)| *registered == provider)
        else {
            return Ok(Vec::new());
        };
        let context = self.read_context().await?;
        let rows = self
            .read_resolved_rows(
                provider,
                driver.as_ref(),
                &context,
                false,
                McpProbeScope::None,
                None,
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|(_key, row)| row.declaration)
            .collect())
    }

    /// Every registered provider's declarations, in the registry's order, read as
    /// [`Self::read_declarations`] reads one provider's, over the attached roots and `extra_roots`
    /// besides, the attached roots and the accounts read once for every provider. Fails as a
    /// source or a provider's driver cannot be read.
    pub(crate) async fn read_every_declaration(
        &self,
        extra_roots: &[PlacedPath],
    ) -> Result<Vec<(ProviderId, Vec<McpServerDeclaration>)>, McpInventoryError> {
        let mut context = self.read_context().await?;
        context.extra_roots = extra_roots.to_vec();
        let mut declarations = Vec::new();
        for (provider, driver) in self.sources.providers.drivers() {
            let rows = self
                .read_resolved_rows(
                    provider,
                    driver.as_ref(),
                    &context,
                    false,
                    McpProbeScope::None,
                    None,
                )
                .await?;
            declarations.push((
                provider.clone(),
                rows.into_iter()
                    .map(|(_key, row)| row.declaration)
                    .collect(),
            ));
        }
        Ok(declarations)
    }

    /// Fills the attribution table from one read per provider of what it loads at each attached
    /// root, with no account, no probe and no refresh, so a leg that reports before any list
    /// resolves its servers; the status tracker's readings stay as they are. A provider whose read
    /// fails keeps the table as it was, is logged and is recorded as a failed fill; a failed read
    /// of the attached roots fills nothing, is logged and records every provider's fill as failed.
    pub async fn fill_attribution(&self) {
        let attached_roots: Vec<PlacedPath> = match self.read_attached_projects().await {
            Ok(projects) => projects
                .into_iter()
                .map(|(_project_id, root)| root)
                .collect(),
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the attached roots could not be read, so no MCP server name was attributed"
                );
                for (provider, _driver) in self.sources.providers.drivers() {
                    self.sources.attribution.record_failed_fill(provider);
                }
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
                    Err(error) => {
                        tracing::warn!(
                            error = &error as &(dyn std::error::Error + 'static),
                            provider = provider.as_str(),
                            "the provider's MCP servers could not be read, so their names resolve \
                             as the last read left them"
                        );
                        self.sources.attribution.record_failed_fill(provider);
                    }
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
                .read_provider_rows(provider, driver, context, false, McpProbeScope::None, None)
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
                    None,
                )
                .await
            }
            McpMachineProbeTurn::Wait(running) => {
                wait_for_machine_probe(running).await;
                self.read_provider_rows(provider, driver, context, false, McpProbeScope::None, None)
                    .await
            }
        }
    }

    /// The attached project whose root is `root`, or `None` where no attached project's is.
    /// Fails as the attached projects cannot be read.
    pub(crate) async fn attached_project_at(
        &self,
        root: &PlacedPath,
    ) -> Result<Option<ProjectId>, McpInventoryError> {
        Ok(self
            .read_attached_projects()
            .await?
            .into_iter()
            .find(|(_project_id, attached)| attached == root)
            .map(|(project_id, _root)| project_id))
    }

    // The attached projects and the accounts, read once for every provider of one read.
    async fn read_context(&self) -> Result<McpInventoryContext, McpInventoryError> {
        let (attached_projects, accounts) = tokio::join!(
            self.read_attached_projects(),
            read_account_homes(&self.sources.reads)
        );
        Ok(McpInventoryContext {
            attached_projects: attached_projects?,
            extra_roots: Vec::new(),
            accounts: accounts.map_err(McpInventoryError::Accounts)?,
        })
    }

    // Each attached project with its root.
    async fn read_attached_projects(
        &self,
    ) -> Result<Vec<(ProjectId, PlacedPath)>, McpInventoryError> {
        self.sources
            .projects
            .read_attached_roots()
            .await
            .map_err(McpInventoryError::Projects)?
            .iter()
            .map(|root| attached_root_path(root).map(|path| (root.project_id, path)))
            .collect::<Result<_, _>>()
            .map_err(McpInventoryError::ProjectRoot)
    }

    /// Reads `provider`'s bindings through `driver`, asking it to probe the bindings `probe`
    /// names, the store's `local` bindings among them, and, on `is_refresh`, to read again what it
    /// keeps, for each of the provider's stored accounts, with `landing`'s row, where given, laid
    /// over what the store keeps; this is the one read a probe trigger calls. Each row is keyed by
    /// its binding. The attribution table takes the provider's reading unless a later read already
    /// replaced it, a refresh then has the driver ask its live sessions again, each probe reading
    /// the driver answers lands in [`Self::keep_probe_readings`], and, where this read is the
    /// newest, the tracker forgets the probe reading of every binding of the provider the rows no
    /// longer hold. Fails with [`McpInventoryError::AccountId`] where a stored account of the
    /// provider has an id that is not one, and as the driver's read fails; a store that does not
    /// answer gives each row the store-unavailable arm and forgets no probe reading, since without
    /// it the emulated `local` rows are not listed.
    async fn read_provider_rows(
        &self,
        provider: &ProviderId,
        driver: &dyn ProviderDriver,
        context: &McpInventoryContext,
        is_refresh: bool,
        probe: McpProbeScope,
        landing: Option<McpBindingLanding<'_>>,
    ) -> Result<Vec<(McpBindingKey, McpServerInventoryEntry)>, McpInventoryError> {
        Ok(self
            .read_resolved_rows(provider, driver, context, is_refresh, probe, landing)
            .await?
            .into_iter()
            .map(|(key, row)| {
                let entry = self.entry(&key, row, context);
                (key, entry)
            })
            .collect())
    }

    // The read [`Self::read_provider_rows`] makes, each binding's row resolved and keyed before
    // it becomes an entry.
    async fn read_resolved_rows(
        &self,
        provider: &ProviderId,
        driver: &dyn ProviderDriver,
        context: &McpInventoryContext,
        is_refresh: bool,
        probe: McpProbeScope,
        landing: Option<McpBindingLanding<'_>>,
    ) -> Result<Vec<(McpBindingKey, McpBindingRow)>, McpInventoryError> {
        let provider_account_ids = context
            .accounts
            .iter()
            .filter(|account| account.provider == provider.as_str())
            .map(|account| {
                ProviderAccountId::new(account.account_id.clone()).ok_or_else(|| {
                    McpInventoryError::AccountId {
                        provider: provider.clone(),
                    }
                })
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
            .ok()
            .map(|mut stored| {
                if let Some(landing) = &landing {
                    stored.record(landing);
                }
                stored
            });
        let request = McpServersReadRequest {
            attached_roots: context.attached_roots(),
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
        Ok(rows)
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
    // it answered, each project the daemon switched it off in named by the root it is at now.
    fn entry(
        &self,
        key: &McpBindingKey,
        row: McpBindingRow,
        context: &McpInventoryContext,
    ) -> McpServerInventoryEntry {
        let enabled = row.own_switch();
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
        let probe_failure_reason = status_reading
            .probe_failure_reason
            .and_then(|text| failure_reason_text(&text));
        let superseded_in = unique_places(declaration.superseded_in);
        let organization_managed = declaration.organization_managed;
        let Some(stored) = stored else {
            let binding_store_unavailable = True::default();
            // Where the per-project switch lives in the store, the driver's roots alone would read
            // as switched off nowhere else, so the member is absent.
            let disabled_in = if PROJECT_SWITCH_SCOPES.contains(&key.scope) {
                None
            } else {
                unique_places(declaration.disabled_in)
            };
            return McpServerInventoryEntry::StoreUnavailable(binding_arm!(
                McpStoreUnavailableInventoryEntry,
                declaration.binding,
                {
                    server_binding_id,
                    config,
                    status,
                    legs,
                    observed_at,
                    probe_failure_reason,
                    superseded_in,
                    disabled_in,
                    organization_managed,
                    binding_store_unavailable,
                    enabled,
                }
            ));
        };
        let enabled = enabled.expect("a row the store answered has its own switch");
        let disabled_in = unique_places(
            declaration
                .disabled_in
                .into_iter()
                .chain(stored.switched_off_in.iter().filter_map(|project_id| {
                    // A project with no attached mount has no root to name until it has one.
                    context
                        .attached_projects
                        .iter()
                        .find(|(attached, _root)| attached == project_id)
                        .map(|(_project_id, root)| McpOverrideOrigin::Placed(root.clone()))
                }))
                .collect(),
        );
        let tools = tool_readings(
            status_reading.tool_names,
            &declaration.tool_defaults,
            &stored.tool_overrides,
        );
        let binding_store_unavailable = None;
        McpServerInventoryEntry::Answered(binding_arm!(
            McpAnsweredInventoryEntry,
            declaration.binding,
            {
                server_binding_id,
                config,
                status,
                legs,
                observed_at,
                probe_failure_reason,
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

// `provider`, whose read failed with `error`, as the list names it, the failure logged.
fn name_failed_provider(
    provider: ProviderId,
    error: &(dyn std::error::Error + 'static),
) -> McpProviderReadFailure {
    tracing::warn!(
        error,
        provider = provider.as_str(),
        "the provider's MCP servers could not be read, so the list names it without its rows"
    );
    McpProviderReadFailure {
        provider,
        cause: read_failure_cause(error),
    }
}

// Why a provider's read failed, as the list names it: the error and its causes, with no
// credential, address query or file path, cut to the cap.
fn read_failure_cause(
    error: &(dyn std::error::Error + 'static),
) -> FreeFormText<ERROR_MESSAGE_MAX_LEN> {
    FreeFormText::new(sanitize_failure_chain(error, ERROR_MESSAGE_MAX_LEN)).unwrap_or_else(
        |_blank| {
            FreeFormText::new("The provider's MCP servers could not be read".to_owned())
                .expect("the fallback is text")
        },
    )
}

/// `text`, a provider's or a driver's words about a failure, as the wire carries a failure reason:
/// with no credential, address query, file path or NUL, cut to its cap; `None` where nothing but
/// whitespace is left.
pub(crate) fn failure_reason_text(text: &str) -> Option<FreeFormText<ERROR_MESSAGE_MAX_LEN>> {
    // A blank text carries no reason; past that, the NUL dropped and the cap kept leave nothing
    // the text check refuses.
    let reason = sanitize_failure_reason(&text.replace('\0', ""), ERROR_MESSAGE_MAX_LEN);
    (!reason.chars().all(is_ecmascript_whitespace)).then(|| {
        FreeFormText::new(reason)
            .expect("a sanitized, NUL-free, non-blank reason within its cap is free text")
    })
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
