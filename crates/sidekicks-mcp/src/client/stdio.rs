//! A tool server the daemon starts as a child and talks to over its standard input and output.
//!
//! - It starts on the daemon's spawner thread, leading a session of its own so a stop reaches
//!   what it started too, armed to end with the daemon, in the environment a conversation's
//!   commands get with the server's own values laid over it.
//! - Its error output goes to the service log line by line and into the bounded tail its exit
//!   carries, so a server that dies at its start says why.
//! - It closes as the protocol asks: its input closed, 2 s, `SIGTERM` to its group, 2 s, then a
//!   kill of the group; a connection dropped unclosed kills it at once.

use std::error::Error;
use std::io;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use process_wrap::tokio::ChildWrapper;
use rmcp::transport::async_rw::AsyncRwTransport;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_platforms::{
    ChildEnd, Spawner, ask_child_to_stop, read_child_exit, wrap_session_child_command,
};
use sidekicks_provider::spawn_environment::{
    ProviderEnvironmentRequest, SpawnEnvironmentError, build_conversation_command_environment,
    remove_environment_names,
};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::process_exit::{OutputTail, compose_process_exit, read_output_chunks};
use sidekicks_std::utf8_stream::Utf8StreamDecoder;
use tokio::io::AsyncRead;
use tokio::process::Command;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::client::connection::{
    McpConnectionError, McpConnectionScope, McpConnectionStart, McpServerConnection,
};
use crate::client::raw_copy::{RawLineTee, RawReplyCopy};

/// How long a closed server may take to end after its input closed, and again after `SIGTERM`.
const CLOSE_STEP_WAIT: Duration = Duration::from_secs(2);

/// How long the error output is read on after the process ended, for what it wrote last.
const ERROR_OUTPUT_DRAIN: Duration = Duration::from_millis(250);

/// The longest error-output line the service log takes; the rest of the line is left out.
const LOGGED_LINE_MAX_BYTES: usize = 4 * 1024;

/// The tail of a server's error output a failed start or an exit carries: its last 32,768 code
/// points.
type ErrorOutputTail = OutputTail<PROVIDER_FAILURE_DETAIL_MAX_LEN>;

/// How a stdio server's process ended: its exit with its error output's tail, or why its end
/// could not be read.
pub(crate) type ProcessEnd = Result<ProcessExit, Arc<io::Error>>;

/// A tool server the daemon starts as a child and talks to over its standard input and output.
#[derive(Clone, Debug)]
pub(crate) struct McpStdioServer {
    /// The program.
    pub(crate) program: PathBuf,
    /// Its arguments.
    pub(crate) arguments: Vec<String>,
    /// The environment values its entry holds, laid over a conversation command's environment.
    pub(crate) environment: Vec<(String, String)>,
    /// The folder it starts in, where the entry names one.
    pub(crate) working_folder: Option<PathBuf>,
    /// How long its start may take, `None` for the 30 s default.
    pub(crate) startup_timeout: Option<Duration>,
}

impl McpServerConnection {
    /// Starts `server` on `spawner`'s thread in the environment `environment` builds for a
    /// conversation's commands, with the server's own values over it, and opens a connection over
    /// its standard streams, its output teed into the raw copy. Fails when the environment cannot
    /// be built, the process cannot start, or the server does not complete its start in time or
    /// its first tools read; past the spawn, the error carries the process's exit.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the session's tool-server connections, which the tool-server units open, \
                      start a stdio server through it"
        )
    )]
    pub(crate) async fn start_stdio(
        spawner: &Spawner,
        server: McpStdioServer,
        environment: &ProviderEnvironmentRequest<'_>,
        scope: McpConnectionScope,
    ) -> Result<Self, McpConnectionError> {
        let mut start = McpConnectionStart::stdio(server.startup_timeout, None);
        let environment = compose_server_environment(environment, &server.environment)?;
        let mut command = Command::new(&server.program);
        command
            .args(&server.arguments)
            .env_clear()
            .envs(environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(working_folder) = &server.working_folder {
            command.current_dir(working_folder);
        }
        let daemon_pid = std::process::id();
        let mut child = spawner
            .run(move || wrap_session_child_command(command, daemon_pid).spawn())
            .await
            .and_then(|spawned| spawned)
            .map_err(McpConnectionError::Start)?;
        let streams = (
            child.inner_mut().stdout().take(),
            child.inner_mut().stdin().take(),
            child.inner_mut().stderr().take(),
        );
        let process = StdioProcess::supervise(child, streams.2, &scope);
        let (Some(output), Some(input)) = (streams.0, streams.1) else {
            drop(process);
            return Err(McpConnectionError::Start(io::Error::other(
                "the tool server's standard streams were not piped",
            )));
        };
        start.hold(process);
        let raw = RawReplyCopy::default();
        let transport = AsyncRwTransport::new_client(RawLineTee::new(output, raw.clone()), input);
        Self::open(transport, raw, scope, start).await
    }

    /// How a stdio server's process ended, once it did: closed, killed or on its own, the tail
    /// of its error output beside it; `None` at once for a server at an address.
    #[expect(
        dead_code,
        reason = "the session's tool-server connections, which the tool-server units open, show a \
                  server that ended unasked as failed, with what it wrote"
    )]
    pub(crate) async fn wait_for_process_end(&self) -> Option<ProcessEnd> {
        Some(self.process.as_ref()?.end().await)
    }
}

/// The server's environment: a conversation command's, with every value starting with `()` left
/// out, as a shell exports a function, then the server's own values over it.
fn compose_server_environment(
    request: &ProviderEnvironmentRequest<'_>,
    server_environment: &[(String, String)],
) -> Result<Vec<(String, String)>, SpawnEnvironmentError> {
    let mut environment = build_conversation_command_environment(request)?;
    environment.retain(|(_, value)| !value.starts_with("()"));
    let server_names: Vec<&str> = server_environment
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    remove_environment_names(&mut environment, &server_names, request.session.rules);
    environment.extend(server_environment.iter().cloned());
    Ok(environment)
}

/// A running stdio server's process, waited on by a task of its own that takes each end asked of
/// it and publishes how it ended. Dropped, the process is killed.
pub(crate) struct StdioProcess {
    ends: mpsc::Sender<ChildEnd>,
    end: watch::Receiver<Option<ProcessEnd>>,
}

impl StdioProcess {
    /// Waits on `child` in a task of its own, reading `error_output` into the service log under
    /// `scope`'s server name and into the tail its end carries.
    pub(super) fn supervise(
        child: Box<dyn ChildWrapper>,
        error_output: Option<tokio::process::ChildStderr>,
        scope: &McpConnectionScope,
    ) -> Self {
        let tail = Arc::new(Mutex::new(ErrorOutputTail::new()));
        let reader = error_output.map(|error_output| {
            tokio::spawn(read_error_output(
                error_output,
                scope.server_name.as_str().to_owned(),
                Arc::clone(&tail),
            ))
        });
        let (ends, asked) = mpsc::channel(2);
        let (published, end) = watch::channel(None);
        tokio::spawn(supervise_child(child, asked, reader, tail, published));
        Self { ends, end }
    }

    /// How the process ended, once it did.
    pub(super) async fn end(&self) -> ProcessEnd {
        let mut end = self.end.clone();
        match end.wait_for(Option::is_some).await {
            Ok(ended) => ended
                .clone()
                .expect("the wait returns only once the end is published"),
            Err(_supervisor_gone) => Err(Arc::new(io::Error::other(
                "the tool server's process was no longer waited on",
            ))),
        }
    }

    /// Kills the process's group and waits for its end.
    pub(super) async fn kill(&self) -> ProcessEnd {
        self.ask(ChildEnd::Kill).await;
        self.end().await
    }

    /// Ends a process whose input was just closed: 2 s for it to end, then `SIGTERM` to its group
    /// and 2 s more, then a kill of the group. Never fails.
    pub(super) async fn close(&self) {
        for end in [ChildEnd::Stop, ChildEnd::Kill] {
            if tokio::time::timeout(CLOSE_STEP_WAIT, self.end())
                .await
                .is_ok()
            {
                return;
            }
            self.ask(end).await;
        }
        if let Err(error) = self.end().await {
            tracing::warn!(
                error = &*error as &(dyn Error + 'static),
                "a closed tool server's end could not be read"
            );
        }
    }

    // Asks the waiting task for `end`; a task that has finished already has published the end.
    async fn ask(&self, end: ChildEnd) {
        if self.ends.send(end).await.is_err() {
            tracing::debug!("a tool server's process had ended before it was asked to");
        }
    }
}

/// Waits on `child` until it ends, sending each end `asked` brings and killing it when `asked`
/// closes; then reads the error output on for a moment and publishes the end with its tail.
async fn supervise_child(
    mut child: Box<dyn ChildWrapper>,
    mut asked: mpsc::Receiver<ChildEnd>,
    reader: Option<JoinHandle<()>>,
    tail: Arc<Mutex<ErrorOutputTail>>,
    published: watch::Sender<Option<ProcessEnd>>,
) {
    let mut asked_end = None;
    let mut is_dropped = false;
    let status = loop {
        let next = tokio::select! {
            status = child.wait() => Ok(status),
            end = asked.recv(), if !is_dropped => Err(end),
        };
        let end = match next {
            Ok(status) => break status,
            Err(Some(end)) => end,
            Err(None) => {
                is_dropped = true;
                ChildEnd::Kill
            }
        };
        let sent = match end {
            // The child leads its own session, so the stop reaches its whole group.
            ChildEnd::Stop => ask_child_to_stop(&mut *child),
            ChildEnd::Kill => child.start_kill(),
        };
        match sent {
            Ok(()) => asked_end = Some(end),
            Err(error) => tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a tool server's process could not be asked to end"
            ),
        }
    };
    if let Some(mut reader) = reader
        && tokio::time::timeout(ERROR_OUTPUT_DRAIN, &mut reader)
            .await
            .is_err()
    {
        // What the process started may hold the output open; what it wrote by now is kept.
        reader.abort();
    }
    let tail = std::mem::replace(&mut *lock(&tail), ErrorOutputTail::new());
    published.send_replace(Some(compose_end(status, asked_end, tail)));
}

fn compose_end(
    status: io::Result<ExitStatus>,
    asked_end: Option<ChildEnd>,
    tail: ErrorOutputTail,
) -> ProcessEnd {
    let status = status.map_err(Arc::new)?;
    Ok(compose_process_exit(
        read_child_exit(&status, asked_end),
        tail,
    ))
}

/// Reads `error_output` to its end, chunk by chunk, into `tail` and line by line into the service
/// log under `server`, each line cut at 4 KiB so a line that never ends holds no more.
async fn read_error_output(
    error_output: impl AsyncRead + Unpin,
    server: String,
    tail: Arc<Mutex<ErrorOutputTail>>,
) {
    let mut line = Vec::new();
    let what = format!("the error output of tool server '{server}'");
    read_output_chunks(error_output, &what, |chunk| {
        lock(&tail).push(chunk);
        for piece in chunk.split_inclusive(|byte| *byte == b'\n') {
            let (body, is_line_end) = match piece.split_last() {
                Some((b'\n', body)) => (body, true),
                _ => (piece, false),
            };
            let room = LOGGED_LINE_MAX_BYTES.saturating_sub(line.len());
            line.extend_from_slice(&body[..body.len().min(room)]);
            if is_line_end {
                log_error_output_line(&server, &line);
                line.clear();
            }
        }
    })
    .await;
    if !line.is_empty() {
        log_error_output_line(&server, &line);
    }
}

fn log_error_output_line(server: &str, line: &[u8]) {
    let line = error_output_line_text(line);
    tracing::info!(server, line = %line, "a tool server wrote to its error output");
}

// A logged line as text: its `\r` dropped, a character the 4 KiB cut split at its end left out,
// and each other invalid sequence read as U+FFFD.
fn error_output_line_text(line: &[u8]) -> String {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let mut text = String::with_capacity(line.len());
    Utf8StreamDecoder::default().push(line, |piece| text.push_str(piece));
    text
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::run::control::ProcessExit;
    use sidekicks_platforms::{
        POSIX_SHELL, PathRules, Spawner, shell_line_command, wrap_session_child_command,
    };
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::spawn_environment::{
        ProviderEnvironmentRequest, ReservedEnvironmentNames, SessionEnvironment,
    };
    use tokio::io::AsyncReadExt as _;

    use super::{LOGGED_LINE_MAX_BYTES, McpStdioServer, StdioProcess, error_output_line_text};
    use crate::client::connection::{McpConnectionError, McpServerConnection};
    use crate::client::test_server::{
        Reply, method_not_found, start_test_server, test_client, test_scope, v1_initialize_result,
    };

    // Mutations: in `start_stdio`, leave stderr unpiped, or drop the tail `supervise_child`
    // publishes; in `compose_server_environment`, keep `()` values or lay the server's values
    // under the conversation's.
    #[tokio::test]
    async fn a_server_that_dies_at_its_start_says_why_in_its_own_environment() {
        let (client, _card) = test_client();
        let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
        let reserved_names = ReservedEnvironmentNames::of_providers(PROVIDERS);
        let base = [
            ("EXPORTED_FUNCTION".to_owned(), "() {  :\n}".to_owned()),
            ("TRACKER_TOKEN".to_owned(), "from-the-shell".to_owned()),
        ];
        let environment = ProviderEnvironmentRequest {
            session: SessionEnvironment {
                base: &base,
                every_project_rows: &[],
                project_rows: &[],
                reserved_names: &reserved_names,
                rules: PathRules::NATIVE,
            },
            descriptor: PROVIDERS[0],
            deny_env_vars: &[],
            credential_homes: &[],
        };
        let server = McpStdioServer {
            program: POSIX_SHELL.into(),
            arguments: vec![
                "-c".to_owned(),
                concat!(
                    r#"echo "missing API key token=$TRACKER_TOKEN "#,
                    r#"function=${EXPORTED_FUNCTION-unset}" >&2; exit 1"#,
                )
                .to_owned(),
            ],
            environment: vec![("TRACKER_TOKEN".to_owned(), "from-the-entry".to_owned())],
            working_folder: None,
            startup_timeout: None,
        };

        let started =
            McpServerConnection::start_stdio(&spawner, server, &environment, test_scope(&client))
                .await;

        let Err(McpConnectionError::ProcessFailedStart { exit, .. }) = started else {
            panic!("the start fails with the process's exit");
        };
        let ProcessExit::Code(exit) = *exit else {
            panic!("the server exits with a code");
        };
        assert_eq!(
            exit.output_tail.as_str().trim_end(),
            "missing API key token=from-the-entry function=unset"
        );
    }

    // Mutations: in `StdioProcess::close`, skip the `Stop` step; or in `start_stdio` and here,
    // spawn through `wrap_child_command`, whose stop reaches the shell alone, which then waits on
    // its child until the kill.
    #[tokio::test]
    async fn a_server_that_ignores_its_closed_input_ends_after_sigterm_to_its_group() {
        let (client, _card) = test_client();
        let scope = test_scope(&client);
        let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
        // The server waits on a child of its own once asked to stop, and the child says it was
        // asked too before it ends.
        let script = "trap 'wait $child; exit 0' TERM; \
                      (trap 'echo asked; exit 0' TERM; while :; do sleep 0.05; done) & \
                      child=$!; wait $child";
        let mut command = shell_line_command(Path::new(POSIX_SHELL), script);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let daemon_pid = std::process::id();
        let mut child = spawner
            .run(move || wrap_session_child_command(command, daemon_pid).spawn())
            .await
            .and_then(|spawned| spawned)
            .expect("the child starts");
        let mut output = child
            .inner_mut()
            .stdout()
            .take()
            .expect("the output is piped");
        let process = StdioProcess::supervise(child, None, &scope);
        let (opened, _server) = start_test_server(
            scope,
            Box::new(|method, _params| match method {
                "initialize" => Reply::Answer(json!({ "result": v1_initialize_result() })),
                "tools/list" => Reply::Answer(json!({ "result": { "tools": [] } })),
                _ => method_not_found(),
            }),
            Some(process),
        )
        .await;
        let connection = opened.expect("the connection opens");
        let closing = Instant::now();

        connection.close().await;

        let took = closing.elapsed();
        assert!(
            took >= Duration::from_secs(2) && took < Duration::from_secs(4),
            "the close waits 2 s, then the group ends on SIGTERM, not at the kill: {took:?}"
        );
        let mut said = String::new();
        tokio::time::timeout(Duration::from_secs(1), output.read_to_string(&mut said))
            .await
            .expect("every holder of the output ended")
            .expect("the output reads");
        assert_eq!(said, "asked\n");
    }

    // Mutation: in `error_output_line_text`, decode the cut line lossily as it stands, which ends
    // it in U+FFFD, or call the decoder's `finish`, which does too.
    #[rstest]
    #[case::nothing_else_invalid(b"", "")]
    // An invalid byte earlier in the line reads as U+FFFD and still leaves the cut character out.
    #[case::an_invalid_byte_before_it(b"\xFF", "\u{FFFD}")]
    fn a_logged_line_cut_inside_a_character_leaves_the_character_out(
        #[case] start: &[u8],
        #[case] expected_start: &str,
    ) {
        let mut line = start.to_vec();
        line.resize(LOGGED_LINE_MAX_BYTES - 1, b'a');
        line.extend_from_slice("é".as_bytes());

        let text = error_output_line_text(&line[..LOGGED_LINE_MAX_BYTES]);

        let expected_a_count = LOGGED_LINE_MAX_BYTES - 1 - start.len();
        assert_eq!(
            text,
            format!("{expected_start}{}", "a".repeat(expected_a_count))
        );
    }
}
