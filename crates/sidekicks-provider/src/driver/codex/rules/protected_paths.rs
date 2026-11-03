//! The paths Codex's permission profiles deny on this machine, read as Codex resolves them: its
//! config layers merged, the system's `config.toml` under each home's and a trusted project's over
//! both, the profile the merged `default_permissions` selects followed through every profile it
//! `extends`, parents first, and each deny entry named by the layer file that set it.
//!
//! Codex's own `config/read` gives the merged layers only for a home a service runs on, and the
//! person's own Codex folder has none; nor does it resolve `extends`. So the layers are read here,
//! in the order and with the deep table merge Codex's config loader uses.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the provider settings page's protected paths, which the Codex driver serves"
    )
)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sidekicks_contracts::provider::settings::rules::ProviderProtectedPath;

use super::listing::{CodexRuleListingSources, listable_path, listable_text};
use super::{CODEX_PROJECT_SETTINGS_FOLDER, CodexRulesError, is_codex_home_project};
use crate::driver::codex::config_read::{CODEX_CONFIG_FILE_NAME, read_codex_config_file};

// The config keys that select a permission profile and hold the profiles, a profile's parent and
// its filesystem entries; the word a filesystem entry denies with; and the older sandbox key, which
// Codex follows over any profile where a layer above every `default_permissions` sets it.
const DEFAULT_PERMISSIONS_KEY: &str = "default_permissions";
const PERMISSIONS_KEY: &str = "permissions";
const EXTENDS_KEY: &str = "extends";
const FILESYSTEM_KEY: &str = "filesystem";
const DENY_ACCESS: &str = "deny";
const SANDBOX_MODE_KEY: &str = "sandbox_mode";

// The subpath of a scoped filesystem entry that names its root itself, and the mark that starts
// the name of a profile built into Codex, which denies nothing a config file writes.
const SCOPED_ROOT_SUBPATH: &str = ".";
const BUILT_IN_PROFILE_MARK: char = ':';

// One deny entry in force: its pattern and the layer file that set it.
#[derive(Clone, PartialEq, Eq)]
struct DenyEntry {
    pattern: String,
    source: PathBuf,
}

/// The paths Codex's permission profiles deny: for each account home and the person's own Codex
/// folder, every `deny` filesystem entry of the profile its layers select, the system's under its
/// own, listed as global; and for each trusted project read over each of those homes, every one
/// the project's layer brings into force beyond that home's, listed under the project. A scoped
/// entry's subpath is joined to its root. Layers that select no profile, or leave the older
/// `sandbox_mode` in force, list none. Fails with `UnreadableConfig` where a layer cannot be read
/// or is not TOML, `UnresolvedProfile` where the selected profile does not resolve, and
/// `Unlistable` where an entry or a path does not fit the list.
pub(crate) async fn read_codex_protected_paths(
    sources: &CodexRuleListingSources<'_>,
) -> Result<Vec<ProviderProtectedPath>, CodexRulesError> {
    let mut configs = ConfigFiles::default();
    let system_config = sources.system_folder.join(CODEX_CONFIG_FILE_NAME);
    let codex_homes: Vec<&Path> = sources
        .account_homes
        .iter()
        .map(|home| home.codex_home.as_path())
        .chain(std::iter::once(sources.personal_codex_home))
        .collect();
    let mut entries = Vec::new();
    let mut home_denies = Vec::with_capacity(codex_homes.len());
    for codex_home in &codex_homes {
        let layers = [
            system_config.clone(),
            codex_home.join(CODEX_CONFIG_FILE_NAME),
        ];
        let denies = configs.resolve_denies(&layers).await?;
        for deny in &denies {
            let entry = ProviderProtectedPath::Global {
                pattern: listable_text(&deny.source, deny.pattern.clone())?,
                place: sources.place.cloned(),
                source_path: listable_path(&deny.source)?,
            };
            if !entries.contains(&entry) {
                entries.push(entry);
            }
        }
        home_denies.push(denies);
    }
    for project in sources.projects.iter().filter(|project| project.is_trusted) {
        if is_any_codex_home(&codex_homes, &project.project_folder).await {
            continue;
        }
        let project_config = project
            .project_folder
            .join(CODEX_PROJECT_SETTINGS_FOLDER)
            .join(CODEX_CONFIG_FILE_NAME);
        for (codex_home, denies_without_project) in codex_homes.iter().zip(&home_denies) {
            let layers = [
                system_config.clone(),
                codex_home.join(CODEX_CONFIG_FILE_NAME),
                project_config.clone(),
            ];
            for deny in configs.resolve_denies(&layers).await? {
                if denies_without_project.contains(&deny) {
                    continue;
                }
                let entry = ProviderProtectedPath::Project {
                    pattern: listable_text(&deny.source, deny.pattern.clone())?,
                    source_path: listable_path(&deny.source)?,
                    repo_mount_id: project.repo_mount_id,
                };
                if !entries.contains(&entry) {
                    entries.push(entry);
                }
            }
        }
    }
    Ok(entries)
}

// Whether the project's `.codex` folder is one of the Codex homes, whose config is read as the
// home's and which Codex never reads as a project's.
async fn is_any_codex_home(codex_homes: &[&Path], project_folder: &Path) -> bool {
    for codex_home in codex_homes {
        if is_codex_home_project(project_folder, codex_home).await {
            return true;
        }
    }
    false
}

// Each config file read once, `None` for one that is not there.
#[derive(Default)]
struct ConfigFiles {
    read: HashMap<PathBuf, Option<toml::Table>>,
}

impl ConfigFiles {
    // The deny entries in force over `layers`, lowest precedence first.
    async fn resolve_denies(
        &mut self,
        layers: &[PathBuf],
    ) -> Result<Vec<DenyEntry>, CodexRulesError> {
        for path in layers {
            if !self.read.contains_key(path) {
                let table = read_codex_config_file(path)
                    .await
                    .map_err(CodexRulesError::UnreadableConfig)?;
                self.read.insert(path.clone(), table);
            }
        }
        let read_layers: Vec<(&Path, &toml::Table)> = layers
            .iter()
            .filter_map(|path| {
                let table = self.read.get(path)?.as_ref()?;
                Some((path.as_path(), table))
            })
            .collect();
        resolve_layer_denies(&read_layers)
    }
}

// The deny entries of the profile `layers` select, each named by the highest layer that wrote it
// into the profile of the chain that supplies it.
fn resolve_layer_denies(
    layers: &[(&Path, &toml::Table)],
) -> Result<Vec<DenyEntry>, CodexRulesError> {
    // Codex walks the layers lowest first, and the last layer naming either key picks the syntax,
    // `true` for the profiles; a layer naming both picks the profiles.
    let mut selects_profiles = None;
    for (_, table) in layers {
        if table.contains_key(SANDBOX_MODE_KEY) {
            selects_profiles = Some(false);
        }
        if table.contains_key(DEFAULT_PERMISSIONS_KEY) {
            selects_profiles = Some(true);
        }
    }
    let mut merged = toml::Value::Table(toml::Table::new());
    for (_, table) in layers {
        merge_toml(&mut merged, &toml::Value::Table((*table).clone()));
    }
    let profiles = merged.get(PERMISSIONS_KEY).and_then(toml::Value::as_table);
    match selects_profiles {
        Some(true) => {}
        // Codex refuses profiles that no layer selects one of, as it does an unresolved one.
        None if profiles.is_some_and(|profiles| !profiles.is_empty()) => {
            return Err(CodexRulesError::ProfileUnselected);
        }
        Some(false) | None => return Ok(Vec::new()),
    }
    let Some(selected) = merged
        .get(DEFAULT_PERMISSIONS_KEY)
        .and_then(toml::Value::as_str)
    else {
        return Ok(Vec::new());
    };
    if selected.starts_with(BUILT_IN_PROFILE_MARK) {
        return Ok(Vec::new());
    }
    let chain = resolve_profile_chain(selected, profiles)?;
    // Parents are merged first, so a child's entry replaces its parent's.
    let mut filesystem = toml::Value::Table(toml::Table::new());
    for profile in chain.iter().rev() {
        if let Some(own) = profile_filesystem(profiles, profile) {
            merge_toml(&mut filesystem, own);
        }
    }
    let Some(filesystem) = filesystem.as_table() else {
        return Ok(Vec::new());
    };
    let mut denies = Vec::new();
    for (root, access) in filesystem {
        if access.as_str() == Some(DENY_ACCESS) {
            denies.push(deny_entry(layers, profiles, &chain, root.clone(), &[root]));
        } else if let Some(subpaths) = access.as_table() {
            for (subpath, access) in subpaths {
                if access.as_str() != Some(DENY_ACCESS) {
                    continue;
                }
                let pattern = if subpath == SCOPED_ROOT_SUBPATH {
                    root.clone()
                } else {
                    format!("{root}/{subpath}")
                };
                denies.push(deny_entry(
                    layers,
                    profiles,
                    &chain,
                    pattern,
                    &[root, subpath],
                ));
            }
        }
    }
    Ok(denies)
}

// The profiles from `selected` up through each one it `extends`, as Codex follows them; refused
// where one is not defined, a parent is one of Codex's built-in profiles, or the chain returns to
// a profile already in it.
fn resolve_profile_chain(
    selected: &str,
    profiles: Option<&toml::Table>,
) -> Result<Vec<String>, CodexRulesError> {
    let unresolved = |reason: String| CodexRulesError::UnresolvedProfile {
        profile: selected.to_owned(),
        reason,
    };
    let mut chain: Vec<String> = Vec::new();
    let mut next = selected.to_owned();
    loop {
        if chain.contains(&next) {
            return Err(unresolved(format!(
                "its profiles extend in a circle through {next}"
            )));
        }
        let Some(profile) = profiles.and_then(|profiles| profiles.get(&next)) else {
            return Err(unresolved(match chain.last() {
                None => "it is not defined".to_owned(),
                Some(child) if next.starts_with(BUILT_IN_PROFILE_MARK) => {
                    format!("{child} extends the built-in profile {next}")
                }
                Some(child) => format!("{child} extends {next}, which is not defined"),
            }));
        };
        let parent = profile
            .get(EXTENDS_KEY)
            .and_then(toml::Value::as_str)
            .map(str::to_owned);
        chain.push(next);
        match parent {
            Some(parent) => next = parent,
            None => return Ok(chain),
        }
    }
}

// The deny entry `pattern` at `keys` of the merged filesystem table, named by the layer that set
// it: the child-most profile of `chain` whose merged entries hold a value there supplies it, and
// the highest layer writing a value there in that profile set it.
fn deny_entry(
    layers: &[(&Path, &toml::Table)],
    profiles: Option<&toml::Table>,
    chain: &[String],
    pattern: String,
    keys: &[&String],
) -> DenyEntry {
    let supplier = chain
        .iter()
        .find(|profile| {
            profile_filesystem(profiles, profile).is_some_and(|own| holds_value_at(own, keys))
        })
        .expect("a merged entry comes from a profile of the chain");
    let (source, _) = layers
        .iter()
        .rev()
        .find(|(_, table)| {
            table
                .get(PERMISSIONS_KEY)
                .and_then(|permissions| permissions.get(supplier.as_str()))
                .and_then(|profile| profile.get(FILESYSTEM_KEY))
                .is_some_and(|own| holds_value_at(own, keys))
        })
        .expect("a merged entry comes from a layer");
    DenyEntry {
        pattern,
        source: source.to_path_buf(),
    }
}

fn profile_filesystem<'a>(
    profiles: Option<&'a toml::Table>,
    profile: &str,
) -> Option<&'a toml::Value> {
    profiles?.get(profile)?.get(FILESYSTEM_KEY)
}

// Whether `table` holds a value that is not a table at the path `keys`.
fn holds_value_at(table: &toml::Value, keys: &[&String]) -> bool {
    keys.iter()
        .try_fold(table, |value, key| value.get(key.as_str()))
        .is_some_and(|value| !value.is_table())
}

// Codex's merge of one config layer over the layers below it: tables merge key by key, and any
// other value replaces what was there.
fn merge_toml(base: &mut toml::Value, overlay: &toml::Value) {
    if let (toml::Value::Table(base_table), toml::Value::Table(overlay_table)) =
        (&mut *base, overlay)
    {
        for (key, value) in overlay_table {
            if let Some(existing) = base_table.get_mut(key) {
                merge_toml(existing, value);
            } else {
                base_table.insert(key.clone(), value.clone());
            }
        }
    } else {
        *base = overlay.clone();
    }
}

#[cfg(test)]
mod tests;
