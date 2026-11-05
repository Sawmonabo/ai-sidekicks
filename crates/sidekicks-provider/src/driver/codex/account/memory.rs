//! Codex's two memory stores, its first `memories/` and its second `memories_v2/`, and the rule
//! that picks one for a home; and the memory import of the store Codex picks for the person, into
//! the same store of the account home and of the switching home, which holds the memories of every
//! session that follows the current account whichever account pays for it. Neither home carries
//! the person's config, so the folders standing in each then pick that store there.

use std::io;
use std::path::Path;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::runtime::Handle;

use crate::account::credential_home::CredentialHome;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::config_read::read_codex_config;
use crate::driver::codex::service::registry::personal_folder_read::PersonalFolderRead;
use crate::driver::codex::service::registry::{CodexServiceRegistry, switching_home};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::read_codex_object;
use crate::driver::contract::account::MemoryImportStore;

/// The request that reads the requirements Codex's managed policy sets, `[features]` pins among
/// them.
const CONFIG_REQUIREMENTS_READ_METHOD: &str = "configRequirements/read";

/// One of a Codex home's two memory stores: the first, `memories/`, which
/// `memories.version = "v1"` names, or the second, `memories_v2/`, which `"v2"` names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub(crate) enum CodexMemoryStore {
    /// The first store, `memories/`.
    #[serde(rename = "v1")]
    First,
    /// The second store, `memories_v2/`.
    #[serde(rename = "v2")]
    Second,
}

impl CodexMemoryStore {
    /// The store's folder in a Codex home.
    pub(crate) fn folder_name(self) -> &'static str {
        match self {
            Self::First => "memories",
            Self::Second => "memories_v2",
        }
    }
}

// What a Codex config sets of the memory feature and the memory stores; an absent or `null` key
// is unset, and every other key is left unread.
#[derive(Deserialize)]
struct CodexMemoryConfig {
    features: Option<CodexMemoryFeature>,
    memories: Option<CodexMemoryTable>,
}

// The memory feature's switch in a table of features, under its own key or its legacy one.
#[derive(Deserialize)]
struct CodexMemoryFeature {
    memories: Option<bool>,
    memory_tool: Option<bool>,
}

impl CodexMemoryFeature {
    // The switch, the legacy key winning where both are set: Codex applies the keys in sorted
    // order, so `memory_tool` lands after `memories`.
    fn switch(&self) -> Option<bool> {
        self.memory_tool.or(self.memories)
    }
}

// The memory table: the store it names and whether both stores are written.
#[derive(Deserialize)]
struct CodexMemoryTable {
    version: Option<CodexMemoryStore>,
    dual_write: Option<bool>,
}

// A `configRequirements/read` reply, as far as the features its policy pins.
#[derive(Deserialize)]
struct CodexRequirementsRead {
    requirements: Option<CodexFeatureRequirements>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexFeatureRequirements {
    feature_requirements: Option<CodexMemoryFeature>,
}

/// The three settings Codex picks a home's memory store by, as its config and its requirements
/// set them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CodexMemorySettings {
    // The store `memories.version` names; `None` where it is unset.
    version: Option<CodexMemoryStore>,
    // Whether the memory feature is on: as a requirement pins it, else as the config sets it; off
    // where neither does.
    is_memory_feature_on: bool,
    // `memories.dual_write` as set; `None` where it is unset, which Codex reads as not `false`.
    dual_write: Option<bool>,
}

impl CodexMemorySettings {
    /// Reads the settings from `config`, a `config/read` reply's effective config, and
    /// `requirements`, a `configRequirements/read` reply, whose pin of the memory feature wins
    /// over the config's. Fails with the path of a value of a type Codex does not read there.
    pub(crate) fn read(config: Value, requirements: Value) -> io::Result<Self> {
        let config: CodexMemoryConfig = read_reply(config, "effective config")?;
        let requirements: CodexRequirementsRead = read_reply(requirements, "requirements")?;
        let required = requirements
            .requirements
            .and_then(|requirements| requirements.feature_requirements);
        let required = required.as_ref().and_then(CodexMemoryFeature::switch);
        let configured = config
            .features
            .as_ref()
            .and_then(CodexMemoryFeature::switch);
        let memories = config.memories;
        Ok(Self {
            version: memories.as_ref().and_then(|table| table.version),
            is_memory_feature_on: required.or(configured).unwrap_or(false),
            dual_write: memories.and_then(|table| table.dual_write),
        })
    }
}

// `value`, Codex's `reply`, read as `Shape`; fails with the path of a value of a type Codex does
// not read there, never the value, which may be a secret.
fn read_reply<Shape: DeserializeOwned>(value: Value, reply: &str) -> io::Result<Shape> {
    serde_path_to_error::deserialize(value).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "Codex's {reply} holds a value of a type Codex does not read at `{}`",
                error.path()
            ),
        )
    })
}

/// The store Codex reads and writes in `codex_home` under `settings`: the one `memories.version`
/// names; else the second where the memory feature is on, `dual_write` is not `false` and the home
/// holds no first store; else the first, a failed check of the home's folder counting as the
/// first's, as Codex fails closed.
pub(crate) async fn resolve_codex_memory_store(
    codex_home: &Path,
    settings: CodexMemorySettings,
) -> CodexMemoryStore {
    if let Some(store) = settings.version {
        return store;
    }
    if settings.is_memory_feature_on
        && settings.dual_write != Some(false)
        && matches!(
            tokio::fs::try_exists(codex_home.join(CodexMemoryStore::First.folder_name())).await,
            Ok(false)
        )
    {
        return CodexMemoryStore::Second;
    }
    CodexMemoryStore::First
}

/// The person's own Codex memory store, the one Codex picks for them by the settings it reports
/// for them, with the same store of the two homes it lands in for the account whose home is
/// `home`; a store the person does not have is skipped by the import. Asks Codex for the person's
/// settings, and fails as that read fails.
pub(super) fn codex_memory_import_stores(
    legs: &CodexAccountLegs,
    home: &CredentialHome,
) -> io::Result<Vec<MemoryImportStore>> {
    let personal_home = legs.registry.personal_home();
    // The legs run on a blocking thread of the daemon's runtime.
    let store =
        Handle::current().block_on(read_personal_memory_store(&legs.registry, &personal_home))?;
    let folder = store.folder_name();
    let switching_home = switching_home(&legs.dependencies.data_folder);
    Ok(vec![MemoryImportStore {
        source: personal_home.join(folder),
        destinations: vec![home.path().join(folder), switching_home.join(folder)],
    }])
}

// The store Codex picks for the person's own folder `personal_home`, by the config Codex loads
// there for no project folder and the requirements its managed policy sets. Fails as either read
// fails, and as a setting of a type Codex does not read.
async fn read_personal_memory_store(
    registry: &CodexServiceRegistry,
    personal_home: &Path,
) -> io::Result<CodexMemoryStore> {
    let (config, requirements) = registry
        .read_on_personal_folder(PersonalFolderRead::Config, |service| async move {
            let connection = service.connection()?;
            let config = read_codex_config::<Value>(&connection, None, false).await?;
            let reply = connection
                .request(CONFIG_REQUIREMENTS_READ_METHOD, &())
                .await?;
            let requirements =
                read_codex_object::<Value>(reply.get()).ok_or_else(|| CodexError::Transport {
                    detail: format!(
                        "Codex's \"{CONFIG_REQUIREMENTS_READ_METHOD}\" reply could not be read."
                    ),
                    cause: None,
                })?;
            Ok((config.config, requirements))
        })
        .await
        .map_err(io::Error::other)?;
    let settings = CodexMemorySettings::read(config, requirements)?;
    Ok(resolve_codex_memory_store(personal_home, settings).await)
}

#[cfg(test)]
mod tests;
