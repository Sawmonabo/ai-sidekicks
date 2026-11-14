//! Codex's standing rules, kept in the `.rules` files of the system folder's, each Codex home's and
//! each trusted project's `rules/` folders, which Codex reads in conversations started after a
//! change. The daemon writes one file of its own in a project's `.codex/rules/`, holding a
//! command's `prefix_rule` and a host's `network_rule`, and lists it in the repository's own
//! exclude list so it stays on this machine; a revoke, from the settings page or of an approval's
//! rule, takes a rule out of each home or project file that holds it, never out of a system file.
//! Codex drops every rule file's rules when one rule file does not load, so a rule Codex would
//! refuse is refused before anything is written, and a revoke that would leave a file Codex refuses
//! is refused with the file untouched. A command allow a prefix rule would stretch over a force
//! push or a branch delete is never written: the daemon answers each ask it covers. The rules in
//! force are read by evaluating every rule file Codex loads, the system's and the person's own
//! among them, as Codex's own loader evaluates them.

mod evaluator;
mod listing;
mod protected_paths;
mod removal;

use std::io;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::approval::RememberedRuleSense;
use sidekicks_contracts::provider::tool_call::ToolCallActionKind;
use sidekicks_contracts::wire::text::{TextError, is_ecmascript_whitespace};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_platforms::PathRules;
use sidekicks_policy::ask_rule::ProviderAskRule;
use sidekicks_policy::destructive_git::covers_destructive_git;
use sidekicks_std::bounded_wait::wait_within;
use sidekicks_std::file::atomic_write::{AtomicWriteError, rewrite_file_in_place};
use sidekicks_std::file::real_location::resolve_real_location;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::missing_entry::MissingEntry;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_workspace::git::exclude::{ExcludeError, add_repository_exclude};

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::config_read::CodexConfigFileError;
use crate::driver::codex::delivery::asks::CodexProjectRules;
use crate::driver::codex::rules::evaluator::{EvaluatedRuleFile, RuleFileEvaluator};
use crate::port::repository_reader::RepositoryReader;
use crate::project_rule_folders::RuleFileHolds;
use crate::record_readers::is_digits;

/// The folder a project keeps its Codex settings in.
pub(crate) const CODEX_PROJECT_SETTINGS_FOLDER: &str = ".codex";
// In that folder and in every other folder Codex reads settings from, the folder of rule files and
// the extension Codex reads.
const CODEX_RULES_FOLDER: &str = "rules";
const CODEX_RULE_FILE_EXTENSION: &str = "rules";

// The daemon's own rule file in that folder, and its exclude line, read from the worktree's root.
const CODEX_PROJECT_RULE_FILE_NAME: &str = "sidekicks.rules";
const CODEX_PROJECT_RULE_EXCLUDE_PATTERN: &str = "/.codex/rules/sidekicks.rules";

// A rule file the daemon makes is the person's to read, as Codex leaves such files; one already
// there keeps its own mode.
const CODEX_RULE_FILE_MODE: u32 = 0o644;

// A host's rule covers both protocols a fetch takes.
const CODEX_NETWORK_RULE_PROTOCOLS: [&str; 2] = ["https", "http"];

/// How long one read may evaluate rule files before the file it is in reads as one that did not
/// finish, the limit the daemon's sources carry; a person's file runs whatever it computes, a loop
/// over a huge range included.
pub(crate) const RULE_EVALUATION_TIME_LIMIT: Duration = Duration::from_secs(5);

// How much longer than the time limit a read waits on the evaluating thread, for one long call
// that never reaches starlark's cancel check, before the read answers without it.
const RULE_EVALUATION_WAIT_MARGIN: Duration = Duration::from_secs(1);

// Held on a rule file the daemon edits across its read and write, so two edits never drop each
// other's.
static RULE_FILE_LOCK: LazyLock<KeyedLock<PathBuf>> = LazyLock::new(KeyedLock::new);

/// Why a Codex rule could not be written, removed, listed or read.
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
    /// The project folder's repository could not be read, so where its rule file is kept out of
    /// commits is not known.
    #[error("the project folder's repository could not be read")]
    RepositoryUnreadable(#[source] DomainError),
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
    /// A rule file could not be written.
    #[error("writing a rule file failed")]
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
    /// A rule file could not be deleted once its last rule went.
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
    /// Taking a rule out of its file would leave a file Codex refuses, which drops every rule
    /// file's rules, or one that still makes the rule, so the file is left as it was.
    #[error("taking the rule out of {} is refused: {reason}", path.display())]
    RevokeRefused {
        /// The rule file.
        path: PathBuf,
        /// Why, in Codex's own words where Codex would refuse the file.
        reason: String,
    },
    /// A Codex config file cannot be read or is not TOML, so Codex does not start on it.
    #[error("a Codex config file cannot be read")]
    UnreadableConfig(#[source] CodexConfigFileError),
    /// The permission profile Codex's config selects does not resolve, so Codex does not start on
    /// it: it or a profile it extends is not defined, it extends a built-in profile, or the chain
    /// runs in a circle.
    #[error("Codex does not resolve the permission profile {profile}: {reason}")]
    UnresolvedProfile {
        /// The profile the config selects.
        profile: String,
        /// Why, in Codex's terms.
        reason: String,
    },
    /// Codex's config defines permission profiles but no layer selects one or the older sandbox
    /// key, so Codex does not start on it.
    #[error("Codex's config defines permission profiles but does not select one")]
    ProfileUnselected,
    /// A rule's text, a protected path or a file's path does not fit the settings list's bounds.
    #[error("a rule or path read from {} does not fit the settings list", path.display())]
    Unlistable {
        /// The file it was read from.
        path: PathBuf,
        /// The bound it broke.
        #[source]
        failure: TextError,
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

// Which of Codex's rule folders a file is in: the system folder's, which Codex reads for every
// home, a Codex home's, or a project's.
#[derive(Clone, Copy, PartialEq, Eq)]
enum RuleFileOrigin {
    System,
    Home,
    Project,
}

// One rule file's text as read, and the folder it is in.
struct RuleFileText {
    path: PathBuf,
    text: String,
    origin: RuleFileOrigin,
}

/// The project rule files the daemon edits: a rule an answer made written into a project, and a
/// revoked one taken back out, each read beside the rules of the Codex home the session runs on.
pub(crate) struct CodexProjectRuleFiles {
    /// The person's home folder.
    pub(crate) home_folder: PathBuf,
    /// The daemon's reads of the repository a project folder belongs to.
    pub(crate) repositories: Arc<PortRegistration<Arc<dyn RepositoryReader>>>,
}

impl CodexProjectRuleFiles {
    /// Takes a revoked `rule` out of each rule file of `codex_home`, the session's, and of
    /// `project_folder` that makes it; a rule no file makes is already out of force. Fails as
    /// [`remove_codex_project_rule`] does otherwise.
    pub(crate) async fn revoke(
        &self,
        codex_home: &Path,
        project_folder: &Path,
        rule: &ProviderAskRule,
    ) -> Result<(), CodexRulesError> {
        match remove_codex_project_rule(&self.sources(codex_home, project_folder), rule).await {
            Err(CodexRulesError::RuleNotFound) => Ok(()),
            removed => removed,
        }
    }

    // Where Codex reads the rules of `project_folder`'s sessions on `codex_home`. The project's own
    // files count only where Codex trusts it, which no read tells; they are read as trusted, so a
    // rule another of them keeps is never reported gone.
    fn sources<'a>(
        &'a self,
        codex_home: &'a Path,
        project_folder: &'a Path,
    ) -> CodexRuleSources<'a> {
        CodexRuleSources {
            system_folder: &SYSTEM_FOLDER,
            codex_home,
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
        codex_home: &'call Path,
        project_folder: &'call Path,
        rule: &'call ProviderAskRule,
        hold: &'call KeyHold<'static, PathBuf>,
    ) -> BoxFuture<'call, Result<CodexProjectRuleWrite, CodexRulesError>> {
        async move {
            let repository = match self.repositories.port() {
                Some(repositories) => repositories
                    .read_repository(project_folder)
                    .await
                    .map_err(CodexRulesError::RepositoryUnreadable)?,
                None => None,
            };
            let common_git_folder = repository.map(|reading| reading.common_git_folder);
            write_codex_project_rule(
                &self.sources(codex_home, project_folder),
                common_git_folder.as_deref(),
                rule,
                hold,
            )
            .await
        }
        .boxed()
    }

    fn take_back<'call>(
        &'call self,
        project_folder: &'call Path,
        change: &'call CodexProjectRuleWrite,
        hold: &'call KeyHold<'static, PathBuf>,
    ) -> BoxFuture<'call, Result<(), CodexRulesError>> {
        take_back_codex_project_rule(project_folder, change, hold).boxed()
    }
}

/// Holds the edit lock of the project's own rule file in each of `project_folders`, every file in
/// one order, for a write into all of them and any take-back. Fails with `Read` where a file's
/// location cannot be resolved.
pub(crate) async fn hold_codex_project_rule_files(
    project_folders: &[PathBuf],
) -> Result<RuleFileHolds, CodexRulesError> {
    let mut files = Vec::with_capacity(project_folders.len());
    for project_folder in project_folders {
        let lock_key = resolve_lock_key(&project_rule_file(project_folder)).await?;
        files.push((project_folder.clone(), lock_key));
    }
    Ok(RuleFileHolds::acquire(&RULE_FILE_LOCK, files).await)
}

/// What [`write_codex_project_rule`] changed in the project's own rule file, which
/// [`take_back_codex_project_rule`] puts back.
pub(crate) enum CodexProjectRuleWrite {
    /// The rule takes no line, so the file was left as it was.
    Unchanged,
    /// The file was written over `text_before`, its text until then, or made where that is `None`.
    Written {
        /// The file's text before the write, `None` where the write made the file.
        text_before: Option<String>,
    },
}

/// Writes `rule` into the project's own rule file, replacing a rule of the other sense over the
/// same subject; a file the daemon creates is first listed in the exclude list of
/// `common_git_folder`, the repository the project folder belongs to, where it is one, under
/// `_hold`, the file's edit lock. Refuses, with nothing written, a kind Codex keeps no project rule
/// on, a command with no word, a host Codex would refuse and a project whose `.codex` is the Codex
/// home. Answers what it changed, for a take-back.
pub(crate) async fn write_codex_project_rule(
    sources: &CodexRuleSources<'_>,
    common_git_folder: Option<&Path>,
    rule: &ProviderAskRule,
    _hold: &KeyHold<'_, PathBuf>,
) -> Result<CodexProjectRuleWrite, CodexRulesError> {
    let written = compose_rule_lines(rule)?;
    if written.is_empty() {
        return Ok(CodexProjectRuleWrite::Unchanged);
    }
    let opposite = compose_rule_lines(&ProviderAskRule {
        sense: opposite_sense(rule.sense),
        ..rule.clone()
    })?;
    if is_codex_home_project(sources.project_folder, sources.codex_home).await {
        return Err(CodexRulesError::ProjectIsCodexHome);
    }
    let file_path = project_rule_file(sources.project_folder);
    let text_before = read_if_present(&file_path).await?;
    if text_before.is_none()
        && let Some(common_git_folder) = common_git_folder
    {
        add_repository_exclude(common_git_folder, CODEX_PROJECT_RULE_EXCLUDE_PATTERN)
            .await
            .map_err(CodexRulesError::Exclude)?;
    }
    let mut lines: Vec<&str> = rule_lines(text_before.as_deref().unwrap_or_default())
        .filter(|line| {
            !opposite
                .iter()
                .chain(&written)
                .any(|rule_line| rule_line == line)
        })
        .collect();
    lines.extend(written.iter().map(String::as_str));
    write_rule_file(&file_path, &lines).await?;
    Ok(CodexProjectRuleWrite::Written { text_before })
}

/// Puts the project's own rule file back as it was before [`write_codex_project_rule`] made
/// `change`, where a write into another of the project's folders failed: the text it held written
/// back, or the file deleted where the write made it, so a rule the write replaced stands again,
/// under `_hold`, the file's edit lock held since the write. No other rule file is read or touched.
/// Fails as the file cannot be written or deleted.
pub(crate) async fn take_back_codex_project_rule(
    project_folder: &Path,
    change: &CodexProjectRuleWrite,
    _hold: &KeyHold<'_, PathBuf>,
) -> Result<(), CodexRulesError> {
    let text_before = match change {
        CodexProjectRuleWrite::Unchanged => return Ok(()),
        CodexProjectRuleWrite::Written { text_before } => text_before,
    };
    let file_path = project_rule_file(project_folder);
    match text_before {
        Some(text) => rewrite_file_in_place(&file_path, text.clone(), CODEX_RULE_FILE_MODE)
            .await
            .map_err(CodexRulesError::Write),
        None => tokio::fs::remove_file(&file_path)
            .await
            .none_if_missing()
            .map(|_was_there| ())
            .map_err(|failure| CodexRulesError::Delete {
                path: file_path.clone(),
                failure,
            }),
    }
}

/// Takes a revoked rule out of every home and project rule file Codex reads for the project's
/// sessions that makes it, each file held while every edit is checked together and written only
/// once all pass, as [`removal::remove_rule_calls`] does, a file left with no rule deleted. Refuses
/// the rules [`write_codex_project_rule`] refuses; answers `RuleInUneditedFile` where a system rule
/// file makes the rule, since the daemon never edits one and the rule would still apply,
/// `RevokeRefused` where a call that makes it makes another rule too, which a revoke would take
/// with it, or where an edited file would not load or still make it, each changing nothing;
/// `RuleNotFound` where no file makes it; and fails with `Unloadable` where Codex refuses a rule
/// file.
pub(crate) async fn remove_codex_project_rule(
    sources: &CodexRuleSources<'_>,
    rule: &ProviderAskRule,
) -> Result<(), CodexRulesError> {
    compose_rule_lines(rule)?;
    if is_codex_home_project(sources.project_folder, sources.codex_home).await {
        return Err(CodexRulesError::ProjectIsCodexHome);
    }
    let wanted = normalize_rule_subject(rule)?;
    loop {
        let making = read_files_making_rule(sources, &wanted).await?;
        if making.is_empty() {
            return Err(CodexRulesError::RuleNotFound);
        }
        if let Some((system_file, _)) = making
            .iter()
            .find(|(file, _)| file.origin == RuleFileOrigin::System)
        {
            return Err(CodexRulesError::RuleInUneditedFile {
                path: system_file.path.clone(),
            });
        }
        // Every file is held in one order, so two revokes never wait on each other.
        let mut lock_keys = Vec::with_capacity(making.len());
        for (file, _) in &making {
            lock_keys.push(resolve_lock_key(&file.path).await?);
        }
        let _holds = RULE_FILE_LOCK.acquire_all(lock_keys).await;
        // Each file is read again under the holds; where one changed since, the files are read
        // and evaluated again.
        let mut is_unchanged = true;
        for (file, _) in &making {
            if read_if_present(&file.path).await?.as_deref() != Some(file.text.as_str()) {
                is_unchanged = false;
                break;
            }
        }
        if !is_unchanged {
            continue;
        }
        let edits = making
            .into_iter()
            .map(|(file, spans)| removal::RuleFileEdit {
                path: file.path,
                text: file.text,
                spans,
            })
            .collect();
        return removal::remove_rule_calls(sources, edits, |evaluated, _| {
            evaluated.rules.contains(&wanted)
        })
        .await;
    }
}

/// Every allow and block Codex enforces from the project's rule files, read as Codex loads them:
/// each `.rules` file of the system folder's `rules/`, of the Codex home's, then of the project's
/// `.codex/rules/`, each folder in name order, evaluated in turn; none of the project's where Codex
/// does not trust it or its `.codex` is the Codex home. A rule Codex asks on (`prompt`) is neither
/// and is left out. Fails with `Unloadable` naming the first file Codex refuses, or one that did
/// not finish in time, since Codex then drops every rule file's rules.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the standing-rules list, which reads a project's Codex rules for the rule list"
    )
)]
pub(crate) async fn read_codex_project_rules(
    sources: &CodexRuleSources<'_>,
) -> Result<Vec<CodexProjectRule>, CodexRulesError> {
    let files = read_rule_file_texts(sources).await?;
    let mut rules = Vec::new();
    for (file, evaluated) in evaluate_rule_files(files, sources).await? {
        let evaluated = evaluated.map_err(|reason| CodexRulesError::Unloadable {
            path: file.path.clone(),
            reason,
        })?;
        if file.origin == RuleFileOrigin::Project {
            rules.extend(evaluated.rules.into_iter().map(|rule| CodexProjectRule {
                file: file.path.clone(),
                rule,
            }));
        }
    }
    Ok(rules)
}

// Every rule file Codex reads for the project's sessions that makes `wanted`, with the places of
// the calls that make it. Refuses with `RevokeRefused` where one of those calls makes another rule
// too, and fails with `Unloadable` where Codex refuses a file.
async fn read_files_making_rule(
    sources: &CodexRuleSources<'_>,
    wanted: &ProviderAskRule,
) -> Result<Vec<(RuleFileText, Vec<Range<usize>>)>, CodexRulesError> {
    let files = read_rule_file_texts(sources).await?;
    let mut making = Vec::new();
    for (file, evaluated) in evaluate_rule_files(files, sources).await? {
        let evaluated = evaluated.map_err(|reason| CodexRulesError::Unloadable {
            path: file.path.clone(),
            reason,
        })?;
        let mut spans = Vec::new();
        for call in evaluated.calls {
            if !call.rules.contains(wanted) {
                continue;
            }
            if call.rules.iter().any(|made| made != wanted) {
                return Err(CodexRulesError::RevokeRefused {
                    path: file.path,
                    reason: "the call that makes the rule makes other rules too".to_owned(),
                });
            }
            spans.push(call.span);
        }
        if !spans.is_empty() {
            making.push((file, spans));
        }
    }
    Ok(making)
}

// The text of every rule file Codex loads for the project's sessions, in the order it loads them.
async fn read_rule_file_texts(
    sources: &CodexRuleSources<'_>,
) -> Result<Vec<RuleFileText>, CodexRulesError> {
    let mut folders = vec![
        (
            sources.system_folder.join(CODEX_RULES_FOLDER),
            RuleFileOrigin::System,
        ),
        (
            sources.codex_home.join(CODEX_RULES_FOLDER),
            RuleFileOrigin::Home,
        ),
    ];
    if sources.is_project_trusted
        && !is_codex_home_project(sources.project_folder, sources.codex_home).await
    {
        folders.push((
            project_rules_folder(sources.project_folder),
            RuleFileOrigin::Project,
        ));
    }
    let mut files = Vec::new();
    for (folder, origin) in folders {
        for path in list_rule_files(&folder).await? {
            let text = read_rule_file(&path).await?;
            files.push(RuleFileText { path, text, origin });
        }
    }
    Ok(files)
}

// Each file evaluated in turn by one evaluator, as Codex's loader carries one across them, away
// from the async workers, up to the first file Codex refuses, after which Codex loads none.
// The evaluation stops at the sources' time limit; a call that runs on past it without reaching
// starlark's check is left to its thread, and the file it is in reads as one that did not finish.
async fn evaluate_rule_files(
    files: Vec<RuleFileText>,
    sources: &CodexRuleSources<'_>,
) -> Result<Vec<(RuleFileText, Result<EvaluatedRuleFile, String>)>, CodexRulesError> {
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
            file.path.clone_into(&mut lock(&evaluator_running_file));
            let outcome = evaluator.evaluate(&file.path.to_string_lossy(), &file.text, deadline);
            let is_refused = outcome.is_err();
            evaluated.push((file, outcome));
            if is_refused {
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
        let path = lock(&running_file).clone();
        return Err(CodexRulesError::Unloadable {
            path,
            reason: "did not finish".to_owned(),
        });
    };
    finished.map_err(CodexRulesError::EvaluationStopped)
}

// Whether `project_folder`'s `.codex` folder is `codex_home`, as written or once resolved, which
// Codex never reads as a project's.
async fn is_codex_home_project(project_folder: &Path, codex_home: &Path) -> bool {
    let project_settings = project_folder.join(CODEX_PROJECT_SETTINGS_FOLDER);
    if project_settings == codex_home {
        return true;
    }
    // A path that does not resolve is compared as written, as Codex's loader compares it.
    let resolve = |path: PathBuf| async move { resolve_real_location(&path).await.unwrap_or(path) };
    resolve(project_settings).await == resolve(codex_home.to_path_buf()).await
}

// A rule file as its lock knows it, one key for every spelling of the file.
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
        ToolCallActionKind::Command => rule
            .subject
            .split(is_ecmascript_whitespace)
            .filter(|word| !word.is_empty())
            .collect::<Vec<_>>()
            .join(" "),
        ToolCallActionKind::Network => {
            normalize_network_rule_host(&rule.subject).map_err(CodexRulesError::RefusedHost)?
        }
        ToolCallActionKind::CommandInput
        | ToolCallActionKind::FileChange
        | ToolCallActionKind::FileRead
        | ToolCallActionKind::Search
        | ToolCallActionKind::Tool => {
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
        ToolCallActionKind::Command => {
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
        ToolCallActionKind::Network => {
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
                        "network_rule(host={host}, \
                         protocol=\"{protocol}\", decision=\"{decision}\")"
                    )
                })
                .collect())
        }
        ToolCallActionKind::CommandInput
        | ToolCallActionKind::FileChange
        | ToolCallActionKind::FileRead
        | ToolCallActionKind::Search
        | ToolCallActionKind::Tool => Err(CodexRulesError::UnkeptKind(rule.action.into())),
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
        let has_port = rest.strip_prefix(':').is_some_and(is_digits);
        if !rest.is_empty() && !has_port {
            return Err(format!(
                "network_rule host contains an unsupported suffix: {raw}"
            ));
        }
        host = inside;
    } else if host.matches(':').count() == 1
        && let Some((candidate, port)) = host.rsplit_once(':')
        && !candidate.is_empty()
        && is_digits(port)
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
    rewrite_file_in_place(file_path, text, CODEX_RULE_FILE_MODE)
        .await
        .map_err(CodexRulesError::Write)
}

#[cfg(test)]
mod tests;
