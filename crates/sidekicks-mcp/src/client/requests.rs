//! A connection's own requests to its server, each bounded in time: an ordinary request waits 60 s
//! through rmcp's request options; a tool call that may run long waits out the connection's idle
//! window, which the daemon keeps, within one total bound rmcp keeps; and a task's result held
//! while the task waits on the person waits within that total bound alone. A request whose bound
//! runs out, or whose caller stops waiting, tells the server it is canceled, and its raw reply,
//! should one still come, is dropped.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use rmcp::model::{
    CallToolRequest, CallToolRequestParams, CallToolResponse, CancelTaskParams, CancelTaskRequest,
    CancelledNotificationParam, ClientRequest, CustomRequest, GetTaskParams, GetTaskRequest,
    GetTaskResult, ListPromptsRequest, PaginatedRequestParams, Prompt, RequestId, ServerResult,
    UpdateTaskParams, UpdateTaskRequest,
};
use rmcp::service::{PeerRequestOptions, ServiceError};
use rmcp::{Peer, RoleClient};
use serde_json::{Map, Value};

use crate::client::idle_window::ToolCallActivity;
use crate::client::raw_copy::RawReplyCopy;

/// How long an ordinary request waits for its answer (the TypeScript SDK's default).
pub(super) const ORDINARY_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// How long a tool call on a stdio server may go without an answer or a progress notification,
/// counted only while no question on the connection is open.
pub(super) const STDIO_TOOL_CALL_IDLE_TIMEOUT: Duration = Duration::from_mins(30);

/// How long a tool call on a server at an address may go without an answer or a progress
/// notification, counted only while no question on the connection is open.
pub(super) const HTTP_TOOL_CALL_IDLE_TIMEOUT: Duration = Duration::from_mins(5);

/// The longest a tool call may run however often it reports progress, 100,000,000 ms, Claude
/// Code's own bound, so no call Claude Code allows fails here.
const TOOL_CALL_MAX_TOTAL_TIMEOUT: Duration = Duration::from_secs(100_000);

/// The most pages one list is read to, the cap on a server whose list never ends: past it, the
/// list is what the pages read so far hold. rmcp's own list helpers have no such bound.
pub(super) const MAX_LIST_PAGES: usize = 100;

/// The cursors one paged list was read at: a list stops at its last page, at a cursor it was
/// already read at, or at [`MAX_LIST_PAGES`].
#[derive(Default)]
pub(super) struct PageCursors {
    seen: HashSet<String>,
    pages: usize,
}

impl PageCursors {
    /// The cursor to read the page after one whose `nextCursor` is `next` at; `None` once the
    /// list ends, repeats a cursor or reaches the page cap, the last two logged.
    pub(super) fn follow(&mut self, method: &str, next: Option<String>) -> Option<String> {
        self.pages += 1;
        let cursor = next?;
        if self.pages >= MAX_LIST_PAGES {
            tracing::warn!(
                method,
                "a tool server's list ran past the page cap; read so far kept"
            );
            return None;
        }
        if !self.seen.insert(cursor.clone()) {
            tracing::warn!(
                method,
                "a tool server's list repeated a cursor; read so far kept"
            );
            return None;
        }
        Some(cursor)
    }
}

/// How long a request may wait for its answer.
#[derive(Clone, Copy, Debug)]
pub(super) enum RequestWait {
    /// An ordinary request: 60 s.
    Ordinary,
    /// A tool call: the connection's idle window, which progress on the call starts again and an
    /// open question holds still, within the total bound.
    ToolCall,
    /// A task's result held while the task waits on the person: the total bound alone, since the
    /// person may take longer than any idle window and the task's polls show the server answers.
    HeldResult,
}

/// Why a request the client reads raw has no result.
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpRequestError {
    /// The request did not reach the server, or no answer came back in time.
    #[error("the request did not reach the tool server, or it did not answer")]
    Service(#[source] ServiceError),
    /// The server answered with a JSON-RPC error.
    #[error("the tool server refused the request with code {code}")]
    Refused {
        /// The error's code.
        code: i64,
        /// The whole error object as the server sent it: its code, message and any data.
        error: Map<String, Value>,
    },
    /// The server's answer came back without its raw copy.
    #[error("the tool server's answer to {method} was not kept")]
    ReplyNotKept {
        /// The request's method.
        method: String,
    },
    /// The answer does not read as the result the request asks for, or as a JSON-RPC error.
    #[error("the tool server's answer to {method} does not read as its result")]
    Malformed {
        /// The request's method.
        method: String,
    },
}

/// The requests one connection sends its server, through its peer, its raw copy and its tool
/// calls' idle window and activity.
#[derive(Clone)]
pub(super) struct ServerRequests {
    pub(super) peer: Peer<RoleClient>,
    pub(super) raw: RawReplyCopy,
    pub(super) tool_call_idle_timeout: Duration,
    pub(super) activity: Arc<ToolCallActivity>,
}

/// A request sent and not yet answered: dropped before its answer, it tells the server the request
/// is canceled; dropped at all, it drops the request's raw reply, so a late one is never kept.
struct PendingRequest<'requests> {
    requests: &'requests ServerRequests,
    id: RequestId,
    is_answered: bool,
}

impl Drop for PendingRequest<'_> {
    fn drop(&mut self) {
        self.requests.raw.take(&self.id);
        if self.is_answered {
            return;
        }
        let peer = self.requests.peer.clone();
        let id = self.id.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let canceled = CancelledNotificationParam::new(
                    Some(id),
                    Some("the client stopped waiting".to_owned()),
                );
                if let Err(error) = peer.notify_cancelled(canceled).await {
                    tracing::debug!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "a tool server was not told a request was canceled"
                    );
                }
            });
        }
    }
}

impl ServerRequests {
    fn request_options(wait: RequestWait) -> PeerRequestOptions {
        match wait {
            RequestWait::Ordinary => PeerRequestOptions::with_timeout(ORDINARY_REQUEST_TIMEOUT),
            RequestWait::ToolCall | RequestWait::HeldResult => {
                PeerRequestOptions::no_options().with_max_total_timeout(TOOL_CALL_MAX_TOTAL_TIMEOUT)
            }
        }
    }

    /// Sends `request` and waits for its answer within `wait`'s bound, returning the request's id
    /// beside the answer; a tool call also within the connection's idle window, failing
    /// [`ServiceError::Timeout`] once it runs out. Fails when it does not reach the server or no
    /// answer comes in time.
    async fn send_bounded<T>(
        &self,
        request: ClientRequest,
        wait: RequestWait,
        read: impl FnOnce(&RequestId, Result<ServerResult, ServiceError>) -> T,
    ) -> Result<T, ServiceError> {
        let handle = self
            .peer
            .send_request_with_option(request, Self::request_options(wait))
            .await?;
        let mut pending = PendingRequest {
            requests: self,
            id: handle.id.clone(),
            is_answered: false,
        };
        let answered = match wait {
            RequestWait::ToolCall => {
                let progress = self.activity.watch_progress(handle.progress_token.clone());
                tokio::select! {
                    answered = handle.await_response() => answered,
                    () = self.activity.idle_out(&progress, self.tool_call_idle_timeout) => {
                        // Dropped unanswered, the pending request tells the server it is canceled.
                        return Err(ServiceError::Timeout {
                            timeout: self.tool_call_idle_timeout,
                        });
                    }
                }
            }
            RequestWait::Ordinary | RequestWait::HeldResult => handle.await_response().await,
        };
        pending.is_answered = true;
        Ok(read(&pending.id, answered))
    }

    /// Sends `request` through rmcp's types within `wait`'s bound. Fails as
    /// [`Self::send_bounded`] does, or with the server's error.
    async fn send_request(
        &self,
        request: ClientRequest,
        wait: RequestWait,
    ) -> Result<ServerResult, ServiceError> {
        self.send_bounded(request, wait, |_, answered| answered)
            .await?
    }

    /// Sends `method` as the client's own request within `wait`'s bound and reads its result from
    /// the raw copy, never from rmcp's typed result. Fails when it does not reach the server or
    /// come back in time, when the server answers an error, or when the answer was not kept.
    pub(super) async fn send_raw(
        &self,
        method: &str,
        params: Option<Value>,
        wait: RequestWait,
    ) -> Result<Map<String, Value>, McpRequestError> {
        let request = ClientRequest::CustomRequest(CustomRequest::new(method, params));
        let read = self
            .send_bounded(request, wait, |id, answered| (answered, self.raw.take(id)))
            .await;
        match read.map_err(McpRequestError::Service)? {
            (Err(ServiceError::McpError(_)) | Ok(_), Some(reply)) => read_raw_result(method, reply),
            (Err(error), _) => Err(McpRequestError::Service(error)),
            (Ok(_), None) => Err(McpRequestError::ReplyNotKept {
                method: method.to_owned(),
            }),
        }
    }

    /// One `tools/call` round: a result, a task, or the server's request for input. Fails as the
    /// request fails, or when the server answers another request's result.
    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "rmcp's result union is open, so every other result is named by the wildcard"
    )]
    pub(super) async fn call_tool_once(
        &self,
        params: CallToolRequestParams,
    ) -> Result<CallToolResponse, ServiceError> {
        let request = ClientRequest::CallToolRequest(CallToolRequest::new(params));
        match self.send_request(request, RequestWait::ToolCall).await? {
            ServerResult::CallToolResult(result) => Ok(CallToolResponse::Complete(result)),
            ServerResult::InputRequiredResult(result) => {
                Ok(CallToolResponse::InputRequired(result))
            }
            ServerResult::CreateTaskResult(result) => Ok(CallToolResponse::Task(result)),
            _ => Err(ServiceError::UnexpectedResponse),
        }
    }

    /// A 2026-07-28 task's `tasks/get`. Fails as the request fails.
    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "rmcp's result union is open, so every other result is named by the wildcard"
    )]
    pub(super) async fn get_task(&self, mcp_task_id: &str) -> Result<GetTaskResult, ServiceError> {
        let request =
            ClientRequest::GetTaskRequest(GetTaskRequest::new(GetTaskParams::new(mcp_task_id)));
        match self.send_request(request, RequestWait::Ordinary).await? {
            ServerResult::GetTaskResult(result) => Ok(result),
            _ => Err(ServiceError::UnexpectedResponse),
        }
    }

    /// A 2026-07-28 task's `tasks/update`, carrying answers to its input requests. Fails as the
    /// request fails.
    pub(super) async fn update_task(&self, params: UpdateTaskParams) -> Result<(), ServiceError> {
        let request = ClientRequest::UpdateTaskRequest(UpdateTaskRequest::new(params));
        read_task_ack(&self.send_request(request, RequestWait::Ordinary).await?)
    }

    /// A 2026-07-28 task's `tasks/cancel`. Fails as the request fails.
    pub(super) async fn cancel_v2_task(&self, mcp_task_id: &str) -> Result<(), ServiceError> {
        let request = ClientRequest::CancelTaskRequest(CancelTaskRequest::new(
            CancelTaskParams::new(mcp_task_id),
        ));
        read_task_ack(&self.send_request(request, RequestWait::Ordinary).await?)
    }

    /// Every prompt the server lists, page by page, as [`PageCursors`] bounds the pages. Fails as a
    /// page's request fails.
    pub(super) async fn list_all_prompts(&self) -> Result<Vec<Prompt>, ServiceError> {
        let mut prompts = Vec::new();
        let mut cursors = PageCursors::default();
        let mut cursor = None;
        loop {
            let request = ClientRequest::ListPromptsRequest(ListPromptsRequest::with_param(
                PaginatedRequestParams::default().with_cursor(cursor),
            ));
            let ServerResult::ListPromptsResult(page) =
                self.send_request(request, RequestWait::Ordinary).await?
            else {
                return Err(ServiceError::UnexpectedResponse);
            };
            prompts.extend(page.prompts);
            cursor = cursors.follow("prompts/list", page.next_cursor);
            if cursor.is_none() {
                return Ok(prompts);
            }
        }
    }
}

/// A task request's acknowledgement.
#[expect(
    clippy::wildcard_enum_match_arm,
    reason = "rmcp's result union is open, so every other result is named by the wildcard"
)]
fn read_task_ack(result: &ServerResult) -> Result<(), ServiceError> {
    match result {
        ServerResult::TaskAckResult(_) | ServerResult::EmptyResult(_) => Ok(()),
        _ => Err(ServiceError::UnexpectedResponse),
    }
}

/// The result of a kept reply, or the server's error; an error object without an integer code is
/// malformed.
fn read_raw_result(method: &str, reply: Value) -> Result<Map<String, Value>, McpRequestError> {
    let Value::Object(mut reply) = reply else {
        return Err(McpRequestError::ReplyNotKept {
            method: method.to_owned(),
        });
    };
    if let Some(error) = reply.remove("error") {
        let (Some(code), Value::Object(error)) = (error.get("code").and_then(Value::as_i64), error)
        else {
            return Err(McpRequestError::Malformed {
                method: method.to_owned(),
            });
        };
        return Err(McpRequestError::Refused { code, error });
    }
    match reply.remove("result") {
        Some(Value::Object(result)) => Ok(result),
        Some(_) | None => Err(McpRequestError::ReplyNotKept {
            method: method.to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use rstest::rstest;
    use serde_json::json;
    use tokio::time::{Duration, timeout};

    use super::{MAX_LIST_PAGES, RequestWait};
    use crate::client::test_server::{
        Reply, method_not_found, open_test_server, test_client, v1_initialize_result,
    };

    // Mutations: in `PageCursors::follow`, leave out the repeated-cursor stop or the page cap,
    // and either list never ends and the test times out; or replace `extend` with assignment in
    // `list_all_prompts` or `read_task_tools`, which keeps only the last page read.
    #[rstest]
    #[case::a_repeated_cursor(false, 2)]
    #[case::a_list_that_never_ends(true, MAX_LIST_PAGES)]
    #[tokio::test(start_paused = true)]
    async fn a_paged_list_stops_at_a_repeated_cursor_or_the_page_cap_keeping_every_page_read(
        #[case] is_endless: bool,
        #[case] expected_pages: usize,
    ) {
        let (client, _card) = test_client();
        let mut pages: HashMap<String, usize> = HashMap::new();
        let (connection, server) = open_test_server(
            &client,
            Box::new(move |method, _params| {
                let page = pages.entry(method.to_owned()).or_default();
                *page += 1;
                let next_cursor = if is_endless {
                    format!("c{page}")
                } else {
                    "c".to_owned()
                };
                // Only the first page names a task tool; every page names a prompt of its own.
                let tools = if *page == 1 {
                    json!([{
                        "name": "track",
                        "inputSchema": { "type": "object" },
                        "execution": { "taskSupport": "required" },
                    }])
                } else {
                    json!([])
                };
                let prompts = json!([{ "name": format!("prompt-{page}") }]);
                match method {
                    "initialize" => Reply::Answer(json!({ "result": v1_initialize_result() })),
                    "tools/list" => Reply::Answer(
                        json!({ "result": { "tools": tools, "nextCursor": next_cursor } }),
                    ),
                    "prompts/list" => Reply::Answer(
                        json!({ "result": { "prompts": prompts, "nextCursor": next_cursor } }),
                    ),
                    _ => method_not_found(),
                }
            }),
        )
        .await;

        let prompts = timeout(
            Duration::from_secs(60),
            connection.requests.list_all_prompts(),
        )
        .await
        .expect("the prompts list ends")
        .expect("the prompts read");

        assert_eq!(server.requests("tools/list").len(), expected_pages);
        assert_eq!(server.requests("prompts/list").len(), expected_pages);
        assert_eq!(prompts.len(), expected_pages, "every page's prompt is kept");
        assert!(
            connection
                .is_task_tool("track")
                .await
                .expect("the tools are read"),
            "the first page's task tool is kept"
        );
    }

    // Mutation: in `PendingRequest::drop`, leave out `raw.take`; the request then stays awaited
    // and its late reply is kept with nobody to take it.
    #[tokio::test(start_paused = true)]
    async fn a_raw_request_its_caller_stopped_waiting_on_keeps_no_late_reply() {
        let (client, _card) = test_client();
        let (connection, server) = open_test_server(
            &client,
            Box::new(|method, _params| match method {
                "initialize" => Reply::Answer(json!({ "result": v1_initialize_result() })),
                "tools/list" => Reply::Answer(json!({ "result": { "tools": [] } })),
                "tasks/get" => Reply::Silent,
                _ => method_not_found(),
            }),
        )
        .await;

        let stopped = timeout(
            Duration::from_secs(1),
            connection.requests.send_raw(
                "tasks/get",
                Some(json!({ "taskId": "task-1" })),
                RequestWait::Ordinary,
            ),
        )
        .await;
        assert!(
            stopped.is_err(),
            "the caller stops waiting before an answer"
        );
        let id = server.requests("tasks/get")[0].1["id"].clone();
        server
            .unasked
            .send(
                json!({ "jsonrpc": "2.0", "id": id, "result": { "status": "working" } })
                    .to_string(),
            )
            .expect("the server is running");
        // The server writes in order, so once a later reply is read the late one has passed.
        connection
            .read_task_tools()
            .await
            .expect("the tools read after it");

        assert!(connection.requests.raw.is_empty());
    }
}
