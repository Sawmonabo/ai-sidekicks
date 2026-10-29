//! Codex's own read of its settings for a folder, `config/read`: the effective config Codex merged
//! from its layers for that folder, the layer that set each key, and on request each layer as it
//! stands. Every reader of Codex's settings asks through this one call.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::driver::codex::app_server_protocol::ConfigReadParams;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};

/// The request that reads Codex's settings for a folder.
const CONFIG_READ_METHOD: &str = "config/read";

/// A `config/read` reply: the effective config as `Config` reads it, the layer that set each key,
/// and each layer where the read asked for them.
#[derive(Deserialize)]
pub(crate) struct CodexConfigRead<Config> {
    /// The effective config, its TOML keys at the top.
    pub(crate) config: Config,
    /// The layer that set each dotted key, by key.
    pub(crate) origins: HashMap<String, CodexConfigOrigin>,
    /// Each layer, the highest precedence first, Codex's packaged defaults left out; absent where
    /// the read did not ask for them.
    #[serde(default)]
    pub(crate) layers: Option<Vec<CodexConfigLayer>>,
}

/// One of Codex's config layers as it stands: where it comes from, its own TOML as JSON, and why
/// Codex leaves it out of the effective config, where it does.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexConfigLayer {
    /// Where the layer comes from.
    pub(crate) name: CodexConfigLayerSource,
    /// The layer's own config, before any merge.
    pub(crate) config: Value,
    /// Why Codex ignores the layer when it merges; `None` for a layer it merges.
    #[serde(default)]
    pub(crate) disabled_reason: Option<String>,
}

/// Where one key's effective value came from.
#[derive(Deserialize)]
pub(crate) struct CodexConfigOrigin {
    /// The layer that set it.
    pub(crate) name: CodexConfigLayerSource,
}

/// Where one of Codex's config layers comes from: its kind (`user`, `project`, `packagedDefaults`)
/// and the file or folder that kind names. A member the kind does not carry is `None`, and a kind
/// this reader does not know reads with its kind alone.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexConfigLayerSource {
    /// The layer's kind.
    #[serde(rename = "type")]
    pub(crate) kind: String,
    /// The layer's file: the user's, the system's, the packaged defaults' or the legacy managed
    /// file's.
    #[serde(default)]
    pub(crate) file: Option<String>,
    /// A project layer's `.codex` folder.
    #[serde(default)]
    pub(crate) dot_codex_folder: Option<String>,
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
