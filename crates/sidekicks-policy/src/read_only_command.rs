//! Whether a shell line only reads: the daemon's own verdict on a command a provider ran, which
//! takes no provider's word for it. The verdict is an allow list: a line passes only when every
//! form it holds is one a reading line may hold, every program it runs is on a short closed list of
//! reading programs, and every option it gives one is on that program's own closed set, none of
//! which writes a file or runs another program; any other line does not.

use std::borrow::Cow;

use crate::destructive_git::read_git_subcommand;
use crate::shell_commands::{
    ShellCommand, ShellLineReader, ShellWord, WordText, is_option, unwrap_shell_command_line,
};

/// Whether `line`, a provider's command line, only reads: it holds at most 10,000 characters and,
/// after any `<shell> -lc '…'` wrapper is taken off, reads whole on `reader` as the shell reads it,
/// holds only forms a reading line may hold, runs no `git` beside a `cd`, and runs only listed
/// programs, through listed wrappers, each named without a folder and given only decided words
/// where its options could write or run something, with listed options.
pub fn is_read_only_command(reader: &mut ShellLineReader, line: &str) -> bool {
    if line.chars().nth(MAX_LINE_CHARACTERS).is_some() {
        return false;
    }
    let unwrapped = unwrap_shell_command_line(line);
    let Some(line) = line_as_the_shell_reads(&unwrapped) else {
        return false;
    };
    let reading = reader.read(&line);
    if !reading.is_whole() || !reading.holds_only_reading_forms() {
        return false;
    }
    let runs = |name: &str| reading.commands().any(|command| command.program().is(name));
    // A `git` run in a folder a `cd` moved to runs that folder's hooks and configured programs.
    if runs("cd") && runs("git") {
        return false;
    }
    reading.commands().all(is_reading_command)
}

// Past this many characters a line is not read for a verdict at all.
const MAX_LINE_CHARACTERS: usize = 10_000;

// The line with each line continuation joined as the shell joins it, or `None` when the parser
// would part words where the shell does not: a control character or a blank other than space, tab
// and newline, which the parser reads as a separator; a backslash before a tab, or before a space
// that starts a word, which the parser drops between words; and a continuation in a line that
// quotes, expands or opens a here-document, where only a full read could place it.
fn line_as_the_shell_reads(line: &str) -> Option<Cow<'_, str>> {
    if line.chars().any(|character| {
        (character.is_control() && !matches!(character, '\t' | '\n'))
            || (character.is_whitespace() && !matches!(character, ' ' | '\t' | '\n'))
    }) {
        return None;
    }
    let joined = join_line_continuations(line)?;
    let bytes = joined.as_bytes();
    let parts_words = bytes.windows(2).enumerate().any(|(at, pair)| match pair {
        [b'\\', b'\t'] => true,
        [b'\\', b' '] => at
            .checked_sub(1)
            .and_then(|before| bytes.get(before))
            .is_none_or(|&before| WORD_BREAKING_BYTES.contains(&before)),
        _ => false,
    });
    (!parts_words).then_some(joined)
}

// The bytes after which a word token cannot go on: the parser's special characters and blanks.
const WORD_BREAKING_BYTES: &[u8] = b"'\"<>{}[]()`$|&;\\ \t\n";

// The line with each unquoted backslash-newline removed, or `None` when the line holds one beside
// a quote, an expansion, a comment or a redirect, whose reading decides whether it is quoted.
fn join_line_continuations(line: &str) -> Option<Cow<'_, str>> {
    let bytes = line.as_bytes();
    let mut continuations = Vec::new();
    let mut position = 0;
    while position < bytes.len() {
        if bytes[position] == b'\\' {
            if bytes.get(position + 1) == Some(&b'\n') {
                continuations.push(position);
            }
            position += 2;
        } else {
            position += 1;
        }
    }
    if continuations.is_empty() {
        return Some(Cow::Borrowed(line));
    }
    if line.contains(['\'', '"', '`', '$', '#', '<']) {
        return None;
    }
    let mut joined = String::with_capacity(line.len());
    let mut kept_from = 0;
    for continuation in continuations {
        joined.push_str(&line[kept_from..continuation]);
        kept_from = continuation + 2;
    }
    joined.push_str(&line[kept_from..]);
    Some(Cow::Owned(joined))
}

// The programs that run the command after them whose own options neither write nor run anything,
// each with its closed set of options and the count of operands it takes before the command.
struct ReadingWrapper {
    name: &'static str,
    options: GetoptOptions,
    operand_count: usize,
}

const READING_WRAPPERS: &[ReadingWrapper] = &[
    ReadingWrapper {
        name: "command",
        options: GetoptOptions {
            flags: "p",
            letters_with_value: "",
            letters_with_attached_value: "",
            long: &[],
            long_with_value: &[],
            takes_count: false,
        },
        operand_count: 0,
    },
    ReadingWrapper {
        name: "nice",
        options: GetoptOptions {
            flags: "",
            letters_with_value: "n",
            letters_with_attached_value: "",
            long: &[],
            long_with_value: &[&["--adjustment"]],
            takes_count: true,
        },
        operand_count: 0,
    },
    // The duration comes before the command.
    ReadingWrapper {
        name: "timeout",
        options: GetoptOptions {
            flags: "v",
            letters_with_value: "sk",
            letters_with_attached_value: "",
            long: &[&["--preserve-status", "--foreground", "--verbose"]],
            long_with_value: &[&["--signal", "--kill-after"]],
            takes_count: false,
        },
        operand_count: 1,
    },
];

// How a listed program's option words are read.
enum ProgramOptions {
    // Short letters, alone or in a cluster, and long options, alone or with `=<value>`; `--` ends
    // them.
    Getopt(GetoptOptions),
    // `find`'s primaries, each a whole word with the count of value words after it; `--` ends
    // nothing.
    Primaries(&'static [(&'static str, usize)]),
}

// A program's closed set of getopt-style options. A value an option takes is never checked, so a
// value of `--` or of a listed program's dangerous option ends or hides nothing.
struct GetoptOptions {
    // Short letters that take no value.
    flags: &'static str,
    // Short letters that require a value: the rest of the cluster, or the next word when the
    // letter ends it.
    letters_with_value: &'static str,
    // Short letters whose value is optional and only the rest of the cluster, as git's `-U3`.
    letters_with_attached_value: &'static str,
    // Long options that take no value or an optional one after `=`, in groups so programs share
    // one.
    long: &'static [&'static [&'static str]],
    // Long options that require a value: after `=`, or the next word.
    long_with_value: &'static [&'static [&'static str]],
    // Whether `-<digits>` is a count, as in `head -5` or `git log -3`.
    takes_count: bool,
}

// A listed program and its closed set of options.
struct ReadingProgram {
    name: &'static str,
    options: ProgramOptions,
    // Whether no option of the program, listed or not, writes or runs anything, so a word only
    // the line's run decides, which can turn into any option, stays harmless.
    takes_undecided_words: bool,
}

const fn getopt(
    flags: &'static str,
    letters_with_value: &'static str,
    long: &'static [&'static [&'static str]],
    long_with_value: &'static [&'static [&'static str]],
    takes_count: bool,
) -> ProgramOptions {
    ProgramOptions::Getopt(GetoptOptions {
        flags,
        letters_with_value,
        letters_with_attached_value: "",
        long,
        long_with_value,
        takes_count,
    })
}

const HEAD_TAIL_LONG: &[&str] = &["--quiet", "--silent", "--verbose"];
const HEAD_TAIL_LONG_WITH_VALUE: &[&str] = &["--lines", "--bytes"];

// `rg` without `--pre`, `--pre-glob`, `--hostname-bin` or `--search-zip`, which run programs.
const RG_LONG: &[&str] = &[
    "--ignore-case",
    "--smart-case",
    "--case-sensitive",
    "--fixed-strings",
    "--word-regexp",
    "--line-regexp",
    "--invert-match",
    "--line-number",
    "--no-line-number",
    "--files-with-matches",
    "--files-without-match",
    "--count",
    "--count-matches",
    "--only-matching",
    "--quiet",
    "--hidden",
    "--no-ignore",
    "--follow",
    "--type-list",
    "--files",
    "--heading",
    "--no-heading",
    "--with-filename",
    "--no-filename",
    "--json",
    "--vimgrep",
    "--multiline",
    "--multiline-dotall",
    "--pcre2",
    "--trim",
    "--column",
    "--null",
    "--stats",
    "--unrestricted",
    "--text",
    "--no-messages",
    "--no-ignore-vcs",
];

const RG_LONG_WITH_VALUE: &[&str] = &[
    "--glob",
    "--iglob",
    "--type",
    "--type-not",
    "--file",
    "--regexp",
    "--max-count",
    "--max-depth",
    "--after-context",
    "--before-context",
    "--context",
    "--color",
    "--sort",
    "--sortr",
    "--replace",
    "--max-columns",
    "--max-filesize",
    "--ignore-file",
];

const GREP_LONG: &[&str] = &[
    "--ignore-case",
    "--extended-regexp",
    "--fixed-strings",
    "--perl-regexp",
    "--word-regexp",
    "--line-regexp",
    "--invert-match",
    "--line-number",
    "--files-with-matches",
    "--files-without-match",
    "--count",
    "--only-matching",
    "--quiet",
    "--silent",
    "--no-messages",
    "--with-filename",
    "--no-filename",
    "--recursive",
    "--dereference-recursive",
    "--color",
    "--colour",
    "--null",
    "--text",
];

const GREP_LONG_WITH_VALUE: &[&str] = &[
    "--include",
    "--exclude",
    "--exclude-dir",
    "--max-count",
    "--after-context",
    "--before-context",
    "--context",
    "--regexp",
    "--file",
];

// `diff` without `-l` (`--paginate`), which runs `pr`.
const DIFF_LONG: &[&str] = &[
    "--unified",
    "--context",
    "--brief",
    "--recursive",
    "--new-file",
    "--ignore-all-space",
    "--ignore-space-change",
    "--ignore-blank-lines",
    "--ignore-case",
    "--text",
    "--color",
    "--strip-trailing-cr",
    "--report-identical-files",
];

const LS_LONG: &[&str] = &[
    "--all",
    "--almost-all",
    "--human-readable",
    "--recursive",
    "--reverse",
    "--color",
    "--classify",
    "--directory",
    "--inode",
    "--size",
    "--group-directories-first",
];

const READING_PROGRAMS: &[ReadingProgram] = &[
    ReadingProgram {
        name: "cat",
        options: getopt(
            "benstuvAET",
            "",
            &[&[
                "--number",
                "--number-nonblank",
                "--squeeze-blank",
                "--show-all",
                "--show-ends",
                "--show-tabs",
                "--show-nonprinting",
            ]],
            &[],
            false,
        ),
        takes_undecided_words: true,
    },
    ReadingProgram {
        name: "head",
        options: getopt(
            "qv",
            "nc",
            &[HEAD_TAIL_LONG],
            &[HEAD_TAIL_LONG_WITH_VALUE],
            true,
        ),
        takes_undecided_words: true,
    },
    ReadingProgram {
        name: "tail",
        options: getopt(
            "qv",
            "nc",
            &[HEAD_TAIL_LONG],
            &[HEAD_TAIL_LONG_WITH_VALUE],
            true,
        ),
        takes_undecided_words: true,
    },
    ReadingProgram {
        name: "ls",
        options: getopt(
            "1aAcdFGhilLnprRStu",
            "",
            &[LS_LONG],
            &[&["--sort", "--time-style"]],
            false,
        ),
        takes_undecided_words: true,
    },
    ReadingProgram {
        name: "wc",
        options: getopt(
            "clmwL",
            "",
            &[&[
                "--bytes",
                "--chars",
                "--lines",
                "--words",
                "--max-line-length",
            ]],
            &[],
            false,
        ),
        takes_undecided_words: true,
    },
    ReadingProgram {
        name: "stat",
        options: getopt(
            "LFnqrsx",
            "cft",
            &[&["--dereference", "--terse", "--file-system"]],
            &[&["--format", "--printf"]],
            false,
        ),
        takes_undecided_words: true,
    },
    ReadingProgram {
        name: "rg",
        options: getopt(
            "iSsFwxvnNlcoqHIL.u0UP",
            "egtTABCmMdjrf",
            &[RG_LONG],
            &[RG_LONG_WITH_VALUE],
            false,
        ),
        takes_undecided_words: false,
    },
    ReadingProgram {
        name: "grep",
        options: getopt(
            "iEFGPwxvnlLcoqshHrRIaZz",
            "eABCmfd",
            &[GREP_LONG],
            &[GREP_LONG_WITH_VALUE],
            false,
        ),
        takes_undecided_words: true,
    },
    ReadingProgram {
        name: "diff",
        options: getopt("uqrNwbBiac", "UCx", &[DIFF_LONG], &[&["--exclude"]], false),
        takes_undecided_words: false,
    },
    // `find` without `-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fls` or `-fprint*`.
    ReadingProgram {
        name: "find",
        options: ProgramOptions::Primaries(&[
            ("-H", 0),
            ("-L", 0),
            ("-P", 0),
            ("-name", 1),
            ("-iname", 1),
            ("-path", 1),
            ("-ipath", 1),
            ("-regex", 1),
            ("-iregex", 1),
            ("-type", 1),
            ("-maxdepth", 1),
            ("-mindepth", 1),
            ("-depth", 0),
            ("-newer", 1),
            ("-mtime", 1),
            ("-mmin", 1),
            ("-size", 1),
            ("-empty", 0),
            ("-user", 1),
            ("-group", 1),
            ("-perm", 1),
            ("-links", 1),
            ("-follow", 0),
            ("-print", 0),
            ("-print0", 0),
            ("-ls", 0),
            ("-prune", 0),
            ("-not", 0),
            ("-and", 0),
            ("-or", 0),
            ("-a", 0),
            ("-o", 0),
        ]),
        takes_undecided_words: false,
    },
    ReadingProgram {
        name: "cd",
        options: getopt("LP", "", &[], &[], false),
        takes_undecided_words: true,
    },
    ReadingProgram {
        name: "pwd",
        options: getopt("LP", "", &[], &[], false),
        takes_undecided_words: true,
    },
    ReadingProgram {
        name: "echo",
        options: getopt("neE", "", &[], &[], false),
        takes_undecided_words: true,
    },
    ReadingProgram {
        name: "which",
        options: getopt("as", "", &[], &[], false),
        takes_undecided_words: true,
    },
    // `command` with `-v` or `-V`, which prints how the shell finds a name; any other `command`
    // is read as the wrapper of the command it runs.
    ReadingProgram {
        name: "command",
        options: getopt("pvV", "", &[], &[], false),
        takes_undecided_words: true,
    },
];

// Git's own options a reading `git` may take before its subcommand: none takes a value, so none
// sets configuration, moves git to another folder or changes the programs it runs.
const GIT_GLOBAL_OPTIONS: &[&str] = &["--no-pager", "-P", "--no-optional-locks"];

// The output options `git log`, `diff` and `show` share, without `--output`, which writes a file,
// and `--ext-diff` or `--textconv`, which run configured programs.
const GIT_DIFF_OUTPUT_LONG: &[&str] = &[
    "--stat",
    "--shortstat",
    "--numstat",
    "--name-only",
    "--name-status",
    "--patch",
    "--no-patch",
    "--color",
    "--no-color",
    "--word-diff",
    "--unified",
    "--no-ext-diff",
    "--no-textconv",
    "--relative",
    "--ignore-all-space",
    "--ignore-space-change",
    "--minimal",
    "--patience",
    "--histogram",
    "--abbrev",
];

const GIT_DIFF_OUTPUT_LONG_WITH_VALUE: &[&str] = &["--diff-filter"];

const GIT_HISTORY_LONG: &[&str] = &[
    "--oneline",
    "--format",
    "--pretty",
    "--abbrev-commit",
    "--decorate",
    "--no-decorate",
];

const GIT_HISTORY_LONG_WITH_VALUE: &[&str] = &["--date"];

// Git's reading subcommands, each with its own closed set of options.
const GIT_READING_SUBCOMMANDS: &[(&str, GetoptOptions)] = &[
    (
        "status",
        GetoptOptions {
            flags: "sbvz",
            letters_with_value: "",
            letters_with_attached_value: "u",
            long: &[&[
                "--short",
                "--branch",
                "--porcelain",
                "--long",
                "--verbose",
                "--untracked-files",
                "--ignored",
                "--show-stash",
                "--ahead-behind",
                "--no-ahead-behind",
                "--renames",
                "--no-renames",
            ]],
            long_with_value: &[],
            takes_count: false,
        },
    ),
    (
        "log",
        GetoptOptions {
            flags: "p",
            letters_with_value: "nSG",
            letters_with_attached_value: "",
            long: &[
                GIT_DIFF_OUTPUT_LONG,
                GIT_HISTORY_LONG,
                &[
                    "--graph",
                    "--all",
                    "--branches",
                    "--follow",
                    "--reverse",
                    "--merges",
                    "--no-merges",
                    "--first-parent",
                    "--topo-order",
                    "--date-order",
                ],
            ],
            long_with_value: &[
                GIT_DIFF_OUTPUT_LONG_WITH_VALUE,
                GIT_HISTORY_LONG_WITH_VALUE,
                &[
                    "--max-count",
                    "--skip",
                    "--author",
                    "--committer",
                    "--since",
                    "--until",
                    "--after",
                    "--before",
                    "--grep",
                ],
            ],
            takes_count: true,
        },
    ),
    (
        "diff",
        GetoptOptions {
            flags: "pw",
            letters_with_value: "",
            letters_with_attached_value: "U",
            long: &[
                GIT_DIFF_OUTPUT_LONG,
                &[
                    "--cached",
                    "--staged",
                    "--no-index",
                    "--merge-base",
                    "--exit-code",
                    "--quiet",
                    "--check",
                ],
            ],
            long_with_value: &[GIT_DIFF_OUTPUT_LONG_WITH_VALUE],
            takes_count: false,
        },
    ),
    (
        "show",
        GetoptOptions {
            flags: "ps",
            letters_with_value: "",
            letters_with_attached_value: "",
            long: &[GIT_DIFF_OUTPUT_LONG, GIT_HISTORY_LONG, &["--quiet"]],
            long_with_value: &[GIT_DIFF_OUTPUT_LONG_WITH_VALUE, GIT_HISTORY_LONG_WITH_VALUE],
            takes_count: false,
        },
    ),
];

// Whether one simple command only reads: each wrapper and its program listed and named without a
// folder, since only the system program of a listed name reads, each wrapper given only decided
// words from its own closed set, and every option word on the program's closed set.
fn is_reading_command(command: ShellCommand<'_>) -> bool {
    let program = command.program();
    if command.is_named_by_path()
        || !program.is_decided()
        || !runs_through_reading_wrappers(command)
    {
        return false;
    }
    if program.is("git") {
        return is_reading_git(command);
    }
    let Some(listed) = READING_PROGRAMS
        .iter()
        .find(|listed| program.is(listed.name))
    else {
        return false;
    };
    let mut words = command.argument_words();
    if !listed.takes_undecided_words && !command.argument_words().all(ShellWord::is_decided) {
        return false;
    }
    match &listed.options {
        ProgramOptions::Getopt(options) => takes_only_listed_options(options, &mut words),
        ProgramOptions::Primaries(primaries) => takes_only_listed_primaries(primaries, &mut words),
    }
}

// Whether the words before the program are reading wrappers, each followed by its listed options
// and its operands, every word decided, since bash splits a word only the run decides into any
// option or program.
fn runs_through_reading_wrappers(command: ShellCommand<'_>) -> bool {
    if !command.wrapper_words().all(ShellWord::is_decided) {
        return false;
    }
    let mut words = command.wrapper_words().peekable();
    while let Some(name) = words.next() {
        let Some(wrapper) = READING_WRAPPERS
            .iter()
            .find(|wrapper| name.is(wrapper.name))
        else {
            return false;
        };
        while let Some(word) = words.next_if(|word| word.starts_with("-") && !word.is("-")) {
            if word.is("--") {
                break;
            }
            let option = if word.starts_with("--") {
                read_long_option(&wrapper.options, word)
            } else {
                read_short_cluster(&wrapper.options, word)
            };
            match option {
                OptionWord::Unlisted => return false,
                OptionWord::Whole => {}
                OptionWord::TakesNextWord => {
                    if words.next().is_none() {
                        return false;
                    }
                }
            }
        }
        for _ in 0..wrapper.operand_count {
            if words.next().is_none() {
                return false;
            }
        }
    }
    true
}

// Whether every word that starts with `-`, a primary's values aside, is a listed primary.
fn takes_only_listed_primaries<'r>(
    primaries: &[(&str, usize)],
    words: &mut impl Iterator<Item = ShellWord<'r>>,
) -> bool {
    while let Some(word) = words.next() {
        if !word.starts_with("-") {
            continue;
        }
        let Some(&(_, value_count)) = primaries.iter().find(|(primary, _)| word.is(primary)) else {
            return false;
        };
        for _ in 0..value_count {
            words.next();
        }
    }
    true
}

// A `git` command that only reads: every word decided, git's own options listed, and a reading
// subcommand with only its listed options. The subcommand is found by git's one option walk.
fn is_reading_git(command: ShellCommand<'_>) -> bool {
    if !command.argument_words().all(ShellWord::is_decided) {
        return false;
    }
    let mut rest = command.argument_words();
    let word_count = rest.len();
    let Some(subcommand) = read_git_subcommand(&mut rest).subcommand else {
        return false;
    };
    // The words before the subcommand are git's own options.
    let global_option_count = word_count - rest.len() - 1;
    command
        .argument_words()
        .take(global_option_count)
        .all(|word| GIT_GLOBAL_OPTIONS.iter().any(|option| word.is(option)))
        && GIT_READING_SUBCOMMANDS
            .iter()
            .find(|(name, _)| subcommand.is(name))
            .is_some_and(|(_, options)| takes_only_listed_options(options, &mut rest))
}

// Whether every option word before a `--` is on `options`: a long option by its name, a short
// cluster letter by letter up to one that takes a value, or a count. An option's value is skipped
// unchecked, so a value of `--` ends nothing.
fn takes_only_listed_options<'r>(
    options: &GetoptOptions,
    words: &mut impl Iterator<Item = ShellWord<'r>>,
) -> bool {
    while let Some(word) = words.next() {
        if word.is("--") {
            return true;
        }
        if word.is("-") || !word.starts_with("-") {
            continue;
        }
        let option = if word.starts_with("--") {
            read_long_option(options, word)
        } else {
            read_short_cluster(options, word)
        };
        match option {
            OptionWord::Unlisted => return false,
            OptionWord::Whole => {}
            OptionWord::TakesNextWord => {
                words.next();
            }
        }
    }
    true
}

// How one option word reads against a program's closed set.
enum OptionWord {
    Unlisted,
    // Listed, with any value inside the word.
    Whole,
    // Listed, its value the next word.
    TakesNextWord,
}

// A listed long option, alone or with `=<value>`; one that requires a value and has no `=` takes
// the next word.
fn read_long_option(options: &GetoptOptions, word: ShellWord<'_>) -> OptionWord {
    let listed_in = |groups: &[&[&'static str]]| -> Option<&'static str> {
        groups
            .iter()
            .flat_map(|group| group.iter())
            .find(|option| is_option(word, option))
            .copied()
    };
    if let Some(option) = listed_in(options.long_with_value) {
        return if word.is(option) {
            OptionWord::TakesNextWord
        } else {
            OptionWord::Whole
        };
    }
    if listed_in(options.long).is_some() {
        OptionWord::Whole
    } else {
        OptionWord::Unlisted
    }
}

// A `-` and then listed letters, the first one that takes a value ending the cluster and taking the
// next word when nothing follows it, or digits alone for a program that takes a count.
fn read_short_cluster(options: &GetoptOptions, word: ShellWord<'_>) -> OptionWord {
    let mut characters = word.chars().skip(1).peekable();
    if options.takes_count
        && characters.peek().is_some()
        && word
            .chars()
            .skip(1)
            .all(|character| character.is_ascii_digit())
    {
        return OptionWord::Whole;
    }
    while let Some(character) = characters.next() {
        if options.letters_with_value.contains(character) {
            return if characters.peek().is_none() {
                OptionWord::TakesNextWord
            } else {
                OptionWord::Whole
            };
        }
        if options.letters_with_attached_value.contains(character) {
            return OptionWord::Whole;
        }
        if !options.flags.contains(character) {
            return OptionWord::Unlisted;
        }
    }
    OptionWord::Whole
}

#[cfg(test)]
mod tests;
