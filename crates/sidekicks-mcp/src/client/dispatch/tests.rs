use std::sync::Arc;

use serde_json::{Value, json};
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use tokio::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

use super::{McpCallCompletionError, McpToolDispatch, McpToolDispatchError};
use crate::client::McpClient;
use crate::client::connection::standing::McpStandingConnection;
use crate::client::tasks::McpToolCallEnd;
use crate::client::tasks::recorder::McpTaskHandleRecorder;
use crate::client::test_server::{
    Reply, Responder, TestServer, contact, method_not_found, start_test_server, test_client,
    text_result, track_call, tracked_end, v1_initialize_result, v1_status_reply, v1_task,
};
use crate::command_receipts::CommandReceiptStore;
use crate::schema::schema_parts;

/// How long [`until`] waits for its condition before it fails the test.
const UNTIL_LIMIT: Duration = Duration::from_secs(120);

/// A receipt row as stored: its status, whether it was claimed and ended, and its four task
/// columns.
#[derive(Debug, PartialEq, Eq)]
struct StoredReceipt {
    status: String,
    is_started: bool,
    is_completed: bool,
    task: [Option<String>; 4],
}

/// A dispatch over a fresh database, its client, and a session with the server name `tracker`.
struct Fixture {
    database: TestDatabase,
    dispatch: McpToolDispatch,
    client: McpClient,
    session_id: SessionId,
    name: McpServerName,
}

impl Fixture {
    async fn new() -> Self {
        let database = TestDatabase::new(schema_parts());
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let dispatch = McpToolDispatch::new(
            CommandReceiptStore::new(Arc::clone(&writer)),
            McpTaskHandleRecorder::new(writer),
        );
        let (client, _card) = test_client();
        Self {
            database,
            dispatch,
            client,
            session_id: SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id"),
            name: FreeFormText::new("tracker".to_owned()).expect("a short server name"),
        }
    }

    /// Connects the session to a server answering through `responder`, and returns the session's
    /// standing connection to it.
    async fn connect(&self, responder: Responder) -> (McpStandingConnection, TestServer) {
        let (opened, server) = start_test_server(
            self.client
                .connection_scope(self.session_id, self.name.clone()),
            responder,
            None,
        )
        .await;
        self.client
            .add_connection(opened.expect("the test server completes its start"))
            .await;
        (
            self.client.standing_connection(self.session_id, &self.name),
            server,
        )
    }

    /// Every receipt row.
    fn receipts(&self) -> Vec<StoredReceipt> {
        let reader = self.database.reader();
        let mut statement = reader
            .prepare(
                "SELECT status, started_at IS NOT NULL, completed_at IS NOT NULL, mcp_task_id, \
                 mcp_task_generation, mcp_server_name, mcp_server_endpoint FROM command_receipts",
            )
            .expect("the receipts statement prepares");
        statement
            .query_map([], |row| {
                Ok(StoredReceipt {
                    status: row.get(0)?,
                    is_started: row.get(1)?,
                    is_completed: row.get(2)?,
                    task: [row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?],
                })
            })
            .expect("the receipts read")
            .collect::<Result<_, _>>()
            .expect("each receipt reads")
    }
}

/// A claimed receipt at `status`, ended or not, holding no task.
fn receipt_without_task(status: &str, is_completed: bool) -> StoredReceipt {
    StoredReceipt {
        status: status.to_owned(),
        is_started: true,
        is_completed,
        task: [None, None, None, None],
    }
}

/// A 2025-11-25 server whose `track` tool runs only as task `task-1`, accepted at once; every
/// other task method, and `tools/list` after the one read at the start, is answered through
/// `task_reply` with the method and how many of it came before.
fn task_server(mut task_reply: impl FnMut(&str, usize) -> Reply + Send + 'static) -> Responder {
    tools_server(
        json!({ "taskSupport": "required" }),
        move |method, earlier| match method {
            "tools/call" => Reply::Answer(json!({ "result": { "task": v1_task("working") } })),
            _ => task_reply(method, earlier),
        },
    )
}

/// A 2025-11-25 server whose `track` tool runs as a plain call, whose `tools/call` is never
/// answered.
fn silent_call_server() -> Responder {
    tools_server(json!({ "taskSupport": "forbidden" }), |_, _| Reply::Silent)
}

/// A 2025-11-25 server listing the one tool `track`, with `execution`, at its start; every later
/// request but `initialize` is answered through `reply` with the method and how many of it came
/// before.
fn tools_server(
    execution: Value,
    mut reply: impl FnMut(&str, usize) -> Reply + Send + 'static,
) -> Responder {
    let mut counts = std::collections::HashMap::<String, usize>::new();
    Box::new(move |method, _params| {
        let earlier = counts.entry(method.to_owned()).or_default();
        let count = *earlier;
        *earlier += 1;
        match method {
            "initialize" => Reply::Answer(json!({ "result": v1_initialize_result() })),
            "tools/list" if count == 0 => Reply::Answer(json!({ "result": { "tools": [{
                "name": "track",
                "inputSchema": { "type": "object" },
                "execution": execution,
            }] } })),
            "tools/list" | "tools/call" | "tasks/get" | "tasks/result" | "tasks/cancel" => {
                reply(method, count)
            }
            _ => method_not_found(),
        }
    })
}

/// Waits, on the paused clock, until `condition` holds; fails the test after [`UNTIL_LIMIT`].
async fn until(mut condition: impl FnMut() -> bool) {
    let started = Instant::now();
    while !condition() {
        assert!(started.elapsed() < UNTIL_LIMIT, "the condition never held");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The ids of the requests the client told `server` it canceled.
fn canceled_requests(server: &TestServer) -> Vec<Value> {
    server
        .requests("notifications/cancelled")
        .into_iter()
        .map(|(_, message)| message["params"]["requestId"].clone())
        .collect()
}

/// The id of the one request of `method` `server` received.
fn request_id(server: &TestServer, method: &str) -> Value {
    let requests = server.requests(method);
    assert_eq!(requests.len(), 1, "one {method} reached the server");
    requests[0].1["id"].clone()
}

// T2. Mutations: in `call_task_tool`, observe the acceptance after the follow; or never write the
// end in `complete`.
#[tokio::test(start_paused = true)]
async fn a_task_is_stored_on_its_receipt_before_its_first_poll_and_completes_inline() {
    let fixture = Fixture::new().await;
    let (standing, server) = fixture
        .connect(task_server(|method, earlier| match (method, earlier) {
            ("tasks/get", 0) => Reply::Silent,
            ("tasks/get", _) => v1_status_reply("completed"),
            ("tasks/result", _) => Reply::Answer(json!({ "result": text_result("tracked") })),
            _ => method_not_found(),
        }))
        .await;
    let contact = contact();
    let uncanceled = CancellationToken::new();

    let (dispatched, at_first_poll) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            until(|| server.requests("tasks/get").len() == 1).await;
            fixture.receipts()
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    let stored_task = ["task-1", "v1", "tracker", "stdio"].map(|column| Some(column.to_owned()));
    let [polled] = <[_; 1]>::try_from(at_first_poll).expect("one receipt");
    assert_eq!(
        (polled.status.as_str(), polled.is_completed, &polled.task),
        ("accepted", false, &stored_task),
        "the task is stored before its first poll"
    );
    assert_eq!(end.expect("the call ends"), tracked_end());
    written.expect("the end is written");
    assert_eq!(
        fixture.receipts(),
        [StoredReceipt {
            status: "completed".to_owned(),
            is_started: true,
            is_completed: true,
            task: stored_task,
        }]
    );
}

// T3. Mutations: send the call before the receipt's write; or store a handle before the server
// names one.
#[tokio::test(start_paused = true)]
async fn a_call_dropped_unanswered_leaves_its_receipt_claimed_without_a_task() {
    let fixture = Fixture::new().await;
    let (standing, server) = fixture
        .connect(tools_server(
            json!({ "taskSupport": "required" }),
            |_, _| Reply::Silent,
        ))
        .await;
    let contact = contact();
    let uncanceled = CancellationToken::new();

    tokio::select! {
        _ = fixture.dispatch.call(&standing, track_call(), &contact, &uncanceled) => {
            panic!("an unanswered call does not end");
        }
        () = until(|| server.requests("tools/call").len() == 1) => {}
    }

    assert_eq!(
        fixture.receipts(),
        [receipt_without_task("accepted", false)]
    );
}

// T5, a plain call canceled. Mutation: leave the call's await unraced against `cancellation`;
// the call then waits out its idle window and ends with its timeout.
#[tokio::test(start_paused = true)]
async fn a_plain_call_canceled_before_its_answer_ends_canceled_with_its_end_unknown() {
    let fixture = Fixture::new().await;
    let (standing, server) = fixture.connect(silent_call_server()).await;
    let contact = contact();
    let cancellation = CancellationToken::new();

    let (dispatched, ()) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &cancellation),
        async {
            until(|| server.requests("tools/call").len() == 1).await;
            cancellation.cancel();
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;
    until(|| !canceled_requests(&server).is_empty()).await;

    assert_eq!(end.expect("the call ends"), McpToolCallEnd::Canceled);
    written.expect("the caller writes the end");
    assert_eq!(fixture.receipts(), [receipt_without_task("unknown", true)]);
    assert_eq!(
        canceled_requests(&server),
        [request_id(&server, "tools/call")]
    );
}

// T5, a plain call cut by the session's close. Mutation: leave the call's await unraced against
// the closed mark; the close then waits for the call's 30-minute idle window.
#[tokio::test(start_paused = true)]
async fn a_plain_call_cut_by_its_sessions_close_is_written_unknown_at_once() {
    let fixture = Fixture::new().await;
    let (standing, server) = fixture.connect(silent_call_server()).await;
    let contact = contact();
    let uncanceled = CancellationToken::new();
    let started = Instant::now();

    let (dispatched, closed_after) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            until(|| server.requests("tools/call").len() == 1).await;
            fixture.client.close_session(fixture.session_id).await;
            started.elapsed()
        },
    );
    let stored = fixture.receipts();
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;
    until(|| !canceled_requests(&server).is_empty()).await;

    assert!(
        closed_after < Duration::from_secs(60),
        "the close waits for no answer: {closed_after:?}"
    );
    assert_eq!(stored, [receipt_without_task("unknown", true)]);
    assert_eq!(end.expect("the call ends"), McpToolCallEnd::Canceled);
    assert!(matches!(written, Err(McpCallCompletionError::Settled)));
    assert_eq!(
        canceled_requests(&server),
        [request_id(&server, "tools/call")]
    );
}

// T5, a closing session's task. Mutations: close the connection before the cancel, as a close
// that does not wait for the dispatch would; or write the 2025-11-25 ack as anything but `failed`.
#[tokio::test(start_paused = true)]
async fn a_closing_sessions_task_is_canceled_before_its_connection_closes() {
    let fixture = Fixture::new().await;
    let (standing, server) = fixture
        .connect(task_server(|method, _| match method {
            "tasks/get" => v1_status_reply("working"),
            "tasks/cancel" => v1_status_reply("cancelled"),
            _ => method_not_found(),
        }))
        .await;
    let contact = contact();
    let uncanceled = CancellationToken::new();

    let (dispatched, ()) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            until(|| !server.requests("tasks/get").is_empty()).await;
            fixture.client.close_session(fixture.session_id).await;
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    assert_eq!(server.requests("tasks/cancel").len(), 1);
    assert_eq!(end.expect("the call ends"), McpToolCallEnd::Canceled);
    assert!(matches!(written, Err(McpCallCompletionError::Settled)));
    let [stored] = <[_; 1]>::try_from(fixture.receipts()).expect("one receipt");
    assert_eq!(
        (stored.status.as_str(), stored.is_completed),
        ("failed", true)
    );
}

// T5, a closing session's task that ended meanwhile. Mutation: write `unknown` on the cancel's
// `-32602` without reading the task.
#[tokio::test(start_paused = true)]
async fn a_closing_sessions_task_that_ended_meanwhile_is_read_once_for_its_result() {
    let fixture = Fixture::new().await;
    let mut is_cancel_sent = false;
    let (standing, server) = fixture
        .connect(task_server(move |method, _| match method {
            "tasks/get" if is_cancel_sent => v1_status_reply("completed"),
            "tasks/get" => v1_status_reply("working"),
            "tasks/cancel" => {
                is_cancel_sent = true;
                Reply::Answer(json!({ "error": { "code": -32602, "message": "task ended" } }))
            }
            "tasks/result" => Reply::Answer(json!({ "result": text_result("tracked") })),
            _ => method_not_found(),
        }))
        .await;
    let contact = contact();
    let uncanceled = CancellationToken::new();

    let (dispatched, ()) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            until(|| !server.requests("tasks/get").is_empty()).await;
            fixture.client.close_session(fixture.session_id).await;
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    let received = server
        .received
        .lock()
        .expect("the test's record is never poisoned")
        .iter()
        .map(|(_, message)| message["method"].clone())
        .collect::<Vec<_>>();
    let cancel_position = received
        .iter()
        .position(|method| method == "tasks/cancel")
        .expect("the cancel reached the server");
    let polls_after_cancel = received[cancel_position..]
        .iter()
        .filter(|method| *method == "tasks/get")
        .count();
    assert_eq!(
        polls_after_cancel, 1,
        "one read follows the rejected cancel"
    );
    assert_eq!(server.requests("tasks/result").len(), 1);
    assert_eq!(end.expect("the call ends"), tracked_end());
    assert!(matches!(written, Err(McpCallCompletionError::Settled)));
    let [stored] = <[_; 1]>::try_from(fixture.receipts()).expect("one receipt");
    assert_eq!(
        (stored.status.as_str(), stored.is_completed),
        ("completed", true)
    );
}

// T5, a call after the close. Mutation: leave the closed mark unread before the call; the call
// then finds no live connection and fails `NotConnected`.
#[tokio::test(start_paused = true)]
async fn a_call_after_its_sessions_close_sends_and_writes_nothing() {
    let fixture = Fixture::new().await;
    let (standing, server) = fixture
        .connect(task_server(|_, _| method_not_found()))
        .await;
    fixture.client.close_session(fixture.session_id).await;

    let dispatched = fixture
        .dispatch
        .call(
            &standing,
            track_call(),
            &contact(),
            &CancellationToken::new(),
        )
        .await;

    assert!(matches!(
        dispatched,
        Err(McpToolDispatchError::SessionClosed)
    ));
    assert_eq!(
        server.requests("tools/list").len(),
        1,
        "only the start's read"
    );
    assert_eq!(server.requests("tools/call").len(), 0);
    assert_eq!(fixture.receipts(), []);
}

// T5, a close during the tools read. Mutations: leave the tools read unraced against the closed
// mark, or read the marks only before it; the read then waits out its 60 s and fails, and the
// close waits for it.
#[tokio::test(start_paused = true)]
async fn a_call_whose_session_closes_during_its_tools_read_sends_no_call() {
    let fixture = Fixture::new().await;
    let (standing, server) = fixture.connect(task_server(|_, _| Reply::Silent)).await;
    mark_tools_changed(&server).await;
    let contact = contact();
    let uncanceled = CancellationToken::new();

    let (dispatched, ()) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            until(|| server.requests("tools/list").len() == 2).await;
            fixture.client.close_session(fixture.session_id).await;
        },
    );

    assert!(matches!(
        dispatched,
        Err(McpToolDispatchError::SessionClosed)
    ));
    assert_eq!(server.requests("tools/call").len(), 0);
    assert_eq!(fixture.receipts(), []);
}

// A tools read the caller stops waiting for. Mutation: leave the tools marked read when their read
// is dropped; the next task call then trusts the tools it read before the change.
#[tokio::test(start_paused = true)]
async fn a_call_canceled_during_its_tools_read_leaves_the_tools_to_read_again() {
    let fixture = Fixture::new().await;
    let (standing, server) = fixture
        .connect(task_server(|method, earlier| match (method, earlier) {
            ("tools/list", 1) => Reply::Silent,
            ("tools/list", _) => Reply::Answer(json!({ "result": { "tools": [] } })),
            _ => method_not_found(),
        }))
        .await;
    mark_tools_changed(&server).await;
    let contact = contact();
    let cancellation = CancellationToken::new();

    let (dispatched, ()) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &cancellation),
        async {
            until(|| server.requests("tools/list").len() == 2).await;
            cancellation.cancel();
        },
    );
    let is_task_tool = standing
        .current()
        .expect("the connection is live")
        .is_task_tool("track")
        .await
        .expect("the tools read");

    assert!(matches!(dispatched, Err(McpToolDispatchError::Canceled)));
    assert_eq!(server.requests("tools/list").len(), 3);
    assert!(!is_task_tool, "the tools read again list no `track`");
    assert_eq!(fixture.receipts(), []);
}

// T5, the client's stop. Mutation: write the session's close row under the stop.
#[tokio::test(start_paused = true)]
async fn a_task_cut_by_the_clients_stop_leaves_its_receipt_in_flight() {
    let fixture = Fixture::new().await;
    let (standing, server) = fixture
        .connect(task_server(|method, _| match method {
            "tasks/get" => v1_status_reply("working"),
            "tasks/cancel" => v1_status_reply("cancelled"),
            _ => method_not_found(),
        }))
        .await;
    let contact = contact();
    let uncanceled = CancellationToken::new();

    let (dispatched, ()) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            until(|| !server.requests("tasks/get").is_empty()).await;
            fixture.client.stop().await;
        },
    );

    assert!(matches!(
        dispatched,
        Err(McpToolDispatchError::ClientStopping)
    ));
    let [stored] = <[_; 1]>::try_from(fixture.receipts()).expect("one receipt");
    assert_eq!(
        (
            stored.status.as_str(),
            stored.is_started,
            stored.is_completed
        ),
        ("accepted", true, false)
    );
}

/// Tells the client its server's tools changed, and lets it read the notification.
async fn mark_tools_changed(server: &TestServer) {
    server
        .unasked
        .send(json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }).to_string())
        .expect("the server writes");
    tokio::time::sleep(Duration::from_millis(10)).await;
}
