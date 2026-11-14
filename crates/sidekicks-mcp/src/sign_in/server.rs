//! The server an MCP sign-in reaches, read from its binding: the provider's declaration, the whole
//! address the binding's entry declares as its driver reads it, never the stripped one the
//! inventory serves, the client the server's owner issued with the secret its driver reads for it,
//! held only in memory, the scopes and the resource the entry asks for, the `https:` address its
//! authorization server's metadata is read at where the entry names one, the binding's project
//! root on this computer, the environment rows that fill the address's variables and each
//! provider's current account.

use std::collections::HashMap;
use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use reqwest::Url;
use secrecy::SecretString;
use sidekicks_contracts::machine::settings::EnvironmentRow;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::config::{McpServerAddress, McpServerConfigView};
use sidekicks_contracts::project::ProjectId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_platforms::DistributionPath;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::sign_in::{
    McpServerAddressRead, McpServerAddressReading, McpSignInCallback, RedirectAddress,
};
use sidekicks_provider::driver::mcp_server::read::McpServerSignInSettings;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::{CurrentProviderAccount, ProviderAccountReader};
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use sidekicks_workspace::project::records::{AttachedProjectRoot, ProjectRecords};

use crate::binding::resolver::{attached_root_path, detached_root_path};
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

/// Reads again the secret of the client a server's owner issued, where the provider of the binding
/// whose entry names it keeps it, for a renewal or a revocation of a sign-in made as that client,
/// so a rotated secret is sent and none is kept beyond the call.
pub trait OwnerClientSecretReads: Send + Sync {
    /// The secret `binding`'s entry gives its owner's client now; `None` where it gives none.
    /// Fails as the binding's provider, its environment rows, the accounts or the driver's read
    /// fail, an entry that is gone among them.
    fn read_owner_client_secret<'read>(
        &'read self,
        binding: &'read McpServerBindingRef,
    ) -> BoxFuture<'read, Result<Option<SecretString>, HandlerError>>;
}

impl OwnerClientSecretReads for SignInTargetReads {
    fn read_owner_client_secret<'read>(
        &'read self,
        binding: &'read McpServerBindingRef,
    ) -> BoxFuture<'read, Result<Option<SecretString>, HandlerError>> {
        async move {
            let driver = self.providers.lookup(binding.provider())?;
            let provider_accounts = self.read_provider_accounts().await?;
            let (every_project_rows, project_rows) = EnvironmentRowReads::read(self)
                .await?
                .rows_of(&self.projects, binding)
                .await?;
            driver
                .read_mcp_owner_client_secret(McpServerAddressRead {
                    binding: binding.clone(),
                    provider_account_id: provider_accounts.get(binding.provider()).cloned(),
                    root_folder: root_folder_of(binding),
                    every_project_rows,
                    project_rows,
                })
                .await
                .map_err(HandlerError::from)
        }
        .boxed()
    }
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

    /// The target of a sign-in to `binding`, its whole address, the callback the provider's own
    /// client sends and the secret of a client its owner issued read through the provider's driver
    /// in one read of the server's entry, made only once the metadata address passes. Refuses
    /// `mcp.server.signInUnsupported` for a connector, whose sign-in is its account's own, for a
    /// metadata address that is no `https:` address (`unusableMetadata`), before any secret is
    /// read or helper run, for a server whose declared address does not read and for an owner's
    /// callback that is no address, and
    /// `mcp.server.notFound` when no provider declares the binding; answers an inventory or driver
    /// failure, a secret or a callback that does not read among them, as each answers a call, and
    /// an accounts, settings or project read that fails, or a stored project root that is no
    /// path, as a fault.
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
                let settings = declaration.sign_in_settings;
                // Checked before the entry's read, which reads the owner's secret and may run the
                // administrator's helper.
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
                let (every_project_rows, project_rows) = EnvironmentRowReads::read(self)
                    .await?
                    .rows_of(&self.projects, binding)
                    .await?;
                // Only a client its owner named has a secret its driver reads.
                let is_owner_client_secret_read = settings
                    .as_ref()
                    .is_some_and(|settings| settings.client_id.is_some());
                let entry_read = McpServerAddressRead {
                    binding: binding.clone(),
                    provider_account_id: provider_accounts.get(provider).cloned(),
                    root_folder: root_folder.clone(),
                    every_project_rows: every_project_rows.clone(),
                    project_rows: project_rows.clone(),
                };
                let entry = match driver
                    .read_mcp_sign_in_entry(entry_read, is_owner_client_secret_read)
                    .await
                {
                    Ok(entry) => entry,
                    // The inventory listed the binding and its entry left before this read.
                    Err(DriverError::NoPersonServerEntry(_)) => return Err(not_found()),
                    Err(error) => return Err(HandlerError::from(error)),
                };
                let address: McpServerAddress = match entry.address {
                    McpServerAddressReading::Declared(address) => address,
                    McpServerAddressReading::Unreadable => {
                        return Err(unsupported(SignInUnsupportedReason::AddressUnreadable));
                    }
                };
                let asks_offline_access_where_listed = settings
                    .as_ref()
                    .is_some_and(|settings| settings.asks_offline_access_where_listed);
                let mut owner_client = match owner_client_of(settings, entry.callback) {
                    Ok(owner_client) => owner_client,
                    Err(OwnerCallbackUnparsed) => {
                        return Err(unsupported(SignInUnsupportedReason::OwnerCallbackUnserved));
                    }
                };
                if let Some(owner) = owner_client.as_mut() {
                    owner.client_secret = entry.owner_client_secret;
                }
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

    /// The whole address a sign-out of `binding` reaches, as its driver reads it: `None` where it
    /// no longer reads, as one whose variable lost its value. No metadata address or owner's client
    /// is read, so a held sign-in is always removable. Refuses as [`Self::read`] does a binding no
    /// provider declares, a connector or a program (`NotReachedAtAddress`) and a WebSocket server
    /// (`AddressUnreadable`); fails as the inventory, the accounts, the rows or the driver fail.
    pub(crate) async fn read_sign_out_address(
        &self,
        binding: &McpServerBindingRef,
    ) -> Result<Option<McpServerAddress>, HandlerError> {
        let refused = |refusal: McpRefusal| HandlerError::Refused(refusal.into());
        let unsupported = |reason| {
            refused(McpRefusal::ServerSignInUnsupported {
                binding: Box::new(binding.clone()),
                reason,
            })
        };
        let not_found = || {
            refused(McpRefusal::ServerNotFound {
                binding: Box::new(binding.clone()),
            })
        };
        if matches!(binding, McpServerBindingRef::Connector { .. }) {
            return Err(unsupported(SignInUnsupportedReason::NotReachedAtAddress));
        }
        let declaration = self
            .inventory
            .read_declarations(binding.provider())
            .await?
            .into_iter()
            .find(|declaration| declaration.binding == *binding)
            .ok_or_else(not_found)?;
        match declaration.config {
            McpServerConfigView::Stdio { .. } => {
                Err(unsupported(SignInUnsupportedReason::NotReachedAtAddress))
            }
            McpServerConfigView::Ws { .. } => {
                Err(unsupported(SignInUnsupportedReason::AddressUnreadable))
            }
            McpServerConfigView::Http { .. } | McpServerConfigView::Sse { .. } => {
                let driver = self.providers.lookup(binding.provider())?;
                let provider_accounts = self.read_provider_accounts().await?;
                match self
                    .read_address(driver.as_ref(), binding, &provider_accounts)
                    .await?
                {
                    Ok(McpServerAddressReading::Declared(address)) => Ok(Some(address)),
                    Ok(McpServerAddressReading::Unreadable) => Ok(None),
                    Err(DriverError::NoPersonServerEntry(_)) => Err(not_found()),
                    Err(error) => Err(HandlerError::from(error)),
                }
            }
        }
    }

    /// The whole address `binding`'s entry declares, read before a removal of it: `None` where
    /// the address does not read or the entry declares none, as a program's does. Fails as the
    /// accounts, the rows or the provider's driver fail, and refuses `provider.notFound` for a
    /// provider that is not registered.
    pub(crate) async fn read_declared_address(
        &self,
        binding: &McpServerBindingRef,
    ) -> Result<Option<McpServerAddress>, HandlerError> {
        let driver = self.providers.lookup(binding.provider())?;
        let provider_accounts = self.read_provider_accounts().await?;
        let reading = self
            .read_address(driver.as_ref(), binding, &provider_accounts)
            .await?;
        match reading {
            Ok(McpServerAddressReading::Declared(address)) => Ok(Some(address)),
            Ok(McpServerAddressReading::Unreadable) | Err(DriverError::NoPersonServerEntry(_)) => {
                Ok(None)
            }
            Err(error) => Err(HandlerError::from(error)),
        }
    }

    /// Every registered provider's remote bindings, each with the whole address it declares as
    /// read with its own rows, `None` where the address does not read; a program, a WebSocket
    /// server and a connector are left unread, and so is a binding whose entry left before its
    /// read. A detached project's folder counts as a project root, so the entries its files still
    /// declare are bindings here. The settings, the attached and detached roots and the accounts
    /// are read once, and each provider's addresses in one read. Fails as the inventory, the
    /// accounts, the rows or a driver fail.
    pub(crate) async fn read_remote_addresses(
        &self,
    ) -> Result<Vec<(McpServerBindingRef, Option<McpServerAddress>)>, HandlerError> {
        let internal = |error: Box<dyn Error + Send + Sync>| HandlerError::Internal(error);
        let provider_accounts = self.read_provider_accounts().await?;
        let mut rows = EnvironmentRowReads::read(self).await?;
        let detached_roots = self
            .projects
            .read_detached_roots()
            .await
            .map_err(|error| internal(Box::new(error)))?
            .iter()
            .map(detached_root_path)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| internal(Box::new(error)))?;
        let mut addresses = Vec::new();
        for (provider, declarations) in self
            .inventory
            .read_every_declaration(&detached_roots)
            .await?
        {
            let Ok(driver) = self.providers.lookup(&provider) else {
                continue;
            };
            let mut requests = Vec::new();
            for declaration in declarations {
                let is_remote = matches!(
                    declaration.config,
                    McpServerConfigView::Http { .. } | McpServerConfigView::Sse { .. }
                );
                if !is_remote
                    || matches!(declaration.binding, McpServerBindingRef::Connector { .. })
                {
                    continue;
                }
                let (every_project_rows, project_rows) =
                    rows.rows_of(&self.projects, &declaration.binding).await?;
                requests.push(McpServerAddressRead {
                    provider_account_id: provider_accounts.get(&provider).cloned(),
                    root_folder: root_folder_of(&declaration.binding),
                    binding: declaration.binding,
                    every_project_rows,
                    project_rows,
                });
            }
            // A provider with no remote binding has no address to read, so its driver is not asked.
            if requests.is_empty() {
                continue;
            }
            let bindings: Vec<McpServerBindingRef> = requests
                .iter()
                .map(|request| request.binding.clone())
                .collect();
            for (binding, reading) in bindings
                .into_iter()
                .zip(driver.read_mcp_server_addresses(requests).await)
            {
                let address = match reading {
                    Ok(McpServerAddressReading::Declared(address)) => Some(address),
                    Ok(McpServerAddressReading::Unreadable) => None,
                    Err(DriverError::NoPersonServerEntry(_)) => continue,
                    Err(error) => return Err(HandlerError::from(error)),
                };
                addresses.push((binding, address));
            }
        }
        Ok(addresses)
    }

    // Reads `binding`'s whole address through `driver`, its provider's, with that provider's
    // account in `provider_accounts`, the binding's root folder and its own environment rows.
    async fn read_address(
        &self,
        driver: &dyn ProviderDriver,
        binding: &McpServerBindingRef,
        provider_accounts: &ProviderAccounts,
    ) -> Result<Result<McpServerAddressReading, DriverError>, HandlerError> {
        let (every_project_rows, project_rows) = EnvironmentRowReads::read(self)
            .await?
            .rows_of(&self.projects, binding)
            .await?;
        Ok(driver
            .read_mcp_server_addresses(vec![McpServerAddressRead {
                binding: binding.clone(),
                provider_account_id: provider_accounts.get(binding.provider()).cloned(),
                root_folder: root_folder_of(binding),
                every_project_rows,
                project_rows,
            }])
            .await
            .pop()
            .expect("a driver answers one reading per read"))
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

/// What the bindings' environment rows are read from, read once for any number of bindings: the
/// machine's `Every project` rows, the attached roots and each project's rows once read.
struct EnvironmentRowReads {
    every_project_rows: Vec<EnvironmentRow>,
    attached_roots: Vec<AttachedProjectRoot>,
    project_rows: HashMap<ProjectId, Vec<EnvironmentRow>>,
}

impl EnvironmentRowReads {
    // The settings and the attached roots `reads` reads from. Fails as either read fails.
    async fn read(reads: &SignInTargetReads) -> Result<Self, HandlerError> {
        let internal = |error: Box<dyn Error + Send + Sync>| HandlerError::Internal(error);
        let every_project_rows = reads
            .machine_settings
            .read_machine_settings()
            .await
            .map_err(internal)?
            .environment_rows;
        let attached_roots = reads
            .projects
            .read_attached_roots()
            .await
            .map_err(|error| internal(Box::new(error)))?;
        Ok(Self {
            every_project_rows,
            attached_roots,
            project_rows: HashMap::new(),
        })
    }

    // The `Every project` rows, and the rows of the project whose attached root is a `project` or
    // `local` binding's root, read from `projects` once per project; no project's rows for any
    // other binding, or for a root no attached project holds, as a session outside a project
    // reads none.
    async fn rows_of(
        &mut self,
        projects: &ProjectRecords,
        binding: &McpServerBindingRef,
    ) -> Result<(Vec<EnvironmentRow>, Vec<EnvironmentRow>), HandlerError> {
        let internal = |error: Box<dyn Error + Send + Sync>| HandlerError::Internal(error);
        let every_project_rows = self.every_project_rows.clone();
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
        for root in &self.attached_roots {
            let root_path = attached_root_path(root).map_err(|error| internal(Box::new(error)))?;
            if root_path.path == *scope_ref && root_path.place == *place {
                project_id = Some(root.project_id);
                break;
            }
        }
        let Some(project_id) = project_id else {
            return Ok((every_project_rows, Vec::new()));
        };
        if let Some(rows) = self.project_rows.get(&project_id) {
            return Ok((every_project_rows, rows.clone()));
        }
        let rows = projects
            .read_entry(project_id)
            .await
            .map_err(|error| internal(Box::new(error)))?
            .map(|entry| entry.environment_rows)
            .unwrap_or_default();
        self.project_rows.insert(project_id, rows.clone());
        Ok((every_project_rows, rows))
    }
}

/// An owner's callback that does not parse as an address.
struct OwnerCallbackUnparsed;

// The owner's client, built from whichever of its id and its callback the entry gives: the
// callback the provider's own client sends where its driver read one, else the entry's whole one
// in both forms. An entry that gives neither builds none, and a callback that does not parse is
// refused.
fn owner_client_of(
    sign_in_settings: Option<McpServerSignInSettings>,
    provider_callback: Option<McpSignInCallback>,
) -> Result<Option<OwnerIssuedClient>, OwnerCallbackUnparsed> {
    let (client_id, callback_url) = sign_in_settings
        .map(|settings| (settings.client_id, settings.callback_url))
        .unwrap_or_default();
    let callback = match provider_callback {
        Some(callback) => Some(callback),
        None => callback_url
            .map(|callback_url| RedirectAddress::parse(&callback_url))
            .transpose()
            .map_err(|_error| OwnerCallbackUnparsed)?
            .map(|callback_url| McpSignInCallback {
                with_issuer: callback_url.clone(),
                without_issuer: callback_url,
            }),
    };
    if client_id.is_none() && callback.is_none() {
        return Ok(None);
    }
    Ok(Some(OwnerIssuedClient {
        client_id,
        client_secret: None,
        callback,
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
pub(crate) mod tests;
