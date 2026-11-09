//! The paths Claude Code's own deny rules refuse on this machine, read from its settings files:
//! the managed settings and each account home's and the person's own settings file as global
//! entries, and each attached project's shared and local ones under the project.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the settings page's protected paths call this through the driver"
    )
)]

use std::path::Path;

use serde_json::{Map, Value};
use sidekicks_contracts::provider::settings::PROVIDER_RULE_TEXT_MAX_LEN;
use sidekicks_contracts::provider::settings::rules::ProviderProtectedPath;
use sidekicks_contracts::wire::text::FreeFormText;

use super::ClaudeRulesError;
use super::listing::{
    ClaudeRuleListingSources, filesystem_path, project_settings_files, read_managed_settings_files,
    read_strict_settings, read_string_list, resolve_home_settings, rule_text,
};

/// The tools whose rules Claude Code checks a path against; every other tool's rule names no path.
pub(super) const PATH_RULE_TOOLS: [&str; 2] = ["Read", "Edit"];

// The sandbox's own lists of paths its commands may not read or write, under `sandbox.filesystem`.
const SANDBOX_FILESYSTEM: [&str; 2] = ["sandbox", "filesystem"];
const SANDBOX_DENY_LISTS: [&str; 2] = ["denyRead", "denyWrite"];

/// The paths Claude Code's own deny rules refuse: the pattern of every `Read(…)` and `Edit(…)`
/// entry of `permissions.deny` and every `sandbox.filesystem.denyRead` and `denyWrite` entry, in
/// the managed settings and each account home's and the person's own settings file (global) and
/// each project's shared and local ones. Fails as a file or the managed drop-in folder cannot be
/// read, a file is not a strict JSON object of Claude Code's shape, or an entry does not fit the
/// list.
pub(crate) async fn read_claude_protected_paths(
    sources: &ClaudeRuleListingSources<'_>,
) -> Result<Vec<ProviderProtectedPath>, ClaudeRulesError> {
    let mut global_files = read_managed_settings_files(sources).await?;
    for home in sources
        .account_homes
        .iter()
        .map(|account_home| &account_home.home)
        .chain([&sources.person])
    {
        let file = resolve_home_settings(home).await;
        if !global_files.contains(&file) {
            global_files.push(file);
        }
    }
    let mut entries = Vec::new();
    for file in global_files {
        let Some(settings) = read_strict_settings(&file).await? else {
            continue;
        };
        let source_path = filesystem_path(&file)?;
        for pattern in read_denied_patterns(&settings, &file)? {
            entries.push(ProviderProtectedPath::Global {
                pattern,
                place: sources.place.cloned(),
                source_path: source_path.clone(),
            });
        }
    }
    for project in sources.projects {
        for file in project_settings_files(project.folder) {
            let Some(settings) = read_strict_settings(&file).await? else {
                continue;
            };
            let source_path = filesystem_path(&file)?;
            for pattern in read_denied_patterns(&settings, &file)? {
                entries.push(ProviderProtectedPath::Project {
                    pattern,
                    source_path: source_path.clone(),
                    repo_mount_id: project.repo_mount_id,
                });
            }
        }
    }
    Ok(entries)
}

// The path patterns one settings object denies: each `Read(…)` and `Edit(…)` deny rule's, then
// the sandbox's.
fn read_denied_patterns(
    settings: &Map<String, Value>,
    file: &Path,
) -> Result<Vec<FreeFormText<PROVIDER_RULE_TEXT_MAX_LEN>>, ClaudeRulesError> {
    let deny_rules = read_string_list(settings, &["permissions"], "deny", file)?;
    let rule_patterns = deny_rules.into_iter().filter_map(|entry| {
        PATH_RULE_TOOLS.iter().find_map(|tool| {
            entry
                .strip_prefix(tool)?
                .strip_prefix('(')?
                .strip_suffix(')')
        })
    });
    let mut patterns = rule_patterns.collect::<Vec<_>>();
    for list in SANDBOX_DENY_LISTS {
        patterns.extend(read_string_list(settings, &SANDBOX_FILESYSTEM, list, file)?);
    }
    patterns
        .into_iter()
        .map(|pattern| rule_text(pattern, file))
        .collect()
}

#[cfg(test)]
mod tests;
