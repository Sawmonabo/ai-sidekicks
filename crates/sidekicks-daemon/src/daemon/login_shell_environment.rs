//! The environment every provider's process starts from, captured once per start. Where the system
//! has a login shell, it runs once, as a login and interactive shell in a session of its own, and
//! prints `env -0` between two marker lines, so proxy, certificate and locale settings and a
//! provider installed later are present with no terminal open. A shell that fails, stalls past five
//! seconds, prints past what an environment can hold or prints no markers is ended with its whole
//! group, and the start goes on with the account's default environment: the start never waits on
//! a shell. Where the system has none, the daemon's own environment is the base.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use sidekicks_platforms::{
    BaseEnvironmentSource, Spawner, base_environment_source, name_as_login_shell,
    windows_drive_mounts, wrap_session_child_command,
};
use tokio::io::{AsyncRead, AsyncReadExt as _};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::random_hex::random_hex;

/// How long the login shell may take before the start goes on without it.
pub(crate) const LOGIN_SHELL_DEADLINE: Duration = Duration::from_secs(5);

// A system refuses to start a program with an environment past its argument limit (1 MiB on
// macOS, 2 MiB on Linux), so more output than this holds no usable environment.
const MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;

// The search path a login gets before any profile runs: `_PATH_DEFPATH`, the same on macOS and in
// glibc.
const DEFAULT_LOGIN_PATH: &str = "/usr/bin:/bin";

// Tells the startup files that the daemon is only reading their environment, so one that starts
// a terminal program or prompts can skip it.
const RESOLVING_ENVIRONMENT: &str = "SIDEKICKS_RESOLVING_ENVIRONMENT";

// The names the capture leaves out: the shell's own nesting depth, and the variable above.
const LEFT_OUT_NAMES: [&str; 2] = ["SHLVL", RESOLVING_ENVIRONMENT];

// The external programs the shell runs, the same for every shell, so no alias, function or
// builtin a startup file defines changes what is printed; only how a shell runs a path differs.
const ECHO_PROGRAM: &str = "/bin/echo";
const ENVIRONMENT_PROGRAM: &str = "/usr/bin/env";

// The random bytes in each marker, fresh at every start, so no startup file prints one by chance.
const MARKER_RANDOM_BYTES: usize = 16;

/// Captures the base environment of every provider's process as name-value pairs, unless `stop`
/// is canceled first. Never fails for a shell that fails, stalls, prints no markers or is
/// abandoned: it says why in the service log and answers the account's default environment,
/// `HOME` from `home_folder`, `SHELL` where the account names one, `USER` and `LOGNAME`, `PATH` as
/// `/usr/bin:/bin`, and `TMPDIR` where the system keeps one per account. Fails with the system's
/// error only when the account cannot be read.
#[expect(
    dead_code,
    reason = "the daemon's start captures it once, before any provider starts"
)]
pub(crate) async fn capture_provider_base_environment(
    spawner: &Spawner,
    home_folder: &Path,
    stop: &CancellationToken,
) -> std::io::Result<Vec<(String, String)>> {
    let (account_name, shell, temporary_folder) = match base_environment_source()? {
        BaseEnvironmentSource::ServiceEnvironment => {
            return Ok(std::env::vars_os()
                .map(|(name, value)| {
                    (
                        name.to_string_lossy().into_owned(),
                        value.to_string_lossy().into_owned(),
                    )
                })
                .collect());
        }
        BaseEnvironmentSource::LoginShell {
            account_name,
            shell,
            temporary_folder,
        } => (account_name, shell, temporary_folder),
    };
    let account = DefaultEnvironment {
        home_folder: home_folder.to_string_lossy().into_owned(),
        shell: shell
            .as_deref()
            .map(|shell| shell.to_string_lossy().into_owned()),
        account_name,
        temporary_folder,
    };
    let Some(shell) = shell else {
        tracing::warn!(
            "The account names no login shell, so providers start with the account's default \
             environment."
        );
        return Ok(account.pairs());
    };
    Ok(capture_login_shell_environment(spawner, &shell, LOGIN_SHELL_DEADLINE, stop, account).await)
}

// Runs the capture with `shell` and answers what it printed, the search path without the Windows
// drives inside WSL, or `account`'s default environment with the reason in the service log.
async fn capture_login_shell_environment(
    spawner: &Spawner,
    shell: &Path,
    deadline: Duration,
    stop: &CancellationToken,
    account: DefaultEnvironment,
) -> Vec<(String, String)> {
    let reason = match run_login_shell(spawner, shell, deadline, stop).await {
        CaptureOutcome::Captured(pairs) => return leave_out_windows_drives(pairs),
        CaptureOutcome::Failed(reason) => reason,
    };
    tracing::warn!(
        shell = %shell.display(),
        "The login shell {reason}, so providers start with the account's default environment."
    );
    account.pairs()
}

/// What one run of the login shell gave.
#[derive(Debug, PartialEq, Eq)]
enum CaptureOutcome {
    /// The pairs it printed between the markers.
    Captured(Vec<(String, String)>),
    /// Why it gave none, finishing the sentence "The login shell …".
    Failed(String),
}

// The marker lines one capture prints around the environment.
struct CaptureMarkers {
    begin_line: String,
    end_line: String,
}

impl CaptureMarkers {
    fn new(token: &str) -> Self {
        Self {
            begin_line: format!("__sidekicks_environment_{token}_begin__"),
            end_line: format!("__sidekicks_environment_{token}_end__"),
        }
    }
}

async fn run_login_shell(
    spawner: &Spawner,
    shell: &Path,
    deadline: Duration,
    stop: &CancellationToken,
) -> CaptureOutcome {
    if stop.is_cancelled() {
        return CaptureOutcome::Failed("was not run, since the start is stopping".to_owned());
    }
    let markers = match random_hex(MARKER_RANDOM_BYTES) {
        Ok(token) => CaptureMarkers::new(&token),
        Err(error) => {
            return CaptureOutcome::Failed(format!(
                "was not run, since no markers were drawn ({error})"
            ));
        }
    };
    let launch = capture_launch(shell, &markers);
    let mut command = Command::new(shell);
    if launch.is_named_as_login {
        name_as_login_shell(&mut command, shell);
    }
    command
        .args(&launch.arguments)
        .env(RESOLVING_ENVIRONMENT, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let daemon_pid = std::process::id();
    // Its own session, so a failed capture ends whatever the startup files started with it.
    let started = spawner
        .run(move || wrap_session_child_command(command, daemon_pid).spawn())
        .await
        .and_then(|spawned| spawned);
    let mut child = match started {
        Ok(child) => child,
        Err(error) => return CaptureOutcome::Failed(format!("could not be started ({error})")),
    };
    let output = child
        .stdout()
        .take()
        .expect("the login shell's standard output is piped");
    let outcome = tokio::select! {
        () = stop.cancelled() => {
            CaptureOutcome::Failed("was ended, since the start is stopping".to_owned())
        }
        read = tokio::time::timeout(deadline, read_capture(output, &markers)) => {
            read.unwrap_or_else(|_| {
                CaptureOutcome::Failed(format!(
                    "did not finish within {} ms",
                    deadline.as_millis()
                ))
            })
        }
    };
    // A capture that failed ends the shell's whole group, whatever the startup files started with
    // it; a captured one leaves the group alone, so an agent a profile started keeps running, and
    // the handle's drop ends only a shell still printing.
    if let CaptureOutcome::Failed(_) = &outcome
        && matches!(child.try_wait(), Ok(None))
        && let Err(error) = child.start_kill()
    {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "The login shell's group could not be ended."
        );
    }
    outcome
}

// How the login shell is started for one capture: under its login name or not, and its arguments.
struct CaptureLaunch {
    is_named_as_login: bool,
    arguments: Vec<String>,
}

// The arguments each shell takes to run one command as a login and interactive shell, by the
// shell's file name; a shell not named runs as a POSIX shell does.
fn capture_launch(shell: &Path, markers: &CaptureMarkers) -> CaptureLaunch {
    let name = shell
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let command = |call: &str| {
        format!(
            "{call}{ECHO_PROGRAM} {begin}; {call}{ENVIRONMENT_PROGRAM} -0; {call}{ECHO_PROGRAM}; \
             {call}{ECHO_PROGRAM} {end}",
            begin = markers.begin_line,
            end = markers.end_line,
        )
    };
    let (is_named_as_login, arguments) = match name {
        // csh and tcsh take a login only from their name, and `-l` only alone.
        "csh" | "tcsh" => (true, vec!["-i".to_owned(), "-c".to_owned(), command("")]),
        // `-e` runs the text, then stays interactive unless the text exits.
        "nu" => (
            false,
            vec![
                "-l".to_owned(),
                "-e".to_owned(),
                format!("{}; exit", command("^")),
            ],
        ),
        "pwsh" | "powershell" => (
            false,
            vec!["-Login".to_owned(), "-Command".to_owned(), command("& ")],
        ),
        "xonsh" => (
            false,
            vec![
                "-i".to_owned(),
                "-l".to_owned(),
                "-c".to_owned(),
                command(""),
            ],
        ),
        _ => (
            false,
            vec![
                "-l".to_owned(),
                "-i".to_owned(),
                "-c".to_owned(),
                command(""),
            ],
        ),
    };
    CaptureLaunch {
        is_named_as_login,
        arguments,
    }
}

// Reads the shell's output until the end marker, answering the pairs between the markers. Fails
// past the cap, at the output's end without both markers, and on a read error.
async fn read_capture(
    mut output: impl AsyncRead + Unpin,
    markers: &CaptureMarkers,
) -> CaptureOutcome {
    let end = format!("\n{}\n", markers.end_line);
    let mut text = Vec::new();
    let mut chunk = vec![0_u8; 64 * 1024];
    loop {
        let read = match output.read(&mut chunk).await {
            Ok(0) => {
                return CaptureOutcome::Failed(
                    "printed no environment between the markers".to_owned(),
                );
            }
            Ok(read) => read,
            Err(error) => return CaptureOutcome::Failed(format!("could not be read ({error})")),
        };
        // Only the bytes that could start the end marker across a chunk's edge are searched again.
        let searched_from = text.len().saturating_sub(end.len() - 1);
        text.extend_from_slice(&chunk[..read]);
        if find(&text[searched_from..], end.as_bytes()).is_some()
            && let Some(pairs) = read_between_markers(&text, markers)
        {
            return CaptureOutcome::Captured(pairs);
        }
        if text.len() > MAX_CAPTURE_BYTES {
            return CaptureOutcome::Failed("printed more than an environment can hold".to_owned());
        }
    }
}

// The pairs `env -0` printed between the marker lines, or `None` until both have arrived. Entries
// end in NUL, so a value may hold newlines; a name the capture leaves out is dropped.
fn read_between_markers(text: &[u8], markers: &CaptureMarkers) -> Option<Vec<(String, String)>> {
    let begin = format!("{}\n", markers.begin_line);
    let body_start = find(text, begin.as_bytes())? + begin.len();
    let end = format!("\n{}\n", markers.end_line);
    let body_end = body_start + find(&text[body_start..], end.as_bytes())?;
    Some(
        text[body_start..body_end]
            .split(|byte| *byte == 0)
            .filter_map(|entry| {
                let separator = entry.iter().position(|byte| *byte == b'=')?;
                let name = String::from_utf8_lossy(&entry[..separator]).into_owned();
                (separator > 0 && !LEFT_OUT_NAMES.contains(&name.as_str())).then(|| {
                    (
                        name,
                        String::from_utf8_lossy(&entry[separator + 1..]).into_owned(),
                    )
                })
            })
            .collect(),
    )
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// A Windows program reached under a drive mount inside WSL cannot run its Linux dependencies, so
// the search path drops every folder at or under one. A mount table that cannot be read is logged
// and leaves the search path whole.
fn leave_out_windows_drives(mut pairs: Vec<(String, String)>) -> Vec<(String, String)> {
    let mounts = match windows_drive_mounts() {
        Ok(mounts) => mounts,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "The Windows drives' mounts could not be read, so the search path keeps every \
                 folder."
            );
            return pairs;
        }
    };
    if mounts.is_empty() {
        return pairs;
    }
    for (name, value) in &mut pairs {
        if name == "PATH" {
            *value = value
                .split(':')
                .filter(|folder| {
                    !mounts
                        .iter()
                        .any(|mount| Path::new(folder).starts_with(mount))
                })
                .collect::<Vec<_>>()
                .join(":");
        }
    }
    pairs
}

// What a login gives before any profile runs.
struct DefaultEnvironment {
    home_folder: String,
    shell: Option<String>,
    account_name: String,
    temporary_folder: Option<String>,
}

impl DefaultEnvironment {
    fn pairs(self) -> Vec<(String, String)> {
        let mut pairs = vec![("HOME".to_owned(), self.home_folder)];
        if let Some(shell) = self.shell {
            pairs.push(("SHELL".to_owned(), shell));
        }
        pairs.push(("USER".to_owned(), self.account_name.clone()));
        pairs.push(("LOGNAME".to_owned(), self.account_name));
        pairs.push(("PATH".to_owned(), DEFAULT_LOGIN_PATH.to_owned()));
        if let Some(temporary_folder) = self.temporary_folder {
            pairs.push(("TMPDIR".to_owned(), temporary_folder));
        }
        pairs
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::Duration;

    use sidekicks_platforms::Spawner;
    use tokio::io::AsyncReadExt as _;
    use tokio_util::sync::CancellationToken;

    use super::{
        CaptureMarkers, CaptureOutcome, DefaultEnvironment, MAX_CAPTURE_BYTES, capture_launch,
        capture_login_shell_environment, read_capture,
    };

    fn markers() -> CaptureMarkers {
        CaptureMarkers::new("0123")
    }

    #[tokio::test]
    async fn a_value_holding_a_newline_is_read_whole_and_the_shell_s_own_names_are_left_out() {
        let output = b"motd line\n__sidekicks_environment_0123_begin__\nA=one\nline two\0SHLVL=2\0\
            SIDEKICKS_RESOLVING_ENVIRONMENT=1\0=nameless\0B=x=y\0\n\
            __sidekicks_environment_0123_end__\n";
        let outcome = read_capture(&output[..], &markers()).await;
        assert_eq!(
            outcome,
            CaptureOutcome::Captured(vec![
                ("A".to_owned(), "one\nline two".to_owned()),
                ("B".to_owned(), "x=y".to_owned()),
            ])
        );
    }

    #[tokio::test]
    async fn output_past_the_cap_is_refused() {
        let output = tokio::io::repeat(b'x').take(u64::try_from(MAX_CAPTURE_BYTES).unwrap() + 2);
        let outcome = read_capture(output, &markers()).await;
        assert_eq!(
            outcome,
            CaptureOutcome::Failed("printed more than an environment can hold".to_owned())
        );
    }

    #[test]
    fn tcsh_runs_under_its_login_name_with_only_external_programs() {
        let launch = capture_launch(Path::new("/bin/tcsh"), &markers());
        assert!(launch.is_named_as_login);
        assert_eq!(
            launch.arguments,
            [
                "-i",
                "-c",
                "/bin/echo __sidekicks_environment_0123_begin__; /usr/bin/env -0; /bin/echo; \
                 /bin/echo __sidekicks_environment_0123_end__"
            ]
        );
    }

    #[test]
    fn a_shell_that_prints_no_markers_leaves_the_account_s_default_environment() {
        // This test program, given a shell's switches, prints nothing on its output and exits.
        let shell = std::env::current_exe().expect("the test program's path is read");
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("the runtime is built");
        let spawner = Spawner::new(runtime.handle().clone()).expect("the spawner starts");
        let account = DefaultEnvironment {
            home_folder: "/home/ada".to_owned(),
            shell: Some("/bin/zsh".to_owned()),
            account_name: "ada".to_owned(),
            temporary_folder: Some("/tmp/ada".to_owned()),
        };
        let pairs = runtime.block_on(capture_login_shell_environment(
            &spawner,
            &shell,
            Duration::from_secs(30),
            &CancellationToken::new(),
            account,
        ));
        let expected = [
            ("HOME", "/home/ada"),
            ("SHELL", "/bin/zsh"),
            ("USER", "ada"),
            ("LOGNAME", "ada"),
            ("PATH", "/usr/bin:/bin"),
            ("TMPDIR", "/tmp/ada"),
        ]
        .map(|(name, value)| (name.to_owned(), value.to_owned()));
        assert_eq!(pairs, expected);
    }
}
