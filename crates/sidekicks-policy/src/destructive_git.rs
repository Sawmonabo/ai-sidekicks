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

// The long options of `git push` that force or delete, by any prefix, alone or with `=<value>`.
const PUSH_DESTRUCTIVE_OPTIONS: &[&str] = &[
    "--force",
    "--force-with-lease",
    "--force-if-includes",
    "--delete",
    "--mirror",
    "--prune",
];

// The short options of `git push` that force (`f`) or delete (`d`), alone or in a cluster.
const PUSH_DESTRUCTIVE_LETTERS: &[char] = &['f', 'd'];

// The long option of `git branch` that deletes, and its short ones (`d`, `D`).
const BRANCH_DELETE_OPTIONS: &[&str] = &["--delete"];
const BRANCH_DELETE_LETTERS: &[char] = &['d', 'D'];

/// Whether the line `reading` holds runs a force push or a branch delete anywhere, the lines its
/// listed programs hand a shell, the here-document or here-string a shell reads as its input on
/// its own statement and the lines its git settings hand a shell included, each reread on
/// `reader`. Each command is read by the words its text spells, so one whose program only the run
/// decides counts as none; a shell fed by a pipe or a file is not read; a line not read whole
/// counts as one when the words it still shows name one, its listed shells' `-c` strings and
/// `eval`'s words reread; a string the reader leaves unread holds no command, so it reads as no
/// destructive git.
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

/// Whether `word` names one of a git subcommand's options as git's own option parser reads it: a
/// `--` word whose name, up to any `=`, begins one of `long_options`, each written with its `--`
/// (git takes a unique prefix, and an ambiguous one, which git refuses, counts too), or a `-`
/// cluster holding one of `short_letters` before its first character that is neither a letter nor
/// a digit, where an attached value starts. git's own options before the subcommand take no prefix.
pub fn is_git_option_among(
    word: impl WordText,
    long_options: &[&str],
    short_letters: &[char],
) -> bool {
    if word.starts_with("--") {
        let name = || {
            word.chars()
                .skip(2)
                .take_while(|&character| character != '=')
        };
        return name().next().is_some()
            && long_options.iter().any(|option| {
                let mut option_characters = option.chars().skip(2);
                name().all(|character| option_characters.next() == Some(character))
            });
    }
    let mut characters = word.chars();
    characters.next() == Some('-')
        && characters
            .take_while(char::is_ascii_alphanumeric)
            .any(|letter| short_letters.contains(&letter))
}

// Whether a command of `reading` is a destructive git command, or a line not read whole shows
// one; each string a command hands a shell, or its git settings do, or a listed shell or `eval`
// in a run of a line not read whole does, is read and left in `rereads` to be judged in its place.
fn holds_destructive_git(
    reader: &mut ShellLineReader,
    reading: &ShellLineReading,
    rereads: &mut Vec<Arc<ShellLineReading>>,
) -> bool {
    if !reading.is_whole() {
        for run in reading.unread_word_runs() {
            if runs_git_words(&run) {
                return true;
            }
            rereads.extend(reader.read_run_strings(&run));
        }
    }
    for command in reading.commands() {
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

// A push that forces or deletes, or a branch delete, of git's `arguments`, read by the words
// their text spells: a word that spells alternatives, a brace expansion's or an ANSI-C string's
// the shells decode apart, counts as a match wherever a word is read, since one of them may be
// git's own option, its value, the subcommand or an option of a push; a word only the run decides,
// a parameter, a substitution or a pattern, is none of them.
fn is_destructive_git_arguments<W: WordText>(arguments: impl Iterator<Item = W>) -> bool {
    let mut rest = arguments;
    let mut takes_alternatives = false;
    let reading = take_git_subcommand(&mut rest, |word, _| {
        takes_alternatives |= word.spells_alternatives();
    });
    if takes_alternatives {
        return true;
    }
    let Some(subcommand) = reading.subcommand else {
        return false;
    };
    if subcommand.is("push") {
        return rest.any(|word| {
            word.spells_alternatives()
                || is_git_option_among(word, PUSH_DESTRUCTIVE_OPTIONS, PUSH_DESTRUCTIVE_LETTERS)
                // A refspec that forces (`+main`) or deletes (`:main`) the branch it names.
                || word.starts_with("+")
                || word.starts_with(":")
        });
    }
    if subcommand.is("branch") {
        return rest.any(|word| {
            word.spells_alternatives()
                || is_git_option_among(word, BRANCH_DELETE_OPTIONS, BRANCH_DELETE_LETTERS)
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

    fn spells_alternatives(self) -> bool {
        match self {
            Self::Read(word) => word.spells_alternatives(),
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

#[cfg(test)]
mod tests;
