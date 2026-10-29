//! Codex's own read of its settings for a folder, `config/read`: the effective config Codex merged
//! from its layers for that folder, and the layer that set each key. Every reader of Codex's
//! settings asks through this one call.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;
use serde::de::DeserializeOwned;

use crate::driver::codex::app_server_protocol::ConfigReadParams;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};

/// The request that reads Codex's settings for a folder.
const CONFIG_READ_METHOD: &str = "config/read";

/// A `config/read` reply: the effective config as `Config` reads it, and the layer that set each
/// key.
#[derive(Deserialize)]
pub(crate) struct CodexConfigRead<Config> {
    /// The effective config, its TOML keys at the top.
    pub(crate) config: Config,
    /// The layer that set each dotted key, by key.
    pub(crate) origins: HashMap<String, CodexConfigOrigin>,
}

/// Where one key's effective value came from.
#[derive(Deserialize)]
pub(crate) struct CodexConfigOrigin {
    /// The layer that set it.
    pub(crate) name: CodexConfigLayerSource,
}

/// One of Codex's config layers, by its kind (`user`, `project`, `packagedDefaults`).
#[derive(Deserialize)]
pub(crate) struct CodexConfigLayerSource {
    /// The layer's kind.
    #[serde(rename = "type")]
    pub(crate) kind: String,
}

/// Codex's settings for `cwd` as `connection`'s service resolves them, each layer listed in the
/// reply when `include_layers` asks. Fails as the request fails, and with `CodexError::Transport`
/// for a reply `Config` cannot read.
pub(crate) async fn read_codex_config<Config: DeserializeOwned>(
    connection: &CodexAppServerConnection,
    cwd: &Path,
    include_layers: bool,
) -> Result<CodexConfigRead<Config>, CodexError> {
    let reply = connection
        .request(
            CONFIG_READ_METHOD,
            &ConfigReadParams {
                cwd: Some(cwd.to_string_lossy().into_owned()),
                include_layers: Some(include_layers),
            },
        )
        .await?;
    read_codex_object(reply.get()).ok_or_else(|| CodexError::Transport {
        detail: format!("Codex's \"{CONFIG_READ_METHOD}\" reply could not be read."),
        cause: None,
    })
}
