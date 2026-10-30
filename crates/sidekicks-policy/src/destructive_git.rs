//! Which git commands are destructive, a force push or a branch delete, read wherever a line runs
//! them, the strings its shells run included; the subcommand a git command runs, past git's own
//! options; and which standing rules a provider keeps as a prefix that would also let a destructive
//! one through, which no provider can narrow and so is never handed to one.

use std::sync::Arc;

use sidekicks_contracts::approval::RememberedRuleSense;

use crate::ask_rule::{ProviderAskActionKind, ProviderAskRule};
use crate::shell_commands::{ShellCommand, ShellLineReader, ShellLineReading, WordText, is_option};

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
    take_git_subcommand(&mut argument_words.into_iter(), |_, _| {})
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
        let strings = reader.read_command_strings(command);
        if strings.is_empty() {
            if is_destructive_git(command) {
                return true;
            }
        } else {
            rereads.extend(strings);
        }
    }
    false
}

// A push that forces or deletes, or a branch delete. A word only the run decides, which can turn
// into any word or several, counts as a match wherever a decided word is read: as the program or
// a word that can split or move it, as any word up to the subcommand, each of which git may read
// as its own option, a value or the subcommand, and after `push` or `branch`. Only a value of
// git's own option that is one quoted parameter stays one word, which cannot move the subcommand.
fn is_destructive_git(command: ShellCommand<'_>) -> bool {
    if command.is_program_undecided() {
        return true;
    }
    if !command.program().is("git") {
        return false;
    }
    let mut rest = command.argument_words();
    let mut takes_an_undecided_word = false;
    let reading = take_git_subcommand(&mut rest, |word, is_option_value| {
        takes_an_undecided_word |=
            !(word.is_decided() || is_option_value && word.is_one_quoted_parameter());
    });
    if takes_an_undecided_word {
        return true;
    }
    let Some(subcommand) = reading.subcommand else {
        return false;
    };
    if subcommand.is("push") {
        return rest.any(|word| {
            !word.is_decided()
                || is_short_option_cluster_with(word, PUSH_DESTRUCTIVE_LETTERS)
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
            !word.is_decided()
                || word.is("--delete")
                || is_short_option_cluster_with(word, BRANCH_DELETE_LETTERS)
        });
    }
    false
}

// Takes words up to and including the subcommand, the first word that is no option, past the
// value of an option that takes one, leaving the words after it in `words`, and hands each word
// taken to `on_taken_word` with whether it is an option's value. Every word before the subcommand,
// an option's value included, is checked for an option that changes what git runs.
fn take_git_subcommand<W: WordText>(
    words: &mut impl Iterator<Item = W>,
    mut on_taken_word: impl FnMut(W, bool),
) -> GitSubcommandReading<W> {
    let mut changes_what_runs = false;
    let mut is_option_value = false;
    for word in words.by_ref() {
        on_taken_word(word, is_option_value);
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
    // A value attached to its option is no word of its own, so the next word is the program.
    #[case::value_inside_the_cluster("sudo -uroot git push --force", true)]
    #[case::value_after_the_long_option("sudo --user=root git push --force", true)]
    // A prefix of one long option names that option, its value after `=` or in the next word.
    #[case::prefix_of_a_value_option("env --chd /tmp git push --force", true)]
    #[case::prefix_of_a_sudo_option("sudo --us root git push --force", true)]
    #[case::prefix_of_the_split_option("env --sp='git push --force'", true)]
    // env reads a split string's words as its own arguments, its quotes and escapes as env does,
    // and a `${name}` it expands leaves the program read.
    #[case::option_inside_a_split_string("env -S'-i git push --force'", true)]
    #[case::quotes_inside_a_split_string(r#"env -S'git "push" --force'"#, true)]
    #[case::separator_escape_inside_a_split_string(r"env -S'git\_push\_--force'", true)]
    #[case::expansion_after_the_program("env -S'git push --force ${X}'", true)]
    // `-` alone is env's own option, emptying the environment.
    #[case::lone_dash_of_env("env - git push --force", true)]
    #[case::buffering_wrapper("stdbuf -oL git push --force", true)]
    #[case::affinity_mask_before_the_command("taskset 0x1 git push --force", true)]
    // `chrt`'s priority is optional, so a word that is no number is the command.
    #[case::policy_with_no_priority("chrt -o git push --force", true)]
    // `arch` reads each option whole: `-arm64e` names an architecture, no cluster.
    #[case::architecture_option("arch -arm64e git push --force", true)]
    #[case::su_command_string("su -c 'git push --force'", true)]
    #[case::su_command_after_the_long_option("su --command='git push --force'", true)]
    #[case::ksh_value_before_the_command_string("ksh -R f -c 'git push --force'", true)]
    // The words after su's user go to the shell, whose own `-c` string runs.
    #[case::shell_string_after_the_user("su root -sc 'git push --force'", true)]
    // A priority only the run decides is still `chrt`'s priority.
    #[case::undecided_priority("chrt $P git push --force", true)]
    // A word only the run decides may be the subcommand or any option of a push.
    #[case::brace_alternatives_of_a_push("git push {--force,origin}", true)]
    #[case::brace_alternatives_of_one_option("git push --{force,force}", true)]
    #[case::pattern_of_an_option("git push --forc?", true)]
    #[case::expanded_subcommand("X=push; git $X -f", true)]
    #[case::braced_expansion_subcommand("git ${X} --force", true)]
    #[case::expansion_after_a_reading_subcommand("git log --since=$DATE", false)]
    // An undecided word before any subcommand: a brace word or an unquoted expansion splits into
    // several, so git can read one as its subcommand; one quoted parameter stays one word.
    #[case::brace_alternatives_of_a_folder("git -C {.,push} --force", true)]
    #[case::expanded_option_word("git -$X --force", true)]
    #[case::expanded_option_word_after_its_value("X=\"C . push\"; git -$X --force", true)]
    #[case::quoted_folder_value("git -C \"$D\" log", false)]
    // env splits a split string again after the shell expanded it, quoted or not.
    #[case::quoted_parameter_inside_a_split_string(
        "X=\". push\"; env -S\"git -C $X --force\"",
        true
    )]
    // A NUL ends bash's value of an ANSI-C string and stays in zsh's word.
    #[case::ansi_c_nul_in_the_program(r"$'gi\0zz't push -f", true)]
    // zsh drops the backslash of an escape it does not know, so this word is `push` there.
    #[case::unknown_ansi_c_escape(r"git $'\push' --force", true)]
    // A program only the run decides may be git.
    #[case::expanded_program("G=git; $G push --force", true)]
    // A wrapper's option word only the run decides sets which later word is the program.
    #[case::expanded_option_of_a_wrapper("X=i; env -$X git push --force", true)]
    #[case::quoted_expanded_option_of_a_wrapper("env \"-$X\" git push --force", true)]
    #[case::expanded_option_before_a_value("sudo -$o root git push --force", true)]
    // The shell splits a wrapper's unquoted value, operand or assignment into the program and its
    // words; a quoted one stays one word, which leaves the program read.
    #[case::split_value_of_a_wrapper("env -u $U main", true)]
    #[case::split_value_of_nice("nice -n $N main", true)]
    #[case::split_operand_of_a_wrapper("timeout $D main", true)]
    #[case::split_assignment_of_a_wrapper("env A=$X main", true)]
    #[case::quoted_value_of_a_wrapper("env -u \"$U\" main", false)]
    #[case::quoted_operand_of_a_wrapper("timeout \"$D\" main", false)]
    #[case::quoted_assignment_of_a_wrapper("env \"A=$X\" main", false)]
    // env splits its split string again after the shell expanded it, so an expansion in its
    // program or assignment word can be any program.
    #[case::split_assignment_inside_a_split_string("env -S \"A=$X main\"", true)]
    #[case::expanded_split_string("env -S \"$X\"", true)]
    #[case::env_expanded_program_of_a_split_string("env -S'${P} push -f'", true)]
    // An expansion the shell splits in a program's folder can be the program; a quoted folder
    // cannot split, so its file is the program.
    #[case::split_folder_of_the_program("G=\"git push --force origin main -o\"; $G/x", true)]
    #[case::expanded_home_folder("$HOME/bin/tool x", true)]
    #[case::quoted_substituted_folder(
        "\"$(git rev-parse --show-toplevel)/tools/x.sh\" notes.md",
        false
    )]
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
