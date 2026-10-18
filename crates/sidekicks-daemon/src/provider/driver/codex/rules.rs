//! A project's standing rules as Codex keeps them, in the `.rules` files of the project's
//! `.codex/rules/`, which Codex reads in conversations started after a change. The daemon writes
//! one file of its own there, holding a command's `prefix_rule` and a host's `network_rule`, and
//! lists it in the repository's own exclude list so it stays on this machine. Codex drops every
//! user and project rule when one rule file does not load, so a rule Codex would refuse is refused
//! before anything is written. A command allow a prefix rule would stretch over a force push or a
//! branch delete is never written: the daemon answers each ask it covers. The rules in force are
//! read from every rule file, the person's own among them, through Codex's own grammar.

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::approval::{RememberedRuleSense, RememberedScopeKind};
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use starlark_syntax::syntax::ast::{ArgumentP, AstExpr, AstLiteral, ExprP, StmtP};
use starlark_syntax::syntax::top_level_stmts::top_level_stmts;
use starlark_syntax::syntax::{AstModule, Dialect};

use crate::file::atomic_write::{AtomicWriteError, write_file_atomically};
use crate::git::exclude::{ExcludeError, add_repository_exclude};
use crate::keyed_lock::KeyedLock;
use crate::missing_entry::MissingEntry;
use crate::policy::destructive_git::covers_destructive_git;
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
    /// A rule file is not one Codex loads, so Codex keeps none of the project's rules.
    #[error("Codex does not load the rule file {}", path.display())]
    Unloadable {
        /// The rule file.
        path: PathBuf,
        /// Why Codex refuses it.
        #[source]
        failure: Box<dyn Error + Send + Sync>,
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

/// Writes `rule` into the project's own rule file, replacing a rule of the other sense over the
/// same subject, after listing the file in the exclude list of `common_git_folder`, the repository
/// the project folder belongs to, where it is one. Holds `lock` on each file across its read and
/// write. Refuses, with nothing written, a kind Codex keeps no project rule on, a command with no
/// word and a host Codex would refuse.
pub(crate) async fn write_codex_project_rule(
    project_folder: &Path,
    common_git_folder: Option<&Path>,
    rule: &ProviderAskRule,
    lock: &KeyedLock<PathBuf>,
) -> Result<(), CodexRulesError> {
    let written = compose_rule_lines(rule)?;
    if written.is_empty() {
        return Ok(());
    }
    let opposite = compose_rule_lines(&ProviderAskRule {
        sense: opposite_sense(rule.sense),
        ..rule.clone()
    })?;
    if let Some(common_git_folder) = common_git_folder {
        add_repository_exclude(common_git_folder, CODEX_PROJECT_RULE_EXCLUDE_PATTERN, lock)
            .await
            .map_err(CodexRulesError::Exclude)?;
    }
    let file_path = project_rule_file(project_folder);
    let _hold = lock.acquire(file_path.clone()).await;
    let text = read_if_present(&file_path).await?.unwrap_or_default();
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

/// Removes a revoked rule from the project's own rule file, holding `lock` on it; a folder with no
/// such file holds none, and no file is made for it. Refuses the rules
/// [`write_codex_project_rule`] refuses.
pub(crate) async fn remove_codex_project_rule(
    project_folder: &Path,
    rule: &ProviderAskRule,
    lock: &KeyedLock<PathBuf>,
) -> Result<(), CodexRulesError> {
    let removed = compose_rule_lines(rule)?;
    let file_path = project_rule_file(project_folder);
    let _hold = lock.acquire(file_path.clone()).await;
    let Some(text) = read_if_present(&file_path).await? else {
        return Ok(());
    };
    let lines: Vec<&str> = rule_lines(&text)
        .filter(|line| !removed.iter().any(|rule_line| rule_line == line))
        .collect();
    write_rule_file(&file_path, &lines).await
}

/// Every allow and block in the project's rule files, read as Codex reads them: each `.rules` file
/// in `.codex/rules/`, in name order. A rule Codex asks on (`prompt`) is neither and is left out,
/// as is one built by a loop, a variable or a function, which only running the file would show.
/// Fails when a file does not parse or holds a rule Codex refuses, since Codex then keeps no rule
/// of the project at all.
pub(crate) async fn read_codex_project_rules(
    project_folder: &Path,
) -> Result<Vec<CodexProjectRule>, CodexRulesError> {
    let folder = CODEX_RULES_FOLDER
        .iter()
        .fold(project_folder.to_path_buf(), |path, part| path.join(part));
    let read_failure = |failure| CodexRulesError::Read {
        path: folder.clone(),
        failure,
    };
    let Some(mut entries) = tokio::fs::read_dir(&folder)
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
    let mut rules = Vec::new();
    for file in files {
        let text =
            tokio::fs::read_to_string(&file)
                .await
                .map_err(|failure| CodexRulesError::Read {
                    path: file.clone(),
                    failure,
                })?;
        let file_rules =
            read_rule_file(&file, text).map_err(|failure| CodexRulesError::Unloadable {
                path: file.clone(),
                failure,
            })?;
        rules.extend(file_rules.into_iter().map(|rule| CodexProjectRule {
            file: file.clone(),
            rule,
        }));
    }
    Ok(rules)
}

fn project_rule_file(project_folder: &Path) -> PathBuf {
    CODEX_RULES_FOLDER
        .iter()
        .fold(project_folder.to_path_buf(), |path, part| path.join(part))
        .join(CODEX_PROJECT_RULE_FILE_NAME)
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

// One rule file's allows and blocks, from the calls at its top level whose arguments are written
// out; a file Codex would refuse is an error.
fn read_rule_file(
    file: &Path,
    text: String,
) -> Result<Vec<ProviderAskRule>, Box<dyn Error + Send + Sync>> {
    let dialect = Dialect {
        enable_f_strings: true,
        ..Dialect::Extended
    };
    let module = AstModule::parse(&file.to_string_lossy(), text, &dialect)
        .map_err(|failure| Box::<dyn Error + Send + Sync>::from(failure.into_anyhow()))?;
    let mut rules: Vec<ProviderAskRule> = Vec::new();
    for statement in top_level_stmts(module.statement()) {
        let StmtP::Expression(expression) = &**statement else {
            continue;
        };
        let ExprP::Call(callee, call) = &**expression else {
            continue;
        };
        let ExprP::Identifier(name) = &***callee else {
            continue;
        };
        let read = match name.ident.as_str() {
            "prefix_rule" => read_prefix_rule(&call.args)?,
            "network_rule" => read_network_rule(&call.args)?,
            _ => continue,
        };
        for rule in read {
            if !rules.contains(&rule) {
                rules.push(rule);
            }
        }
    }
    Ok(rules)
}

// The arguments of a call by its parameters' names, positional ones in the parameters' order;
// `None` when one is computed or passed with `*` or `**`, which only running the file would read.
fn read_call_arguments<'call>(
    arguments: &'call [starlark_syntax::syntax::ast::AstArgument],
    parameters: &[&str],
) -> Option<Vec<(String, &'call AstExpr)>> {
    let mut read = Vec::with_capacity(arguments.len());
    for (index, argument) in arguments.iter().enumerate() {
        match &argument.node {
            ArgumentP::Positional(value) => {
                read.push(((*parameters.get(index)?).to_owned(), value));
            }
            ArgumentP::Named(name, value) => read.push((name.node.clone(), value)),
            ArgumentP::Args(_) | ArgumentP::KwArgs(_) => return None,
        }
    }
    Some(read)
}

fn read_string_literal(expression: &AstExpr) -> Option<&str> {
    if let ExprP::Literal(AstLiteral::String(text)) = &expression.node {
        Some(&text.node)
    } else {
        None
    }
}

// A `prefix_rule` as Codex's own builtin reads it: a non-empty pattern of words or lists of
// alternative words, each alternative making a rule of its own, and a decision of `allow` (the
// default), `prompt` or `forbidden`.
fn read_prefix_rule(
    arguments: &[starlark_syntax::syntax::ast::AstArgument],
) -> Result<Vec<ProviderAskRule>, Box<dyn Error + Send + Sync>> {
    let Some(arguments) = read_call_arguments(
        arguments,
        &["pattern", "decision", "match", "not_match", "justification"],
    ) else {
        return Ok(Vec::new());
    };
    let mut pattern = None;
    let mut sense = Some(RememberedRuleSense::Allow);
    for (name, value) in arguments {
        match name.as_str() {
            "pattern" => {
                let ExprP::List(tokens) = &value.node else {
                    return Ok(Vec::new());
                };
                let mut alternatives = Vec::with_capacity(tokens.len());
                for token in tokens {
                    let token_alternatives = if let ExprP::List(words) = &token.node {
                        words
                            .iter()
                            .map(read_string_literal)
                            .collect::<Option<Vec<&str>>>()
                    } else {
                        read_string_literal(token).map(|word| vec![word])
                    };
                    let Some(token_alternatives) = token_alternatives else {
                        return Ok(Vec::new());
                    };
                    if token_alternatives.is_empty() {
                        return Err("a pattern's alternatives are empty".into());
                    }
                    alternatives.push(token_alternatives);
                }
                if alternatives.is_empty() {
                    return Err("a pattern is empty".into());
                }
                pattern = Some(alternatives);
            }
            "decision" => {
                sense = match read_string_literal(value) {
                    Some("allow") => Some(RememberedRuleSense::Allow),
                    Some("forbidden") => Some(RememberedRuleSense::Block),
                    Some("prompt") => None,
                    Some(_) => return Err("a prefix rule's decision is not one Codex reads".into()),
                    None => return Ok(Vec::new()),
                };
            }
            _ => {}
        }
    }
    let (Some(pattern), Some(sense)) = (pattern, sense) else {
        return Ok(Vec::new());
    };
    let mut subjects = vec![String::new()];
    for alternatives in pattern {
        subjects = subjects
            .iter()
            .flat_map(|prefix| {
                alternatives.iter().map(move |word| {
                    if prefix.is_empty() {
                        (*word).to_owned()
                    } else {
                        format!("{prefix} {word}")
                    }
                })
            })
            .collect();
    }
    Ok(subjects
        .into_iter()
        .map(|subject| ProviderAskRule {
            kind: RememberedScopeKind::Project,
            sense,
            action: ProviderAskActionKind::Command,
            subject,
        })
        .collect())
}

// A `network_rule` as Codex's own builtin reads it: a host Codex keeps, a protocol it knows and a
// decision of `allow`, `prompt`, or `deny` or `forbidden`.
fn read_network_rule(
    arguments: &[starlark_syntax::syntax::ast::AstArgument],
) -> Result<Vec<ProviderAskRule>, Box<dyn Error + Send + Sync>> {
    let Some(arguments) = read_call_arguments(
        arguments,
        &["host", "protocol", "decision", "justification"],
    ) else {
        return Ok(Vec::new());
    };
    let mut host = None;
    let mut sense = None;
    for (name, value) in arguments {
        let Some(text) = read_string_literal(value) else {
            return Ok(Vec::new());
        };
        match name.as_str() {
            "host" => host = Some(normalize_network_rule_host(text)?),
            "protocol" => {
                if !matches!(
                    text,
                    "http"
                        | "https"
                        | "https_connect"
                        | "http-connect"
                        | "socks5_tcp"
                        | "socks5_udp"
                ) {
                    return Err("a network rule's protocol is not one Codex reads".into());
                }
            }
            "decision" => {
                sense = match text {
                    "allow" => Some(RememberedRuleSense::Allow),
                    "deny" | "forbidden" => Some(RememberedRuleSense::Block),
                    "prompt" => None,
                    _ => return Err("a network rule's decision is not one Codex reads".into()),
                };
            }
            _ => {}
        }
    }
    let (Some(host), Some(sense)) = (host, sense) else {
        return Ok(Vec::new());
    };
    Ok(vec![ProviderAskRule {
        kind: RememberedScopeKind::Project,
        sense,
        action: ProviderAskActionKind::Network,
        subject: host,
    }])
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use sidekicks_contracts::approval::{RememberedRuleSense, RememberedScopeKind};

    use super::{
        CodexRulesError, read_codex_project_rules, remove_codex_project_rule,
        write_codex_project_rule,
    };
    use crate::keyed_lock::KeyedLock;
    use crate::provider::port::permission_ask::{ProviderAskActionKind, ProviderAskRule};

    fn rule(
        sense: RememberedRuleSense,
        action: ProviderAskActionKind,
        subject: &str,
    ) -> ProviderAskRule {
        ProviderAskRule {
            kind: RememberedScopeKind::Project,
            sense,
            action,
            subject: subject.to_owned(),
        }
    }

    fn rule_file(project_folder: &Path) -> PathBuf {
        project_folder.join(".codex/rules/sidekicks.rules")
    }

    #[tokio::test]
    async fn a_block_replaces_the_allow_and_the_file_is_excluded_once() {
        let project = tempfile::tempdir().expect("a project folder");
        let git_folder = tempfile::tempdir().expect("a git folder");
        let lock = KeyedLock::<PathBuf>::new();
        let allow = rule(
            RememberedRuleSense::Allow,
            ProviderAskActionKind::Network,
            "example.com",
        );
        let block = rule(
            RememberedRuleSense::Block,
            ProviderAskActionKind::Network,
            "example.com",
        );
        let command = rule(
            RememberedRuleSense::Allow,
            ProviderAskActionKind::Command,
            "npm  test",
        );

        for written in [&allow, &command, &block] {
            write_codex_project_rule(project.path(), Some(git_folder.path()), written, &lock)
                .await
                .expect("the rule is written");
        }

        assert_eq!(
            std::fs::read_to_string(rule_file(project.path())).expect("the rule file reads"),
            "prefix_rule(pattern=[\"npm\", \"test\"], decision=\"allow\")\n\
             network_rule(host=\"example.com\", protocol=\"https\", decision=\"deny\")\n\
             network_rule(host=\"example.com\", protocol=\"http\", decision=\"deny\")\n"
        );
        assert_eq!(
            std::fs::read_to_string(git_folder.path().join("info/exclude"))
                .expect("the exclude list reads"),
            "/.codex/rules/sidekicks.rules\n"
        );

        remove_codex_project_rule(project.path(), &block, &lock)
            .await
            .expect("the block is removed");
        assert_eq!(
            read_codex_project_rules(project.path())
                .await
                .expect("the rules read")
                .into_iter()
                .map(|kept| kept.rule)
                .collect::<Vec<_>>(),
            [rule(
                RememberedRuleSense::Allow,
                ProviderAskActionKind::Command,
                "npm test"
            )]
        );
    }

    #[rstest]
    #[case::the_whole_of_git(ProviderAskActionKind::Command, "git", None)]
    #[case::a_push(ProviderAskActionKind::Command, "git push", None)]
    #[case::a_branch_change(ProviderAskActionKind::Command, "git branch", None)]
    #[case::no_word(
        ProviderAskActionKind::Command,
        " \u{3000}",
        Some("a command rule names no word")
    )]
    #[case::a_url(
        ProviderAskActionKind::Network,
        "https://x",
        Some("Codex refuses this network rule's host: the host names a scheme or a path")
    )]
    #[case::a_wildcard(
        ProviderAskActionKind::Network,
        "*.example.com",
        Some("Codex refuses this network rule's host: the host holds a wildcard")
    )]
    #[case::a_file(
        ProviderAskActionKind::FileChange,
        "src/a.rs",
        Some("Codex keeps no project rule on a fileChange ask")
    )]
    #[tokio::test]
    async fn an_allow_codex_would_stretch_or_refuse_leaves_the_file_untouched(
        #[case] action: ProviderAskActionKind,
        #[case] subject: &str,
        #[case] refusal: Option<&str>,
    ) {
        let project = tempfile::tempdir().expect("a project folder");
        let existing = "prefix_rule(pattern=[\"ls\"], decision=\"allow\")\n";
        std::fs::create_dir_all(project.path().join(".codex/rules")).expect("the folder is made");
        std::fs::write(rule_file(project.path()), existing).expect("the rule file is written");

        let outcome = write_codex_project_rule(
            project.path(),
            None,
            &rule(RememberedRuleSense::Allow, action, subject),
            &KeyedLock::new(),
        )
        .await;

        assert_eq!(
            outcome
                .err()
                .map(|error: CodexRulesError| error.to_string())
                .as_deref(),
            refusal
        );
        assert_eq!(
            std::fs::read_to_string(rule_file(project.path())).expect("the rule file reads"),
            existing
        );
    }

    #[tokio::test]
    async fn the_persons_own_rule_files_are_read_as_codex_reads_them() {
        let project = tempfile::tempdir().expect("a project folder");
        let folder = project.path().join(".codex/rules");
        std::fs::create_dir_all(&folder).expect("the folder is made");
        std::fs::write(
            folder.join("team.rules"),
            "prefix_rule(pattern = [[\"npm\", \"pnpm\"], \"install\"])\n\
             prefix_rule([\"rm\"], \"forbidden\")\n\
             prefix_rule(pattern = [\"curl\"], decision = \"prompt\")\n\
             for tool in [\"cargo\"]:\n    prefix_rule(pattern = [tool])\n\
             network_rule(host = \"Example.COM:443\", protocol = \"https\", decision = \"deny\")\n",
        )
        .expect("the person's file is written");
        std::fs::write(folder.join("notes.txt"), "not a rule file").expect("a note is written");

        let rules: Vec<ProviderAskRule> = read_codex_project_rules(project.path())
            .await
            .expect("the rules read")
            .into_iter()
            .map(|kept| kept.rule)
            .collect();

        assert_eq!(
            rules,
            [
                rule(
                    RememberedRuleSense::Allow,
                    ProviderAskActionKind::Command,
                    "npm install"
                ),
                rule(
                    RememberedRuleSense::Allow,
                    ProviderAskActionKind::Command,
                    "pnpm install"
                ),
                rule(
                    RememberedRuleSense::Block,
                    ProviderAskActionKind::Command,
                    "rm"
                ),
                rule(
                    RememberedRuleSense::Block,
                    ProviderAskActionKind::Network,
                    "example.com"
                ),
            ]
        );

        std::fs::write(folder.join("broken.rules"), "prefix_rule(pattern = [\n")
            .expect("a broken file is written");
        assert!(matches!(
            read_codex_project_rules(project.path()).await,
            Err(CodexRulesError::Unloadable { .. })
        ));
    }
}
