//! The tool calls in flight on one connection, each with the run that made it, so a question the
//! server asks outside a task goes on the card under the run of the call it belongs to: the one in
//! flight, or the newest when several are. A question a call asked and nobody answered is withdrawn
//! when the call ends or is dropped, or when the server cancels the request that asked it.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use sidekicks_contracts::run::id::RunId;

use crate::mcp::client::connection::McpConnectionScope;
use crate::mcp::client::tasks::{
    AwaitedQuestion, ElicitationAnswer, McpToolCall, QuestionOutcome, TaskWatches, compose_question,
};
use crate::mutex_lock::lock;

/// The calls in flight on one connection: one entry per call until it ends or is dropped, each
/// holding its questions until they settle.
#[derive(Default)]
pub(super) struct CallsInFlight {
    calls: Mutex<Vec<CallInFlight>>,
    next_call: AtomicU64,
}

struct CallInFlight {
    number: u64,
    run_id: RunId,
    /// The request ids of the questions the call asked that the card took.
    open_questions: Vec<String>,
}

/// One call while it is in flight; finished or dropped, it forgets the call and withdraws its
/// questions still open.
pub(super) struct TrackedCall<'calls> {
    calls: &'calls CallsInFlight,
    scope: &'calls McpConnectionScope,
    number: u64,
}

impl CallsInFlight {
    /// Tracks `call` on `scope`'s connection until the returned value is finished or dropped.
    pub(super) fn track<'calls>(
        &'calls self,
        call: &McpToolCall,
        scope: &'calls McpConnectionScope,
    ) -> TrackedCall<'calls> {
        let number = self.next_call.fetch_add(1, Ordering::Relaxed);
        lock(&self.calls).push(CallInFlight {
            number,
            run_id: call.run_id,
            open_questions: Vec::new(),
        });
        TrackedCall {
            calls: self,
            scope,
            number,
        }
    }

    /// Asks the elicitation `params` the server sent outside a task, under the newest call in
    /// flight, and waits for the person's answer. `None` when no call is in flight, so no run can
    /// be asked.
    pub(super) async fn ask_newest_call(
        &self,
        scope: &McpConnectionScope,
        params: Value,
    ) -> Option<QuestionOutcome> {
        let number = lock(&self.calls).last()?.number;
        Some(self.ask(scope, number, params).await)
    }

    /// Asks the elicitation `params` under call `number`'s run and waits for the person's answer;
    /// withdrawn when the call ended or the card did not take it.
    async fn ask(&self, scope: &McpConnectionScope, number: u64, params: Value) -> QuestionOutcome {
        let watches: &TaskWatches = &scope.task_watches;
        let Some(run_id) = self.run_of(number) else {
            return QuestionOutcome::Withdrawn;
        };
        let request_id = watches.mint_request_id(scope, &format!("call-{number}"));
        let question = compose_question(scope, run_id, request_id.clone(), &params);
        let (answer, answered) = ElicitationAnswer::open(params);
        if !watches.take_question(scope, question, answer).await {
            return QuestionOutcome::Withdrawn;
        }
        let is_in_flight = lock(&self.calls)
            .iter_mut()
            .find(|call| call.number == number)
            .map(|call| call.open_questions.push(request_id.clone()))
            .is_some();
        // A call that ended while its question was taken leaves nothing to answer it.
        if !is_in_flight {
            watches.withdraw_questions_later(scope.session_id, vec![request_id]);
            return QuestionOutcome::Withdrawn;
        }
        let outcome = AwaitedQuestion::hold(watches, scope.session_id, request_id.clone())
            .answer(answered)
            .await;
        // Settled, it is no longer open, so the call's end has nothing to withdraw for it.
        if let Some(call) = lock(&self.calls)
            .iter_mut()
            .find(|call| call.number == number)
        {
            call.open_questions.retain(|open| *open != request_id);
        }
        outcome
    }

    fn run_of(&self, number: u64) -> Option<RunId> {
        lock(&self.calls)
            .iter()
            .find(|call| call.number == number)
            .map(|call| call.run_id)
    }
}

impl TrackedCall<'_> {
    /// Asks the elicitation `params` under this call's run, as a 2026-07-28 server's input
    /// request on the call itself asks, and waits for the person's answer.
    pub(super) async fn ask(&self, scope: &McpConnectionScope, params: Value) -> QuestionOutcome {
        self.calls.ask(scope, self.number, params).await
    }

    /// Stops tracking the call, withdrawing each of its questions still open on the card.
    pub(super) async fn finish(self) {
        let open_questions = self.forget();
        if !open_questions.is_empty() {
            self.scope
                .task_watches
                .withdraw_questions(self.scope.session_id, open_questions)
                .await;
        }
    }

    fn forget(&self) -> Vec<String> {
        let mut calls = lock(&self.calls.calls);
        let Some(place) = calls.iter().position(|call| call.number == self.number) else {
            return Vec::new();
        };
        calls.remove(place).open_questions
    }
}

impl Drop for TrackedCall<'_> {
    fn drop(&mut self) {
        let open_questions = self.forget();
        self.scope
            .task_watches
            .withdraw_questions_later(self.scope.session_id, open_questions);
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use tokio::time::Duration;

    use crate::mcp::client::tasks::McpToolCallEnd;
    use crate::mcp::client::test_server::{
        CountingSink, Reply, Responder, TestServer, board_accepted, board_answer, board_form,
        contact, method_not_found, open_test_server, test_client, text_result, track_call,
    };

    /// A 2025-11-25 server with no tasks whose `tools/call` asks for the board first.
    fn eliciting_v1_server() -> Responder {
        Box::new(|method, _params| match method {
            "initialize" => Reply::Answer(json!({ "result": {
                "protocolVersion": "2025-11-25",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "tracker", "version": "1.0.0" },
            } })),
            "tools/call" => Reply::AskFirst {
                request: json!({ "method": "elicitation/create", "params": board_form() }),
                then: json!({ "result": text_result("tracked") }),
            },
            _ => method_not_found(),
        })
    }

    /// A 2026-07-28 server with no tasks whose `tools/call` asks for the board in its first round.
    fn eliciting_v2_server() -> Responder {
        Box::new(|method, params| match method {
            "server/discover" => Reply::Answer(json!({ "result": {
                "resultType": "complete",
                "supportedVersions": ["2026-07-28"],
                "capabilities": { "tools": {} },
                "ttlMs": 0,
                "cacheScope": "private",
            } })),
            "tools/call" if params.get("inputResponses").is_none() => {
                Reply::Answer(json!({ "result": {
                    "resultType": "input_required",
                    "inputRequests": {
                        "k1": { "method": "elicitation/create", "params": board_form() },
                    },
                    "requestState": "round-1",
                } }))
            }
            "tools/call" => {
                let mut result = text_result("tracked");
                result["resultType"] = json!("complete");
                Reply::Answer(json!({ "result": result }))
            }
            _ => method_not_found(),
        })
    }

    fn v1_answer(server: &TestServer) -> Value {
        server.answer_to("server-1").expect("the client answered")["result"].clone()
    }

    fn v2_answer(server: &TestServer) -> Value {
        let calls = server.requests("tools/call");
        assert_eq!(
            calls.len(),
            2,
            "one round asks, the next carries the answer"
        );
        assert_eq!(calls[1].1["params"]["requestState"], "round-1");
        calls[1].1["params"]["inputResponses"]["k1"].clone()
    }

    // Mutations: in `connection.rs`'s `create_elicitation`, answer `cancel` instead of asking
    // `ask_newest_call`; in `CallsInFlight::track`, record another run; or in `v2::call_tool`,
    // fail an `InputRequired` round instead of answering it.
    #[rstest]
    #[case::a_2025_11_25_request(eliciting_v1_server(), v1_answer)]
    #[case::a_2026_07_28_input_round(eliciting_v2_server(), v2_answer)]
    #[tokio::test]
    async fn a_plain_calls_question_reaches_the_card_under_its_run(
        #[case] responder: Responder,
        #[case] server_answer: fn(&TestServer) -> Value,
    ) {
        let (client, card) = test_client();
        let (connection, server) = open_test_server(&client, responder).await;
        let call = track_call();
        let run_id = call.run_id;
        let sink = CountingSink::new(&server);
        let contact = contact();

        let (end, question) = tokio::join!(
            connection.call_tool(call, &sink, &contact),
            card.answer_open(board_answer()),
        );

        let McpToolCallEnd::Answered { result } = end.expect("the call ends") else {
            panic!("the call is answered");
        };
        assert_eq!(result["content"], text_result("tracked")["content"]);
        assert_eq!(
            (question.session_id, question.run_id),
            (server.session_id, run_id)
        );
        assert_eq!(server_answer(&server), board_accepted());
        assert!(sink.recorded().is_empty(), "a plain call records no task");
    }

    // Mutation: in `TaskWatches::take_question`, await the card's take inline instead of in a
    // task of its own; the server's cancel then drops the take after the card wrote it, and the
    // question stays open with nobody to answer it.
    #[tokio::test(start_paused = true)]
    async fn a_question_whose_request_is_canceled_while_the_card_takes_it_is_withdrawn() {
        let (client, card) = test_client();
        let gate = card.hold_takes();
        let (connection, server) = open_test_server(&client, eliciting_v1_server()).await;
        let sink = CountingSink::new(&server);
        let contact = contact();
        let call = connection.call_tool(track_call(), &sink, &contact);
        tokio::pin!(call);

        tokio::select! {
            _ = &mut call => panic!("the call ended before its question was taken"),
            () = card.wait_until_taken(1) => {}
        }
        let canceled = json!({
            "jsonrpc": "2.0",
            "method": "notifications/cancelled",
            "params": { "requestId": "server-1" },
        });
        server
            .unasked
            .send(canceled.to_string())
            .expect("the server is running");
        // The cancel is read before the clock moves, and drops the question being asked.
        tokio::select! {
            _ = &mut call => panic!("the call ended while its server waited on its question"),
            () = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
        gate.notify_one();

        tokio::select! {
            _ = &mut call => panic!("the call ended while its server waited on its question"),
            () = card.wait_until_none_open() => {}
        }
        assert_eq!(card.taken().len(), 1);
    }

    // Mutation: in `CallsInFlight::ask`, await the withdrawal of a question whose call ended
    // while the card took it, instead of handing it to a task of its own; the server's cancel then
    // drops the withdrawal while the card writes it, and the question stays open.
    #[tokio::test(start_paused = true)]
    async fn a_question_whose_call_ended_while_the_card_took_it_is_withdrawn_despite_a_cancel() {
        let (client, card) = test_client();
        let take_gate = card.hold_takes();
        let withdraw_gate = card.hold_withdrawals();
        let (connection, server) = open_test_server(&client, eliciting_v1_server()).await;
        let sink = CountingSink::new(&server);
        let contact = contact();
        let call = connection.call_tool(track_call(), &sink, &contact);
        tokio::pin!(call);
        tokio::select! {
            _ = &mut call => panic!("the call ended before its question was taken"),
            () = card.wait_until_taken(1) => {}
        }

        // The server answers the call while the card still takes the call's question.
        let call_id = server.requests("tools/call")[0].1["id"].clone();
        let answered = json!({ "jsonrpc": "2.0", "id": call_id, "result": text_result("tracked") });
        server
            .unasked
            .send(answered.to_string())
            .expect("the server is running");
        let end = call.await.expect("the call ends");
        assert!(matches!(end, McpToolCallEnd::Answered { .. }));
        take_gate.notify_one();
        // The take's outcome is read before the clock moves, so the withdrawal waits on the card
        // when the server cancels the request that asked.
        tokio::time::sleep(Duration::from_secs(1)).await;
        let canceled = json!({
            "jsonrpc": "2.0",
            "method": "notifications/cancelled",
            "params": { "requestId": "server-1" },
        });
        server
            .unasked
            .send(canceled.to_string())
            .expect("the server is running");
        tokio::time::sleep(Duration::from_secs(1)).await;
        withdraw_gate.notify_one();

        card.wait_until_none_open().await;
    }
}
