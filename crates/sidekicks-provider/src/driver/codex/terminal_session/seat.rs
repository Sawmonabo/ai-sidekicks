//! The daemon's seat on one Codex conversation a person typed in a terminal: a connection of its
//! own on the terminal service, held while a command of the conversation runs, since Codex ends a
//! running command once no client holds its conversation. A seat is taken for an exchange, and at
//! each turn end or command end the terminal service reports for a conversation no seat holds,
//! when a command of it still runs, so a terminal that quits mid-command keeps its command.

use std::sync::Arc;

use serde_json::value::RawValue;
use tokio::sync::mpsc;

use super::conversations::TerminalSeatClaim;
use crate::driver::codex::app_server_protocol::ThreadUnsubscribeParams;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::routing::read_codex_frame_thread_id;
use crate::driver::codex::session::background_terminals::list_codex_running_commands;
use crate::driver::codex::session::conversation_release::is_list_change;
use crate::driver::codex::session::detached_conversation::{
    CodexDetachedFrame, CodexDetachedFrames,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::establishment::adoption::request_bare_thread_resume;
use crate::driver::codex::session::slots::{CODEX_LET_GO_TIMEOUT, THREAD_UNSUBSCRIBE_METHOD};
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::codex::transport::diagnostics::{CodexTeardownStep, CodexTransportDiagnostic};

/// The daemon's seat on one terminal conversation: a connection of its own on the terminal
/// service, where that connection's notifications arrive, the conversation, and the seat's claim
/// on it where it holds one, let go as the seat drops.
pub(super) struct TerminalSeat {
    /// The seat's own connection on the terminal service.
    pub(super) connection: CodexAppServerConnection,
    /// Where that connection's notifications arrive.
    pub(super) frames: mpsc::UnboundedReceiver<CodexDetachedFrame>,
    /// The conversation.
    pub(super) thread_id: String,
    /// The seat's claim on the conversation, held only for its drop.
    pub(super) _claim: Option<TerminalSeatClaim>,
}

impl TerminalSeat {
    /// Opens a seat on `thread_id` on `service`, holding `claim` while it lives; the conversation
    /// is not resumed yet. Fails as the connection's start or dial fails.
    pub(super) async fn open(
        service: &CodexService,
        thread_id: &str,
        claim: Option<TerminalSeatClaim>,
    ) -> Result<Self, CodexError> {
        let (events, frames) = CodexDetachedFrames::new();
        let connection = service.open_detached_connection(events).await?;
        Ok(Self {
            connection,
            frames,
            thread_id: thread_id.to_owned(),
            _claim: claim,
        })
    }

    /// The next notification of the seat's conversation, `None` once its connection dropped.
    pub(super) async fn next_frame(&mut self) -> Option<CodexDetachedFrame> {
        while let Some((method, params)) = self.frames.recv().await {
            let frame_thread_id = read_codex_frame_thread_id(&method, &params);
            if frame_thread_id.as_deref() == Some(self.thread_id.as_str()) {
                return Some((method, params));
            }
        }
        None
    }
}

impl CodexService {
    /// Reads one frame of a conversation no session holds on a service terminals join: the frame
    /// moves what is remembered of it, and a turn end or command end with a command of it still
    /// running takes a seat on it until none runs. Called on the reader, so nothing here awaits.
    pub(crate) fn watch_terminal_frame(
        self: &Arc<Self>,
        method: &str,
        params: &RawValue,
        thread_id: &str,
    ) {
        let conversations = self.terminal_conversations();
        conversations.observe_frame(method, params, thread_id);
        if !is_list_change(method, params) {
            return;
        }
        // A seat already on the conversation reads its commands again at this frame itself.
        let Some(claim) = conversations.claim_seat(thread_id) else {
            return;
        };
        let service = Arc::clone(self);
        let thread_id = thread_id.to_owned();
        self.dependencies()
            .tasks
            .spawn(async move { hold_left_commands(&service, &thread_id, claim).await });
    }
}

// Reads the commands `thread_id` runs and, while one does, holds a seat on it until none runs and
// lets it go. A read that fails takes the seat too, since the conversation may still run one.
async fn hold_left_commands(service: &CodexService, thread_id: &str, claim: TerminalSeatClaim) {
    let Ok(connection) = service.connection() else {
        // A service away holds no conversation for the seat to keep.
        return;
    };
    match list_codex_running_commands(&connection, thread_id).await {
        Ok(process_ids) if process_ids.is_empty() => return,
        Ok(_running) => {}
        Err(error) => report_step_failed(CodexTeardownStep::BackgroundTerminalList, error),
    }
    drop(connection);
    let resumed = async {
        let seat = TerminalSeat::open(service, thread_id, Some(claim)).await?;
        request_bare_thread_resume(&seat.connection, thread_id, None).await?;
        Ok::<_, CodexError>(seat)
    };
    let mut seat = match resumed.await {
        Ok(seat) => seat,
        Err(error) => {
            CodexTransportDiagnostic::ConversationResumeFailed {
                thread_id: thread_id.to_owned(),
                error: Box::new(error),
            }
            .report();
            return;
        }
    };
    if hold_while_commands_run(&mut seat).await {
        let_go(seat).await;
    }
}

/// Holds the seat while a command of its conversation runs: reads the running commands now, again
/// at each command's end and each turn's end, and at the next frame after a read that failed,
/// since letting go would end a command that may still run. `true` once none runs, `false` once
/// the seat's connection dropped first.
pub(super) async fn hold_while_commands_run(seat: &mut TerminalSeat) -> bool {
    loop {
        let listed = list_codex_running_commands(&seat.connection, &seat.thread_id).await;
        let is_read_owed = match listed {
            Ok(process_ids) if process_ids.is_empty() => return true,
            Ok(_running) => false,
            Err(error) => {
                report_step_failed(CodexTeardownStep::BackgroundTerminalList, error);
                true
            }
        };
        loop {
            let Some((method, params)) = seat.next_frame().await else {
                return false;
            };
            if is_read_owed || is_list_change(&method, &params) {
                break;
            }
        }
    }
}

/// Unsubscribes the seat from its conversation within a short bound, a refusal reported, and drops
/// its connection and its claim.
pub(super) async fn let_go(seat: TerminalSeat) {
    let unsubscribed = seat
        .connection
        .request_within(
            THREAD_UNSUBSCRIBE_METHOD,
            &ThreadUnsubscribeParams {
                thread_id: seat.thread_id,
            },
            CODEX_LET_GO_TIMEOUT,
        )
        .await;
    if let Err(error) = unsubscribed {
        report_step_failed(CodexTeardownStep::ThreadUnsubscribe, error);
    }
}

fn report_step_failed(step: CodexTeardownStep, error: CodexError) {
    CodexTransportDiagnostic::TeardownStepFailed {
        step,
        error: Box::new(error),
    }
    .report();
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::{Value, json};

    use crate::driver::codex::service::supervisor::test_service::{
        bind_test_listener, next_socket_request, send_on_socket, start_scripted_terminal_service,
    };
    use crate::driver::codex::session::side_questions::test_copies::accept_copy;
    use crate::driver::codex::transport::connection::scripted_service::ScriptedService;

    /// The conversation a person typed in a terminal.
    const THREAD: &str = "typed-thread";

    /// How long a test gives the service to send a request it must not send.
    const QUIET: Duration = Duration::from_millis(200);

    /// How long the test waits before it counts a step as stuck.
    const DEADLOCK_BOUND: Duration = Duration::from_secs(10);

    // Sends the service's connection the notification `method` with `params`, as Codex does.
    fn notify(script: &ScriptedService, method: &str, params: &Value) {
        script.send(&json!({"jsonrpc": "2.0", "method": method, "params": params}));
    }

    // Kills: a turn end of a conversation no session holds left unrouted, a command still running
    // left without a seat, a second seat taken while one holds, and a seat that never lets go once
    // the command ends.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_terminal_that_quits_mid_command_leaves_a_seat_holding_it() {
        let mut scripted = start_scripted_terminal_service();
        let Some(listener) = bind_test_listener(scripted.service.socket_path()) else {
            return;
        };
        let idle = json!({"threadId": THREAD, "status": {"type": "idle"}});
        // The turn ends with the person's terminal gone and a command of it still running.
        notify(&scripted.script, "thread/status/changed", &idle);
        let listed = tokio::time::timeout(
            DEADLOCK_BOUND,
            scripted.next_request("thread/backgroundTerminals/list"),
        )
        .await
        .expect("the turn end reads the conversation's commands");
        assert_eq!(listed["params"]["threadId"], THREAD);
        let running = json!({"data": [{"processId": "4242"}], "nextCursor": null});
        scripted.script.answer(&listed, &running);

        let mut seat = tokio::time::timeout(DEADLOCK_BOUND, accept_copy(&listener))
            .await
            .expect("a running command takes a seat");
        let resume = next_socket_request(&mut seat).await;
        assert_eq!(resume["method"], "thread/resume");
        assert_eq!(resume["params"]["threadId"], THREAD);
        let thread =
            json!({"id": THREAD, "sessionId": "codex-session", "status": {"type": "idle"}});
        send_on_socket(
            &mut seat,
            json!({"id": resume["id"], "result": {"thread": thread}}),
        )
        .await;
        let reread = next_socket_request(&mut seat).await;
        assert_eq!(reread["method"], "thread/backgroundTerminals/list");
        send_on_socket(&mut seat, json!({"id": reread["id"], "result": running})).await;

        notify(&scripted.script, "thread/status/changed", &idle);
        let second = scripted.script.next_sent_within(QUIET).await;
        assert!(
            second.is_none(),
            "one seat holds the conversation: {second:?}"
        );

        let command = json!({"type": "commandExecution", "id": "c-1"});
        send_on_socket(
            &mut seat,
            json!({"jsonrpc": "2.0", "method": "item/completed",
                "params": {"threadId": THREAD, "turnId": "turn-1", "item": command}}),
        )
        .await;
        let reread = next_socket_request(&mut seat).await;
        assert_eq!(reread["method"], "thread/backgroundTerminals/list");
        send_on_socket(
            &mut seat,
            json!({"id": reread["id"], "result": {"data": [], "nextCursor": null}}),
        )
        .await;
        let unsubscribe = next_socket_request(&mut seat).await;
        assert_eq!(unsubscribe["method"], "thread/unsubscribe");
        assert_eq!(unsubscribe["params"]["threadId"], THREAD);
        send_on_socket(
            &mut seat,
            json!({"id": unsubscribe["id"], "result": {"status": "unsubscribed"}}),
        )
        .await;
        let tasks = &scripted.dependencies.tasks;
        tasks.close();
        tokio::time::timeout(DEADLOCK_BOUND, tasks.wait())
            .await
            .expect("the seat lets the conversation go");
    }
}
