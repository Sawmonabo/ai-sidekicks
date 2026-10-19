//! The one runner for git: the absolute `git` found along the person's search path, argv only and
//! no shell, the login shell's environment cleared of the variables that redirect which repository
//! git reads, a bound on its output and on its time, and an end that reaches every process it
//! started. A read runs no hook and no file-watch helper program; a write keeps the repository's
//! hooks. A long call whose standard error its caller reads as it goes is started instead of run.

use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::place::{DistroName, Place};
use sidekicks_platforms::{
    ChildTree, ChildTreeOutputError, NULL_DEVICE_PATH, PathRules, Spawner, find_executables,
    path_from_program_output, start_child_tree,
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

/// One git call: its whole argument list, `-C <folder>` included, what it adds to git's
/// environment and gives git on its standard input, and any bound on its time below the runner's.
#[derive(Debug)]
pub(crate) struct GitCall {
    hooks: GitHooks,
    file_watch: GitFileWatch,
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
    input: Option<Vec<u8>>,
    timeout: Option<Duration>,
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
            timeout: None,
        }
    }

    /// The call with `name` set to `value` in git's environment, over the login shell's and the
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

    /// The call held to `timeout` where that is shorter than the runner's bound, for a quick answer
    /// a person waits on, which a hung network folder would otherwise hold for the runner's whole
    /// bound; `None` keeps the runner's bound.
    pub(crate) fn with_timeout(mut self, timeout: Option<Duration>) -> Self {
        self.timeout = timeout;
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

// A call ready to start: its whole argument list, settings first, what it adds to git's
// environment and what it writes to git's standard input.
struct PreparedCall {
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
    input: Option<Vec<u8>>,
}

impl PreparedCall {
    // A call of `arguments` alone.
    fn of(arguments: Vec<OsString>) -> Self {
        Self {
            arguments,
            environment: Vec::new(),
            input: None,
        }
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

/// The daemon's git: the program found at start, started from the spawner's thread in the login
/// shell's environment, each call held to the runner's bounds. Cloning it shares the program, the
/// environment and what was read of its build.
#[derive(Clone)]
pub(crate) struct GitRunner {
    spawner: Spawner,
    executable: Option<Arc<Path>>,
    // The login shell's environment captured at the daemon's start, never the daemon's own, which
    // a program the system starts holds without the person's search path.
    login_environment: Arc<[(String, String)]>,
    limits: GitLimits,
    // Whether the program was built with its file-watch daemon, read once it is first needed.
    has_built_in_file_watch: Arc<OnceCell<bool>>,
}

impl GitRunner {
    /// The runner for the git at `executable`, an absolute path, or for none found, when every
    /// call fails with [`GitError::NotFound`] where git is first needed rather than at start; each
    /// call's environment starts from `login_environment`, the login shell's captured at start.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start makes its git runner through it"
        )
    )]
    pub(crate) fn new(
        spawner: Spawner,
        executable: Option<PathBuf>,
        login_environment: Arc<[(String, String)]>,
        limits: GitLimits,
    ) -> Self {
        Self {
            spawner,
            executable: executable.map(Arc::from),
            login_environment,
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
        let executable = self.executable_for(place)?;
        let timeout = call.timeout.map_or(self.limits.timeout, |timeout| {
            timeout.min(self.limits.timeout)
        });
        let prepared = self.prepare(executable, call).await?;
        self.run_git(executable, prepared, timeout).await
    }

    /// Starts `call` for a project at `place` and hands back its tree, its standard error piped
    /// for the caller to read as git writes it, its standard input and output the null device and
    /// no bound on its time: the caller ends it, and dropping the tree before git exits ends it.
    /// A call's input is not written. Fails as [`run`](Self::run) does before git starts.
    #[expect(dead_code, reason = "the clone service's git and the background fetch")]
    pub(crate) async fn start(
        &self,
        place: Option<&Place>,
        call: GitCall,
    ) -> Result<ChildTree, GitError> {
        let executable = self.executable_for(place)?;
        let prepared = self.prepare(executable, call).await?;
        self.start_git(
            executable,
            prepared.arguments,
            prepared.environment,
            false,
            Stdio::null(),
        )
        .await
    }

    // The git program for a project at `place`; fails with `WslPlace` for a project in a WSL 2
    // distribution and `NotFound` when no git was found.
    fn executable_for(&self, place: Option<&Place>) -> Result<&Path, GitError> {
        if let Some(Place::Wsl(wsl)) = place {
            return Err(GitError::WslPlace {
                distro: wsl.distro.clone(),
            });
        }
        self.executable.as_deref().ok_or(GitError::NotFound)
    }

    // `call`'s whole argument list with its settings first, its environment and its input.
    async fn prepare(&self, executable: &Path, call: GitCall) -> Result<PreparedCall, GitError> {
        let GitCall {
            hooks,
            file_watch,
            arguments,
            environment,
            input,
            timeout: _,
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
        Ok(PreparedCall {
            arguments: settings,
            environment,
            input,
        })
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
        let is_built_in_on = match self
            .run_git(executable, PreparedCall::of(arguments), self.limits.timeout)
            .await
        {
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
                    .run_git(executable, PreparedCall::of(arguments), self.limits.timeout)
                    .await?;
                Ok(output
                    .stdout
                    .split(|byte| *byte == b'\n')
                    .any(|line| line.trim_ascii() == BUILT_IN_FILE_WATCH_BUILD_LINE))
            })
            .await
            .copied()
    }

    // Starts the git at `executable` with `arguments` and holds it to `timeout` and the runner's
    // output bound.
    async fn run_git(
        &self,
        executable: &Path,
        call: PreparedCall,
        timeout: Duration,
    ) -> Result<GitOutput, GitError> {
        let PreparedCall {
            arguments,
            environment,
            input,
        } = call;
        let mut child = self
            .start_git(
                executable,
                arguments,
                environment,
                input.is_some(),
                Stdio::piped(),
            )
            .await?;
        let waited = tokio::time::timeout(
            timeout,
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
            Err(_elapsed) => GitError::TimedOut { timeout },
        };
        if let Err(error) = child.end_tree().await {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the processes of a git call that failed could not be ended"
            );
        }
        Err(failure)
    }

    // Starts the git at `executable` with `arguments` in the login shell's environment from the
    // spawner's thread, leading a tree of its own, its standard error piped, its standard input
    // piped when `is_input_written` and its standard output as `stdout` sets it.
    async fn start_git(
        &self,
        executable: &Path,
        arguments: Vec<OsString>,
        environment: Vec<(OsString, OsString)>,
        is_input_written: bool,
        stdout: Stdio,
    ) -> Result<ChildTree, GitError> {
        let login_environment = self
            .login_environment
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)));
        let mut command = Command::new(executable);
        command
            .args(arguments)
            .env_clear()
            .envs(git_environment(login_environment, environment))
            .stdin(if is_input_written {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(stdout)
            .stderr(Stdio::piped());
        let daemon_pid = std::process::id();
        self.spawner
            .run(move || start_child_tree(command, daemon_pid))
            .await
            .map_err(GitError::Start)?
            .map_err(GitError::Start)
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
/// shares with every worktree of its repository, held to `timeout` (the runner's bound when
/// `None`). Fails as [`GitRunner::run`] does, with exit 128 when `folder` is in no repository, and
/// with `PathText` for a path this system cannot name.
pub(crate) async fn read_git_common_folder(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    timeout: Option<Duration>,
) -> Result<PathBuf, GitError> {
    let output = git
        .run(
            place,
            GitCall::read(background_read(
                folder,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            ))
            .with_timeout(timeout),
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
        environment.into(),
        GitLimits::DAEMON,
    )
}

/// `line` without the one line end git prints after a single answer: the `\n`, and the `\r`
/// before it only where the running system ends lines with `\r\n`, since elsewhere a name may
/// end with a `\r` git prints as it stands.
pub(crate) fn strip_line_end(mut line: Vec<u8>) -> Vec<u8> {
    if line.last() == Some(&b'\n') {
        line.pop();
        if PathRules::NATIVE.has_carriage_return_line_ends() && line.last() == Some(&b'\r') {
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
mod tests;
