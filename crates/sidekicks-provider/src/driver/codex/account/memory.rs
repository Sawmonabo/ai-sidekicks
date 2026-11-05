//! Codex's two memory stores, its first `memories/` and its second `memories_v2/`, and the rule
//! that picks one for a home; and the memory import of the store Codex picks for the person, into
//! the same store of the account home and of the switching home, which holds the memories of every
//! session that follows the current account whichever account pays for it. Neither home carries
//! the person's config, so the folders standing in each then pick that store there.

use std::io;
use std::path::Path;

use serde_json::{Map, Value};
use tokio::runtime::Handle;

use crate::account::credential_home::CredentialHome;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::config_read::read_codex_config;
use crate::driver::codex::service::registry::personal_folder_read::PersonalFolderRead;
use crate::driver::codex::service::registry::{CodexServiceRegistry, switching_home};
use crate::driver::contract::account::MemoryImportStore;

// The dotted keys of a Codex config that pick a home's memory store: the feature table and its
// memory switch, and the memory table with the store it names and whether both stores are written.
const FEATURES_KEY: &str = "features";
const FEATURES_MEMORIES_KEY: &str = "features.memories";
const MEMORIES_KEY: &str = "memories";
const MEMORIES_VERSION_KEY: &str = "memories.version";
const MEMORIES_DUAL_WRITE_KEY: &str = "memories.dual_write";

/// One of a Codex home's two memory stores: the first, `memories/`, which
/// `memories.version = "v1"` names, or the second, `memories_v2/`, which `"v2"` names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexMemoryStore {
    /// The first store, `memories/`.
    First,
    /// The second store, `memories_v2/`.
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

/// The three settings Codex picks a home's memory store by, as a Codex config sets them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CodexMemorySettings {
    // The store `memories.version` names; `None` where it is unset.
    version: Option<CodexMemoryStore>,
    // Whether `features.memories` turns the memory feature on; off where it is unset.
    is_memory_feature_on: bool,
    // `memories.dual_write` as set; `None` where it is unset, which Codex reads as not `false`.
    dual_write: Option<bool>,
}

impl CodexMemorySettings {
    /// Reads the settings from `config`, a Codex config as JSON, such as a `config/read` reply's
    /// effective config. Fails with the dotted key whose value is of a type Codex does not read
    /// there; an absent or `null` key is unset.
    pub(crate) fn read(config: &Map<String, Value>) -> Result<Self, &'static str> {
        let features = read_table(config, FEATURES_KEY)?;
        let memories = read_table(config, MEMORIES_KEY)?;
        let version = memories
            .and_then(|table| read_member(table, MEMORIES_VERSION_KEY))
            .map(|version| match version.as_str() {
                Some("v1") => Ok(CodexMemoryStore::First),
                Some("v2") => Ok(CodexMemoryStore::Second),
                _ => Err(MEMORIES_VERSION_KEY),
            })
            .transpose()?;
        Ok(Self {
            version,
            is_memory_feature_on: read_switch(features, FEATURES_MEMORIES_KEY)?.unwrap_or(false),
            dual_write: read_switch(memories, MEMORIES_DUAL_WRITE_KEY)?,
        })
    }
}

// The member of `table` the dotted `key` ends in; `None` where it is absent or `null`.
fn read_member<'config>(table: &'config Map<String, Value>, key: &str) -> Option<&'config Value> {
    let name = key.rsplit_once('.').map_or(key, |(_, name)| name);
    table.get(name).filter(|value| !value.is_null())
}

// The table `key` names in `config`; `None` where it is unset, and `key` as the failure where it
// holds anything but a table.
fn read_table<'config>(
    config: &'config Map<String, Value>,
    key: &'static str,
) -> Result<Option<&'config Map<String, Value>>, &'static str> {
    read_member(config, key)
        .map(|value| value.as_object().ok_or(key))
        .transpose()
}

// The switch `key` names in `table`; `None` where it or its table is unset, and `key` as the
// failure where it holds anything but `true` or `false`.
fn read_switch(
    table: Option<&Map<String, Value>>,
    key: &'static str,
) -> Result<Option<bool>, &'static str> {
    table
        .and_then(|table| read_member(table, key))
        .map(|value| value.as_bool().ok_or(key))
        .transpose()
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
// there for no project folder. Fails as the read fails, and as a setting of a type Codex does not
// read.
async fn read_personal_memory_store(
    registry: &CodexServiceRegistry,
    personal_home: &Path,
) -> io::Result<CodexMemoryStore> {
    let read = registry
        .read_on_personal_folder(PersonalFolderRead::Config, |service| async move {
            read_codex_config::<Map<String, Value>>(&*service.connection()?, None, false).await
        })
        .await
        .map_err(io::Error::other)?;
    let settings = CodexMemorySettings::read(&read.config).map_err(|key| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Codex's effective `{key}` holds a value of a type Codex does not read"),
        )
    })?;
    Ok(resolve_codex_memory_store(personal_home, settings).await)
}

#[cfg(test)]
mod tests;
