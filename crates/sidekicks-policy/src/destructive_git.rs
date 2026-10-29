//! Which git commands are destructive, a force push or a branch delete, read wherever a line runs
//! them, the strings its shells run included; the subcommand a git command runs, past git's own
//! options; and which standing rules a provider keeps as a prefix that would also let a destructive
//! one through, which no provider can narrow and so is never handed to one.

use std::sync::Arc;

use sidekicks_contracts::approval::RememberedRuleSense;

use crate::ask_rule::{ProviderAskActionKind, ProviderAskRule};
use crate::shell_commands::{ShellCommand, ShellLineReader, ShellLineReading, WordText};

/// The subcommand a git command runs, and whether its options change what git itself runs. The
/// subcommand's `Display` writes its text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GitSubcommandReading<W> {
    /// The first word past git's own options, `None` when every word is one of them.
    pub subcommand: Option<W>,
    /// Whether an option before the subcommand sets configuration or the folder git's own programs
    /// come from (`-c`, `--config-env`, `--exec-path`), which can make any subcommand run anything.
    pub changes_what_runs: bool,
}

// The options before git's subcommand that take the next word as their value.
const GIT_OPTIONS_WITH_VALUE: &[&str] = &[
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
    "--config-env",
    "--attr-source",
];

// The options before git's subcommand that can change what it runs, alone or with `=<value>`.
const GIT_OPTIONS_CHANGING_WHAT_RUNS: &[&str] = &["-c", "--config-env", "--exec-path"];

// The subcommands that can push with force, delete a remote branch or delete a local one.
const DESTRUCTIVE_GIT_SUBCOMMANDS: &[&str] = &["push", "branch"];

// The long options of `git push` that force or delete, alone or with `=<value>`.
const PUSH_DESTRUCTIVE_OPTIONS: &[&str] = &[
    "--force",
    "--force-with-lease",
    "--force-if-includes",
    "--delete",
    "--mirror",
    "--prune",
];

// The short options of `git push` that force (`f`) or delete (`d`), and of `git branch` that
// delete (`d`, `D`), alone or in a cluster.
const PUSH_DESTRUCTIVE_LETTERS: &[char] = &['f', 'd'];
const BRANCH_DELETE_LETTERS: &[char] = &['d', 'D'];

/// Whether the line `reading` holds runs a force push or a branch delete anywhere, the `-c` and
/// `eval` strings its shells run included, each reread on `reader`. A command that hands a shell a
/// string is judged by that string alone; a string the reader leaves unread holds no command, so
/// it reads as no destructive git.
pub fn runs_destructive_git(reader: &mut ShellLineReader, reading: &ShellLineReading) -> bool {
    // The strings still to judge, so a nesting depth costs a list entry and never a stack frame.
    let mut rereads = Vec::new();
    if holds_destructive_git(reader, reading, &mut rereads) {
        return true;
    }
    while let Some(reread) = rereads.pop() {
        if holds_destructive_git(reader, &reread, &mut rereads) {
            return true;
        }
    }
    false
}

/// The subcommand of a git command with `argument_words`, the first word past git's own options.
pub fn read_git_subcommand<W: WordText>(
    argument_words: impl IntoIterator<Item = W>,
) -> GitSubcommandReading<W> {
    take_git_subcommand(&mut argument_words.into_iter())
}

/// Whether a provider keeping `rule` as a prefix over its subject's words would also let a force
/// push or a branch delete through: a command allow on `git` alone, `git push` or `git branch`.
/// Such a rule is the daemon's alone, which answers each ask it covers and sends a destructive one
/// to the card.
pub fn covers_destructive_git(rule: &ProviderAskRule) -> bool {
    if rule.action != ProviderAskActionKind::Command || rule.sense != RememberedRuleSense::Allow {
        return false;
    }
    let mut words = rule.subject.split(' ');
    let program = words.next();
    let subcommand = words.next();
    program == Some("git")
        && words.next().is_none()
        && subcommand.is_none_or(|subcommand| DESTRUCTIVE_GIT_SUBCOMMANDS.contains(&subcommand))
}

// Whether a command of `reading` that hands a shell no string is a destructive git command; each
// string a command hands a shell is read and left in `rereads` to be judged in its place.
fn holds_destructive_git(
    reader: &mut ShellLineReader,
    reading: &ShellLineReading,
    rereads: &mut Vec<Arc<ShellLineReading>>,
) -> bool {
    for command in reading.commands() {
        match reader.read_command_string(command) {
            Some(reread) => rereads.push(reread),
            None => {
                if is_destructive_git(command) {
                    return true;
                }
            }
        }
    }
    false
}

// A push that forces or deletes, or a branch delete.
fn is_destructive_git(command: ShellCommand<'_>) -> bool {
    if !command.program().is("git") {
        return false;
    }
    let mut rest = command.argument_words();
    let Some(subcommand) = take_git_subcommand(&mut rest).subcommand else {
        return false;
    };
    if subcommand.is("push") {
        return rest.any(|word| {
            is_short_option_cluster_with(word, PUSH_DESTRUCTIVE_LETTERS)
                || PUSH_DESTRUCTIVE_OPTIONS
                    .iter()
                    .any(|option| is_option(word, option))
                // A refspec that forces (`+main`) or deletes (`:main`) the branch it names.
                || word.starts_with("+")
                || word.starts_with(":")
        });
    }
    if subcommand.is("branch") {
        return rest.any(|word| {
            word.is("--delete") || is_short_option_cluster_with(word, BRANCH_DELETE_LETTERS)
        });
    }
    false
}

// Takes words up to and including the subcommand, the first word that is no option, past the
// value of an option that takes one, leaving the words after it in `words`. Every word before the
// subcommand, an option's value included, is checked for an option that changes what git runs.
fn take_git_subcommand<W: WordText>(
    words: &mut impl Iterator<Item = W>,
) -> GitSubcommandReading<W> {
    let mut changes_what_runs = false;
    let mut is_option_value = false;
    for word in words.by_ref() {
        if is_option_value {
            is_option_value = false;
        } else if GIT_OPTIONS_WITH_VALUE.iter().any(|option| word.is(option)) {
            is_option_value = true;
        } else if !word.starts_with("-") {
            return GitSubcommandReading {
                subcommand: Some(word),
                changes_what_runs,
            };
        }
        changes_what_runs |= GIT_OPTIONS_CHANGING_WHAT_RUNS
            .iter()
            .any(|option| is_option(word, option));
    }
    GitSubcommandReading {
        subcommand: None,
        changes_what_runs,
    }
}

/// Whether `word` is `option`, alone or with `=<value>`; `option` is ASCII, so its byte length
/// counts its characters.
pub(crate) fn is_option(word: impl WordText, option: &str) -> bool {
    word.starts_with(option) && matches!(word.chars().nth(option.len()), None | Some('='))
}

// Whether `word` is a `-` and then only ASCII letters, at least one of them among `letters`.
fn is_short_option_cluster_with(word: impl WordText, letters: &[char]) -> bool {
    let mut characters = word.chars();
    if characters.next() != Some('-') {
        return false;
    }
    let mut has_letter = false;
    for character in characters {
        if !character.is_ascii_alphabetic() {
            return false;
        }
        has_letter |= letters.contains(&character);
    }
    has_letter
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::approval::RememberedScopeKind;

    use super::*;

    // Far past every line here, so the cases read the walk and never the cap.
    const LIMIT: usize = 4096;

    #[rstest]
    #[case::unterminated_line(r#"git push --force origin main && echo "unterminated"#, true)]
    #[case::shell_string("sh -c 'git push -f'", true)]
    #[case::eval_string(r#"eval "git push --force""#, true)]
    #[case::folder_option_value("git -C dir push --force", true)]
    #[case::folder_option_takes_push("git -C push -f", false)]
    #[case::forcing_refspec("git push origin +main", true)]
    #[case::deleting_refspec("git push origin :main", true)]
    #[case::lease_with_value("git push --force-with-lease=x", true)]
    #[case::branch_delete("git branch -D x", true)]
    #[case::push_cluster("git push -qf", true)]
    // A letter an expansion makes is no `command -v`, so `command` runs the push.
    #[case::undecided_lookup_option("command -$v git push --force", true)]
    // A wrapper's split string is the command it runs, its value attached or in a cluster.
    #[case::split_string_inside_the_word("env -S'git push --force'", true)]
    #[case::split_string_in_a_cluster("env -vS'git push --force'", true)]
    #[case::split_string_after_the_long_option("env --split-string='git push --force'", true)]
    // A wrapper's option value is never the program, whichever system's option it is.
    #[case::search_path_value("env -P /usr/bin git push --force", true)]
    #[case::replacement_value("xargs -J % git push --force", true)]
    #[case::value_letter_ending_a_cluster("sudo -Eu root git push --force", true)]
    // GNU xargs's `-i` takes its value inside its own word, so the next word is the program.
    #[case::attached_optional_value("xargs -iI git push --force", true)]
    #[case::dry_run("git push --dry-run origin main", false)]
    #[case::branch_long_option_with_d("git branch --edit-description", false)]
    fn a_line_reads_destructive_git(#[case] line: &str, #[case] is_destructive: bool) {
        let mut reader = ShellLineReader::new(LIMIT);
        let reading = reader.read(line);

        assert_eq!(runs_destructive_git(&mut reader, &reading), is_destructive);
    }

    #[rstest]
    #[case::git_alone(
        RememberedRuleSense::Allow,
        ProviderAskActionKind::Command,
        "git",
        true
    )]
    #[case::git_push(
        RememberedRuleSense::Allow,
        ProviderAskActionKind::Command,
        "git push",
        true
    )]
    #[case::git_branch(
        RememberedRuleSense::Allow,
        ProviderAskActionKind::Command,
        "git branch",
        true
    )]
    #[case::push_with_remote(
        RememberedRuleSense::Allow,
        ProviderAskActionKind::Command,
        "git push origin",
        false
    )]
    #[case::other_subcommand(
        RememberedRuleSense::Allow,
        ProviderAskActionKind::Command,
        "git status",
        false
    )]
    #[case::block(
        RememberedRuleSense::Block,
        ProviderAskActionKind::Command,
        "git push",
        false
    )]
    #[case::not_a_command(
        RememberedRuleSense::Allow,
        ProviderAskActionKind::FileChange,
        "git",
        false
    )]
    fn a_rule_covers_destructive_git(
        #[case] sense: RememberedRuleSense,
        #[case] action: ProviderAskActionKind,
        #[case] subject: &str,
        #[case] covers: bool,
    ) {
        let rule = ProviderAskRule {
            kind: RememberedScopeKind::Session,
            sense,
            action,
            subject: subject.to_owned(),
        };

        assert_eq!(covers_destructive_git(&rule), covers);
    }
}
