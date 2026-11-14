//! One running connection to a tool server: rmcp's client over a stdio or HTTP transport, the raw
//! copy of the replies the client reads raw, which Tasks protocol the server speaks, the calls in
//! flight on it, and the handler that takes the server's own requests and notifications.
//!
//! - The lifecycle probes `server/discover` and falls back to `initialize`, so a 2026-07-28 server
//!   and a 2025-11-25 one both connect; a 2026-07-28 server declares the Tasks extension in its
//!   typed capabilities, a 2025-11-25 one `capabilities.tasks.requests.tools.call` in its raw
//!   `initialize` reply, beside `capabilities.tasks.cancel` when it takes `tasks/cancel`. The
//!   whole start is held to the server's start-up timeout.
//! - Every question the server asks goes on the questions card: one carrying a followed task's
//!   id under that task's run, any other under the run of the call in flight on the connection,
//!   and with none in flight it is answered `cancel`, since nobody saw it. While it is open, the
//!   connection's tool calls' idle window stands still.

pub(super) mod standing;

use std::collections::HashSet;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rmcp::model::{
    ClientCapabilities, CustomNotification, ElicitRequestParams, ElicitResult, ElicitationAction,
    ErrorData, Implementation, InitializeRequestParams, ProgressNotificationParam, ProtocolVersion,
    TaskStatusNotificationParams,
};
use rmcp::service::{
    ClientInitializeError, ClientLifecycleMode, MaybeSendFuture, NotificationContext,
    RequestContext, RunningService, serve_client_with_lifecycle,
};
use rmcp::{ClientHandler, RoleClient};
use serde_json::{Value, json};
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::release_manifest::ReleaseVersion;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::spawn_environment::SpawnEnvironmentError;
use sidekicks_std::mutex_lock::lock;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::client::calls::CallsInFlight;
use crate::client::idle_window::ToolCallActivity;
use crate::client::prompts::PromptWatchers;
use crate::client::raw_copy::{
    DetachedRequests, INITIALIZE_METHOD, RawCopyTransport, RawReplyCopy,
};
use crate::client::requests::{McpRequestError, PageCursors, RequestWait, ServerRequests};
use crate::client::stdio::StdioProcess;
use crate::client::tasks::watches::{QuestionOutcome, TaskWatches};
use crate::client::tasks::{McpServerEndpoint, McpTaskGeneration};
use crate::sign_in::address_digest::ServerAddressDigest;

/// The notification a 2025-11-25 server sends when a task's status changes.
const V1_TASK_STATUS_METHOD: &str = "notifications/tasks/status";

/// The `_meta` key naming the task a 2025-11-25 server's request belongs to.
const RELATED_TASK_META_KEY: &str = "io.modelcontextprotocol/related-task";

/// How long a server may take to start when its entry names no start-up timeout (Claude Code's
/// and Codex's own default).
pub(super) const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// Why a connection to a tool server could not be opened.
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpConnectionError {
    /// The server's process could not start, or its standard streams were not piped.
    #[error("the tool server's process could not start")]
    Start(#[source] io::Error),
    /// The server's entry sets a header the client sets itself.
    #[error("the tool server's entry sets the {name} header, which the client sets itself")]
    ReservedHeader {
        /// The header's name.
        name: String,
    },
    /// The server's process environment could not be built.
    #[error("the tool server's environment could not be built")]
    Environment(#[from] SpawnEnvironmentError),
    /// The server did not complete the lifecycle's start.
    #[error("the tool server did not complete its start")]
    Initialize(#[source] Box<ClientInitializeError>),
    /// The server did not complete its start within its start-up timeout.
    #[error("the tool server did not start within {timeout:?}")]
    StartupTimedOut {
        /// The start-up timeout.
        timeout: Duration,
    },
    /// The first read of its tools failed.
    #[error("the tool server's tools could not be read")]
    Tools(#[source] McpRequestError),
    /// A stdio server's start failed, and its process was ended; its exit carries the tail of
    /// what it wrote to its error output.
    #[error("the tool server's process failed its start")]
    ProcessFailedStart {
        /// Why the start failed.
        #[source]
        cause: Box<McpConnectionError>,
        /// How the process ended, with its error output's tail.
        exit: Box<ProcessExit>,
    },
}

/// What a connection is: its session, its server's name, the client's shared HTTP client, the
/// shared watches its handler feeds and the release version it declares.
#[derive(Clone)]
pub(crate) struct McpConnectionScope {
    /// The session the connection serves.
    pub(crate) session_id: SessionId,
    /// The server's name.
    pub(crate) server_name: McpServerName,
    /// The client's one HTTP client, which a server at an address is reached through.
    pub(crate) http: reqwest::Client,
    /// The listeners of each session's prompts.
    pub(crate) prompt_watchers: Arc<PromptWatchers>,
    /// The tasks the connection follows.
    pub(crate) task_watches: Arc<TaskWatches>,
    /// The daemon's release version, which the client declares to the server.
    pub(crate) release_version: ReleaseVersion,
}

/// How a connection starts: the deadline its start is held to, its tool calls' idle window, the
/// stdio server's process it holds, if any, and the server's endpoint.
pub(super) struct McpConnectionStart {
    startup_timeout: Duration,
    startup_deadline: Instant,
    tool_call_idle_timeout: Duration,
    process: Option<StdioProcess>,
    endpoint: McpServerEndpoint,
}

impl McpConnectionStart {
    /// A stdio server's start, from now, within `startup_timeout` or the default.
    pub(super) fn stdio(startup_timeout: Option<Duration>, process: Option<StdioProcess>) -> Self {
        Self::new(
            startup_timeout,
            crate::client::requests::STDIO_TOOL_CALL_IDLE_TIMEOUT,
            process,
            McpServerEndpoint::stdio(),
        )
    }

    /// A start at the address whose keyed digest is `digest`, from now, within `startup_timeout`
    /// or the default.
    pub(super) fn http(startup_timeout: Option<Duration>, digest: &ServerAddressDigest) -> Self {
        Self::new(
            startup_timeout,
            crate::client::requests::HTTP_TOOL_CALL_IDLE_TIMEOUT,
            None,
            McpServerEndpoint::at_address(digest),
        )
    }

    fn new(
        startup_timeout: Option<Duration>,
        tool_call_idle_timeout: Duration,
        process: Option<StdioProcess>,
        endpoint: McpServerEndpoint,
    ) -> Self {
        let startup_timeout = startup_timeout.unwrap_or(DEFAULT_STARTUP_TIMEOUT);
        Self {
            startup_timeout,
            startup_deadline: Instant::now() + startup_timeout,
            tool_call_idle_timeout,
            process,
            endpoint,
        }
    }

    /// Holds `process` for the connection's life.
    pub(super) fn hold(&mut self, process: StdioProcess) {
        self.process = Some(process);
    }
}

/// One open connection to a tool server.
pub(crate) struct McpServerConnection {
    pub(super) scope: McpConnectionScope,
    /// Which server this is, stamped on each task it accepts.
    pub(super) endpoint: McpServerEndpoint,
    pub(super) service: RunningService<RoleClient, McpClientHandler>,
    pub(super) requests: ServerRequests,
    /// The Tasks protocol the server speaks, `None` when it offers no tasks.
    pub(super) task_generation: Option<McpTaskGeneration>,
    /// Whether the server takes `tasks/cancel`: on a 2025-11-25 server, when it declares
    /// `tasks.cancel`; on a 2026-07-28 server always, since its Tasks extension carries the method.
    pub(super) can_cancel_tasks: bool,
    /// The tool calls in flight, with their runs.
    pub(super) calls: Arc<CallsInFlight>,
    /// On a 2025-11-25 server, each tool whose `execution.taskSupport` takes a task.
    task_tools: Mutex<HashSet<String>>,
    /// Set when the server says its tools changed, so the next task call reads them again.
    are_tools_stale: Arc<AtomicBool>,
    /// A stdio server's process, ended when the connection closes or drops.
    pub(super) process: Option<StdioProcess>,
    /// Canceled as the connection starts to close, before its service, so a 2025-11-25 task's
    /// question whose request the close cuts is detached rather than withdrawn.
    closing: CancellationToken,
}

impl McpServerConnection {
    /// Opens a connection over `transport`, whose replies already feed `raw`, as `start` says.
    /// Fails when the server does not complete its start within its start-up timeout or its first
    /// tools read; a stdio server's process is then ended and its exit carried by the error.
    pub(super) async fn open<T>(
        transport: T,
        raw: RawReplyCopy,
        scope: McpConnectionScope,
        start: McpConnectionStart,
    ) -> Result<Self, McpConnectionError>
    where
        T: rmcp::transport::Transport<RoleClient> + 'static,
    {
        let McpConnectionStart {
            startup_timeout,
            startup_deadline,
            tool_call_idle_timeout,
            process,
            endpoint,
        } = start;
        let are_tools_stale = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(CallsInFlight::default());
        let activity = Arc::new(ToolCallActivity::new());
        let closing = CancellationToken::new();
        let detached = DetachedRequests::default();
        let handler = McpClientHandler {
            scope: scope.clone(),
            are_tools_stale: Arc::clone(&are_tools_stale),
            calls: Arc::clone(&calls),
            activity: Arc::clone(&activity),
            closing: closing.clone(),
            detached: Arc::clone(&detached),
        };
        let lifecycle = serve_client_with_lifecycle(
            handler,
            RawCopyTransport {
                inner: transport,
                raw: raw.clone(),
                detached,
            },
            ClientLifecycleMode::Auto {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
                legacy_version: Some(ProtocolVersion::V_2025_11_25),
            },
        );
        let started = match tokio::time::timeout_at(startup_deadline, lifecycle).await {
            Ok(Ok(service)) => Ok(service),
            Ok(Err(error)) => Err(McpConnectionError::Initialize(Box::new(error))),
            Err(_elapsed) => Err(McpConnectionError::StartupTimedOut {
                timeout: startup_timeout,
            }),
        };
        let service = match started {
            Ok(service) => service,
            Err(error) => return Err(end_failed_start(error, process).await),
        };
        let initialize = raw.take_reply_to(INITIALIZE_METHOD);
        let declares_v1_tasks = initialize
            .as_ref()
            .and_then(|reply| reply.pointer("/result/capabilities/tasks/requests/tools/call"))
            .is_some();
        let declares_v2_tasks = service
            .peer()
            .peer_info()
            .is_some_and(|info| info.capabilities.supports_tasks());
        let can_cancel_tasks = declares_v2_tasks
            || initialize
                .as_ref()
                .and_then(|reply| reply.pointer("/result/capabilities/tasks/cancel"))
                .is_some();
        let task_generation = if declares_v2_tasks {
            Some(McpTaskGeneration::V2)
        } else if declares_v1_tasks {
            Some(McpTaskGeneration::V1)
        } else {
            None
        };
        let mut connection = Self {
            requests: ServerRequests {
                peer: service.peer().clone(),
                raw,
                tool_call_idle_timeout,
                activity,
            },
            scope,
            endpoint,
            service,
            task_generation,
            can_cancel_tasks,
            calls,
            task_tools: Mutex::new(HashSet::new()),
            are_tools_stale,
            process: None,
            closing,
        };
        if task_generation == Some(McpTaskGeneration::V1)
            && let Err(error) = connection.read_task_tools().await
        {
            connection.service.cancellation_token().cancel();
            return Err(end_failed_start(McpConnectionError::Tools(error), process).await);
        }
        connection.process = process;
        Ok(connection)
    }

    /// Closes the connection: it is marked closing, then its transport is closed, which closes a
    /// stdio server's input, the primary way to ask it to stop; then, for a stdio server, its
    /// process is ended as [`StdioProcess::close`] says. Never fails.
    pub(crate) async fn close(&self) {
        self.closing.cancel();
        self.service.cancellation_token().cancel();
        if let Some(process) = &self.process {
            process.close().await;
        }
    }

    /// Whether `tool_name` takes a task on this server. On a 2025-11-25 server, the answer comes
    /// from its tools' `execution.taskSupport`, read again first when the server said they
    /// changed; on any other server it is false, since that server decides per call or takes no
    /// task. Fails as that read fails; the tools then stay marked changed, as they do when the
    /// caller stops waiting for the read, so the next task call reads them again.
    pub(super) async fn is_task_tool(&self, tool_name: &str) -> Result<bool, McpRequestError> {
        if self.task_generation != Some(McpTaskGeneration::V1) {
            return Ok(false);
        }
        if self.are_tools_stale.swap(false, Ordering::AcqRel) {
            let mut unread = StaleToolsMark {
                are_tools_stale: &self.are_tools_stale,
                is_read: false,
            };
            self.read_task_tools().await?;
            unread.is_read = true;
        }
        Ok(lock(&self.task_tools).contains(tool_name))
    }

    /// Re-reads, page by page from the raw `tools/list` replies as [`PageCursors`] bounds them,
    /// which tools take a task: those whose `execution.taskSupport` is `required` or `optional`.
    /// Fails as a page's request fails.
    pub(super) async fn read_task_tools(&self) -> Result<(), McpRequestError> {
        let mut task_tools = HashSet::new();
        let mut cursors = PageCursors::default();
        let mut cursor: Option<String> = None;
        loop {
            let params = cursor.map(|cursor| json!({ "cursor": cursor }));
            let page = self
                .requests
                .send_raw("tools/list", params, RequestWait::Ordinary)
                .await?;
            let tools = page.get("tools").and_then(Value::as_array).ok_or_else(|| {
                McpRequestError::Malformed {
                    method: "tools/list".to_owned(),
                }
            })?;
            task_tools.extend(tools.iter().filter_map(|tool| {
                let support = tool.pointer("/execution/taskSupport")?.as_str()?;
                matches!(support, "required" | "optional")
                    .then(|| tool.get("name")?.as_str().map(str::to_owned))?
            }));
            let next = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            cursor = cursors.follow("tools/list", next);
            if cursor.is_none() {
                break;
            }
        }
        *lock(&self.task_tools) = task_tools;
        Ok(())
    }
}

/// `error`, with the stdio server's exit beside it once its process was ended.
async fn end_failed_start(
    error: McpConnectionError,
    process: Option<StdioProcess>,
) -> McpConnectionError {
    let Some(process) = process else {
        return error;
    };
    match process.kill().await {
        Ok(exit) => McpConnectionError::ProcessFailedStart {
            cause: Box::new(error),
            exit: Box::new(exit),
        },
        Err(wait_error) => {
            tracing::warn!(
                error = &*wait_error as &(dyn std::error::Error + 'static),
                "a tool server's process that failed its start could not be waited for"
            );
            error
        }
    }
}

/// Marks a connection's tools changed again when dropped before their read succeeded: the read
/// failed, or its caller stopped waiting.
struct StaleToolsMark<'connection> {
    are_tools_stale: &'connection AtomicBool,
    is_read: bool,
}

impl Drop for StaleToolsMark<'_> {
    fn drop(&mut self) {
        if !self.is_read {
            self.are_tools_stale.store(true, Ordering::Release);
        }
    }
}

/// The client's side of a connection: what it declares, and the server's requests and
/// notifications it takes.
pub(crate) struct McpClientHandler {
    scope: McpConnectionScope,
    are_tools_stale: Arc<AtomicBool>,
    calls: Arc<CallsInFlight>,
    activity: Arc<ToolCallActivity>,
    /// The connection's closing mark.
    closing: CancellationToken,
    /// The requests whose answer the transport drops.
    detached: DetachedRequests,
}

impl ClientHandler for McpClientHandler {
    fn get_info(&self) -> InitializeRequestParams {
        InitializeRequestParams::new(
            ClientCapabilities::builder()
                .enable_elicitation()
                .enable_tasks()
                .build(),
            Implementation::new("sidekicks-daemon", self.scope.release_version.as_str()),
        )
    }

    async fn create_elicitation(
        &self,
        request: ElicitRequestParams,
        context: RequestContext<RoleClient>,
    ) -> Result<ElicitResult, ErrorData> {
        // Open from the request's arrival to its answer, its cancel included, so no call's idle
        // window runs out while the person answers or the question waits its run's turn.
        let _open_question = self.activity.open_question();
        let params = serde_json::to_value(&request)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        // rmcp moves the request's `_meta` out of its params into the context.
        let related_task = context
            .meta
            .get(RELATED_TASK_META_KEY)
            .and_then(|related| related.get("taskId"))
            .and_then(Value::as_str);
        let ask = async {
            match related_task {
                Some(task_id) => {
                    self.scope
                        .task_watches
                        .ask_v1_task_question(&self.scope, task_id, params, &self.closing)
                        .await
                }
                None => self.calls.ask_newest_call(&self.scope, params).await,
            }
        };
        // A request the server canceled drops its question, which withdraws it from the card. One
        // the connection's close cut leaves a task's question open for the server's next ask on
        // another connection, and the answer to it is never sent.
        let asked = tokio::select! {
            asked = ask => asked,
            () = context.ct.cancelled() => {
                if self.closing.is_cancelled() && related_task.is_some() {
                    lock(&self.detached).insert(context.id.clone());
                }
                Some(QuestionOutcome::Withdrawn)
            }
        };
        Ok(match asked {
            Some(QuestionOutcome::Answered(content)) => {
                let mut answer = ElicitResult::new(ElicitationAction::Accept);
                answer.content = Some(Value::Object(content));
                answer
            }
            Some(QuestionOutcome::Withdrawn) => ElicitResult::new(ElicitationAction::Cancel),
            None => {
                tracing::warn!(
                    server = self.scope.server_name.as_str(),
                    "a tool server asked for input no call or task of the client waits on"
                );
                ElicitResult::new(ElicitationAction::Cancel)
            }
        })
    }

    fn on_progress(
        &self,
        params: ProgressNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.activity.progressed(&params.progress_token);
        std::future::ready(())
    }

    async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>) {
        self.are_tools_stale.store(true, Ordering::Release);
    }

    async fn on_prompt_list_changed(&self, _context: NotificationContext<RoleClient>) {
        self.scope.prompt_watchers.notify(self.scope.session_id);
    }

    fn on_task_status(
        &self,
        params: TaskStatusNotificationParams,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.scope
            .task_watches
            .wake(&self.scope, &params.task.task.task_id);
        std::future::ready(())
    }

    fn on_custom_notification(
        &self,
        notification: CustomNotification,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        if notification.method == V1_TASK_STATUS_METHOD
            && let Some(task_id) = notification
                .params
                .as_ref()
                .and_then(|params| params.get("taskId"))
                .and_then(Value::as_str)
        {
            self.scope.task_watches.wake(&self.scope, task_id);
        }
        std::future::ready(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use serde_json::json;
    use tokio::time::{Duration, Instant, timeout};

    use super::{DEFAULT_STARTUP_TIMEOUT, McpConnectionError, McpConnectionStart};
    use crate::client::test_server::{
        Reply, method_not_found, open_test_server, start_test_server, test_client, test_scope,
        v1_initialize_result,
    };

    // Mutation: in `McpServerConnection::open`, await the lifecycle without `timeout_at`, or
    // measure the deadline from a later instant.
    #[tokio::test(start_paused = true)]
    async fn a_server_that_never_answers_its_start_fails_it_at_30_s() {
        let (client, _card) = test_client();
        let started = Instant::now();

        let (opened, _server) = timeout(
            Duration::from_secs(120),
            start_test_server(
                test_scope(&client),
                Box::new(|_, _| Reply::Silent),
                McpConnectionStart::stdio(None, None),
            ),
        )
        .await
        .expect("the start ends");

        let Err(McpConnectionError::StartupTimedOut { timeout }) = opened else {
            panic!("the start times out");
        };
        assert_eq!(timeout, DEFAULT_STARTUP_TIMEOUT);
        assert_eq!(started.elapsed(), Duration::from_secs(30));
    }

    // Mutation: in `is_task_tool`, leave the tools unmarked after a failed read; the second call
    // then answers `false` from the old set.
    #[tokio::test(start_paused = true)]
    async fn a_failed_read_of_changed_tools_leaves_them_marked_for_the_next_task_call() {
        let (client, _card) = test_client();
        let mut tools_reads = 0;
        let (connection, server) = open_test_server(
            &client,
            Box::new(move |method, _params| match method {
                "initialize" => Reply::Answer(json!({ "result": v1_initialize_result() })),
                "tools/list" => {
                    tools_reads += 1;
                    let track = json!({ "name": "track", "inputSchema": { "type": "object" } });
                    match tools_reads {
                        1 => Reply::Answer(json!({ "result": { "tools": [track] } })),
                        2 => {
                            Reply::Answer(json!({ "error": { "code": -32603, "message": "busy" } }))
                        }
                        _ => Reply::Answer(json!({ "result": { "tools": [track, {
                            "name": "export",
                            "inputSchema": { "type": "object" },
                            "execution": { "taskSupport": "optional" },
                        }] } })),
                    }
                }
                _ => method_not_found(),
            }),
        )
        .await;
        connection.are_tools_stale.store(true, Ordering::Release);

        let failed = connection.is_task_tool("export").await;
        let read_again = connection.is_task_tool("export").await;

        assert!(failed.is_err(), "the failed read fails the call");
        assert!(
            read_again.expect("the second read answers"),
            "export takes a task"
        );
        assert_eq!(server.requests("tools/list").len(), 3);
    }
}
