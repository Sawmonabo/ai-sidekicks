//! An agent's message to a Codex session typed in a terminal, on a seat of its own: a connection
//! to the terminal service that resumes the conversation for this exchange alone, writes the
//! message as a turn of its own when the conversation is idle or steers it into the turn running,
//! hands back the end of a turn it started, and lets the conversation go once the exchange's turn
//! ended and no command of it still runs.

use serde_json::Value;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::oneshot;
use tokio_util::task::TaskTracker;

use super::seat::{TerminalSeat, hold_while_commands_run, let_go};
use super::{CodexTerminalExchangeError, require_terminal_session};
use crate::driver::codex::app_server_protocol::{TurnSteerParams, UserInput};
use crate::driver::codex::attachments::compose_codex_text_input;
use crate::driver::codex::event_normalizer::CODEX_TURN_COMPLETED_METHOD;
use crate::driver::codex::messages::{CodexArrivalMoment, compose_codex_arrival_text};
use crate::driver::codex::run::steer::CODEX_TURN_STEER_METHOD;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::establishment::adoption::request_bare_thread_resume;
use crate::driver::codex::session::history::read_codex_resumed_newest_turn;
use crate::driver::codex::session::owed_turn_ends::is_codex_turn_in_progress;
use crate::driver::codex::session::side_questions::copy_turn::{
    CopyFrameReading, CopyTurn, CopyTurnMeter,
};
use crate::driver::codex::thread::settings::CodexTurnStartParams;
use crate::driver::codex::thread::view::{TURN_START_METHOD, read_steered_turn_id, read_turn_id};

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
    /// Codex's own notice of the failure, where the turn failed with one.
    pub(crate) notice: Option<String>,
}

/// Delivers `message` into `thread_id`, a conversation a person typed in a terminal inside
/// `service`, which is up, on a seat the service's tasks hold until the exchange is over. Fails
/// with `GivenUp` when no terminal holds the conversation, and as the seat's connection, its
/// resume or the message's request fails.
pub(super) async fn deliver_to_terminal_session(
    service: &CodexService,
    thread_id: &str,
    message: &CodexTerminalMessage,
) -> Result<CodexTerminalDelivery, CodexTerminalExchangeError> {
    require_terminal_session(service, thread_id).await?;
    let conversations = service.terminal_conversations();
    // A seat the conversation's turn end took keeps holding it beside this one.
    let claim = conversations.claim_seat(thread_id);
    let seat = TerminalSeat::open(service, thread_id, claim).await?;
    // Held from the resume to the write, so two sends never both read the conversation idle and
    // both open a turn: the second reads the first's turn running and steers into it.
    let _writing = conversations.write_turn().await;
    let tasks = &service.dependencies().tasks;
    Ok(deliver_on_seat(seat, message, tasks).await?)
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
    // The terminal's turns are the person's, never metered here, so the meter knows no model.
    let mut meter = CopyTurnMeter::new(seat.thread_id.clone(), None, None);
    let mut reply = None;
    while let Some((method, params)) = seat.next_frame().await {
        if method == CODEX_TURN_COMPLETED_METHOD
            && read_turn_id(&params, &method).ok().as_deref() != Some(turn_id)
        {
            continue;
        }
        match meter.read_frame(&method, &params) {
            CopyFrameReading::Reply(text) => reply = Some(text),
            CopyFrameReading::Ended(turn) => {
                let notice = turn
                    .as_ref()
                    .and_then(|turn| turn.error.as_ref())
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .filter(|notice| !notice.trim().is_empty())
                    .map(str::to_owned);
                return Some(CodexTerminalTurnEnd {
                    is_completed: CopyTurn::is_completed(turn.as_ref()),
                    reply,
                    notice,
                });
            }
            CopyFrameReading::Usage(_) | CopyFrameReading::Other => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::{Value, json};
    use sidekicks_contracts::session::controls::methods::PermissionLevel;
    use sidekicks_std::mutex_lock::lock;
    use sidekicks_std::port_registration::PortRegistration;
    use tokio_util::task::TaskTracker;

    use super::{CodexTerminalDelivery, CodexTerminalMessage, TerminalSeat, deliver_on_seat};
    use crate::driver::codex::service::registry::CodexServiceRegistry;
    use crate::driver::codex::service::supervisor::test_service::start_scripted_terminal_service;
    use crate::driver::codex::terminal_session::TERMINAL_RECONNECT_WINDOW;
    use crate::driver::codex::transport::connection::scripted_service::{
        ScriptedService, scripted_connection,
    };
    use crate::driver::session_messages::{
        SessionMessageDelivery, SessionMessageKind, SessionMessageSent, SessionMessageTarget,
    };
    use crate::driver::test_registry::{RecordedQueue, new_message_id, new_session_id};
    use crate::port::session_message_reading_publisher::{
        SessionMessageReading, SessionMessageReadingPublisher,
    };

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
            _claim: None,
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
        assert_eq!(turn_end.notice, None);

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

    // Kills: a steer sent as a turn of its own (`turn/start` while a turn runs), a steer naming
    // another turn than the running one, and a steered message answered as a turn it started.
    #[tokio::test]
    async fn a_message_to_a_busy_terminal_session_steers_into_its_running_turn() {
        let (connection, mut script, frames) = scripted_connection();
        let seat = TerminalSeat {
            connection,
            frames,
            thread_id: THREAD.to_owned(),
            _claim: None,
        };
        let message = message();
        let tasks = TaskTracker::new();
        let delivering = deliver_on_seat(seat, &message, &tasks);
        let service = async {
            let resume = script.next_sent().await;
            assert_eq!(resume["method"], "thread/resume");
            let active = json!({"type": "active", "activeFlags": []});
            let thread = json!({"id": THREAD, "sessionId": "codex-session", "status": active});
            let running = json!({"id": "turn-7", "status": "inProgress"});
            let newest = json!({"data": [running], "nextCursor": null});
            script.answer(
                &resume,
                &json!({"thread": thread, "initialTurnsPage": newest}),
            );
            let steer = script.next_sent().await;
            script.answer(&steer, &json!({"turnId": "turn-7"}));
            steer
        };
        let (delivered, steer) =
            tokio::time::timeout(DEADLOCK_BOUND, async { tokio::join!(delivering, service) })
                .await
                .expect("the delivery settles");

        assert_eq!(steer["method"], "turn/steer");
        assert_eq!(steer["params"]["expectedTurnId"], "turn-7");
        assert_eq!(
            steer["params"]["clientUserMessageId"],
            message.message_id.to_string()
        );
        assert!(
            matches!(delivered, Ok(CodexTerminalDelivery::Steered)),
            "a steered message opens no turn of its own"
        );
    }

    // Kills: a send to a service away within the window that blocks or reads nothing instead of
    // held, a held message whose terminal closed meanwhile left with no final reading or one
    // without the reopen line, and a service away past the window that is still asked.
    #[tokio::test(start_paused = true)]
    async fn a_send_to_a_terminal_session_its_service_left_reads_held_then_the_reopen_line() {
        let mut scripted = start_scripted_terminal_service();
        let registry = CodexServiceRegistry::holding(&scripted);
        let recorded = Arc::new(RecordedQueue::default());
        let readings: Arc<PortRegistration<Arc<dyn SessionMessageReadingPublisher>>> =
            Arc::new(PortRegistration::new("session message readings"));
        readings
            .register(Arc::clone(&recorded) as _)
            .expect("the readings register once");
        let tasks = TaskTracker::new();
        let reopen = format!("Reopen it in a terminal: codex resume {THREAD}");

        let connection = scripted.publish_reconnecting();
        tokio::time::advance(TERMINAL_RECONNECT_WINDOW / 2).await;
        let held = registry
            .deliver_session_message_to_terminal(THREAD, delivery(), &readings, &tasks)
            .await
            .expect("a held send is answered at once");
        let held_readings = lock(&recorded.readings).clone();
        scripted.publish_up(connection);
        let loaded = scripted.next_request("thread/loaded/list").await;
        scripted
            .script
            .answer(&loaded, &json!({"data": [], "nextCursor": null}));
        tokio::time::timeout(DEADLOCK_BOUND, async {
            while lock(&recorded.readings).len() < 2 {
                recorded.changed.notified().await;
            }
        })
        .await
        .expect("the held message reaches a final reading");

        let _down = scripted.publish_crash_loop();
        tokio::time::advance(TERMINAL_RECONNECT_WINDOW).await;
        let given_up = registry
            .deliver_session_message_to_terminal(THREAD, delivery(), &readings, &tasks)
            .await
            .expect("a send past the window is answered");

        assert_eq!(held, SessionMessageSent::Sent);
        assert!(
            matches!(
                held_readings.as_slice(),
                [SessionMessageReading::Held { .. }]
            ),
            "{held_readings:?}"
        );
        assert!(
            matches!(
                lock(&recorded.readings).get(1),
                Some(SessionMessageReading::Refused { reason: Some(reason), .. })
                    if *reason == reopen
            ),
            "the closed terminal's message reads the reopen line"
        );
        assert_eq!(given_up, SessionMessageSent::Refused { words: reopen });
        let sent = scripted.script.next_sent_within(QUIET).await;
        assert!(sent.is_none(), "nothing reaches the service: {sent:?}");
    }

    // A message from another session to the terminal conversation.
    fn delivery() -> SessionMessageDelivery {
        SessionMessageDelivery {
            target: SessionMessageTarget::Terminal(THREAD.to_owned()),
            message_id: new_message_id(),
            sender_session_id: new_session_id(),
            sender_name: "planner".to_owned(),
            kind: SessionMessageKind::Message {
                body: "Run the release checks.".to_owned(),
                sender_level: PermissionLevel::Ask,
                hop_chain: Vec::new(),
            },
        }
    }
}
