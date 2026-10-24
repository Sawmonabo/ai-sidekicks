//! Codex's faster-model retry: a turn Codex holds for a safety check is stopped, the conversation
//! forked to just before it, and the same message sent again on the faster model, which stays the
//! session's model. The run goes on in the new turn under its binding; nothing is drawn twice. An
//! interrupt of the run while it retries stops the retry, which then forks and sends nothing more;
//! one that comes once the fork has begun leaves the session on the fork, since the conversation
//! it left is already let go, and sends the turn only when it comes too late to keep it back.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use tokio_util::sync::CancellationToken;

use crate::mutex_lock::lock;
use crate::provider::driver::codex::notification_routing::CodexRoutedFrames;
use crate::provider::driver::codex::run::control::fail_codex_run;
use crate::provider::driver::codex::run::routes::{CodexRunBinding, CodexRunRoutes};
use crate::provider::driver::codex::run::start::record::{
    CodexRunCallDependencies, CodexTurnRequest,
};
use crate::provider::driver::codex::run::start::{CODEX_TURN_START_TIMEOUT, CodexRunStart};
use crate::provider::driver::codex::run::turn_end_waiters::{CodexTurnEndDeadline, CodexTurnWait};
use crate::provider::driver::codex::run::turn_interrupt::interrupt_codex_turn;
use crate::provider::driver::codex::session::calls::{
    CodexSessionTask, call_codex_session, wait_for_codex_turns,
};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::fork::{CodexForkDependencies, establish_codex_fork};
use crate::provider::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInboundSender,
};
use crate::provider::driver::codex::session::slots::CodexSessionSlots;
use crate::provider::driver::codex::session::state::{CodexSessionRecord, CodexTurnInput};
use crate::provider::driver::codex::transport::connection::CodexAppServerConnection;
use crate::provider::driver::run_control::{FasterModelRetryOutcome, FasterModelRetryParams};
use crate::session::run::inbound::RunInboundDispatch;

const NOT_LATEST_REJECTION: &str = "The turn is no longer the run's latest.";
const REPLY_STARTED_REJECTION: &str = "The turn's reply has started.";
const INTERRUPTED_REJECTION: &str = "The run was interrupted.";
const RETRY_FAILED: &str = "Failed to retry with a faster model";

/// How the session's task took a retry's stop of its held turn.
pub(crate) enum CodexRetryStopAnswer {
    /// The turn is marked retried and its route taken; its interrupt goes next.
    Stopping(CodexRetryStop),
    /// The turn cannot be retried, for this reason.
    Rejected(&'static str),
    /// The service has no connection to stop the turn on.
    Failed(CodexError),
}

/// What a retry stops and sends again: the connection and conversation the held turn runs on, and
/// the turn's input.
pub(crate) struct CodexRetryStop {
    connection: Arc<CodexAppServerConnection>,
    thread_id: String,
    input: CodexTurnInput,
}

/// What the retry acts through.
pub(crate) struct CodexFasterModelRetryDependencies {
    /// The sessions' slots, which a retry's fork claims.
    pub(crate) slots: Arc<CodexSessionSlots>,
    /// The driver's run routes.
    pub(crate) run_routes: Arc<CodexRunRoutes>,
    /// The run start, which sends the turn again.
    pub(crate) run_start: Arc<CodexRunStart>,
    /// The run engine's dispatch, which takes the failed run's end.
    pub(crate) dispatch: Arc<RunInboundDispatch>,
}

/// A retry an interrupt stopped: its session, and the conversation its held turn ran on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexStoppedRetry {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The conversation the held turn ran on.
    pub(crate) held_thread_id: String,
}

/// Retries held turns on a faster model, and stops a retry its run's interrupt reaches.
pub(crate) struct CodexFasterModelRetries {
    dependencies: CodexFasterModelRetryDependencies,
    in_flight_by_run: Mutex<HashMap<RunId, Arc<CodexRetryInFlight>>>,
}

// One retry in flight: its session, the conversation its held turn ran on, its end, and whether it
// was stopped. The stop is shared with the turn's start, which the session's task refuses once it
// is set.
struct CodexRetryInFlight {
    inbound: CodexSessionInboundSender,
    held_thread_id: String,
    settled: CancellationToken,
    is_canceled: Arc<AtomicBool>,
}

impl CodexFasterModelRetries {
    /// Retries acting through `dependencies`.
    pub(crate) fn new(dependencies: CodexFasterModelRetryDependencies) -> Self {
        Self {
            dependencies,
            in_flight_by_run: Mutex::new(HashMap::new()),
        }
    }

    /// Retries a held turn on a faster model, answering `Applied` once `turn/start` on the fork
    /// answered a new turn. Answers `Rejected` when the turn is no longer the run's latest or its
    /// reply has started, and when an interrupt of the run stopped the retry. An interrupt that
    /// fails while the turn runs on leaves the turn the run's and fails; any later failure ends
    /// the run failed. Both fail with `Failed to retry with a faster model: <reason>`.
    pub(crate) async fn retry(
        &self,
        params: FasterModelRetryParams,
    ) -> Result<FasterModelRetryOutcome, CodexError> {
        let inbound = self.dependencies.slots.require_live(params.session_id)?;
        let Some(binding) = self.dependencies.run_routes.binding_for(params.run_id) else {
            return Ok(rejected(NOT_LATEST_REJECTION));
        };
        let stop = call_codex_session(&inbound, |reply| CodexSessionCall::StopTurnForRetry {
            run_id: params.run_id,
            turn_id: params.expected_turn_id.clone(),
            reply,
        })
        .await?;
        let stop = match stop {
            CodexRetryStopAnswer::Stopping(stop) => stop,
            CodexRetryStopAnswer::Rejected(reason) => return Ok(rejected(reason)),
            CodexRetryStopAnswer::Failed(error) => return Err(retry_failure(error)),
        };
        let in_flight = Arc::new(CodexRetryInFlight {
            inbound,
            held_thread_id: stop.thread_id.clone(),
            settled: CancellationToken::new(),
            is_canceled: Arc::new(AtomicBool::new(false)),
        });
        lock(&self.in_flight_by_run).insert(params.run_id, Arc::clone(&in_flight));
        let outcome = self.retry_stopped(&params, &in_flight, stop, binding).await;
        {
            let mut in_flight_by_run = lock(&self.in_flight_by_run);
            if in_flight_by_run
                .get(&params.run_id)
                .is_some_and(|kept| Arc::ptr_eq(kept, &in_flight))
            {
                in_flight_by_run.remove(&params.run_id);
            }
        }
        in_flight.settled.cancel();
        outcome
    }

    /// Stops the retry of `run_id` in flight, answering the session and the conversation its held
    /// turn ran on when that stopped the run: the retry forks and sends nothing more. The retry is
    /// waited for to its end, so the session is on its one conversation and the held turn has ended
    /// when this answers. Answers `None` with no retry in flight, and once a turn the retry kept or
    /// already sent runs as the run's, which the interrupt then stops as any live turn. Fails as
    /// the session's reading fails.
    pub(crate) async fn cancel(
        &self,
        run_id: RunId,
    ) -> Result<Option<CodexStoppedRetry>, CodexError> {
        let Some(in_flight) = lock(&self.in_flight_by_run).get(&run_id).map(Arc::clone) else {
            return Ok(None);
        };
        in_flight.is_canceled.store(true, Ordering::Release);
        in_flight.settled.cancelled().await;
        let reading =
            call_codex_session(&in_flight.inbound, |reply| CodexSessionCall::ReadSession {
                thread_id: None,
                reply,
            })
            .await?;
        Ok(
            (!reading.live_turn_runs.contains(&run_id)).then(|| CodexStoppedRetry {
                session_id: in_flight.inbound.session_id(),
                held_thread_id: in_flight.held_thread_id.clone(),
            }),
        )
    }

    async fn retry_stopped(
        &self,
        params: &FasterModelRetryParams,
        in_flight: &CodexRetryInFlight,
        stop: CodexRetryStop,
        binding: CodexRunBinding,
    ) -> Result<FasterModelRetryOutcome, CodexError> {
        let turn_id = &params.expected_turn_id;
        let interrupted = interrupt_codex_turn(&stop.connection, &stop.thread_id, turn_id).await;
        if let Err(error) = interrupted {
            // Not stopped: the turn runs on as the run's, so the retry is refused and the run is
            // not.
            let is_restored = call_codex_session(&in_flight.inbound, |reply| {
                CodexSessionCall::RestoreRetriedTurn {
                    run_id: params.run_id,
                    turn_id: turn_id.clone(),
                    reply,
                }
            })
            .await?;
            if is_restored {
                return Err(retry_failure(error));
            }
        }
        let sent = self
            .send_again(params, in_flight, stop.input, &binding.binding_id)
            .await;
        let is_canceled = in_flight.is_canceled.load(Ordering::Acquire);
        match sent {
            Ok(true) => Ok(FasterModelRetryOutcome::Applied {}),
            Ok(false) => {
                self.forget_stopped_run(params.run_id, &binding);
                Ok(rejected(INTERRUPTED_REJECTION))
            }
            Err(_) if is_canceled => {
                self.forget_stopped_run(params.run_id, &binding);
                Ok(rejected(INTERRUPTED_REJECTION))
            }
            Err(error) => {
                fail_codex_run(
                    &self.dependencies.dispatch,
                    params.run_id,
                    binding.binding_id,
                    RETRY_FAILED,
                    &error,
                )
                .await;
                self.dependencies.run_routes.forget_run(params.run_id);
                Err(retry_failure(error))
            }
        }
    }

    // Waits for the held turn's end, forks to just before it on the faster model and sends its
    // input again there; `false` when an interrupt stopped the retry first.
    async fn send_again(
        &self,
        params: &FasterModelRetryParams,
        in_flight: &CodexRetryInFlight,
        input: CodexTurnInput,
        binding_id: &RuntimeBindingId,
    ) -> Result<bool, CodexError> {
        let inbound = &in_flight.inbound;
        let turn_id = &params.expected_turn_id;
        let has_ended = wait_for_codex_turns(
            inbound,
            CodexTurnWait::End {
                turn_id: turn_id.clone(),
            },
            Some(&CodexTurnEndDeadline::for_request()),
        )
        .await?;
        if in_flight.is_canceled.load(Ordering::Acquire) {
            return Ok(false);
        }
        if !has_ended {
            return Err(CodexError::Transport {
                detail: "The held turn did not stop.".to_owned(),
                cause: None,
            });
        }
        // The fork carries the faster model on its default window, and every later start and
        // resume carries it too. The run's binding is pointed at the fork before the turn is sent,
        // so a resume after a restart finds the fork, never the held turn.
        let model = params.model.as_str().to_owned();
        {
            let _claim = self
                .dependencies
                .slots
                .claim_establishing(params.session_id)
                .await?;
            call_codex_session(inbound, |reply| CodexSessionCall::ForkForRetry {
                turn_id: turn_id.clone(),
                model: model.clone(),
                binding_id: binding_id.clone(),
                reply,
            })
            .await??;
        }
        if in_flight.is_canceled.load(Ordering::Acquire) {
            return Ok(false);
        }
        self.dependencies
            .run_start
            .start_turn(
                inbound,
                params.run_id,
                binding_id.clone(),
                CodexTurnRequest {
                    messages: input.messages,
                    client_message_ids: input.client_message_ids,
                    model: Some(model),
                    output_speed: None,
                    output_speed_for_turn: input.output_speed_for_turn,
                    output_schema: None,
                    level: None,
                },
                Some(Arc::clone(&in_flight.is_canceled)),
                &CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT),
            )
            .await?;
        Ok(true)
    }

    // The end of a turn the retry stopped forgets no run, so the binding of a run the interrupt
    // stopped goes here, unless a continue of the run bound it again meanwhile.
    fn forget_stopped_run(&self, run_id: RunId, binding: &CodexRunBinding) {
        let run_routes = &self.dependencies.run_routes;
        if run_routes.binding_for(run_id).as_ref() == Some(binding) {
            run_routes.forget_run(run_id);
        }
    }
}

/// Marks the run's held turn retried and takes its route, on the session's task, before its
/// interrupt goes out, since the turn's end can follow the interrupt's answer at once: that end is
/// the retry's, so it ends no run. Refuses a turn that is no longer the run's newest live one or
/// whose reply has started.
pub(crate) fn stop_codex_turn_for_retry(
    record: &mut CodexSessionRecord,
    dependencies: &CodexRunCallDependencies,
    run_id: RunId,
    turn_id: &str,
) -> CodexRetryStopAnswer {
    let input = record
        .turn_input_by_turn_id
        .get(turn_id)
        .filter(|_| record.newest_active_turn_for_run(run_id) == Some(turn_id))
        .cloned();
    let Some(input) = input else {
        return CodexRetryStopAnswer::Rejected(NOT_LATEST_REJECTION);
    };
    if record.delivery.reply_started_turn_ids.contains(turn_id) {
        return CodexRetryStopAnswer::Rejected(REPLY_STARTED_REJECTION);
    }
    let connection = match record.service.connection() {
        Ok(connection) => connection,
        Err(error) => return CodexRetryStopAnswer::Failed(error),
    };
    record
        .delivery
        .retried_run_id_by_turn_id
        .insert(turn_id.to_owned(), run_id);
    dependencies.run_routes.retire_turn_route(record, turn_id);
    CodexRetryStopAnswer::Stopping(CodexRetryStop {
        connection,
        thread_id: record.thread_id.clone(),
        input,
    })
}

/// Gives a retried turn whose interrupt Codex refused back to its run, on the session's task;
/// `false` for a turn that ended meanwhile, which needs nothing back.
pub(crate) fn restore_codex_retried_turn(
    record: &mut CodexSessionRecord,
    dependencies: &CodexRunCallDependencies,
    run_id: RunId,
    turn_id: &str,
) -> bool {
    if record.is_turn_settled(turn_id) {
        return false;
    }
    record.delivery.retried_run_id_by_turn_id.remove(turn_id);
    record.add_active_turn(turn_id.to_owned(), run_id);
    dependencies.run_routes.bind_run(run_id, record.session_id);
    true
}

/// Forks the session's conversation to just before the retried turn on `model` at its default
/// window and moves the session and `binding_id` onto the fork, on the session's task, the caller
/// holding the slot. A fork that fails leaves the session on its conversation and its model.
pub(crate) async fn fork_codex_session_for_retry(
    task: &mut CodexSessionTask<'_>,
    forks: &CodexForkDependencies,
    turn_id: &str,
    model: String,
    binding_id: RuntimeBindingId,
) -> Result<CodexRoutedFrames, CodexError> {
    let held_settings = task.record.thread_settings.clone();
    task.record.thread_settings.model = model;
    task.record.thread_settings.model_context_window = None;
    let forked = establish_codex_fork(task, forks, Some(turn_id), Some(binding_id)).await;
    if forked.is_err() {
        task.record.thread_settings = held_settings;
    }
    forked
}

fn rejected(reason: &str) -> FasterModelRetryOutcome {
    FasterModelRetryOutcome::Rejected {
        rejection_reason: reason.to_owned(),
    }
}

fn retry_failure(error: CodexError) -> CodexError {
    CodexError::Transport {
        detail: format!("{RETRY_FAILED}: {error}"),
        cause: Some(Box::new(error)),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;
    use sidekicks_contracts::agent::definition::binding::ProviderToken;

    use super::{
        CodexFasterModelRetries, CodexFasterModelRetryDependencies, INTERRUPTED_REJECTION,
    };
    use crate::provider::driver::codex::run::routes::CodexRunBinding;
    use crate::provider::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInbound};
    use crate::provider::driver::codex::session::state::{CodexTurnInput, CodexTurnMessage};
    use crate::provider::driver::codex::session::test_session::{
        TEST_THREAD, TestCodexSession, answer_fork, turn_completed, turn_reply,
    };
    use crate::provider::driver::run_control::{FasterModelRetryOutcome, FasterModelRetryParams};
    use crate::provider::driver::test_registry::new_run_id;

    /// How the turn sent again on the fork goes.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum TurnOnFork {
        Started,
        Refused,
        /// The run's interrupt arrives as the turn's start reaches the session's task.
        Withdrawn,
        /// The run's interrupt arrives while `turn/start` waits for Codex's answer.
        WithdrawnWhileStarting,
    }

    // Kills: `Applied` answered once the fork alone is established, before `turn/start` on it
    // answered (the refused case then answers `Applied`); a retry the interrupt stops while its
    // turn's start is under way sending the turn anyway; and a withdrawal that came while Codex
    // was starting the turn leaving the named turn running (no `turn/interrupt` naming it).
    #[tokio::test]
    async fn a_retry_applies_only_once_the_turn_on_the_fork_starts() {
        for turn_on_fork in [
            TurnOnFork::Started,
            TurnOnFork::Refused,
            TurnOnFork::Withdrawn,
            TurnOnFork::WithdrawnWhileStarting,
        ] {
            let mut session = TestCodexSession::start().await;
            let binding_id = session.record_binding().await;
            let run_id = new_run_id();
            let record = &mut session.task.record;
            let session_id = record.session_id;
            record.binding_id = Some(binding_id.clone());
            record.turn_boundaries.push("turn-1".to_owned());
            record.add_active_turn("turn-1".to_owned(), run_id);
            record.turn_input_by_turn_id.insert(
                "turn-1".to_owned(),
                CodexTurnInput {
                    messages: vec![CodexTurnMessage {
                        text: "Fix the build.".to_owned(),
                        skills: Vec::new(),
                        attachments: Vec::new(),
                    }],
                    client_message_ids: vec!["message-1".to_owned()],
                    output_speed_for_turn: None,
                },
            );
            let run_routes = Arc::clone(&session.task.run_routes);
            run_routes.bind_run(run_id, session_id);
            run_routes.bind_run_delivery(
                run_id,
                CodexRunBinding {
                    session_id,
                    binding_id,
                    agent_id: session.daemon_turn_bindings.agent_id,
                    step_bound: None,
                },
            );
            let retries = CodexFasterModelRetries::new(CodexFasterModelRetryDependencies {
                slots: Arc::clone(&session.slots),
                run_routes: Arc::clone(&run_routes),
                run_start: Arc::clone(&session.run_start),
                dispatch: Arc::clone(&session.dispatch),
            });
            let settings = session.task.record.thread_settings.clone();
            let retry = retries.retry(FasterModelRetryParams {
                session_id,
                run_id,
                expected_turn_id: "turn-1".to_owned(),
                model: ProviderToken::new("gpt-5-fast".to_owned()).expect("a model token"),
            });
            let task = &mut session.task;
            let script = &mut session.scripted.script;
            let (start_sent, start_seen) = tokio::sync::oneshot::channel::<()>();
            let (withdrawal_set, withdrawal_seen) = tokio::sync::oneshot::channel::<()>();
            let service = async {
                let interrupt = script.next_sent().await;
                assert_eq!(interrupt["method"], "turn/interrupt");
                script.answer(&interrupt, &json!({}));
                script.send(&turn_completed(TEST_THREAD, "turn-1", "interrupted"));
                let fork_model = answer_fork(script, "thread-2", &settings).await;
                assert_eq!(
                    fork_model, "gpt-5-fast",
                    "the fork runs on the faster model"
                );
                if turn_on_fork == TurnOnFork::Withdrawn {
                    return;
                }
                let started = script.next_sent().await;
                assert_eq!(started["method"], "turn/start");
                assert_eq!(started["params"]["threadId"], "thread-2");
                assert_eq!(started["params"]["input"][0]["text"], "Fix the build.");
                if turn_on_fork == TurnOnFork::WithdrawnWhileStarting {
                    start_sent
                        .send(())
                        .expect("the session's task waits for the start");
                    withdrawal_seen
                        .await
                        .expect("the interrupt withdrew the start");
                    script.answer(&started, &turn_reply("turn-2"));
                    let interrupt = script.next_sent().await;
                    assert_eq!(interrupt["method"], "turn/interrupt");
                    assert_eq!(
                        interrupt["params"]["turnId"], "turn-2",
                        "the turn Codex named is stopped"
                    );
                    script.answer(&interrupt, &json!({}));
                    let listed = script.next_sent().await;
                    assert_eq!(listed["method"], "thread/backgroundTerminals/list");
                    script.answer(&listed, &json!({"data": []}));
                    script.send(&turn_completed("thread-2", "turn-2", "interrupted"));
                } else if turn_on_fork == TurnOnFork::Refused {
                    script.send(&json!({
                        "jsonrpc": "2.0",
                        "id": started["id"],
                        "error": {"code": -32600, "message": "The model is unavailable."},
                    }));
                } else {
                    script.answer(&started, &turn_reply("turn-2"));
                }
            };
            let bound = Duration::from_secs(10);
            let settled = if turn_on_fork == TurnOnFork::Withdrawn {
                // The session's task, the interrupt set as the turn's start reaches it.
                let session_task = async {
                    loop {
                        let item = task.next_item().await;
                        if matches!(
                            item,
                            CodexSessionInbound::Call(CodexSessionCall::BeginTurnStart { .. })
                        ) {
                            let mut cancel = std::pin::pin!(retries.cancel(run_id));
                            assert!(futures::poll!(&mut cancel).is_pending());
                            task.handle(item).await;
                            return task.drive(cancel).await.expect("the session reads");
                        }
                        task.handle(item).await;
                    }
                };
                tokio::time::timeout(
                    bound,
                    Box::pin(async { tokio::join!(retry, service, session_task).0 }),
                )
                .await
            } else if turn_on_fork == TurnOnFork::WithdrawnWhileStarting {
                let interrupt = async {
                    start_seen.await.expect("the service saw the start");
                    let mut cancel = std::pin::pin!(retries.cancel(run_id));
                    assert!(futures::poll!(&mut cancel).is_pending());
                    withdrawal_set
                        .send(())
                        .expect("the service waits for the withdrawal");
                    cancel.await.expect("the session reads")
                };
                tokio::time::timeout(
                    bound,
                    Box::pin(async {
                        tokio::join!(
                            task.drive(async { tokio::join!(retry, interrupt).0 }),
                            service
                        )
                        .0
                    }),
                )
                .await
            } else {
                tokio::time::timeout(
                    bound,
                    Box::pin(async { tokio::join!(task.drive(retry), service).0 }),
                )
                .await
            };
            let retried = settled.expect("the retry settles");
            match turn_on_fork {
                TurnOnFork::Refused => {
                    let error = retried.expect_err("a refused turn fails the retry");
                    assert!(
                        error
                            .to_string()
                            .starts_with("Failed to retry with a faster model:"),
                        "{error}"
                    );
                    assert_eq!(
                        run_routes.binding_for(run_id),
                        None,
                        "the failed run has no route"
                    );
                }
                TurnOnFork::Started => {
                    assert_eq!(
                        retried.expect("the retry applies"),
                        FasterModelRetryOutcome::Applied {}
                    );
                    assert_eq!(session.task.record.active_turn_run("turn-2"), Some(run_id));
                }
                TurnOnFork::Withdrawn | TurnOnFork::WithdrawnWhileStarting => assert_eq!(
                    retried.expect("a stopped retry answers"),
                    FasterModelRetryOutcome::Rejected {
                        rejection_reason: INTERRUPTED_REJECTION.to_owned(),
                    },
                    "a retry its run's interrupt stops during its turn's start is rejected"
                ),
            }
        }
    }
}
