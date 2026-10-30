//! Which git commands are destructive, a force push or a branch delete, read wherever a line runs
//! them, the strings its shells run and the lines a git command's settings run included; the
//! subcommand a git command runs, past git's own options; what its settings for its own run make
//! it run; and which standing rules a provider keeps as a prefix that would also let a destructive
//! one through, which no provider can narrow and so is never handed to one.

use std::sync::Arc;

use sidekicks_contracts::approval::RememberedRuleSense;

use crate::ask_rule::{ProviderAskActionKind, ProviderAskRule};
use crate::shell_commands::{
    PositionedByte, ShellCommand, ShellLineReader, ShellLineReading, ShellWord, WordText, is_option,
};

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
/// `eval` strings its shells run and the lines its git settings hand a shell included, each
/// reread on `reader`. Each command is read by the words its text spells, so one whose program
/// only the run decides counts as none; a command that runs a line it reads from its input counts
/// as one; a line not read whole counts as one when the words it still shows name one; a string
/// the reader leaves unread holds no command, so it reads as no destructive git.
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

// Whether a command of `reading` is a destructive git command or runs a line it reads from its
// input, or a line not read whole shows one; each string a command hands a shell, or its git
// settings do, is read and left in `rereads` to be judged in its place.
fn holds_destructive_git(
    reader: &mut ShellLineReader,
    reading: &ShellLineReading,
    rereads: &mut Vec<Arc<ShellLineReading>>,
) -> bool {
    if !reading.is_whole()
        && reading
            .unread_word_runs()
            .iter()
            .any(|run| runs_git_words(run))
    {
        return true;
    }
    for command in reading.commands() {
        if command.runs_a_line_from_its_input() {
            return true;
        }
        rereads.extend(reader.read_command_strings(command));
        let settings = read_git_run_settings(reading, command);
        rereads.extend(settings.shell_lines().map(|line| reader.read(line)));
        if is_destructive_git(command, &settings) {
            return true;
        }
    }
    false
}

// Whether a run of a line's words not read whole runs a destructive git command: `git`, by its
// name or a path ending in it, followed by the words of one.
fn runs_git_words(run: &[String]) -> bool {
    run.iter().enumerate().any(|(index, word)| {
        word.rsplit('/').next() == Some("git")
            && is_destructive_git_arguments(run[index + 1..].iter().map(String::as_str))
    })
}

// A push that forces or deletes, or a branch delete, of a git command, its aliases' words put in
// place of the subcommand each names, as git runs them.
fn is_destructive_git(command: ShellCommand<'_>, settings: &GitRunSettings) -> bool {
    if !command.program().is("git") {
        return false;
    }
    let aliases = &settings.aliases;
    if aliases.is_empty() {
        return is_destructive_git_arguments(command.argument_words());
    }
    let mut arguments: Vec<GitArgumentWord<'_>> = command
        .argument_words()
        .map(GitArgumentWord::Read)
        .collect();
    // Each alias stands in once, as git refuses an alias that names itself again.
    let mut is_expanded = vec![false; aliases.len()];
    loop {
        if is_destructive_git_arguments(arguments.iter().copied()) {
            return true;
        }
        let mut taken = 0;
        let reading = take_git_subcommand(&mut arguments.iter().copied(), |_, _| taken += 1);
        let Some(subcommand) = reading.subcommand else {
            return false;
        };
        let named = |alias: &GitAlias| {
            let name = subcommand
                .chars()
                .map(|character| character.to_ascii_lowercase());
            name.eq(alias.name.chars())
        };
        let alias = aliases
            .iter()
            .enumerate()
            .find(|&(index, alias)| !is_expanded[index] && named(alias));
        let Some((index, alias)) = alias else {
            return false;
        };
        is_expanded[index] = true;
        let words = alias.words.iter().map(|word| GitArgumentWord::Alias(word));
        arguments.splice(taken - 1..taken, words);
    }
}

// A push that forces or deletes, or a branch delete, of git's `arguments`. A word only the run
// decides, which can turn into any word or several, counts as a match wherever a decided word is
// read: as any word up to the subcommand, each of which git may read as its own option, a value or
// the subcommand, and after `push` or `branch`. Only a value of git's own option that is one quoted
// parameter stays one word, which cannot move the subcommand.
fn is_destructive_git_arguments<W: GitArgument>(arguments: impl Iterator<Item = W>) -> bool {
    let mut rest = arguments;
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

/// What a git command's settings for its own run make it run: the aliases it defines, through
/// its `-c` options, the line's `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` pairs or its
/// `GIT_CONFIG_PARAMETERS`, with those the values of these aliases define in turn; and the shell
/// lines those settings and the line's `GIT_PAGER`, `GIT_EDITOR` and their kin hand a shell.
pub struct GitRunSettings {
    aliases: Vec<GitAlias>,
    shell_lines: Vec<String>,
}

// One alias of git's own words: its name in lower case, as git compares configuration names, and
// its value split as git splits it.
struct GitAlias {
    name: String,
    words: Vec<String>,
}

impl GitRunSettings {
    /// The lines the settings hand a shell, whether or not the command names or reaches them: an
    /// alias's value after its leading `!`, a pager, an editor, an SSH command, an external diff,
    /// and a credential helper's value after its leading `!`.
    pub fn shell_lines(&self) -> impl Iterator<Item = &str> {
        self.shell_lines.iter().map(String::as_str)
    }
}

// The configuration name of an alias, before its name.
const ALIAS_SECTION: &str = "alias.";

// The settings whose value git hands a shell as a line, compared in lower case.
const SHELL_LINE_SETTINGS: &[&str] = &[
    "core.pager",
    "core.editor",
    "sequence.editor",
    "core.sshcommand",
    "diff.external",
];

// The environment names whose value git hands a shell as a line.
const SHELL_LINE_ENVIRONMENT: &[&str] = &[
    "GIT_PAGER",
    "GIT_EDITOR",
    "GIT_SEQUENCE_EDITOR",
    "GIT_SSH_COMMAND",
    "GIT_EXTERNAL_DIFF",
];

// The environment name whose value holds the `-c` settings git hands the git programs it runs.
const CONFIG_PARAMETERS: &str = "GIT_CONFIG_PARAMETERS";

/// The settings `command` of `reading` gives its own run when its program is git, none for any
/// other: from git's own `-c` options, the `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` pairs
/// and the `GIT_CONFIG_PARAMETERS` the line or the command's wrappers assign, the `-c` options of
/// each alias's own words, and the environment names whose value is a shell line. A setting only
/// the run decides is not read.
pub fn read_git_run_settings(
    reading: &ShellLineReading,
    command: ShellCommand<'_>,
) -> GitRunSettings {
    let mut run_settings = GitRunSettings {
        aliases: Vec::new(),
        shell_lines: Vec::new(),
    };
    if !command.program().is("git") {
        return run_settings;
    }
    let mut settings = Vec::new();
    push_config_options(command.argument_words(), &mut settings);
    let mut keys = Vec::new();
    let mut values = Vec::new();
    for word in reading.assignment_words().chain(command.wrapper_words()) {
        if !word.is_decided() {
            continue;
        }
        let text = word.to_string();
        let Some((name, value)) = text.split_once('=') else {
            continue;
        };
        if let Some(number) = name.strip_prefix("GIT_CONFIG_KEY_") {
            keys.push((number.to_owned(), value.to_owned()));
        } else if let Some(number) = name.strip_prefix("GIT_CONFIG_VALUE_") {
            values.push((number.to_owned(), value.to_owned()));
        } else if name == CONFIG_PARAMETERS {
            push_config_parameters(value, &mut settings);
        } else if SHELL_LINE_ENVIRONMENT.contains(&name) {
            run_settings.shell_lines.push(value.to_owned());
        }
    }
    for (number, key) in keys {
        // The last value assigned to a number is the one git reads.
        if let Some((_, value)) = values.iter().rev().find(|(other, _)| *other == number) {
            settings.push(format!("{key}={value}"));
        }
    }
    // An alias's words are shorter than the setting that holds them, so the reading ends.
    let mut index = 0;
    while let Some(setting) = settings.get(index).cloned() {
        index += 1;
        let Some((key, value)) = setting.split_once('=') else {
            continue;
        };
        let key = key.to_ascii_lowercase();
        if let Some(line) = shell_line_of_setting(&key, value) {
            run_settings.shell_lines.push(line.to_owned());
            continue;
        }
        let Some(name) = key.strip_prefix(ALIAS_SECTION) else {
            continue;
        };
        if let Some(line) = value.strip_prefix('!') {
            run_settings.shell_lines.push(line.to_owned());
            continue;
        }
        // git refuses a value with an open quote, running nothing.
        let words = shlex::split(value).unwrap_or_default();
        push_config_options(words.iter().map(String::as_str), &mut settings);
        run_settings.aliases.push(GitAlias {
            name: name.to_owned(),
            words,
        });
    }
    run_settings
}

// The line the setting `key`, in lower case, hands a shell with `value`: the whole value of a
// pager, an editor, an SSH command or an external diff, and a credential helper's after its `!`.
fn shell_line_of_setting<'v>(key: &str, value: &'v str) -> Option<&'v str> {
    if SHELL_LINE_SETTINGS.contains(&key) {
        return Some(value);
    }
    let is_credential_helper = key.starts_with("credential.") && key.ends_with(".helper");
    is_credential_helper
        .then(|| value.strip_prefix('!'))
        .flatten()
}

// Pushes each `<key>=<value>` setting of a `GIT_CONFIG_PARAMETERS` value, items single-quoted as
// a shell quotes them and parted by blanks, each `'<key>=<value>'` or `'<key>'='<value>'`, as
// git's own `-c` writes them; git stops at the first item it cannot read.
fn push_config_parameters(value: &str, settings: &mut Vec<String>) {
    let mut rest = value.trim_start();
    while !rest.is_empty() {
        let Some((key, after_key)) = single_quoted_step(rest) else {
            return;
        };
        let (setting, after_item) = match after_key.strip_prefix('=') {
            Some(after_equals) if after_equals.starts_with('\'') => {
                let Some((value, after_value)) = single_quoted_step(after_equals) else {
                    return;
                };
                (format!("{key}={value}"), after_value)
            }
            Some(after_equals) => (format!("{key}="), after_equals),
            None => (key, after_key),
        };
        if !after_item.is_empty() && !after_item.starts_with(char::is_whitespace) {
            return;
        }
        settings.push(setting);
        rest = after_item.trim_start();
    }
}

// The text of the single-quoted run at the start of `text`, quoted runs joined across a `\'` or
// `\!` between them as git reads them, and the text after it; `None` when `text` starts with no
// quote or a quote is left open.
fn single_quoted_step(text: &str) -> Option<(String, &str)> {
    let mut rest = text.strip_prefix('\'')?;
    let mut dequoted = String::new();
    loop {
        let close = rest.find('\'')?;
        dequoted.push_str(&rest[..close]);
        rest = &rest[close + 1..];
        let mut escape = rest.chars();
        match (escape.next(), escape.next(), escape.next()) {
            (Some('\\'), Some(escaped @ ('\'' | '!')), Some('\'')) => {
                dequoted.push(escaped);
                rest = &rest[3..];
            }
            _ => return Some((dequoted, rest)),
        }
    }
}

// Pushes the `<name>=<value>` setting of each `-c` option among git's own options in `words`, of
// those the line decides.
fn push_config_options<W: WordText>(
    words: impl IntoIterator<Item = W>,
    settings: &mut Vec<String>,
) {
    let mut follows_config_option = false;
    take_git_subcommand(&mut words.into_iter(), |word, is_option_value| {
        if is_option_value && follows_config_option && word.is_decided() {
            settings.push(word.chars().collect());
        }
        follows_config_option = !is_option_value && word.is("-c");
    });
}

// A word of git's arguments as the destructive reading reads it.
trait GitArgument: WordText {
    // Whether the shell passes the word as one word whatever the run makes of its text.
    fn is_one_quoted_parameter(self) -> bool;
}

impl GitArgument for ShellWord<'_> {
    fn is_one_quoted_parameter(self) -> bool {
        ShellWord::is_one_quoted_parameter(self)
    }
}

impl GitArgument for &str {
    fn is_one_quoted_parameter(self) -> bool {
        false
    }
}

// A word of a git command with its aliases in place: one the line read, or one of an alias's
// value.
#[derive(Clone, Copy)]
enum GitArgumentWord<'a> {
    Read(ShellWord<'a>),
    Alias(&'a str),
}

impl WordText for GitArgumentWord<'_> {
    fn is(self, text: &str) -> bool {
        match self {
            Self::Read(word) => word.is(text),
            Self::Alias(word) => word == text,
        }
    }

    fn starts_with(self, prefix: &str) -> bool {
        match self {
            Self::Read(word) => WordText::starts_with(word, prefix),
            Self::Alias(word) => word.starts_with(prefix),
        }
    }

    fn chars(self) -> impl Iterator<Item = char> {
        let (read, alias) = match self {
            Self::Read(word) => (Some(WordText::chars(word)), None),
            Self::Alias(word) => (None, Some(word.chars())),
        };
        read.into_iter()
            .flatten()
            .chain(alias.into_iter().flatten())
    }

    fn contains(self, byte: PositionedByte) -> bool {
        match self {
            Self::Read(word) => WordText::contains(word, byte),
            Self::Alias(word) => WordText::contains(word, byte),
        }
    }

    fn is_decided(self) -> bool {
        match self {
            Self::Read(word) => word.is_decided(),
            Self::Alias(_) => true,
        }
    }
}

impl GitArgument for GitArgumentWord<'_> {
    fn is_one_quoted_parameter(self) -> bool {
        match self {
            Self::Read(word) => word.is_one_quoted_parameter(),
            Self::Alias(_) => false,
        }
    }
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
    // zsh drops the backslash of an escape it does not know, so this word is `push` there.
    #[case::unknown_ansi_c_escape(r"git $'\push' --force", true)]
    // A program the text does not spell is read by the words it does spell.
    #[case::expanded_program("G=git; $G push --force", false)]
    #[case::undecided_operand_before_another_program("timeout \"$T\" cargo test", false)]
    // Programs that run the words after them, and zsh's `=name`, which names a program's path.
    #[case::builtin_eval("builtin eval 'git push --force'", true)]
    #[case::noglob_modifier("noglob git push --force", true)]
    #[case::equals_expansion("=git push --force", true)]
    #[case::dash_modifier("true; - git push --force", true)]
    // xargs appends its input's words to the command, and puts them where the command holds the
    // string it replaces.
    #[case::xargs_appended_words("echo --force | xargs git push origin main", true)]
    #[case::xargs_replaced_argument("echo --force | xargs -I% git push origin %", true)]
    #[case::xargs_replaced_shell_string("echo 'git push -f' | xargs -I% sh -c %", true)]
    #[case::xargs_appended_shell_string("echo 'git push -f' | xargs sh -c", true)]
    #[case::xargs_appended_words_after_a_reading_subcommand("echo x | xargs git status", false)]
    // A shell handed no `-c` string and no script reads its line from its input, and `source`
    // reads one from anything but a regular file, its path's `.` and `..` folded.
    #[case::here_string_to_a_shell("sh <<< 'git push --force'", true)]
    #[case::pipe_into_a_shell("echo 'git push --force' | sh", true)]
    #[case::shell_reading_its_input("sh -s <<< x", true)]
    #[case::source_of_the_input("source /dev/stdin <<< x", true)]
    #[case::source_of_a_substitution(". <(echo x)", true)]
    #[case::climb_to_the_input("sh ../../dev/stdin <<< x", true)]
    #[case::source_through_a_device_folder("source /dev/fd/../stdin <<< x", true)]
    #[case::shell_running_a_script("sh ./script.sh", false)]
    #[case::source_of_a_script("source ./x.sh", false)]
    // `su` handed no command, and a wrapper left with none that runs a shell, run a shell reading
    // its input, as does a wrapper that xargs hands its input's words.
    #[case::su_reading_its_input("echo 'git push --force' | su root", true)]
    #[case::sudo_shell_reading_its_input("echo 'git push --force' | sudo -s", true)]
    #[case::sudo_login_shell_in_a_cluster("echo 'git push --force' | sudo -Ei", true)]
    #[case::doas_shell_reading_its_input("echo 'git push --force' | doas -s", true)]
    #[case::chroot_shell_reading_its_input("echo 'git push --force' | chroot /x", true)]
    #[case::script_shell_reading_its_input("echo 'git push --force' | script -q /dev/null", true)]
    #[case::xargs_handing_sudo_its_input("echo 'git push --force' | xargs sudo -s", true)]
    #[case::xargs_handing_a_wrapper_its_input("echo 'git push --force' | xargs nohup", true)]
    #[case::sudo_user_named_s("echo 'git push --force' | sudo -us", false)]
    // The words of an alias a line defines run where the line uses it.
    #[case::alias_value("shopt -s expand_aliases\nalias g='git push --force'\ng", true)]
    // A split string's split strings are read in turn, and past the bound on what they read the
    // line is judged by the words it shows; a line break or vertical tab is a blank.
    #[case::nested_split_past_the_line("env -S'-S \"git push --force\"'", true)]
    #[case::nested_split_chain("env -S-S-S-Sgit push --force", true)]
    #[case::line_break_in_a_split_string("env -S'A=1\ngit push --force'", true)]
    #[case::vertical_tab_in_a_split_string("env -S'git\u{b}push\u{b}--force'", true)]
    // Programs that run their words as a command, or hand a shell a line.
    #[case::trap_line("trap 'git push --force' EXIT", true)]
    #[case::find_exec("find . -exec git push --force \\;", true)]
    #[case::find_okdir_after_its_path("find . -okdir git push --force {} +", true)]
    #[case::find_exec_of_a_reading_command("find . -exec git status \\;", false)]
    #[case::script_command("script -q /dev/null git push --force", true)]
    #[case::script_line("script -c 'git push --force' /dev/null", true)]
    #[case::sandbox_command("sandbox-exec -p '(version 1)(allow default)' git push --force", true)]
    #[case::completion_line("compgen -C 'git push --force' x", true)]
    #[case::mapfile_line("mapfile -tC 'git push --force' -c 1 <<< x", true)]
    #[case::readarray_attached_line("readarray -c1 -C'git push --force' <<< x", true)]
    #[case::emulate_line("emulate sh -c 'git push --force'", true)]
    #[case::repeat_count("repeat 1 git push --force", true)]
    #[case::zargs_command("zargs -- x -- git push --force", true)]
    #[case::zargs_input_appended("zargs -- --force -- git push origin", true)]
    #[case::chroot_command("chroot / git push --force", true)]
    #[case::watch_words("watch -n 1 'git push' --force", true)]
    #[case::flock_command("flock f git push --force", true)]
    #[case::flock_line("flock f -c 'git push --force'", true)]
    #[case::flock_descriptor("flock --fd 3 git push --force", true)]
    // git's aliases: a value starting `!` is a shell line, any other git's own words.
    #[case::git_alias_line("git -c alias.x='!git push --force' x", true)]
    #[case::git_alias_words("git -c alias.x='push --force' x", true)]
    #[case::git_alias_before_its_words("git -c alias.p=push p --force", true)]
    #[case::git_alias_of_a_reading_subcommand("git -c alias.l=log l --force", false)]
    #[case::git_environment_alias_line(
        "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0='!git push --force' git x",
        true
    )]
    // git's settings whose value it hands a shell, from `-c`, the environment or its parameters.
    #[case::git_pager_setting("git -c core.pager='git push --force' log", true)]
    #[case::git_pager_environment("GIT_PAGER='git push --force' git log", true)]
    #[case::git_credential_helper_line("git -c credential.helper='!git push --force' fetch", true)]
    #[case::git_parameters_alias("GIT_CONFIG_PARAMETERS=\"'alias.x'='push --force'\" git x", true)]
    #[case::git_parameters_pager(
        "GIT_CONFIG_PARAMETERS=\"'core.pager=git push -f'\" git log",
        true
    )]
    #[case::git_hooks_folder("git -c core.hooksPath=/x status", false)]
    #[case::git_alias_from_the_environment("git --config-env=alias.x=A x", false)]
    #[case::git_environment_alias_through_env(
        "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p --force",
        true
    )]
    // sudo's long options that take no value are named whole, so a prefix of one reads no other.
    #[case::sudo_login("sudo --login git push --force", true)]
    #[case::sudo_login_class("sudo --login-class X git push --force", true)]
    // A line the parser does not read whole is judged by the words it still shows.
    #[case::zsh_short_loop("for x in 1; git push --force", true)]
    #[case::zsh_short_loop_of_a_reading_command("for x in 1; git status", false)]
    #[case::zsh_short_loop_with_a_comment("for x in 1; git push origin #--force", false)]
    #[case::nocorrect_modifier("nocorrect git push --force", true)]
    #[case::here_document_to_a_shell("sh <<E\ngit push --force\nE", true)]
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
