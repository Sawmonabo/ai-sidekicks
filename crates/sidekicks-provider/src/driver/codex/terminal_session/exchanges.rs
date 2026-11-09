//! An agent's message to a Codex session typed in a terminal, on a seat of its own: a connection
//! to the terminal service that resumes the conversation for this exchange alone, writes the
//! message as a turn of its own when the conversation is idle or steers it into the turn running,
//! hands back the end of a turn it started, and lets the conversation go once the exchange's turn
//! ended and no command of it still runs, since Codex ends a running command once no client holds
//! its conversation. Each command's end and each turn's end reads the commands again, with no
//! timer.

use serde_json::Value;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::{mpsc, oneshot};
use tokio_util::task::TaskTracker;

use super::{CodexTerminalExchangeError, require_terminal_session};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::app_server_protocol::{
    ThreadUnsubscribeParams, TurnSteerParams, UserInput,
};
use crate::driver::codex::attachments::compose_codex_text_input;
use crate::driver::codex::event_normalizer::CODEX_TURN_COMPLETED_METHOD;
use crate::driver::codex::messages::{CodexArrivalMoment, compose_codex_arrival_text};
use crate::driver::codex::run::steer::CODEX_TURN_STEER_METHOD;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::routing::read_codex_frame_thread_id;
use crate::driver::codex::session::background_terminals::list_codex_running_commands;
use crate::driver::codex::session::conversation_release::is_list_change;
use crate::driver::codex::session::detached_conversation::{
    CodexDetachedFrame, CodexDetachedFrames,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::establishment::adoption::request_bare_thread_resume;
use crate::driver::codex::session::history::read_codex_resumed_newest_turn;
use crate::driver::codex::session::owed_turn_ends::is_codex_turn_in_progress;
use crate::driver::codex::session::side_questions::copy_turn::{
    CopyFrameReading, CopyTurn, read_copy_frame,
};
use crate::driver::codex::session::slots::{CODEX_LET_GO_TIMEOUT, THREAD_UNSUBSCRIBE_METHOD};
use crate::driver::codex::thread::settings::CodexTurnStartParams;
use crate::driver::codex::thread::view::{TURN_START_METHOD, read_steered_turn_id, read_turn_id};
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::codex::transport::diagnostics::{CodexTeardownStep, CodexTransportDiagnostic};
use crate::usage_delta_accountant::UsageDeltaAccountant;

/// An agent's message to a Codex session typed in a terminal.
pub(crate) struct CodexTerminalMessage {
    /// The id the text goes to Codex under, which its echo carries back.
    pub(crate) message_id: QueueItemId,
    /// The sending session's name.
    pub(crate) sender_name: String,
    /// The sending session.
    pub(crate) sender_session_id: SessionId,
    /// What the sender wrote.
    pub(crate) body: String,
}

/// How a message went into a Codex session typed in a terminal.
pub(crate) enum CodexTerminalDelivery {
    /// The conversation was idle, so the message opened a turn of its own, whose end arrives here;
    /// the sender dropped means the seat's connection ended before the turn did.
    Started(oneshot::Receiver<CodexTerminalTurnEnd>),
    /// A turn was running, so the message was steered into it; that turn answers no one.
    Steered,
}

/// How the turn a message started ended.
pub(crate) struct CodexTerminalTurnEnd {
    /// Whether the turn completed.
    pub(crate) is_completed: bool,
    /// The turn's last reply, `None` where it wrote none.
    pub(crate) reply: Option<String>,
    /// Codex's error, where the turn failed with one.
    pub(crate) error: Option<Value>,
}

// The daemon's seat on one terminal conversation: a connection of its own on the terminal service,
// where that connection's notifications arrive, and the conversation.
struct TerminalSeat {
    connection: CodexAppServerConnection,
    frames: mpsc::UnboundedReceiver<CodexDetachedFrame>,
    thread_id: String,
}

impl TerminalSeat {
    // The next notification of the seat's conversation, `None` once its connection dropped.
    async fn next_frame(&mut self) -> Option<CodexDetachedFrame> {
        while let Some((method, params)) = self.frames.recv().await {
            let frame_thread_id = read_codex_frame_thread_id(&method, &params);
            if frame_thread_id.as_deref() == Some(self.thread_id.as_str()) {
                return Some((method, params));
            }
        }
        None
    }
}

impl CodexServiceRegistry {
    /// Delivers `message` into `thread_id`, a conversation a person typed in a terminal inside the
    /// terminal service, on a seat the service's tasks hold until the exchange is over; a service
    /// that is away is waited for within the terminal's reconnect window. Fails with `GivenUp` once
    /// the service has been away past that window, with `NotOpen` when no terminal holds the
    /// conversation, and as the seat's connection, its resume or the message's request fails.
    pub(crate) async fn deliver_to_terminal_session(
        &self,
        thread_id: &str,
        message: &CodexTerminalMessage,
    ) -> Result<CodexTerminalDelivery, CodexTerminalExchangeError> {
        let service = require_terminal_session(self, thread_id).await?;
        let (events, frames) = CodexDetachedFrames::new();
        let connection = service.open_detached_connection(events).await?;
        let seat = TerminalSeat {
            connection,
            frames,
            thread_id: thread_id.to_owned(),
        };
        let tasks = &service.dependencies().tasks;
        Ok(deliver_on_seat(seat, message, tasks).await?)
    }
}

// Resumes the seat's conversation, which subscribes the seat to it, and writes `message` once the
// reload is done: a turn of its own when no turn runs, else a steer into the running one. Then
// holds the seat on `tasks` until that turn ended and no command of the conversation runs, and
// lets it go. Fails as the resume or the message's request fails, the seat then dropped.
async fn deliver_on_seat(
    mut seat: TerminalSeat,
    message: &CodexTerminalMessage,
    tasks: &TaskTracker,
) -> Result<CodexTerminalDelivery, CodexError> {
    let resumed = request_bare_thread_resume(&seat.connection, &seat.thread_id, None).await?;
    let running_turn = read_codex_resumed_newest_turn(&resumed)
        .filter(|newest| is_codex_turn_in_progress(&newest.turn));
    let (turn_id, delivery, ended) = match running_turn {
        None => {
            let reply = seat
                .connection
                .request(
                    TURN_START_METHOD,
                    &CodexTurnStartParams {
                        thread_id: seat.thread_id.clone(),
                        input: vec![compose_message_input(message, CodexArrivalMoment::Idle)],
                        approvals_reviewer: None,
                        collaboration_mode: None,
                        model: None,
                        client_user_message_id: Some(message.message_id.to_string()),
                        turn_trigger: None,
                        root_turn_id: None,
                        output_schema: None,
                        effort: None,
                        service_tier: None,
                        service_tier_for_turn: None,
                        // The terminal's own environments stay as they are.
                        environments: None,
                    },
                )
                .await?;
            let (ended, delivered) = oneshot::channel();
            (
                read_turn_id(&reply, TURN_START_METHOD)?,
                CodexTerminalDelivery::Started(delivered),
                Some(ended),
            )
        }
        Some(running) => {
            let reply = seat
                .connection
                .request(
                    CODEX_TURN_STEER_METHOD,
                    &TurnSteerParams {
                        thread_id: seat.thread_id.clone(),
                        input: vec![compose_message_input(message, CodexArrivalMoment::MidTurn)],
                        expected_turn_id: running.id.clone(),
                        client_user_message_id: Some(message.message_id.to_string()),
                        additional_context: None,
                        responsesapi_client_metadata: None,
                        responsesapi_client_metadata_patch: None,
                    },
                )
                .await?;
            (
                read_steered_turn_id(&reply).unwrap_or(running.id),
                CodexTerminalDelivery::Steered,
                None,
            )
        }
    };
    tasks.spawn(async move {
        let Some(turn_end) = read_turn_end(&mut seat, &turn_id).await else {
            // The connection ended, which let the conversation go with it.
            return;
        };
        if let Some(ended) = ended {
            // A sender that stopped waiting has no use for the turn's end.
            let _unheard = ended.send(turn_end);
        }
        if hold_while_commands_run(&mut seat).await {
            let_go(seat).await;
        }
    });
    Ok(delivery)
}

// The text of `message` landing at `moment`, as one input item.
fn compose_message_input(message: &CodexTerminalMessage, moment: CodexArrivalMoment) -> UserInput {
    compose_codex_text_input(compose_codex_arrival_text(
        &message.sender_name,
        message.sender_session_id,
        &message.body,
        moment,
    ))
}

// Reads the seat's frames until the turn `turn_id` ended, its last reply kept; `None` once the
// seat's connection dropped first.
async fn read_turn_end(seat: &mut TerminalSeat, turn_id: &str) -> Option<CodexTerminalTurnEnd> {
    // The terminal's turns are the person's, never metered here.
    let mut accountant = UsageDeltaAccountant::new(DESCRIPTOR.provider_id());
    let mut reply = None;
    while let Some((method, params)) = seat.next_frame().await {
        if method == CODEX_TURN_COMPLETED_METHOD
            && read_turn_id(&params, &method).ok().as_deref() != Some(turn_id)
        {
            continue;
        }
        match read_copy_frame(&method, &params, &mut accountant) {
            CopyFrameReading::Reply(text) => reply = Some(text),
            CopyFrameReading::Ended(turn) => {
                return Some(CodexTerminalTurnEnd {
                    is_completed: CopyTurn::is_completed(turn.as_ref()),
                    reply,
                    error: turn.and_then(|turn| turn.error),
                });
            }
            CopyFrameReading::Usage(_) | CopyFrameReading::Other => {}
        }
    }
    None
}

// Holds the seat while a command of its conversation runs: reads the running commands now, again
// at each command's end and each turn's end, and at the next frame after a read that failed, since
// letting go would end a command that may still run. `true` once none runs, `false` once the
// seat's connection dropped first.
async fn hold_while_commands_run(seat: &mut TerminalSeat) -> bool {
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

// Unsubscribes the seat from its conversation within a short bound, a refusal reported, and drops
// its connection.
async fn let_go(seat: TerminalSeat) {
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
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::{Value, json};
    use tokio_util::task::TaskTracker;

    use super::{CodexTerminalDelivery, CodexTerminalMessage, TerminalSeat, deliver_on_seat};
    use crate::driver::codex::service::registry::CodexServiceRegistry;
    use crate::driver::codex::service::supervisor::test_service::start_scripted_terminal_service;
    use crate::driver::codex::terminal_session::{
        CodexTerminalExchangeError, TERMINAL_RECONNECT_WINDOW,
    };
    use crate::driver::codex::transport::connection::scripted_service::{
        ScriptedService, scripted_connection,
    };
    use crate::driver::test_registry::{new_message_id, new_session_id};

    /// The conversation a person typed in a terminal.
    const THREAD: &str = "typed-thread";

    /// How long a test gives the seat to send a request it must not send.
    const QUIET: Duration = Duration::from_millis(200);

    /// How long the test waits before it counts a step as stuck.
    const DEADLOCK_BOUND: Duration = Duration::from_secs(10);

    fn message() -> CodexTerminalMessage {
        CodexTerminalMessage {
            message_id: new_message_id(),
            sender_name: "planner".to_owned(),
            sender_session_id: new_session_id(),
            body: "Run the release checks.".to_owned(),
        }
    }

    // Sends the seat the notification `method` with `params`, as the service does.
    fn notify(script: &ScriptedService, method: &str, params: &Value) {
        script.send(&json!({"jsonrpc": "2.0", "method": method, "params": params}));
    }

    // Kills: a seat that opens no turn of its own on an idle conversation, the turn's reply or end
    // not handed back, another conversation's reply taken for it, a let-go while a command still
    // runs, a list read again at a frame that ends no command, and no let-go once none runs.
    #[tokio::test]
    async fn the_seat_resumes_for_the_exchange_alone_and_holds_while_a_command_runs() {
        let (connection, mut script, frames) = scripted_connection();
        let seat = TerminalSeat {
            connection,
            frames,
            thread_id: THREAD.to_owned(),
        };
        let tasks = TaskTracker::new();
        let message = message();
        let delivering = deliver_on_seat(seat, &message, &tasks);
        let service = async {
            let resume = script.next_sent().await;
            assert_eq!(resume["method"], "thread/resume");
            assert_eq!(resume["params"]["threadId"], THREAD);
            let idle = json!({"type": "idle"});
            let thread = json!({"id": THREAD, "sessionId": "codex-session", "status": idle});
            let ended_turn = json!({"id": "turn-0", "status": "completed"});
            let newest = json!({"data": [ended_turn], "nextCursor": null});
            let resumed = json!({"thread": thread, "initialTurnsPage": newest});
            script.answer(&resume, &resumed);
            let start = script.next_sent().await;
            assert_eq!(start["method"], "turn/start");
            assert_eq!(start["params"]["threadId"], THREAD);
            assert_eq!(
                start["params"]["clientUserMessageId"],
                message.message_id.to_string()
            );
            let text = start["params"]["input"][0]["text"]
                .as_str()
                .expect("the turn opens with the message")
                .to_owned();
            assert!(text.contains("Run the release checks."), "{text}");
            script.answer(&start, &json!({"turn": {"id": "turn-1"}}));
        };
        let joined = async { tokio::join!(delivering, service) };
        let (delivered, ()) = tokio::time::timeout(DEADLOCK_BOUND, joined)
            .await
            .expect("the delivery settles");
        let Ok(CodexTerminalDelivery::Started(ended)) = delivered else {
            panic!("an idle conversation takes the message as a turn of its own");
        };

        let elsewhere = json!({"type": "agentMessage", "id": "m-0", "text": "Not this one."});
        let reply = json!({"type": "agentMessage", "id": "m-1", "text": "The checks pass."});
        let other_thread = json!({"threadId": "other", "turnId": "turn-9", "item": elsewhere});
        notify(&script, "item/completed", &other_thread);
        let own_reply = json!({"threadId": THREAD, "turnId": "turn-1", "item": reply});
        notify(&script, "item/completed", &own_reply);
        let own_turn = json!({"id": "turn-1", "status": "completed"});
        let completed = json!({"threadId": THREAD, "turn": own_turn});
        notify(&script, "turn/completed", &completed);
        let turn_end = tokio::time::timeout(DEADLOCK_BOUND, ended)
            .await
            .expect("the turn's end arrives")
            .expect("the seat hands back the turn's end");
        assert!(turn_end.is_completed);
        assert_eq!(turn_end.reply.as_deref(), Some("The checks pass."));
        assert_eq!(turn_end.error, None);

        let listed = script.next_sent().await;
        assert_eq!(listed["method"], "thread/backgroundTerminals/list");
        let running = json!({"data": [{"processId": "4242"}], "nextCursor": null});
        script.answer(&listed, &running);
        let reasoning = json!({"type": "reasoning", "id": "r-1"});
        let thought = json!({"threadId": THREAD, "turnId": "turn-1", "item": reasoning});
        notify(&script, "item/completed", &thought);
        let held = script.next_sent_within(QUIET).await;
        assert!(held.is_none(), "the seat holds: {held:?}");

        let idle = json!({"threadId": THREAD, "status": {"type": "idle"}});
        notify(&script, "thread/status/changed", &idle);
        let reread = script.next_sent().await;
        assert_eq!(reread["method"], "thread/backgroundTerminals/list");
        script.answer(&reread, &json!({"data": [], "nextCursor": null}));
        let unsubscribe = script.next_sent().await;
        assert_eq!(unsubscribe["method"], "thread/unsubscribe");
        assert_eq!(unsubscribe["params"]["threadId"], THREAD);
        script.answer(&unsubscribe, &json!({"status": "unsubscribed"}));
        tasks.close();
        tokio::time::timeout(DEADLOCK_BOUND, tasks.wait())
            .await
            .expect("the seat lets the conversation go");
    }

    // Kills: a refusal without the reopen line, a give-up before the terminal's window passed,
    // and a service that went down for good read as terminal reach off.
    #[tokio::test(start_paused = true)]
    async fn a_send_to_a_terminal_session_its_service_left_reads_the_reopen_line() {
        let mut scripted = start_scripted_terminal_service();
        let registry = CodexServiceRegistry::holding(&scripted);

        let connection = scripted.publish_reconnecting();
        tokio::time::advance(TERMINAL_RECONNECT_WINDOW / 2).await;
        let sending = tokio::spawn({
            let registry = Arc::clone(&registry);
            async move {
                registry
                    .deliver_to_terminal_session(THREAD, &message())
                    .await
                    .map(drop)
            }
        });
        // The send waits on the service within the window, and the service comes back.
        tokio::task::yield_now().await;
        scripted.publish_up(connection);
        let loaded = scripted.next_request("thread/loaded/list").await;
        let nothing_loaded = json!({"data": [], "nextCursor": null});
        scripted.script.answer(&loaded, &nothing_loaded);
        let closed = sending.await.expect("the send ends");
        assert!(
            matches!(closed, Err(CodexTerminalExchangeError::NotOpen { .. })),
            "{closed:?}"
        );

        let _down = scripted.publish_crash_loop();
        tokio::time::advance(TERMINAL_RECONNECT_WINDOW).await;
        let given_up = registry
            .deliver_to_terminal_session(THREAD, &message())
            .await
            .map(drop);
        let Err(error) = given_up else {
            panic!("a service away past the window reaches no terminal");
        };
        assert!(
            matches!(error, CodexTerminalExchangeError::GivenUp { .. }),
            "{error:?}"
        );
        assert_eq!(
            error.to_string(),
            format!("Reopen it in a terminal: codex resume {THREAD}")
        );
        let sent = scripted.script.next_sent_within(QUIET).await;
        assert!(sent.is_none(), "nothing reaches the service: {sent:?}");
    }
}
