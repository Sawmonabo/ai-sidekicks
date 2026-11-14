use std::sync::Arc;

use serde_json::{Value, json};
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::port::question::test_card::QuestionCard;
use sidekicks_store::database::statement::run_statement;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use tokio::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

use super::{McpCallCompletionError, McpToolDispatch, McpToolDispatchError};
use crate::client::McpClient;
use crate::client::connection::standing::McpStandingConnection;
use crate::client::connection::{McpConnectionStart, McpServerConnection};
use crate::client::tasks::McpTaskContact::{CancelRefused, Reached};
use crate::client::tasks::{
    McpServerEndpoint, McpTaskContact, McpTaskGeneration, McpTaskHandleObservation,
    McpTaskHandleSink as _, McpToolCallEnd,
};
use crate::client::test_server::{
    Reply, Responder, TestServer, contact, method_not_found, start_test_server, test_client,
    text_result, track_call, track_task_handle, tracked_end, v1_initialize_result, v1_status_reply,
    v1_task, wait_for_contact,
};
use crate::command_receipts::{InFlightReceipt, InFlightTask, background_statement};
use crate::schema::schema_parts;
use crate::sign_in::address_digest::ServerAddressDigest;

/// A receipt row as stored: its status, whether it was claimed and ended, and its four task
/// columns.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct StoredReceipt {
    pub(super) status: String,
    pub(super) is_started: bool,
    pub(super) is_completed: bool,
    pub(super) task: [Option<String>; 4],
}

/// A dispatch over a fresh database, its client with its questions card, and a session with the
/// server name `tracker`, whose connections reach a stdio server unless `address_digest` names
/// the keyed digest of the server's address.
pub(super) struct Fixture {
    pub(super) database: TestDatabase,
    pub(super) dispatch: Arc<McpToolDispatch>,
    pub(super) client: Arc<McpClient>,
    pub(super) card: Arc<QuestionCard>,
    pub(super) session_id: SessionId,
    pub(super) name: McpServerName,
    pub(super) address_digest: Option<ServerAddressDigest>,
}

impl Fixture {
    pub(super) async fn new() -> Self {
        let database = TestDatabase::new(schema_parts());
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let dispatch = Arc::new(McpToolDispatch::new(writer));
        let (client, card) = test_client();
        Self {
            database,
            dispatch,
            client: Arc::new(client),
            card,
            session_id: SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id"),
            name: FreeFormText::new("tracker".to_owned()).expect("a short server name"),
            address_digest: None,
        }
    }

    /// Opens a connection of the session to a server answering through `responder`, at the
    /// address `address_digest` names or a stdio server, without publishing it.
    pub(super) async fn open(
        &self,
        responder: Responder,
        address_digest: Option<&ServerAddressDigest>,
    ) -> (McpServerConnection, TestServer) {
        let start = address_digest.map_or_else(
            || McpConnectionStart::stdio(None, None),
            |digest| McpConnectionStart::http(None, Some(digest)),
        );
        let (opened, server) = start_test_server(
            self.client
                .connection_scope(self.session_id, self.name.clone()),
            responder,
            start,
        )
        .await;
        (opened.expect("the test server completes its start"), server)
    }

    /// Connects the session to a server answering through `responder`, publishing the connection
    /// in place of any before it as a Reconnect does, and returns the session's standing
    /// connection to it.
    pub(super) async fn connect(
        &self,
        responder: Responder,
    ) -> (McpStandingConnection, TestServer) {
        let (opened, server) = self.open(responder, self.address_digest.as_ref()).await;
        self.client.add_connection(opened).await;
        (
            self.client.standing_connection(self.session_id, &self.name),
            server,
        )
    }

    /// Moves the call of `command_id` to the background as the tool route does, through a
    /// connection of the test's own: awaiting the writer's thread would let the paused clock jump
    /// to the call's next timer meanwhile.
    pub(super) fn move_to_background(&self, command_id: &str) {
        let moved = run_statement(&self.database.reader(), &background_statement(command_id))
            .expect("the call moves to the background");
        assert_eq!(
            moved.row_count, 1,
            "one claimed receipt moves to the background"
        );
    }

    /// Every receipt row.
    pub(super) fn receipts(&self) -> Vec<StoredReceipt> {
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
pub(super) fn receipt_without_task(status: &str, is_completed: bool) -> StoredReceipt {
    StoredReceipt {
        status: status.to_owned(),
        is_started: true,
        is_completed,
        task: [None, None, None, None],
    }
}

/// The receipt a call of `track` left in flight across a restart: claimed, and holding task
/// `task-1` accepted under the generation on the tracker at the endpoint when `task` names them.
pub(super) async fn left_in_flight(
    fixture: &Fixture,
    task: Option<(McpTaskGeneration, McpServerEndpoint)>,
) -> InFlightReceipt {
    let call = track_call();
    let id = fixture
        .dispatch
        .receipts
        .accept_and_claim(
            &call.dispatch.command_id,
            call.run_id,
            &CancellationToken::new(),
        )
        .await
        .expect("the receipt is written");
    if let Some((mcp_task_generation, endpoint)) = &task {
        let observation = McpTaskHandleObservation {
            endpoint: endpoint.clone(),
            ..track_task_handle(*mcp_task_generation)
        };
        fixture.dispatch.recorder.record(observation).await;
    }
    let task = task.map(|(mcp_task_generation, endpoint)| InFlightTask {
        mcp_task_id: "task-1".to_owned(),
        mcp_task_generation,
        server_name: fixture.name.clone(),
        endpoint,
    });
    InFlightReceipt {
        id,
        command_id: call.dispatch.command_id,
        run_id: call.run_id,
        task,
        is_backgrounded: false,
    }
}

/// A 2025-11-25 server whose `track` tool runs only as task `task-1`, accepted at once; every
/// other task method, and `tools/list` after the one read at the start, is answered through
/// `task_reply` with the method and how many of it came before.
pub(super) fn task_server(
    mut task_reply: impl FnMut(&str, usize) -> Reply + Send + 'static,
) -> Responder {
    tools_server(
        v1_initialize_result(),
        json!({ "taskSupport": "required" }),
        move |method, earlier| match method {
            "tools/call" => Reply::Answer(json!({ "result": { "task": v1_task("working") } })),
            _ => task_reply(method, earlier),
        },
    )
}

/// A 2025-11-25 server whose `track` tool runs as a plain call, whose `tools/call` is never
/// answered.
pub(super) fn silent_call_server() -> Responder {
    tools_server(
        v1_initialize_result(),
        json!({ "taskSupport": "forbidden" }),
        |_, _| Reply::Silent,
    )
}

/// A 2025-11-25 server answering `initialize` with `initialize` and listing the one tool `track`,
/// with `execution`, at its start; every later request is answered through `reply` with the method
/// and how many of it came before.
pub(super) fn tools_server(
    initialize: Value,
    execution: Value,
    mut reply: impl FnMut(&str, usize) -> Reply + Send + 'static,
) -> Responder {
    let mut counts = std::collections::HashMap::<String, usize>::new();
    Box::new(move |method, _params| {
        let earlier = counts.entry(method.to_owned()).or_default();
        let count = *earlier;
        *earlier += 1;
        match method {
            "initialize" => Reply::Answer(json!({ "result": initialize.clone() })),
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

// Mutations: in `call_task_tool`, observe the acceptance after the follow; or never write the
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
            server
                .wait_until(|server| server.requests("tasks/get").len() == 1)
                .await;
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

// Mutations: send the call before the receipt's write; or store a handle before the server
// names one.
#[tokio::test(start_paused = true)]
async fn a_call_dropped_unanswered_leaves_its_receipt_claimed_without_a_task() {
    let fixture = Fixture::new().await;
    let (standing, server) = fixture
        .connect(tools_server(
            v1_initialize_result(),
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
        () = server.wait_until(|server| server.requests("tools/call").len() == 1) => {}
    }

    assert_eq!(
        fixture.receipts(),
        [receipt_without_task("accepted", false)]
    );
}

// Mutations: in `call`, send no `tasks/cancel` at the caller's cancel of a held task, end the
// follow there, or write `failed` for a canceled task's end whatever the follow reached; in
// `cancel_followed_task`, leave a refused cancel's contact `Reached`; in `follow_task`, write
// `Reached` over the refused cancel at the poll that reads the end.
#[rstest::rstest]
#[case::taken(
    true,
    || v1_status_reply("cancelled"),
    "cancelled",
    McpToolCallEnd::Canceled,
    "failed",
    1,
    Reached
)]
#[case::answered_first(
    true,
    || Reply::Answer(json!({ "error": { "code": -32602, "message": "task ended" } })),
    "completed",
    tracked_end(),
    "completed",
    1,
    Reached
)]
#[case::refused_with_method_not_found(
    true,
    method_not_found,
    "completed",
    tracked_end(),
    "completed",
    1,
    CancelRefused { is_from_stop: true }
)]
#[case::cancel_not_declared(
    false,
    method_not_found,
    "completed",
    tracked_end(),
    "completed",
    0,
    CancelRefused { is_from_stop: true }
)]
#[tokio::test(start_paused = true)]
async fn a_canceled_task_is_asked_to_cancel_and_followed_to_the_end_it_reaches(
    #[case] is_cancel_declared: bool,
    #[case] cancel_reply: fn() -> Reply,
    #[case] after: &'static str,
    #[case] expected_end: McpToolCallEnd,
    #[case] expected_status: &str,
    #[case] expected_cancels: usize,
    #[case] expected_contact: McpTaskContact,
) {
    let fixture = Fixture::new().await;
    let mut initialize = v1_initialize_result();
    if !is_cancel_declared {
        initialize["capabilities"]["tasks"]
            .as_object_mut()
            .expect("the tasks capability is an object")
            .remove("cancel");
    }
    // Two polls read `working`, the cancel sent after the first; the third reads `after`.
    let (standing, server) = fixture
        .connect(tools_server(
            initialize,
            json!({ "taskSupport": "required" }),
            move |method, earlier| match (method, earlier) {
                ("tools/call", _) => {
                    Reply::Answer(json!({ "result": { "task": v1_task("working") } }))
                }
                ("tasks/get", 0 | 1) => v1_status_reply("working"),
                ("tasks/get", _) => v1_status_reply(after),
                ("tasks/cancel", _) => cancel_reply(),
                ("tasks/result", _) => Reply::Answer(json!({ "result": text_result("tracked") })),
                _ => method_not_found(),
            },
        ))
        .await;
    let contact = contact();
    let cancellation = CancellationToken::new();

    let (dispatched, ()) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &cancellation),
        async {
            server
                .wait_until(|server| server.requests("tasks/get").len() == 1)
                .await;
            cancellation.cancel();
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    assert_eq!(server.requests("tasks/cancel").len(), expected_cancels);
    assert_eq!(
        server.requests("tasks/get").len(),
        3,
        "the follow went on to the end"
    );
    assert_eq!(end.expect("the call ends"), expected_end);
    assert_eq!(*contact.borrow(), expected_contact);
    written.expect("the caller writes the end");
    let [stored] = <[_; 1]>::try_from(fixture.receipts()).expect("one receipt");
    assert_eq!(
        (stored.status.as_str(), stored.is_completed),
        (expected_status, true)
    );
}

// Mutation: leave the call's await unraced against `cancellation`; the call then waits out its
// idle window and ends with its timeout.
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
            server
                .wait_until(|server| server.requests("tools/call").len() == 1)
                .await;
            cancellation.cancel();
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;
    server
        .wait_until(|server| !canceled_requests(server).is_empty())
        .await;

    assert_eq!(end.expect("the call ends"), McpToolCallEnd::Canceled);
    written.expect("the caller writes the end");
    assert_eq!(fixture.receipts(), [receipt_without_task("unknown", true)]);
    assert_eq!(
        canceled_requests(&server),
        [request_id(&server, "tools/call")]
    );
}

// Mutation: leave the call's await unraced against the closed mark; the close then waits for the
// call's 30-minute idle window.
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
            server
                .wait_until(|server| server.requests("tools/call").len() == 1)
                .await;
            fixture.client.close_session(fixture.session_id).await;
            started.elapsed()
        },
    );
    let stored = fixture.receipts();
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;
    server
        .wait_until(|server| !canceled_requests(server).is_empty())
        .await;

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

// Mutations: close the connection before the cancel, as a close that does not wait for the
// dispatch would; or write the 2025-11-25 ack as anything but `failed`.
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
            server
                .wait_until(|server| !server.requests("tasks/get").is_empty())
                .await;
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

// Mutation: in `race_call`, cancel at the session's close a task whose server refused the caller's
// cancel already.
#[tokio::test(start_paused = true)]
async fn a_closing_sessions_task_whose_cancel_was_refused_is_not_asked_again() {
    let fixture = Fixture::new().await;
    let (standing, server) = fixture
        .connect(task_server(|method, _| match method {
            "tasks/get" => v1_status_reply("working"),
            _ => method_not_found(),
        }))
        .await;
    let contact = contact();
    let cancellation = CancellationToken::new();

    let (dispatched, ()) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &cancellation),
        async {
            server
                .wait_until(|server| !server.requests("tasks/get").is_empty())
                .await;
            cancellation.cancel();
            wait_for_contact(&contact, CancelRefused { is_from_stop: true }).await;
            fixture.client.close_session(fixture.session_id).await;
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    assert_eq!(
        server.requests("tasks/cancel").len(),
        1,
        "the refused cancel is not sent again"
    );
    assert_eq!(
        end.expect("the call ends"),
        McpToolCallEnd::ConnectionClosed
    );
    assert!(matches!(written, Err(McpCallCompletionError::Settled)));
    let [stored] = <[_; 1]>::try_from(fixture.receipts()).expect("one receipt");
    assert_eq!(
        (stored.status.as_str(), stored.is_completed),
        ("unknown", true)
    );
}

// Mutation: write `unknown` on the cancel's `-32602` without reading the task.
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
            server
                .wait_until(|server| !server.requests("tasks/get").is_empty())
                .await;
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

// Mutation: leave the closed mark unread before the call; the call then finds no live connection
// and fails `NotConnected`.
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

// Mutations: leave the tools read unraced against the closed mark, or read the marks only before
// it; the read then waits out its 60 s and fails, and the close waits for it.
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
            server
                .wait_until(|server| server.requests("tools/list").len() == 2)
                .await;
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

// Mutation: leave the tools marked read when their read is dropped; the next task call then
// trusts the tools it read before the change.
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
            server
                .wait_until(|server| server.requests("tools/list").len() == 2)
                .await;
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

// Mutation: write the session's close row under the stop.
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
            server
                .wait_until(|server| !server.requests("tasks/get").is_empty())
                .await;
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

/// Tells the client its tools changed. The paused sleep ends only once the runtime idles, which is
/// after the client has set its tools-changed mark.
async fn mark_tools_changed(server: &TestServer) {
    server
        .unasked
        .send(json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }).to_string())
        .expect("the server writes");
    tokio::time::sleep(Duration::from_millis(10)).await;
}
