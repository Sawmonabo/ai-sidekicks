//! What a provider's permission ask is about, as its card draws it and a rule on it names it: the
//! category, the target as free text, and the subject a standing rule names, derived here once so
//! the card's button, the answer's check and the provider's rule all read the same words.
//!
//! - A command's subject is its program and, where the word right after it reads as one, its
//!   first subcommand (`npm run`, `git push`); git's own options are read past to its subcommand.
//!   Only a line read whole, of one plain command, has one: a rule over a line of several, over the
//!   string an `sh -c` or `eval` runs, over a command run through another (`sudo`, `env`, `xargs`),
//!   or over a git command whose options change what it runs, would answer commands the card never
//!   named.
//! - A force push or a branch delete, wherever the line runs it, is `destructiveGit` and takes no
//!   standing allow, and no rule in force answers it: it always reaches the card. So does an ask
//!   the provider's own safety check flagged.
//! - A change to one file names its path, as does a read; a change to several files names none.
//! - A host names itself, a tool its name; a plan and input to a running command take no rule.
//!
//! A command's line is read once per ask, on the ask's one reader, and that reading is handed to
//! each function here; the `-c` and `eval` strings they reread come from the reader's own keep.

use std::borrow::Cow;

use sidekicks_contracts::approval::{ApprovalCategory, ApprovalScope, RememberedScopeKind};
use sidekicks_contracts::free_form_string::FILE_PATH_MAX_LEN;
use sidekicks_contracts::wire::text::{NonEmptyText, TextError, is_ecmascript_whitespace};

use crate::approvals::request_create::ApprovalResourceDescriptor;
use crate::policy::destructive_git::{read_git_subcommand, runs_destructive_git};
use crate::policy::shell_commands::{ShellCommand, ShellLineReader, ShellLineReading, WordText};
use crate::provider::port::permission_ask::{ProviderAskAction, ProviderPermissionAsk};
use crate::text_cut::cut_to_code_points;

/// A provider ask as the approval service raises it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProviderAskDescription {
    /// What the ask is about.
    pub(crate) category: ApprovalCategory,
    /// The target as free text, or the tool's name where the action names none.
    pub(crate) scope: ApprovalScope,
    /// What the card draws.
    pub(crate) resource_descriptor: ApprovalResourceDescriptor,
}

/// Why an ask could not be described: its tool name, which the card names and which stands as the
/// scope of an ask with no target of its own, is empty or no scope.
#[derive(Debug, thiserror::Error)]
pub(crate) enum AskDescriptionError {
    /// The provider named the tool with no text.
    #[error("the ask names its tool with no text")]
    EmptyToolName,
    /// The ask has no target, and its tool name cannot stand as its scope.
    #[error("the ask has no target, and its tool name cannot stand as its scope")]
    ToolNameNotAScope(#[source] TextError),
}

/// Describes one ask the approval service raises for a person's answer. `reading` is the reading
/// `reader` made of a command action's line, `None` for any other action; a command with none
/// reads as a line not read. Fails with [`AskDescriptionError`] when the ask's tool name is empty,
/// or must stand as its scope and cannot.
pub(crate) fn describe_provider_ask(
    reader: &mut ShellLineReader,
    reading: Option<&ShellLineReading>,
    ask: &ProviderPermissionAsk,
) -> Result<ProviderAskDescription, AskDescriptionError> {
    let action = &ask.action;
    // The category first: its walk rereads the line's `-c` and `eval` strings, which the
    // subject's walk then takes from the reader's keep.
    let category = category_of(reader, reading, action);
    let derived_subject = derive_rule_subject(reader, reading, action);
    let tool_name =
        NonEmptyText::new(ask.tool_name.clone()).ok_or(AskDescriptionError::EmptyToolName)?;
    let scope = match bounded_wire_text(&target_text_of(action)) {
        Some(scope) => scope,
        None => ApprovalScope::new(ask.tool_name.clone())
            .map_err(AskDescriptionError::ToolNameNotAScope)?,
    };
    let subject = derived_subject.as_deref().and_then(bounded_wire_text);
    // A subject the wire bound had to change no longer says exactly what the rule would cover.
    let is_subject_exact =
        subject.as_ref().map(ApprovalScope::as_str) == derived_subject.as_deref();
    let standing_allow_offered =
        may_allow_stand_on(ask, category, derived_subject.as_deref()) && is_subject_exact;
    Ok(ProviderAskDescription {
        category,
        resource_descriptor: ApprovalResourceDescriptor {
            subject: subject.unwrap_or_else(|| scope.clone()),
            standing_allow_offered,
            project_scope_offered: standing_allow_offered
                && ask.rule_scopes.contains(&RememberedScopeKind::Project),
            editable: is_editable(action),
            action: Some(action.clone()),
            tool_name: Some(tool_name),
            // A prompt with no text is no prompt.
            prompt: ask.prompt.clone().and_then(NonEmptyText::new),
        },
        scope,
    })
}

/// Whether a standing allow may stand on `ask`, made on its card or answering it while in force:
/// the provider keeps a rule on it, neither the daemon nor the provider's own safety check flagged
/// it, and it has a subject to name. `reading` is as [`describe_provider_ask`] takes it.
pub(crate) fn may_allow_stand(
    reader: &mut ShellLineReader,
    reading: Option<&ShellLineReading>,
    ask: &ProviderPermissionAsk,
) -> bool {
    let category = category_of(reader, reading, &ask.action);
    let subject = derive_rule_subject(reader, reading, &ask.action);
    may_allow_stand_on(ask, category, subject.as_deref())
}

/// The subject a standing rule on `action` names, or `None` for an action no rule may name: a
/// plan, input to a running command, a change to several files, or a line that is not one plain
/// command read whole. `reading` is as [`describe_provider_ask`] takes it.
pub(crate) fn derive_rule_subject(
    reader: &mut ShellLineReader,
    reading: Option<&ShellLineReading>,
    action: &ProviderAskAction,
) -> Option<String> {
    match action {
        ProviderAskAction::Command { .. } => {
            let reading = reading.filter(|reading| reading.is_whole())?;
            let mut commands = reading.commands();
            match (commands.next(), commands.next()) {
                (Some(only), None) => command_subject_of(reader, only),
                (None, _) | (Some(_), Some(_)) => None,
            }
        }
        ProviderAskAction::FileChange { paths } => match paths.as_slice() {
            [only] => Some(only.clone()),
            [] | [_, _, ..] => None,
        },
        ProviderAskAction::FileRead { path } => Some(path.clone()),
        ProviderAskAction::Network { host } => Some(host.clone()),
        ProviderAskAction::Tool { tool_name } => Some(tool_name.clone()),
        ProviderAskAction::CommandInput { .. } => None,
    }
}

fn may_allow_stand_on(
    ask: &ProviderPermissionAsk,
    category: ApprovalCategory,
    subject: Option<&str>,
) -> bool {
    !ask.rule_scopes.is_empty()
        && !ask.is_provider_flagged
        && category != ApprovalCategory::DestructiveGit
        && subject.is_some()
}

fn command_subject_of(reader: &mut ShellLineReader, command: ShellCommand<'_>) -> Option<String> {
    if command.wrappers().next().is_some() || reader.read_command_string(command).is_some() {
        return None;
    }
    let program = command.program();
    let next = if program.is("git") {
        let git_reading = read_git_subcommand(command.argument_words());
        if git_reading.changes_what_runs {
            return None;
        }
        git_reading.subcommand
    } else {
        command.argument_words().next()
    };
    Some(match next {
        Some(word) if is_subcommand_word(word) => format!("{program} {word}"),
        Some(_) | None => program.to_string(),
    })
}

// A word that reads as a subcommand: a lower-case letter, then lower-case letters, digits and
// dashes, never a path or a file.
fn is_subcommand_word(word: impl WordText) -> bool {
    let mut characters = word.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_lowercase())
        && characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

fn category_of(
    reader: &mut ShellLineReader,
    reading: Option<&ShellLineReading>,
    action: &ProviderAskAction,
) -> ApprovalCategory {
    match action {
        // What a line not read whole still shows of a destructive git command counts.
        ProviderAskAction::Command { .. } => {
            if reading.is_some_and(|reading| runs_destructive_git(reader, reading)) {
                ApprovalCategory::DestructiveGit
            } else {
                ApprovalCategory::ToolExecution
            }
        }
        ProviderAskAction::FileChange { .. } => ApprovalCategory::FileWrite,
        ProviderAskAction::Network { .. } => ApprovalCategory::NetworkAccess,
        ProviderAskAction::CommandInput { .. }
        | ProviderAskAction::FileRead { .. }
        | ProviderAskAction::Tool { .. } => ApprovalCategory::ToolExecution,
    }
}

// The target the card names in a line: the command or input whole, the files one per line, the
// host or the tool.
fn target_text_of(action: &ProviderAskAction) -> Cow<'_, str> {
    match action {
        ProviderAskAction::Command { command } => Cow::Borrowed(command),
        ProviderAskAction::CommandInput { input } => Cow::Borrowed(input),
        ProviderAskAction::FileChange { paths } => Cow::Owned(paths.join("\n")),
        ProviderAskAction::FileRead { path } => Cow::Borrowed(path),
        ProviderAskAction::Network { host } => Cow::Borrowed(host),
        ProviderAskAction::Tool { tool_name } => Cow::Borrowed(tool_name),
    }
}

// A command or a path may be corrected before it is approved; nothing else may.
fn is_editable(action: &ProviderAskAction) -> bool {
    match action {
        ProviderAskAction::Command { .. } | ProviderAskAction::FileRead { .. } => true,
        ProviderAskAction::FileChange { paths } => paths.len() == 1,
        ProviderAskAction::CommandInput { .. }
        | ProviderAskAction::Network { .. }
        | ProviderAskAction::Tool { .. } => false,
    }
}

// `text` as the wire carries a scope or a subject: no NUL, cut to the bound on a whole character,
// and `None` where nothing but white space is left.
fn bounded_wire_text(text: &str) -> Option<ApprovalScope> {
    let without_nul = text.replace('\0', "");
    let bounded = cut_to_code_points(&without_nul, FILE_PATH_MAX_LEN);
    if bounded.chars().all(is_ecmascript_whitespace) {
        return None;
    }
    Some(
        ApprovalScope::new(bounded.to_owned())
            .expect("text with no NUL, cut to the cap and not blank is a scope"),
    )
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::*;

    // Far past every line here, so the cases read the walk and never the cap.
    const LIMIT: usize = 4096;

    #[rstest]
    #[case::unterminated_quote(
        r#"git push --force origin main && echo "unterminated"#,
        None,
        ApprovalCategory::DestructiveGit
    )]
    #[case::one_command_not_read_whole(
        r#"git push origin main "unterminated"#,
        None,
        ApprovalCategory::ToolExecution
    )]
    #[case::whole_line(
        "git push origin main",
        Some("git push"),
        ApprovalCategory::ToolExecution
    )]
    #[case::force_push_in_a_shell_string(
        "bash -c 'git push --force origin main'",
        None,
        ApprovalCategory::DestructiveGit
    )]
    fn a_command_reads_its_subject_and_category(
        #[case] line: &str,
        #[case] subject: Option<&str>,
        #[case] category: ApprovalCategory,
    ) {
        let action = ProviderAskAction::Command {
            command: line.to_owned(),
        };
        let mut reader = ShellLineReader::new(LIMIT);
        let reading = reader.read(line);

        assert_eq!(category_of(&mut reader, Some(&reading), &action), category);
        assert_eq!(
            derive_rule_subject(&mut reader, Some(&reading), &action).as_deref(),
            subject
        );
    }
}
