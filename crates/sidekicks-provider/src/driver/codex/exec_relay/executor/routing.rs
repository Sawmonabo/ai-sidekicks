//! The routing of each line the executor writes: an answer to one of the relay's own requests
//! reaches its waiter, an answer to a connection's request reaches that connection under its own
//! id with the table its method names kept in step, and a policy ask, a process's event or a body
//! delta reaches the connection that owns the id it names; an executor request no connection owns
//! is refused and an unrouted notification dropped.

use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
use sidekicks_std::mutex_lock::lock;

use super::connection_ids::UNKNOWN_ID;
use super::policy_requests::deny_answer;
use super::{ClientRequest, CodexExecutor, RELAY_REQUEST_PREFIX, WatchedAnswer, record_end};
use crate::driver::codex::exec_relay::executor_end::ProcessEventKind;
use crate::driver::codex::exec_relay::message::{RoutedMessage, RoutedParams, splice, text_of};
use crate::driver::codex::exec_relay::methods::{
    ClientMethod, FS_MISSING_CHANGED_METHOD, HTTP_REQUEST_BODY_DELTA_METHOD,
    NETWORK_POLICY_REQUEST_METHOD, PROCESS_CLOSED_METHOD, RelayIdKind, is_process_notification,
};

/// What an answer began that no connection holds any more, by its relay id, for the relay to end.
enum UnownedEnd {
    /// A process started after its connection or its hold went.
    Process(String),
    /// A file opened after its connection went.
    FileHandle(String),
}

impl CodexExecutor {
    // Routes one line the executor wrote.
    pub(super) fn take_line(&self, line: &str) {
        let Some(message) = RoutedMessage::read(line) else {
            tracing::warn!(
                length = line.len(),
                "the Codex executor wrote a line that is no message"
            );
            return;
        };
        if message.method.is_none()
            && let Some(id) = message
                .id
                .and_then(|id| serde_json::from_str::<String>(id.get()).ok())
                .filter(|id| id.starts_with(RELAY_REQUEST_PREFIX))
        {
            let answer = match (message.result, message.error) {
                (Some(result), _) => Ok(result.to_owned()),
                (None, error) => Err(error
                    .and_then(|error| error.message)
                    .unwrap_or_else(|| "no reason given".to_owned())),
            };
            if let Some(waiting) = lock(&self.pending).remove(&id)
                && waiting.send(answer).is_err()
            {
                tracing::debug!(id, "a relay request's caller stopped waiting");
            }
            return;
        }
        if message.method.is_none()
            && let Some(id) = message.id
        {
            let watching = lock(&self.client_replies).remove(id.get());
            let request = lock(&self.client_requests).remove(id.get());
            let (answer, mut unowned) = match &request {
                Some(request) => {
                    let (answer, unowned) = self.client_answer(line, &message, id, request);
                    (Some((request.connection, answer)), unowned)
                }
                None => (None, None),
            };
            if let Some(watching) = watching {
                let watched = if message.error.is_some() {
                    WatchedAnswer::Refused
                } else if matches!(unowned, Some(UnownedEnd::Process(_))) {
                    WatchedAnswer::TakenUnowned
                } else {
                    WatchedAnswer::Taken
                };
                // A watcher still waiting ends or keeps the unowned process itself; the client
                // gets the answer whether the watcher hears it or not.
                if watching.send(watched).is_ok() && watched == WatchedAnswer::TakenUnowned {
                    unowned = None;
                }
            }
            let Some((connection, answer)) = answer else {
                tracing::debug!(
                    length = line.len(),
                    "the Codex executor answered a request no connection waits on"
                );
                return;
            };
            self.answer_connection(connection, answer);
            match unowned {
                Some(UnownedEnd::Process(process)) => {
                    self.send_own_line_awaited(self.compose_process_terminate(&process));
                }
                Some(UnownedEnd::FileHandle(handle)) => {
                    self.send_own_line_awaited(self.compose_file_close(&handle));
                }
                None => {}
            }
            return;
        }
        if message.method.as_deref() == Some(NETWORK_POLICY_REQUEST_METHOD)
            && let Some(id) = message.id
        {
            let params = message.params.unwrap_or_default();
            self.take_policy_request(line, id, &params);
            return;
        }
        if message.method.as_deref() == Some(HTTP_REQUEST_BODY_DELTA_METHOD) && message.id.is_none()
        {
            let params = message.params.unwrap_or_default();
            self.take_body_delta(line, &params);
            return;
        }
        if let Some(method) = message.method.as_deref()
            && message.id.is_none()
            && is_process_notification(method)
        {
            let params = message.params.unwrap_or_default();
            self.take_process_notification(line, method, &params);
            return;
        }
        match (message.method.as_deref(), message.id) {
            (Some(FS_MISSING_CHANGED_METHOD), None) => {
                let watch_id = message.params.and_then(|params| params.watch_id);
                self.fire_missing_watch(watch_id);
            }
            // No connection owns it, so it is refused as Codex's client refuses one it lacks.
            (Some(method), Some(id)) => {
                let refusal = json!({ "id": id, "error": {
                    "code": JsonRpcErrorCode::MethodNotFound.code(),
                    "message": format!("The relay does not serve {method}."),
                }});
                self.send_own_lines(vec![refusal.to_string()]);
            }
            (Some(method), None) => {
                tracing::debug!(
                    method,
                    "the Codex executor's notification reached no connection"
                );
            }
            (None, _) => tracing::debug!(
                length = line.len(),
                "the Codex executor wrote a message with no method and no id"
            ),
        }
    }

    // The executor's answer `line` to the client's `request` under the client's own id, the table
    // its method names kept in step, and what the answer began for no one: a file opened after its
    // connection went, and a process started once its connection or its hold was gone.
    fn client_answer(
        &self,
        line: &str,
        message: &RoutedMessage<'_>,
        id: &RawValue,
        request: &ClientRequest,
    ) -> (String, Option<UnownedEnd>) {
        match request.method {
            ClientMethod::ProcessStart => {
                let (answer, unowned) =
                    self.mint_answer(RelayIdKind::Process, line, message, id, request);
                if let Some(minted) = &request.relay_id {
                    let mut ledger = lock(&self.ledger);
                    if message.error.is_none() {
                        ledger.open_process(minted);
                    } else {
                        ledger.forget_process(minted);
                    }
                }
                (answer, unowned.map(UnownedEnd::Process))
            }
            ClientMethod::FileOpen => {
                let (answer, unowned) =
                    self.mint_answer(RelayIdKind::FileHandle, line, message, id, request);
                (answer, unowned.map(UnownedEnd::FileHandle))
            }
            ClientMethod::FileClose => {
                if let Some(handle) = &request.relay_id {
                    lock(&self.file_handles).close(handle);
                }
                (splice(line, [(id, &*request.client_id)]), None)
            }
            // A streamed request's id lives until its last delta; any other's ends at its answer.
            ClientMethod::HttpRequest => {
                if let Some(minted) = &request.relay_id {
                    let mut ids = lock(&self.http_requests);
                    if request.streams && message.error.is_none() {
                        ids.mark_live(minted);
                    } else {
                        ids.forget(minted);
                    }
                }
                (splice(line, [(id, &*request.client_id)]), None)
            }
            ClientMethod::Initialize
            | ClientMethod::Initialized
            | ClientMethod::ProcessTerminate
            | ClientMethod::ProcessNamed
            | ClientMethod::FileNamed
            | ClientMethod::WatchMissing
            | ClientMethod::Passed => (splice(line, [(id, &*request.client_id)]), None),
        }
    }

    // The executor's answer `line` to `request`, which minted an id of `kind`, under the client's
    // own id: a refused mint's id is forgotten, and an answered one is live and names the
    // connection's own id again. The relay id an answer names that no connection holds any more is
    // answered beside it.
    fn mint_answer(
        &self,
        kind: RelayIdKind,
        line: &str,
        message: &RoutedMessage<'_>,
        id: &RawValue,
        request: &ClientRequest,
    ) -> (String, Option<String>) {
        let mut ids = lock(self.ids_of(kind));
        if message.error.is_some()
            && let Some(minted) = &request.relay_id
        {
            ids.forget(minted);
        }
        let mut unowned = None;
        let named = message
            .result
            .and_then(|result| serde_json::from_str::<RoutedParams<'_>>(result.get()).ok())
            .and_then(|result| result.id_of(kind))
            .and_then(|raw| {
                let relay_id = text_of(raw)?;
                let Some(owner) = ids.owner(&relay_id) else {
                    unowned = Some(relay_id);
                    return None;
                };
                let own_id = serde_json::to_string(&owner.own_id).ok()?;
                ids.mark_live(&relay_id);
                Some((raw, own_id))
            });
        drop(ids);
        let answer = splice(
            line,
            std::iter::once((id, &*request.client_id))
                .chain(named.as_ref().map(|(raw, own_id)| (*raw, own_id.as_str()))),
        );
        (answer, unowned)
    }

    // Hands `line`, the executor's policy ask `id` about the process `params` names by its relay
    // id, to the connection that started it under its own id, keeping the ask until that
    // connection answers it or goes; an ask no connection can answer is denied at once.
    fn take_policy_request(&self, line: &str, id: &RawValue, params: &RoutedParams<'_>) {
        let owner = params
            .process_id
            .and_then(text_of)
            .and_then(|relay_id| lock(&self.process_ids).owner(&relay_id).cloned());
        let routed = owner.and_then(|owner| {
            let raw = params.process_id?;
            let own_id = serde_json::to_string(&owner.own_id).expect("a string serializes");
            // Kept while the connection is held, so its detach either finds the ask or comes first.
            let clients = lock(&self.clients);
            if !clients.contains_key(&owner.connection) {
                return None;
            }
            lock(&self.policy_requests).ask(id, owner.connection);
            drop(clients);
            Some((owner.connection, splice(line, [(raw, own_id.as_str())])))
        });
        let Some((connection, routed)) = routed else {
            self.send_own_lines(vec![deny_answer(id.get())]);
            return;
        };
        if !self.answer_connection(connection, routed)
            && lock(&self.policy_requests).answer(id, connection)
        {
            self.send_own_lines(vec![deny_answer(id.get())]);
        }
    }

    // Hands `line`, the executor's `method` about the process `params` names by its relay id, to
    // the connection that started it under its own id, recording the process's end; a process no
    // connection owns has its message reach no one.
    fn take_process_notification(&self, line: &str, method: &str, params: &RoutedParams<'_>) {
        let relay_id = params.process_id.and_then(text_of);
        if let Some(relay_id) = &relay_id
            && let Some(kind) = ProcessEventKind::from_method(method)
        {
            lock(&self.ledger).record_event(relay_id, kind, params.seq, params.stream);
            if kind != ProcessEventKind::Output {
                let mut exits = lock(&self.exits);
                if let Some(exit) = exits.get(relay_id) {
                    record_end(exit, params.exit_code);
                }
                if kind == ProcessEventKind::Closed {
                    exits.remove(relay_id);
                }
            }
        }
        let owned = relay_id.as_ref().and_then(|relay_id| {
            let mut ids = lock(&self.process_ids);
            let owner = ids.owner(relay_id).cloned();
            if method == PROCESS_CLOSED_METHOD {
                ids.close(relay_id);
            }
            owner
        });
        let (Some(raw), Some(owner)) = (params.process_id, owned) else {
            tracing::debug!(
                method,
                process_id = relay_id.as_deref().unwrap_or(UNKNOWN_ID),
                "the Codex executor wrote of a process no connection owns"
            );
            return;
        };
        let own_id = serde_json::to_string(&owner.own_id).expect("a string serializes");
        let routed = splice(line, [(raw, own_id.as_str())]);
        self.answer_connection(owner.connection, routed);
    }

    // Hands `line`, a body delta of the http request `params` names by its relay id, to the
    // connection that sent it under its own id, forgetting the id at its last delta; a delta no
    // connection owns reaches no one, as Codex drops one.
    fn take_body_delta(&self, line: &str, params: &RoutedParams<'_>) {
        let relay_id = params.request_id.and_then(text_of);
        let owned = relay_id.as_ref().and_then(|relay_id| {
            let mut ids = lock(&self.http_requests);
            let owner = ids.owner(relay_id).cloned();
            if let Some(seq) = params.seq {
                ids.note_seq(relay_id, seq);
            }
            if params.done || params.error.is_some() {
                ids.close(relay_id);
            }
            owner
        });
        let (Some(raw), Some(owner)) = (params.request_id, owned) else {
            tracing::debug!(
                request_id = relay_id.as_deref().unwrap_or(UNKNOWN_ID),
                "the Codex executor streamed a body no connection asked for"
            );
            return;
        };
        let own_id = serde_json::to_string(&owner.own_id).expect("a string serializes");
        let routed = splice(line, [(raw, own_id.as_str())]);
        self.answer_connection(owner.connection, routed);
    }
}
