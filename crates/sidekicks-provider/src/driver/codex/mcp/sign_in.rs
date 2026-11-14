//! The sign-in to one MCP server through Codex's own client. The server's entry, the person's as
//! Codex's config read merges it or a plugin's as its file declares it, is copied into a folder of
//! the daemon's own, made for this sign-in alone, beside a setting that keeps Codex's saved
//! sign-ins in a file there; a throwaway Codex service runs on that folder as its home, starts the
//! login, and the caller opens its authorization address. Once Codex reports the login done, the
//! saved sign-in is read back from the folder's file; the service is stopped and the folder
//! removed whatever the outcome, a dropped sign-in's included. The person's own Codex home is only
//! read, for the entry, through Codex's config read; no sign-in of theirs is read or written. The
//! same entry read answers the whole address the entry declares and the redirect Codex's own
//! client sends for it.

mod callback;
mod login_failure;

use std::collections::{BTreeMap, HashMap};
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use secrecy::SecretString;
use serde::Deserialize;
use serde_json::{Map, Value};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_std::missing_entry::MissingEntry as _;
use sidekicks_store::data_folder::plugin_home;
use tokio::sync::oneshot;
use url::Url;

use self::callback::{CodexCallbackSettings, resolve_codex_sign_in_callback};
use self::login_failure::read_codex_login_failure;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::app_server_protocol::McpServerOauthLoginParams;
use crate::driver::codex::config_read::read_codex_config;
use crate::driver::codex::mcp::config::plugins::{CodexPluginServer, read_plugin_server_entries};
use crate::driver::codex::mcp::config::server_entry::{URL_MEMBER, read_owner_client_secret};
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::registry::personal_folder_read::PersonalFolderRead;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::thread::settings::MCP_SERVERS_KEY;
use crate::driver::codex::transport::connection::read_codex_object;
use crate::driver::codex::transport::login_notices::{LoginNotice, LoginNotices};
use crate::driver::contract::error::DriverError;
use crate::driver::contract::sign_in::{
    BEARER_TOKEN_TYPE, McpServerAddressRead, McpServerAddressReading, McpSignInEntryReading,
    NoPersonServerEntry, ProviderSignInFailure, ProviderSignInTakeover,
    ProviderSignInTakeoverRequest,
};
use crate::driver::error_causes::provider_failure_refusal;
use crate::driver::mcp_server::address::names_server_at;
use crate::driver::mcp_server::sign_in_folder::SignInFolder;
use crate::driver::mcp_server::write::ENTRY_SWITCH_MEMBER;
use crate::driver::saved_secret::{read_optional_secret, read_secret};

/// The request that starts a login to one of the home's MCP servers.
const OAUTH_LOGIN_METHOD: &str = "mcpServer/oauth/login";

/// The notice Codex sends once a login ends, done or failed.
const OAUTH_LOGIN_COMPLETED_METHOD: &str = "mcpServer/oauthLogin/completed";

/// The setting naming where Codex keeps the sign-ins it saves for MCP servers, and the value that
/// keeps them in a file under its home.
const CREDENTIALS_STORE_SETTING: (&str, &str) = ("mcp_oauth_credentials_store", "file");

/// The home's settings file Codex reads.
const CODEX_CONFIG_FILE: &str = "config.toml";

/// The file under its home Codex saves MCP sign-ins in when told to keep them in a file.
const CODEX_CREDENTIALS_FILE: &str = ".credentials.json";

/// The prefix Codex gives the saved name of a server whose own name starts with one of its
/// reserved prefixes.
const CODEX_LOCAL_NAME_PREFIX: &str = "local:";

/// The random bytes in one sign-in's folder name, kept short since Codex's control socket lives
/// under it.
const SIGN_IN_FOLDER_NAME_BYTES: usize = 4;

/// How long past the sign-in's lifetime the wait for Codex's own end of the login runs, since
/// Codex ends a login that outlived its timeout itself.
const COMPLETION_MARGIN: Duration = Duration::from_secs(10);

/// Why a sign-in through Codex's own client did not answer credentials. No case carries a
/// credential value.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CodexSignInError {
    /// The sign-in's own folder or its settings file could not be made.
    #[error("the folder Codex's MCP sign-in runs in could not be made")]
    FolderUnmade(#[source] Box<dyn Error + Send + Sync>),
    /// The login's reply named no authorization address Codex's own client could open.
    #[error("Codex's MCP login reply could not be read")]
    LoginReplyUnreadable,
    /// The caller stopped waiting for the authorization address.
    #[error("the MCP sign-in's caller was gone before the browser opened")]
    CallerGone,
    /// The login passed its lifetime with no end from Codex.
    #[error("the MCP sign-in through Codex did not finish in time")]
    Unfinished,
    /// Codex ended the login without a sign-in.
    #[error("Codex's MCP sign-in failed: {failure}")]
    Failed {
        /// Why, as the driver contract's kind.
        failure: ProviderSignInFailure,
    },
    /// The connection to the throwaway service closed before the login ended.
    #[error("the Codex service running the MCP sign-in closed: {reason}")]
    ConnectionClosed {
        /// How it closed, in words.
        reason: String,
    },
    /// The saved sign-ins file could not be read, or did not read as Codex writes it.
    #[error("Codex's saved MCP sign-ins could not be read")]
    CredentialsUnreadable(#[source] Box<dyn Error + Send + Sync>),
    /// The saved sign-ins hold none for the server.
    #[error("Codex saved no sign-in for the MCP server")]
    NoSavedSignIn,
}

impl From<CodexSignInError> for DriverError {
    /// A login that ended in time with Codex's reason, an unreadable reply, a timeout or no saved
    /// sign-in is the sign-in's failure of that kind; a service that closed before the login ended
    /// answers `provider.unavailable` with how it closed bounded as `providerFailureDetail`; every
    /// other failure is the daemon's own.
    fn from(error: CodexSignInError) -> Self {
        match error {
            CodexSignInError::Failed { failure } => Self::SignInFailed(failure),
            CodexSignInError::LoginReplyUnreadable => {
                Self::SignInFailed(ProviderSignInFailure::ReplyUnreadable)
            }
            CodexSignInError::Unfinished => {
                Self::SignInFailed(ProviderSignInFailure::DidNotFinishInTime)
            }
            CodexSignInError::NoSavedSignIn => {
                Self::SignInFailed(ProviderSignInFailure::SignInNotSaved)
            }
            closed @ CodexSignInError::ConnectionClosed { .. } => {
                Self::from(provider_failure_refusal(
                    &DESCRIPTOR.provider_id(),
                    "The Codex service running the MCP sign-in closed before the sign-in finished",
                    RefusalCode::ProviderUnavailable,
                    closed,
                ))
            }
            other @ (CodexSignInError::FolderUnmade(_)
            | CodexSignInError::CallerGone
            | CodexSignInError::CredentialsUnreadable(_)) => Self::Internal(Box::new(other)),
        }
    }
}

/// Signs in to `request`'s server through Codex's own client on a throwaway service of
/// `registry`'s, the server's entry read from the person's config at the binding's root, else at
/// `home_folder`, or from the plugin that carries it, beside the global callback settings that
/// config sets; `request`'s environment rows are not read,
/// since Codex fills no variable in an entry's address. Fails with
/// [`DriverError::NoPersonServerEntry`] for a connector or a binding whose entry is gone or
/// declares another address, as the entry's read, the service's start or a request fails, and
/// with [`CodexSignInError`] for every other failure; the service is stopped and its folder
/// removed either way.
pub(crate) async fn sign_in_with_codex_client(
    registry: &CodexServiceRegistry,
    home_folder: &Path,
    request: ProviderSignInTakeoverRequest,
) -> Result<ProviderSignInTakeover, DriverError> {
    let name = request.binding.server_name().clone();
    let mut entries = CodexServerEntryReader::new(registry, home_folder);
    let entry = entries
        .read(&request.binding, request.root_folder.as_deref())
        .await?
        .filter(|entry| {
            entry
                .get(URL_MEMBER)
                .and_then(Value::as_str)
                .is_some_and(|url| names_server_at(url, &request.server_address))
        })
        .ok_or_else(|| {
            DriverError::from(NoPersonServerEntry {
                binding: request.binding.clone(),
            })
        })?;
    let callback_settings = entries
        .read_callback_settings(request.root_folder.as_deref())
        .await?;
    let settings = compose_sign_in_settings(&name, entry, callback_settings)
        .map_err(|error| CodexSignInError::FolderUnmade(Box::new(error)))?;
    let folder = SignInFolder::make(
        &registry.mcp_sign_in_folder(),
        SIGN_IN_FOLDER_NAME_BYTES,
        CODEX_CONFIG_FILE,
        settings,
    )
    .await
    .map_err(CodexSignInError::FolderUnmade)?;
    let service = registry.mcp_sign_in_service(folder.path().to_owned());
    let signed_in = run_login(&service, &name, request.lifetime, request.authorization_url).await;
    service.stop().await;
    let read = match signed_in {
        Ok(()) => read_saved_sign_in(folder.path(), &name, &request.server_address).await,
        Err(error) => Err(error),
    };
    match (read, folder.remove().await) {
        (read, Ok(())) => read,
        (Ok(_takeover), Err(removal)) => Err(DriverError::Internal(Box::new(removal))),
        (Err(error), Err(removal)) => {
            // The sign-in's own failure is the one the caller acts on.
            tracing::warn!(
                error = &removal as &(dyn Error + 'static),
                "the folder of a Codex MCP sign-in was not removed"
            );
            Err(error)
        }
    }
}

/// Reads the whole address each of `requests`' server entries declares, in the requests' order:
/// its `url` as Codex's merged config or the plugin's file gives it, the environment rows not
/// read, since Codex fills no variable there. Codex's config is read once for each root the
/// requests name and the plugins' files once. Each reading fails with
/// [`DriverError::NoPersonServerEntry`] for a connector and an entry that is gone or names no
/// `url`, and as its entry's read fails.
pub(crate) async fn read_codex_server_addresses(
    registry: &CodexServiceRegistry,
    home_folder: &Path,
    requests: Vec<McpServerAddressRead>,
) -> Vec<Result<McpServerAddressReading, DriverError>> {
    let mut entries = CodexServerEntryReader::new(registry, home_folder);
    let mut readings = Vec::with_capacity(requests.len());
    for request in requests {
        let entry = entries
            .read(&request.binding, request.root_folder.as_deref())
            .await;
        readings.push(entry.and_then(|entry| read_entry_address(entry.as_ref(), &request.binding)));
    }
    readings
}

// The whole address `entry`, `binding`'s, declares in its `url`. Fails with `NoPersonServerEntry`
// where there is no entry or it names no `url`.
fn read_entry_address(
    entry: Option<&Map<String, Value>>,
    binding: &McpServerBindingRef,
) -> Result<McpServerAddressReading, DriverError> {
    let Some(url) = entry
        .and_then(|entry| entry.get(URL_MEMBER))
        .and_then(Value::as_str)
    else {
        return Err(DriverError::from(NoPersonServerEntry {
            binding: binding.clone(),
        }));
    };
    Ok(McpServerAddress::new(url).map_or(
        McpServerAddressReading::Unreadable,
        McpServerAddressReading::Declared,
    ))
}

/// The secret the client of `request`'s server entry holds, read as Codex reads it for a sign-in:
/// from the entry its config or the plugin's file declares; `None` where the entry names no id
/// and secret. Fails with [`DriverError::NoPersonServerEntry`] for a connector and an entry that
/// is gone, and as the entry's read fails.
pub(crate) async fn read_codex_owner_client_secret(
    registry: &CodexServiceRegistry,
    home_folder: &Path,
    request: McpServerAddressRead,
) -> Result<Option<SecretString>, DriverError> {
    let entry = CodexServerEntryReader::new(registry, home_folder)
        .read(&request.binding, request.root_folder.as_deref())
        .await?
        .ok_or_else(|| {
            DriverError::from(NoPersonServerEntry {
                binding: request.binding.clone(),
            })
        })?;
    Ok(read_owner_client_secret(&entry))
}

/// What a sign-in to `request`'s server reads from the entry Codex's config or the plugin's file
/// declares, Codex's config read once at the binding's root, else at `home_folder`: the entry's
/// whole address, the redirect Codex's own client sends with the global callback settings that
/// config sets, `None` where Codex listens on a free port at a path it registers itself, and,
/// where `is_owner_client_secret_read`, the secret the entry's client holds. Fails with
/// [`DriverError::NoPersonServerEntry`] for a connector and an entry that is gone or names no
/// `url`, and as a config read fails.
pub(crate) async fn read_codex_sign_in_entry(
    registry: &CodexServiceRegistry,
    home_folder: &Path,
    request: McpServerAddressRead,
    is_owner_client_secret_read: bool,
) -> Result<McpSignInEntryReading, DriverError> {
    let mut entries = CodexServerEntryReader::new(registry, home_folder);
    let entry = entries
        .read(&request.binding, request.root_folder.as_deref())
        .await?;
    let address = read_entry_address(entry.as_ref(), &request.binding)?;
    let entry = entry.expect("an entry whose address read is present");
    let settings = entries
        .read_callback_settings(request.root_folder.as_deref())
        .await?;
    Ok(McpSignInEntryReading {
        address,
        callback: resolve_codex_sign_in_callback(&entry, settings),
        owner_client_secret: if is_owner_client_secret_read {
            read_owner_client_secret(&entry)
        } else {
            None
        },
    })
}

// Reads server entries for one sign-in or one batch of address reads, Codex's config read once at
// each root and the plugins' files once, however many entries they hold.
struct CodexServerEntryReader<'sources> {
    registry: &'sources CodexServiceRegistry,
    home_folder: &'sources Path,
    // Each root's merged config as a sign-in reads it, by the root it was read at.
    configs: HashMap<PathBuf, CodexSignInConfig>,
    plugins: Option<Vec<CodexPluginServer>>,
}

impl<'sources> CodexServerEntryReader<'sources> {
    fn new(registry: &'sources CodexServiceRegistry, home_folder: &'sources Path) -> Self {
        Self {
            registry,
            home_folder,
            configs: HashMap::new(),
            plugins: None,
        }
    }

    // The entry of `binding`'s server, switched on: a plugin's as its file declares it, as Codex
    // reads its own plugins' entries, and any other's as Codex's config read at `root_folder`,
    // else at the home folder, merges it; `None` where none declares the server. Fails with
    // `NoPersonServerEntry` for a connector, whose sign-in is the account's own, so another
    // provider's flow is asked.
    async fn read(
        &mut self,
        binding: &McpServerBindingRef,
        root_folder: Option<&Path>,
    ) -> Result<Option<Map<String, Value>>, DriverError> {
        let name = binding.server_name();
        let entry = match binding {
            McpServerBindingRef::Connector { .. } => {
                return Err(DriverError::from(NoPersonServerEntry {
                    binding: binding.clone(),
                }));
            }
            McpServerBindingRef::Plugin { .. } => {
                if self.plugins.is_none() {
                    self.plugins = Some(
                        read_plugin_server_entries(&plugin_home(
                            self.home_folder,
                            &DESCRIPTOR.provider_id(),
                        ))
                        .await,
                    );
                }
                self.plugins
                    .iter()
                    .flatten()
                    .find(|server| server.declaration.binding == *binding)
                    .map(CodexPluginServer::compose_codex_entry)
            }
            McpServerBindingRef::User { .. }
            | McpServerBindingRef::Project { .. }
            | McpServerBindingRef::Local { .. }
            | McpServerBindingRef::Managed { .. } => self
                .read_config(root_folder)
                .await?
                .servers
                .as_ref()
                .and_then(|servers| servers.get(name.as_str()))
                .and_then(Value::as_object)
                .cloned(),
        };
        Ok(entry.map(|mut entry| {
            entry.remove(ENTRY_SWITCH_MEMBER);
            entry
        }))
    }

    // The global callback settings Codex's config read at `root_folder`, else at the home folder,
    // sets, which a plugin's server takes as every other server does.
    async fn read_callback_settings(
        &mut self,
        root_folder: Option<&Path>,
    ) -> Result<&CodexCallbackSettings, DriverError> {
        Ok(&self.read_config(root_folder).await?.callback_settings)
    }

    // The person's config as Codex's read at `root_folder`, else at the home folder, merges it,
    // read once per folder.
    async fn read_config(
        &mut self,
        root_folder: Option<&Path>,
    ) -> Result<&CodexSignInConfig, DriverError> {
        let cwd = root_folder.unwrap_or(self.home_folder).to_path_buf();
        if !self.configs.contains_key(&cwd) {
            let folder = cwd.as_path();
            let read = self
                .registry
                .read_on_personal_folder(PersonalFolderRead::Config, |service| async move {
                    let connection = service.connection()?;
                    read_codex_config::<Map<String, Value>>(&connection, Some(folder), false).await
                })
                .await?;
            let config = CodexSignInConfig {
                servers: read
                    .config
                    .get(MCP_SERVERS_KEY)
                    .and_then(Value::as_object)
                    .cloned(),
                callback_settings: CodexCallbackSettings::read(&read.config),
            };
            self.configs.insert(cwd.clone(), config);
        }
        Ok(self
            .configs
            .get(&cwd)
            .expect("the folder's config was read just above"))
    }
}

// What a sign-in reads of the person's merged config at one folder: the servers it declares,
// `None` where it declares none, and the global callback settings.
struct CodexSignInConfig {
    servers: Option<Map<String, Value>>,
    callback_settings: CodexCallbackSettings,
}

/// The settings of a sign-in's own Codex home: sign-ins kept in a file, the person's global
/// `callback_settings`, and `entry` as the one server `name`, its `null` members dropped since
/// TOML has none. Fails when the entry holds a value TOML cannot write.
fn compose_sign_in_settings(
    name: &McpServerName,
    entry: Map<String, Value>,
    callback_settings: &CodexCallbackSettings,
) -> Result<String, toml::ser::Error> {
    let entry = drop_nulls(Value::Object(entry));
    let mut servers = toml::Table::new();
    servers.insert(name.as_str().to_owned(), toml::Value::try_from(entry)?);
    let mut settings = toml::Table::new();
    let (store_setting, store_value) = CREDENTIALS_STORE_SETTING;
    settings.insert(store_setting.to_owned(), toml::Value::from(store_value));
    callback_settings.write_into(&mut settings);
    settings.insert(MCP_SERVERS_KEY.to_owned(), toml::Value::Table(servers));
    toml::to_string(&settings)
}

// `value` with every `null` member and item removed, at every depth.
fn drop_nulls(value: Value) -> Value {
    match value {
        Value::Object(members) => Value::Object(
            members
                .into_iter()
                .filter(|(_, member)| !member.is_null())
                .map(|(key, member)| (key, drop_nulls(member)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .filter(|item| !item.is_null())
                .map(drop_nulls)
                .collect(),
        ),
        scalar @ (Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)) => scalar,
    }
}

// The members of the login's reply the sign-in reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginReply {
    authorization_url: String,
    #[serde(default)]
    login_id: Option<String>,
}

// The members of a completion notice the sign-in reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginCompleted {
    name: String,
    #[serde(default)]
    login_id: Option<String>,
    success: bool,
    #[serde(default)]
    error: Option<String>,
}

// Starts the login to `name` on `service`, hands its authorization address out through
// `authorization_url` and waits, within `lifetime` and a margin, for Codex's notice that this
// login ended; Codex's own listener takes the browser's return. Fails as the start or the request
// fails, and with `CodexSignInError` otherwise.
async fn run_login(
    service: &Arc<CodexService>,
    name: &McpServerName,
    lifetime: Duration,
    authorization_url: oneshot::Sender<Url>,
) -> Result<(), DriverError> {
    let (notices, mut received) = LoginNotices::open(OAUTH_LOGIN_COMPLETED_METHOD);
    let connection = service.open_detached_connection(notices).await?;
    let login = async {
        let reply = connection
            .request(
                OAUTH_LOGIN_METHOD,
                &McpServerOauthLoginParams {
                    name: name.as_str().to_owned(),
                    thread_id: None,
                    client_registration: None,
                    scopes: None,
                    timeout_secs: Some(i64::try_from(lifetime.as_secs()).unwrap_or(i64::MAX)),
                },
            )
            .await?;
        let reply = read_codex_object::<LoginReply>(reply.get())
            .ok_or(CodexSignInError::LoginReplyUnreadable)?;
        let browser_url = Url::parse(&reply.authorization_url)
            .map_err(|_unparsed| CodexSignInError::LoginReplyUnreadable)?;
        authorization_url
            .send(browser_url)
            .map_err(|_unsent| CodexSignInError::CallerGone)?;
        let completed = tokio::time::timeout(lifetime + COMPLETION_MARGIN, async {
            while let Some(notice) = received.recv().await {
                match notice {
                    LoginNotice::Completed(params) => {
                        let Some(completed) = read_codex_object::<LoginCompleted>(params.get())
                        else {
                            continue;
                        };
                        let is_this_login = completed.name == name.as_str()
                            && (reply.login_id.is_none()
                                || completed.login_id.is_none()
                                || completed.login_id == reply.login_id);
                        if is_this_login {
                            return Ok(completed);
                        }
                    }
                    LoginNotice::Closed(reason) => {
                        return Err(CodexSignInError::ConnectionClosed { reason });
                    }
                }
            }
            Err(CodexSignInError::ConnectionClosed {
                reason: "the notices ended".to_owned(),
            })
        })
        .await
        .map_err(|_elapsed| CodexSignInError::Unfinished)??;
        if completed.success {
            Ok(())
        } else {
            Err(CodexSignInError::Failed {
                failure: read_codex_login_failure(completed.error.as_deref()),
            }
            .into())
        }
    }
    .await;
    if let Err(error) = connection.close().await {
        tracing::debug!(
            error = &error as &(dyn Error + 'static),
            "a Codex MCP sign-in's connection did not close cleanly"
        );
    }
    login
}

// Reads the sign-in Codex saved in `folder` for `name` at `address`.
async fn read_saved_sign_in(
    folder: &Path,
    name: &McpServerName,
    address: &McpServerAddress,
) -> Result<ProviderSignInTakeover, DriverError> {
    let Some(text) = tokio::fs::read_to_string(folder.join(CODEX_CREDENTIALS_FILE))
        .await
        .none_if_missing()
        .map_err(unreadable)?
    else {
        return Err(CodexSignInError::NoSavedSignIn.into());
    };
    Ok(read_codex_saved_sign_in(&text, name, address)?)
}

fn unreadable(error: io::Error) -> CodexSignInError {
    CodexSignInError::CredentialsUnreadable(Box::new(error))
}

// One saved sign-in as Codex writes it in its file. It derives no `Debug`, since it holds tokens.
#[derive(Deserialize)]
struct CodexSavedSignIn {
    server_name: String,
    server_url: String,
    #[serde(default)]
    issuer: Option<String>,
    client_id: String,
    #[serde(deserialize_with = "read_secret")]
    access_token: SecretString,
    #[serde(default)]
    expires_at: Option<u64>,
    #[serde(default, deserialize_with = "read_optional_secret")]
    refresh_token: Option<SecretString>,
    #[serde(default)]
    scopes: Vec<String>,
}

/// The sign-in Codex's saved sign-ins file `text` holds for the server `name` at `address`,
/// matched by the saved name and address, never by the file's key, whose hash Codex may compute
/// differently between builds; the expiry Codex keeps in milliseconds since the epoch. Fails with
/// `CredentialsUnreadable` for a file Codex did not write, and `NoSavedSignIn` when none matches.
fn read_codex_saved_sign_in(
    text: &str,
    name: &McpServerName,
    address: &McpServerAddress,
) -> Result<ProviderSignInTakeover, CodexSignInError> {
    let saved: BTreeMap<String, CodexSavedSignIn> = serde_json::from_str(text)
        .map_err(|error| CodexSignInError::CredentialsUnreadable(Box::new(error)))?;
    let local_name = format!("{CODEX_LOCAL_NAME_PREFIX}{}", name.as_str());
    let sign_in = saved
        .into_values()
        .find(|sign_in| {
            (sign_in.server_name == name.as_str() || sign_in.server_name == local_name)
                && names_server_at(&sign_in.server_url, address)
        })
        .ok_or(CodexSignInError::NoSavedSignIn)?;
    Ok(ProviderSignInTakeover {
        access_token: sign_in.access_token,
        refresh_token: sign_in.refresh_token,
        expires_at: sign_in
            .expires_at
            .map(|milliseconds| UNIX_EPOCH + Duration::from_millis(milliseconds)),
        scopes: sign_in.scopes,
        token_type: BEARER_TOKEN_TYPE.to_owned(),
        client_id: sign_in.client_id,
        client_secret: None,
        issuer: sign_in.issuer,
    })
}

#[cfg(test)]
mod tests;
