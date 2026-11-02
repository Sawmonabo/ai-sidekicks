//! The standing rules and protected paths Claude Code holds on this machine, read from its own
//! settings files: each account home's settings file and each attached project's shared and local
//! ones, and for protected paths the person's own settings file too. A rule is revoked by removing
//! its one entry from the file it sits in, every other byte kept. A file that is absent holds
//! nothing; one that is not a strict JSON object of the shape Claude Code reads is refused.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the settings page's standing rule list, its revoke and its protected paths call \
                  these through the driver"
    )
)]

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::settings::{
    PROVIDER_RULE_DECISION_MAX_LEN, PROVIDER_RULE_TEXT_MAX_LEN, ProviderProtectedPath,
    ProviderStandingRule, ProviderStandingRuleId, ProviderStandingRuleRevokeOutcome,
    ProviderStandingRuleScope,
};
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::wire::text::FreeFormText;

use super::{
    CLAUDE_LOCAL_SETTINGS_MODE, CLAUDE_SHARED_SETTINGS_FILE, ClaudeRulesError,
    edit_permission_lists, local_settings_path, refused, remove_entries, settings_path,
};
use crate::driver::claude::mcp::config::ClaudePersonConfigFiles;
use crate::driver::claude::session::settings_file::{
    ClaudeSettingsFileError, hold_settings_file, is_unreadable_path, read_settings_file,
    write_settings_file,
};
use crate::driver::claude::spawn::account_home::CLAUDE_HOME_SETTINGS_MODE;
use crate::inbound_json::decode_inbound_json;
use crate::standing_rule_id::mint_standing_rule_id;

// The `permissions` lists a standing rule sits in, each named as Claude Code names its decision.
const STANDING_RULE_LISTS: [&str; 3] = ["allow", "deny", "ask"];

// The deny rules Claude Code checks a path against; every other tool's rule names no path.
const PATH_RULE_TOOLS: [&str; 2] = ["Read", "Edit"];

// The sandbox's own lists of paths its commands may not read or write, under `sandbox.filesystem`.
const SANDBOX_FILESYSTEM: [&str; 2] = ["sandbox", "filesystem"];
const SANDBOX_DENY_LISTS: [&str; 2] = ["denyRead", "denyWrite"];

/// A Claude Code home the rules are read from: its folder and the environment a Claude Code
/// process there starts in, whose `CLAUDE_CONFIG_DIR` can move its settings file.
pub(crate) struct ClaudeRuleHome<'a> {
    /// The home folder.
    pub(crate) home: &'a Path,
    /// The environment Claude Code starts in there.
    pub(crate) environment: &'a [(String, String)],
}

/// One account home the app manages, as the account's rules are scoped.
pub(crate) struct ClaudeRuleAccountHome<'a> {
    /// The account.
    pub(crate) account_id: ProviderAccountId,
    /// Its home.
    pub(crate) home: ClaudeRuleHome<'a>,
}

/// One attached project and the folder its settings files are read at.
pub(crate) struct ClaudeRuleProject<'a> {
    /// The project.
    pub(crate) repo_mount_id: RepoMountId,
    /// The project's folder, which holds its `.claude` folder.
    pub(crate) folder: &'a Path,
}

/// Where Claude Code's standing rules and protected paths are read, all in one place; the caller
/// supplies every list.
pub(crate) struct ClaudeRuleListingSources<'a> {
    /// The account homes.
    pub(crate) account_homes: &'a [ClaudeRuleAccountHome<'a>],
    /// The person's own home, read only for its protected paths.
    pub(crate) person: ClaudeRuleHome<'a>,
    /// The attached projects.
    pub(crate) projects: &'a [ClaudeRuleProject<'a>],
    /// The place the files are in; `None` on a computer without a WSL 2 distribution.
    pub(crate) place: Option<Place>,
}

/// Every entry of `permissions.allow`, `deny` and `ask` in each account home's settings file and
/// each project's shared and local ones, one row per entry, its decision the list's name. Fails as
/// a file cannot be read, is not a strict JSON object of Claude Code's shape, or holds an entry
/// the wire cannot carry.
pub(crate) async fn list_claude_standing_rules(
    sources: &ClaudeRuleListingSources<'_>,
) -> Result<Vec<ProviderStandingRule>, ClaudeRulesError> {
    Ok(list_rules(sources)
        .await?
        .into_iter()
        .map(|listed| listed.rule)
        .collect())
}

/// Removes the one rule `rule_id` names from its list in the file it sits in, every other entry
/// and key kept; `AlreadyAbsent` when no listed rule has the id or the file no longer holds it.
/// Fails as the listing fails, or as the file cannot be edited or written.
pub(crate) async fn revoke_claude_standing_rule(
    sources: &ClaudeRuleListingSources<'_>,
    rule_id: &ProviderStandingRuleId,
) -> Result<ProviderStandingRuleRevokeOutcome, ClaudeRulesError> {
    let Some(listed) = list_rules(sources)
        .await?
        .into_iter()
        .find(|listed| &listed.rule.rule_id == rule_id)
    else {
        return Ok(ProviderStandingRuleRevokeOutcome::AlreadyAbsent);
    };
    let file = listed.file.as_path();
    let hold = hold_settings_file(file).await?;
    let Some(text) = read_settings_file(&hold, file).await? else {
        return Ok(ProviderStandingRuleRevokeOutcome::AlreadyAbsent);
    };
    let revoked = listed.rule.text.as_str();
    let Some(edited) = edit_permission_lists(file, &text, |permissions, path| {
        remove_entries(permissions, listed.list, path, |entry| entry == revoked)
    })?
    else {
        return Ok(ProviderStandingRuleRevokeOutcome::AlreadyAbsent);
    };
    write_settings_file(&hold, file, edited, listed.mode).await?;
    Ok(ProviderStandingRuleRevokeOutcome::Revoked)
}

/// The paths Claude Code's own deny rules refuse: the pattern of every `Read(…)` and `Edit(…)`
/// entry of `permissions.deny` and every `sandbox.filesystem.denyRead` and `denyWrite` entry, in
/// each account home's and the person's own settings file (global) and each project's shared and
/// local ones. Fails as [`list_claude_standing_rules`] does.
pub(crate) async fn read_claude_protected_paths(
    sources: &ClaudeRuleListingSources<'_>,
) -> Result<Vec<ProviderProtectedPath>, ClaudeRulesError> {
    let mut global_files = Vec::new();
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
                place: sources.place.clone(),
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

// One listed rule with where its revoke edits it: the file as read, its list, and the mode the
// rewritten file keeps.
struct ListedRule {
    rule: ProviderStandingRule,
    file: PathBuf,
    list: &'static str,
    mode: u32,
}

// One settings file a standing rule can sit in, with its scope and the mode a rewrite gives it.
struct RuleFile {
    scope: ProviderStandingRuleScope,
    file: PathBuf,
    mode: u32,
}

// Every rule of every rule file, each once.
async fn list_rules(
    sources: &ClaudeRuleListingSources<'_>,
) -> Result<Vec<ListedRule>, ClaudeRulesError> {
    let mut listed = Vec::new();
    let mut listed_ids = HashSet::new();
    for rule_file in rule_files(sources).await {
        let Some(settings) = read_strict_settings(&rule_file.file).await? else {
            continue;
        };
        let source_path = filesystem_path(&rule_file.file)?;
        for list in STANDING_RULE_LISTS {
            for text in read_string_list(&settings, &["permissions"], list, &rule_file.file)? {
                let rule_id = mint_standing_rule_id(
                    sources.place.as_ref(),
                    &source_path,
                    Some(&rule_file.scope),
                    list,
                    text,
                );
                if !listed_ids.insert(rule_id.clone()) {
                    continue;
                }
                listed.push(ListedRule {
                    rule: ProviderStandingRule {
                        rule_id,
                        scope: rule_file.scope.clone(),
                        place: sources.place.clone(),
                        source_path: source_path.clone(),
                        decision: FreeFormText::<PROVIDER_RULE_DECISION_MAX_LEN>::new(
                            list.to_owned(),
                        )
                        .expect("each list name is a short word"),
                        text: rule_text(text, &rule_file.file)?,
                    },
                    file: rule_file.file.clone(),
                    list,
                    mode: rule_file.mode,
                });
            }
        }
    }
    Ok(listed)
}

// Each account home's settings file, then each project's shared and local ones.
async fn rule_files(sources: &ClaudeRuleListingSources<'_>) -> Vec<RuleFile> {
    let mut files = Vec::new();
    for account_home in sources.account_homes {
        files.push(RuleFile {
            scope: ProviderStandingRuleScope::AccountHome {
                account_id: account_home.account_id.clone(),
            },
            file: resolve_home_settings(&account_home.home).await,
            mode: CLAUDE_HOME_SETTINGS_MODE,
        });
    }
    for project in sources.projects {
        for file in project_settings_files(project.folder) {
            files.push(RuleFile {
                scope: ProviderStandingRuleScope::Project {
                    repo_mount_id: project.repo_mount_id,
                },
                file,
                mode: CLAUDE_LOCAL_SETTINGS_MODE,
            });
        }
    }
    files
}

// The settings file Claude Code reads for a home, under `CLAUDE_CONFIG_DIR` where it is set.
async fn resolve_home_settings(home: &ClaudeRuleHome<'_>) -> PathBuf {
    ClaudePersonConfigFiles::resolve(home.environment, home.home)
        .await
        .user_settings
}

// A project's shared and local settings files.
fn project_settings_files(folder: &Path) -> [PathBuf; 2] {
    [
        settings_path(folder, CLAUDE_SHARED_SETTINGS_FILE),
        local_settings_path(folder),
    ]
}

// The settings object of `file`, `None` where the daemon cannot read it, as Claude Code cannot.
// Refuses a file that is not strict JSON or whose root is not an object.
async fn read_strict_settings(
    file: &Path,
) -> Result<Option<Map<String, Value>>, ClaudeSettingsFileError> {
    let bytes = match tokio::fs::read(file).await {
        Ok(bytes) => bytes,
        Err(failure) if is_unreadable_path(&failure) => return Ok(None),
        Err(failure) => {
            return Err(ClaudeSettingsFileError::Read {
                path: file.to_path_buf(),
                failure,
            });
        }
    };
    let Ok(Value::Object(settings)) = serde_json::from_str::<Value>(&decode_inbound_json(&bytes))
    else {
        return Err(refused(file));
    };
    Ok(Some(settings))
}

// The string entries of `list` in the object `objects` lead to in `settings`, none where a key is
// missing; refuses a member on the way that is not an object, or a list that is not an array.
fn read_string_list<'settings>(
    settings: &'settings Map<String, Value>,
    objects: &[&str],
    list: &str,
    file: &Path,
) -> Result<Vec<&'settings str>, ClaudeSettingsFileError> {
    let mut object = settings;
    for key in objects {
        match object.get(*key) {
            Some(Value::Object(member)) => object = member,
            Some(_) => return Err(refused(file)),
            None => return Ok(Vec::new()),
        }
    }
    match object.get(list) {
        Some(Value::Array(entries)) => Ok(entries.iter().filter_map(Value::as_str).collect()),
        Some(_) => Err(refused(file)),
        None => Ok(Vec::new()),
    }
}

// The path patterns one settings object denies: each `Read(…)` and `Edit(…)` deny rule's, then
// the sandbox's.
fn read_denied_patterns(
    settings: &Map<String, Value>,
    file: &Path,
) -> Result<Vec<FreeFormText<PROVIDER_RULE_TEXT_MAX_LEN>>, ClaudeSettingsFileError> {
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

// A rule's text or pattern as the wire carries it; refuses the file for one it cannot carry.
fn rule_text(
    text: &str,
    file: &Path,
) -> Result<FreeFormText<PROVIDER_RULE_TEXT_MAX_LEN>, ClaudeSettingsFileError> {
    FreeFormText::new(text.to_owned()).map_err(|_text_error| refused(file))
}

// A settings file's path as the wire carries it.
fn filesystem_path(file: &Path) -> Result<FilesystemPath, ClaudeSettingsFileError> {
    FilesystemPath::new(file.to_string_lossy().into_owned()).map_err(|_text_error| refused(file))
}

#[cfg(test)]
mod tests;
