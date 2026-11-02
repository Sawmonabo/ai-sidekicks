//! The standing rules Claude Code holds on this machine, read from its own settings files: the
//! managed settings, each account home's settings file and each attached project's shared and
//! local ones. A rule is revoked by removing its one entry from the file it sits in, every other
//! byte kept; a managed rule is never revoked. A file that is absent holds nothing; one that is not
//! a strict JSON object of the shape Claude Code reads is refused.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the settings page's standing rule list and its revoke call these through the \
                  driver"
    )
)]

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::settings::{
    PROVIDER_RULE_DECISION_MAX_LEN, PROVIDER_RULE_TEXT_MAX_LEN, ProviderStandingRule,
    ProviderStandingRuleId, ProviderStandingRuleRevokeOutcome, ProviderStandingRuleScope,
};
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::wire::text::FreeFormText;

use super::{
    CLAUDE_SHARED_SETTINGS_FILE, ClaudeRulesError, local_settings_path, refused,
    remove_list_entries, settings_path,
};
use crate::driver::claude::mcp::config::ClaudePersonConfigFiles;
use crate::driver::claude::session::ignored_settings::{
    list_managed_settings_files, refuse_unread_settings,
};
use crate::driver::claude::session::settings_file::{
    ClaudeSettingsFileError, read_claude_settings_json,
};
use crate::standing_rule_id::mint_standing_rule_id;

// The `permissions` lists a standing rule sits in, each named as Claude Code names its decision.
const STANDING_RULE_LISTS: [&str; 3] = ["allow", "deny", "ask"];

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
    /// The folder of Claude Code's managed settings, which rank above every other file and hold
    /// for every account and project; `None` where the system names none.
    pub(crate) managed_settings_folder: Option<&'a Path>,
    /// The account homes.
    pub(crate) account_homes: &'a [ClaudeRuleAccountHome<'a>],
    /// The person's own home, read only for its protected paths.
    pub(crate) person: ClaudeRuleHome<'a>,
    /// The attached projects.
    pub(crate) projects: &'a [ClaudeRuleProject<'a>],
    /// The place the files are in; absent on a computer without a WSL 2 distribution.
    pub(crate) place: Option<&'a Place>,
}

/// Every entry of `permissions.allow`, `deny` and `ask` in the managed settings, under no scope,
/// each account home's settings file and each project's shared and local ones, one row per entry,
/// its decision the list's name. Fails as a file or the managed drop-in folder cannot be read, a
/// file is not a strict JSON object of Claude Code's shape, or an entry does not fit the list.
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
/// Fails as the listing fails, with `RuleInUneditedFile` for a rule of the managed settings, which
/// the daemon never edits, or as the file cannot be edited or written.
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
    if listed.rule.scope.is_none() {
        return Err(ClaudeRulesError::RuleInUneditedFile { path: listed.file });
    }
    let revoked = listed.rule.text.as_str();
    if remove_list_entries(&listed.file, listed.list, |entry| entry == revoked).await? {
        Ok(ProviderStandingRuleRevokeOutcome::Revoked)
    } else {
        Ok(ProviderStandingRuleRevokeOutcome::AlreadyAbsent)
    }
}

// One listed rule with where its revoke edits it: the file it sits in and its list.
struct ListedRule {
    rule: ProviderStandingRule,
    file: PathBuf,
    list: &'static str,
}

// One settings file a standing rule can sit in, with its scope, none for a managed file.
struct RuleFile {
    scope: Option<ProviderStandingRuleScope>,
    file: PathBuf,
}

// Every rule of every rule file, each once.
async fn list_rules(
    sources: &ClaudeRuleListingSources<'_>,
) -> Result<Vec<ListedRule>, ClaudeRulesError> {
    let mut listed = Vec::new();
    let mut listed_ids = HashSet::new();
    for rule_file in rule_files(sources).await? {
        let Some(settings) = read_strict_settings(&rule_file.file).await? else {
            continue;
        };
        let source_path = filesystem_path(&rule_file.file)?;
        for list in STANDING_RULE_LISTS {
            for text in read_string_list(&settings, &["permissions"], list, &rule_file.file)? {
                let rule_id = mint_standing_rule_id(
                    sources.place,
                    &source_path,
                    rule_file.scope.as_ref(),
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
                        place: sources.place.cloned(),
                        source_path: source_path.clone(),
                        decision: FreeFormText::<PROVIDER_RULE_DECISION_MAX_LEN>::new(
                            list.to_owned(),
                        )
                        .expect("each list name is a short word"),
                        text: rule_text(text, &rule_file.file)?,
                    },
                    file: rule_file.file.clone(),
                    list,
                });
            }
        }
    }
    Ok(listed)
}

// The managed settings files, then each account home's settings file, then each project's shared
// and local ones. Fails where the managed drop-in folder cannot be listed.
async fn rule_files(
    sources: &ClaudeRuleListingSources<'_>,
) -> Result<Vec<RuleFile>, ClaudeRulesError> {
    let mut files: Vec<RuleFile> = read_managed_settings_files(sources)
        .await?
        .into_iter()
        .map(|file| RuleFile { scope: None, file })
        .collect();
    for account_home in sources.account_homes {
        files.push(RuleFile {
            scope: Some(ProviderStandingRuleScope::AccountHome {
                account_id: account_home.account_id.clone(),
            }),
            file: resolve_home_settings(&account_home.home).await,
        });
    }
    for project in sources.projects {
        for file in project_settings_files(project.folder) {
            files.push(RuleFile {
                scope: Some(ProviderStandingRuleScope::Project {
                    repo_mount_id: project.repo_mount_id,
                }),
                file,
            });
        }
    }
    Ok(files)
}

/// The managed settings files in the order Claude Code applies them, none where the system names
/// no managed folder. Fails with `Read` where the drop-in folder cannot be listed.
pub(super) async fn read_managed_settings_files(
    sources: &ClaudeRuleListingSources<'_>,
) -> Result<Vec<PathBuf>, ClaudeRulesError> {
    let Some(folder) = sources.managed_settings_folder else {
        return Ok(Vec::new());
    };
    let mut failures = Vec::new();
    let files = list_managed_settings_files(folder, &mut failures).await;
    refuse_unread_settings(failures)?;
    Ok(files)
}

/// The settings file Claude Code reads for a home, under `CLAUDE_CONFIG_DIR` where it is set.
pub(super) async fn resolve_home_settings(home: &ClaudeRuleHome<'_>) -> PathBuf {
    ClaudePersonConfigFiles::resolve(home.environment, home.home)
        .await
        .user_settings
}

/// A project's shared and local settings files.
pub(super) fn project_settings_files(folder: &Path) -> [PathBuf; 2] {
    [
        settings_path(folder, CLAUDE_SHARED_SETTINGS_FILE),
        local_settings_path(folder),
    ]
}

/// The settings object of `file`, `None` where the daemon cannot read it, as Claude Code cannot.
/// Refuses a file that is not strict JSON or whose root is not an object.
pub(super) async fn read_strict_settings(
    file: &Path,
) -> Result<Option<Map<String, Value>>, ClaudeSettingsFileError> {
    let read =
        read_claude_settings_json(file)
            .await
            .map_err(|failure| ClaudeSettingsFileError::Read {
                path: file.to_path_buf(),
                failure,
            })?;
    let Some(parsed) = read else {
        return Ok(None);
    };
    let Ok(Value::Object(settings)) = parsed else {
        return Err(refused(file));
    };
    Ok(Some(settings))
}

/// The string entries of `list` in the object `objects` lead to in `settings`, none where a key is
/// missing; refuses a member on the way that is not an object, or a list that is not an array.
pub(super) fn read_string_list<'settings>(
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

/// A rule's text or pattern as the wire carries it; fails with `Unlistable`, keeping the bound it
/// broke, for one it cannot carry.
pub(super) fn rule_text(
    text: &str,
    file: &Path,
) -> Result<FreeFormText<PROVIDER_RULE_TEXT_MAX_LEN>, ClaudeRulesError> {
    FreeFormText::new(text.to_owned()).map_err(|failure| ClaudeRulesError::Unlistable {
        path: file.to_path_buf(),
        failure,
    })
}

/// A settings file's path as the wire carries it; fails with `Unlistable` for one it cannot carry.
pub(super) fn filesystem_path(file: &Path) -> Result<FilesystemPath, ClaudeRulesError> {
    FilesystemPath::new(file.to_string_lossy().into_owned()).map_err(|failure| {
        ClaudeRulesError::Unlistable {
            path: file.to_path_buf(),
            failure,
        }
    })
}

#[cfg(test)]
pub(super) mod test_tree;
#[cfg(test)]
mod tests;
