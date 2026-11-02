//! The standing rules Codex holds on this machine, one row per rule call in each rule file Codex
//! reads, shown as the file writes it, and a rule taken back out of the file that holds it; and the
//! paths the permission profile each of Codex's config files selects denies. Codex reads its rules
//! when a conversation starts, so a revoke applies to conversations started after it.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the provider settings page's standing rules and protected paths, which the Codex \
                  driver serves"
    )
)]

use std::collections::HashMap;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::settings::{
    PROVIDER_RULE_DECISION_MAX_LEN, PROVIDER_RULE_TEXT_MAX_LEN, ProviderProtectedPath,
    ProviderStandingRule, ProviderStandingRuleId, ProviderStandingRuleRevokeOutcome,
    ProviderStandingRuleScope,
};
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::wire::text::{FreeFormText, is_ecmascript_whitespace};
use sidekicks_platforms::PathRules;
use sidekicks_std::file::atomic_write::write_file_atomically;

use super::{
    AfterFailure, CODEX_PROJECT_RULE_FILE_MODE, CODEX_PROJECT_SETTINGS_FOLDER, CodexRuleSources,
    CodexRulesError, RULE_FILE_LOCK, evaluate_rule_files, is_codex_home_project, read_if_present,
    read_rule_file_texts, resolve_lock_key, rule_lines,
};
use crate::driver::codex::config_read::CODEX_CONFIG_FILE_NAME;

// The config keys that select a permission profile, hold the profiles, and hold a profile's
// filesystem entries; the word a filesystem entry denies with; and the older sandbox key, which
// Codex follows over any profile where a config file sets it.
const DEFAULT_PERMISSIONS_KEY: &str = "default_permissions";
const PERMISSIONS_KEY: &str = "permissions";
const FILESYSTEM_KEY: &str = "filesystem";
const DENY_ACCESS: &str = "deny";
const SANDBOX_MODE_KEY: &str = "sandbox_mode";

// The subpath of a scoped filesystem entry that names its root itself.
const SCOPED_ROOT_SUBPATH: &str = ".";

/// One account home Codex runs the account's sessions on.
pub(crate) struct CodexRuleAccountHome {
    /// The account.
    pub(crate) account_id: ProviderAccountId,
    /// The account's Codex home, whose `rules/` and `config.toml` Codex reads.
    pub(crate) codex_home: PathBuf,
    /// The home folder the account's sessions run with, in which an example's `~` is read.
    pub(crate) home_folder: PathBuf,
}

/// One attached project and whether Codex trusts it, which the caller reads.
pub(crate) struct CodexRuleProject {
    /// The project.
    pub(crate) repo_mount_id: RepoMountId,
    /// The project's folder, whose `.codex/` Codex reads where it trusts the project.
    pub(crate) project_folder: PathBuf,
    /// Whether Codex trusts the project; it reads nothing of a project it does not trust.
    pub(crate) is_trusted: bool,
}

/// Where Codex keeps the standing rules and permission profiles of this machine's sessions, as the
/// caller lists them.
pub(crate) struct CodexRuleListingSources<'a> {
    /// The folder Codex keeps its system settings in, whose `rules/` Codex reads first.
    pub(crate) system_folder: &'a Path,
    /// Every account home.
    pub(crate) account_homes: &'a [CodexRuleAccountHome],
    /// The person's own Codex folder, whose `config.toml` is the person's global config.
    pub(crate) personal_codex_home: &'a Path,
    /// Every attached project.
    pub(crate) projects: &'a [CodexRuleProject],
    /// The place the files are in; absent on a computer without a WSL 2 distribution.
    pub(crate) place: Option<&'a Place>,
    /// How that place spells paths.
    pub(crate) path_rules: PathRules,
    /// How long one read may evaluate rule files, [`super::RULE_EVALUATION_TIME_LIMIT`] for the
    /// daemon's reads.
    pub(crate) evaluation_time_limit: Duration,
}

// A listed rule with its file, that file's text as read, and every place the text writes it.
struct ListedRule {
    rule: ProviderStandingRule,
    file: PathBuf,
    file_text: Arc<str>,
    spans: Vec<Range<usize>>,
}

/// Every rule call of every rule file Codex reads, one row per rule: for each account home the
/// system folder's and the home's `rules/*.rules`, and each trusted project's `.codex/rules/`, each
/// row with Codex's decision word and the call as its file writes it. A call a file writes twice
/// is one rule. Fails with `Unloadable` where Codex refuses a rule file, since Codex then drops
/// every rule file's rules, `Read` where one cannot be read and `Unlistable` where a call or a
/// path does not fit the list.
pub(crate) async fn list_codex_standing_rules(
    sources: &CodexRuleListingSources<'_>,
) -> Result<Vec<ProviderStandingRule>, CodexRulesError> {
    Ok(list_rules(sources)
        .await?
        .into_iter()
        .map(|listed| listed.rule)
        .collect())
}

/// Takes the rule `rule_id` names out of the rule file that holds it, every place the file writes
/// its call, one edit at a time on the file, and deletes the file once it holds nothing else;
/// `AlreadyAbsent` where no rule Codex reads has the id. Fails as [`list_codex_standing_rules`]
/// does, and with `Write` or `Delete` where the file cannot be changed.
pub(crate) async fn revoke_codex_standing_rule(
    sources: &CodexRuleListingSources<'_>,
    rule_id: &ProviderStandingRuleId,
) -> Result<ProviderStandingRuleRevokeOutcome, CodexRulesError> {
    let Some(found) = find_rule(sources, rule_id).await? else {
        return Ok(ProviderStandingRuleRevokeOutcome::AlreadyAbsent);
    };
    let _hold = RULE_FILE_LOCK
        .acquire(resolve_lock_key(&found.file).await?)
        .await;
    // Read again under the hold, so the places taken out are those of the file as it stands.
    let Some(listed) = find_rule(sources, rule_id).await? else {
        return Ok(ProviderStandingRuleRevokeOutcome::AlreadyAbsent);
    };
    let mut kept = listed.file_text.to_string();
    let mut spans = listed.spans;
    spans.sort_by_key(|span| std::cmp::Reverse(span.start));
    for span in spans {
        let extent = call_extent(&kept, span);
        kept.replace_range(extent, "");
    }
    if rule_lines(&kept).next().is_none() {
        tokio::fs::remove_file(&listed.file)
            .await
            .map_err(|failure| CodexRulesError::Delete {
                path: listed.file.clone(),
                failure,
            })?;
    } else {
        write_file_atomically(&listed.file, kept, CODEX_PROJECT_RULE_FILE_MODE)
            .await
            .map_err(CodexRulesError::Write)?;
    }
    Ok(ProviderStandingRuleRevokeOutcome::Revoked)
}

/// The paths the person's own permission profiles deny: in each account home's and the person's
/// own `config.toml`, and in each trusted project's `.codex/config.toml`, every `deny` entry of the
/// filesystem table of the profile that file's `default_permissions` names, a scoped entry's
/// subpath joined to its root. A file naming no profile, or setting `sandbox_mode`, which Codex
/// then follows instead, lists none. Fails with `UnreadableConfig` where a file is not TOML, `Read`
/// where one cannot be read and `Unlistable` where an entry or a path does not fit the list.
pub(crate) async fn read_codex_protected_paths(
    sources: &CodexRuleListingSources<'_>,
) -> Result<Vec<ProviderProtectedPath>, CodexRulesError> {
    let mut entries = Vec::new();
    let codex_homes = sources
        .account_homes
        .iter()
        .map(|home| home.codex_home.as_path())
        .chain(std::iter::once(sources.personal_codex_home));
    for codex_home in codex_homes {
        let path = codex_home.join(CODEX_CONFIG_FILE_NAME);
        let source_path = listable_path(&path)?;
        for pattern in read_profile_denies(&path).await? {
            entries.push(ProviderProtectedPath::Global {
                pattern,
                place: sources.place.cloned(),
                source_path: source_path.clone(),
            });
        }
    }
    for project in sources.projects.iter().filter(|project| project.is_trusted) {
        if is_any_codex_home(sources, &project.project_folder).await {
            continue;
        }
        let path = project
            .project_folder
            .join(CODEX_PROJECT_SETTINGS_FOLDER)
            .join(CODEX_CONFIG_FILE_NAME);
        let source_path = listable_path(&path)?;
        for pattern in read_profile_denies(&path).await? {
            entries.push(ProviderProtectedPath::Project {
                pattern,
                source_path: source_path.clone(),
                repo_mount_id: project.repo_mount_id,
            });
        }
    }
    Ok(entries)
}

// Every rule: for each account home its system and home files, then each trusted project's files
// as Codex reads them beside each home, a project's rule read beside two homes listed once.
async fn list_rules(
    sources: &CodexRuleListingSources<'_>,
) -> Result<Vec<ListedRule>, CodexRulesError> {
    let mut listing = RuleListing::default();
    for home in sources.account_homes {
        let scope = ProviderStandingRuleScope::AccountHome {
            account_id: home.account_id.clone(),
        };
        // No project is read here, so the working folder an example's relative program is read
        // in is the home folder.
        let home_sources = rule_sources(sources, home, &home.home_folder, false);
        listing
            .collect(&home_sources, &scope, false, sources.place)
            .await?;
    }
    for project in sources.projects.iter().filter(|project| project.is_trusted) {
        let scope = ProviderStandingRuleScope::Project {
            repo_mount_id: project.repo_mount_id,
        };
        for home in sources.account_homes {
            let project_sources = rule_sources(sources, home, &project.project_folder, true);
            listing
                .collect(&project_sources, &scope, true, sources.place)
                .await?;
        }
    }
    Ok(listing.rules)
}

async fn find_rule(
    sources: &CodexRuleListingSources<'_>,
    rule_id: &ProviderStandingRuleId,
) -> Result<Option<ListedRule>, CodexRulesError> {
    Ok(list_rules(sources)
        .await?
        .into_iter()
        .find(|listed| listed.rule.rule_id == *rule_id))
}

// The rules listed so far, each id once, with where each sits in the list.
#[derive(Default)]
struct RuleListing {
    rules: Vec<ListedRule>,
    positions: HashMap<ProviderStandingRuleId, usize>,
}

impl RuleListing {
    // Adds every rule call of the files `sources` reads, of the project's files where
    // `takes_project_files` holds and of the others where it does not, each under `scope`.
    async fn collect(
        &mut self,
        sources: &CodexRuleSources<'_>,
        scope: &ProviderStandingRuleScope,
        takes_project_files: bool,
        place: Option<&Place>,
    ) -> Result<(), CodexRulesError> {
        let files = read_rule_file_texts(sources).await?;
        for (file, evaluated) in evaluate_rule_files(files, sources, AfterFailure::Continue).await?
        {
            let evaluated = evaluated.map_err(|reason| CodexRulesError::Unloadable {
                path: file.path.clone(),
                reason,
            })?;
            if file.is_project != takes_project_files {
                continue;
            }
            let source_path = listable_path(&file.path)?;
            let file_text: Arc<str> = Arc::from(file.text);
            for call in evaluated.calls {
                let text = file_text
                    .get(call.span.clone())
                    .expect("a call's place lies in the text its file was parsed from");
                let rule_id = mint_rule_id(scope, place, &source_path, text);
                // The id holds the file, so a rule listed before is in this file: written twice
                // in it, or a project's file read again beside another home.
                if let Some(&position) = self.positions.get(&rule_id) {
                    let listed = &mut self.rules[position];
                    if !listed.spans.contains(&call.span) {
                        listed.spans.push(call.span);
                    }
                    continue;
                }
                let rule = ProviderStandingRule {
                    rule_id: rule_id.clone(),
                    scope: scope.clone(),
                    place: place.cloned(),
                    source_path: source_path.clone(),
                    decision: listable_text::<PROVIDER_RULE_DECISION_MAX_LEN>(
                        &file.path,
                        call.decision,
                    )?,
                    text: listable_text::<PROVIDER_RULE_TEXT_MAX_LEN>(&file.path, text.to_owned())?,
                };
                self.positions.insert(rule_id, self.rules.len());
                self.rules.push(ListedRule {
                    rule,
                    file: file.path.clone(),
                    file_text: Arc::clone(&file_text),
                    spans: vec![call.span],
                });
            }
        }
        Ok(())
    }
}

// Where Codex reads the rules of sessions on `home` working in `working_folder`, that folder's
// `.codex/rules/` read where `is_project_trusted`.
fn rule_sources<'a>(
    sources: &CodexRuleListingSources<'a>,
    home: &'a CodexRuleAccountHome,
    working_folder: &'a Path,
    is_project_trusted: bool,
) -> CodexRuleSources<'a> {
    CodexRuleSources {
        system_folder: sources.system_folder,
        codex_home: &home.codex_home,
        home_folder: &home.home_folder,
        project_folder: working_folder,
        is_project_trusted,
        path_rules: sources.path_rules,
        evaluation_time_limit: sources.evaluation_time_limit,
    }
}

// Whether the project's `.codex` folder is one of the Codex homes, whose config is listed as the
// home's and which Codex never reads as a project's.
async fn is_any_codex_home(sources: &CodexRuleListingSources<'_>, project_folder: &Path) -> bool {
    let codex_homes = sources
        .account_homes
        .iter()
        .map(|home| home.codex_home.as_path())
        .chain(std::iter::once(sources.personal_codex_home));
    for codex_home in codex_homes {
        if is_codex_home_project(project_folder, codex_home).await {
            return true;
        }
    }
    false
}

// The id of the rule `text` in `source_path` under `scope` in `place`: a hex digest of the four,
// each length-prefixed so no two different sets of parts give the same bytes.
fn mint_rule_id(
    scope: &ProviderStandingRuleScope,
    place: Option<&Place>,
    source_path: &FilesystemPath,
    text: &str,
) -> ProviderStandingRuleId {
    let (scope_kind, scope_id) = match scope {
        ProviderStandingRuleScope::AccountHome { account_id } => {
            ("accountHome", account_id.as_str().to_owned())
        }
        ProviderStandingRuleScope::Project { repo_mount_id } => {
            ("project", repo_mount_id.to_string())
        }
    };
    let (place_kind, place_name) = match place {
        None => ("", ""),
        Some(Place::Windows(_)) => ("windows", ""),
        Some(Place::Wsl(wsl)) => ("wsl", wsl.distro.as_str()),
    };
    let mut hasher = blake3::Hasher::new();
    for part in [
        scope_kind,
        scope_id.as_str(),
        place_kind,
        place_name,
        source_path.as_str(),
        text,
    ] {
        hasher.update(&(part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    ProviderStandingRuleId::new(hasher.finalize().to_hex().to_string())
        .expect("a 64-digit hex digest lies within the id's bounds")
}

// The bytes a call's removal takes out of `text`: its whole lines where nothing else is on them,
// else the call alone.
fn call_extent(text: &str, span: Range<usize>) -> Range<usize> {
    let line_start = text[..span.start].rfind('\n').map_or(0, |index| index + 1);
    let line_end = text[span.end..]
        .find('\n')
        .map_or(text.len(), |index| span.end + index + 1);
    let is_alone = text[line_start..span.start]
        .chars()
        .all(is_ecmascript_whitespace)
        && text[span.end..line_end]
            .chars()
            .all(is_ecmascript_whitespace);
    if is_alone { line_start..line_end } else { span }
}

// The deny entries of the profile the config file at `path` selects; none where the file is
// missing, names no profile or sets the older sandbox key.
async fn read_profile_denies(
    path: &Path,
) -> Result<Vec<FreeFormText<PROVIDER_RULE_TEXT_MAX_LEN>>, CodexRulesError> {
    let Some(text) = read_if_present(path).await? else {
        return Ok(Vec::new());
    };
    let config: toml::Table =
        toml::from_str(&text).map_err(|failure| CodexRulesError::UnreadableConfig {
            path: path.to_path_buf(),
            failure,
        })?;
    if config.contains_key(SANDBOX_MODE_KEY) {
        return Ok(Vec::new());
    }
    let filesystem = config
        .get(DEFAULT_PERMISSIONS_KEY)
        .and_then(toml::Value::as_str)
        .and_then(|profile| {
            config
                .get(PERMISSIONS_KEY)?
                .get(profile)?
                .get(FILESYSTEM_KEY)
        })
        .and_then(toml::Value::as_table);
    let Some(filesystem) = filesystem else {
        return Ok(Vec::new());
    };
    let mut patterns = Vec::new();
    for (root, access) in filesystem {
        if access.as_str() == Some(DENY_ACCESS) {
            patterns.push(root.clone());
        } else if let Some(subpaths) = access.as_table() {
            for (subpath, access) in subpaths {
                if access.as_str() != Some(DENY_ACCESS) {
                    continue;
                }
                patterns.push(if subpath == SCOPED_ROOT_SUBPATH {
                    root.clone()
                } else {
                    format!("{root}/{subpath}")
                });
            }
        }
    }
    patterns
        .into_iter()
        .map(|pattern| listable_text(path, pattern))
        .collect()
}

fn listable_path(path: &Path) -> Result<FilesystemPath, CodexRulesError> {
    FilesystemPath::new(path.to_string_lossy().into_owned()).map_err(|failure| {
        CodexRulesError::Unlistable {
            path: path.to_path_buf(),
            failure,
        }
    })
}

fn listable_text<const MAX: usize>(
    path: &Path,
    text: String,
) -> Result<FreeFormText<MAX>, CodexRulesError> {
    FreeFormText::new(text).map_err(|failure| CodexRulesError::Unlistable {
        path: path.to_path_buf(),
        failure,
    })
}

#[cfg(test)]
mod tests;
