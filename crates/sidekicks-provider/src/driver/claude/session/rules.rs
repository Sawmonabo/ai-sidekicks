//! A session's standing rules as Claude Code keeps them. A session rule lives in the process's flag
//! settings, which carry the session's whole allow and deny lists, so a grant, a block and a revoke
//! each resend the whole permissions document. A project rule lives in the project's
//! `.claude/settings.local.json`, which Claude Code keeps at the repository's root (a worktree's
//! main checkout) and otherwise beside `.claude/settings.json`, and reads from both places: Claude
//! Code writes an allow there itself when the answer carries it, and the daemon writes it for the
//! project's other folders, writes a host's block, which a decline cannot carry, and removes a
//! revoked rule. The file is edited in place, every other byte kept, and a file that is not a
//! strict JSON object is refused, never overwritten. A command allow a prefix rule would stretch
//! over a force push or a branch delete is never handed over: the daemon answers each ask it
//! covers.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use jsonc_parser::cst::{CstInputValue, CstNode, CstObject};
use serde::Serialize;
use sidekicks_contracts::approval::RememberedRuleSense;
use sidekicks_platforms::PathRules;

use crate::driver::claude::session::ignored_settings::list_managed_settings_files;
use crate::driver::claude::session::settings_file::{
    ClaudeSettingsFileError, edit_settings_object, hold_settings_file, read_claude_settings_file,
    read_settings_file, write_settings_file,
};
use crate::mcp::tool_name::TOOL_SERVER_TOOL_PREFIX;
use crate::project_rule_folders::write_into_project_folders;
use sidekicks_policy::ask_rule::{ProviderAskActionKind, ProviderAskRule};
use sidekicks_policy::destructive_git::covers_destructive_git;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::mutex_lock::lock;
use sidekicks_workspace::git::exclude::{ExcludeError, add_repository_exclude};

// The project's own settings file Claude Code keeps on this machine, from a folder, and its exclude
// line, read from the worktree's root.
const CLAUDE_LOCAL_SETTINGS_FILE: [&str; 2] = [".claude", "settings.local.json"];
const CLAUDE_LOCAL_SETTINGS_EXCLUDE_PATTERN: &str = "/.claude/settings.local.json";

/// The project's shared settings file, from a folder, which the person commits and the daemon never
/// edits; under a home folder, the person's own settings file.
pub(crate) const CLAUDE_SHARED_SETTINGS_FILE: [&str; 2] = [".claude", "settings.json"];

// The person's own settings file in a Claude Code home's config folder, which the daemon never
// edits.
const CLAUDE_USER_SETTINGS_FILE: &str = "settings.json";

// The name Claude Code gives a connector it fetches itself starts so, and is written more tightly.
const CLAUDE_CONNECTOR_SERVER_PREFIX: &str = "claude.ai ";

// The local settings file is the person's own, readable as Claude Code leaves it.
const CLAUDE_LOCAL_SETTINGS_MODE: u32 = 0o644;

// The characters a gitignore pattern reads as more than themselves, escaped in a path rule so it
// matches only the path the card named.
const GITIGNORE_SPECIAL_CHARACTERS: [char; 5] = ['[', ']', '*', '?', '\\'];

/// Why a Claude Code rule could not be composed, written or removed. No variant quotes a settings
/// file's text.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeRulesError {
    /// Claude Code keeps no rule on this kind of ask.
    #[error("Claude Code keeps no rule on a {0} ask")]
    UnkeptKind(&'static str),
    /// A settings file could not be read, written, or edited as a strict JSON object with
    /// permission lists, so it is left as it is.
    #[error(transparent)]
    SettingsFile(#[from] ClaudeSettingsFileError),
    /// The settings file could not be listed in the repository's exclude list.
    #[error("keeping the project's local settings out of commits failed")]
    Exclude(#[source] ExcludeError),
    /// A revoked rule is in no local settings file, nor in a file the daemon does not edit.
    #[error("the rule is in none of the project's settings files")]
    RuleNotFound,
    /// A revoked rule is kept in a settings file the daemon never edits, so it still applies.
    #[error("the rule is kept in {}, which the daemon does not edit", path.display())]
    RuleInUneditedFile {
        /// The file that keeps it.
        path: PathBuf,
    },
}

/// One Claude Code permission rule: its tool and, where it names one, what the rule matches, as an
/// `addRules` update carries it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudePermissionRuleValue {
    /// The tool.
    pub(crate) tool_name: String,
    /// What the rule matches, where it names anything.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rule_content: Option<String>,
}

/// The permission update an approval's answer carries so Claude Code writes the project allow into
/// its own local settings file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename = "addRules", rename_all = "camelCase")]
pub(crate) struct ClaudeProjectAllowUpdate {
    /// The rules to add.
    pub(crate) rules: Vec<ClaudePermissionRuleValue>,
    /// Always `allow`.
    pub(crate) behavior: &'static str,
    /// Always `localSettings`.
    pub(crate) destination: &'static str,
}

/// The session's own rules as the flag settings' `permissions` carry them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ClaudeSessionRuleLists {
    /// The allow list.
    pub(crate) allow: Vec<String>,
    /// The deny list.
    pub(crate) deny: Vec<String>,
}

/// A working folder of the project, with what Claude Code reads to place its local settings.
pub(crate) struct ClaudeProjectFolder<'a> {
    /// The folder a session starts in, a worktree's root or the project's checkout.
    pub(crate) working_folder: &'a Path,
    /// The repository the folder belongs to, `None` outside git.
    pub(crate) repository: Option<ClaudeRepository<'a>>,
}

/// What Claude Code reads of a working folder's repository.
pub(crate) struct ClaudeRepository<'a> {
    /// The repository's root, the main checkout's for a worktree.
    pub(crate) root: &'a Path,
    /// The repository's common git folder, which holds its exclude list.
    pub(crate) common_git_folder: &'a Path,
    /// Whether the person owns the root and its `.git` and `.claude` entries.
    pub(crate) is_owned_by_user: bool,
}

/// The local settings file Claude Code keeps for one working folder, and the common git folder of
/// its repository where it is in one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeLocalSettingsFile {
    /// The file.
    pub(crate) path: PathBuf,
    /// The repository's common git folder.
    pub(crate) common_git_folder: Option<PathBuf>,
}

/// Where Claude Code keeps `folder`'s local settings in a place that spells paths by `path_rules`
/// and whose home is `home_folder`: at the repository's root, except outside git, on Windows, at a
/// root that is the home folder, or at one the person does not own, where it stays in the working
/// folder beside `.claude/settings.json`.
pub(crate) fn resolve_claude_local_settings_file(
    folder: &ClaudeProjectFolder<'_>,
    home_folder: &Path,
    path_rules: PathRules,
) -> ClaudeLocalSettingsFile {
    let anchor = match &folder.repository {
        Some(repository)
            if path_rules != PathRules::Windows
                && repository.root != home_folder
                && repository.is_owned_by_user =>
        {
            repository.root
        }
        Some(_) | None => folder.working_folder,
    };
    ClaudeLocalSettingsFile {
        path: local_settings_path(anchor),
        common_git_folder: folder
            .repository
            .as_ref()
            .map(|repository| repository.common_git_folder.to_path_buf()),
    }
}

/// The session's own rules as the flag settings' `allow` and `deny` lists carry them, each path in
/// the words of a place that spells paths by `path_rules`. Refuses a kind Claude Code keeps no rule
/// on.
pub(crate) fn compose_claude_session_rule_lists(
    rules: &[ProviderAskRule],
    path_rules: PathRules,
) -> Result<ClaudeSessionRuleLists, ClaudeRulesError> {
    let mut lists = ClaudeSessionRuleLists::default();
    for rule in rules {
        let list = match rule.sense {
            RememberedRuleSense::Allow => &mut lists.allow,
            RememberedRuleSense::Block => &mut lists.deny,
        };
        list.extend(
            compose_rule_values(rule, path_rules)?
                .iter()
                .map(write_rule_value),
        );
    }
    Ok(lists)
}

/// The update an approval's answer carries so Claude Code writes the project allow `rule`, or
/// `None` for an allow never handed over. Refuses a kind Claude Code keeps no rule on.
pub(crate) fn compose_claude_project_allow_update(
    rule: &ProviderAskRule,
    path_rules: PathRules,
) -> Result<Option<ClaudeProjectAllowUpdate>, ClaudeRulesError> {
    let rules = compose_rule_values(rule, path_rules)?;
    Ok((!rules.is_empty()).then_some(ClaudeProjectAllowUpdate {
        rules,
        behavior: "allow",
        destination: "localSettings",
    }))
}

/// Adds a project rule once to the local settings file of each of `folders`, in the list of its
/// sense, taking the same entries out of the other list so an allow and a block never stand
/// together; `written_by_answer`, the resolved file Claude Code itself writes for the answer's
/// allow (the repository root's in the normal case), is skipped, and taken back with the rest when
/// a later file fails. A file the daemon creates in a repository is first listed in its exclude
/// list, each repository's list read once per call. One edit at a time on each file.
pub(crate) async fn write_claude_project_rule(
    folders: &[ClaudeProjectFolder<'_>],
    home_folder: &Path,
    path_rules: PathRules,
    rule: &ProviderAskRule,
    written_by_answer: Option<&Path>,
) -> Result<(), CleanupFailures<ClaudeRulesError>> {
    let mut common_git_folders: HashMap<PathBuf, Option<PathBuf>> = HashMap::new();
    let mut files = Vec::new();
    for folder in folders {
        let resolved = resolve_claude_local_settings_file(folder, home_folder, path_rules);
        if Some(resolved.path.as_path()) != written_by_answer
            && !common_git_folders.contains_key(&resolved.path)
        {
            files.push(resolved.path.clone());
        }
        common_git_folders.insert(resolved.path, resolved.common_git_folder);
    }
    let written_already: Vec<PathBuf> = written_by_answer
        .map(Path::to_path_buf)
        .into_iter()
        .collect();
    let excluded_repositories = Arc::new(Mutex::new(HashSet::new()));
    write_into_project_folders(
        &files,
        rule,
        |file: &Path, rule: &ProviderAskRule| {
            let common_git_folder = common_git_folders.get(file).cloned().flatten();
            let excluded_repositories = Arc::clone(&excluded_repositories);
            async move {
                let written = rule_entries(rule, path_rules)?;
                let (list, other_list) = sense_lists(rule.sense);
                edit_local_settings(
                    file,
                    common_git_folder.as_deref(),
                    &excluded_repositories,
                    &[
                        ListChange {
                            list: other_list,
                            add: &[],
                            remove: &written,
                        },
                        ListChange {
                            list,
                            add: &written,
                            remove: &[],
                        },
                    ],
                )
                .await
            }
            .boxed()
        },
        |file: &Path, rule: &ProviderAskRule| {
            async move {
                remove_rule_from_file(file, rule, path_rules)
                    .await
                    .map(|_is_removed| ())
            }
            .boxed()
        },
        &written_already,
    )
    .await
}

/// Removes a revoked project rule from the local settings of each of `folders`: the file Claude
/// Code keeps for the folder and the one in the folder itself, since Claude Code applies the rules
/// of both. A file that does not exist holds none and is not made. First searches every file
/// Claude Code reads and the daemon does not edit, the managed settings in
/// `managed_settings_folder` with every drop-in, the user settings of `config_folder` and each
/// folder's shared `.claude/settings.json`: where one keeps the rule it answers
/// `RuleInUneditedFile` and changes nothing, since the rule would still apply. Refuses a rule no
/// file holds with `RuleNotFound`, and fails as a file or the drop-in folder cannot be read.
pub(crate) async fn remove_claude_project_rule(
    folders: &[ClaudeProjectFolder<'_>],
    managed_settings_folder: Option<&Path>,
    config_folder: &Path,
    home_folder: &Path,
    path_rules: PathRules,
    rule: &ProviderAskRule,
) -> Result<(), ClaudeRulesError> {
    let entries = rule_entries(rule, path_rules)?;
    let (list, _) = sense_lists(rule.sense);
    let mut managed_files = Vec::new();
    if let Some(folder) = managed_settings_folder {
        let mut failures = Vec::new();
        managed_files = list_managed_settings_files(folder, &mut failures).await;
        if let Some(unlisted) = failures.pop() {
            return Err(ClaudeSettingsFileError::Read {
                path: unlisted.path,
                failure: unlisted.failure,
            }
            .into());
        }
    }
    let unedited_files = managed_files
        .into_iter()
        .chain([config_folder.join(CLAUDE_USER_SETTINGS_FILE)])
        .chain(
            folders
                .iter()
                .map(|folder| settings_path(folder.working_folder, CLAUDE_SHARED_SETTINGS_FILE)),
        );
    for file in unedited_files {
        let settings = read_claude_settings_file(&file).await.map_err(|failure| {
            ClaudeSettingsFileError::Read {
                path: file.clone(),
                failure,
            }
        })?;
        let is_kept = settings
            .as_ref()
            .and_then(|settings| settings.get("permissions")?.get(list)?.as_array())
            .is_some_and(|kept| {
                kept.iter()
                    .any(|kept| entries.iter().any(|entry| kept.as_str() == Some(entry)))
            });
        if is_kept {
            return Err(ClaudeRulesError::RuleInUneditedFile { path: file });
        }
    }
    let mut is_removed = false;
    for file in every_local_settings_file(folders, home_folder, path_rules) {
        is_removed |= remove_rule_from_file(&file, rule, path_rules).await?;
    }
    if is_removed {
        Ok(())
    } else {
        Err(ClaudeRulesError::RuleNotFound)
    }
}

/// Removes every allow and block over a removed tool server's tools from the local settings of
/// each of `folders`, both of each folder's files as [`remove_claude_project_rule`] reads them.
/// The server is named as Claude Code names it in its tools, so only that server's rules go.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the removal of a tool server clears its rules through it"
    )
)]
pub(crate) async fn remove_claude_tool_server_rules(
    folders: &[ClaudeProjectFolder<'_>],
    home_folder: &Path,
    path_rules: PathRules,
    server_name: &str,
) -> Result<(), ClaudeRulesError> {
    let server_name = compose_claude_tool_server_name(server_name);
    let is_server_rule = |entry: &str| is_claude_tool_server_rule(entry, &server_name);
    for file in every_local_settings_file(folders, home_folder, path_rules) {
        let hold = hold_settings_file(&file).await?;
        let Some(text) = read_settings_file(&hold, &file).await? else {
            continue;
        };
        if let Some(edited) = edit_permission_lists(&file, &text, |permissions, path| {
            let mut is_changed = false;
            for list in ["allow", "deny"] {
                is_changed |= remove_entries(permissions, list, path, is_server_rule)?;
            }
            Ok(is_changed)
        })? {
            write_settings_file(&hold, &file, edited, CLAUDE_LOCAL_SETTINGS_MODE).await?;
        }
    }
    Ok(())
}

// A server's name as Claude Code writes it into its tools' names: each UTF-16 unit outside ASCII
// letters, digits, `_` and `-` read as `_`, and a connector's name, which starts `claude.ai `, with
// each run of `_` made one and the `_` at either end dropped.
fn compose_claude_tool_server_name(server_name: &str) -> String {
    let mut name = String::with_capacity(server_name.len());
    for character in server_name.chars() {
        if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
            name.push(character);
        } else {
            // A character past U+FFFF is two UTF-16 units, each of which becomes `_`.
            name.extend(std::iter::repeat_n('_', character.len_utf16()));
        }
    }
    if !server_name.starts_with(CLAUDE_CONNECTOR_SERVER_PREFIX) {
        return name;
    }
    let mut collapsed = String::with_capacity(name.len());
    for character in name.chars() {
        if !(character == '_' && collapsed.ends_with('_')) {
            collapsed.push(character);
        }
    }
    let trimmed = collapsed.strip_prefix('_').unwrap_or(&collapsed);
    trimmed.strip_suffix('_').unwrap_or(trimmed).to_owned()
}

// Whether a rule names the tool server Claude Code calls `server_name`, split as Claude Code splits
// a rule at each `__` (the server the piece after `mcp`, the tool the rest): its wildcard
// `mcp__<server>__*`, its whole-server `mcp__<server>`, read as that server's only while the name
// holds no `__`, and a tool's `mcp__<server>__<tool>`. A tool piece holding `__` or starting `_` is
// a longer name's rule, `mcp__<server>__v2__*` or `mcp__<server>___*`, the one Claude Code's
// documentation has a name ending in `_` write, so it stays with the server that name names.
fn is_claude_tool_server_rule(entry: &str, server_name: &str) -> bool {
    let Some(rest) = entry
        .strip_prefix(TOOL_SERVER_TOOL_PREFIX)
        .and_then(|rest| rest.strip_prefix(server_name))
    else {
        return false;
    };
    match rest.strip_prefix("__") {
        Some(tool) => {
            tool == "*" || (!tool.is_empty() && !tool.starts_with('_') && !tool.contains("__"))
        }
        None => rest.is_empty() && !server_name.contains("__"),
    }
}

/// The local settings file in `folder` itself.
pub(crate) fn local_settings_path(folder: &Path) -> PathBuf {
    settings_path(folder, CLAUDE_LOCAL_SETTINGS_FILE)
}

/// The settings `file` under `folder`.
pub(crate) fn settings_path(folder: &Path, file: [&str; 2]) -> PathBuf {
    file.iter()
        .fold(folder.to_path_buf(), |path, part| path.join(part))
}

// Each folder's resolved file and the one in the folder itself, each once.
fn every_local_settings_file(
    folders: &[ClaudeProjectFolder<'_>],
    home_folder: &Path,
    path_rules: PathRules,
) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for folder in folders {
        let resolved = resolve_claude_local_settings_file(folder, home_folder, path_rules).path;
        for file in [resolved, local_settings_path(folder.working_folder)] {
            if !files.contains(&file) {
                files.push(file);
            }
        }
    }
    files
}

// The list a rule of `sense` goes in, and the other one.
fn sense_lists(sense: RememberedRuleSense) -> (&'static str, &'static str) {
    match sense {
        RememberedRuleSense::Allow => ("allow", "deny"),
        RememberedRuleSense::Block => ("deny", "allow"),
    }
}

// The rules one standing rule is in Claude Code's own words. A command's covers the command alone
// and with any arguments after it, which matches no longer program name; one that would also cover
// a destructive git command, or whose words hold a wildcard, is none. A path on a Windows network
// share is none: Claude Code documents its path rules only for drive paths, and an allow never
// spares a network read its prompt.
fn compose_rule_values(
    rule: &ProviderAskRule,
    path_rules: PathRules,
) -> Result<Vec<ClaudePermissionRuleValue>, ClaudeRulesError> {
    let value = |tool_name: &str, rule_content: Option<String>| ClaudePermissionRuleValue {
        tool_name: tool_name.to_owned(),
        rule_content,
    };
    Ok(match rule.action {
        ProviderAskActionKind::Command => {
            if covers_destructive_git(rule) || rule.subject.contains('*') {
                Vec::new()
            } else {
                vec![value("Bash", Some(format!("{} *", rule.subject)))]
            }
        }
        ProviderAskActionKind::FileChange | ProviderAskActionKind::FileRead
            if is_windows_network_path(&rule.subject, path_rules) =>
        {
            Vec::new()
        }
        ProviderAskActionKind::FileChange => vec![value(
            "Edit",
            Some(compose_path_content(&rule.subject, path_rules)),
        )],
        ProviderAskActionKind::FileRead => vec![value(
            "Read",
            Some(compose_path_content(&rule.subject, path_rules)),
        )],
        ProviderAskActionKind::Network => {
            vec![value("WebFetch", Some(format!("domain:{}", rule.subject)))]
        }
        ProviderAskActionKind::Tool => vec![value(&rule.subject, None)],
        ProviderAskActionKind::CommandInput => {
            return Err(ClaudeRulesError::UnkeptKind(rule.action.into()));
        }
    })
}

// A `\\server\share` path, which any two leading separators name on Windows.
fn is_windows_network_path(path: &str, path_rules: PathRules) -> bool {
    let mut characters = path.chars();
    path_rules == PathRules::Windows
        && characters
            .next()
            .is_some_and(|first| path_rules.is_separator(first))
        && characters
            .next()
            .is_some_and(|second| path_rules.is_separator(second))
}

fn write_rule_value(value: &ClaudePermissionRuleValue) -> String {
    match &value.rule_content {
        Some(content) => format!("{}({content})", value.tool_name),
        None => value.tool_name.clone(),
    }
}

fn rule_entries(
    rule: &ProviderAskRule,
    path_rules: PathRules,
) -> Result<Vec<String>, ClaudeRulesError> {
    Ok(compose_rule_values(rule, path_rules)?
        .iter()
        .map(write_rule_value)
        .collect())
}

/// A rule's path as Claude Code matches it: in POSIX form, as Claude Code reads every path, so a
/// Windows place's `C:\Users\a` is `/c/Users/a`; an absolute one written with a leading `//`,
/// which roots it at `/`; and each gitignore special escaped, so the rule matches only that path.
pub(crate) fn compose_path_content(path: &str, path_rules: PathRules) -> String {
    let is_absolute = path_rules.is_absolute(path);
    let posix_path = path_rules.posix_form(Path::new(path));
    let mut content = String::with_capacity(posix_path.len() + 2);
    if is_absolute {
        content.push('/');
    }
    for character in posix_path.chars() {
        if GITIGNORE_SPECIAL_CHARACTERS.contains(&character) {
            content.push('\\');
        }
        content.push(character);
    }
    content
}

// One change to one permission list: entries added where missing, and entries taken out.
struct ListChange<'entries> {
    list: &'static str,
    add: &'entries [String],
    remove: &'entries [String],
}

// Whether the rule was in the file and went.
async fn remove_rule_from_file(
    file: &Path,
    rule: &ProviderAskRule,
    path_rules: PathRules,
) -> Result<bool, ClaudeRulesError> {
    let removed = rule_entries(rule, path_rules)?;
    let (list, _) = sense_lists(rule.sense);
    let hold = hold_settings_file(file).await?;
    let Some(text) = read_settings_file(&hold, file).await? else {
        return Ok(false);
    };
    let change = ListChange {
        list,
        add: &[],
        remove: &removed,
    };
    let Some(edited) = edit_permission_lists(file, &text, |permissions, path| {
        apply_list_changes(permissions, path, std::slice::from_ref(&change))
    })?
    else {
        return Ok(false);
    };
    write_settings_file(&hold, file, edited, CLAUDE_LOCAL_SETTINGS_MODE).await?;
    Ok(true)
}

// Applies `changes` to `file`, made where missing and an entry is added (first listed in the
// exclude list of the repository `common_git_folder` names, unless `excluded_repositories` holds
// it already), one edit at a time on the file, the exclude step under the same hold.
async fn edit_local_settings(
    file: &Path,
    common_git_folder: Option<&Path>,
    excluded_repositories: &Mutex<HashSet<PathBuf>>,
    changes: &[ListChange<'_>],
) -> Result<(), ClaudeRulesError> {
    let hold = hold_settings_file(file).await?;
    let edited = if let Some(text) = read_settings_file(&hold, file).await? {
        edit_permission_lists(file, &text, |permissions, path| {
            apply_list_changes(permissions, path, changes)
        })?
    } else {
        let added: Vec<_> = changes
            .iter()
            .filter(|change| !change.add.is_empty())
            .collect();
        if added.is_empty() {
            return Ok(());
        }
        if let Some(common_git_folder) = common_git_folder
            && lock(excluded_repositories).insert(common_git_folder.to_path_buf())
        {
            add_repository_exclude(common_git_folder, CLAUDE_LOCAL_SETTINGS_EXCLUDE_PATTERN)
                .await
                .map_err(ClaudeRulesError::Exclude)?;
        }
        let lists: serde_json::Map<String, serde_json::Value> = added
            .iter()
            .map(|change| (change.list.to_owned(), serde_json::json!(change.add)))
            .collect();
        let mut text = serde_json::to_string_pretty(&serde_json::json!({ "permissions": lists }))
            .expect("a map of string lists always serializes");
        text.push('\n');
        Some(text)
    };
    if let Some(edited) = edited {
        write_settings_file(&hold, file, edited, CLAUDE_LOCAL_SETTINGS_MODE).await?;
    }
    Ok(())
}

// Hands `edit` the `permissions` object of `text`, the contents of `file` (made when missing and
// the edit adds to it), and returns the edited text, or `None` when the edit changed nothing.
// Refuses a file as `edit_settings_object` does, and one whose `permissions` is not an object.
fn edit_permission_lists(
    file: &Path,
    text: &str,
    edit: impl FnOnce(&PermissionsObject, &Path) -> Result<bool, ClaudeSettingsFileError>,
) -> Result<Option<String>, ClaudeSettingsFileError> {
    edit_settings_object(file, text, |settings| {
        let permissions = match settings.get("permissions") {
            Some(property) => match property.value() {
                Some(CstNode::Container(container)) => {
                    PermissionsObject::Present(container.as_object().ok_or_else(|| refused(file))?)
                }
                Some(CstNode::Leaf(_)) | None => return Err(refused(file)),
            },
            None => PermissionsObject::Missing(settings.clone()),
        };
        edit(&permissions, file)
    })
}

// The refusal of a file whose permission lists are not the shape the edit needs.
fn refused(file: &Path) -> ClaudeSettingsFileError {
    ClaudeSettingsFileError::Refused {
        path: file.to_path_buf(),
    }
}

// The settings' `permissions` object, or the settings object it is made in once an entry is added.
enum PermissionsObject {
    Present(CstObject),
    Missing(CstObject),
}

impl PermissionsObject {
    // The object, made in the settings when it is missing.
    fn object(&self) -> CstObject {
        match self {
            Self::Present(permissions) => permissions.clone(),
            Self::Missing(settings) => settings
                .object_value_or_create("permissions")
                .expect("a missing member is created as an object"),
        }
    }
}

fn apply_list_changes(
    permissions: &PermissionsObject,
    file: &Path,
    changes: &[ListChange<'_>],
) -> Result<bool, ClaudeSettingsFileError> {
    let mut is_changed = false;
    for change in changes {
        is_changed |= remove_entries(permissions, change.list, file, |entry| {
            change.remove.iter().any(|removed| removed == entry)
        })?;
        if change.add.is_empty() {
            continue;
        }
        let present = read_list_entries(permissions, change.list, file)?;
        let missing: Vec<&String> = change
            .add
            .iter()
            .filter(|entry| !present.contains(entry))
            .collect();
        if missing.is_empty() {
            continue;
        }
        let list = permissions
            .object()
            .array_value_or_create(change.list)
            .ok_or_else(|| refused(file))?;
        for entry in missing {
            list.append(CstInputValue::String(entry.clone()));
        }
        is_changed = true;
    }
    Ok(is_changed)
}

// The string entries of one list, empty where the list is missing; refuses a list that is not an
// array.
fn read_list_entries(
    permissions: &PermissionsObject,
    list: &str,
    file: &Path,
) -> Result<Vec<String>, ClaudeSettingsFileError> {
    let PermissionsObject::Present(object) = permissions else {
        return Ok(Vec::new());
    };
    let Some(property) = object.get(list) else {
        return Ok(Vec::new());
    };
    let array = property.array_value().ok_or_else(|| refused(file))?;
    Ok(array
        .elements()
        .iter()
        .filter_map(|element| element.as_string_lit()?.decoded_value().ok())
        .collect())
}

// Takes every string entry `is_removed` picks out of one list; a missing list is left missing, and
// a list that is not an array is refused. Whether any entry went.
fn remove_entries(
    permissions: &PermissionsObject,
    list: &str,
    file: &Path,
    is_removed: impl Fn(&str) -> bool,
) -> Result<bool, ClaudeSettingsFileError> {
    let PermissionsObject::Present(object) = permissions else {
        return Ok(false);
    };
    let Some(property) = object.get(list) else {
        return Ok(false);
    };
    let array = property.array_value().ok_or_else(|| refused(file))?;
    let is_after_bracket = |node: Option<CstNode>| {
        node.and_then(|node| node.previous_sibling())
            .is_some_and(|previous| previous.token_char() == Some('['))
    };
    // Whether the person wrote the first entry right after the bracket, as in `["a", "b"]`.
    let is_first_flush = is_after_bracket(array.elements().first().cloned());
    let mut is_changed = false;
    let mut is_first_removed = false;
    for (index, element) in array.elements().into_iter().enumerate() {
        let is_picked = element
            .as_string_lit()
            .and_then(|entry| entry.decoded_value().ok())
            .is_some_and(|entry| is_removed(&entry));
        if is_picked {
            element.remove();
            is_changed = true;
            is_first_removed |= index == 0;
        }
    }
    // jsonc-parser keeps the separator that followed a removed first entry, so `["a", "b"]` would
    // read `[ "b"]`; that separator goes when the person's first entry sat right after the bracket.
    if is_first_flush
        && is_first_removed
        && let Some(first) = array.elements().first()
        && let Some(space) = first
            .previous_sibling()
            .and_then(|node| node.as_whitespace())
        && space
            .previous_sibling()
            .is_some_and(|node| node.token_char() == Some('['))
    {
        space.remove();
    }
    Ok(is_changed)
}

#[cfg(test)]
mod tests;
