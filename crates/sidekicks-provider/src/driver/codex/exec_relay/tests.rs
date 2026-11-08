use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
use serde_json::{Value, json};
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::caller_process::system_reader::ProcessTableReader;
use sidekicks_platforms::Spawner;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader, DuplexStream, Lines};
use tokio::net::TcpStream;
use tokio::runtime::Handle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tokio_util::task::TaskTracker;

use super::endpoint::RelayEndpoint;
use super::executor::CodexExecutor;
use super::{CodexExecRelay, CodexExecRelayDependencies, CodexThreadSessions, RelayedThread};
use crate::bearer_token::BearerToken;
use crate::command::running_set::RunningCommandSets;
use crate::command::waiting_checks::SystemInputWaitReader;

mod acts;
mod connections;
mod exchange;
mod file_handles;
mod http_requests;
mod missing_watches;
mod parity;
mod processes;
mod starts;

mod executor_end;

const THREAD: &str = "thread-1";
const COPY_THREAD: &str = "thread-copy";
const CALL: &str = "call-1";
const EXECUTOR_PROCESS: &str = "7-0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5d";

// How long a test waits for any one message on a client's socket.
const SOCKET_READ_WAIT: Duration = Duration::from_secs(5);

// How long a connection is watched for a message it must not receive.
const QUIET_WAIT: Duration = Duration::from_millis(100);

// A client's end of a connection to the relay.
type ClientSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

// The executor's far side: the lines the relay wrote to it, and its output the test writes.
struct FakeExecutor {
    sent: Lines<BufReader<DuplexStream>>,
    output: DuplexStream,
}

impl FakeExecutor {
    async fn next_sent(&mut self) -> Value {
        let line = self
            .sent
            .next_line()
            .await
            .expect("the executor's input reads")
            .expect("the relay wrote a line");
        serde_json::from_str(&line).expect("the relay writes JSON")
    }

    async fn write(&mut self, message: &Value) {
        let line = format!("{message}\n");
        self.output
            .write_all(line.as_bytes())
            .await
            .expect("the executor's output takes the line");
    }
}

// A connection to a fake executor, initialized as the relay initializes a real one.
async fn initialized_executor() -> (Arc<CodexExecutor>, FakeExecutor) {
    let (input, sent) = tokio::io::duplex(1 << 16);
    let (output, read) = tokio::io::duplex(1 << 16);
    let executor = CodexExecutor::over(read, input, Some(std::process::id()));
    let mut fake = FakeExecutor {
        sent: BufReader::new(sent).lines(),
        output,
    };
    let answering = async {
        let initialize = fake.next_sent().await;
        assert_eq!(initialize["method"], "initialize");
        fake.write(&json!({ "id": initialize["id"], "result": { "sessionId": "executor-1" } }))
            .await;
        assert_eq!(fake.next_sent().await["method"], "initialized");
    };
    let (initialized, ()) = tokio::join!(executor.initialize(), answering);
    initialized.expect("the executor initializes");
    (executor, fake)
}

// A relay whose conversation `THREAD` and side question's copy `COPY_THREAD` belong to
// `session_id`, its running commands not registered, so no start is wrapped.
fn relay_for(session_id: SessionId, folder: &Path) -> Arc<CodexExecRelay> {
    relay_reporting_to(folder, None, session_threads(session_id))
}

// `THREAD` and the side question's copy `COPY_THREAD`, both `session_id`'s.
fn session_threads(session_id: SessionId) -> CodexThreadSessions {
    Arc::new(move |thread_id: &str| {
        [THREAD, COPY_THREAD]
            .contains(&thread_id)
            .then_some(RelayedThread {
                session_id,
                is_side_question: thread_id == COPY_THREAD,
            })
    })
}

// A relay in `folder` whose conversations `thread_sessions` reads, its running commands `sets`
// where given.
fn relay_reporting_to(
    folder: &Path,
    sets: Option<Arc<RunningCommandSets>>,
    thread_sessions: CodexThreadSessions,
) -> Arc<CodexExecRelay> {
    let command_output = Arc::new(PortRegistration::new("running commands"));
    if let Some(sets) = sets {
        assert!(command_output.register(sets).is_ok());
    }
    let spawner = Spawner::new(Handle::current()).expect("the spawner thread starts");
    let dependencies = Arc::new(CodexExecRelayDependencies {
        spawner: spawner.clone(),
        command_channel_root: folder.join("channels"),
        caller_processes: Arc::new(
            ProcessTableReader::for_this_program().expect("this program's reader builds"),
        ),
        input_waits: Arc::new(SystemInputWaitReader { spawner }),
        command_output,
        command_capture: Arc::new(PortRegistration::new("command capture")),
        wrapper_program: folder.join("wrapper"),
        askpass_program: folder.join("askpass"),
        tasks: TaskTracker::new(),
    });
    CodexExecRelay::new(dependencies, thread_sessions, Arc::new(|| {}))
}

// A relay listening over a fake executor, and what a client needs to reach it.
struct ListeningRelay {
    relay: Arc<CodexExecRelay>,
    fake: FakeExecutor,
    url: String,
    // The authorization header that presents the relay's token.
    presented: String,
}

// A relay for `session_id` in `folder` over an initialized fake executor, listening under a fresh
// token.
async fn listening_relay(session_id: SessionId, folder: &Path) -> ListeningRelay {
    let relay = relay_for(session_id, folder);
    let (executor, fake) = initialized_executor().await;
    relay.take_executor(executor);
    let token = BearerToken::mint().expect("a token mints");
    let presented = format!("Bearer {}", token.text());
    let endpoint = RelayEndpoint::listen(Arc::downgrade(&relay), token)
        .await
        .expect("the relay listens");
    let url = endpoint.url();
    *lock(&relay.endpoint) = Some(endpoint);
    ListeningRelay {
        relay,
        fake,
        url,
        presented,
    }
}

// A connection to the relay at `url`, admitted by the authorization header `presented`.
async fn admitted_socket(url: &str, presented: &str) -> ClientSocket {
    let mut request = url.into_client_request().expect("a request");
    request.headers_mut().insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(presented).expect("a header value"),
    );
    let (socket, _response) = tokio_tungstenite::connect_async(request)
        .await
        .expect("the token is admitted");
    socket
}

// Sends `message` on `socket` as one text message.
async fn send_text(socket: &mut ClientSocket, message: &Value) {
    socket
        .send(Message::text(message.to_string()))
        .await
        .expect("the client writes");
}

// Sends `initialize` under id 1 on `socket` and reads its answer, the relay's executor's own.
async fn initialize(socket: &mut ClientSocket) {
    send_text(
        socket,
        &json!({ "id": 1, "method": "initialize", "params": { "clientName": "codex" } }),
    )
    .await;
    assert_eq!(
        next_text(socket).await,
        json!({ "id": 1, "result": { "sessionId": "executor-1" } })
    );
}

// The next line the executor reads, failing when none comes within the socket's wait.
async fn next_forwarded(fake: &mut FakeExecutor) -> Value {
    tokio::time::timeout(SOCKET_READ_WAIT, fake.next_sent())
        .await
        .expect("the relay forwards the message")
}

// Fails when the relay writes the executor anything within the quiet wait.
async fn assert_executor_quiet(fake: &mut FakeExecutor) {
    let read = tokio::time::timeout(QUIET_WAIT, fake.next_sent()).await;
    assert!(read.is_err(), "the executor read {read:?}");
}

// Fails when `socket` receives anything within the quiet wait.
async fn assert_quiet(socket: &mut ClientSocket) {
    let read = tokio::time::timeout(QUIET_WAIT, socket.next()).await;
    assert!(read.is_err(), "the connection received {read:?}");
}

fn command_id() -> CommandId {
    CommandId::new(CALL.to_owned()).expect("a call id is a command id")
}

async fn next_text<Stream>(socket: &mut Stream) -> Value
where
    Stream: futures::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    match tokio::time::timeout(SOCKET_READ_WAIT, socket.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str(text.as_str()).expect("JSON"),
        other => panic!("the client expected a text message, got {other:?}"),
    }
}

fn exited(process: &str) -> Value {
    json!({
        "method": "process/exited",
        "params": { "processId": process, "seq": 1, "exitCode": 3 },
    })
}

// Yields until `holds` reads true, failing after a bound.
async fn wait_until(mut holds: impl FnMut() -> bool) {
    for _turn in 0..1_000 {
        if holds() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    panic!("the condition never held");
}
