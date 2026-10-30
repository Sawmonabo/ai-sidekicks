//! The closed lists a line that only reads draws on: the wrappers, the programs and git's own
//! options and subcommands, each with the options it may take.

/// A program that runs the command after it whose own options neither write nor run anything,
/// with its closed set of options and the count of operands it takes before the command.
pub(super) struct ReadingWrapper {
    /// The wrapper's name.
    pub(super) name: &'static str,
    /// Its closed set of options.
    pub(super) options: GetoptOptions,
    /// The count of operands it takes before the command.
    pub(super) operand_count: usize,
}

/// The reading wrappers, each with its options and operand count.
pub(super) const READING_WRAPPERS: &[ReadingWrapper] = &[
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

/// How a listed program's option words are read.
pub(super) enum ProgramOptions {
    /// Short letters, alone or in a cluster, and long options, alone or with `=<value>`; `--`
    /// ends them.
    Getopt(GetoptOptions),
    /// `find`'s primaries, each a whole word with the count of value words after it; `--` ends
    /// nothing.
    Primaries(&'static [(&'static str, usize)]),
}

/// A program's closed set of getopt-style options. A value an option takes is never checked, so a
/// value of `--` or of a listed program's dangerous option ends or hides nothing.
pub(super) struct GetoptOptions {
    /// Short letters that take no value.
    pub(super) flags: &'static str,
    /// Short letters that require a value: the rest of the cluster, or the next word when the
    /// letter ends it.
    pub(super) letters_with_value: &'static str,
    /// Short letters whose value is optional and only the rest of the cluster, as git's `-U3`.
    pub(super) letters_with_attached_value: &'static str,
    /// Long options that take no value or an optional one after `=`, in groups so programs share
    /// one.
    pub(super) long: &'static [&'static [&'static str]],
    /// Long options that require a value: after `=`, or the next word.
    pub(super) long_with_value: &'static [&'static [&'static str]],
    /// Whether `-<digits>` is a count, as in `head -5` or `git log -3`.
    pub(super) takes_count: bool,
}

/// A listed program and its closed set of options.
pub(super) struct ReadingProgram {
    /// The program's name.
    pub(super) name: &'static str,
    /// How its option words are read.
    pub(super) options: ProgramOptions,
    /// Whether no option of the program, listed or not, writes or runs anything, so a word only
    /// the line's run decides, which can turn into any option, stays harmless.
    pub(super) takes_undecided_words: bool,
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

/// The programs a reading line may run, each with its closed set of options.
pub(super) const READING_PROGRAMS: &[ReadingProgram] = &[
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

/// Git's own options a reading `git` may take before its subcommand: none takes a value, so none
/// sets configuration, moves git to another folder or changes the programs it runs.
pub(super) const GIT_GLOBAL_OPTIONS: &[&str] = &["--no-pager", "-P", "--no-optional-locks"];

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

/// Git's reading subcommands, each with its own closed set of options.
pub(super) const GIT_READING_SUBCOMMANDS: &[(&str, GetoptOptions)] = &[
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
