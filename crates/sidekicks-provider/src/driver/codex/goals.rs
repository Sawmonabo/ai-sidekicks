//! A session's goal on Codex's own thread goal. The goal is the person's own `/goal`, so it goes
//! out as `origin: "user"`: Codex records only such a goal in the model's history as the person's
//! instruction, which its automatic reviewer reads as authorization. A goal set while a turn runs
//! goes out at once, and Codex applies it to that turn, steering it. On an idle thread Codex may
//! work on the goal in a turn of its own, whose run opens when that turn starts. Setting or
//! clearing one records a message in the conversation, and setting one can start that turn, so
//! each waits for a turn the daemon is stopping to end, within the request deadline, and goes
//! apart from the session's turn starts; a set keeps them apart until the turn it starts begins,
//! within the turn-start deadline, since Codex starts it only after answering. A goal set on a
//! session with no process opens it: the goal goes as a turn the daemon starts on the session,
//! whose binding brings the conversation up, and the turn Codex starts for the goal is that run's.

use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::app_server_protocol::{
    ThreadGoalClearParams, ThreadGoalMutationOrigin, ThreadGoalSetParams,
};
use crate::driver::codex::run::control::interrupt_codex_run;
use crate::driver::codex::run::routes::{CodexRunBinding, CodexRunRoutes};
use crate::driver::codex::run::start::{CODEX_TURN_START_TIMEOUT, CodexRunStart};
use crate::driver::codex::run::turn_end_waiters::{CodexTurnEndDeadline, CodexTurnWait};
use crate::driver::codex::session::calls::{
    CodexSessionReading, call_codex_session, wait_for_codex_turns,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInboundSender};
use crate::driver::codex::session::slots::CodexSessionSlots;
use crate::driver::run_control::{DaemonTurnBinding, DaemonTurnBindingResolver, DaemonTurnProcess};
use crate::driver::session_control::{
    ClearSessionGoalParams, DriverGoalResult, SetSessionGoalParams,
};
use crate::port::run_host::RunHost;
use crate::run::start_request::DaemonTurnStartRequest;

const THREAD_GOAL_SET_METHOD: &str = "thread/goal/set";
const THREAD_GOAL_CLEAR_METHOD: &str = "thread/goal/clear";

/// Sets and clears each session's goal on its conversation.
#[derive(Clone)]
pub(crate) struct CodexSessionGoals {
    slots: Arc<CodexSessionSlots>,
    config_forks: Arc<CodexConfigForks>,
    run_start: Arc<CodexRunStart>,
    run_routes: Arc<CodexRunRoutes>,
    engine: Arc<dyn RunHost>,
    daemon_turn_bindings: Arc<dyn DaemonTurnBindingResolver>,
}

impl CodexSessionGoals {
    /// Goals reaching each session through `slots`, after any config fork in flight, apart from
    /// `run_start`'s turn starts; a goal on a session with no process goes as a run `engine`
    /// starts, which `daemon_turn_bindings` admits and opens and `run_routes` routes.
    pub(crate) fn new(
        slots: Arc<CodexSessionSlots>,
        config_forks: Arc<CodexConfigForks>,
        run_start: Arc<CodexRunStart>,
        run_routes: Arc<CodexRunRoutes>,
        engine: Arc<dyn RunHost>,
        daemon_turn_bindings: Arc<dyn DaemonTurnBindingResolver>,
    ) -> Self {
        Self {
            slots,
            config_forks,
            run_start,
            run_routes,
            engine,
            daemon_turn_bindings,
        }
    }

    /// Sets the session's goal on its conversation and answers once Codex took it and a turn runs:
    /// at once when one already ran, which Codex steers with the goal, else once the turn the goal
    /// starts began or the turn-start deadline passed. A session with no process is opened for the
    /// goal by a run of its own, which takes the turn Codex starts for the goal and ends failed
    /// when none starts within the deadline. Only the objective is sent; its status and token
    /// budget are Codex's own. Fails as the request fails, and as the run's start fails before
    /// the request: with the admission's refusal, and `SessionTurnInFlight` while the engine holds
    /// the session's turn for another run.
    pub(crate) async fn set(
        &self,
        params: SetSessionGoalParams,
    ) -> Result<DriverGoalResult, CodexError> {
        // A slot no record or transition holds: the driver runs no process for the session.
        if self.slots.describe_holder(params.session_id).is_none() {
            return self.set_on_session_not_open(params).await;
        }
        self.send(params.session_id, |inbound, reading| {
            set_goal(inbound, reading, params.goal_text)
        })
        .await?;
        Ok(DriverGoalResult::Applied {})
    }

    /// Clears the session's goal on its conversation; Codex answering that it had none still
    /// applies. Fails as the request fails.
    pub(crate) async fn clear(
        &self,
        params: ClearSessionGoalParams,
    ) -> Result<DriverGoalResult, CodexError> {
        self.send(params.session_id, |_inbound, reading| async move {
            reading
                .connection?
                .request(
                    THREAD_GOAL_CLEAR_METHOD,
                    &ThreadGoalClearParams {
                        thread_id: reading.thread_id,
                        origin: Some(ThreadGoalMutationOrigin::User),
                    },
                )
                .await
                .map(drop)
        })
        .await?;
        Ok(DriverGoalResult::Applied {})
    }

    // Sets the goal as a turn the daemon starts on the session, admitted as a new run of the
    // session is, whose binding brings the session's process up. Answers `Applied` once Codex
    // took the goal, even when its turn never started and the run ended failed.
    async fn set_on_session_not_open(
        &self,
        params: SetSessionGoalParams,
    ) -> Result<DriverGoalResult, CodexError> {
        let session_id = params.session_id;
        let admission = self
            .daemon_turn_bindings
            .admit_daemon_turn(session_id)
            .await
            .map_err(CodexError::from_daemon_turn_binding)?;
        // How Codex answered the set, once the run's start sent it.
        let set_answer: Arc<Mutex<Option<Result<(), CodexError>>>> = Arc::new(Mutex::new(None));
        let goal_text = Arc::new(Mutex::new(Some(params.goal_text)));
        let goals = self.clone();
        let start_answer = Arc::clone(&set_answer);
        let slots = Arc::clone(&self.slots);
        let request = DaemonTurnStartRequest {
            session_id,
            provider: DESCRIPTOR.provider_id(),
            admitted_provider_account_id: admission.admitted_provider_account_id,
            execution_posture: admission.execution_posture,
            is_provider_started: false,
            start_turn: Box::new(move |run_id| {
                let goals = goals.clone();
                let set_answer = Arc::clone(&start_answer);
                let goal_text = lock(&goal_text).take();
                async move {
                    // The engine starts each run's turn once.
                    let Some(goal_text) = goal_text else {
                        return Ok(());
                    };
                    let binding = goals
                        .daemon_turn_bindings
                        .open_daemon_turn_binding(
                            run_id,
                            session_id,
                            DaemonTurnProcess::OpenWhenAbsent,
                        )
                        .await?;
                    let set = goals
                        .set_for_run(session_id, run_id, binding, goal_text)
                        .await;
                    let (answer, started) = match set {
                        Ok(true) => (Ok(()), Ok(())),
                        Ok(false) => (
                            Ok(()),
                            Err(CodexError::Transport {
                                detail: format!(
                                    "Codex took the goal on session \"{session_id}\" and started \
                                     no turn for it within {CODEX_TURN_START_TIMEOUT:?}."
                                ),
                                cause: None,
                            }),
                        ),
                        // The caller reads the set's own failure; the run ends on its words.
                        Err(error) => {
                            let detail = format!(
                                "The goal was not set on session \"{session_id}\": {error}"
                            );
                            (
                                Err(error),
                                Err(CodexError::Transport {
                                    detail,
                                    cause: None,
                                }),
                            )
                        }
                    };
                    *lock(&set_answer) = Some(answer);
                    started?;
                    Ok(())
                }
                .boxed()
            }),
            interrupt_turn: Box::new(move |run_id| {
                let slots = Arc::clone(&slots);
                async move {
                    let inbound = slots.require_live(session_id)?;
                    interrupt_codex_run(&inbound, run_id).await?;
                    Ok(())
                }
                .boxed()
            }),
        };
        let started = self.engine.start_daemon_turn(request).await;
        let set_answer = lock(&set_answer).take();
        match set_answer {
            Some(answer) => answer.map(|()| DriverGoalResult::Applied {}),
            None => started
                .map(|_run_id| DriverGoalResult::Applied {})
                .map_err(|error| CodexError::from_daemon_turn_start(session_id, error)),
        }
    }

    // Sets the goal on the session `run_id`'s binding brought up, with the session's next turn
    // Codex starts by itself claimed for the run: `true` once that turn routed to the run, `false`
    // when Codex took the goal and the claim was taken back, no turn having started within the
    // turn-start deadline. A run whose turn did not route keeps no route. Fails as the set fails.
    async fn set_for_run(
        &self,
        session_id: SessionId,
        run_id: RunId,
        binding: DaemonTurnBinding,
        goal_text: String,
    ) -> Result<bool, CodexError> {
        let run_routes = &self.run_routes;
        let set = self
            .send(session_id, |inbound, reading| async move {
                run_routes.bind_run_delivery(
                    run_id,
                    CodexRunBinding {
                        session_id,
                        binding_id: binding.binding_id,
                        agent_id: binding.agent_id,
                        step_bound: binding.step_bound,
                    },
                );
                run_routes.claim_goal_turn(session_id, run_id);
                let set = set_goal(inbound, reading, goal_text).await;
                // The turn's start took the claim; one still held is taken back, so a later turn
                // Codex starts opens a run of its own.
                let is_turn_routed = run_routes.take_goal_turn_claim(session_id).is_none();
                set.map(|_has_turn_run| is_turn_routed)
            })
            .await;
        if !matches!(set, Ok(true)) {
            run_routes.forget_run(run_id);
        }
        set
    }

    // Runs `request` on the session, after any config fork in flight, apart from its turn starts,
    // once every turn the daemon is stopping ended or the request deadline passed: a goal sent
    // into a turn being stopped would steer a turn that is ending.
    async fn send<Request, Answer>(
        &self,
        session_id: SessionId,
        request: impl FnOnce(CodexSessionInboundSender, CodexSessionReading) -> Request,
    ) -> Result<Answer, CodexError>
    where
        Request: Future<Output = Result<Answer, CodexError>>,
    {
        self.config_forks.join(session_id).await;
        let inbound = self.slots.require_live(session_id)?;
        self.run_start
            .send_apart_from_turn_starts(session_id, async {
                wait_for_codex_turns(
                    &inbound,
                    CodexTurnWait::StoppedTurns,
                    Some(&CodexTurnEndDeadline::for_request()),
                )
                .await?;
                let reading = call_codex_session(&inbound, |reply| CodexSessionCall::ReadSession {
                    thread_id: None,
                    reply,
                })
                .await?;
                request(inbound.clone(), reading).await
            })
            .await
    }
}

// Sets the goal on the conversation `reading` read and waits for a turn to run, within the
// turn-start deadline: `false` once the deadline passed with none.
async fn set_goal(
    inbound: CodexSessionInboundSender,
    reading: CodexSessionReading,
    goal_text: String,
) -> Result<bool, CodexError> {
    reading
        .connection?
        .request(
            THREAD_GOAL_SET_METHOD,
            &ThreadGoalSetParams {
                thread_id: reading.thread_id,
                origin: Some(ThreadGoalMutationOrigin::User),
                objective: Some(goal_text),
                status: None,
                token_budget: None,
            },
        )
        .await?;
    // A turn sent before the goal's own turn starts would fold into it or race it; a turn
    // already running answers at once.
    wait_for_codex_turns(
        &inbound,
        CodexTurnWait::TurnInFlight,
        Some(&CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT)),
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use serde_json::json;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_ipc::domain_error::DomainError;

    use super::CodexSessionGoals;
    use crate::driver::codex::session::errors::CodexError;
    use crate::driver::codex::session::inbound::CodexSessionInboundSender;
    use crate::driver::codex::session::slots::CodexSessionSlots;
    use crate::driver::codex::session::test_fixture::{
        TEST_THREAD, TestCodexSession, TestDaemonTurnBindings, turn_started,
    };
    use crate::driver::contract::error::DriverError;
    use crate::driver::run_control::{
        DaemonTurnAdmission, DaemonTurnBinding, DaemonTurnBindingError, DaemonTurnBindingResolver,
        DaemonTurnProcess,
    };
    use crate::driver::session_control::{DriverGoalResult, SetSessionGoalParams};
    use crate::driver::test_registry::new_run_id;
    use crate::port::run_host::test_host::EngineCall;

    /// How long a test waits for a set to settle before it counts it as stuck.
    const SET_BOUND: Duration = Duration::from_secs(10);

    /// Opens each turn's binding as the fixture's bindings do, once the session's record is up in
    /// `slots`, as the queue's open of a session with no process brings it up.
    struct OpeningBindings {
        slots: Arc<CodexSessionSlots>,
        inbound: CodexSessionInboundSender,
        bindings: Arc<TestDaemonTurnBindings>,
    }

    impl DaemonTurnBindingResolver for OpeningBindings {
        fn open_daemon_turn_binding(
            &self,
            run_id: RunId,
            session_id: SessionId,
            process: DaemonTurnProcess,
        ) -> BoxFuture<'_, Result<DaemonTurnBinding, DaemonTurnBindingError>> {
            async move {
                self.slots
                    .claim_establishing(session_id)
                    .await
                    .expect("the session's slot is free")
                    .install(self.inbound.clone());
                self.bindings
                    .open_daemon_turn_binding(run_id, session_id, process)
                    .await
            }
            .boxed()
        }

        fn admit_daemon_turn(
            &self,
            session_id: SessionId,
        ) -> BoxFuture<'_, Result<DaemonTurnAdmission, DaemonTurnBindingError>> {
            self.bindings.admit_daemon_turn(session_id)
        }
    }

    /// Refuses every daemon turn's admission for want of a current account.
    struct RefusingAdmission;

    impl DaemonTurnBindingResolver for RefusingAdmission {
        fn open_daemon_turn_binding(
            &self,
            _run_id: RunId,
            session_id: SessionId,
            _process: DaemonTurnProcess,
        ) -> BoxFuture<'_, Result<DaemonTurnBinding, DaemonTurnBindingError>> {
            async move { Err(DaemonTurnBindingError::NoProviderSession { session_id }) }.boxed()
        }

        fn admit_daemon_turn(
            &self,
            session_id: SessionId,
        ) -> BoxFuture<'_, Result<DaemonTurnAdmission, DaemonTurnBindingError>> {
            async move {
                Err(DaemonTurnBindingError::Refused {
                    session_id,
                    refusal: Box::new(DomainError::new(
                        "no current account".to_owned(),
                        RefusalCode::ProviderAccountCurrentNotSet,
                    )),
                })
            }
            .boxed()
        }
    }

    // A goal on a session with no process answers the admission's refusal as that refusal, and a
    // turn the engine holds for another run as the turn-in-flight refusal. Kills: either answered
    // as an internal fault.
    #[tokio::test]
    async fn a_goal_on_a_session_with_no_process_answers_its_refusals() {
        let session = TestCodexSession::start().await;
        let session_id = session.task.record.session_id;
        let goals_over = |bindings: Arc<dyn DaemonTurnBindingResolver>| {
            CodexSessionGoals::new(
                Arc::new(CodexSessionSlots::new()),
                Arc::clone(&session.task.calls.runs.config_forks),
                Arc::clone(&session.run_start),
                Arc::clone(&session.task.run_routes),
                Arc::clone(&session.engine) as _,
                bindings,
            )
        };
        let params = || SetSessionGoalParams {
            session_id,
            goal_text: "ship the checkout fix".to_owned(),
        };

        let refused = goals_over(Arc::new(RefusingAdmission) as _)
            .set(params())
            .await;
        assert!(
            matches!(
                &refused,
                Err(CodexError::Driver(DriverError::Refused(refusal)))
                    if refusal.code == RefusalCode::ProviderAccountCurrentNotSet
            ),
            "{refused:?}"
        );

        session.engine.refuse_next_daemon_turns_held(1);
        let held = goals_over(Arc::clone(&session.daemon_turn_bindings) as _)
            .set(params())
            .await;
        assert!(
            matches!(
                &held,
                Err(CodexError::SessionTurnInFlight { session_id: held_session })
                    if *held_session == session_id
            ),
            "{held:?}"
        );
    }

    // Kills: a set refused while a turn runs, which Codex applies to that turn instead.
    #[tokio::test]
    async fn a_goal_set_while_a_turn_runs_goes_out_at_once() {
        let mut session = TestCodexSession::start().await;
        let run_id = new_run_id();
        session
            .task
            .record
            .add_active_turn("turn-1".to_owned(), run_id);
        let goals = CodexSessionGoals::new(
            Arc::clone(&session.slots),
            Arc::clone(&session.task.calls.runs.config_forks),
            Arc::clone(&session.run_start),
            Arc::clone(&session.task.run_routes),
            Arc::clone(&session.engine) as _,
            Arc::clone(&session.daemon_turn_bindings) as _,
        );
        let set = goals.set(SetSessionGoalParams {
            session_id: session.task.record.session_id,
            goal_text: "ship the checkout fix".to_owned(),
        });
        let task = &mut session.task;
        let script = &mut session.scripted.script;
        let service = async {
            let sent = script.next_sent().await;
            assert_eq!(sent["method"], "thread/goal/set");
            assert_eq!(sent["params"]["threadId"], TEST_THREAD);
            assert_eq!(sent["params"]["objective"], "ship the checkout fix");
            assert_eq!(sent["params"]["origin"], "user");
            script.answer(&sent, &json!({}));
        };
        let (answered, ()) = tokio::time::timeout(
            SET_BOUND,
            Box::pin(async { tokio::join!(task.drive(set), service) }),
        )
        .await
        .expect("the set settles while the turn runs");

        assert_eq!(
            answered.expect("Codex takes the goal mid-turn"),
            DriverGoalResult::Applied {}
        );
    }

    // Kills: the turn Codex starts for the goal opening a run of its own beside the goal's (two
    // runs for one goal); the goal's run claiming no turn; a set on a session with no process
    // sent with no run to open it (the slot holds no record).
    #[tokio::test]
    async fn a_goal_on_a_session_with_no_process_opens_it_and_its_turn_is_the_goal_run() {
        let mut session = TestCodexSession::start().await;
        let binding_id = session.record_binding().await;
        session.daemon_turn_bindings.open_on(binding_id);
        let session_id = session.task.record.session_id;
        // No record holds the goal's slots until the goal's binding brings the session up.
        let slots = Arc::new(CodexSessionSlots::new());
        let goals = CodexSessionGoals::new(
            Arc::clone(&slots),
            Arc::clone(&session.task.calls.runs.config_forks),
            Arc::clone(&session.run_start),
            Arc::clone(&session.task.run_routes),
            Arc::clone(&session.engine) as _,
            Arc::new(OpeningBindings {
                slots,
                inbound: session.task.record.inbound.clone(),
                bindings: Arc::clone(&session.daemon_turn_bindings),
            }),
        );
        let set = goals.set(SetSessionGoalParams {
            session_id,
            goal_text: "ship the checkout fix".to_owned(),
        });
        let task = &mut session.task;
        let script = &mut session.scripted.script;
        let service = async {
            let sent = script.next_sent().await;
            assert_eq!(sent["method"], "thread/goal/set");
            script.answer(&sent, &json!({}));
            // Codex starts the goal's turn by itself once it answered.
            script.send(&turn_started("turn-1"));
        };
        let (answered, ()) = tokio::time::timeout(
            SET_BOUND,
            Box::pin(async { tokio::join!(task.drive(set), service) }),
        )
        .await
        .expect("the set settles once the goal's turn started");

        assert_eq!(
            answered.expect("Codex takes the goal"),
            DriverGoalResult::Applied {}
        );
        let goal_run_id = session
            .engine
            .first_daemon_turn_run()
            .expect("the goal went as a run the daemon started");
        let daemon_turn_runs = session
            .engine
            .calls()
            .into_iter()
            .filter(|call| matches!(call, EngineCall::StartDaemonTurn(_)))
            .count();
        assert_eq!(
            daemon_turn_runs, 1,
            "the turn Codex started opened no run beside the goal's"
        );
        assert_eq!(
            session.task.record.active_turn_run("turn-1"),
            Some(goal_run_id),
            "the goal's run took the turn Codex started"
        );
    }
}
