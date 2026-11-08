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
use sidekicks_provider::driver::contract::ProviderDriver;
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
                let AddressRead {
                    reading,
                    every_project_rows,
                    project_rows,
                } = self
                    .read_address(driver.as_ref(), binding, &provider_accounts)
                    .await?;
                let address: McpServerAddress = match reading {
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
        let read = self
            .read_address(driver.as_ref(), binding, &provider_accounts)
            .await?;
        match read.reading {
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
    /// read. Fails as the inventory, the accounts, the rows or a driver fail.
    pub(crate) async fn read_remote_addresses(
        &self,
    ) -> Result<Vec<(McpServerBindingRef, Option<McpServerAddress>)>, HandlerError> {
        let provider_accounts = self.read_provider_accounts().await?;
        let mut addresses = Vec::new();
        for (provider, driver) in self.providers.drivers() {
            for declaration in self.inventory.read_declarations(provider).await? {
                let is_remote = matches!(
                    declaration.config,
                    McpServerConfigView::Http { .. } | McpServerConfigView::Sse { .. }
                );
                if !is_remote
                    || matches!(declaration.binding, McpServerBindingRef::Connector { .. })
                {
                    continue;
                }
                let read = self
                    .read_address(driver.as_ref(), &declaration.binding, &provider_accounts)
                    .await?;
                let address = match read.reading {
                    Ok(McpServerAddressReading::Declared(address)) => Some(address),
                    Ok(McpServerAddressReading::Unreadable) => None,
                    Err(DriverError::NoPersonServerEntry(_)) => continue,
                    Err(error) => return Err(HandlerError::from(error)),
                };
                addresses.push((declaration.binding, address));
            }
        }
        Ok(addresses)
    }

    // Reads `binding`'s whole address through `driver`, its provider's, with that provider's
    // account in `provider_accounts`, the binding's root folder and its own environment rows,
    // which it answers beside the reading.
    async fn read_address(
        &self,
        driver: &dyn ProviderDriver,
        binding: &McpServerBindingRef,
        provider_accounts: &ProviderAccounts,
    ) -> Result<AddressRead, HandlerError> {
        let (every_project_rows, project_rows) = self.read_environment_rows(binding).await?;
        let reading = driver
            .read_mcp_server_address(McpServerAddressRead {
                binding: binding.clone(),
                provider_account_id: provider_accounts.get(binding.provider()).cloned(),
                root_folder: root_folder_of(binding),
                every_project_rows: every_project_rows.clone(),
                project_rows: project_rows.clone(),
            })
            .await;
        Ok(AddressRead {
            reading,
            every_project_rows,
            project_rows,
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

/// A binding's address as its driver read it, with the environment rows the read filled it from.
struct AddressRead {
    /// The driver's reading.
    reading: Result<McpServerAddressReading, DriverError>,
    /// The machine's `Every project` rows.
    every_project_rows: Vec<EnvironmentRow>,
    /// The binding's project's own rows.
    project_rows: Vec<EnvironmentRow>,
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
pub(crate) mod tests;
