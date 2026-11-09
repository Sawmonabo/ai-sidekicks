//! The session each connection opens at its `initialize`, as Codex's executor keeps one per
//! connection: attached while its socket is open, and held for its resume once the socket drops,
//! so a Codex that reconnects with `resumeSessionId` finds its processes still its own. A session
//! is resumed only by the environment that opened it.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::random_hex::random_hex;
use tokio::time::Instant;

use super::{CodexExecutor, RelayConnectionId};
use crate::driver::codex::exec_relay::methods::ClientMethod;

/// How long a dropped connection's processes are held for its resume: the longer of the windows
/// the executors Codex ships keep a detached session.
pub(in crate::driver::codex::exec_relay) const DETACHED_CONNECTION_HOLD: Duration =
    Duration::from_secs(80);

/// The JSON-RPC code Codex's executor refuses the resume of a session another connection holds
/// with, which Codex's client retries.
const SESSION_ALREADY_ATTACHED_ERROR_CODE: i64 = -32010;

/// The JSON-RPC code of a request the executor cannot take, a resume of an unknown session among
/// them.
const INVALID_REQUEST_ERROR_CODE: i64 = -32600;

/// The random bytes of the session id the relay gives each connection.
const SESSION_ID_BYTES: usize = 16;

/// A refused `initialize`: its JSON-RPC code and its words, as Codex's executor answers it.
#[derive(Debug, PartialEq, Eq)]
pub(in crate::driver::codex::exec_relay) struct InitializeRefusal {
    /// The JSON-RPC code.
    pub(in crate::driver::codex::exec_relay) code: i64,
    /// The refusal in words.
    pub(in crate::driver::codex::exec_relay) message: String,
}

impl InitializeRefusal {
    /// The refusal of a request the executor cannot take, under `message`.
    pub(super) fn invalid(message: String) -> Self {
        Self {
            code: INVALID_REQUEST_ERROR_CODE,
            message,
        }
    }
}

/// One dropped connection's hold, told apart from a later hold of the same session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::driver::codex::exec_relay) struct ConnectionHold {
    session_id: String,
    number: u64,
}

// One session: the connection that holds it, the environment that opened it, and, once its
// connection dropped, the hold and when it ends.
struct ConnectionSession {
    connection: RelayConnectionId,
    environment: Arc<str>,
    held: Option<(u64, Instant)>,
}

/// Every connection's session, attached or held.
#[derive(Default)]
pub(super) struct DetachedConnections {
    sessions: HashMap<String, ConnectionSession>,
    session_of: HashMap<RelayConnectionId, String>,
    holds: u64,
}

impl DetachedConnections {
    /// Whether `connection` already opened or resumed a session.
    pub(super) fn has_session(&self, connection: RelayConnectionId) -> bool {
        self.session_of.contains_key(&connection)
    }

    /// Opens `session_id` for `connection` of `environment`, and ends at once every hold of that
    /// environment, which opened afresh, answering the connections those holds kept.
    pub(super) fn open(
        &mut self,
        connection: RelayConnectionId,
        environment: Arc<str>,
        session_id: String,
    ) -> Vec<RelayConnectionId> {
        let ended: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_id, session)| session.held.is_some() && session.environment == environment)
            .map(|(id, _session)| id.clone())
            .collect();
        let ended = ended
            .into_iter()
            .filter_map(|id| self.remove(&id))
            .collect();
        self.session_of.insert(connection, session_id.clone());
        self.sessions.insert(
            session_id,
            ConnectionSession {
                connection,
                environment,
                held: None,
            },
        );
        ended
    }

    /// Hands `session_id` to `connection` of `environment`, answering the connection whose drop
    /// held it. Refused as unknown for a session no connection of that environment holds or whose
    /// hold has ended, and as already attached for one whose connection is still open.
    pub(super) fn resume(
        &mut self,
        connection: RelayConnectionId,
        environment: &str,
        session_id: &str,
    ) -> Result<RelayConnectionId, InitializeRefusal> {
        let unknown = || InitializeRefusal::invalid(format!("unknown session id {session_id}"));
        let session = self
            .sessions
            .get_mut(session_id)
            .filter(|session| &*session.environment == environment)
            .ok_or_else(unknown)?;
        let Some((_hold, ends_at)) = session.held else {
            return Err(InitializeRefusal {
                code: SESSION_ALREADY_ATTACHED_ERROR_CODE,
                message: format!("session {session_id} is already attached to another connection"),
            });
        };
        if Instant::now() >= ends_at {
            return Err(unknown());
        }
        let held = std::mem::replace(&mut session.connection, connection);
        session.held = None;
        self.session_of.remove(&held);
        self.session_of.insert(connection, session_id.to_owned());
        Ok(held)
    }

    /// Holds the session of `connection`, whose socket dropped, for its resume; `None` for a
    /// connection that opened no session, whose ids go with it.
    pub(super) fn hold(&mut self, connection: RelayConnectionId) -> Option<ConnectionHold> {
        let session_id = self.session_of.get(&connection)?;
        let session = self
            .sessions
            .get_mut(session_id)
            .expect("every connection's session is kept");
        self.holds += 1;
        session.held = Some((self.holds, Instant::now() + DETACHED_CONNECTION_HOLD));
        Some(ConnectionHold {
            session_id: session_id.clone(),
            number: self.holds,
        })
    }

    /// Ends `hold` at its window, answering the connection it kept; `None` once the session was
    /// resumed, held again or ended.
    pub(super) fn end_hold(&mut self, hold: &ConnectionHold) -> Option<RelayConnectionId> {
        let held = self
            .sessions
            .get(&hold.session_id)
            .and_then(|session| session.held);
        if held.is_none_or(|(number, _ends_at)| number != hold.number) {
            return None;
        }
        self.remove(&hold.session_id)
    }

    // Removes `session_id`, answering the connection that held it.
    fn remove(&mut self, session_id: &str) -> Option<RelayConnectionId> {
        let session = self.sessions.remove(session_id)?;
        self.session_of.remove(&session.connection);
        Some(session.connection)
    }
}

/// A connection's `initialize` the relay took: the answer's result, naming the session it opened
/// or resumed, and the live processes of the holds a fresh open ended, by their relay ids.
pub(in crate::driver::codex::exec_relay) struct InitializedConnection {
    /// The result the connection's `initialize` is answered with.
    pub(in crate::driver::codex::exec_relay) result: Value,
    /// The processes the ended holds kept.
    pub(in crate::driver::codex::exec_relay) released_processes: Vec<String>,
}

impl CodexExecutor {
    /// Takes the connection `connection`'s `initialize`: with `resume_session_id`, it takes back
    /// the session a dropped connection of its environment held, with every process that session
    /// started; without, it opens a session of its own and ends every hold of its environment,
    /// whose processes it answers for the relay to end. Refused, as Codex's executor refuses
    /// them, for a second `initialize`, an unknown session and one another connection holds.
    pub(in crate::driver::codex::exec_relay) fn initialize_connection(
        &self,
        connection: RelayConnectionId,
        resume_session_id: Option<&str>,
    ) -> Result<InitializedConnection, InitializeRefusal> {
        let environment = lock(&self.clients)
            .get(&connection)
            .map(|queue| Arc::clone(queue.environment()))
            .ok_or_else(|| InitializeRefusal::invalid("the connection has closed".to_owned()))?;
        let mut sessions = lock(&self.sessions);
        if sessions.has_session(connection) {
            return Err(InitializeRefusal::invalid(
                "initialize may only be sent once per connection".to_owned(),
            ));
        }
        let (session_id, released_processes) = if let Some(session_id) = resume_session_id {
            let held = sessions.resume(connection, &environment, session_id)?;
            drop(sessions);
            lock(&self.process_ids).move_connection(held, connection);
            for request in lock(&self.client_requests).values_mut() {
                if request.connection == held {
                    request.connection = connection;
                }
            }
            (session_id.to_owned(), Vec::new())
        } else {
            let session_id = random_hex(SESSION_ID_BYTES).map_err(|error| {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the Codex relay could not mint a connection's session id"
                );
                InitializeRefusal::invalid("the relay could not mint a session id".to_owned())
            })?;
            let ended = sessions.open(connection, environment, session_id.clone());
            drop(sessions);
            let released = ended
                .into_iter()
                .flat_map(|held| self.forget_held(held))
                .collect();
            (session_id, released)
        };
        let mut result = self
            .initialize_result()
            .and_then(|result| serde_json::from_str::<Map<String, Value>>(result.get()).ok())
            .unwrap_or_default();
        result.insert("sessionId".to_owned(), Value::String(session_id));
        Ok(InitializedConnection {
            result: Value::Object(result),
            released_processes,
        })
    }

    /// Ends `hold` at its window, answering the live processes it kept, by their relay ids, for
    /// the relay to end; `None` once the session was resumed or its hold already ended.
    pub(in crate::driver::codex::exec_relay) fn end_hold(
        &self,
        hold: &ConnectionHold,
    ) -> Option<Vec<String>> {
        let held = lock(&self.sessions).end_hold(hold)?;
        Some(self.forget_held(held))
    }

    // Forgets the held connection `held`'s ids and requests, answering its live processes.
    fn forget_held(&self, held: RelayConnectionId) -> Vec<String> {
        lock(&self.client_requests).retain(|_relay_id, request| {
            request.connection != held || request.method == ClientMethod::FileOpen
        });
        lock(&self.process_ids).forget_connection(held)
    }
}
