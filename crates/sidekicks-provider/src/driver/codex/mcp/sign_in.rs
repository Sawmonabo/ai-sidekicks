//! The sign-in to one MCP server through Codex's own client. The server's entry, the person's as
//! Codex's config read merges it or a plugin's as its file declares it, is copied into a folder of
//! the daemon's own, made for this sign-in alone, beside a setting that keeps Codex's saved
//! sign-ins in a file there; a throwaway Codex service runs on that folder as its home, starts the
//! login, and the caller opens its authorization address. Once Codex reports the login done, the
//! saved sign-in is read back from the folder's file; the service is stopped and the folder
//! removed whatever the outcome, a dropped sign-in's included. The person's own Codex home is only
//! read, for the entry, through Codex's config read; no sign-in of theirs is read or written.

use std::collections::BTreeMap;
use std::error::Error;
use std::io::{self, ErrorKind};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_store::data_folder::plugin_home;
use tokio::sync::mpsc;
use url::Url;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::app_server_protocol::McpServerOauthLoginParams;
use crate::driver::codex::config_read::read_codex_config;
use crate::driver::codex::lifecycle::naming::lockdown::MCP_SERVERS_KEY;
use crate::driver::codex::mcp::config::plugins::read_plugin_server_entries;
use crate::driver::codex::mcp::config::server_entry::ENABLED_MEMBER;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::registry::personal_folder_read::PersonalFolderRead;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::transport::connection::{
    CodexConnectionEvents, CodexForgottenRequest, read_codex_object,
};
use crate::driver::contract::DriverError;
use crate::driver::contract::sign_in::{
    BEARER_TOKEN_TYPE, NoPersonServerEntry, ProviderSignInBrowser, ProviderSignInTakeover,
    ProviderSignInTakeoverRequest,
};
use crate::driver::mcp_server::address::read_server_address;
use crate::driver::mcp_server::read::binding_server_name;
use crate::driver::mcp_server::sign_in_folder::SignInFolder;

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

/// The notices one login's wait reads, a few at most.
const LOGIN_NOTICE_CAPACITY: usize = 8;

/// The member of a server entry holding its sign-in client, and that client's secret.
const OAUTH_MEMBER: &str = "oauth";
const OAUTH_CLIENT_SECRET_MEMBER: &str = "client_secret";

/// Why a sign-in through Codex's own client did not answer credentials. No case carries a
/// credential value.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CodexSignInError {
    /// Neither the person's Codex config where it was read nor an installed plugin declares the
    /// binding's server any more.
    #[error("no Codex config declares the MCP server named {name} any more")]
    ServerEntryGone {
        /// The server's name.
        name: String,
    },
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
    #[error("Codex's MCP sign-in failed: {detail}")]
    Failed {
        /// Codex's own words, or that it gave none.
        detail: String,
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
    /// Every failure of the sign-in is the driver's own.
    fn from(error: CodexSignInError) -> Self {
        Self::Internal(Box::new(error))
    }
}

/// Signs in to `request`'s server through Codex's own client on a throwaway service of
/// `registry`'s, the server's entry read from the person's config at the binding's root, else at
/// `home_folder`, or from the plugin that carries it. Fails with
/// [`DriverError::NoPersonServerEntry`] for a connector, as the entry's read, the service's start
/// or a request fails, and with [`CodexSignInError`] for every other failure; the service is
/// stopped and its folder removed either way.
pub(crate) async fn sign_in_with_codex_client(
    registry: &CodexServiceRegistry,
    home_folder: &Path,
    request: ProviderSignInTakeoverRequest,
) -> Result<ProviderSignInTakeover, DriverError> {
    let name = binding_server_name(&request.binding).clone();
    let entry = read_sign_in_entry(
        registry,
        home_folder,
        &request.binding,
        request.root_folder.as_deref(),
    )
    .await?;
    // Codex keeps no client secret in its saved sign-in, so the one its entry configures is kept.
    let configured_client_secret = entry
        .get(OAUTH_MEMBER)
        .and_then(|oauth| oauth.get(OAUTH_CLIENT_SECRET_MEMBER))
        .and_then(Value::as_str)
        .filter(|secret| !secret.is_empty())
        .map(str::to_owned);
    let settings = compose_sign_in_settings(&name, entry)
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
    let signed_in = run_login(&service, &name, request.lifetime, request.browser).await;
    service.stop().await;
    let read = match signed_in {
        Ok(()) => read_saved_sign_in(folder.path(), &name, &request.server_address)
            .await
            .map(|takeover| ProviderSignInTakeover {
                client_secret: configured_client_secret,
                ..takeover
            }),
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

// The entry of `binding`'s server, switched on: a plugin's as its file declares it, as Codex reads
// its own plugins' entries, and any other's as Codex's config read at the binding's root, else at
// `home_folder`, merges it. Fails with `NoPersonServerEntry` for a connector, whose sign-in is the
// account's own, and with `ServerEntryGone` where no entry is found.
async fn read_sign_in_entry(
    registry: &CodexServiceRegistry,
    home_folder: &Path,
    binding: &McpServerBindingRef,
    root_folder: Option<&Path>,
) -> Result<Map<String, Value>, DriverError> {
    let name = binding_server_name(binding);
    let entry = match binding {
        McpServerBindingRef::Connector { .. } => {
            return Err(DriverError::NoPersonServerEntry(NoPersonServerEntry {
                binding: binding.clone(),
            }));
        }
        McpServerBindingRef::Plugin { .. } => {
            read_plugin_server_entries(&plugin_home(home_folder, &DESCRIPTOR.provider_id()))
                .await
                .into_iter()
                .find(|server| server.declaration.binding == *binding)
                .map(|server| server.compose_codex_entry())
        }
        McpServerBindingRef::User { .. }
        | McpServerBindingRef::Project { .. }
        | McpServerBindingRef::Local { .. }
        | McpServerBindingRef::Managed { .. } => {
            read_person_server_entry(registry, root_folder.unwrap_or(home_folder), name).await?
        }
    };
    let mut entry = entry.ok_or_else(|| CodexSignInError::ServerEntryGone {
        name: name.as_str().to_owned(),
    })?;
    entry.remove(ENABLED_MEMBER);
    Ok(entry)
}

// The person's own entry for `name`, as Codex's config read at `cwd` merges it; `None` where it
// declares none.
async fn read_person_server_entry(
    registry: &CodexServiceRegistry,
    cwd: &Path,
    name: &McpServerName,
) -> Result<Option<Map<String, Value>>, DriverError> {
    let read = registry
        .read_on_personal_folder(PersonalFolderRead::Config, |service| async move {
            let connection = service.connection()?;
            read_codex_config::<Map<String, Value>>(&connection, cwd, false).await
        })
        .await?;
    Ok(read
        .config
        .get(MCP_SERVERS_KEY)
        .and_then(|servers| servers.get(name.as_str()))
        .and_then(Value::as_object)
        .cloned())
}

/// The settings of a sign-in's own Codex home: sign-ins kept in a file, and `entry` as the one
/// server `name`, its `null` members dropped since TOML has none. Fails when the entry holds a
/// value TOML cannot write.
fn compose_sign_in_settings(
    name: &McpServerName,
    entry: Map<String, Value>,
) -> Result<String, toml::ser::Error> {
    let entry = drop_nulls(Value::Object(entry));
    let mut servers = toml::Table::new();
    servers.insert(name.as_str().to_owned(), toml::Value::try_from(entry)?);
    let mut settings = toml::Table::new();
    let (store_setting, store_value) = CREDENTIALS_STORE_SETTING;
    settings.insert(store_setting.to_owned(), toml::Value::from(store_value));
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

// What one login's wait reads: a completion notice, or the connection's close.
enum LoginNotice {
    Completed(Box<RawValue>),
    Closed(String),
}

// Hands the throwaway connection's completion notices and its close to the login's wait.
struct LoginNotices(mpsc::Sender<LoginNotice>);

impl LoginNotices {
    fn forward(&self, notice: LoginNotice) {
        if self.0.try_send(notice).is_err() {
            tracing::debug!("a Codex MCP sign-in's notice came after its wait ended");
        }
    }
}

impl CodexConnectionEvents for LoginNotices {
    fn notification(&self, method: &str, params: Box<RawValue>) {
        if method == OAUTH_LOGIN_COMPLETED_METHOD {
            self.forward(LoginNotice::Completed(params));
        }
    }

    fn dropped(&self, reason: &str) {
        self.forward(LoginNotice::Closed(reason.to_owned()));
    }

    // The connection holds no ask: it has no responder.
    fn held_requests_dropped(&self, _dropped: Vec<CodexForgottenRequest>) {}

    // A throwaway service never drains: the daemon stops it.
    fn service_draining(&self, _message: &str) {}

    // The login's own request reports its deadline.
    fn request_timed_out(&self, _silent_for: Duration) {}

    fn answered_after_timeout(&self) {}
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

// Starts the login to `name` on `service`, hands its authorization address out through `browser`
// and waits, within `lifetime` and a margin, for Codex's notice that this login ended. Fails as
// the start or the request fails, and with `CodexSignInError` otherwise.
async fn run_login(
    service: &Arc<CodexService>,
    name: &McpServerName,
    lifetime: Duration,
    browser: ProviderSignInBrowser,
) -> Result<(), DriverError> {
    let (notices, mut received) = mpsc::channel(LOGIN_NOTICE_CAPACITY);
    let connection = service
        .open_detached_connection(Arc::new(LoginNotices(notices)))
        .await?;
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
        let authorization_url = Url::parse(&reply.authorization_url)
            .map_err(|_unparsed| CodexSignInError::LoginReplyUnreadable)?;
        // Codex's own listener takes the browser's return, so none comes to the daemon's relay.
        drop(browser.browser_return);
        browser
            .authorization_url
            .send(authorization_url)
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
                detail: completed
                    .error
                    .unwrap_or_else(|| "Codex gave no reason".to_owned()),
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
    let text = match tokio::fs::read_to_string(folder.join(CODEX_CREDENTIALS_FILE)).await {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err(CodexSignInError::NoSavedSignIn.into());
        }
        Err(error) => return Err(unreadable(error).into()),
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
    access_token: String,
    #[serde(default)]
    expires_at: Option<u64>,
    #[serde(default)]
    refresh_token: Option<String>,
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
    let identity = read_server_address(address.as_str())
        .identity
        .ok_or(CodexSignInError::NoSavedSignIn)?;
    let local_name = format!("{CODEX_LOCAL_NAME_PREFIX}{}", name.as_str());
    let sign_in = saved
        .into_values()
        .find(|sign_in| {
            (sign_in.server_name == name.as_str() || sign_in.server_name == local_name)
                && read_server_address(&sign_in.server_url).identity.as_ref() == Some(&identity)
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
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::{Duration, UNIX_EPOCH};

    use futures::future::BoxFuture;
    use futures::{SinkExt as _, StreamExt as _};
    use interprocess::local_socket::tokio::Listener;
    use interprocess::local_socket::traits::tokio::Listener as _;
    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::config::McpServerAddress;
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
    use sidekicks_platforms::{
        CAN_BIND_A_SOCKET_LISTENER, LeftoverSweep, ProgramStart, bind_socket_listener,
        create_file_atomically, short_socket_folder,
    };
    use tokio::sync::oneshot;
    use tokio_tungstenite::tungstenite::Message;
    use url::Url;

    use super::{
        CODEX_CREDENTIALS_FILE, OAUTH_LOGIN_COMPLETED_METHOD, OAUTH_LOGIN_METHOD,
        read_codex_saved_sign_in, sign_in_with_codex_client,
    };
    use crate::driver::codex::DESCRIPTOR;
    use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
    use crate::driver::codex::service::registry::{
        CodexServiceRegistry, OneHome, home_socket_path,
    };
    use crate::driver::codex::service::supervisor::test_service::{
        STAND_IN_CODEX, UnheardEvents, script_codex_service, test_codex_service_dependencies,
    };
    use crate::driver::codex::service::supervisor::{CodexProgramResolver, CodexServiceSocket};
    use crate::driver::contract::DriverError;
    use crate::driver::contract::sign_in::{ProviderSignInBrowser, ProviderSignInTakeoverRequest};
    use crate::runtime_binding::test_store::test_provider_account_id;
    use crate::spawned_version::ResolvedProviderExecutable;

    /// The server signed in to.
    const SERVER_NAME: &str = "docs";

    /// Its address as the binding keeps it.
    const SERVER_ADDRESS: &str = "https://docs.example.test/mcp";

    /// An expiry in milliseconds since the epoch, as Codex keeps it.
    const EXPIRY_MILLISECONDS: u64 = 1_767_225_600_000;

    /// The access token the sign-in's own home gets.
    const SIGNED_IN_ACCESS: &str = "access-of-the-sign-in";

    /// The person's own saved sign-ins, planted outside the daemon's folders.
    const PERSON_SIGN_INS: &str = r#"{"docs|person":{"server_name":"docs","server_url":"https://docs.example.test/mcp","client_id":"person-client","access_token":"access-of-the-person","expires_at":1,"scopes":[]}}"#;

    fn name() -> McpServerName {
        McpServerName::new(SERVER_NAME.to_owned()).expect("a test server name is a name")
    }

    fn address() -> McpServerAddress {
        McpServerAddress::new(SERVER_ADDRESS).expect("a test address is a web address")
    }

    // One saved sign-in as Codex writes it.
    fn saved(server_name: &str, server_url: &str, access_token: &str) -> Value {
        json!({
            "server_name": server_name,
            "server_url": server_url,
            "client_id": "client-one",
            "access_token": access_token,
            "expires_at": EXPIRY_MILLISECONDS,
            "refresh_token": "refresh-one",
            "scopes": ["read", "write"],
        })
    }

    // Killed by reading the expiry as seconds, by matching a saved sign-in on its name alone or
    // its address alone, and by an address match that does not fold the host's case.
    #[test]
    fn a_saved_sign_in_matches_by_name_and_address_and_its_expiry_reads_in_milliseconds() {
        let file = json!({
            "a": saved(SERVER_NAME, "https://other.example.test/mcp", "access-of-another-address"),
            "b": saved("other", SERVER_ADDRESS, "access-of-another-name"),
            "c": saved(SERVER_NAME, "https://DOCS.example.test/mcp", "access-of-the-server"),
        });

        let read = read_codex_saved_sign_in(&file.to_string(), &name(), &address())
            .expect("the server's sign-in reads");

        assert_eq!(read.access_token, "access-of-the-server");
        assert_eq!(read.refresh_token.as_deref(), Some("refresh-one"));
        assert_eq!(
            read.expires_at,
            Some(UNIX_EPOCH + Duration::from_millis(EXPIRY_MILLISECONDS))
        );
        assert_eq!(read.scopes, ["read", "write"]);
        assert_eq!(read.client_id, "client-one");
    }

    // Answers each throwaway service as Codex would on its home: a login saves a sign-in in
    // `codex_home`'s own credentials file and reports itself done.
    struct SignInStandIn {
        program: PathBuf,
    }

    impl CodexProgramResolver for SignInStandIn {
        fn resolve<'call>(
            &'call self,
            home: &'call CodexServiceHome,
        ) -> BoxFuture<'call, Result<ResolvedProviderExecutable, DriverError>> {
            let socket = home_socket_path(&home.codex_home);
            std::fs::create_dir_all(socket.parent().expect("the socket has a folder"))
                .expect("the socket's folder is made");
            let listener = bind_socket_listener(&socket).expect("the stand-in listens");
            tokio::spawn(answer_logins(listener, home.codex_home.clone()));
            let resolved = ResolvedProviderExecutable {
                requested_command: "codex".to_owned(),
                resolved_executable_path: self.program.clone(),
                start: ProgramStart {
                    program: self.program.clone(),
                    leading_arguments: Vec::new(),
                },
                environment: vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned())],
            };
            Box::pin(async move { Ok(resolved) })
        }
    }

    async fn answer_logins(listener: Listener, codex_home: PathBuf) {
        while let Ok(stream) = listener.accept().await {
            let codex_home = codex_home.clone();
            tokio::spawn(async move {
                let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                    return;
                };
                while let Some(Ok(message)) = socket.next().await {
                    let Message::Text(text) = message else {
                        continue;
                    };
                    let request: Value =
                        serde_json::from_str(&text).expect("the daemon sends JSON");
                    if request.get("id").is_none() {
                        continue;
                    }
                    let mut messages = Vec::new();
                    let result = match request["method"].as_str() {
                        Some("initialize") => {
                            json!({"userAgent": "ai-sidekicks-daemon/0.130.0 (test)"})
                        }
                        Some(OAUTH_LOGIN_METHOD) => {
                            let saved = json!({"docs|key": saved(
                                &request["params"]["name"].as_str().expect("a name"),
                                SERVER_ADDRESS,
                                SIGNED_IN_ACCESS,
                            )});
                            std::fs::write(
                                codex_home.join(CODEX_CREDENTIALS_FILE),
                                saved.to_string(),
                            )
                            .expect("the stand-in saves its sign-in");
                            messages.push(json!({"jsonrpc": "2.0",
                                "method": OAUTH_LOGIN_COMPLETED_METHOD,
                                "params": {"name": request["params"]["name"],
                                    "loginId": "login-one", "success": true}}));
                            json!({"authorizationUrl": "https://auth.example.test/authorize",
                                "loginId": "login-one"})
                        }
                        _ => json!({}),
                    };
                    let reply = json!({"id": request["id"], "result": result});
                    for message in std::iter::once(reply).chain(messages) {
                        if socket
                            .send(Message::Text(message.to_string().into()))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            });
        }
    }

    // Killed by running the login on the person's own Codex folder, or on any folder but one the
    // daemon makes for the sign-in, and by leaving that folder behind.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_codex_takeover_leaves_the_persons_saved_sign_ins_as_they_were() {
        if !CAN_BIND_A_SOCKET_LISTENER {
            return;
        }
        let folder = short_socket_folder().expect("a scratch folder is made");
        let program = folder.path().join("codex");
        create_file_atomically(
            &program,
            STAND_IN_CODEX.as_bytes(),
            0o755,
            LeftoverSweep::Unswept,
        )
        .expect("the stand-in is written");
        let dependencies = test_codex_service_dependencies(
            folder.path(),
            Arc::new(SignInStandIn { program }),
            Arc::new(UnheardEvents),
        );
        let person_home = CodexServiceHome {
            codex_home: folder.path().join("home"),
            kind: CodexHomeKind::PersonalFolder,
        };
        std::fs::create_dir_all(&person_home.codex_home).expect("the person's folder is made");
        let planted = person_home.codex_home.join(CODEX_CREDENTIALS_FILE);
        std::fs::write(&planted, PERSON_SIGN_INS).expect("the person's sign-ins are planted");
        let socket = home_socket_path(&person_home.codex_home);
        let (on_folder, mut script) = script_codex_service(
            person_home.clone(),
            CodexServiceSocket {
                path: socket.clone(),
                home_socket: socket,
            },
            CodexServiceKind::Terminal,
            Arc::clone(&dependencies),
        );
        let registry = CodexServiceRegistry::holding_service_on(
            &on_folder,
            Arc::clone(&dependencies),
            Arc::new(OneHome(person_home.clone())),
        );
        let (authorization_url, opened) = oneshot::channel();
        let (_returned, browser_return) = oneshot::channel();
        let request = ProviderSignInTakeoverRequest {
            provider_account_id: test_provider_account_id(),
            binding: McpServerBindingRef::User {
                provider: DESCRIPTOR.provider_id(),
                server_name: name(),
            },
            root_folder: None,
            server_address: address(),
            redirect_url: Url::parse("http://127.0.0.1:1/callback").expect("an address"),
            lifetime: Duration::from_secs(30),
            browser: ProviderSignInBrowser {
                authorization_url,
                browser_return,
            },
        };

        let home_folder = folder.path().join("person");
        let signing_in = tokio::spawn({
            let registry = Arc::clone(&registry);
            async move { sign_in_with_codex_client(&registry, &home_folder, request).await }
        });
        let config_read = script.next_sent().await;
        assert_eq!(config_read["method"], "config/read", "{config_read}");
        script.answer(
            &config_read,
            &json!({"config": {"mcp_servers": {SERVER_NAME: {
                "url": SERVER_ADDRESS, "enabled": true}}}, "origins": {}}),
        );
        let opened = opened
            .await
            .expect("the authorization address is handed out");
        let signed_in = signing_in
            .await
            .expect("the sign-in runs")
            .expect("the sign-in reads back");

        assert_eq!(opened.as_str(), "https://auth.example.test/authorize");
        assert_eq!(signed_in.access_token, SIGNED_IN_ACCESS);
        assert_eq!(
            std::fs::read_to_string(&planted).expect("the person's sign-ins read"),
            PERSON_SIGN_INS
        );
        let left = std::fs::read_dir(registry.mcp_sign_in_folder())
            .expect("the sign-ins' folder reads")
            .count();
        assert_eq!(left, 0, "the sign-in's own folder is removed");
    }
}
