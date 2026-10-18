//! A project's standing rules as Codex keeps them, in the `.rules` files of the project's
//! `.codex/rules/`, which Codex reads in conversations started after a change. The daemon writes
//! one file of its own there, holding a command's `prefix_rule` and a host's `network_rule`, and
//! lists it in the repository's own exclude list so it stays on this machine. Codex drops every
//! user and project rule when one rule file does not load, so a rule Codex would refuse is refused
//! before anything is written. A command allow a prefix rule would stretch over a force push or a
//! branch delete is never written: the daemon answers each ask it covers. The rules in force are
//! read from every rule file Codex loads, the person's own among them, through Codex's own grammar
//! and checks.

mod reader;

use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use sidekicks_contracts::approval::RememberedRuleSense;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use sidekicks_platforms::PathRules;

use crate::file::atomic_write::{AtomicWriteError, write_file_atomically};
use crate::git::exclude::{ExcludeError, add_repository_exclude};
use crate::keyed_lock::KeyedLock;
use crate::missing_entry::MissingEntry;
use crate::policy::destructive_git::covers_destructive_git;
use crate::provider::driver::codex::rules::reader::{RuleFileReader, RuleFileReading};
use crate::provider::port::permission_ask::{ProviderAskActionKind, ProviderAskRule};

// The folder Codex reads a project's rule files from, and the extension it reads.
const CODEX_RULES_FOLDER: [&str; 2] = [".codex", "rules"];
const CODEX_RULE_FILE_EXTENSION: &str = "rules";

// The daemon's own rule file in that folder, and its exclude line, read from the worktree's root.
const CODEX_PROJECT_RULE_FILE_NAME: &str = "sidekicks.rules";
const CODEX_PROJECT_RULE_EXCLUDE_PATTERN: &str = "/.codex/rules/sidekicks.rules";

// The rule file is the person's to read, as Codex leaves such files.
const CODEX_PROJECT_RULE_FILE_MODE: u32 = 0o644;

// A host's rule covers both protocols a fetch takes.
const CODEX_NETWORK_RULE_PROTOCOLS: [&str; 2] = ["https", "http"];

// The folder of a Codex home Codex reads the person's own rule files from.
const CODEX_HOME_RULES_FOLDER: &str = "rules";

// Held on the daemon's rule file across its read and write, so two edits never drop each other's.
static PROJECT_RULE_FILE_LOCK: LazyLock<KeyedLock<PathBuf>> = LazyLock::new(KeyedLock::new);

/// Why a Codex project rule could not be written, removed or read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CodexRulesError {
    /// Codex keeps no project rule on this kind of ask.
    #[error("Codex keeps no project rule on a {0} ask")]
    UnkeptKind(&'static str),
    /// A command rule names no word, which Codex refuses.
    #[error("a command rule names no word")]
    EmptyPattern,
    /// A network rule's host is one Codex refuses.
    #[error("Codex refuses this network rule's host: {0}")]
    RefusedHost(&'static str),
    /// A rule file or its folder could not be read.
    #[error("reading {} failed", path.display())]
    Read {
        /// The file or folder.
        path: PathBuf,
        /// The file system's failure.
        #[source]
        failure: io::Error,
    },
    /// The rule file's folder could not be made.
    #[error("making the folder of {} failed", path.display())]
    CreateFolder {
        /// The rule file.
        path: PathBuf,
        /// The file system's failure.
        #[source]
        failure: io::Error,
    },
    /// The rule file could not be written.
    #[error("writing the project's rule file failed")]
    Write(#[source] AtomicWriteError),
    /// The rule file could not be listed in the repository's exclude list.
    #[error("keeping the project's rule file out of commits failed")]
    Exclude(#[source] ExcludeError),
    /// A rule file is not one Codex loads, so Codex keeps none of the person's or the project's
    /// rules.
    #[error("Codex does not load the rule file {}: {reason}", path.display())]
    Unloadable {
        /// The rule file.
        path: PathBuf,
        /// Why Codex refuses it.
        reason: String,
    },
    /// The daemon's rule file could not be deleted once its last rule went.
    #[error("deleting the emptied rule file {} failed", path.display())]
    Delete {
        /// The rule file.
        path: PathBuf,
        /// The file system's failure.
        #[source]
        failure: io::Error,
    },
    /// A revoked rule is in no rule file of the project the daemon reads.
    #[error("the rule is in none of the project's rule files")]
    RuleNotFound,
    /// A revoked rule is kept in a rule file of the person's own, which the daemon never edits, so
    /// it still applies.
    #[error("the rule is kept in {}, which the daemon does not edit", path.display())]
    RuleInUneditedFile {
        /// The file that keeps it.
        path: PathBuf,
    },
}

/// One rule in force in a project's rule files, with the file that holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexProjectRule {
    /// The rule file.
    pub(crate) file: PathBuf,
    /// The rule, a project command or network rule.
    pub(crate) rule: ProviderAskRule,
}

/// A rule file Codex loads that the daemon cannot read without running it, and why; its rules are
/// never listed in part.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexUnreadRuleFile {
    /// The rule file.
    pub(crate) file: PathBuf,
    /// What in it only running the file would show.
    pub(crate) reason: String,
}

/// The project's rules Codex enforces, and the rule files bearing on them the daemon cannot read.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct CodexProjectRules {
    /// Every allow and block in the project's readable rule files.
    pub(crate) rules: Vec<CodexProjectRule>,
    /// The person's and the project's rule files the daemon cannot read.
    pub(crate) unread_files: Vec<CodexUnreadRuleFile>,
}

/// Where Codex reads the rules of one project's sessions.
pub(crate) struct CodexRuleSources<'a> {
    /// The Codex home the sessions run on, whose `rules/` Codex reads first.
    pub(crate) codex_home: &'a Path,
    /// The project's folder, whose `.codex/rules/` Codex reads next.
    pub(crate) project_folder: &'a Path,
    /// Whether Codex trusts the project; it reads no rule file of a project it does not trust.
    pub(crate) is_project_trusted: bool,
    /// How the place the sessions run in spells paths.
    pub(crate) path_rules: PathRules,
}

/// Writes `rule` into the project's own rule file, replacing a rule of the other sense over the
/// same subject; a file the daemon creates is first listed in the exclude list of
/// `common_git_folder`, the repository the project folder belongs to, where it is one. One edit at
/// a time on the file. Refuses, with nothing written, a kind Codex keeps no project rule on, a
/// command with no word and a host Codex would refuse.
pub(crate) async fn write_codex_project_rule(
    project_folder: &Path,
    common_git_folder: Option<&Path>,
    rule: &ProviderAskRule,
) -> Result<(), CodexRulesError> {
    let written = compose_rule_lines(rule)?;
    if written.is_empty() {
        return Ok(());
    }
    let opposite = compose_rule_lines(&ProviderAskRule {
        sense: opposite_sense(rule.sense),
        ..rule.clone()
    })?;
    let file_path = project_rule_file(project_folder);
    let _hold = PROJECT_RULE_FILE_LOCK.acquire(file_path.clone()).await;
    let text = if let Some(text) = read_if_present(&file_path).await? {
        text
    } else {
        if let Some(common_git_folder) = common_git_folder {
            add_repository_exclude(common_git_folder, CODEX_PROJECT_RULE_EXCLUDE_PATTERN)
                .await
                .map_err(CodexRulesError::Exclude)?;
        }
        String::new()
    };
    let mut lines: Vec<&str> = rule_lines(&text)
        .filter(|line| {
            !opposite
                .iter()
                .chain(&written)
                .any(|rule_line| rule_line == line)
        })
        .collect();
    lines.extend(written.iter().map(String::as_str));
    write_rule_file(&file_path, &lines).await
}

/// Removes a revoked rule from the project's own rule file, one edit at a time on it, and deletes
/// the file once it holds no rule. Refuses the rules [`write_codex_project_rule`] refuses, and a
/// rule the file does not hold: `RuleInUneditedFile` where another of the project's rule files,
/// read in a place that spells paths by `path_rules`, keeps it, else `RuleNotFound`.
pub(crate) async fn remove_codex_project_rule(
    project_folder: &Path,
    rule: &ProviderAskRule,
    path_rules: PathRules,
) -> Result<(), CodexRulesError> {
    let removed = compose_rule_lines(rule)?;
    let file_path = project_rule_file(project_folder);
    let _hold = PROJECT_RULE_FILE_LOCK.acquire(file_path.clone()).await;
    let text = read_if_present(&file_path).await?.unwrap_or_default();
    let lines: Vec<&str> = rule_lines(&text).collect();
    let kept: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|line| !removed.iter().any(|rule_line| rule_line == line))
        .collect();
    if kept.len() == lines.len() {
        return Err(find_rule_elsewhere(project_folder, &file_path, rule, path_rules).await?);
    }
    if kept.is_empty() {
        return tokio::fs::remove_file(&file_path).await.map_err(|failure| {
            CodexRulesError::Delete {
                path: file_path.clone(),
                failure,
            }
        });
    }
    write_rule_file(&file_path, &kept).await
}

/// Every allow and block Codex enforces from the project's rule files, read as Codex loads them:
/// each `.rules` file of the Codex home's `rules/`, then of the project's `.codex/rules/`, each
/// folder in name order, none of the project's where Codex does not trust it. A rule Codex asks on
/// (`prompt`) is neither and is left out. A file only running would read is listed among the
/// unread files with its reason, none of its rules among the rules. Fails with `Unloadable` when a
/// file is one Codex refuses, since Codex then keeps none of the person's or the project's rules.
pub(crate) async fn read_codex_project_rules(
    sources: &CodexRuleSources<'_>,
) -> Result<CodexProjectRules, CodexRulesError> {
    let mut read = CodexProjectRules::default();
    if !sources.is_project_trusted {
        return Ok(read);
    }
    let mut reader = RuleFileReader::new(sources.path_rules);
    let home_folder = sources.codex_home.join(CODEX_HOME_RULES_FOLDER);
    let project_folder = project_rules_folder(sources.project_folder);
    for (folder, is_project) in [(home_folder, false), (project_folder, true)] {
        for file in list_rule_files(&folder).await? {
            let text = read_rule_file(&file).await?;
            let reading = reader
                .read(&file.to_string_lossy(), text)
                .map_err(|reason| CodexRulesError::Unloadable {
                    path: file.clone(),
                    reason,
                })?;
            match reading {
                RuleFileReading::Read(rules) if is_project => {
                    read.rules
                        .extend(rules.into_iter().map(|rule| CodexProjectRule {
                            file: file.clone(),
                            rule,
                        }));
                }
                RuleFileReading::Read(_) => {}
                RuleFileReading::Unread(reason) => {
                    read.unread_files.push(CodexUnreadRuleFile { file, reason });
                }
            }
        }
    }
    Ok(read)
}

// Why a revoked rule the daemon's file does not hold cannot be revoked: another of the project's
// rule files keeps it, or none does.
async fn find_rule_elsewhere(
    project_folder: &Path,
    own_file: &Path,
    rule: &ProviderAskRule,
    path_rules: PathRules,
) -> Result<CodexRulesError, CodexRulesError> {
    let wanted = normalize_rule_subject(rule)?;
    let mut reader = RuleFileReader::new(path_rules);
    for file in list_rule_files(&project_rules_folder(project_folder)).await? {
        if file == own_file {
            continue;
        }
        let text = read_rule_file(&file).await?;
        // A file Codex refuses or the daemon cannot read names no rule the daemon can point at.
        if let Ok(RuleFileReading::Read(rules)) = reader.read(&file.to_string_lossy(), text)
            && rules.contains(&wanted)
        {
            return Ok(CodexRulesError::RuleInUneditedFile { path: file });
        }
    }
    Ok(CodexRulesError::RuleNotFound)
}

// A rule with its subject as a rule file reads back: a command's words joined by one space, a
// host as Codex keeps it.
fn normalize_rule_subject(rule: &ProviderAskRule) -> Result<ProviderAskRule, CodexRulesError> {
    let subject = match rule.action {
        ProviderAskActionKind::Command => rule
            .subject
            .split(is_ecmascript_whitespace)
            .filter(|word| !word.is_empty())
            .collect::<Vec<_>>()
            .join(" "),
        ProviderAskActionKind::Network => {
            normalize_network_rule_host(&rule.subject).map_err(CodexRulesError::RefusedHost)?
        }
        ProviderAskActionKind::Plan
        | ProviderAskActionKind::CommandInput
        | ProviderAskActionKind::FileChange
        | ProviderAskActionKind::FileRead
        | ProviderAskActionKind::Tool => {
            return Err(CodexRulesError::UnkeptKind(rule.action.into()));
        }
    };
    Ok(ProviderAskRule {
        subject,
        ..rule.clone()
    })
}

// The `.rules` files of one folder in name order, as Codex lists them; none where it is missing.
async fn list_rule_files(folder: &Path) -> Result<Vec<PathBuf>, CodexRulesError> {
    let read_failure = |failure| CodexRulesError::Read {
        path: folder.to_path_buf(),
        failure,
    };
    let Some(mut entries) = tokio::fs::read_dir(folder)
        .await
        .none_if_missing()
        .map_err(read_failure)?
    else {
        return Ok(Vec::new());
    };
    let mut files = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(read_failure)? {
        let path = entry.path();
        if path
            .extension()
            .is_some_and(|extension| extension == CODEX_RULE_FILE_EXTENSION)
            && entry.file_type().await.map_err(read_failure)?.is_file()
        {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

async fn read_rule_file(file: &Path) -> Result<String, CodexRulesError> {
    tokio::fs::read_to_string(file)
        .await
        .map_err(|failure| CodexRulesError::Read {
            path: file.to_path_buf(),
            failure,
        })
}

fn project_rules_folder(project_folder: &Path) -> PathBuf {
    CODEX_RULES_FOLDER
        .iter()
        .fold(project_folder.to_path_buf(), |path, part| path.join(part))
}

fn project_rule_file(project_folder: &Path) -> PathBuf {
    project_rules_folder(project_folder).join(CODEX_PROJECT_RULE_FILE_NAME)
}

fn opposite_sense(sense: RememberedRuleSense) -> RememberedRuleSense {
    match sense {
        RememberedRuleSense::Allow => RememberedRuleSense::Block,
        RememberedRuleSense::Block => RememberedRuleSense::Allow,
    }
}

// The lines one rule is in Codex's rule language, each word written as a JSON string, which
// Codex's Starlark lexer reads back unchanged: a command's words as a prefix, none for one that
// would also cover a destructive git command, and a host's for each protocol.
fn compose_rule_lines(rule: &ProviderAskRule) -> Result<Vec<String>, CodexRulesError> {
    match rule.action {
        ProviderAskActionKind::Command => {
            if covers_destructive_git(rule) {
                return Ok(Vec::new());
            }
            let words: Vec<String> = rule
                .subject
                .split(is_ecmascript_whitespace)
                .filter(|word| !word.is_empty())
                .map(write_rule_string)
                .collect();
            if words.is_empty() {
                return Err(CodexRulesError::EmptyPattern);
            }
            let decision = match rule.sense {
                RememberedRuleSense::Allow => "allow",
                RememberedRuleSense::Block => "forbidden",
            };
            Ok(vec![format!(
                "prefix_rule(pattern=[{}], decision=\"{decision}\")",
                words.join(", ")
            )])
        }
        ProviderAskActionKind::Network => {
            normalize_network_rule_host(&rule.subject).map_err(CodexRulesError::RefusedHost)?;
            let decision = match rule.sense {
                RememberedRuleSense::Allow => "allow",
                RememberedRuleSense::Block => "deny",
            };
            let host = write_rule_string(&rule.subject);
            Ok(CODEX_NETWORK_RULE_PROTOCOLS
                .iter()
                .map(|protocol| {
                    format!(
                        "network_rule(host={host}, protocol=\"{protocol}\", decision=\"{decision}\")"
                    )
                })
                .collect())
        }
        ProviderAskActionKind::Plan
        | ProviderAskActionKind::CommandInput
        | ProviderAskActionKind::FileChange
        | ProviderAskActionKind::FileRead
        | ProviderAskActionKind::Tool => Err(CodexRulesError::UnkeptKind(rule.action.into())),
    }
}

fn write_rule_string(text: &str) -> String {
    serde_json::to_string(text).expect("a string always serializes")
}

// The host as Codex keeps it, or why Codex refuses it: trimmed, a port and trailing dots dropped,
// lower-cased, and never empty, a URL, a wildcard or holding whitespace.
fn normalize_network_rule_host(raw: &str) -> Result<String, &'static str> {
    let mut host = raw.trim();
    if host.is_empty() {
        return Err("the host is empty");
    }
    if host.contains("://") || host.contains(['/', '?', '#']) {
        return Err("the host names a scheme or a path");
    }
    if let Some(stripped) = host.strip_prefix('[') {
        let Some((inside, rest)) = stripped.split_once(']') else {
            return Err("the host's bracketed address is unclosed");
        };
        let has_port = rest
            .strip_prefix(':')
            .is_some_and(|port| !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()));
        if !rest.is_empty() && !has_port {
            return Err("the host's bracketed address has an unsupported suffix");
        }
        host = inside;
    } else if host.matches(':').count() == 1
        && let Some((candidate, port)) = host.rsplit_once(':')
        && !candidate.is_empty()
        && !port.is_empty()
        && port.chars().all(|c| c.is_ascii_digit())
    {
        host = candidate;
    }
    let normalized = host.trim_end_matches('.').trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Err("the host is empty");
    }
    if normalized.contains('*') {
        return Err("the host holds a wildcard");
    }
    if normalized.chars().any(char::is_whitespace) {
        return Err("the host holds whitespace");
    }
    Ok(normalized)
}

// The file's lines that hold anything, a line break's carriage return dropped.
fn rule_lines(text: &str) -> impl Iterator<Item = &str> {
    text.lines()
        .filter(|line| !line.chars().all(is_ecmascript_whitespace))
}

async fn read_if_present(file_path: &Path) -> Result<Option<String>, CodexRulesError> {
    tokio::fs::read_to_string(file_path)
        .await
        .none_if_missing()
        .map_err(|failure| CodexRulesError::Read {
            path: file_path.to_path_buf(),
            failure,
        })
}

async fn write_rule_file(file_path: &Path, lines: &[&str]) -> Result<(), CodexRulesError> {
    if let Some(folder) = file_path.parent() {
        tokio::fs::create_dir_all(folder).await.map_err(|failure| {
            CodexRulesError::CreateFolder {
                path: file_path.to_path_buf(),
                failure,
            }
        })?;
    }
    let mut text = lines.join("\n");
    text.push('\n');
    write_file_atomically(file_path, text, CODEX_PROJECT_RULE_FILE_MODE)
        .await
        .map_err(CodexRulesError::Write)
}

#[cfg(test)]
mod tests;
