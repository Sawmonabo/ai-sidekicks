//! A project's standing rules as Codex keeps them, in the `.rules` files of the project's
//! `.codex/rules/`, which Codex reads in conversations started after a change. The daemon writes
//! one file of its own there, holding a command's `prefix_rule` and a host's `network_rule`, and
//! lists it in the repository's own exclude list so it stays on this machine. Codex drops every
//! rule file's rules when one rule file does not load, so a rule Codex would refuse is refused
//! before anything is written. A command allow a prefix rule would stretch over a force push or a
//! branch delete is never written: the daemon answers each ask it covers. The rules in force are
//! read by evaluating every rule file Codex loads, the system's and the person's own among them, as
//! Codex's own loader evaluates them.

mod evaluator;

use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::approval::RememberedRuleSense;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use sidekicks_platforms::PathRules;

use crate::bounded_wait::wait_within;
use crate::file::atomic_write::{AtomicWriteError, write_file_atomically};
use crate::file::real_location::resolve_real_location;
use crate::git::exclude::{ExcludeError, add_repository_exclude};
use crate::keyed_lock::KeyedLock;
use crate::missing_entry::MissingEntry;
use crate::policy::destructive_git::covers_destructive_git;
use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::delivery::asks::CodexProjectRules;
use crate::provider::driver::codex::rules::evaluator::RuleFileEvaluator;
use crate::provider::port::permission_ask::{ProviderAskActionKind, ProviderAskRule};
use crate::provider::port::registration::PortRegistration;
use crate::provider::port::repository_reader::RepositoryReader;

// The folder a project keeps its Codex settings in, and in it and in every other folder Codex
// reads settings from, the folder of rule files and the extension Codex reads.
const CODEX_PROJECT_SETTINGS_FOLDER: &str = ".codex";
const CODEX_RULES_FOLDER: &str = "rules";
const CODEX_RULE_FILE_EXTENSION: &str = "rules";

// The daemon's own rule file in that folder, and its exclude line, read from the worktree's root.
const CODEX_PROJECT_RULE_FILE_NAME: &str = "sidekicks.rules";
const CODEX_PROJECT_RULE_EXCLUDE_PATTERN: &str = "/.codex/rules/sidekicks.rules";

// The rule file is the person's to read, as Codex leaves such files.
const CODEX_PROJECT_RULE_FILE_MODE: u32 = 0o644;

// A host's rule covers both protocols a fetch takes.
const CODEX_NETWORK_RULE_PROTOCOLS: [&str; 2] = ["https", "http"];

/// How long one read may evaluate rule files before the file it is in reads as one that did not
/// finish, the limit the daemon's sources carry; a person's file runs whatever it computes, a loop
/// over a huge range included.
pub(crate) const RULE_EVALUATION_TIME_LIMIT: Duration = Duration::from_secs(5);

// How much longer than the time limit a read waits on the evaluating thread, for one long call
// that never reaches starlark's cancel check, before the read answers without it.
const RULE_EVALUATION_WAIT_MARGIN: Duration = Duration::from_secs(1);

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
    /// A network rule's host is one Codex refuses, in Codex's words.
    #[error("Codex refuses this network rule's host: {0}")]
    RefusedHost(String),
    /// The project's `.codex` folder is the Codex home, whose rule files are the person's own and
    /// which Codex never reads as a project's.
    #[error("the project's .codex folder is the Codex home, which holds the person's own rules")]
    ProjectIsCodexHome,
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
    /// A rule file is not one Codex loads, or did not finish evaluating in time, so Codex drops
    /// every rule file's rules.
    #[error("Codex does not load the rule file {}: {reason}", path.display())]
    Unloadable {
        /// The rule file.
        path: PathBuf,
        /// Why, in Codex's own words, or that it did not finish.
        reason: String,
    },
    /// The task evaluating the rule files ended before it answered.
    #[error("evaluating the rule files stopped")]
    EvaluationStopped(#[source] tokio::task::JoinError),
    /// The daemon's rule file could not be deleted once its last rule went.
    #[error("deleting the emptied rule file {} failed", path.display())]
    Delete {
        /// The rule file.
        path: PathBuf,
        /// The file system's failure.
        #[source]
        failure: io::Error,
    },
    /// A revoked rule is in no rule file Codex reads.
    #[error("the rule is in none of the rule files Codex reads")]
    RuleNotFound,
    /// A revoked rule is kept in a rule file the daemon never edits, so it still applies.
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

/// Where Codex reads the rules of one project's sessions.
pub(crate) struct CodexRuleSources<'a> {
    /// The folder Codex keeps its system settings in, its descriptor's managed settings folder,
    /// whose `rules/` Codex reads first.
    pub(crate) system_folder: &'a Path,
    /// The Codex home the sessions run on, whose `rules/` Codex reads next.
    pub(crate) codex_home: &'a Path,
    /// The person's home folder, in which an example's program starting `~` is read.
    pub(crate) home_folder: &'a Path,
    /// The project's folder, the sessions' working folder, whose `.codex/rules/` Codex reads last.
    pub(crate) project_folder: &'a Path,
    /// Whether Codex trusts the project; it reads no rule file of a project it does not trust.
    pub(crate) is_project_trusted: bool,
    /// How the place the sessions run in spells paths.
    pub(crate) path_rules: PathRules,
    /// How long one read may evaluate the rule files, [`RULE_EVALUATION_TIME_LIMIT`] for the
    /// daemon's sessions.
    pub(crate) evaluation_time_limit: Duration,
}

// Whether an evaluation goes on past the first file Codex refuses: a read stops there, since the
// whole read then fails, while a revoke's search reads every file.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AfterFailure {
    Stop,
    Continue,
}

// One rule file's text as read, and whether it is one of the project's.
struct RuleFileText {
    path: PathBuf,
    text: String,
    is_project: bool,
}

/// The project rule files the daemon edits on the person's own Codex folder: a rule an answer made
/// written into a project, and a revoked one taken back out.
pub(crate) struct CodexProjectRuleFiles {
    /// The person's own Codex folder, whose rules Codex reads before a project's.
    pub(crate) codex_home: PathBuf,
    /// The person's home folder.
    pub(crate) home_folder: PathBuf,
    /// The daemon's reads of the repository a project folder belongs to.
    pub(crate) repositories: Arc<PortRegistration<Arc<dyn RepositoryReader>>>,
}

impl CodexProjectRuleFiles {
    /// Takes a revoked `rule` back out of `project_folder`'s own rule file; a rule the file no
    /// longer holds is already out of force. Fails as [`remove_codex_project_rule`] does otherwise.
    pub(crate) async fn revoke(
        &self,
        project_folder: &Path,
        rule: &ProviderAskRule,
    ) -> Result<(), CodexRulesError> {
        match remove_codex_project_rule(&self.sources(project_folder), rule).await {
            Err(CodexRulesError::RuleNotFound) => Ok(()),
            removed => removed,
        }
    }

    // Where Codex reads the rules of `project_folder`'s sessions. The project's own files count
    // only where Codex trusts it, which no read tells; they are read as trusted, so a rule another
    // of them keeps is never reported gone.
    fn sources<'a>(&'a self, project_folder: &'a Path) -> CodexRuleSources<'a> {
        CodexRuleSources {
            system_folder: &SYSTEM_FOLDER,
            codex_home: &self.codex_home,
            home_folder: &self.home_folder,
            project_folder,
            is_project_trusted: true,
            path_rules: PathRules::NATIVE,
            evaluation_time_limit: RULE_EVALUATION_TIME_LIMIT,
        }
    }
}

/// The folder Codex keeps its system settings in on the running system.
static SYSTEM_FOLDER: LazyLock<PathBuf> = LazyLock::new(|| {
    DESCRIPTOR
        .managed_settings_folder()
        .expect("Codex names its system settings folder on every system")
});

impl CodexProjectRules for CodexProjectRuleFiles {
    fn write<'call>(
        &'call self,
        project_folder: &'call Path,
        rule: &'call ProviderAskRule,
    ) -> BoxFuture<'call, Result<(), CodexRulesError>> {
        async move {
            let repository = match self.repositories.port() {
                Some(repositories) => repositories.read_repository(project_folder).await,
                None => None,
            };
            let common_git_folder = repository.map(|reading| reading.common_git_folder);
            write_codex_project_rule(
                &self.sources(project_folder),
                common_git_folder.as_deref(),
                rule,
            )
            .await
        }
        .boxed()
    }

    fn remove<'call>(
        &'call self,
        project_folder: &'call Path,
        rule: &'call ProviderAskRule,
    ) -> BoxFuture<'call, Result<(), CodexRulesError>> {
        async move { remove_codex_project_rule(&self.sources(project_folder), rule).await }.boxed()
    }
}

/// Writes `rule` into the project's own rule file, replacing a rule of the other sense over the
/// same subject; a file the daemon creates is first listed in the exclude list of
/// `common_git_folder`, the repository the project folder belongs to, where it is one. One edit at
/// a time on the file. Refuses, with nothing written, a kind Codex keeps no project rule on, a
/// command with no word, a host Codex would refuse and a project whose `.codex` is the Codex home.
pub(crate) async fn write_codex_project_rule(
    sources: &CodexRuleSources<'_>,
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
    if is_codex_home_project(sources).await {
        return Err(CodexRulesError::ProjectIsCodexHome);
    }
    let file_path = project_rule_file(sources.project_folder);
    let _hold = PROJECT_RULE_FILE_LOCK
        .acquire(resolve_lock_key(&file_path).await?)
        .await;
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
/// the file once it holds no rule. Refuses the rules [`write_codex_project_rule`] refuses; answers
/// `RuleInUneditedFile`, changing nothing, where another rule file Codex reads keeps the rule (one
/// that does not load counts when its text holds the rule's line), since it would still apply;
/// else `RuleNotFound` where the daemon's file does not hold it either.
pub(crate) async fn remove_codex_project_rule(
    sources: &CodexRuleSources<'_>,
    rule: &ProviderAskRule,
) -> Result<(), CodexRulesError> {
    let removed = compose_rule_lines(rule)?;
    if is_codex_home_project(sources).await {
        return Err(CodexRulesError::ProjectIsCodexHome);
    }
    let file_path = project_rule_file(sources.project_folder);
    if let Some(path) = find_rule_elsewhere(sources, &file_path, rule, &removed).await? {
        return Err(CodexRulesError::RuleInUneditedFile { path });
    }
    let _hold = PROJECT_RULE_FILE_LOCK
        .acquire(resolve_lock_key(&file_path).await?)
        .await;
    let text = read_if_present(&file_path).await?.unwrap_or_default();
    let lines: Vec<&str> = rule_lines(&text).collect();
    let kept: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|line| !removed.iter().any(|rule_line| rule_line == line))
        .collect();
    if kept.len() == lines.len() {
        return Err(CodexRulesError::RuleNotFound);
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
/// each `.rules` file of the system folder's `rules/`, of the Codex home's, then of the project's
/// `.codex/rules/`, each folder in name order, evaluated in turn; none of the project's where Codex
/// does not trust it or its `.codex` is the Codex home. A rule Codex asks on (`prompt`) is neither
/// and is left out. Fails with `Unloadable` naming the first file Codex refuses, or one that did
/// not finish in time, since Codex then drops every rule file's rules.
pub(crate) async fn read_codex_project_rules(
    sources: &CodexRuleSources<'_>,
) -> Result<Vec<CodexProjectRule>, CodexRulesError> {
    let files = read_rule_file_texts(sources).await?;
    let mut rules = Vec::new();
    for (file, evaluated) in evaluate_rule_files(files, sources, AfterFailure::Stop).await? {
        let file_rules = evaluated.map_err(|reason| CodexRulesError::Unloadable {
            path: file.path.clone(),
            reason,
        })?;
        if file.is_project {
            rules.extend(file_rules.into_iter().map(|rule| CodexProjectRule {
                file: file.path.clone(),
                rule,
            }));
        }
    }
    Ok(rules)
}

// The first rule file Codex reads, other than the daemon's own, that keeps a revoked rule, by its
// evaluated rules or, for one that does not load, by one of `literal_lines` in its text; `None`
// where none does.
async fn find_rule_elsewhere(
    sources: &CodexRuleSources<'_>,
    own_file: &Path,
    rule: &ProviderAskRule,
    literal_lines: &[String],
) -> Result<Option<PathBuf>, CodexRulesError> {
    let wanted = normalize_rule_subject(rule)?;
    let files = read_rule_file_texts(sources).await?;
    for (file, evaluated) in evaluate_rule_files(files, sources, AfterFailure::Continue).await? {
        if file.path == own_file {
            continue;
        }
        let is_kept = match evaluated {
            Ok(rules) => rules.contains(&wanted),
            Err(_) => literal_lines
                .iter()
                .any(|line| file.text.contains(line.as_str())),
        };
        if is_kept {
            return Ok(Some(file.path));
        }
    }
    Ok(None)
}

// The text of every rule file Codex loads for the project's sessions, in the order it loads them.
async fn read_rule_file_texts(
    sources: &CodexRuleSources<'_>,
) -> Result<Vec<RuleFileText>, CodexRulesError> {
    let mut folders = vec![
        (sources.system_folder.join(CODEX_RULES_FOLDER), false),
        (sources.codex_home.join(CODEX_RULES_FOLDER), false),
    ];
    if sources.is_project_trusted && !is_codex_home_project(sources).await {
        folders.push((project_rules_folder(sources.project_folder), true));
    }
    let mut files = Vec::new();
    for (folder, is_project) in folders {
        for path in list_rule_files(&folder).await? {
            let text = read_rule_file(&path).await?;
            files.push(RuleFileText {
                path,
                text,
                is_project,
            });
        }
    }
    Ok(files)
}

// Each file evaluated in turn by one evaluator, as Codex's loader carries one across them, away
// from the async workers, up to the first file Codex refuses where `after_failure` stops there.
// The evaluation stops at the sources' time limit; a call that runs on past it without reaching
// starlark's check is left to its thread, and the file it is in reads as one that did not finish.
async fn evaluate_rule_files(
    files: Vec<RuleFileText>,
    sources: &CodexRuleSources<'_>,
    after_failure: AfterFailure,
) -> Result<Vec<(RuleFileText, Result<Vec<ProviderAskRule>, String>)>, CodexRulesError> {
    let Some(first_file) = files.first() else {
        return Ok(Vec::new());
    };
    let running_file = Arc::new(Mutex::new(first_file.path.clone()));
    let evaluator_running_file = Arc::clone(&running_file);
    let evaluator_path_rules = sources.path_rules;
    let working_folder = sources.project_folder.to_string_lossy().into_owned();
    let home_folder = sources.home_folder.to_string_lossy().into_owned();
    let time_limit = sources.evaluation_time_limit;
    let mut evaluation = tokio::task::spawn_blocking(move || {
        let evaluator = RuleFileEvaluator::new(evaluator_path_rules, working_folder, home_folder);
        let deadline = Instant::now() + time_limit;
        let mut evaluated = Vec::with_capacity(files.len());
        for file in files {
            file.path.clone_into(
                &mut evaluator_running_file
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner),
            );
            let outcome = evaluator.evaluate(&file.path.to_string_lossy(), &file.text, deadline);
            let is_refused = outcome.is_err();
            evaluated.push((file, outcome));
            if is_refused && after_failure == AfterFailure::Stop {
                break;
            }
        }
        evaluated
    });
    let waited = wait_within(
        Pin::new(&mut evaluation),
        time_limit + RULE_EVALUATION_WAIT_MARGIN,
        None,
    )
    .await;
    let Some(finished) = waited else {
        let path = running_file
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        return Err(CodexRulesError::Unloadable {
            path,
            reason: "did not finish".to_owned(),
        });
    };
    finished.map_err(CodexRulesError::EvaluationStopped)
}

// Whether the project's `.codex` folder is the Codex home, as written or once resolved, which
// Codex never reads as a project's.
async fn is_codex_home_project(sources: &CodexRuleSources<'_>) -> bool {
    let project_settings = sources.project_folder.join(CODEX_PROJECT_SETTINGS_FOLDER);
    if project_settings == sources.codex_home {
        return true;
    }
    // A path that does not resolve is compared as written, as Codex's loader compares it.
    let resolve = |path: PathBuf| async move { resolve_real_location(&path).await.unwrap_or(path) };
    resolve(project_settings).await == resolve(sources.codex_home.to_path_buf()).await
}

// The daemon's rule file as its lock knows it, one key for every spelling of the file.
async fn resolve_lock_key(file_path: &Path) -> Result<PathBuf, CodexRulesError> {
    resolve_real_location(file_path)
        .await
        .map_err(|failure| CodexRulesError::Read {
            path: file_path.to_path_buf(),
            failure,
        })
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
        ProviderAskActionKind::CommandInput
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
    project_folder
        .join(CODEX_PROJECT_SETTINGS_FOLDER)
        .join(CODEX_RULES_FOLDER)
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
        ProviderAskActionKind::CommandInput
        | ProviderAskActionKind::FileChange
        | ProviderAskActionKind::FileRead
        | ProviderAskActionKind::Tool => Err(CodexRulesError::UnkeptKind(rule.action.into())),
    }
}

fn write_rule_string(text: &str) -> String {
    serde_json::to_string(text).expect("a string always serializes")
}

// The host as Codex keeps it, or Codex's words for why it refuses it: trimmed, a port and
// trailing dots dropped, lower-cased, and never empty, a URL, a wildcard or holding whitespace.
fn normalize_network_rule_host(raw: &str) -> Result<String, String> {
    let mut host = raw.trim();
    if host.is_empty() {
        return Err("network_rule host cannot be empty".to_owned());
    }
    if host.contains("://") || host.contains(['/', '?', '#']) {
        return Err(
            "network_rule host must be a hostname or IP literal (without scheme or path)"
                .to_owned(),
        );
    }
    if let Some(stripped) = host.strip_prefix('[') {
        let Some((inside, rest)) = stripped.split_once(']') else {
            return Err("network_rule host has an invalid bracketed IPv6 literal".to_owned());
        };
        let has_port = rest
            .strip_prefix(':')
            .is_some_and(|port| !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()));
        if !rest.is_empty() && !has_port {
            return Err(format!(
                "network_rule host contains an unsupported suffix: {raw}"
            ));
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
        return Err("network_rule host cannot be empty".to_owned());
    }
    if normalized.contains('*') {
        return Err(
            "network_rule host must be a specific host; wildcards are not allowed".to_owned(),
        );
    }
    if normalized.chars().any(char::is_whitespace) {
        return Err("network_rule host cannot contain whitespace".to_owned());
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
