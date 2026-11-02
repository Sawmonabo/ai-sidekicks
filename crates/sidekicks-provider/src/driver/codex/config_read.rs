//! Codex's settings as the daemon reads them. A reader with a service running on the Codex home it
//! reads asks Codex itself through `config/read`: the effective config Codex merged from its layers
//! for a folder, the layer that set each key, and on request each layer as it stands. A reader
//! with no service to ask, the person's own Codex folder among the homes it reads, reads a layer's
//! `config.toml` itself through [`read_codex_config_file`].

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::driver::codex::app_server_protocol::ConfigReadParams;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};

/// The request that reads Codex's settings for a folder.
const CONFIG_READ_METHOD: &str = "config/read";

/// The file each of Codex's config layers keeps its settings in, in the layer's folder.
pub(crate) const CODEX_CONFIG_FILE_NAME: &str = "config.toml";

/// Why a Codex `config.toml` could not be read. No variant quotes the file's text, which can hold
/// an MCP server's token: a parse failure keeps the line and the TOML reader's own words alone.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CodexConfigFileError {
    /// The file could not be read.
    #[error("reading Codex's configuration {} failed", path.display())]
    Read {
        /// The config file.
        path: PathBuf,
        /// The file system's failure.
        #[source]
        failure: io::Error,
    },
    /// The file is not TOML, so Codex does not start on it.
    #[error(
        "Codex's configuration {} does not parse{}: {message}",
        path.display(),
        line.map_or_else(String::new, |line| format!(" at line {line}"))
    )]
    Unparsable {
        /// The config file.
        path: PathBuf,
        /// The line the failure is on, counted from 1, where the reader names a place.
        line: Option<usize>,
        /// The TOML reader's words for the failure, which hold none of the file's text.
        message: String,
    },
    /// A key holds a value of another type than Codex reads there, so Codex does not start on it.
    #[error("Codex's configuration {} sets `{key}` to a value of the wrong type", path.display())]
    Mistyped {
        /// The config file.
        path: PathBuf,
        /// The dotted key whose value has the wrong type.
        key: String,
    },
}

/// The table of the `config.toml` at `path`, `None` where there is no file. Fails with
/// [`CodexConfigFileError::Read`] where it cannot be read and
/// [`CodexConfigFileError::Unparsable`] where it is not TOML.
pub(crate) async fn read_codex_config_file(
    path: &Path,
) -> Result<Option<toml::Table>, CodexConfigFileError> {
    let text = match tokio::fs::read_to_string(path).await {
        Ok(text) => text,
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(failure) => {
            return Err(CodexConfigFileError::Read {
                path: path.to_path_buf(),
                failure,
            });
        }
    };
    // The parse error is dropped once its line and words are read: it holds the file's text and
    // shows it.
    toml::from_str(&text)
        .map(Some)
        .map_err(|failure| CodexConfigFileError::Unparsable {
            path: path.to_path_buf(),
            line: failure
                .span()
                .and_then(|span| text.get(..span.start))
                .map(|before| before.matches('\n').count() + 1),
            message: failure.message().to_owned(),
        })
}

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
