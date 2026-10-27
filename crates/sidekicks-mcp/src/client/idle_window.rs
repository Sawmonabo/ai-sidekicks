//! A connection's tool calls' idle window, which the daemon keeps itself rather than rmcp: a call
//! goes without an answer for at most the window, each `notifications/progress` for its token
//! starting the window again, and the window stands still while any question the server asked on
//! the connection is open, then starts again in full once none is.

use std::collections::HashMap;
use std::pin::pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rmcp::model::ProgressToken;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::{Notify, watch};
use tokio::time::Instant;

/// What moves or holds one connection's tool calls' idle window: progress on each call in
/// flight, by its token, and how many of the server's questions are open. It holds one entry per
/// tool call in flight on the connection.
pub(super) struct ToolCallActivity {
    progress: Mutex<HashMap<ProgressToken, Arc<Notify>>>,
    open_questions: watch::Sender<usize>,
}

/// A tool call's watch on the progress for its token, from before it waits until it ends.
pub(super) struct ProgressWatch<'activity> {
    activity: &'activity ToolCallActivity,
    token: ProgressToken,
    progressed: Arc<Notify>,
}

/// One of the server's questions while it is open, from the moment its request arrives.
pub(super) struct OpenQuestion<'activity> {
    activity: &'activity ToolCallActivity,
}

impl ToolCallActivity {
    /// A connection's activity with no call in flight and no question open.
    pub(super) fn new() -> Self {
        Self {
            progress: Mutex::new(HashMap::new()),
            open_questions: watch::Sender::new(0),
        }
    }

    /// Watches the progress the server reports for `token`, a call's, until the watch drops.
    pub(super) fn watch_progress(&self, token: ProgressToken) -> ProgressWatch<'_> {
        let progressed = Arc::new(Notify::new());
        lock(&self.progress).insert(token.clone(), Arc::clone(&progressed));
        ProgressWatch {
            activity: self,
            token,
            progressed,
        }
    }

    /// Starts again the idle window of the call whose token is `token`, as its progress does.
    pub(super) fn progressed(&self, token: &ProgressToken) {
        if let Some(progressed) = lock(&self.progress).get(token) {
            progressed.notify_one();
        }
    }

    /// Holds every call's idle window still until the returned question closes.
    pub(super) fn open_question(&self) -> OpenQuestion<'_> {
        self.open_questions.send_modify(|open| *open += 1);
        OpenQuestion { activity: self }
    }

    /// Resolves once `watch`'s call has gone `idle_timeout` with no progress and no question open
    /// on the connection, the window starting again in full once the last open question closes.
    pub(super) async fn idle_out(&self, watch: &ProgressWatch<'_>, idle_timeout: Duration) {
        let mut questions = self.open_questions.subscribe();
        let mut deadline = Instant::now() + idle_timeout;
        loop {
            if *questions.borrow_and_update() > 0 {
                questions
                    .wait_for(|open| *open == 0)
                    .await
                    .expect("the connection's activity outlives its calls");
                deadline = Instant::now() + idle_timeout;
                continue;
            }
            let progressed = pin!(watch.progressed.notified());
            tokio::select! {
                () = tokio::time::sleep_until(deadline) => return,
                () = progressed => deadline = Instant::now() + idle_timeout,
                changed = questions.changed() => {
                    changed.expect("the connection's activity outlives its calls");
                }
            }
        }
    }
}

impl Drop for ProgressWatch<'_> {
    fn drop(&mut self) {
        lock(&self.activity.progress).remove(&self.token);
    }
}

impl Drop for OpenQuestion<'_> {
    fn drop(&mut self) {
        self.activity.open_questions.send_modify(|open| *open -= 1);
    }
}

#[cfg(test)]
mod tests {
    use rmcp::service::ServiceError;
    use serde_json::{Value, json};
    use tokio::time::{Duration, Instant, sleep, sleep_until};

    use crate::client::requests::STDIO_TOOL_CALL_IDLE_TIMEOUT;
    use crate::client::tasks::{McpTaskContact, McpToolCallEnd, McpToolCallError};
    use crate::client::test_server::{
        CountingSink, Reply, Responder, TestServer, board_accepted, board_answer, board_form,
        contact, method_not_found, open_test_server, test_client, text_result, track_call,
    };

    /// A 2025-11-25 server with no tasks, the stdio window's, whose `tools/call` is `call`.
    fn plain_v1_server(call: fn() -> Reply) -> Responder {
        Box::new(move |method, _params| match method {
            "initialize" => Reply::Answer(json!({ "result": {
                "protocolVersion": "2025-11-25",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "tracker", "version": "1.0.0" },
            } })),
            "tools/call" => call(),
            _ => method_not_found(),
        })
    }

    /// Writes `message` from the server, unasked.
    fn send(server: &TestServer, message: &Value) {
        server
            .unasked
            .send(message.to_string())
            .expect("the server is running");
    }

    // A question the person holds past the idle window keeps its call waiting, with no cancel and
    // the contact untouched, until the answer ends it. Mutations: send the call with rmcp's idle
    // timeout; leave out the open question's guard in `create_elicitation`; write `Lost` on a
    // plain call.
    #[tokio::test(start_paused = true)]
    async fn a_question_held_past_the_idle_window_never_cancels_its_call() {
        let (client, card) = test_client();
        let (connection, server) = open_test_server(
            &client,
            plain_v1_server(|| Reply::AskFirst {
                request: json!({ "method": "elicitation/create", "params": board_form() }),
                then: json!({ "result": text_result("tracked") }),
            }),
        )
        .await;
        let sink = CountingSink::new(&server);
        let contact = contact();
        let call = connection.call_tool(track_call(), &sink, &contact);
        tokio::pin!(call);

        tokio::select! {
            _ = &mut call => panic!("the call ended while its question was open"),
            () = sleep(STDIO_TOOL_CALL_IDLE_TIMEOUT + Duration::from_mins(1)) => {}
        }

        assert_eq!(server.requests("notifications/cancelled"), Vec::new());
        assert_eq!(*contact.borrow(), McpTaskContact::Reached);
        let (end, _question) = tokio::join!(&mut call, card.answer_open(board_answer()));
        assert!(matches!(
            end.expect("the call ends"),
            McpToolCallEnd::Answered { .. }
        ));
        let answer = server.answer_to("server-1").expect("the client answered");
        assert_eq!(answer["result"], board_accepted());
    }

    // The window stands still while the question is open and starts again in full at its answer:
    // a server that asks at 2 min and never replies has its call end one whole window after the
    // answer, then told once that the call is canceled. Mutations: never lift the hold (the call
    // waits for the total bound); resume the window with what was left (it ends 2 min early);
    // time the window from the call's start (it ends at the answer).
    #[tokio::test(start_paused = true)]
    async fn the_idle_window_starts_again_in_full_once_the_question_is_answered() {
        let (client, card) = test_client();
        let (connection, server) =
            open_test_server(&client, plain_v1_server(|| Reply::Silent)).await;
        let sink = CountingSink::new(&server);
        let contact = contact();
        let started = Instant::now();
        let call = connection.call_tool(track_call(), &sink, &contact);
        tokio::pin!(call);
        tokio::select! {
            _ = &mut call => panic!("the call ended before its server asked"),
            () = sleep_until(started + Duration::from_mins(2)) => {}
        }
        send(
            &server,
            &json!({
                "jsonrpc": "2.0",
                "id": "server-1",
                "method": "elicitation/create",
                "params": board_form(),
            }),
        );
        tokio::select! {
            _ = &mut call => panic!("the call ended while its question was open"),
            () = sleep_until(started + Duration::from_mins(40)) => {}
        }
        tokio::select! {
            _ = &mut call => panic!("the call ended while its question was open"),
            _question = card.answer_open(board_answer()) => {}
        }
        let answered_at = Instant::now();

        let end = (&mut call).await;

        assert_eq!(answered_at.elapsed(), STDIO_TOOL_CALL_IDLE_TIMEOUT);
        let Err(McpToolCallError::Service(ServiceError::Timeout { timeout })) = end else {
            panic!("the call's idle window runs out");
        };
        assert_eq!(timeout, STDIO_TOOL_CALL_IDLE_TIMEOUT);
        // The cancel goes out from a task of its own once the call stops waiting.
        sleep(Duration::from_secs(1)).await;
        let call_id = server.requests("tools/call")[0].1["id"].clone();
        let canceled = server.requests("notifications/cancelled");
        assert_eq!(canceled.len(), 1);
        assert_eq!(canceled[0].1["params"]["requestId"], call_id);
    }

    // Progress for the call's token starts its window again, so a reply 10 min past the window
    // still ends the call answered. Mutation: leave out `on_progress` or the token's watch.
    #[tokio::test(start_paused = true)]
    async fn progress_on_a_call_starts_its_idle_window_again() {
        let (client, _card) = test_client();
        let (connection, server) =
            open_test_server(&client, plain_v1_server(|| Reply::Silent)).await;
        let sink = CountingSink::new(&server);
        let contact = contact();
        let started = Instant::now();
        let call = connection.call_tool(track_call(), &sink, &contact);
        tokio::pin!(call);
        tokio::select! {
            _ = &mut call => panic!("the call ended before its window ran out"),
            () = sleep_until(started + STDIO_TOOL_CALL_IDLE_TIMEOUT - Duration::from_mins(1)) => {}
        }
        let request = server.requests("tools/call")[0].1.clone();
        send(
            &server,
            &json!({
                "jsonrpc": "2.0",
                "method": "notifications/progress",
                "params": {
                    "progressToken": request["params"]["_meta"]["progressToken"],
                    "progress": 1,
                },
            }),
        );
        tokio::select! {
            _ = &mut call => panic!("the call ended though its server reported progress"),
            () = sleep_until(started + STDIO_TOOL_CALL_IDLE_TIMEOUT + Duration::from_mins(10)) => {}
        }
        send(
            &server,
            &json!({ "jsonrpc": "2.0", "id": request["id"], "result": text_result("tracked") }),
        );

        assert!(matches!(
            call.await.expect("the call ends"),
            McpToolCallEnd::Answered { .. }
        ));
    }
}
