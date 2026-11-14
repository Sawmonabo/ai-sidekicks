//! The redirect Codex's own client sends at a sign-in to one MCP server, so a client its owner
//! registered for Codex finds the daemon's redirect identical. Codex takes the entry's own
//! `callback_url` where it names one; else, for a client its owner issued, its global
//! `mcp_oauth_callback_url`, or its listener's `http://127.0.0.1/callback`, with the server's
//! callback id appended. A registered client whose callback lacks that id falls back to the
//! global or listener address with the id where the server returns no `iss`, and a client the
//! sign-in registers itself takes the id only then. The listener binds the entry's
//! `callback_port`, else the global `mcp_oauth_callback_port`, else a free port, which goes into a
//! redirect on `127.0.0.1` that names none. A callback Codex sends as written keeps its text byte
//! for byte; one it fills or extends goes out as the address serializes.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};
use url::Url;

use crate::driver::codex::mcp::config::server_entry::{OAUTH_MEMBER, URL_MEMBER};
use crate::driver::contract::sign_in::{McpSignInCallback, RedirectAddress};

/// The setting naming the fixed port Codex's sign-in listener binds where a server names none.
const CALLBACK_PORT_SETTING: &str = "mcp_oauth_callback_port";

/// The setting naming the redirect Codex sends in place of its listener's address.
const CALLBACK_URL_SETTING: &str = "mcp_oauth_callback_url";

/// Codex's listener address where nothing names one; the listener's port goes into it.
const LISTENER_CALLBACK: &str = "http://127.0.0.1/callback";

/// The leading bytes of the SHA-256 over the server's address that Codex's callback id keeps.
const CALLBACK_ID_BYTES: usize = 9;

/// Codex's global callback settings, as its merged config at the sign-in's folder sets them.
pub(crate) struct CodexCallbackSettings {
    port: Option<u16>,
    url: Option<String>,
}

impl CodexCallbackSettings {
    /// The settings `config`, a merged config Codex's config read answers, sets; a value of
    /// another type reads as unset.
    pub(crate) fn read(config: &Map<String, Value>) -> Self {
        Self {
            port: config
                .get(CALLBACK_PORT_SETTING)
                .and_then(Value::as_u64)
                .and_then(|port| u16::try_from(port).ok()),
            url: config
                .get(CALLBACK_URL_SETTING)
                .and_then(Value::as_str)
                .map(str::to_owned),
        }
    }

    /// Writes each setting that is set into `settings`, a sign-in's own Codex home's, so Codex's
    /// own client there binds and sends what the person's Codex would.
    pub(crate) fn write_into(&self, settings: &mut toml::Table) {
        if let Some(port) = self.port {
            settings.insert(
                CALLBACK_PORT_SETTING.to_owned(),
                toml::Value::Integer(i64::from(port)),
            );
        }
        if let Some(url) = &self.url {
            settings.insert(
                CALLBACK_URL_SETTING.to_owned(),
                toml::Value::String(url.clone()),
            );
        }
    }
}

// The sign-in members of a server entry the redirect reads, in Codex's spelling.
#[derive(Default, Deserialize)]
struct CodexCallbackMembers {
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    callback_url: Option<String>,
    #[serde(default)]
    callback_port: Option<u16>,
}

/// The redirect Codex's own client sends at a sign-in to `entry`'s server, with `settings`
/// beside it; `None` where it names no client, callback or port and no global callback is set,
/// so Codex listens on a free port at a path it registers itself, and where an address Codex
/// would refuse does not parse. A port of 0, which Codex refuses, reads as a free one.
pub(crate) fn resolve_codex_sign_in_callback(
    entry: &Map<String, Value>,
    settings: &CodexCallbackSettings,
) -> Option<McpSignInCallback> {
    let callback_id = callback_id(entry.get(URL_MEMBER)?.as_str()?)?;
    let members = match entry.get(OAUTH_MEMBER) {
        Some(oauth) => CodexCallbackMembers::deserialize(oauth).ok()?,
        None => CodexCallbackMembers::default(),
    };
    let is_owner_client = members
        .client_id
        .as_deref()
        .is_some_and(|client_id| !client_id.trim().is_empty());
    let port = members
        .callback_port
        .or(settings.port)
        .filter(|port| *port != 0);
    if !is_owner_client
        && members.callback_url.is_none()
        && port.is_none()
        && settings.url.is_none()
    {
        return None;
    }
    let global_callback = || {
        settings
            .url
            .as_deref()
            .map(RedirectAddress::parse)
            .transpose()
            .ok()
    };
    let configured = match (&members.callback_url, is_owner_client) {
        (Some(callback_url), _) => Some(RedirectAddress::parse(callback_url).ok()?),
        (None, false) => global_callback()?,
        (None, true) => {
            let base = Url::parse(settings.url.as_deref().unwrap_or(LISTENER_CALLBACK)).ok()?;
            Some(append_callback_id(&base, &callback_id))
        }
    };
    let form = |is_issuer_returned: bool| -> Option<RedirectAddress> {
        // A registered client's callback without the id gives way only where no `iss` returns.
        let is_fallback = is_owner_client
            && !is_issuer_returned
            && configured
                .as_ref()
                .is_some_and(|callback| last_segment(callback.url()) != Some(callback_id.as_str()));
        let callback = if is_fallback {
            global_callback()?
        } else {
            configured.clone()
        };
        let is_sent_as_is = callback.is_some() && !is_fallback;
        let redirect = listener_redirect(callback, port);
        let is_id_appended = if is_owner_client {
            !is_sent_as_is
        } else {
            !is_issuer_returned
        };
        Some(if is_id_appended {
            append_callback_id(redirect.url(), &callback_id)
        } else {
            redirect
        })
    };
    Some(McpSignInCallback {
        with_issuer: form(true)?,
        without_issuer: form(false)?,
    })
}

// Codex's callback id for the server at `server_url`: the URL-safe base64, unpadded, of the first
// 9 bytes of the SHA-256 over its address with any fragment dropped; `None` for an address with
// no host, which Codex refuses.
fn callback_id(server_url: &str) -> Option<String> {
    let mut address = Url::parse(server_url).ok()?;
    address.host_str()?;
    address.set_fragment(None);
    let digest = Sha256::digest(address.as_str().as_bytes());
    Some(URL_SAFE_NO_PAD.encode(&digest[..CALLBACK_ID_BYTES]))
}

// The address Codex's listener answers on for `callback`: the listener's own where none is named,
// and a named one on `127.0.0.1` with no port given the fixed port where there is one, which
// Codex sends as the address serializes; a free port goes into either once the listener binds.
fn listener_redirect(callback: Option<RedirectAddress>, port: Option<u16>) -> RedirectAddress {
    let callback = callback.unwrap_or_else(|| {
        RedirectAddress::parse(LISTENER_CALLBACK).expect("the listener's callback is an address")
    });
    let address = callback.url();
    if address.scheme() == "http"
        && address.host_str() == Some("127.0.0.1")
        && address.port().is_none()
    {
        let mut redirect = address.clone();
        redirect
            .set_port(port)
            .expect("an http address takes a port");
        return RedirectAddress::from_url(redirect);
    }
    callback
}

// `redirect` with `callback_id` as its last path segment, kept as it is where it already ends so,
// sent as the address serializes, as Codex sends it.
fn append_callback_id(redirect: &Url, callback_id: &str) -> RedirectAddress {
    let mut redirect = redirect.clone();
    if last_segment(&redirect) != Some(callback_id) {
        let path = redirect.path();
        let path = if path.ends_with('/') {
            format!("{path}{callback_id}")
        } else {
            format!("{path}/{callback_id}")
        };
        redirect.set_path(&path);
    }
    RedirectAddress::from_url(redirect)
}

fn last_segment(address: &Url) -> Option<&str> {
    address.path_segments()?.next_back()
}
