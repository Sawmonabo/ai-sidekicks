//! Codex's settings as the daemon reads them. A reader with a service running on the Codex home it
//! reads asks Codex itself through `config/read`: the effective config Codex merged from its layers
//! for a folder or for none, the layer that set each key, and on request each layer as it stands.
//! A reader with no service to ask, the privacy read before each start among them, reads a layer's
//! `config.toml` itself through [`read_codex_config_file`]. The service's processing region is read
//! here too, from the host of the base URL its model provider sends requests to.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use url::Url;

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
    /// The layer's version, which a write to it expects.
    pub(crate) version: String,
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

impl CodexConfigLayerSource {
    /// The kind of the layer that holds the person's own Codex config.
    pub(crate) const USER_KIND: &'static str = "user";

    /// The kind of a layer that holds a project's own Codex config.
    pub(crate) const PROJECT_KIND: &'static str = "project";
}

/// Codex's settings for `cwd` as `connection`'s service resolves them, each layer listed in the
/// reply when `include_layers` asks; with no `cwd`, the config Codex loads for no folder, which no
/// project layer joins. Fails as the request fails, and with `CodexError::Transport` for a reply
/// `Config` cannot read.
pub(crate) async fn read_codex_config<Config: DeserializeOwned>(
    connection: &CodexAppServerConnection,
    cwd: Option<&Path>,
    include_layers: bool,
) -> Result<CodexConfigRead<Config>, CodexError> {
    let reply = connection
        .request(
            CONFIG_READ_METHOD,
            &ConfigReadParams {
                cwd: cwd.map(|cwd| cwd.to_string_lossy().into_owned()),
                include_layers: Some(include_layers),
            },
        )
        .await?;
    read_codex_object(reply.get()).ok_or_else(|| CodexError::Transport {
        detail: format!("Codex's \"{CONFIG_READ_METHOD}\" reply could not be read."),
        cause: None,
    })
}

/// Where a Codex service's model requests are processed, by the host of its model provider's base
/// URL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CodexProcessingRegion {
    /// The API's own host, `api.openai.com`, set or by default: no regional processing.
    NoRegion,
    /// A data-residency host of the API, by its domain prefix (`eu` for `eu.api.openai.com`).
    Region(String),
    /// Any other host, or a base URL that does not parse, whose region is unknown.
    UnknownHost,
}

/// The API's own host, which processes requests with no regional processing.
const OPENAI_API_HOST: &str = "api.openai.com";

/// The API's data-residency domain prefixes, each labeling a host `<prefix>.api.openai.com`.
pub(crate) const OPENAI_REGION_PREFIXES: [&str; 10] =
    ["us", "eu", "ae", "au", "ca", "jp", "in", "sg", "kr", "gb"];

/// Codex's built-in model provider, whose base URL is `openai_base_url`.
const OPENAI_PROVIDER_ID: &str = "openai";

// The effective config's keys that name where model requests go: the provider, the built-in
// provider's base URL and each other provider's.
#[derive(Deserialize)]
struct CodexEndpointConfig {
    #[serde(default)]
    model_provider: Option<String>,
    #[serde(default)]
    openai_base_url: Option<String>,
    #[serde(default)]
    model_providers: HashMap<String, CodexModelProviderEndpoint>,
}

#[derive(Deserialize)]
struct CodexModelProviderEndpoint {
    #[serde(default)]
    base_url: Option<String>,
}

/// The processing region of the Codex service `connection` reaches, read from its settings for
/// `cwd`. Fails as [`read_codex_config`] does.
pub(crate) async fn read_codex_processing_region(
    connection: &CodexAppServerConnection,
    cwd: &Path,
) -> Result<CodexProcessingRegion, CodexError> {
    let read = read_codex_config::<CodexEndpointConfig>(connection, Some(cwd), false).await?;
    Ok(processing_region_of(&read.config))
}

// The region of the base URL `config`'s model provider sends to: the built-in provider's own
// setting, unset or empty meaning OpenAI's host as Codex reads it, or another provider's entry,
// which has no default host.
fn processing_region_of(config: &CodexEndpointConfig) -> CodexProcessingRegion {
    let base_url = match config.model_provider.as_deref() {
        None | Some(OPENAI_PROVIDER_ID) => {
            let Some(base_url) = config
                .openai_base_url
                .as_deref()
                .filter(|base_url| !base_url.is_empty())
            else {
                return CodexProcessingRegion::NoRegion;
            };
            base_url
        }
        Some(provider_id) => {
            let Some(base_url) = config
                .model_providers
                .get(provider_id)
                .and_then(|provider| provider.base_url.as_deref())
            else {
                return CodexProcessingRegion::UnknownHost;
            };
            base_url
        }
    };
    let Ok(url) = Url::parse(base_url) else {
        return CodexProcessingRegion::UnknownHost;
    };
    let Some(host) = url.host_str() else {
        return CodexProcessingRegion::UnknownHost;
    };
    if host == OPENAI_API_HOST {
        return CodexProcessingRegion::NoRegion;
    }
    match host
        .strip_suffix(OPENAI_API_HOST)
        .and_then(|prefix| prefix.strip_suffix('.'))
    {
        Some(prefix) if OPENAI_REGION_PREFIXES.contains(&prefix) => {
            CodexProcessingRegion::Region(prefix.to_owned())
        }
        Some(_) | None => CodexProcessingRegion::UnknownHost,
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::json;

    use super::{CodexEndpointConfig, CodexProcessingRegion, processing_region_of};

    // OpenAI's host or no or an empty base URL is no region, a data-residency host its prefix,
    // and any other host, an unlisted prefix or a custom provider unknown. Killed by a suffix or
    // substring host match, ignoring `model_provider` (a custom provider read as OpenAI), ignoring
    // a custom provider's `base_url`, labeling an unlisted prefix, and parsing an empty base URL
    // (an unknown host).
    #[rstest]
    #[case::default_host(json!({}), "none")]
    #[case::empty_base_url(json!({ "openai_base_url": "" }), "none")]
    #[case::openai_host(json!({ "openai_base_url": "https://api.openai.com/v1" }), "none")]
    #[case::regional_host(json!({ "openai_base_url": "https://eu.api.openai.com/v1" }), "eu")]
    #[case::residency_provider(
        json!({
            "model_provider": "openaidr",
            "model_providers": { "openaidr": { "base_url": "https://ae.api.openai.com/v1" } }
        }),
        "ae"
    )]
    #[case::host_suffix(
        json!({ "openai_base_url": "https://us.api.openai.com.evil.com/v1" }),
        "unknown"
    )]
    #[case::user_info(
        json!({ "openai_base_url": "https://us.api.openai.com@evil.com/v1" }),
        "unknown"
    )]
    #[case::unlisted_prefix(
        json!({ "openai_base_url": "https://xx.api.openai.com/v1" }),
        "unknown"
    )]
    #[case::proxy(
        json!({
            "model_provider": "proxy",
            "openai_base_url": "https://eu.api.openai.com/v1",
            "model_providers": { "proxy": { "base_url": "http://proxy.example.com" } }
        }),
        "unknown"
    )]
    #[case::local_provider(json!({ "model_provider": "ollama" }), "unknown")]
    fn reads_the_region_from_the_model_providers_host(
        #[case] config: serde_json::Value,
        #[case] region: &str,
    ) {
        let config: CodexEndpointConfig = serde_json::from_value(config).expect("the config reads");
        let read = match processing_region_of(&config) {
            CodexProcessingRegion::NoRegion => "none".to_owned(),
            CodexProcessingRegion::Region(prefix) => prefix,
            CodexProcessingRegion::UnknownHost => "unknown".to_owned(),
        };
        assert_eq!(read, region);
    }
}
