//! Claude Code's saved MCP sign-ins as the sign-in reads them back: whether its stored
//! credentials hold one for a server, and the one saved for a server at its address, read from the
//! sign-in's own folder or the keychain item Claude Code files for it, with its client.

use std::error::Error;
use std::time::{Duration, UNIX_EPOCH};

use secrecy::{ExposeSecret as _, SecretString};
use serde::Deserialize;
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::mcp::server::config::McpServerAddress;

use super::ClaudeSignInError;
use crate::driver::claude::account::credentials::{
    ClaudeSignInReader, ClaudeStoredCredentials, read_claude_credential_file, read_secret,
};
use crate::driver::claude::mcp::machine_probe::variables::expand_remote_address;
use crate::driver::contract::sign_in::{BEARER_TOKEN_TYPE, ProviderSignInTakeover};
use crate::driver::mcp_server::address::names_server_at;

/// Whether `stored` holds a sign-in with an access token for `name`.
pub(super) fn holds_sign_in_for(stored: &ClaudeStoredCredentials, name: &McpServerName) -> bool {
    stored.mcp_oauth.values().any(|sign_in| {
        sign_in.server_name.as_deref() == Some(name.as_str())
            && sign_in.access_token.as_ref().is_some_and(is_held)
    })
}

// Whether `secret` holds a value; Claude Code leaves an empty one where it has none.
fn is_held(secret: &SecretString) -> bool {
    !secret.expose_secret().is_empty()
}

/// Reads the sign-in Claude Code saved for `name` at `address` where it keeps it: the credential
/// folder's file `environment` names, else the keychain item named for that folder, which is
/// removed once read so no token outlives the sign-in. A removal that fails is logged where the
/// read succeeded, and reported beside the read's failure where it did not.
pub(super) async fn read_saved_sign_in(
    credentials: &ClaudeSignInReader,
    environment: &[(String, String)],
    name: &McpServerName,
    address: &McpServerAddress,
) -> Result<ClaudeSavedSignInReading, ClaudeSignInError> {
    let from_file = match read_claude_credential_file(environment).await {
        Ok(Some(stored)) => read_claude_saved_sign_in(stored, environment, name, address),
        Ok(None) => Err(ClaudeSignInError::NoSavedSignIn),
        Err(error) => Err(ClaudeSignInError::CredentialsUnreadable(error)),
    };
    if from_file.is_ok() {
        return from_file;
    }
    let from_keychain = match credentials.read_keychain_record(environment).await {
        Ok(Some(stored)) => read_claude_saved_sign_in(stored, environment, name, address),
        // Nothing in the keychain to read or remove: the file's outcome stands.
        Ok(None) => return from_file,
        Err(error) => Err(ClaudeSignInError::CredentialsUnreadable(error)),
    };
    match (
        from_keychain,
        credentials.remove_keychain_record(environment).await,
    ) {
        (from_keychain, Ok(_was_held)) => from_keychain,
        (Ok(reading), Err(removal)) => {
            tracing::warn!(
                error = &removal as &(dyn Error + 'static),
                "the keychain item of a read MCP sign-in was not removed"
            );
            Ok(reading)
        }
        (Err(read), Err(removal)) => Err(ClaudeSignInError::KeychainItemLeft {
            read: Box::new(read),
            removal,
        }),
    }
}

/// One saved MCP sign-in as Claude Code writes it in its stored credentials, each member read
/// leniently, since a stub for another server may lack any of them. It derives no `Debug`, since
/// it holds tokens.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeSavedSignIn {
    #[serde(default)]
    server_name: Option<String>,
    #[serde(default)]
    server_url: Option<String>,
    #[serde(default, deserialize_with = "read_secret")]
    access_token: Option<SecretString>,
    #[serde(default, deserialize_with = "read_secret")]
    refresh_token: Option<SecretString>,
    #[serde(default)]
    expires_at: Option<f64>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default, deserialize_with = "read_secret")]
    client_secret: Option<SecretString>,
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
pub(super) struct ClaudeSavedSignInReading {
    /// The credentials, their client id empty where Claude Code kept none.
    pub(super) takeover: ProviderSignInTakeover,
    /// Whether the saved sign-in named its client.
    has_client_id: bool,
}

/// The sign-in `stored` holds for the server `name` at `address`, matched by the saved name and
/// address, never by Claude Code's key, whose hash Claude Code computes; a saved address that does
/// not name the server as written is read again with its variables filled from `environment`, the
/// sign-in process's own, as an address saved as the entry declares it. The expiry Claude Code
/// keeps in milliseconds since the epoch, the scopes as one space-separated text. Fails with
/// `NoSavedSignIn` when none with an access token matches.
pub(super) fn read_claude_saved_sign_in(
    stored: ClaudeStoredCredentials,
    environment: &[(String, String)],
    name: &McpServerName,
    address: &McpServerAddress,
) -> Result<ClaudeSavedSignInReading, ClaudeSignInError> {
    let (sign_in, access_token) = stored
        .mcp_oauth
        .into_values()
        .find_map(|mut sign_in| {
            let is_match = sign_in.server_name.as_deref() == Some(name.as_str())
                && sign_in.server_url.as_deref().is_some_and(|url| {
                    names_server_at(url, address)
                        || names_server_at(&expand_remote_address(url, environment), address)
                });
            let access_token = sign_in.access_token.take().filter(is_held)?;
            is_match.then_some((sign_in, access_token))
        })
        .ok_or(ClaudeSignInError::NoSavedSignIn)?;
    let has_client_id = sign_in.client_id.is_some();
    Ok(ClaudeSavedSignInReading {
        takeover: ProviderSignInTakeover {
            access_token,
            refresh_token: sign_in.refresh_token.filter(is_held),
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
            client_secret: sign_in.client_secret.filter(is_held),
            issuer: sign_in.issuer.or_else(|| {
                sign_in
                    .discovery_state
                    .and_then(|state| state.authorization_server_url)
            }),
        },
        has_client_id,
    })
}

/// The saved sign-in with its client id, the one the server's owner issued where Claude Code
/// kept none. Fails with `NoClient` where neither names one.
pub(super) fn complete_client(
    saved: ClaudeSavedSignInReading,
    configured_client_id: Option<String>,
) -> Result<ProviderSignInTakeover, ClaudeSignInError> {
    let mut takeover = saved.takeover;
    if !saved.has_client_id {
        takeover.client_id = configured_client_id.ok_or(ClaudeSignInError::NoClient)?;
    }
    Ok(takeover)
}
