//! One running connection to a tool server: rmcp's client over a stdio or HTTP transport, the raw
//! copy of the replies the client reads raw, which Tasks protocol the server speaks, and the
//! handler that takes the server's own requests and notifications.
//!
//! - The lifecycle probes `server/discover` and falls back to `initialize`, so a 2026-07-28 server
//!   and a 2025-11-25 one both connect; a 2026-07-28 server declares the Tasks extension in its
//!   typed capabilities, a 2025-11-25 one `capabilities.tasks.requests.tools.call` in its raw
//!   `initialize` reply.
//! - A stdio server's process starts on the daemon's spawner thread, armed to end with the daemon
//!   and killed when the connection drops.

use std::collections::HashSet;
use std::io;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use process_wrap::tokio::ChildWrapper;
use rmcp::model::{
    ClientCapabilities, ClientRequest, CustomNotification, CustomRequest, ElicitRequestParams,
    ElicitResult, ElicitationAction, ErrorData, Implementation, InitializeRequestParams,
    ProtocolVersion, RequestId, TaskStatusNotificationParams,
};
use rmcp::service::{
    ClientInitializeError, ClientLifecycleMode, MaybeSendFuture, NotificationContext,
    PeerRequestOptions, RequestContext, RunningService, ServiceError, serve_client_with_lifecycle,
};
use rmcp::transport::async_rw::AsyncRwTransport;
use rmcp::{ClientHandler, Peer, RoleClient};
use serde_json::{Map, Value, json};
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::{Spawner, wrap_child_command};
use tokio::process::Command;

use crate::mcp::client::prompts::PromptWatchers;
use crate::mcp::client::raw_copy::{INITIALIZE_METHOD, RawCopyTransport, RawLineTee, RawReplyCopy};
use crate::mcp::client::tasks::{McpTaskGeneration, TaskQuestionAnswer, TaskWatches};

/// The notification a 2025-11-25 server sends when a task's status changes.
const V1_TASK_STATUS_METHOD: &str = "notifications/tasks/status";

/// A tool server the daemon starts as a child and talks to over its standard input and output.
#[derive(Clone, Debug)]
pub(crate) struct McpStdioServer {
    /// The program.
    pub(crate) program: PathBuf,
    /// Its arguments.
    pub(crate) arguments: Vec<String>,
    /// The environment values its declaration holds, set over the daemon's own.
    pub(crate) environment: Vec<(String, String)>,
    /// The folder it starts in, where the declaration names one.
    pub(crate) working_folder: Option<PathBuf>,
}

/// Why a connection to a tool server could not be opened.
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpConnectionError {
    /// The server's process could not start, or its standard streams were not piped.
    #[error("the tool server's process could not start")]
    Start(#[source] io::Error),
    /// The server did not complete the lifecycle's start.
    #[error("the tool server did not complete its start")]
    Initialize(#[source] Box<ClientInitializeError>),
    /// The first read of its tools failed.
    #[error("the tool server's tools could not be read")]
    Tools(#[source] McpRequestError),
}

/// Why a request the client reads raw has no result.
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpRequestError {
    /// The request did not reach the server, or no answer came back.
    #[error("the request did not reach the tool server, or it did not answer")]
    Service(#[source] ServiceError),
    /// The server answered with a JSON-RPC error.
    #[error("the tool server refused the request with code {code}")]
    Refused {
        /// The error's code.
        code: i64,
        /// The error's own words.
        message: String,
    },
    /// The server's answer came back without its raw copy.
    #[error("the tool server's answer to {method} was not kept")]
    ReplyNotKept {
        /// The request's method.
        method: String,
    },
    /// The answer does not read as the result the request asks for.
    #[error("the tool server's answer to {method} does not read as its result")]
    Malformed {
        /// The request's method.
        method: &'static str,
    },
}

/// What a connection is: its session, its server's name and the shared watches its handler feeds.
#[derive(Clone)]
pub(crate) struct McpConnectionScope {
    /// The session the connection serves.
    pub(crate) session_id: SessionId,
    /// The server's name.
    pub(crate) server_name: McpServerName,
    /// The listeners of each session's prompts.
    pub(crate) prompt_watchers: Arc<PromptWatchers>,
    /// The tasks the connection follows.
    pub(crate) task_watches: Arc<TaskWatches>,
}

/// One open connection to a tool server.
pub(crate) struct McpServerConnection {
    pub(super) scope: McpConnectionScope,
    pub(super) service: RunningService<RoleClient, McpClientHandler>,
    pub(super) raw: RawReplyCopy,
    /// The Tasks protocol the server speaks, `None` when it offers no tasks.
    pub(super) task_generation: Option<McpTaskGeneration>,
    /// On a 2025-11-25 server, each tool whose `execution.taskSupport` takes a task.
    task_tools: Mutex<HashSet<String>>,
    /// Set when the server says its tools changed, so the next task call reads them again.
    are_tools_stale: Arc<AtomicBool>,
    /// The server's process, for a stdio server; killed when the connection drops.
    _child: Option<Box<dyn ChildWrapper>>,
}

impl McpServerConnection {
    /// Starts `server` on `spawner`'s thread and opens a connection over its standard streams,
    /// its output teed into the raw copy. Fails when the process cannot start or the server does
    /// not complete its start or its first tools read.
    #[expect(
        dead_code,
        reason = "the session's tool-server connections, which the tool-server units open, start \
                  a stdio server through it"
    )]
    pub(crate) async fn start_stdio(
        spawner: &Spawner,
        server: McpStdioServer,
        scope: McpConnectionScope,
    ) -> Result<Self, McpConnectionError> {
        let mut command = Command::new(&server.program);
        command
            .args(&server.arguments)
            .envs(server.environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(working_folder) = &server.working_folder {
            command.current_dir(working_folder);
        }
        let daemon_pid = std::process::id();
        let mut child = spawner
            .run(move || wrap_child_command(command, daemon_pid).spawn())
            .await
            .and_then(|spawned| spawned)
            .map_err(McpConnectionError::Start)?;
        let (Some(output), Some(input)) = (
            child.inner_mut().stdout().take(),
            child.inner_mut().stdin().take(),
        ) else {
            return Err(McpConnectionError::Start(io::Error::other(
                "the tool server's standard streams were not piped",
            )));
        };
        let raw = RawReplyCopy::default();
        let transport = AsyncRwTransport::new_client(RawLineTee::new(output, raw.clone()), input);
        Self::open(transport, raw, scope, Some(child)).await
    }

    /// Opens a connection over `transport`, whose replies already feed `raw`, holding `child`
    /// for its life. Fails as [`Self::start_stdio`] says.
    pub(super) async fn open<T>(
        transport: T,
        raw: RawReplyCopy,
        scope: McpConnectionScope,
        child: Option<Box<dyn ChildWrapper>>,
    ) -> Result<Self, McpConnectionError>
    where
        T: rmcp::transport::Transport<RoleClient> + 'static,
    {
        let are_tools_stale = Arc::new(AtomicBool::new(false));
        let handler = McpClientHandler {
            scope: scope.clone(),
            are_tools_stale: Arc::clone(&are_tools_stale),
        };
        let service = serve_client_with_lifecycle(
            handler,
            RawCopyTransport {
                inner: transport,
                raw: raw.clone(),
            },
            ClientLifecycleMode::Auto {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
                legacy_version: Some(ProtocolVersion::V_2025_11_25),
            },
        )
        .await
        .map_err(|error| McpConnectionError::Initialize(Box::new(error)))?;
        let initialize = raw.take_reply_to(INITIALIZE_METHOD);
        let declares_v1_tasks = initialize
            .as_ref()
            .and_then(|reply| reply.pointer("/result/capabilities/tasks/requests/tools/call"))
            .is_some();
        let declares_v2_tasks = service
            .peer()
            .peer_info()
            .is_some_and(|info| info.capabilities.supports_tasks());
        let task_generation = if declares_v2_tasks {
            Some(McpTaskGeneration::V2)
        } else if declares_v1_tasks {
            Some(McpTaskGeneration::V1)
        } else {
            None
        };
        let connection = Self {
            scope,
            service,
            raw,
            task_generation,
            task_tools: Mutex::new(HashSet::new()),
            are_tools_stale,
            _child: child,
        };
        if task_generation == Some(McpTaskGeneration::V1) {
            connection
                .read_task_tools()
                .await
                .map_err(McpConnectionError::Tools)?;
        }
        Ok(connection)
    }

    /// The peer the connection's typed requests go through.
    pub(super) fn peer(&self) -> &Peer<RoleClient> {
        self.service.peer()
    }

    /// Whether `tool_name` takes a task on this 2025-11-25 server, its tools read again first
    /// when the server said they changed. Fails as that read fails.
    pub(super) async fn is_task_tool(&self, tool_name: &str) -> Result<bool, McpRequestError> {
        if self.are_tools_stale.swap(false, Ordering::AcqRel) {
            self.read_task_tools().await?;
        }
        Ok(lock(&self.task_tools).contains(tool_name))
    }

    /// Re-reads, page by page from the raw `tools/list` replies, which tools take a task: those
    /// whose `execution.taskSupport` is `required` or `optional`. Fails as a page's request fails.
    pub(super) async fn read_task_tools(&self) -> Result<(), McpRequestError> {
        let mut task_tools = HashSet::new();
        let mut cursor: Option<String> = None;
        loop {
            let params = cursor.map(|cursor| json!({ "cursor": cursor }));
            let page = self.send_raw("tools/list", params).await?;
            let tools =
                page.get("tools")
                    .and_then(Value::as_array)
                    .ok_or(McpRequestError::Malformed {
                        method: "tools/list",
                    })?;
            task_tools.extend(tools.iter().filter_map(|tool| {
                let support = tool.pointer("/execution/taskSupport")?.as_str()?;
                matches!(support, "required" | "optional")
                    .then(|| tool.get("name")?.as_str().map(str::to_owned))?
            }));
            cursor = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        *lock(&self.task_tools) = task_tools;
        Ok(())
    }

    /// Sends `method` as the client's own request and reads its result from the raw copy, never
    /// from rmcp's typed result. Fails when it does not reach the server or come back, when the
    /// server answers an error, or when the answer was not kept.
    pub(super) async fn send_raw(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Map<String, Value>, McpRequestError> {
        let handle = self
            .peer()
            .send_request_with_option(
                ClientRequest::CustomRequest(CustomRequest::new(method, params)),
                PeerRequestOptions::no_options(),
            )
            .await
            .map_err(McpRequestError::Service)?;
        let id: RequestId = handle.id.clone();
        let answered = handle.await_response().await;
        let kept = self.raw.take(&id);
        match (answered, kept) {
            (Err(ServiceError::McpError(_)) | Ok(_), Some(reply)) => read_raw_result(method, reply),
            (Err(error), _) => Err(McpRequestError::Service(error)),
            (Ok(_), None) => Err(McpRequestError::ReplyNotKept {
                method: method.to_owned(),
            }),
        }
    }
}

/// The result of a kept reply, or the server's error.
fn read_raw_result(method: &str, reply: Value) -> Result<Map<String, Value>, McpRequestError> {
    let Value::Object(mut reply) = reply else {
        return Err(McpRequestError::ReplyNotKept {
            method: method.to_owned(),
        });
    };
    if let Some(error) = reply.remove("error") {
        return Err(McpRequestError::Refused {
            code: error
                .get("code")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        });
    }
    match reply.remove("result") {
        Some(Value::Object(result)) => Ok(result),
        Some(_) | None => Err(McpRequestError::ReplyNotKept {
            method: method.to_owned(),
        }),
    }
}

/// The client's side of a connection: what it declares, and the server's requests and
/// notifications it takes.
pub(crate) struct McpClientHandler {
    scope: McpConnectionScope,
    are_tools_stale: Arc<AtomicBool>,
}

impl ClientHandler for McpClientHandler {
    fn get_info(&self) -> InitializeRequestParams {
        InitializeRequestParams::new(
            ClientCapabilities::builder()
                .enable_elicitation()
                .enable_tasks()
                .build(),
            Implementation::new("sidekicks-daemon", env!("CARGO_PKG_VERSION")),
        )
    }

    async fn create_elicitation(
        &self,
        request: ElicitRequestParams,
        _context: RequestContext<RoleClient>,
    ) -> Result<ElicitResult, ErrorData> {
        let params = serde_json::to_value(&request)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let related_task = params
            .pointer("/_meta/io.modelcontextprotocol~1related-task/taskId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let Some(task_id) = related_task else {
            tracing::warn!(
                server = self.scope.server_name.as_str(),
                "a tool server asked for input outside a task the client follows; declined"
            );
            return Ok(ElicitResult::new(ElicitationAction::Decline));
        };
        let asked = self
            .scope
            .task_watches
            .ask_v1_task_question(&self.scope, &task_id, params)
            .await;
        Ok(match asked {
            Some(TaskQuestionAnswer::Answered(content)) => {
                let mut answer = ElicitResult::new(ElicitationAction::Accept);
                answer.content = Some(Value::Object(content));
                answer
            }
            Some(TaskQuestionAnswer::Withdrawn) => ElicitResult::new(ElicitationAction::Cancel),
            None => {
                tracing::warn!(
                    server = self.scope.server_name.as_str(),
                    "a tool server asked for input for a task the client does not follow; declined"
                );
                ElicitResult::new(ElicitationAction::Decline)
            }
        })
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
        self.scope.task_watches.wake(&params.task.task.task_id);
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
            self.scope.task_watches.wake(task_id);
        }
        std::future::ready(())
    }
}

// No holder awaits or panics while it changes the set, so a poisoned lock still guards a whole
// set.
fn lock(task_tools: &Mutex<HashSet<String>>) -> MutexGuard<'_, HashSet<String>> {
    task_tools.lock().unwrap_or_else(PoisonError::into_inner)
}
