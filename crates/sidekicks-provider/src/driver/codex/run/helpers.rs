//! A Codex helper stopped alone, its lead going on: the person's interrupt of the helper's run, and
//! its stop from the console. Both stop the running turn of the helper's own conversation, read as
//! its newest turn, and end the commands that turn left running. Also a session's helpers
//! reopened after a restart.

use std::error::Error;
use std::sync::Arc;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::run::control::CodexRunControl;
use crate::driver::codex::run::turn_interrupt::{
    CodexRunningTurnInterrupt, CodexTurnInterrupt, TURN_INTERRUPT_METHOD,
    interrupt_codex_running_turn,
};
use crate::driver::codex::session::background_terminals::end_codex_running_commands;
use crate::driver::codex::session::calls::call_codex_session;
use crate::driver::codex::session::detached_conversation::CODEX_DETACHED_INTERRUPT_DEADLINE;
use crate::driver::codex::session::errors::{CodexError, CodexUnansweredCause};
use crate::driver::codex::session::establishment::helpers::reopen_registered_codex_helper;
use crate::driver::codex::session::inbound::CodexSessionCall;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::codex::turn_evidence::CodexTurnStatus;
use crate::driver::contract::error::DriverError;
use crate::driver::prior_usage::read_prior_emitted;
use crate::driver::run_control::{HelperStopOutcome, HelperStopParams, ReattachHelpersParams};
use crate::port::usage_sink::UsageSink;

impl CodexRunControl {
    /// Interrupts a helper's running turn on its own conversation and ends the commands it left
    /// running; the route is marked first, so the helper's end reads as this interrupt's however
    /// soon it arrives, and cleared unless Codex stopped a running turn, so any other end reads as
    /// the helper's own. A run with no helper route answers at once with nothing sent. Answers no
    /// steers, since a helper holds none of the queue's; fails as the helper's stop fails.
    pub(super) async fn interrupt_helper_run(
        &self,
        run_id: RunId,
    ) -> Result<Vec<QueueItemId>, CodexError> {
        let Some(route) = self.dependencies.run_routes.begin_helper_interrupt(run_id) else {
            return Ok(Vec::new());
        };
        let stopped = self
            .stop_helper_turn(route.session_id, &route.thread_id)
            .await;
        self.settle_helper_interrupt(run_id, &stopped);
        stopped.map(|_| Vec::new())
    }

    /// Stops the helper `params.subagent_id` names from the console, its lead going on: its running
    /// turn is interrupted, which Codex can continue, and its commands ended; how each newest turn
    /// answers is the shared body's table. A bound route is marked first, as an interrupt marks it,
    /// and cleared unless Codex stopped a running turn. Codex holds no helper's hook call here, so
    /// no pausing or paused helper is stopped differently. Fails as a request fails, and with
    /// `CodexError::Unanswered` past [`CODEX_DETACHED_INTERRUPT_DEADLINE`].
    pub(crate) async fn stop_child_run(
        &self,
        params: &HelperStopParams,
    ) -> Result<HelperStopOutcome, CodexError> {
        // A helper with no route bound is stopped all the same.
        self.dependencies
            .run_routes
            .begin_helper_interrupt(params.run_id);
        // A Codex helper's id is its own conversation's.
        let stopped = self
            .stop_helper_turn(params.session_id, params.subagent_id.as_str())
            .await;
        self.settle_helper_interrupt(params.run_id, &stopped);
        stopped
    }

    // Clears the daemon's interrupt mark on the helper route of `run_id` unless `stopped` says
    // Codex stopped a running turn, whose end alone is the interrupt's.
    fn settle_helper_interrupt(
        &self,
        run_id: RunId,
        stopped: &Result<HelperStopOutcome, CodexError>,
    ) {
        if !matches!(stopped, Ok(HelperStopOutcome::Interrupted)) {
            self.dependencies.run_routes.end_helper_interrupt(run_id);
        }
    }

    /// The connection of the session's live conversation, reached as run control reaches it;
    /// `None` for a session not live (asleep, closing or starting again). Fails as the session's
    /// reading fails or its service has no connection.
    pub(crate) async fn live_connection(
        &self,
        session_id: SessionId,
    ) -> Result<Option<Arc<CodexAppServerConnection>>, CodexError> {
        let Ok(inbound) = self.dependencies.slots.require_live(session_id) else {
            return Ok(None);
        };
        let reading = call_codex_session(&inbound, |reply| CodexSessionCall::ReadSession {
            thread_id: None,
            reply,
        })
        .await?;
        reading.connection.map(Some)
    }

    /// Reopens each of `params.helpers` that holds no helper route, in the order given, parents
    /// first, ancestors included, since Codex reopens a helper only once its parent is loaded: a
    /// helper an adoption reopened holds a route. Each is registered on the session's service
    /// first, so its frames reach the session. One whose own run was live is then bound to that
    /// run and registered in the session's routing, its usage based on what `usage` reads was
    /// already metered on it; an ancestor reopened only so its descendants load binds no run, so
    /// nothing reaches its ended run. Reopening an unloaded helper loads it, which has Codex
    /// record the turn the restart cut as interrupted. A refused reopen, or a restore the
    /// session's task did not take, is logged and the rest go on. Fails only for a session not
    /// live or a service not running.
    pub(crate) async fn reattach_helpers(
        &self,
        params: &ReattachHelpersParams,
        usage: &PortRegistration<Arc<dyn UsageSink>>,
    ) -> Result<(), CodexError> {
        let inbound = self.dependencies.slots.require_live(params.session_id)?;
        let reading = call_codex_session(&inbound, |reply| CodexSessionCall::ReadSession {
            thread_id: None,
            reply,
        })
        .await?;
        let connection = reading.connection?;
        for helper in &params.helpers {
            if self.dependencies.run_routes.has_helper_route(helper.run_id) {
                continue;
            }
            // A Codex helper's id is its own conversation's.
            let thread_id = helper.subagent_id.as_str();
            let reopened = match reopen_registered_codex_helper(
                &reading.service,
                &connection,
                params.session_id,
                thread_id,
                reading.auto_memory,
            )
            .await
            {
                Ok(reopened) => reopened,
                Err(error) => {
                    tracing::warn!(
                        session_id = %params.session_id,
                        run_id = %helper.run_id,
                        thread_id = %thread_id,
                        error = &error as &(dyn Error + 'static),
                        "codex refused the reopen of a helper after a restart"
                    );
                    continue;
                }
            };
            if !helper.was_live {
                continue;
            }
            let prior_emitted = read_prior_emitted(
                usage,
                DESCRIPTOR.provider_id(),
                params.session_id,
                thread_id,
            )
            .await;
            // The reopen names the model the helper runs on now, else its node names its first.
            let model = reopened.model.or_else(|| {
                helper
                    .model_id
                    .as_ref()
                    .map(|model| model.as_str().to_owned())
            });
            let restored = call_codex_session(&inbound, |reply| CodexSessionCall::RestoreHelper {
                helper: Box::new(helper.clone()),
                prior_emitted,
                model,
                reply,
            })
            .await;
            if let Err(error) = restored {
                tracing::warn!(
                    session_id = %params.session_id,
                    run_id = %helper.run_id,
                    thread_id = %thread_id,
                    error = &error as &(dyn Error + 'static),
                    "a helper reopened after a restart was not restored on its session"
                );
            }
        }
        Ok(())
    }

    // Stops the helper conversation `thread_id` by its newest turn, within the detached interrupt's
    // deadline, its commands ended as a lead's interrupt ends them:
    //
    // | Session or newest turn                           | Commands ended | Answer               |
    // |--------------------------------------------------|----------------|----------------------|
    // | session not live (asleep, closing, re-starting)  | no             | `AlreadyEnded`       |
    // | no turn yet, or Codex does not hold the thread   | no             | `AlreadyEnded`       |
    // | interrupted                                      | no             | `AlreadyInterrupted` |
    // | completed, failed, or a status Codex adds        | yes            | `AlreadyEnded`       |
    // | running, Codex stopped it                        | yes            | `Interrupted`        |
    // | running, it ended before the interrupt           | yes            | `AlreadyEnded`       |
    // | a failed request, or the deadline passed         | no             | `Err`                |
    async fn stop_helper_turn(
        &self,
        session_id: SessionId,
        thread_id: &str,
    ) -> Result<HelperStopOutcome, CodexError> {
        tokio::time::timeout(CODEX_DETACHED_INTERRUPT_DEADLINE, async {
            // Its helpers end with the session, as Claude Code's end with its process.
            let Some(connection) = self.live_connection(session_id).await? else {
                return Ok(HelperStopOutcome::AlreadyEnded);
            };
            let stopped = match interrupt_codex_running_turn(&connection, thread_id, None).await {
                Ok(CodexRunningTurnInterrupt::Running(CodexTurnInterrupt::Stopped)) => {
                    HelperStopOutcome::Interrupted
                }
                Ok(
                    CodexRunningTurnInterrupt::Running(CodexTurnInterrupt::AlreadyEnded)
                    | CodexRunningTurnInterrupt::Untouched(
                        Some(
                            CodexTurnStatus::Completed
                            | CodexTurnStatus::Failed
                            | CodexTurnStatus::InProgress,
                        )
                        | None,
                    ),
                ) => HelperStopOutcome::AlreadyEnded,
                Ok(CodexRunningTurnInterrupt::Untouched(Some(CodexTurnStatus::Interrupted))) => {
                    return Ok(HelperStopOutcome::AlreadyInterrupted);
                }
                Ok(CodexRunningTurnInterrupt::NoTurn) => {
                    return Ok(HelperStopOutcome::AlreadyEnded);
                }
                Err(error) if error.is_thread_not_found() => {
                    return Ok(HelperStopOutcome::AlreadyEnded);
                }
                Err(error) => return Err(error),
            };
            // Ending an ended turn's commands again is harmless, and ends one whose end the
            // daemon missed.
            end_codex_running_commands(&connection, thread_id, false).await;
            Ok(stopped)
        })
        .await
        .unwrap_or_else(|_elapsed| {
            Err(CodexError::Unanswered {
                method: TURN_INTERRUPT_METHOD.to_owned(),
                cause: CodexUnansweredCause::Deadline {
                    timeout: CODEX_DETACHED_INTERRUPT_DEADLINE,
                },
            })
        })
    }
}

impl CodexDriver {
    /// Stops one helper from the console, its lead going on, answering how Codex took it; see the
    /// run control's stop. Fails as that stop fails.
    pub(crate) async fn stop_child_run(
        &self,
        params: HelperStopParams,
    ) -> Result<HelperStopOutcome, DriverError> {
        Ok(self.parts()?.run_control.stop_child_run(&params).await?)
    }

    /// Reopens a session's helpers after a restart, each live one's usage based on what was
    /// already metered on its conversation; see the run control's re-attach. Fails only for a
    /// session not live.
    pub(crate) async fn reattach_helpers(
        &self,
        params: ReattachHelpersParams,
    ) -> Result<(), DriverError> {
        let parts = self.parts()?;
        Ok(parts
            .run_control
            .reattach_helpers(&params, &parts.ports.usage)
            .await?)
    }
}

#[cfg(test)]
mod tests {
    //! A Codex helper's stop and its re-attach after a restart against the scripted service, on
    //! paused time, so the stop's deadline is passed by moving the clock rather than by a real
    //! wait.

    use std::sync::Arc;
    use std::time::Duration;

    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::agent::definition::binding::ProviderToken;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::run::subagent::SubagentId;
    use sidekicks_std::port_registration::PortRegistration;

    use crate::driver::codex::session::detached_conversation::CODEX_DETACHED_INTERRUPT_DEADLINE;
    use crate::driver::codex::session::errors::{CodexError, CodexUnansweredCause};
    use crate::driver::codex::session::test_fixture::TestCodexSession;
    use crate::driver::run_control::{
        HelperStopOutcome, HelperStopParams, ReattachHelpersParams, ReattachedHelper,
    };
    use crate::driver::test_registry::{new_run_id, new_session_id};
    use crate::port::usage_sink::UsageSink;
    use crate::run::delivery::LateAppendableRow;
    use crate::run::state_entry::RunStateEntry;
    use crate::runtime_binding::store::mint_runtime_binding_id;

    /// The helper's own conversation, which is its id.
    const HELPER_THREAD: &str = "helper-thread";

    /// The helper's newest turn.
    const HELPER_TURN: &str = "helper-turn";

    /// Past the stop's own deadline, so a stop with none fails the test rather than hanging it.
    const DEADLOCK_BOUND: Duration = Duration::from_secs(60);

    // How the scripted service answers the stop's requests.
    #[derive(Clone, Copy)]
    enum ServiceAnswer {
        // Lists the newest turn with this status; a running one's interrupt is answered `{}`, and
        // the commands of any but an interrupted one are listed as none.
        Newest(&'static str),
        // Refuses the turn list with `-32600` and these words.
        ListRefused(&'static str),
        // Lists a running turn and refuses its interrupt with this code and these words; after
        // Codex's `-32600` that the turn already ended, the commands are listed as none.
        InterruptRefused(i64, &'static str),
        // Reads the turn list and never answers it.
        Silent,
        // Is asked nothing: the stop names a session with no live conversation.
        NotLive,
    }

    // What the stop answers.
    #[derive(Clone, Copy, Debug)]
    enum StopAnswer {
        Outcome(HelperStopOutcome),
        Refused,
        PastDeadline,
    }

    // The stop of the helper on `HELPER_THREAD` in `session`, whose own run is `run_id`.
    fn helper_stop(session: &TestCodexSession, run_id: RunId) -> HelperStopParams {
        HelperStopParams {
            session_id: session.task.record.session_id,
            run_id,
            subagent_id: SubagentId::new(HELPER_THREAD.to_owned()).expect("a helper id"),
        }
    }

    // Which of the two helper stops a test takes.
    #[derive(Clone, Copy, Debug)]
    enum HelperStop {
        // The person's interrupt of the helper's run.
        Interrupt,
        // The stop from the console.
        Stop,
    }

    // A helper's stop, by the person's interrupt of its run or from the console, reads its newest
    // turn on its own conversation alone: a running one is interrupted and its commands ended, an
    // interrupted one is left so, and an ended one, a helper no message reached, a conversation
    // Codex does not hold, an interrupt racing the turn's own end and a session not live all read
    // as ended, the commands of an ended turn ended again; a refused interrupt and a service that
    // never answers fail. The route keeps the daemon's interrupt mark only where Codex stopped a
    // running turn, so any other end reads as the helper's own. Kills: the status not read (the
    // interrupted case), a conversation Codex does not hold read as a failure (both `thread not
    // found` cases), a session not live read as a failure (the not-live case), no deadline (the
    // silent case outlives the test's bound), the commands not ended after an interrupt or on an
    // ended turn (the commands list never comes in the running, completed and turn-ended-first
    // cases), the mark never set (the running case), the mark kept on any other answer or a failure
    // (every other case), and anything sent to the lead's conversation (something more is sent).
    #[rstest]
    #[case::running(
        ServiceAnswer::Newest("inProgress"),
        StopAnswer::Outcome(HelperStopOutcome::Interrupted)
    )]
    #[case::interrupted(
        ServiceAnswer::Newest("interrupted"),
        StopAnswer::Outcome(HelperStopOutcome::AlreadyInterrupted)
    )]
    #[case::completed(
        ServiceAnswer::Newest("completed"),
        StopAnswer::Outcome(HelperStopOutcome::AlreadyEnded)
    )]
    #[case::no_turn_yet(
        ServiceAnswer::ListRefused("thread helper-thread is not materialized yet"),
        StopAnswer::Outcome(HelperStopOutcome::AlreadyEnded)
    )]
    #[case::thread_not_found(
        ServiceAnswer::ListRefused("thread not found: helper-thread"),
        StopAnswer::Outcome(HelperStopOutcome::AlreadyEnded)
    )]
    #[case::turn_ended_first(
    ServiceAnswer::InterruptRefused(-32600, "no active turn to interrupt"),
    StopAnswer::Outcome(HelperStopOutcome::AlreadyEnded)
)]
    #[case::interrupt_failed(
    ServiceAnswer::InterruptRefused(-32603, "internal error"),
    StopAnswer::Refused
)]
    #[case::silent(ServiceAnswer::Silent, StopAnswer::PastDeadline)]
    #[case::not_live(
        ServiceAnswer::NotLive,
        StopAnswer::Outcome(HelperStopOutcome::AlreadyEnded)
    )]
    #[tokio::test(start_paused = true)]
    async fn a_helpers_stop_answers_from_its_newest_turn(
        #[case] service: ServiceAnswer,
        #[case] expected: StopAnswer,
        #[values(HelperStop::Interrupt, HelperStop::Stop)] helper_stop_kind: HelperStop,
    ) {
        let mut session = TestCodexSession::start().await;
        let helper_run = new_run_id();
        let mut params = helper_stop(&session, helper_run);
        if matches!(service, ServiceAnswer::NotLive) {
            params.session_id = new_session_id();
        }
        let run_routes = Arc::clone(&session.task.run_routes);
        run_routes.bind_helper_run(helper_run, params.session_id, HELPER_THREAD);
        let control = Arc::clone(&session.task.run_control);
        let task = &mut session.task;
        let script = &mut session.scripted.script;
        let service_side = async {
            if matches!(service, ServiceAnswer::NotLive) {
                return;
            }
            let listed = script.next_sent().await;
            assert_eq!(listed["method"], "thread/turns/list");
            assert_eq!(listed["params"]["threadId"], HELPER_THREAD);
            assert_eq!(listed["params"]["limit"], 1);
            let (status, interrupt_refusal) = match service {
                ServiceAnswer::Silent => {
                    // Moved past the deadline here rather than left to auto-advance, which a
                    // blocking task in flight would hold back.
                    tokio::time::advance(CODEX_DETACHED_INTERRUPT_DEADLINE).await;
                    return;
                }
                ServiceAnswer::ListRefused(message) => {
                    script.send(&json!({
                        "jsonrpc": "2.0",
                        "id": listed["id"],
                        "error": {"code": -32600, "message": message},
                    }));
                    return;
                }
                ServiceAnswer::NotLive => return,
                ServiceAnswer::Newest(status) => (status, None),
                ServiceAnswer::InterruptRefused(code, message) => {
                    ("inProgress", Some((code, message)))
                }
            };
            script.answer(
                &listed,
                &json!({"data": [{"id": HELPER_TURN, "status": status}]}),
            );
            if status == "interrupted" {
                return;
            }
            if status == "inProgress" {
                let interrupt = script.next_sent().await;
                assert_eq!(interrupt["method"], "turn/interrupt");
                assert_eq!(
                    interrupt["params"],
                    json!({"threadId": HELPER_THREAD, "turnId": HELPER_TURN})
                );
                match interrupt_refusal {
                    Some((code, message)) => {
                        script.send(&json!({
                            "jsonrpc": "2.0",
                            "id": interrupt["id"],
                            "error": {"code": code, "message": message},
                        }));
                        if code != -32600 {
                            return;
                        }
                    }
                    None => script.answer(&interrupt, &json!({})),
                }
            }
            let commands = script.next_sent().await;
            assert_eq!(commands["method"], "thread/backgroundTerminals/list");
            assert_eq!(commands["params"]["threadId"], HELPER_THREAD);
            script.answer(&commands, &json!({"data": []}));
        };
        let stopping = async {
            match helper_stop_kind {
                // An interrupt answers no steers, and takes the outcome only as its mark.
                HelperStop::Interrupt => control.interrupt_run(helper_run).await.map(|steers| {
                    assert_eq!(steers, Vec::new());
                    None
                }),
                HelperStop::Stop => control.stop_child_run(&params).await.map(Some),
            }
        };
        let (stopped, ()) = tokio::time::timeout(
            DEADLOCK_BOUND,
            Box::pin(async { tokio::join!(task.drive(stopping), service_side) }),
        )
        .await
        .expect("the helper's stop is answered within its deadline");

        let route = run_routes
            .retire_helper_run(helper_run)
            .expect("the helper's route stays until its end");
        assert_eq!(
            route.is_interrupted_by_daemon,
            matches!(
                expected,
                StopAnswer::Outcome(HelperStopOutcome::Interrupted)
            ),
            "the mark stands only for a turn Codex stopped"
        );
        match expected {
            StopAnswer::Outcome(outcome) => {
                let answered = stopped.expect("the helper's stop is answered");
                if matches!(helper_stop_kind, HelperStop::Stop) {
                    assert_eq!(answered, Some(outcome));
                }
            }
            StopAnswer::Refused => assert!(
                matches!(
                    stopped,
                    Err(CodexError::ProviderRequest { code: -32603, .. })
                ),
                "{stopped:?}"
            ),
            StopAnswer::PastDeadline => assert!(
                matches!(
                    stopped,
                    Err(CodexError::Unanswered {
                        cause: CodexUnansweredCause::Deadline { timeout },
                        ..
                    }) if timeout == CODEX_DETACHED_INTERRUPT_DEADLINE
                ),
                "{stopped:?}"
            ),
        }
        assert!(
            session.scripted.script.sent.try_recv().is_err(),
            "nothing more was sent"
        );
    }

    // A usage record with no port registered, which bases a restored helper's usage at zero.
    fn no_usage_record() -> PortRegistration<Arc<dyn UsageSink>> {
        PortRegistration::new("usage")
    }

    // A helper re-attached after a restart, as the session's tree holds it, on its conversation
    // `thread_id`.
    fn reattached(run_id: RunId, thread_id: &str, parent: Option<&str>) -> ReattachedHelper {
        let subagent_id = |id: &str| SubagentId::new(id.to_owned()).expect("a helper id");
        ReattachedHelper {
            run_id,
            parent_run_id: new_run_id(),
            subagent_id: subagent_id(thread_id),
            parent_subagent_id: parent.map(subagent_id),
            start_call_id: None,
            provider_path: None,
            model_id: None,
            was_live: true,
        }
    }

    // The helpers are reopened in the order given, parents first: one an adoption already reopened,
    // which holds a route, is skipped, and a reopen Codex refuses is passed over, the next helper
    // still reopened. Kills: the routed helper reopened (its resume comes first), a stop at the
    // refusal (the last helper's resume never comes, or the call fails), the order reversed (the
    // child's resume comes before its parent's), and a helper loaded again with no memory keys,
    // which starts it under the home's own settings. A reopen whose reply names no model takes the
    // node's, so no read follows; killed by the node's model ignored (a `thread/read` is sent).
    #[tokio::test(start_paused = true)]
    async fn reattached_helpers_reopen_in_order_past_a_refusal() {
        let mut session = TestCodexSession::start().await;
        session.task.record.thread_settings.auto_memory = Some(false);
        let session_id = session.task.record.session_id;
        let routed_run = new_run_id();
        session
            .task
            .run_routes
            .bind_helper_run(routed_run, session_id, "helper-routed");
        let params = ReattachHelpersParams {
            session_id,
            helpers: vec![
                reattached(routed_run, "helper-routed", None),
                reattached(new_run_id(), "helper-refused", Some("helper-routed")),
                ReattachedHelper {
                    model_id: Some(
                        ProviderToken::new("gpt-5.4-mini".to_owned()).expect("a model id"),
                    ),
                    ..reattached(new_run_id(), "helper-reopened", Some("helper-refused"))
                },
            ],
        };
        let control = Arc::clone(&session.task.run_control);
        let task = &mut session.task;
        let script = &mut session.scripted.script;
        let service_side = async {
            let refused = script.next_sent().await;
            assert_eq!(refused["method"], "thread/resume");
            assert_eq!(refused["params"]["threadId"], "helper-refused");
            script.send(&json!({
            "jsonrpc": "2.0",
            "id": refused["id"],
            "error": {
                "code": -32600,
                "message": "cannot resume multi-agent v2 child: parent is not loaded; resume the \
                            parent first",
            },
        }));
            let reopened = script.next_sent().await;
            assert_eq!(reopened["method"], "thread/resume");
            assert_eq!(reopened["params"]["threadId"], "helper-reopened");
            assert_eq!(reopened["params"]["excludeTurns"], true);
            assert_eq!(
                reopened["params"]["config"],
                json!({"memories.use_memories": false, "memories.generate_memories": false}),
                "the helper loads under the session's memory switch"
            );
            script.answer(
                &reopened,
                &json!({
                    "thread": {"id": "helper-reopened", "sessionId": "codex-session"},
                    "initialTurnsPage": {
                        "data": [{"id": HELPER_TURN, "status": "interrupted"}],
                        "nextCursor": null,
                    },
                }),
            );
        };
        let usage = no_usage_record();
        let (reattached, ()) = tokio::time::timeout(
            DEADLOCK_BOUND,
            Box::pin(async {
                tokio::join!(
                    task.drive(control.reattach_helpers(&params, &usage)),
                    service_side
                )
            }),
        )
        .await
        .expect("the re-attach is answered");

        assert!(reattached.is_ok(), "{reattached:?}");
        assert!(
            session.scripted.script.sent.try_recv().is_err(),
            "nothing more was sent"
        );
    }

    // A helper reopened after a restart is registered on the session's service and in its routing
    // and bound to its existing child run, so a turn it ends afterwards, sent through the service,
    // ends that run with its `subagent.completed` row; no new run is started. The ancestor listed
    // only for its place in the tree is reopened first and bound to nothing. Kills: the service
    // registration missing (the service drops the frame and the wait runs out), the routing's
    // registration or the child run's binding missing (the run never moves), a helper whose run
    // was not live bound all the same (the ancestor holds a route), and the reply's model ignored
    // (a `thread/read` is sent).
    #[tokio::test(start_paused = true)]
    async fn a_reattached_helpers_later_turn_reaches_its_run() {
        let mut session = TestCodexSession::start().await;
        session.task.record.binding_id = Some(mint_runtime_binding_id());
        let (ancestor_run, helper_run) = (new_run_id(), new_run_id());
        let params = ReattachHelpersParams {
            session_id: session.task.record.session_id,
            helpers: vec![
                ReattachedHelper {
                    was_live: false,
                    ..reattached(ancestor_run, "helper-ancestor", None)
                },
                reattached(helper_run, "helper-reopened", Some("helper-ancestor")),
            ],
        };
        let control = Arc::clone(&session.task.run_control);
        let run_routes = Arc::clone(&session.task.run_routes);
        let task = &mut session.task;
        let script = &mut session.scripted.script;
        let service_side = async {
            let ancestor = script.next_sent().await;
            assert_eq!(ancestor["params"]["threadId"], "helper-ancestor");
            script.answer(
                &ancestor,
                &json!({
                    "thread": {"id": "helper-ancestor", "sessionId": "codex-session"},
                    "initialTurnsPage": {
                        "data": [{"id": "ancestor-turn", "status": "completed"}],
                        "nextCursor": null,
                    },
                }),
            );
            let reopened = script.next_sent().await;
            assert_eq!(reopened["params"]["threadId"], "helper-reopened");
            script.answer(
                &reopened,
                &json!({
                    "thread": {"id": "helper-reopened", "sessionId": "codex-session"},
                    "model": "gpt-5.4-mini",
                    "initialTurnsPage": {
                        "data": [{"id": HELPER_TURN, "status": "interrupted"}],
                        "nextCursor": null,
                    },
                }),
            );
        };
        let usage = no_usage_record();
        let (reattached, ()) = tokio::time::timeout(
            DEADLOCK_BOUND,
            Box::pin(async {
                tokio::join!(
                    task.drive(control.reattach_helpers(&params, &usage)),
                    service_side
                )
            }),
        )
        .await
        .expect("the re-attach is answered");
        assert!(reattached.is_ok(), "{reattached:?}");
        assert!(
            session.scripted.script.sent.try_recv().is_err(),
            "nothing more was sent"
        );
        assert!(
            !run_routes.has_helper_route(ancestor_run),
            "the ancestor's ended run holds no route"
        );

        session.scripted.script.send(&json!({
            "jsonrpc": "2.0",
            "method": "turn/completed",
            "params": {
                "threadId": "helper-reopened",
                "turn": {"id": "helper-next-turn", "items": [], "status": "completed"},
            },
        }));
        tokio::time::timeout(DEADLOCK_BOUND, session.task.handle_next())
            .await
            .expect("the helper's frame reaches the session");

        assert_eq!(
            session.engine.moves_of_run(helper_run),
            vec![RunStateEntry::Completed {
                intended_close: None
            }]
        );
        let deliveries = session.engine.deliveries();
        assert!(
            deliveries.iter().any(|delivery| matches!(
                &delivery.row,
                Some(LateAppendableRow::AgentSubagentCompleted(row))
                    if row.child_run_id == Some(helper_run)
            )),
            "the helper's end names its run"
        );
        assert!(
            deliveries
                .iter()
                .all(|delivery| delivery.subagent.is_none()),
            "no new child run is started"
        );
    }
}
