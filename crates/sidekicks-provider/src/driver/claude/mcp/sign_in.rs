//! The sign-in to one MCP server through Claude Code's own client. The server's entry is copied
//! from the person's config into a folder of the daemon's own, made for this sign-in alone, which
//! one process that keeps nothing runs on as its config and credential folder, loading that one
//! server and no other. `mcp_authenticate` answers the authorization address the caller opens;
//! where the authorization server took the daemon's redirect address, the browser's return is
//! handed back with `mcp_oauth_callback_url`, whose answer comes once the sign-in is saved, and
//! where it refused that address Claude Code's own loopback listener takes the return, the folder
//! then watched until the saved sign-in appears. The sign-in is read back from the folder's
//! credentials file; the process is closed and the folder deleted whatever the outcome. The
//! person's own folders are only read, for the entry.

use std::collections::BTreeMap;
use std::error::Error;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use notify::{RecursiveMode, Watcher as _};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::{LeftoverSweep, create_private_folder, replace_file_atomically};
use sidekicks_std::random_hex::random_hex;
use tokio::sync::watch;
use url::Url;

use crate::driver::claude::mcp::config::read_json_file;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::driver::claude::spawn::launch::installed_build::ClaudeProcessStarts;
use crate::driver::contract::DriverError;
use crate::driver::contract::sign_in::{
    BEARER_TOKEN_TYPE, ProviderSignInBrowser, ProviderSignInTakeover, ProviderSignInTakeoverRequest,
};
use crate::driver::mcp_server::address::read_server_address;
use crate::driver::mcp_server::read::binding_server_name;
use crate::inbound_json::decode_inbound_json;

/// The data folder's folder each sign-in makes its own folder in.
const CLAUDE_MCP_SIGN_IN_FOLDER: [&str; 2] = ["claude", "mcp-sign-in"];

/// The random bytes in one sign-in's folder name.
const SIGN_IN_FOLDER_NAME_BYTES: usize = 8;

/// The file in the sign-in's folder that declares its one server, which the process loads alone.
const SIGN_IN_SERVERS_FILE: &str = "sign-in-servers.json";

/// The file Claude Code keeps its saved sign-ins in, under its credential folder.
const CLAUDE_CREDENTIALS_FILE: &str = ".credentials.json";

/// The person's own Claude Code config under their home, holding user and local servers.
const CLAUDE_PERSON_CONFIG_FILE: &str = ".claude.json";

/// A project root's shared server file.
const CLAUDE_PROJECT_SERVERS_FILE: &str = ".mcp.json";

/// The member of a config file and a server file that lists servers by name.
const MCP_SERVERS_MEMBER: &str = "mcpServers";

/// The member of `.claude.json` that holds each project's own settings by its root's path.
const PROJECTS_MEMBER: &str = "projects";

/// The member of a server entry naming the client its owner issued, and that client's id.
const OAUTH_MEMBER: &str = "oauth";
const OAUTH_CLIENT_ID_MEMBER: &str = "clientId";

/// The `redirectScheme` Claude Code answers when the authorization server took the redirect
/// address it was sent, so the browser's return comes to the daemon.
const CUSTOM_REDIRECT_SCHEME: &str = "custom";

/// Why a sign-in through Claude Code's own client did not answer credentials. No case carries a
/// credential value.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeSignInError {
    /// The person's config declares no server under the binding's name where it was read.
    #[error("the person's Claude Code config declares no MCP server named {name}")]
    NoServerEntry {
        /// The server's name.
        name: String,
    },
    /// The sign-in's own folder or its server file could not be made.
    #[error("the folder Claude Code's MCP sign-in runs in could not be made")]
    FolderUnmade(#[source] Box<dyn Error + Send + Sync>),
    /// The caller stopped waiting before the browser opened or returned.
    #[error("the MCP sign-in's caller was gone before the browser returned")]
    CallerGone,
    /// The browser did not return, or the saved sign-in did not appear, within the lifetime.
    #[error("the MCP sign-in through Claude Code did not finish in time")]
    Unfinished,
    /// The watch of the sign-in's folder could not be set up or ended.
    #[error("the folder of Claude Code's MCP sign-in could not be watched")]
    WatchFailed(#[source] Box<dyn Error + Send + Sync>),
    /// The credentials file could not be read, or did not read as Claude Code writes it.
    #[error("Claude Code's saved MCP sign-ins could not be read")]
    CredentialsUnreadable(#[source] Box<dyn Error + Send + Sync>),
    /// The folder's credentials file holds no sign-in for the server. On macOS Claude Code may
    /// keep it in a keychain item named for the folder instead, which nothing here reads.
    #[error(
        "Claude Code saved no sign-in for the MCP server in its credentials file; on macOS it may \
         keep one in a keychain item instead"
    )]
    NoSavedSignIn,
    /// The saved sign-in names no client, and the server's entry names none either.
    #[error("Claude Code's saved MCP sign-in names no client")]
    NoClient,
}

impl From<ClaudeSignInError> for DriverError {
    /// Every failure of the sign-in is the driver's own.
    fn from(error: ClaudeSignInError) -> Self {
        Self::Internal(Box::new(error))
    }
}

/// What starts the one process of a sign-in: its environment, the account it runs for, the
/// sign-in's own folder it runs in, and the file declaring the one server it loads.
pub(crate) struct ClaudeMcpSignInStart {
    /// The process's whole environment, its config and credential folders the sign-in's own.
    pub(crate) environment: Vec<(String, String)>,
    /// The account the process runs for.
    pub(crate) provider_account_id: ProviderAccountId,
    /// The sign-in's own folder, where the process starts.
    pub(crate) folder: PathBuf,
    /// The file declaring the one server, passed with `--mcp-config` under `--strict-mcp-config`.
    pub(crate) servers_file: PathBuf,
}

/// The process `starts` brings up for a sign-in, as a channel the sign-in drives.
pub(crate) type ClaudeMcpSignInChannel = Arc<dyn ClaudeProcessChannel>;

/// Where a sign-in reads the person's config and makes its own folder.
pub(crate) struct ClaudeSignInPlaces<'places> {
    /// The person's home folder, holding `.claude.json`.
    pub(crate) home_folder: &'places Path,
    /// The daemon's data folder.
    pub(crate) data_folder: &'places Path,
}

/// Signs in to `request`'s server through Claude Code's own client, in one process `starts`
/// brings up with the environment `environment_on` composes for the sign-in's own folder. Fails
/// as the entry's read, the environment, the start or a control request fails, and with
/// [`ClaudeSignInError`] for every other failure; the process is closed and the folder deleted
/// either way.
pub(crate) async fn sign_in_with_claude_client(
    starts: &dyn ClaudeProcessStarts,
    places: ClaudeSignInPlaces<'_>,
    environment_on: impl FnOnce(&Path) -> Result<Vec<(String, String)>, DriverError>,
    request: ProviderSignInTakeoverRequest,
) -> Result<ProviderSignInTakeover, DriverError> {
    let name = binding_server_name(&request.binding).clone();
    let entry = read_person_server_entry(
        places.home_folder,
        &request.binding,
        request.root_folder.as_deref(),
    )
    .await?;
    let configured_client_id = entry
        .get(OAUTH_MEMBER)
        .and_then(|oauth| oauth.get(OAUTH_CLIENT_ID_MEMBER))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let sign_in_folder = CLAUDE_MCP_SIGN_IN_FOLDER
        .iter()
        .fold(places.data_folder.to_path_buf(), |folder, part| {
            folder.join(part)
        });
    let folder = make_sign_in_folder(&sign_in_folder, &name, entry).await?;
    let signed_in = async {
        let environment = environment_on(&folder)?;
        let channel = starts
            .start_mcp_sign_in(ClaudeMcpSignInStart {
                environment,
                provider_account_id: request.provider_account_id.clone(),
                folder: folder.clone(),
                servers_file: folder.join(SIGN_IN_SERVERS_FILE),
            })
            .await?;
        let exchanged = run_sign_in(
            &*channel,
            &folder,
            &name,
            &request.redirect_url,
            request.lifetime,
            request.browser,
        )
        .await;
        channel.close().await;
        exchanged?;
        let saved = read_saved_sign_in(&folder, &name, &request.server_address).await?;
        Ok::<_, DriverError>(complete_client(saved, configured_client_id)?)
    }
    .await;
    if let Err(error) = tokio::fs::remove_dir_all(&folder).await
        && error.kind() != ErrorKind::NotFound
    {
        let removal = DriverError::Internal(Box::new(error));
        return match signed_in {
            Ok(_takeover) => Err(removal),
            Err(failure) => {
                // The sign-in's own failure is the one the caller acts on.
                tracing::warn!(
                    error = &removal as &(dyn Error + 'static),
                    "the folder of a Claude Code MCP sign-in was not removed"
                );
                Err(failure)
            }
        };
    }
    signed_in
}

// The person's own entry for the binding's server: a user server in `.claude.json`, a local one
// under its root's project there, a project one in the root's `.mcp.json`.
async fn read_person_server_entry(
    home_folder: &Path,
    binding: &McpServerBindingRef,
    root_folder: Option<&Path>,
) -> Result<Map<String, Value>, DriverError> {
    let name = binding_server_name(binding);
    let person_config = home_folder.join(CLAUDE_PERSON_CONFIG_FILE);
    let servers = match binding {
        McpServerBindingRef::User { .. } => read_object(&person_config)
            .await?
            .and_then(|config| config.get(MCP_SERVERS_MEMBER).cloned()),
        McpServerBindingRef::Local { scope_ref, .. } => {
            read_object(&person_config).await?.and_then(|config| {
                config
                    .get(PROJECTS_MEMBER)?
                    .get(scope_ref.as_str())?
                    .get(MCP_SERVERS_MEMBER)
                    .cloned()
            })
        }
        McpServerBindingRef::Project { scope_ref, .. } => {
            let root =
                root_folder.map_or_else(|| PathBuf::from(scope_ref.as_str()), Path::to_owned);
            read_object(&root.join(CLAUDE_PROJECT_SERVERS_FILE))
                .await?
                .and_then(|file| file.get(MCP_SERVERS_MEMBER).cloned())
        }
        // A plugin's, a connector's or an organization's server has no entry of the person's.
        McpServerBindingRef::Plugin { .. }
        | McpServerBindingRef::Connector { .. }
        | McpServerBindingRef::Managed { .. } => None,
    };
    Ok(servers
        .and_then(|servers| servers.get(name.as_str()).cloned())
        .and_then(|entry| match entry {
            Value::Object(entry) => Some(entry),
            Value::Null
            | Value::Bool(_)
            | Value::Number(_)
            | Value::String(_)
            | Value::Array(_) => None,
        })
        .ok_or_else(|| ClaudeSignInError::NoServerEntry {
            name: name.as_str().to_owned(),
        })?)
}

async fn read_object(path: &Path) -> Result<Option<Map<String, Value>>, DriverError> {
    read_json_file::<Map<String, Value>>(path)
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))
}

// Makes the sign-in's own folder under `sign_in_folder`, readable by the person alone, holding the
// file that declares `entry` as the one server `name`.
async fn make_sign_in_folder(
    sign_in_folder: &Path,
    name: &McpServerName,
    entry: Map<String, Value>,
) -> Result<PathBuf, ClaudeSignInError> {
    let unmade = |error: Box<dyn Error + Send + Sync>| ClaudeSignInError::FolderUnmade(error);
    let folder_name =
        random_hex(SIGN_IN_FOLDER_NAME_BYTES).map_err(|error| unmade(error.into()))?;
    let folder = sign_in_folder.join(folder_name);
    let servers = json!({ MCP_SERVERS_MEMBER: { name.as_str(): entry } }).to_string();
    let made = folder.clone();
    tokio::task::spawn_blocking(move || {
        create_private_folder(&made).map_err(|error| unmade(error.into()))?;
        // The entry can hold header values, so the file is the person's alone.
        replace_file_atomically(
            &made.join(SIGN_IN_SERVERS_FILE),
            servers.as_bytes(),
            0o600,
            LeftoverSweep::Unswept,
        )
        .map_err(|error| unmade(error.into()))
    })
    .await
    .map_err(|error| unmade(error.into()))??;
    Ok(folder)
}

// The members of `mcp_authenticate`'s answer the sign-in reads.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticateReply {
    #[serde(default)]
    auth_url: Option<String>,
    #[serde(default)]
    redirect_scheme: Option<String>,
}

// Runs the sign-in on `channel`: the authorization address handed out through `browser`, then
// the browser's return handed back where the daemon's redirect address took it, else the saved
// sign-in waited for in `folder`, each within `lifetime`. An answer with no address needs no
// person, and the saved sign-in is read as it stands.
async fn run_sign_in(
    channel: &dyn ClaudeProcessChannel,
    folder: &Path,
    name: &McpServerName,
    redirect_url: &Url,
    lifetime: Duration,
    browser: ProviderSignInBrowser,
) -> Result<(), DriverError> {
    let answer = channel
        .send_control_request(ClaudeControlRequest::McpAuthenticate {
            server_name: name.as_str().to_owned(),
            redirect_uri: redirect_url.as_str().to_owned(),
        })
        .await?;
    let reply: AuthenticateReply = answer
        .response
        .and_then(|reply| serde_json::from_str(reply.get()).ok())
        .unwrap_or_default();
    let Some(authorization_url) = reply.auth_url.and_then(|url| Url::parse(&url).ok()) else {
        return Ok(());
    };
    browser
        .authorization_url
        .send(authorization_url)
        .map_err(|_unsent| ClaudeSignInError::CallerGone)?;
    if reply.redirect_scheme.as_deref() != Some(CUSTOM_REDIRECT_SCHEME) {
        // Claude Code's own loopback listener takes the browser's return.
        drop(browser.browser_return);
        return Ok(wait_for_saved_sign_in(folder, name, lifetime).await?);
    }
    let returned = tokio::time::timeout(lifetime, browser.browser_return)
        .await
        .map_err(|_elapsed| ClaudeSignInError::Unfinished)?
        .map_err(|_dropped| ClaudeSignInError::CallerGone)?;
    channel
        .send_control_request(ClaudeControlRequest::McpOauthCallbackUrl {
            server_name: name.as_str().to_owned(),
            callback_url: returned.into(),
        })
        .await?;
    Ok(())
}

// Waits, within `lifetime`, until `folder`'s credentials file holds a sign-in for `name`, read
// again at each change in the folder; a file caught mid-write reads at the next change.
async fn wait_for_saved_sign_in(
    folder: &Path,
    name: &McpServerName,
    lifetime: Duration,
) -> Result<(), ClaudeSignInError> {
    let watch_failed = |error: notify::Error| ClaudeSignInError::WatchFailed(Box::new(error));
    let (changed, mut changes) = watch::channel(0_u64);
    let mut watcher = notify::recommended_watcher(move |_event: notify::Result<notify::Event>| {
        changed.send_modify(|count| *count += 1);
    })
    .map_err(watch_failed)?;
    watcher
        .watch(folder, RecursiveMode::NonRecursive)
        .map_err(watch_failed)?;
    tokio::time::timeout(lifetime, async {
        loop {
            if let Ok(text) = tokio::fs::read(folder.join(CLAUDE_CREDENTIALS_FILE)).await
                && holds_sign_in_for(&decode_inbound_json(&text), name)
            {
                return Ok(());
            }
            changes
                .changed()
                .await
                .map_err(|error| ClaudeSignInError::WatchFailed(Box::new(error)))?;
        }
    })
    .await
    .map_err(|_elapsed| ClaudeSignInError::Unfinished)?
}

// Whether credentials file `text` holds a sign-in with an access token for `name`.
fn holds_sign_in_for(text: &str, name: &McpServerName) -> bool {
    serde_json::from_str::<ClaudeCredentialsFile>(text).is_ok_and(|file| {
        file.mcp_oauth.values().any(|sign_in| {
            sign_in.server_name.as_deref() == Some(name.as_str())
                && sign_in
                    .access_token
                    .as_deref()
                    .is_some_and(|token| !token.is_empty())
        })
    })
}

// Reads the sign-in Claude Code saved in `folder` for `name` at `address`.
async fn read_saved_sign_in(
    folder: &Path,
    name: &McpServerName,
    address: &McpServerAddress,
) -> Result<ClaudeSavedSignInReading, ClaudeSignInError> {
    let bytes = match tokio::fs::read(folder.join(CLAUDE_CREDENTIALS_FILE)).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err(ClaudeSignInError::NoSavedSignIn);
        }
        Err(error) => return Err(ClaudeSignInError::CredentialsUnreadable(Box::new(error))),
    };
    read_claude_saved_sign_in(&decode_inbound_json(&bytes), name, address)
}

// Claude Code's credentials file, its saved MCP sign-ins by key; every other member is left
// unread.
#[derive(Deserialize)]
struct ClaudeCredentialsFile {
    #[serde(rename = "mcpOAuth", default)]
    mcp_oauth: BTreeMap<String, ClaudeSavedSignIn>,
}

// One saved MCP sign-in as Claude Code writes it, each member read leniently, since a stub for
// another server may lack any of them. It derives no `Debug`, since it holds tokens.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSavedSignIn {
    #[serde(default)]
    server_name: Option<String>,
    #[serde(default)]
    server_url: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_at: Option<f64>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    issuer: Option<String>,
    #[serde(default)]
    discovery_state: Option<ClaudeDiscoveryState>,
}

// What Claude Code kept of the authorization server it found.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeDiscoveryState {
    #[serde(default)]
    authorization_server_url: Option<String>,
}

/// A saved sign-in read back, its client id where Claude Code kept one.
struct ClaudeSavedSignInReading {
    /// The credentials, their client id empty where Claude Code kept none.
    takeover: ProviderSignInTakeover,
    /// Whether the saved sign-in named its client.
    has_client_id: bool,
}

/// The sign-in Claude Code's credentials file `text` holds for the server `name` at `address`,
/// matched by the saved name and address, never by the file's key, whose hash Claude Code
/// computes; the expiry Claude Code keeps in milliseconds since the epoch, the scopes as one
/// space-separated text. Fails with `CredentialsUnreadable` for a file Claude Code did not write,
/// and `NoSavedSignIn` when none with an access token matches.
fn read_claude_saved_sign_in(
    text: &str,
    name: &McpServerName,
    address: &McpServerAddress,
) -> Result<ClaudeSavedSignInReading, ClaudeSignInError> {
    let file: ClaudeCredentialsFile = serde_json::from_str(text)
        .map_err(|error| ClaudeSignInError::CredentialsUnreadable(Box::new(error)))?;
    let identity = read_server_address(address.as_str())
        .identity
        .ok_or(ClaudeSignInError::NoSavedSignIn)?;
    let sign_in = file
        .mcp_oauth
        .into_values()
        .find(|sign_in| {
            sign_in.server_name.as_deref() == Some(name.as_str())
                && sign_in.server_url.as_deref().is_some_and(|url| {
                    read_server_address(url).identity.as_ref() == Some(&identity)
                })
                && sign_in
                    .access_token
                    .as_deref()
                    .is_some_and(|token| !token.is_empty())
        })
        .ok_or(ClaudeSignInError::NoSavedSignIn)?;
    let has_client_id = sign_in.client_id.is_some();
    Ok(ClaudeSavedSignInReading {
        takeover: ProviderSignInTakeover {
            access_token: sign_in.access_token.unwrap_or_default(),
            refresh_token: sign_in.refresh_token.filter(|token| !token.is_empty()),
            expires_at: sign_in
                .expires_at
                .filter(|milliseconds| milliseconds.is_finite() && *milliseconds >= 0.0)
                .map(|milliseconds| UNIX_EPOCH + Duration::from_secs_f64(milliseconds / 1000.0)),
            scopes: sign_in
                .scope
                .map(|scope| scope.split_whitespace().map(str::to_owned).collect())
                .unwrap_or_default(),
            token_type: BEARER_TOKEN_TYPE.to_owned(),
            client_id: sign_in.client_id.unwrap_or_default(),
            issuer: sign_in.issuer.or_else(|| {
                sign_in
                    .discovery_state
                    .and_then(|state| state.authorization_server_url)
            }),
        },
        has_client_id,
    })
}

// The saved sign-in with its client id, the one the server's owner issued where Claude Code
// kept none. Fails with `NoClient` where neither names one.
fn complete_client(
    saved: ClaudeSavedSignInReading,
    configured_client_id: Option<String>,
) -> Result<ProviderSignInTakeover, ClaudeSignInError> {
    let mut takeover = saved.takeover;
    if !saved.has_client_id {
        takeover.client_id = configured_client_id.ok_or(ClaudeSignInError::NoClient)?;
    }
    Ok(takeover)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, UNIX_EPOCH};

    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::config::McpServerAddress;
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
    use tokio::sync::oneshot;
    use url::Url;

    use super::{CLAUDE_CREDENTIALS_FILE, CLAUDE_MCP_SIGN_IN_FOLDER, read_claude_saved_sign_in};
    use crate::driver::claude::DESCRIPTOR;
    use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedChannel};
    use crate::driver::claude::session::scripted::driver::ScriptedDriver;
    use crate::driver::contract::sign_in::{ProviderSignInBrowser, ProviderSignInTakeoverRequest};
    use crate::runtime_binding::test_store::test_provider_account_id;

    /// The server signed in to.
    const SERVER_NAME: &str = "docs";

    /// Its address as the binding keeps it.
    const SERVER_ADDRESS: &str = "https://docs.example.test/mcp";

    /// An expiry in milliseconds since the epoch, as Claude Code keeps it.
    const EXPIRY_MILLISECONDS: u64 = 1_767_225_600_000;

    /// The person's own saved sign-ins, planted in their default Claude Code folder.
    const PERSON_SIGN_INS: &str = r#"{"mcpOAuth":{"docs|person":{"serverName":"docs","serverUrl":"https://docs.example.test/mcp","accessToken":"access-of-the-person","expiresAt":1}}}"#;

    /// The person's own Claude Code config, declaring the server.
    const PERSON_CONFIG: &str =
        r#"{"mcpServers":{"docs":{"type":"http","url":"https://docs.example.test/mcp"}}}"#;

    fn name() -> McpServerName {
        McpServerName::new(SERVER_NAME.to_owned()).expect("a test server name is a name")
    }

    fn address() -> McpServerAddress {
        McpServerAddress::new(SERVER_ADDRESS).expect("a test address is a web address")
    }

    // One saved sign-in as Claude Code writes it.
    fn saved(server_name: &str, server_url: &str, access_token: &str) -> Value {
        json!({
            "serverName": server_name,
            "serverUrl": server_url,
            "accessToken": access_token,
            "refreshToken": "refresh-one",
            "expiresAt": EXPIRY_MILLISECONDS,
            "scope": "read write",
            "clientId": "client-one",
            "discoveryState": {"authorizationServerUrl": "https://auth.example.test"},
        })
    }

    // Killed by reading the expiry as seconds, by matching on the name alone or the address
    // alone, by reading the scope as one scope, and by dropping the issuer the discovery kept.
    #[test]
    fn a_saved_sign_in_matches_by_name_and_address_and_its_expiry_reads_in_milliseconds() {
        let file = json!({"mcpOAuth": {
            "a": saved(SERVER_NAME, "https://other.example.test/mcp", "access-of-another-address"),
            "b": saved("other", SERVER_ADDRESS, "access-of-another-name"),
            "c": saved(SERVER_NAME, "https://DOCS.example.test/mcp/", "access-of-the-server"),
        }});

        let read = read_claude_saved_sign_in(&file.to_string(), &name(), &address())
            .expect("the server's sign-in reads");

        let takeover = read.takeover;
        assert_eq!(takeover.access_token, "access-of-the-server");
        assert_eq!(
            takeover.expires_at,
            Some(UNIX_EPOCH + Duration::from_millis(EXPIRY_MILLISECONDS))
        );
        assert_eq!(takeover.scopes, ["read", "write"]);
        assert_eq!(takeover.client_id, "client-one");
        assert_eq!(
            takeover.issuer.as_deref(),
            Some("https://auth.example.test")
        );
    }

    // Killed by running the process on the account's or the person's own folders in place of
    // one the daemon makes, by dropping the browser's return, and by leaving the folder behind.
    #[tokio::test]
    async fn a_claude_takeover_leaves_the_persons_saved_sign_ins_as_they_were() {
        let scripted = ScriptedDriver::new();
        let person_folder = scripted.home.join(".claude");
        std::fs::create_dir_all(&person_folder).expect("the person's folder is made");
        let planted = person_folder.join(CLAUDE_CREDENTIALS_FILE);
        std::fs::write(&planted, PERSON_SIGN_INS).expect("the person's sign-ins are planted");
        std::fs::write(scripted.home.join(".claude.json"), PERSON_CONFIG)
            .expect("the person's config is written");
        let channel = Arc::new(ScriptedChannel::default());
        channel.answer(
            "mcp_authenticate",
            ScriptedAnswer::Reply(json!({
                "authUrl": "https://auth.example.test/authorize",
                "requiresUserAction": true,
                "callbackExpected": true,
                "redirectScheme": "custom",
            })),
        );
        scripted.starts.script_mcp_sign_in(
            Arc::clone(&channel),
            json!({"mcpOAuth": {"docs|key": saved(SERVER_NAME, SERVER_ADDRESS, "access-one")}}),
        );
        let (authorization_url, opened) = oneshot::channel();
        let (returned, browser_return) = oneshot::channel();
        let request = ProviderSignInTakeoverRequest {
            provider_account_id: test_provider_account_id(),
            binding: McpServerBindingRef::User {
                provider: DESCRIPTOR.provider_id(),
                server_name: name(),
            },
            root_folder: None,
            server_address: address(),
            redirect_url: Url::parse("https://relay.example.test/callback").expect("an address"),
            lifetime: Duration::from_secs(30),
            browser: ProviderSignInBrowser {
                authorization_url,
                browser_return,
            },
        };

        let driver = Arc::clone(&scripted.driver);
        let signing_in = tokio::spawn(async move { driver.sign_in_with_own_client(request).await });
        let opened = opened
            .await
            .expect("the authorization address is handed out");
        returned
            .send(Url::parse("https://relay.example.test/callback?code=one").expect("an address"))
            .expect("the sign-in waits for the browser");
        let signed_in = signing_in
            .await
            .expect("the sign-in runs")
            .expect("the sign-in reads back");

        assert_eq!(opened.as_str(), "https://auth.example.test/authorize");
        assert_eq!(signed_in.access_token, "access-one");
        let handed_back = channel
            .control_requests()
            .into_iter()
            .find(|request| request["subtype"] == "mcp_oauth_callback_url")
            .expect("the browser's return is handed back");
        assert_eq!(
            handed_back["callbackUrl"],
            "https://relay.example.test/callback?code=one"
        );
        assert_eq!(
            std::fs::read_to_string(&planted).expect("the person's sign-ins read"),
            PERSON_SIGN_INS
        );
        let sign_ins = CLAUDE_MCP_SIGN_IN_FOLDER
            .iter()
            .fold(scripted.services.data_folder.clone(), |folder, part| {
                folder.join(part)
            });
        let [environment] = scripted
            .starts
            .take_sign_in_environments()
            .try_into()
            .expect("one");
        let config_folder = environment
            .iter()
            .find(|(variable, _value)| variable == "CLAUDE_CONFIG_DIR")
            .map(|(_variable, value)| std::path::PathBuf::from(value))
            .expect("the process names its config folder");
        assert_eq!(config_folder.parent(), Some(sign_ins.as_path()));
        let left = std::fs::read_dir(&sign_ins)
            .expect("the sign-ins' folder reads")
            .count();
        assert_eq!(left, 0, "the sign-in's own folder is removed");
    }
}
