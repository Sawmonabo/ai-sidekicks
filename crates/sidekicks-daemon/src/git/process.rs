//! The one runner for git: the absolute `git` found along the person's search path, argv only and
//! no shell, an environment cleared of the variables that redirect which repository git reads, a
//! bound on its output and on its time, and an end that reaches every process it started. A read
//! runs no hook and no file-watch helper program; a write keeps the repository's hooks.

use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::place::{DistroName, Place};
use sidekicks_platforms::{
    ChildTreeOutputError, NULL_DEVICE_PATH, Spawner, find_executables, path_from_program_output,
    start_child_tree,
};
use tokio::process::Command;
use tokio::sync::OnceCell;

/// The most one stream of a git call may print, sized for the largest: a `-z` listing of a whole
/// worktree's paths. Passing it fails the call; nothing is cut.
pub(crate) const GIT_OUTPUT_MAX_BYTES: usize = 64 * 1024 * 1024;

/// How long one git call may run: `worktree add` writes a whole checkout and a snapshot's staging
/// walks the whole worktree, so a shorter bound would end healthy work on a large repository.
pub(crate) const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

/// The variables git reads as this repository's own (`git rev-parse --local-env-vars`), and three
/// more that move where it looks for one; an inherited one would point a call at another
/// repository, index, object store or history. The person's own config files stay theirs.
const STRIPPED_GIT_ENVIRONMENT_NAMES: [&str; 18] = [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_NAMESPACE",
];

/// Set on every call after the strip: git's messages in English, which callers read refusals
/// from, and no prompt, which would wait on a terminal the daemon lacks until the timeout.
const PINNED_GIT_ENVIRONMENT: [(&str, &str); 3] =
    [("LC_ALL", "C"), ("LANG", "C"), ("GIT_TERMINAL_PROMPT", "0")];

/// The setting that turns git's file watch off for one call, so neither its built-in daemon nor a
/// helper program the repository names starts for it.
const FILE_WATCH_OFF_SETTING: &str = "core.fsmonitor=false";

/// The setting that keeps git's built-in file-watch daemon for one call, never a helper program.
const BUILT_IN_FILE_WATCH_SETTING: &str = "core.fsmonitor=true";

/// The line `git version --build-options` prints for a git built with its file-watch daemon.
const BUILT_IN_FILE_WATCH_BUILD_LINE: &[u8] = b"feature: fsmonitor--daemon";

/// The exit code of `git config --get` for a setting that is not set.
const CONFIG_UNSET_EXIT_CODE: i32 = 1;

/// Why a git call did not answer.
#[derive(Debug, thiserror::Error)]
pub(crate) enum GitError {
    /// The project is in a WSL 2 distribution, where the daemon runs no git.
    #[error(
        "the project is in the WSL 2 distribution {}, where the daemon runs no git",
        distro.as_str()
    )]
    WslPlace {
        /// The distribution.
        distro: DistroName,
    },
    /// No git was found along the person's search path.
    #[error("no git was found along the person's search path")]
    NotFound,
    /// git could not be started.
    #[error("git could not be started")]
    Start(#[source] io::Error),
    /// git ran past its time and its whole tree was ended.
    #[error("git did not finish within {timeout:?}")]
    TimedOut {
        /// The bound it passed.
        timeout: Duration,
    },
    /// One of git's output streams passed its bound and its whole tree was ended.
    #[error("git printed more than {bound} bytes")]
    OutputTooLarge {
        /// The bound, in bytes.
        bound: usize,
    },
    /// git's input, output or exit could not be read.
    #[error("git's input, output or exit could not be read")]
    Read(#[source] io::Error),
    /// git exited with a failure.
    #[error(
        "git exited with {}",
        code.map_or_else(|| "no code".to_owned(), |code| code.to_string())
    )]
    Exited {
        /// Its exit code; `None` when a signal ended it.
        code: Option<i32>,
        /// What it printed on its standard output.
        stdout: Vec<u8>,
        /// What it printed on its standard error, read as UTF-8 with any other byte replaced.
        stderr: String,
    },
    /// git printed a path this system cannot name.
    #[error("git printed a path this system cannot name")]
    PathText(#[source] io::Error),
}

impl GitError {
    /// The exit code of a git that ran to a failed exit; `None` for every other failure.
    pub(crate) fn exit_code(&self) -> Option<i32> {
        match self {
            Self::Exited { code, .. } => *code,
            Self::WslPlace { .. }
            | Self::NotFound
            | Self::Start(_)
            | Self::TimedOut { .. }
            | Self::OutputTooLarge { .. }
            | Self::Read(_)
            | Self::PathText(_) => None,
        }
    }
}

/// What a git call that exited 0 printed on its standard output.
#[derive(Debug)]
pub(crate) struct GitOutput {
    /// Its standard output, bytes as printed, since a `-z` listing's paths are bytes.
    pub(crate) stdout: Vec<u8>,
}

/// Whether a call runs the repository's hooks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GitHooks {
    /// No hook runs: `core.hooksPath` names the system's null device. A read runs so, and may
    /// still write a scratch index, loose objects no ref names, worktree records, the ref locks
    /// of a transaction it prepares and aborts, or a worktree's index.
    Off,
    /// The repository's hooks run as they do for the person: a write of a commit or a ref.
    Repository,
}

/// What a call does with the repository's file watch (`core.fsmonitor`).
#[derive(Debug)]
enum GitFileWatch {
    /// Off for the call, so no file-watch daemon or helper program starts.
    Off,
    /// git's built-in file-watch daemon kept where the repository in `folder` turns it on and the
    /// git program has it, since a read of the live index walks the whole tree without it, and
    /// off otherwise, a helper program the repository names included.
    BuiltInKept {
        /// The folder the call runs in.
        folder: PathBuf,
    },
    /// As the repository sets it.
    Repository,
}

/// One git call: its whole argument list, `-C <folder>` included, and what it adds to git's
/// environment and gives git on its standard input.
#[derive(Debug)]
pub(crate) struct GitCall {
    hooks: GitHooks,
    file_watch: GitFileWatch,
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
    input: Option<Vec<u8>>,
}

impl GitCall {
    /// A read, run with `arguments`: no hook runs and the file watch is off, though the call may
    /// still write a scratch index, worktree records or ref locks. A read in the background builds
    /// its arguments with [`background_read`], so it never takes the person's index lock.
    pub(crate) fn read(arguments: impl IntoIterator<Item = impl Into<OsString>>) -> Self {
        Self::new(GitHooks::Off, GitFileWatch::Off, arguments)
    }

    /// A call that writes a commit or a ref, run with `arguments`, the repository's hooks and file
    /// watch as it sets them.
    pub(crate) fn write(arguments: impl IntoIterator<Item = impl Into<OsString>>) -> Self {
        Self::new(GitHooks::Repository, GitFileWatch::Repository, arguments)
    }

    fn new(
        hooks: GitHooks,
        file_watch: GitFileWatch,
        arguments: impl IntoIterator<Item = impl Into<OsString>>,
    ) -> Self {
        Self {
            hooks,
            file_watch,
            arguments: arguments.into_iter().map(Into::into).collect(),
            environment: Vec::new(),
            input: None,
        }
    }

    /// The call with `name` set to `value` in git's environment, over the daemon's own and the
    /// pinned locale, as a scratch index reaches only the calls that stage into it.
    pub(crate) fn with_environment(
        mut self,
        name: impl Into<OsString>,
        value: impl Into<OsString>,
    ) -> Self {
        self.environment.push((name.into(), value.into()));
        self
    }

    /// The call with `input` written to git's standard input, which is closed after it; a call
    /// given none has no standard input, so `commit-tree -F -` reads an empty message.
    pub(crate) fn with_input(mut self, input: Vec<u8>) -> Self {
        self.input = Some(input);
        self
    }

    /// A read of the live index in `folder`, run with `arguments` there and no optional lock: no
    /// hook runs, and git's built-in file-watch daemon is kept where the repository turns it on
    /// and the git program has it, since the read walks the whole tree without it; any other file
    /// watch, a helper program the repository names included, is off. It costs one more git call
    /// for the repository's setting each time, and one for the program's build once a runner.
    pub(crate) fn live_index_read(folder: &Path, arguments: &[&str]) -> Self {
        Self::new(
            GitHooks::Off,
            GitFileWatch::BuiltInKept {
                folder: folder.to_path_buf(),
            },
            background_read(folder, arguments),
        )
    }
}

/// The bounds every call of one runner keeps.
#[derive(Clone, Copy, Debug)]
pub(crate) struct GitLimits {
    /// How long a call may run before its whole tree is ended.
    pub(crate) timeout: Duration,
    /// How many bytes one output stream may hold.
    pub(crate) output_bytes: usize,
}

impl GitLimits {
    /// The daemon's bounds: [`GIT_COMMAND_TIMEOUT`] and [`GIT_OUTPUT_MAX_BYTES`].
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start makes its git runner with these bounds"
        )
    )]
    pub(crate) const DAEMON: Self = Self {
        timeout: GIT_COMMAND_TIMEOUT,
        output_bytes: GIT_OUTPUT_MAX_BYTES,
    };
}

/// The daemon's git: the program found at start, started from the spawner's thread, each call
/// held to the runner's bounds. Cloning it shares the program and what was read of its build.
#[derive(Clone)]
pub(crate) struct GitRunner {
    spawner: Spawner,
    executable: Option<Arc<Path>>,
    limits: GitLimits,
    // Whether the program was built with its file-watch daemon, read once it is first needed.
    has_built_in_file_watch: Arc<OnceCell<bool>>,
}

impl GitRunner {
    /// The runner for the git at `executable`, an absolute path, or for none found, when every
    /// call fails with [`GitError::NotFound`] where git is first needed rather than at start.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start makes its git runner through it"
        )
    )]
    pub(crate) fn new(spawner: Spawner, executable: Option<PathBuf>, limits: GitLimits) -> Self {
        Self {
            spawner,
            executable: executable.map(Arc::from),
            limits,
            has_built_in_file_watch: Arc::new(OnceCell::new()),
        }
    }

    /// Runs `call` for a project at `place`: `None` on macOS and Linux, Windows itself there. git
    /// starts leading a tree of its own and its whole tree is ended when the call passes its time
    /// or an output stream passes its bound; the output read ends at git's own exit. Fails with
    /// `WslPlace` for a project in a WSL 2 distribution, `NotFound` when no git was found, `Start`
    /// when it cannot start, `TimedOut`, `OutputTooLarge`, `Read`, and `Exited` with what git
    /// printed when it exits with a failure; a live index read fails so too when the read of the
    /// repository's setting or of the program's build does.
    pub(crate) async fn run(
        &self,
        place: Option<&Place>,
        call: GitCall,
    ) -> Result<GitOutput, GitError> {
        if let Some(Place::Wsl(wsl)) = place {
            return Err(GitError::WslPlace {
                distro: wsl.distro.clone(),
            });
        }
        let executable = self.executable.as_deref().ok_or(GitError::NotFound)?;
        let GitCall {
            hooks,
            file_watch,
            arguments,
            environment,
            input,
        } = call;
        let file_watch_setting = match file_watch {
            GitFileWatch::Off => Some(FILE_WATCH_OFF_SETTING),
            GitFileWatch::Repository => None,
            GitFileWatch::BuiltInKept { folder } => {
                Some(self.live_index_file_watch(executable, &folder).await?)
            }
        };
        let mut settings = call_settings(hooks, file_watch_setting);
        settings.extend(arguments);
        self.run_git(executable, settings, environment, input).await
    }

    // The file-watch setting a live index read of the repository in `folder` runs with: the
    // built-in daemon when the repository turns it on, read as git reads a boolean, and the
    // program has it, else off. Set either way, so no helper program named after the read runs.
    async fn live_index_file_watch(
        &self,
        executable: &Path,
        folder: &Path,
    ) -> Result<&'static str, GitError> {
        // The file watch is left as set, since a setting on this call is what it would read.
        let mut arguments = call_settings(GitHooks::Off, None);
        arguments.extend(in_folder(
            folder,
            &["config", "--type=bool-or-str", "--get", "core.fsmonitor"],
        ));
        let is_built_in_on = match self.run_git(executable, arguments, Vec::new(), None).await {
            Ok(output) => strip_line_end(output.stdout) == b"true",
            Err(GitError::Exited {
                code: Some(CONFIG_UNSET_EXIT_CODE),
                ..
            }) => false,
            Err(failure) => return Err(failure),
        };
        if is_built_in_on && self.has_built_in_file_watch(executable).await? {
            return Ok(BUILT_IN_FILE_WATCH_SETTING);
        }
        Ok(FILE_WATCH_OFF_SETTING)
    }

    // Whether the git at `executable` was built with its file-watch daemon, read from its build
    // options once for the runner; a failed read is not kept.
    async fn has_built_in_file_watch(&self, executable: &Path) -> Result<bool, GitError> {
        self.has_built_in_file_watch
            .get_or_try_init(|| async {
                let arguments = vec![OsString::from("version"), OsString::from("--build-options")];
                let output = self
                    .run_git(executable, arguments, Vec::new(), None)
                    .await?;
                Ok(output
                    .stdout
                    .split(|byte| *byte == b'\n')
                    .any(|line| line.trim_ascii() == BUILT_IN_FILE_WATCH_BUILD_LINE))
            })
            .await
            .copied()
    }

    // Starts the git at `executable` with `arguments` and holds it to the runner's bounds.
    async fn run_git(
        &self,
        executable: &Path,
        arguments: Vec<OsString>,
        environment: Vec<(OsString, OsString)>,
        input: Option<Vec<u8>>,
    ) -> Result<GitOutput, GitError> {
        let mut command = Command::new(executable);
        command
            .args(arguments)
            .env_clear()
            .envs(git_environment(std::env::vars_os(), environment))
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let daemon_pid = std::process::id();
        let mut child = self
            .spawner
            .run(move || start_child_tree(command, daemon_pid))
            .await
            .map_err(GitError::Start)?
            .map_err(GitError::Start)?;
        let waited = tokio::time::timeout(
            self.limits.timeout,
            child.wait_with_output(input, self.limits.output_bytes),
        )
        .await;
        let failure = match waited {
            Ok(Ok(output)) => {
                if output.status.success() {
                    return Ok(GitOutput {
                        stdout: output.stdout,
                    });
                }
                return Err(GitError::Exited {
                    code: output.status.code(),
                    stdout: output.stdout,
                    stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                });
            }
            Ok(Err(ChildTreeOutputError::TooLarge { bound })) => GitError::OutputTooLarge { bound },
            Ok(Err(ChildTreeOutputError::Io(error))) => GitError::Read(error),
            Err(_elapsed) => GitError::TimedOut {
                timeout: self.limits.timeout,
            },
        };
        if let Err(error) = child.end_tree().await {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the processes of a git call that failed could not be ended"
            );
        }
        Err(failure)
    }
}

/// The first absolute `git` along `environment`'s search path, the person's own (the login
/// shell's on macOS and Linux); a relative entry is passed over, since it would name the daemon's
/// working folder. `None` when there is none. Reads the file system, so it runs on the spawner's
/// thread or in `spawn_blocking`.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start finds git along the person's search path through it"
    )
)]
pub(crate) fn find_git_executable(environment: &[(String, String)]) -> Option<PathBuf> {
    find_executables("git", environment, Path::new(""), &[])
        .find(|candidate| candidate.is_absolute())
}

/// The absolute git folder of the repository `folder` sits in, the common one a linked worktree
/// shares with every worktree of its repository. Fails as [`GitRunner::run`] does, with exit 128
/// when `folder` is in no repository, and with `PathText` for a path this system cannot name.
pub(crate) async fn read_git_common_folder(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
) -> Result<PathBuf, GitError> {
    let output = git
        .run(
            place,
            GitCall::read(in_folder(
                folder,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            )),
        )
        .await?;
    path_from_program_output(strip_line_end(output.stdout)).map_err(GitError::PathText)
}

/// A git call's arguments that run `arguments` in `folder` with no optional lock, so a read in the
/// background never rewrites the person's index.
pub(crate) fn background_read(folder: &Path, arguments: &[&str]) -> Vec<OsString> {
    let mut call = vec![OsString::from("--no-optional-locks")];
    call.extend(in_folder(folder, arguments));
    call
}

/// A git call's arguments that run `arguments` in `folder`: `-C <folder>` and then them.
pub(crate) fn in_folder(folder: &Path, arguments: &[&str]) -> Vec<OsString> {
    [OsStr::new("-C"), folder.as_os_str()]
        .into_iter()
        .chain(arguments.iter().map(OsStr::new))
        .map(OsStr::to_owned)
        .collect()
}

/// The person's git, found as the daemon's start finds it, with the daemon's bounds, for tests
/// that run git in a temporary repository.
#[cfg(test)]
pub(crate) fn test_git_runner() -> GitRunner {
    let environment: Vec<(String, String)> = std::env::vars().collect();
    let executable = find_git_executable(&environment).expect("the tests run where git is");
    GitRunner::new(
        sidekicks_platforms::Spawner::new(tokio::runtime::Handle::current())
            .expect("the spawner thread starts"),
        Some(executable),
        GitLimits::DAEMON,
    )
}

/// `line` without the one line end git prints after a single answer.
pub(crate) fn strip_line_end(mut line: Vec<u8>) -> Vec<u8> {
    if line.last() == Some(&b'\n') {
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
    }
    line
}

// The `-c` settings put before a call's own arguments: hooks from the null device when `hooks` is
// off, and `file_watch_setting` when there is one.
fn call_settings(hooks: GitHooks, file_watch_setting: Option<&str>) -> Vec<OsString> {
    let mut settings = Vec::new();
    if hooks == GitHooks::Off {
        settings.push(OsString::from("-c"));
        settings.push(OsString::from(format!("core.hooksPath={NULL_DEVICE_PATH}")));
    }
    if let Some(file_watch_setting) = file_watch_setting {
        settings.push(OsString::from("-c"));
        settings.push(OsString::from(file_watch_setting));
    }
    settings
}

// `variables` without the stripped names, compared case-blind since Windows keeps an inherited
// name's own spelling (`Git_Dir`), then the pinned locale and prompt, then `overrides`; a later
// pair of the same name replaces an earlier one when the command applies them.
fn git_environment(
    variables: impl IntoIterator<Item = (OsString, OsString)>,
    overrides: Vec<(OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    variables
        .into_iter()
        .filter(|(name, _)| {
            !STRIPPED_GIT_ENVIRONMENT_NAMES
                .iter()
                .any(|stripped| name.eq_ignore_ascii_case(stripped))
        })
        .chain(
            PINNED_GIT_ENVIRONMENT
                .iter()
                .map(|(name, value)| (OsString::from(name), OsString::from(value))),
        )
        .chain(overrides)
        .collect()
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use super::{
        GitCall, GitError, GitLimits, GitRunner, git_environment, in_folder, strip_line_end,
        test_git_runner,
    };
    use crate::file::atomic_write::write_file_atomically;

    // The person's git with `limits`.
    fn test_runner(limits: GitLimits) -> GitRunner {
        GitRunner {
            limits,
            ..test_git_runner()
        }
    }

    // A new repository in a temporary folder, with one commit of the empty tree: the temporary
    // folder, the repository's folder, the empty tree's id and the commit's.
    async fn repository_with_a_commit(
        git: &GitRunner,
    ) -> (tempfile::TempDir, PathBuf, String, String) {
        let root = tempfile::tempdir().expect("the temporary folder is made");
        let repository = root.path().join("repository");
        git.run(
            None,
            GitCall::write([OsString::from("init"), repository.clone().into()]),
        )
        .await
        .expect("the repository is made");
        let tree = git
            .run(None, GitCall::read(in_folder(&repository, &["write-tree"])))
            .await
            .expect("the empty tree is written");
        let tree = String::from_utf8(strip_line_end(tree.stdout)).expect("an id is ASCII");
        let commit = git
            .run(
                None,
                committing(&repository, &tree).with_input(b"first\n".to_vec()),
            )
            .await
            .expect("the commit is written");
        let commit = String::from_utf8(strip_line_end(commit.stdout)).expect("an id is ASCII");
        (root, repository, tree, commit)
    }

    // `commit-tree` of `tree` with a fixed identity and no signing, whatever the person's config.
    fn committing(repository: &Path, tree: &str) -> GitCall {
        let mut arguments = vec![OsString::from("-c"), "commit.gpgSign=false".into()];
        arguments.extend(in_folder(repository, &["commit-tree", tree, "-F", "-"]));
        GitCall::write(arguments)
            .with_environment("GIT_AUTHOR_NAME", "Test")
            .with_environment("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .with_environment("GIT_COMMITTER_NAME", "Test")
            .with_environment("GIT_COMMITTER_EMAIL", "test@example.invalid")
    }

    // An `update-ref` of a new branch through a `reference-transaction` hook whose body is
    // `hook`, from a hooks folder the call names over the person's config.
    async fn update_ref_through_hook(
        git: &GitRunner,
        root: &Path,
        repository: &Path,
        commit: &str,
        hook: &str,
    ) -> Result<(), GitError> {
        let hooks = root.join("hooks");
        tokio::fs::create_dir_all(&hooks)
            .await
            .expect("the hooks folder is made");
        write_file_atomically(
            &hooks.join("reference-transaction"),
            format!("#!/bin/sh\n{hook}\n"),
            0o755,
        )
        .await
        .expect("the hook is written");
        let mut arguments = vec![
            OsString::from("-c"),
            OsString::from(format!("core.hooksPath={}", hooks.display())),
        ];
        arguments.extend(in_folder(
            repository,
            &["update-ref", "refs/heads/hooked", commit],
        ));
        git.run(None, GitCall::write(arguments)).await.map(drop)
    }

    // Fails when a redirecting variable spelled in another case survives, when the locale is not
    // pinned, or when the pinned value overrides the call's own.
    #[test]
    fn git_environment_strips_redirects_and_lets_the_call_set_last() {
        let variables = [
            ("Git_Dir", "/elsewhere/.git"),
            ("GIT_SHALLOW_FILE", "/elsewhere/shallow"),
            ("GIT_INDEX_FILE", "/elsewhere/index"),
            ("LANG", "fr_FR.UTF-8"),
            ("HOME", "/home/person"),
        ]
        .map(|(name, value)| (OsString::from(name), OsString::from(value)));
        let overrides = vec![(
            OsString::from("GIT_INDEX_FILE"),
            OsString::from("/scratch/index"),
        )];

        let mut command = tokio::process::Command::new("git");
        command
            .env_clear()
            .envs(git_environment(variables, overrides));
        let environment: Vec<(String, Option<String>)> = command
            .as_std()
            .get_envs()
            .map(|(name, value)| {
                let text = |text: &std::ffi::OsStr| text.to_string_lossy().into_owned();
                (text(name), value.map(text))
            })
            .collect();

        let value_of = |wanted: &str| {
            environment
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(wanted))
                .and_then(|(_, value)| value.clone())
        };
        assert_eq!(value_of("GIT_DIR"), None);
        assert_eq!(value_of("GIT_SHALLOW_FILE"), None);
        assert_eq!(
            value_of("GIT_INDEX_FILE").as_deref(),
            Some("/scratch/index")
        );
        assert_eq!(value_of("LANG").as_deref(), Some("C"));
        assert_eq!(value_of("LC_ALL").as_deref(), Some("C"));
        assert_eq!(value_of("GIT_TERMINAL_PROMPT").as_deref(), Some("0"));
        assert_eq!(value_of("HOME").as_deref(), Some("/home/person"));
    }

    // Fails when a call given no input leaves git's standard input open, where `-F -` waits until
    // the timeout.
    #[tokio::test]
    async fn commit_tree_given_no_input_returns() {
        let git = test_runner(GitLimits {
            timeout: Duration::from_secs(30),
            output_bytes: 1024,
        });
        let (_root, repository, tree, _commit) = repository_with_a_commit(&git).await;

        let commit = git.run(None, committing(&repository, &tree)).await;

        assert!(commit.expect("the commit is written").stdout.len() > tree.len());
    }

    // Fails when output past the bound is cut and returned rather than failing the call.
    #[tokio::test]
    async fn output_past_the_bound_fails_the_call() {
        let git = test_runner(GitLimits {
            timeout: Duration::from_secs(30),
            output_bytes: 4,
        });

        let version = git.run(None, GitCall::read(["version"])).await;

        assert!(matches!(
            version,
            Err(GitError::OutputTooLarge { bound: 4 })
        ));
    }

    // Fails when a read runs a hook or the file-watch helper program the repository's own config
    // names, a live index read among them, or when a write does not run the repository's hooks.
    #[tokio::test]
    async fn a_read_runs_no_hook_or_file_watch_helper_and_a_write_runs_the_hooks() {
        let git = test_git_runner();
        let (root, repository, _tree, commit) = repository_with_a_commit(&git).await;
        let ran = |name: &str| root.path().join(name);
        tokio::fs::write(repository.join("tracked.txt"), "tracked\n")
            .await
            .expect("the file is written");
        git.run(
            None,
            GitCall::write(in_folder(&repository, &["add", "tracked.txt"])),
        )
        .await
        .expect("the file is staged");
        let hooks = root.path().join("hooks");
        let helper = root.path().join("file-watch-helper");
        tokio::fs::create_dir_all(&hooks)
            .await
            .expect("the hooks folder is made");
        // The helper fails, so git reads the tree itself.
        for (script, marker, end) in [
            (hooks.join("post-index-change"), "index-hook-ran", ""),
            (hooks.join("reference-transaction"), "ref-hook-ran", ""),
            (helper.clone(), "helper-ran", "exit 1"),
        ] {
            let body = format!("#!/bin/sh\ntouch '{}'\n{end}\n", ran(marker).display());
            write_file_atomically(&script, body, 0o755)
                .await
                .expect("the script is written");
        }
        for (name, value) in [("core.hooksPath", &hooks), ("core.fsmonitor", &helper)] {
            let mut arguments = in_folder(&repository, &["config", name]);
            arguments.push(value.into());
            git.run(None, GitCall::write(arguments))
                .await
                .expect("the repository's config is written");
        }

        for read in [
            GitCall::read(in_folder(&repository, &["status", "--porcelain"])),
            GitCall::live_index_read(&repository, &["status", "--porcelain"]),
            GitCall::read(in_folder(&repository, &["read-tree", &commit])),
        ] {
            git.run(None, read).await.expect("the read runs");
        }
        let ran_after_reads = [ran("index-hook-ran").exists(), ran("helper-ran").exists()];
        git.run(
            None,
            GitCall::write(in_folder(
                &repository,
                &["update-ref", "refs/heads/hooked", &commit],
            )),
        )
        .await
        .expect("the ref is written");

        assert_eq!(ran_after_reads, [false, false]);
        assert!(
            ran("ref-hook-ran").exists(),
            "the write ran the repository's hook"
        );
    }

    // Fails when the timeout ends git alone, which leaves its sleeping hook to finish its work.
    #[tokio::test]
    async fn a_timeout_ends_the_hook_git_started() {
        let git = test_runner(GitLimits {
            timeout: Duration::from_secs(30),
            output_bytes: 1024,
        });
        let (root, repository, _tree, commit) = repository_with_a_commit(&git).await;
        let started = root.path().join("started");
        let finished = root.path().join("finished");
        let impatient = GitRunner {
            limits: GitLimits {
                timeout: Duration::from_millis(1_500),
                output_bytes: 1024,
            },
            ..git
        };

        let update = update_ref_through_hook(
            &impatient,
            root.path(),
            &repository,
            &commit,
            &format!(
                "touch '{}'\nsleep 3\ntouch '{}'",
                started.display(),
                finished.display()
            ),
        )
        .await;
        tokio::time::sleep(Duration::from_secs(4)).await;

        assert!(matches!(update, Err(GitError::TimedOut { .. })));
        assert!(started.exists(), "the hook ran");
        assert!(!finished.exists(), "the hook outlived the timeout");
    }

    // Fails when the output read waits for the end of git's output, which a process a hook left
    // behind holds open long after git's exit.
    #[tokio::test]
    async fn the_call_returns_at_git_exit_while_a_hook_child_holds_its_output() {
        let git = test_runner(GitLimits {
            timeout: Duration::from_secs(60),
            output_bytes: 1024,
        });
        let (root, repository, _tree, commit) = repository_with_a_commit(&git).await;
        let sleeper_pid_file = root.path().join("sleeper.pid");
        let started_at = Instant::now();

        let update = update_ref_through_hook(
            &git,
            root.path(),
            &repository,
            &commit,
            &format!("sleep 30 &\necho $! > '{}'", sleeper_pid_file.display()),
        )
        .await;
        let elapsed = started_at.elapsed();
        // The sleeper is the test's own child's child, ended here so it outlives nothing.
        let sleeper_pid =
            std::fs::read_to_string(&sleeper_pid_file).expect("the hook wrote its pid");
        let ended = std::process::Command::new("kill")
            .arg(sleeper_pid.trim())
            .status()
            .expect("kill runs");

        update.expect("the update succeeds");
        assert!(elapsed < Duration::from_secs(10));
        assert!(ended.success(), "the sleeper was still running");
    }
}
