//! The standing rules Codex holds on this machine, one row per rule call in each rule file Codex
//! reads, shown as the file writes it, and a rule taken back out of the file that holds it. Codex
//! reads its rules when a conversation starts, so a revoke applies to conversations started after
//! it.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the provider settings page's standing rules, which the Codex driver serves"
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
use sidekicks_contracts::provider::settings::rules::{
    ProviderStandingRule, ProviderStandingRuleId, ProviderStandingRuleRevokeOutcome,
    ProviderStandingRuleScope,
};
use sidekicks_contracts::provider::settings::{
    PROVIDER_RULE_DECISION_MAX_LEN, PROVIDER_RULE_TEXT_MAX_LEN,
};
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::PathRules;

use super::removal::{RuleFileEdit, remove_rule_calls};
use super::{
    CodexRuleSources, CodexRulesError, RULE_FILE_LOCK, RuleFileOrigin, evaluate_rule_files,
    read_if_present, read_rule_file_texts, resolve_lock_key,
};
use crate::standing_rule_id::mint_standing_rule_id;

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
    /// The folder Codex keeps its system settings in, whose `rules/` Codex reads first and whose
    /// `config.toml` is the lowest of Codex's config layers.
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

// A listed rule with its file, the folder that file is in, that file's text as read, every place
// the text writes it, and the read it was first listed in.
struct ListedRule {
    rule: ProviderStandingRule,
    file: PathBuf,
    origin: RuleFileOrigin,
    file_text: Arc<str>,
    spans: Vec<Range<usize>>,
    reading: RuleReading,
}

// One read of the rule files Codex loads together: one account home's, with one trusted project's
// where `project_index` names one.
#[derive(Clone, Copy)]
struct RuleReading {
    home_index: usize,
    project_index: Option<usize>,
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
/// `AlreadyAbsent` where no rule Codex reads has the id. The edited text is evaluated beside the
/// files Codex reads with it before it is written. Fails as [`list_codex_standing_rules`] does,
/// with `RuleInUneditedFile` for a rule of the system folder, which Codex reads for every home and
/// the daemon never edits, with `RevokeRefused`, the file untouched, where the edited file would
/// not load or would still make the rule, and with `Write` or `Delete` where the file cannot be
/// changed.
pub(crate) async fn revoke_codex_standing_rule(
    sources: &CodexRuleListingSources<'_>,
    rule_id: &ProviderStandingRuleId,
) -> Result<ProviderStandingRuleRevokeOutcome, CodexRulesError> {
    let Some(found) = find_rule(sources, rule_id).await? else {
        return Ok(ProviderStandingRuleRevokeOutcome::AlreadyAbsent);
    };
    if found.origin == RuleFileOrigin::System {
        return Err(CodexRulesError::RuleInUneditedFile { path: found.file });
    }
    let _hold = RULE_FILE_LOCK
        .acquire(resolve_lock_key(&found.file).await?)
        .await;
    // Only the one file is read again under the hold; the rules are listed again only where it
    // changed since the listing, so the places taken out are those of the file as it stands.
    let current = read_if_present(&found.file).await?;
    let listed = if current.as_deref() == Some(&*found.file_text) {
        found
    } else {
        match find_rule(sources, rule_id).await? {
            Some(listed) => listed,
            None => return Ok(ProviderStandingRuleRevokeOutcome::AlreadyAbsent),
        }
    };
    let revoked = listed.rule.text.as_str();
    let edit = RuleFileEdit {
        path: listed.file.clone(),
        text: listed.file_text.to_string(),
        spans: listed.spans.clone(),
    };
    remove_rule_calls(
        &reading_sources(sources, listed.reading),
        vec![edit],
        |evaluated, text| {
            evaluated
                .calls
                .iter()
                .any(|call| text.get(call.span.clone()) == Some(revoked))
        },
    )
    .await?;
    Ok(ProviderStandingRuleRevokeOutcome::Revoked)
}

// Every rule: for each account home its system files under no scope, each system rule once, and
// its own files under the home, then each trusted project's files as Codex reads them beside each
// home, a project's rule read beside two homes listed once.
async fn list_rules(
    sources: &CodexRuleListingSources<'_>,
) -> Result<Vec<ListedRule>, CodexRulesError> {
    let mut listing = RuleListing::default();
    for (home_index, home) in sources.account_homes.iter().enumerate() {
        let home_scope = ProviderStandingRuleScope::AccountHome {
            account_id: home.account_id.clone(),
        };
        let reading = RuleReading {
            home_index,
            project_index: None,
        };
        listing
            .collect(sources, reading, |origin| match origin {
                RuleFileOrigin::System => Some(None),
                RuleFileOrigin::Home => Some(Some(&home_scope)),
                RuleFileOrigin::Project => None,
            })
            .await?;
    }
    for (project_index, project) in sources.projects.iter().enumerate() {
        if !project.is_trusted {
            continue;
        }
        let project_scope = ProviderStandingRuleScope::Project {
            repo_mount_id: project.repo_mount_id,
        };
        for home_index in 0..sources.account_homes.len() {
            let reading = RuleReading {
                home_index,
                project_index: Some(project_index),
            };
            listing
                .collect(sources, reading, |origin| match origin {
                    RuleFileOrigin::Project => Some(Some(&project_scope)),
                    RuleFileOrigin::System | RuleFileOrigin::Home => None,
                })
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
    // Adds every rule call of the files `reading` loads whose folder `scope_of` lists, each under
    // the scope it gives, `None` for a rule that holds under no scope.
    async fn collect<'scope>(
        &mut self,
        sources: &CodexRuleListingSources<'_>,
        reading: RuleReading,
        scope_of: impl Fn(RuleFileOrigin) -> Option<Option<&'scope ProviderStandingRuleScope>>,
    ) -> Result<(), CodexRulesError> {
        let reading_sources = reading_sources(sources, reading);
        let files = read_rule_file_texts(&reading_sources).await?;
        for (file, evaluated) in evaluate_rule_files(files, &reading_sources).await? {
            let evaluated = evaluated.map_err(|reason| CodexRulesError::Unloadable {
                path: file.path.clone(),
                reason,
            })?;
            let Some(scope) = scope_of(file.origin) else {
                continue;
            };
            let source_path = listable_path(&file.path)?;
            let file_text: Arc<str> = Arc::from(file.text);
            for call in evaluated.calls {
                let text = file_text
                    .get(call.span.clone())
                    .expect("a call's place lies in the text its file was parsed from");
                let rule_id =
                    mint_standing_rule_id(sources.place, &source_path, scope, &call.decision, text);
                // The id holds the file, so a rule listed before is in this file: written twice
                // in it, a system file read again beside another home, or a project's file read
                // again beside another home.
                if let Some(&position) = self.positions.get(&rule_id) {
                    let listed = &mut self.rules[position];
                    if !listed.spans.contains(&call.span) {
                        listed.spans.push(call.span);
                    }
                    continue;
                }
                let rule = ProviderStandingRule {
                    rule_id: rule_id.clone(),
                    scope: scope.cloned(),
                    place: sources.place.cloned(),
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
                    origin: file.origin,
                    file_text: Arc::clone(&file_text),
                    spans: vec![call.span],
                    reading,
                });
            }
        }
        Ok(())
    }
}

// Where Codex reads the rules of `reading`'s sessions: its home's, with its project's where it
// names one, a project being trusted wherever it is read.
fn reading_sources<'a>(
    sources: &CodexRuleListingSources<'a>,
    reading: RuleReading,
) -> CodexRuleSources<'a> {
    let home = &sources.account_homes[reading.home_index];
    match reading.project_index {
        // No project is read, so the working folder an example's relative program is read in is
        // the home folder.
        None => rule_sources(sources, home, &home.home_folder, false),
        Some(project_index) => rule_sources(
            sources,
            home,
            &sources.projects[project_index].project_folder,
            true,
        ),
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

pub(super) fn listable_path(path: &Path) -> Result<FilesystemPath, CodexRulesError> {
    FilesystemPath::new(path.to_string_lossy().into_owned()).map_err(|failure| {
        CodexRulesError::Unlistable {
            path: path.to_path_buf(),
            failure,
        }
    })
}

pub(super) fn listable_text<const MAX: usize>(
    path: &Path,
    text: String,
) -> Result<FreeFormText<MAX>, CodexRulesError> {
    FreeFormText::new(text).map_err(|failure| CodexRulesError::Unlistable {
        path: path.to_path_buf(),
        failure,
    })
}

#[cfg(test)]
pub(super) mod test_machine;
#[cfg(test)]
mod tests;
