//! A call to a 2026-07-28 server, or to any server that offers no 2025-11-25 task for the tool,
//! through rmcp's own types: the server answers a result, a task, or a request for input before
//! it goes on. Input asked of the call itself is answered round by round on the questions card,
//! as rmcp's own helper drives the rounds; a task is polled with `tasks/get` until its result
//! arrives inline, and each of its `inputRequests` that is an elicitation is asked on the card and
//! answered with `tasks/update`.
//!
//! - Input the client does not take is answered as rmcp's own client answers it: a roots request
//!   with an empty list, and sampling with method-not-found, which fails a call; a task has no
//!   way to carry that error back, so it is canceled instead of left waiting until its TTL, before
//!   any of its other requests is asked, so none flashes on the card.
//! - A task's input requests past the first 16 are ignored, as Claude Code ignores them.

use std::collections::BTreeMap;
use std::error::Error;
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, DEFAULT_MRTR_MAX_ROUNDS, ElicitRequest, InputRequest,
    InputRequests, InputResponses, TaskPayload, UpdateTaskParams,
};
use rmcp::service::ServiceError;
use serde_json::{Value, json};
use sidekicks_contracts::question::QuestionAnswer;
use sidekicks_contracts::run::id::RunId;
use sidekicks_provider::mcp::elicitation_form::compose_elicitation_content;
use sidekicks_provider::port::question::{ToolServerAnswerDelivery, ToolServerQuestionAnswer};
use tokio::sync::watch;

use crate::client::calls::TrackedCall;
use crate::client::connection::McpServerConnection;
use crate::client::connection::standing::McpStandingConnection;
use crate::client::poll::{PollStep, follow_task as poll_until_end};
use crate::client::tasks::watches::{QuestionOutcome, QuestionTake, TaskWatch};
use crate::client::tasks::{
    McpServerEndpoint, McpTaskContact, McpTaskGeneration, McpTaskHandleSink, McpToolCall,
    McpToolCallEnd, McpToolCallError, observe_mcp_task_acceptance,
};

/// The most input requests of one task the client answers; the rest are ignored.
const MAX_TASK_INPUT_REQUESTS: usize = 16;

/// Calls `call`'s tool, answering its rounds of input and following a task to its end, whose
/// answers go over `standing`'s live connection. Fails as a round fails, when the server asks for
/// sampling or more rounds than a call drives, or answers another request's result.
pub(super) async fn call_tool(
    connection: &McpServerConnection,
    standing: &McpStandingConnection,
    in_flight: &TrackedCall<'_>,
    call: McpToolCall,
    sink: &dyn McpTaskHandleSink,
    contact: &watch::Sender<McpTaskContact>,
) -> Result<McpToolCallEnd, McpToolCallError> {
    let mut params = CallToolRequestParams::new(call.dispatch.tool_name.clone());
    params.arguments.clone_from(&call.arguments);
    let mut state_only_rounds = 0;
    for _round in 0..DEFAULT_MRTR_MAX_ROUNDS {
        let response = connection
            .requests
            .call_tool_once(params.clone())
            .await
            .map_err(McpToolCallError::Service)?;
        let input = match response {
            CallToolResponse::Task(created) => {
                let mcp_task_id = created.task.task_id;
                if mcp_task_id.is_empty() {
                    return Err(McpToolCallError::AcceptanceWithoutHandle);
                }
                observe_mcp_task_acceptance(
                    sink,
                    connection,
                    call.dispatch.clone(),
                    McpTaskGeneration::V2,
                    &mcp_task_id,
                )
                .await;
                return Ok(
                    follow_task(connection, standing, call.run_id, &mcp_task_id, contact).await,
                );
            }
            CallToolResponse::Complete(result) => {
                let Value::Object(result) = serde_json::to_value(result)
                    .map_err(|_unwritable| McpToolCallError::UnexpectedResult)?
                else {
                    return Err(McpToolCallError::UnexpectedResult);
                };
                return Ok(McpToolCallEnd::Answered { result });
            }
            CallToolResponse::InputRequired(input) => input,
            _ => return Err(McpToolCallError::UnexpectedResult),
        };
        let requests = input.input_requests.unwrap_or_default();
        if requests.is_empty() {
            // A round that only carries the server's state is retried after a short, growing wait,
            // as rmcp's helper does, so a busy server is not asked again at once.
            let wait = (50_u64 << state_only_rounds.min(3)).min(250);
            tokio::time::sleep(Duration::from_millis(wait)).await;
            state_only_rounds += 1;
        } else {
            state_only_rounds = 0;
        }
        let responses = answer_call_input(connection, in_flight, requests).await?;
        params.input_responses = (!responses.is_empty()).then_some(responses);
        params.request_state = input.request_state;
    }
    Err(McpToolCallError::InputRoundsExceeded {
        max_rounds: DEFAULT_MRTR_MAX_ROUNDS,
    })
}

/// The answers to one round of input asked of the call itself, each elicitation asked on the card
/// under the call's run in turn and a roots request answered with an empty list. Fails on
/// sampling, as rmcp's own client fails a call its default method-not-found answers.
#[expect(
    clippy::wildcard_enum_match_arm,
    reason = "rmcp marks the input request non-exhaustive, so a later kind is named by the wildcard"
)]
async fn answer_call_input(
    connection: &McpServerConnection,
    in_flight: &TrackedCall<'_>,
    requests: InputRequests,
) -> Result<InputResponses, McpToolCallError> {
    let mut responses = InputResponses::new();
    for (key, request) in requests {
        let elicitation = match request {
            InputRequest::Elicitation(elicitation) => elicitation,
            InputRequest::ListRoots(_) => {
                responses.insert(key, empty_roots());
                continue;
            }
            _ => return Err(McpToolCallError::UnsupportedInputRequest),
        };
        let params = serde_json::to_value(&elicitation.params)
            .map_err(|_unwritable| McpToolCallError::UnexpectedResult)?;
        let response = match in_flight.ask(&connection.scope, params).await {
            QuestionOutcome::Answered(content) => {
                json!({ "action": "accept", "content": Value::Object(content) })
            }
            QuestionOutcome::Withdrawn => json!({ "action": "cancel" }),
        };
        responses.insert(key, response);
    }
    Ok(responses)
}

/// rmcp's own client's answer to a roots request: an empty list.
fn empty_roots() -> Value {
    json!({ "roots": [] })
}

/// Follows run `run_id`'s task `mcp_task_id` to its end, its questions asked in that run and
/// answered over `standing`'s live connection; a follow on a server at an address that its
/// connection's close cut leaves its watch, with the keys asked, to be re-bound.
pub(super) async fn follow_task(
    connection: &McpServerConnection,
    standing: &McpStandingConnection,
    run_id: RunId,
    mcp_task_id: &str,
    contact: &watch::Sender<McpTaskContact>,
) -> McpToolCallEnd {
    let watch =
        connection
            .scope
            .task_watches
            .watch(&connection.scope, run_id, mcp_task_id, contact);
    let end = poll_until_end(&watch.wake, &watch.contact, |_| {
        poll_once(connection, standing, mcp_task_id, &watch)
    })
    .await;
    watch.end(&end, connection.task_endpoint()).await;
    end
}

/// One poll: the task's state, answering each of its first 16 input requests not asked yet in
/// `watch`, or canceling the task when one of them is a kind the client does not take.
#[expect(
    clippy::wildcard_enum_match_arm,
    reason = "rmcp marks the input request non-exhaustive, so its kinds cannot all be named"
)]
async fn poll_once(
    connection: &McpServerConnection,
    standing: &McpStandingConnection,
    mcp_task_id: &str,
    watch: &TaskWatch<'_>,
) -> Result<PollStep, ServiceError> {
    let reply = connection.requests.get_task(mcp_task_id).await?;
    let suggested_interval_ms = reply.task.task.poll_interval_ms;
    let input_requests = match read_terminal_payload(reply.task.payload) {
        Ok(end) => return Ok(PollStep::End(end)),
        Err(TaskPayload::InputRequired { input_requests }) => input_requests,
        // `working`, and any state a later rmcp adds to its open set, waits for the next poll.
        Err(_) => {
            return Ok(PollStep::Wait {
                suggested_interval_ms,
            });
        }
    };
    if input_requests.len() > MAX_TASK_INPUT_REQUESTS {
        tracing::warn!(
            server = connection.scope.server_name.as_str(),
            count = input_requests.len(),
            "a tool server task asked for input past the first 16; the rest are ignored"
        );
    }
    let mut taken = Vec::new();
    for (key, request) in input_requests.into_iter().take(MAX_TASK_INPUT_REQUESTS) {
        match request {
            InputRequest::Elicitation(elicitation) => {
                taken.push((key, TaskInput::Elicitation(Box::new(elicitation))));
            }
            InputRequest::ListRoots(_) => taken.push((key, TaskInput::Roots)),
            // Sampling, and any request a later rmcp adds: the task is canceled before anything
            // else it asks reaches the card, and the next poll reads its end.
            _ => {
                cancel_for_unsupported_input(connection, mcp_task_id).await;
                return Ok(PollStep::Wait {
                    suggested_interval_ms,
                });
            }
        }
    }
    for (key, input) in taken {
        // A request the card refused, as a run already waiting on a question refuses one, is
        // asked again on a later poll.
        if !watch.is_asked(&key)
            && answer_input_request(connection, standing, mcp_task_id, &key, input).await
        {
            watch.mark_asked(&key);
        }
    }
    Ok(PollStep::Wait {
        suggested_interval_ms,
    })
}

/// The end of task `mcp_task_id` from one `tasks/get`, as its follow reads a terminal state;
/// `None` for any other state. Fails as the request fails.
pub(super) async fn read_task_end(
    connection: &McpServerConnection,
    mcp_task_id: &str,
) -> Result<Option<McpToolCallEnd>, ServiceError> {
    let reply = connection.requests.get_task(mcp_task_id).await?;
    Ok(read_terminal_payload(reply.task.payload).ok())
}

/// The end a terminal task payload carries; any other payload is handed back.
#[expect(
    clippy::wildcard_enum_match_arm,
    reason = "rmcp marks the task payload non-exhaustive, so its open states cannot all be named"
)]
fn read_terminal_payload(payload: TaskPayload) -> Result<McpToolCallEnd, TaskPayload> {
    match payload {
        TaskPayload::Completed { result } => Ok(McpToolCallEnd::Answered { result }),
        TaskPayload::Failed { error } => Ok(McpToolCallEnd::Failed { error }),
        TaskPayload::Cancelled => Ok(McpToolCallEnd::Canceled),
        open => Err(open),
    }
}

/// One input request of a task the client takes.
enum TaskInput {
    /// An elicitation, asked on the questions card.
    Elicitation(Box<ElicitRequest>),
    /// A roots request, answered with an empty list.
    Roots,
}

/// Cancels task `mcp_task_id`, which asked for input the client does not take; a failed cancel is
/// logged and tried again at the next poll that reads the request.
async fn cancel_for_unsupported_input(connection: &McpServerConnection, mcp_task_id: &str) {
    tracing::warn!(
        server = connection.scope.server_name.as_str(),
        "a tool server task asked for input the client does not take; canceled"
    );
    if let Err(error) = connection.requests.cancel_v2_task(mcp_task_id).await {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "a tool server task asking for input the client does not take was not canceled"
        );
    }
}

/// Answers one input request of the task: an elicitation's form asked on the questions card and
/// answered over `standing`'s live connection, a roots request answered with an empty list over
/// the polling connection; true once it needs no answer again.
async fn answer_input_request(
    connection: &McpServerConnection,
    standing: &McpStandingConnection,
    mcp_task_id: &str,
    key: &str,
    input: TaskInput,
) -> bool {
    let elicitation = match input {
        TaskInput::Elicitation(elicitation) => elicitation,
        TaskInput::Roots => {
            let params = input_response(mcp_task_id, key, empty_roots());
            return match connection.requests.update_task(params).await {
                Ok(()) => true,
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "a tool server task's roots request was not answered"
                    );
                    false
                }
            };
        }
    };
    let params = match serde_json::to_value(&elicitation.params) {
        Ok(params) => params,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a tool server task's question could not be read"
            );
            return false;
        }
    };
    let answer = Arc::new(V2TaskAnswer {
        standing: standing.clone(),
        endpoint: connection.task_endpoint().clone(),
        mcp_task_id: mcp_task_id.to_owned(),
        key: key.to_owned(),
        params: params.clone(),
    });
    connection
        .scope
        .task_watches
        .ask(
            &connection.scope,
            mcp_task_id,
            &params,
            answer,
            QuestionTake::Now,
            None,
        )
        .await
        .is_some_and(|taken| taken.is_some())
}

/// The `tasks/update` carrying `response` to task `mcp_task_id`'s input request `key`.
fn input_response(mcp_task_id: &str, key: &str, response: Value) -> UpdateTaskParams {
    UpdateTaskParams::new(mcp_task_id, BTreeMap::from([(key.to_owned(), response)]))
}

/// The answer to one input request of a 2026-07-28 task, sent as `tasks/update` over the live
/// connection of the endpoint that accepted the task.
struct V2TaskAnswer {
    standing: McpStandingConnection,
    endpoint: McpServerEndpoint,
    mcp_task_id: String,
    key: String,
    params: Value,
}

impl ToolServerQuestionAnswer for V2TaskAnswer {
    fn answer(
        &self,
        answers: Vec<QuestionAnswer>,
    ) -> BoxFuture<'_, Result<ToolServerAnswerDelivery, Box<dyn Error + Send + Sync>>> {
        let content = compose_elicitation_content(&self.params, &answers);
        let response = json!({ "action": "accept", "content": Value::Object(content) });
        let params = input_response(&self.mcp_task_id, &self.key, response);
        self.send(params).boxed()
    }
}

impl V2TaskAnswer {
    /// Sends `params` over the live connection of the task's endpoint, and once more over a
    /// connection a Reconnect put in place of one that closed under it; a sent answer is
    /// delivered. Fails at once, sending nothing, when no connection of the endpoint is live, and
    /// as the request fails otherwise.
    async fn send(
        &self,
        params: UpdateTaskParams,
    ) -> Result<ToolServerAnswerDelivery, Box<dyn Error + Send + Sync>> {
        let connection = self.standing.live(&self.endpoint)?;
        let sent = connection.requests.update_task(params.clone()).await;
        if matches!(sent, Err(ServiceError::TransportClosed)) {
            let replacement = self.standing.live(&self.endpoint)?;
            if !Arc::ptr_eq(&replacement, &connection) {
                replacement.requests.update_task(params).await?;
                return Ok(ToolServerAnswerDelivery::Delivered);
            }
        }
        sent?;
        Ok(ToolServerAnswerDelivery::Delivered)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, Value, json};
    use tokio::time::{Duration, timeout};

    use crate::client::tasks::{McpTaskGeneration, McpToolCallEnd};
    use crate::client::test_server::{
        CountingSink, TestServer, board_accepted, board_answer, board_form,
        call_tool_as_dispatched, completed, contact, input_required, open_test_server, test_client,
        track_call, track_task_handle, tracked_end, v2_task_server,
    };

    fn updates(server: &TestServer) -> Vec<Value> {
        server
            .requests("tasks/update")
            .into_iter()
            .map(|(_, request)| request["params"].clone())
            .collect()
    }

    // Mutations: move `observe_mcp_task_acceptance` after `follow_task`; in `poll_once`, drop
    // the `asked` check, which asks k1 again, or insert a key into `asked` before its question is
    // taken, or ignore the take's answer, so k2, refused while the run waits on k1, is never asked
    // again; or in `V2TaskAnswer::answer`, send the answer under another key or without `taskId`.
    #[tokio::test(start_paused = true)]
    async fn a_2026_07_28_task_records_its_handle_and_asks_each_input_once_in_turn_by_update() {
        let (client, card) = test_client();
        let (connection, server) = open_test_server(
            &client,
            // Waiting on both through the second poll, so a key asked again shows there.
            v2_task_server(|poll, updates, _| {
                if poll <= 2 || updates < 2 {
                    input_required(&["k1", "k2"])
                } else {
                    completed()
                }
            }),
        )
        .await;
        let call = track_call();
        let run_id = call.run_id;
        let sink = CountingSink::new(&server);
        let contact = contact();
        // The person answers k1 only after the first poll, in which the run waiting on k1 refused
        // k2.
        let person = async {
            card.wait_until_taken(1).await;
            tokio::time::sleep(Duration::from_secs(1)).await;
            let first = card.answer_open(board_answer()).await;
            let second = card.answer_open(board_answer()).await;
            (first, second)
        };

        let (end, (first, second)) = timeout(Duration::from_secs(600), async {
            tokio::join!(
                call_tool_as_dispatched(&connection, call, &sink, &contact),
                person
            )
        })
        .await
        .expect("both questions are asked and the task ends");

        assert_eq!(end.expect("the call ends"), tracked_end());
        assert_eq!(
            sink.recorded(),
            vec![(0, track_task_handle(McpTaskGeneration::V2))],
            "the handle is recorded before the first poll"
        );
        assert_eq!(card.taken().len(), 2, "no input is asked twice");
        assert_eq!((first.run_id, second.run_id), (run_id, run_id));
        assert_ne!(first.request_id, second.request_id);
        let updates = updates(&server);
        assert_eq!(updates.len(), 2);
        for (update, key) in updates.iter().zip(["k1", "k2"]) {
            assert_eq!(update["taskId"], "task-1");
            assert_eq!(
                update["inputResponses"][key],
                board_accepted(),
                "k2 is answered after k1"
            );
        }
        assert_eq!(server.requests("tasks/get").len(), 3);
    }

    /// The keys of every `tasks/update` answer `server` received, each with its answer, in key
    /// order.
    fn answered_inputs(server: &TestServer) -> Vec<(String, Value)> {
        let mut answered: Vec<(String, Value)> = updates(server)
            .iter()
            .flat_map(|update| {
                update["inputResponses"]
                    .as_object()
                    .expect("the answers")
                    .clone()
            })
            .collect();
        answered.sort_by(|left, right| left.0.cmp(&right.0));
        answered
    }

    // Mutation: in `poll_once`, go on asking the task's other requests past the sampling one, or
    // cancel only once they are asked; "a", sorted before it, then reaches the card.
    #[tokio::test(start_paused = true)]
    async fn a_task_asking_for_sampling_is_canceled_before_any_of_its_input_is_asked() {
        let (client, card) = test_client();
        let mut requests = Map::new();
        requests.insert(
            "a".to_owned(),
            json!({ "method": "elicitation/create", "params": board_form() }),
        );
        requests.insert(
            "b".to_owned(),
            json!({ "method": "sampling/createMessage", "params": {
                "messages": [{ "role": "user", "content": { "type": "text", "text": "Hi" } }],
                "maxTokens": 10,
            } }),
        );
        requests.insert("c".to_owned(), json!({ "method": "roots/list" }));
        let waiting = json!({ "status": "input_required", "inputRequests": requests });
        let (connection, server) = open_test_server(
            &client,
            v2_task_server(move |_, _, cancels| {
                if cancels == 0 {
                    waiting.clone()
                } else {
                    json!({ "status": "cancelled" })
                }
            }),
        )
        .await;
        let sink = CountingSink::new(&server);
        let contact = contact();

        let end = timeout(
            Duration::from_secs(60),
            call_tool_as_dispatched(&connection, track_call(), &sink, &contact),
        )
        .await
        .expect("the canceled task ends");

        assert_eq!(end.expect("the call ends"), McpToolCallEnd::Canceled);
        assert_eq!(server.requests("tasks/cancel").len(), 1);
        assert!(
            updates(&server).is_empty(),
            "nothing is answered to a task canceled"
        );
        assert!(card.taken().is_empty(), "no request reaches the card");
    }

    // Mutations: in `poll_once`, drop the 16-request cap, or leave a roots request unanswered.
    #[tokio::test(start_paused = true)]
    async fn a_tasks_roots_are_answered_empty_and_its_input_past_16_is_ignored() {
        let (client, _card) = test_client();
        let mut requests = Map::new();
        for number in 0..17 {
            requests.insert(format!("r{number:02}"), json!({ "method": "roots/list" }));
        }
        let waiting = json!({ "status": "input_required", "inputRequests": requests });
        let (connection, server) = open_test_server(
            &client,
            v2_task_server(move |_, updates, _| {
                if updates < 16 {
                    waiting.clone()
                } else {
                    completed()
                }
            }),
        )
        .await;
        let sink = CountingSink::new(&server);
        let contact = contact();

        let end = timeout(
            Duration::from_secs(60),
            call_tool_as_dispatched(&connection, track_call(), &sink, &contact),
        )
        .await
        .expect("the task ends");

        assert_eq!(end.expect("the call ends"), tracked_end());
        let expected: Vec<(String, Value)> = (0..16)
            .map(|number| (format!("r{number:02}"), json!({ "roots": [] })))
            .collect();
        assert_eq!(
            answered_inputs(&server),
            expected,
            "r16, past the cap, is never answered"
        );
    }
}
