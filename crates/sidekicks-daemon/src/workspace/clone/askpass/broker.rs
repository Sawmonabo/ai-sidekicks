//! The daemon's side of git's askpass program: a local socket in a private folder, and the owners
//! of the questions. Whoever runs git with a question to answer (a clone, later a provider's git)
//! registers as an owner and gives git the environment it is handed; each question the program
//! carries arrives at that owner alone, chosen by the random id in that environment, and its answer
//! goes back to the program and is kept nowhere.

use std::collections::HashMap;
use std::error::Error;
use std::ffi::OsStr;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures::future::BoxFuture;
use interprocess::local_socket::tokio::{Listener, Stream};
use interprocess::local_socket::traits::tokio::Listener as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::repo::clone::AskpassAnswer;
use sidekicks_platforms::askpass_listener;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::task::{JoinError, JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use super::program::{ASKPASS_OWNER_VARIABLE, ASKPASS_SOCKET_VARIABLE};
use crate::askpass_prompt::is_masked_prompt;
use crate::ipc::domain_error::DomainError;
use crate::mutex_lock::lock;
use crate::random_hex::random_hex;

// The bytes of an owner's id: random, so one owner's id never tells another's.
const OWNER_ID_BYTES: usize = 16;

// The longest request line read from the program, in bytes; a longer one is no question.
const REQUEST_MAX_BYTES: usize = 16 * 1024;

// How long the broker waits after a failed accept before the next, so a lasting failure (no file
// descriptor left) is not retried in a busy loop.
const ACCEPT_RETRY_WAIT: Duration = Duration::from_secs(1);

/// The one line the askpass program sends: whose question it is, and the question in git's or
/// ssh's own words.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct AskpassRequest {
    /// The owner's id from the program's environment.
    pub(crate) owner: String,
    /// The question.
    pub(crate) prompt: String,
}

/// One question git or ssh asks, as the owner receives it.
#[derive(Clone, Debug)]
pub(crate) struct AskpassQuestion {
    /// The question in git's or ssh's own words.
    pub(crate) prompt: String,
    /// Whether the answer is a secret typed out of sight.
    pub(crate) is_masked: bool,
    /// Canceled when the program goes away unanswered (git gave up or was stopped), when the
    /// owner is released, or when the broker closes.
    pub(crate) cancel: CancellationToken,
}

// Answers one question: the answer, or `None` to refuse it, which makes git give up on it.
type AskpassAnswerer =
    Arc<dyn Fn(AskpassQuestion) -> BoxFuture<'static, Option<AskpassAnswer>> + Send + Sync>;

// A registered owner as the broker keeps it: its answerer, and the token its release cancels.
struct RegisteredOwner {
    answer: AskpassAnswerer,
    released: CancellationToken,
}

// What the broker, its connections and its owners share.
struct BrokerState {
    socket_path: PathBuf,
    program_path: PathBuf,
    owners: Mutex<HashMap<String, RegisteredOwner>>,
    // Canceled at close: every owner's token, and so every open question, is a child of it.
    shutdown: CancellationToken,
}

impl BrokerState {
    fn owners(&self) -> MutexGuard<'_, HashMap<String, RegisteredOwner>> {
        lock(&self.owners)
    }
}

/// Why the askpass broker could not start or close.
#[derive(Debug, thiserror::Error)]
pub(crate) enum AskpassBrokerError {
    /// The socket the program connects to could not be opened.
    #[error("the askpass program's socket could not be opened")]
    Listen(#[source] io::Error),
    /// The task that accepts the program's connections ended by a panic.
    #[error("the askpass broker's listening task failed")]
    Stopped(#[source] JoinError),
}

impl From<AskpassBrokerError> for DomainError {
    /// Clone methods answered while the broker is not serving are `project.clone.unavailable`; the
    /// failure underneath is kept for the service log.
    fn from(error: AskpassBrokerError) -> Self {
        DomainError::new(error.to_string(), RefusalCode::ProjectCloneUnavailable).with_source(error)
    }
}

/// The system gave no random bytes for an askpass owner's id: an internal failure, with no
/// refusal of its own.
#[derive(Debug, thiserror::Error)]
#[error("an askpass owner's id could not be drawn")]
pub(crate) struct AskpassOwnerIdError(#[source] getrandom::Error);

/// A registered owner: the environment its git runs with. Dropping it releases the owner, which
/// refuses every question still open and every later one.
pub(crate) struct AskpassOwner {
    owner_id: String,
    state: Arc<BrokerState>,
    released: CancellationToken,
}

impl AskpassOwner {
    /// `GIT_ASKPASS` and `SSH_ASKPASS` naming the askpass program, `SSH_ASKPASS_REQUIRE=force`,
    /// and the socket and owner the program reads, for git's environment.
    pub(crate) fn environment(&self) -> [(&'static str, &OsStr); 5] {
        let program_path = self.state.program_path.as_os_str();
        [
            ("GIT_ASKPASS", program_path),
            ("SSH_ASKPASS", program_path),
            ("SSH_ASKPASS_REQUIRE", OsStr::new("force")),
            (ASKPASS_SOCKET_VARIABLE, self.state.socket_path.as_os_str()),
            (ASKPASS_OWNER_VARIABLE, OsStr::new(&self.owner_id)),
        ]
    }
}

#[cfg(test)]
impl AskpassOwner {
    /// The value the owner's environment gives `variable`, as the askpass mode reads it.
    pub(crate) fn environment_value(&self, variable: &str) -> &OsStr {
        self.environment()
            .into_iter()
            .find(|(name, _)| *name == variable)
            .map(|(_, value)| value)
            .expect("the environment names the variable")
    }
}

impl Drop for AskpassOwner {
    fn drop(&mut self) {
        self.state.owners().remove(&self.owner_id);
        self.released.cancel();
    }
}

/// Routes the askpass program's questions to their owners. [`AskpassBroker::close`] refuses
/// everything open and removes its socket; dropping the broker stops it the same way.
pub(crate) struct AskpassBroker {
    state: Arc<BrokerState>,
    listening: JoinHandle<()>,
}

impl AskpassBroker {
    /// Opens the broker's socket in `folder`, a folder only this account opens, for the askpass
    /// program at `program_path`, which git and ssh run. Runs inside a tokio runtime; fails when
    /// the socket cannot be opened, `Unsupported` where the system has no private askpass socket
    /// yet.
    pub(crate) fn start(folder: &Path, program_path: PathBuf) -> Result<Self, AskpassBrokerError> {
        let (listener, socket_path) =
            askpass_listener(folder).map_err(AskpassBrokerError::Listen)?;
        let state = Arc::new(BrokerState {
            socket_path,
            program_path,
            owners: Mutex::new(HashMap::new()),
            shutdown: CancellationToken::new(),
        });
        let listening = tokio::spawn(listen(listener, Arc::clone(&state)));
        Ok(Self { state, listening })
    }

    /// Registers an owner whose git questions `answer` receives, until the owner is dropped. Fails
    /// when the system gives no random bytes for the owner's id.
    pub(crate) fn register<Answer, Reply>(
        &self,
        answer: Answer,
    ) -> Result<AskpassOwner, AskpassOwnerIdError>
    where
        Answer: Fn(AskpassQuestion) -> Reply + Send + Sync + 'static,
        Reply: Future<Output = Option<AskpassAnswer>> + Send + 'static,
    {
        let owner_id = random_hex(OWNER_ID_BYTES).map_err(AskpassOwnerIdError)?;
        let released = self.state.shutdown.child_token();
        let answer: AskpassAnswerer = Arc::new(
            move |question| -> BoxFuture<'static, Option<AskpassAnswer>> {
                Box::pin(answer(question))
            },
        );
        self.state.owners().insert(
            owner_id.clone(),
            RegisteredOwner {
                answer,
                released: released.clone(),
            },
        );
        Ok(AskpassOwner {
            owner_id,
            state: Arc::clone(&self.state),
            released,
        })
    }

    /// Refuses every open question, stops accepting and removes the socket, once every
    /// connection has closed. Fails when the listening task ended by a panic.
    pub(crate) async fn close(mut self) -> Result<(), AskpassBrokerError> {
        self.state.owners().clear();
        self.state.shutdown.cancel();
        (&mut self.listening)
            .await
            .map_err(AskpassBrokerError::Stopped)
    }
}

impl Drop for AskpassBroker {
    fn drop(&mut self) {
        self.state.shutdown.cancel();
    }
}

// Accepts the program's connections until the broker closes, then waits for each to end; the
// listener's drop removes the socket file.
async fn listen(listener: Listener, state: Arc<BrokerState>) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            () = state.shutdown.cancelled() => break,
            accepted = listener.accept() => match accepted {
                Ok(stream) => {
                    connections.spawn(serve(stream, Arc::clone(&state)));
                }
                Err(error) => {
                    warn!(
                        error = &error as &(dyn Error + 'static),
                        "the askpass broker could not accept a connection"
                    );
                    tokio::select! {
                        () = state.shutdown.cancelled() => break,
                        () = tokio::time::sleep(ACCEPT_RETRY_WAIT) => {}
                    }
                }
            },
            // Reaped as they end, so the set holds only open connections.
            Some(ended) = connections.join_next() => warn_on_failed_connection(ended),
        }
    }
    while let Some(ended) = connections.join_next().await {
        warn_on_failed_connection(ended);
    }
}

fn warn_on_failed_connection(ended: Result<(), JoinError>) {
    if let Err(error) = ended {
        warn!(
            error = &error as &(dyn Error + 'static),
            "an askpass connection ended by a panic"
        );
    }
}

// One connection is one question: a request line in, an answer line out, or a close.
async fn serve(stream: Stream, state: Arc<BrokerState>) {
    let mut receiver = BufReader::new(&stream);
    let mut line = Vec::new();
    let mut request_reader = (&mut receiver).take(REQUEST_MAX_BYTES as u64 + 1);
    let read = request_reader.read_until(b'\n', &mut line);
    let read = tokio::select! {
        () = state.shutdown.cancelled() => return,
        read = read => read,
    };
    if let Err(error) = read {
        debug!(
            error = &error as &(dyn Error + 'static),
            "the askpass program's question could not be read"
        );
        return;
    }
    // No line break within the cap: the program went away mid-line, or the line is too long.
    if line.pop() != Some(b'\n') {
        return;
    }
    let request = match parse_request(&line) {
        Ok(request) => request,
        Err(error) => {
            warn!(
                error = &error as &(dyn Error + 'static),
                "the askpass program sent a request that is no question"
            );
            return;
        }
    };
    let Some((answer, cancel)) = state
        .owners()
        .get(&request.owner)
        .map(|owner| (Arc::clone(&owner.answer), owner.released.child_token()))
    else {
        // An owner released before git asked; its id is never logged, since it routes answers.
        debug!("the askpass program asked for an owner that is not registered");
        return;
    };
    let question = AskpassQuestion {
        is_masked: is_masked_prompt(&request.prompt),
        prompt: request.prompt,
        cancel: cancel.clone(),
    };
    let reply = tokio::select! {
        reply = answer(question) => reply,
        () = wait_for_close(&mut receiver) => {
            cancel.cancel();
            None
        }
        () = cancel.cancelled() => None,
    };
    let Some(reply) = reply else {
        return;
    };
    // An answer holds no line break, so it reaches git whole as one line.
    let mut answer_line = String::with_capacity(reply.as_str().len() + 1);
    answer_line.push_str(reply.as_str());
    answer_line.push('\n');
    if let Err(error) = (&stream).write_all(answer_line.as_bytes()).await {
        warn!(
            error = &error as &(dyn Error + 'static),
            "an answer could not reach the askpass program"
        );
    }
}

// The program's request line read as a JSON object with its owner and prompt; a line that is
// not one is refused.
fn parse_request(line: &[u8]) -> Result<AskpassRequest, serde_json::Error> {
    let request: Value = serde_json::from_slice(line)?;
    if !request.is_object() {
        return Err(serde::de::Error::custom("the request is not a JSON object"));
    }
    serde_json::from_value(request)
}

// Waits until the program goes away: it writes nothing after its question, so any end of the
// read, an error included, means it closed.
async fn wait_for_close(receiver: &mut (impl AsyncRead + Unpin)) {
    let mut scratch = [0_u8; 64];
    while let Ok(1..) = receiver.read(&mut scratch).await {}
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use interprocess::local_socket::tokio::Stream;
    use interprocess::local_socket::traits::tokio::Stream as _;
    use interprocess::local_socket::{GenericFilePath, ToFsName};
    use rstest::rstest;
    use sidekicks_contracts::repo::clone::AskpassAnswer;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::mpsc;

    use super::{
        ASKPASS_OWNER_VARIABLE, AskpassBroker, AskpassOwner, AskpassRequest, REQUEST_MAX_BYTES,
    };
    use crate::mutex_lock::lock;

    const WAIT: Duration = Duration::from_secs(10);

    fn start_broker(folder: &Path) -> AskpassBroker {
        // No program runs in these tests, so its path names nothing.
        AskpassBroker::start(folder, PathBuf::from("askpass-program")).expect("the broker starts")
    }

    fn owner_id_of(owner: &AskpassOwner) -> String {
        let owner_id = owner.environment_value(ASKPASS_OWNER_VARIABLE);
        owner_id.to_str().expect("an owner id is hex").to_owned()
    }

    fn request_line(owner_id: &str, prompt: &str) -> Vec<u8> {
        let mut line = serde_json::to_vec(&AskpassRequest {
            owner: owner_id.to_owned(),
            prompt: prompt.to_owned(),
        })
        .expect("the request serializes");
        line.push(b'\n');
        line
    }

    // Sends `request` as the program does and reads what comes back until the broker closes.
    async fn ask(socket_path: &Path, request: &[u8]) -> Vec<u8> {
        let name = socket_path
            .to_fs_name::<GenericFilePath>()
            .expect("the socket path is a name");
        let stream = Stream::connect(name).await.expect("the program connects");
        (&stream)
            .write_all(request)
            .await
            .expect("the request is written");
        let mut received = Vec::new();
        let ended = tokio::time::timeout(WAIT, (&stream).read_to_end(&mut received))
            .await
            .expect("the broker answers or closes");
        // A refusal can close the socket with the request unread, which some systems end with a
        // reset rather than an end of stream.
        assert!(ended.is_ok() || received.is_empty());
        received
    }

    #[tokio::test]
    async fn brings_a_question_to_its_owner_alone_and_returns_the_answer() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let broker = start_broker(scratch.path());
        let asked = Arc::new(Mutex::new(Vec::new()));
        let owner = {
            let asked = Arc::clone(&asked);
            broker
                .register(move |question| {
                    lock(&asked).push((question.prompt, question.is_masked));
                    async { AskpassAnswer::new("hunter2".to_owned()) }
                })
                .expect("the owner registers")
        };
        let other_calls = Arc::new(AtomicUsize::new(0));
        let other = {
            let other_calls = Arc::clone(&other_calls);
            broker
                .register(move |_| {
                    other_calls.fetch_add(1, Ordering::SeqCst);
                    async { AskpassAnswer::new("wrong".to_owned()) }
                })
                .expect("the other owner registers")
        };

        let reply = ask(
            &broker.state.socket_path,
            &request_line(&owner_id_of(&owner), "Password for 'https://github.com': "),
        )
        .await;

        assert_eq!(reply, b"hunter2\n");
        assert_eq!(
            *lock(&asked),
            [("Password for 'https://github.com': ".to_owned(), true)]
        );
        assert_eq!(other_calls.load(Ordering::SeqCst), 0);
        drop((owner, other));
        broker.close().await.expect("the broker closes");
    }

    #[rstest]
    #[case::unknown_owner(|_: &str| request_line(&"0".repeat(32), "Password: "))]
    #[case::bad_json(|_: &str| b"{\"owner\": \n".to_vec())]
    // The registered owner's request as an array, so only the object check refuses it.
    #[case::not_an_object(|owner_id: &str| format!("[\"{owner_id}\", \"Password: \"]\n").into_bytes())]
    #[case::over_the_cap(|_: &str| vec![b'a'; REQUEST_MAX_BYTES + 1])]
    #[tokio::test]
    async fn leaves_a_request_that_is_no_question_unanswered(
        #[case] request_for: fn(&str) -> Vec<u8>,
    ) {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let broker = start_broker(scratch.path());
        let calls = Arc::new(AtomicUsize::new(0));
        let owner = {
            let calls = Arc::clone(&calls);
            broker
                .register(move |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    async { AskpassAnswer::new("hunter2".to_owned()) }
                })
                .expect("the owner registers")
        };

        let request = request_for(&owner_id_of(&owner));

        let reply = ask(&broker.state.socket_path, &request).await;

        assert_eq!(reply, b"");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        drop(owner);
        broker.close().await.expect("the broker closes");
    }

    #[tokio::test]
    async fn releasing_the_owner_cancels_its_open_question_and_closes_the_program() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let broker = start_broker(scratch.path());
        let (questions, mut asked) = mpsc::unbounded_channel();
        let owner = broker
            .register(move |question| {
                questions
                    .send(question.cancel)
                    .expect("the test waits for the question");
                // Never answered: only the release ends it.
                std::future::pending::<Option<AskpassAnswer>>()
            })
            .expect("the owner registers");
        let socket_path = broker.state.socket_path.clone();
        let request = request_line(&owner_id_of(&owner), "Password: ");
        let program = tokio::spawn(async move { ask(&socket_path, &request).await });
        let cancel = tokio::time::timeout(WAIT, asked.recv())
            .await
            .expect("the question arrives")
            .expect("the owner hears the question");

        drop(owner);

        tokio::time::timeout(WAIT, cancel.cancelled())
            .await
            .expect("the release cancels the question");
        assert_eq!(program.await.expect("the program's side ends"), b"");
        broker.close().await.expect("the broker closes");
    }
}
