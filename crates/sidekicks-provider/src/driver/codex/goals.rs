//! A session's goal on Codex's own thread goal. The goal is the person's own `/goal`, so it goes
//! out as `origin: "user"`: Codex records only such a goal in the model's history as the person's
//! instruction, which its automatic reviewer reads as authorization. A goal set while a turn runs
//! goes out at once, and Codex applies it to that turn, steering it. On an idle thread Codex may
//! work on the goal in a turn of its own, whose run opens when that turn starts. Setting or
//! clearing one records a message in the conversation, and setting one can start that turn, so
//! each waits for a turn the daemon is stopping to end, within the request deadline, and goes
//! apart from the session's turn starts; a set keeps them apart until the turn it starts begins,
//! within the turn-start deadline, since Codex starts it only after answering. A set whose turn
//! never begins is not taken: Codex's goal is put back with its objective, status and budget. A
//! goal set on a session with no process opens it: the goal goes as a turn the daemon starts on
//! the session, whose binding brings the conversation up, and the turn Codex starts for the goal
//! is that run's.

use std::error::Error;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use serde::Deserialize;
use serde_json::Value;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::app_server_protocol::{
    ThreadGoalClearParams, ThreadGoalGetParams, ThreadGoalMutationOrigin, ThreadGoalSetParams,
    ThreadGoalStatus,
};
use crate::driver::codex::run::control::interrupt_codex_run;
use crate::driver::codex::run::routes::{
    CodexGoalReplace, CodexGoalRunEndGuard, CodexRunBinding, CodexRunRoutes,
};
use crate::driver::codex::run::start::{CODEX_TURN_START_TIMEOUT, CodexRunStart};
use crate::driver::codex::run::turn_end_waiters::{CodexTurnEndDeadline, CodexTurnWait};
use crate::driver::codex::session::calls::{
    CodexSessionReading, call_codex_session, wait_for_codex_turns,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInboundSender};
use crate::driver::codex::session::slots::CodexSessionSlots;
use crate::driver::codex::transport::connection::{
    CodexAnswerHook, CodexAppServerConnection, read_codex_object,
};
use crate::driver::run_control::{DaemonTurnBinding, DaemonTurnBindingResolver, DaemonTurnProcess};
use crate::driver::session_control::{
    ClearSessionGoalParams, DriverGoalResult, SetSessionGoalParams,
};
use crate::port::run_host::RunHost;
use crate::run::start_request::DaemonTurnStartRequest;

const THREAD_GOAL_SET_METHOD: &str = "thread/goal/set";
const THREAD_GOAL_GET_METHOD: &str = "thread/goal/get";
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

    /// Sets the session's goal on its conversation and answers `Applied` once Codex took it and a
    /// turn runs: at once when one already ran, which Codex steers with the goal, else once the
    /// turn the goal starts began. When no turn began within the turn-start deadline, Codex's goal
    /// is put back with its objective, status and budget and the set answers `Degraded`, carrying
    /// the words a session with no process also ends its goal's run on: such a session is opened
    /// for the goal by a run of its own, which takes the turn Codex starts for the goal. The
    /// objective goes out `active`; its token budget is Codex's own. Fails as a request fails, the
    /// put-back's included, and as the run's start fails before the request: with the admission's
    /// refusal, and `SessionTurnInFlight` while the engine holds the session's turn for another
    /// run.
    pub(crate) async fn set(
        &self,
        params: SetSessionGoalParams,
    ) -> Result<DriverGoalResult, CodexError> {
        // A slot no record or transition holds: the driver runs no process for the session.
        if self.slots.describe_holder(params.session_id).is_none() {
            return self.set_on_session_not_open(params).await;
        }
        let has_turn = self
            .send(params.session_id, |inbound, reading| {
                self.set_goal(
                    params.session_id,
                    inbound,
                    reading,
                    params.goal_text,
                    |has_turn| has_turn,
                )
            })
            .await?;
        Ok(if has_turn {
            DriverGoalResult::Applied {}
        } else {
            not_applied(no_turn_words())
        })
    }

    /// Clears the session's goal on its conversation; Codex answering that it had none still
    /// applies. Fails as the request fails.
    pub(crate) async fn clear(
        &self,
        params: ClearSessionGoalParams,
    ) -> Result<DriverGoalResult, CodexError> {
        self.send(params.session_id, |_inbound, reading| async move {
            let connection = reading.connection?;
            clear_goal(&connection, reading.thread_id).await
        })
        .await?;
        Ok(DriverGoalResult::Applied {})
    }

    // Sets the goal as a turn the daemon starts on the session, admitted as a new run of the
    // session is, whose binding brings the session's process up. A set whose turn never started
    // answers `Degraded`, and the run ends failed, on one set of words.
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
        // How the set settled, once the run's start sent it.
        let set_answer: Arc<Mutex<Option<Result<DriverGoalResult, CodexError>>>> =
            Arc::new(Mutex::new(None));
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
                        Ok(true) => (Ok(DriverGoalResult::Applied {}), Ok(())),
                        Ok(false) => {
                            let words = no_turn_words();
                            (
                                Ok(not_applied(words.clone())),
                                Err(CodexError::Transport {
                                    detail: words,
                                    cause: None,
                                }),
                            )
                        }
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
        let started = {
            // Once the start returned the goal's run has ended, so a turn Codex started meanwhile
            // opens its own; a set dropped before then ends the mark too.
            let _run_end = CodexGoalRunEndGuard::new(Arc::clone(&self.run_routes), session_id);
            self.engine.start_daemon_turn(request).await
        };
        let set_answer = lock(&set_answer).take();
        match set_answer {
            Some(answer) => answer,
            None => started
                .map(|_run_id| DriverGoalResult::Applied {})
                .map_err(|error| CodexError::from_daemon_turn_start(session_id, error)),
        }
    }

    // Sets the goal on the session `run_id`'s binding brought up, with the session's next turn
    // Codex starts by itself claimed for the run: `true` once that turn routed to the run, `false`
    // when no turn started within the turn-start deadline and Codex's goal was put back. A run
    // whose turn did not route keeps no route. Fails as the set fails.
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
                // The turn's start took the claim; one still held is taken back before Codex's
                // goal is put back, and the run marked ending, so a turn the restored goal starts
                // opens a run of its own once this one ended failed.
                let take_back = || {
                    let is_held = run_routes.take_goal_turn_claim(session_id).is_some();
                    if is_held {
                        run_routes.begin_goal_run_ending(session_id);
                    }
                    is_held
                };
                let set = self
                    .set_goal(session_id, inbound, reading, goal_text, |_has_turn| {
                        !take_back()
                    })
                    .await;
                // A set that failed before its turn wait ended still holds the claim.
                take_back();
                set
            })
            .await;
        if !matches!(set, Ok(true)) {
            run_routes.forget_run(run_id);
        }
        set
    }

    // Sets the goal on the conversation `reading` read and waits for a turn to run, within the
    // turn-start deadline; `turn_started` settles from the wait whether one did, before anything
    // more is asked. A goal already there is cleared first, as Codex's own terminal replaces one,
    // so the new goal starts with fresh usage and none of the old one's budget; the clear draws no
    // row, nor does an update of the new objective but the one carrying the goal the set answered,
    // which draws the replace's row. A set Codex refuses after that clear, or a clear it never
    // answered, puts the old goal back, drawing no row either, and answers the failure. With no
    // turn, Codex's goal is put back with its objective, status and budget, and the answer is
    // `false`. Fails as a request fails, the put-back's included. A failed turn wait puts the goal
    // back too, where the connection still takes requests, and answers the wait's failure.
    async fn set_goal(
        &self,
        session_id: SessionId,
        inbound: CodexSessionInboundSender,
        reading: CodexSessionReading,
        goal_text: String,
        turn_started: impl FnOnce(bool) -> bool,
    ) -> Result<bool, CodexError> {
        let connection = reading.connection?;
        let thread_id = reading.thread_id;
        let previous = read_goal(&connection, &thread_id).await?;
        let objective = goal_text.trim().to_owned();
        let params = new_goal_params(thread_id.clone(), goal_text);
        let sent = if let Some(replaced) = &previous {
            let replace = CodexGoalReplace {
                absorbed_objectives: vec![objective.clone()],
                awaited_goal: None,
                is_drawn: true,
            };
            self.run_routes.begin_goal_replace(session_id, replace);
            if let Err(error) = clear_goal(&connection, thread_id.clone()).await {
                // A clear written with no answer may have gone through.
                if matches!(error, CodexError::Unanswered { .. }) {
                    self.put_refused_replace_back(
                        session_id,
                        &connection,
                        thread_id,
                        replaced,
                        &objective,
                    )
                    .await?;
                } else {
                    self.run_routes.end_goal_replace(session_id);
                }
                return Err(error);
            }
            // A refused set re-marks the replace at its answer, so the old goal's updates after
            // it draw no row before the put-back goes.
            let refused = absorbed_refused_replace(replaced, &objective);
            let on_refused = move |run_routes: &CodexRunRoutes| {
                run_routes.begin_goal_replace(session_id, refused);
            };
            connection
                .request_ordered(
                    THREAD_GOAL_SET_METHOD,
                    &params,
                    self.goal_replace_hook(session_id, on_refused),
                )
                .await
        } else {
            connection.request(THREAD_GOAL_SET_METHOD, &params).await
        };
        if let Err(error) = sent {
            if let Some(replaced) = &previous {
                self.put_refused_replace_back(
                    session_id,
                    &connection,
                    thread_id,
                    replaced,
                    &objective,
                )
                .await?;
            }
            return Err(error);
        }
        // A turn sent before the goal's own turn starts would fold into it or race it; a turn
        // already running answers at once.
        let waited = wait_for_codex_turns(
            &inbound,
            CodexTurnWait::TurnInFlight,
            Some(&CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT)),
        )
        .await;
        let has_turn = match waited {
            Ok(has_turn) => turn_started(has_turn),
            Err(error) => {
                // The session's task ended the wait; the goal still goes back while the
                // connection takes requests, and the wait's failure is the answer.
                turn_started(false);
                if let Err(restore_error) =
                    restore_goal(&connection, thread_id, previous.as_ref()).await
                {
                    tracing::warn!(
                        error = &restore_error as &(dyn Error + 'static),
                        session_id = %session_id,
                        "the codex goal a failed turn wait refused could not be put back"
                    );
                }
                return Err(error);
            }
        };
        if !has_turn {
            restore_goal(&connection, thread_id, previous.as_ref()).await?;
        }
        Ok(has_turn)
    }

    // Puts back `previous`, the goal a replace to `refused_objective` cleared, drawing no row,
    // since the goal did not change but for its usage, where the clear went through: the updates
    // of either objective fold until the one carrying the goal the put-back answered. Fails as the
    // put-back fails.
    async fn put_refused_replace_back(
        &self,
        session_id: SessionId,
        connection: &CodexAppServerConnection,
        thread_id: String,
        previous: &HeldGoal,
        refused_objective: &str,
    ) -> Result<(), CodexError> {
        self.run_routes.begin_goal_replace(
            session_id,
            absorbed_refused_replace(previous, refused_objective),
        );
        let restored = connection
            .request_ordered(
                THREAD_GOAL_SET_METHOD,
                &held_goal_params(thread_id, previous),
                self.goal_replace_hook(session_id, move |run_routes: &CodexRunRoutes| {
                    run_routes.end_goal_replace(session_id);
                }),
            )
            .await;
        // An unanswered put-back ran no hook, so no update can be awaited.
        if restored.is_err() {
            self.run_routes.end_goal_replace(session_id);
        }
        restored.map(drop)
    }

    // The hook a replace's set or put-back answers through, at the answer's place among Codex's
    // frames: the goal answered becomes the update that ends `session_id`'s replace, an answer
    // with no readable goal ends it, and an error answer runs `on_refused`.
    fn goal_replace_hook(
        &self,
        session_id: SessionId,
        on_refused: impl FnOnce(&CodexRunRoutes) + Send + 'static,
    ) -> CodexAnswerHook {
        let run_routes = Arc::clone(&self.run_routes);
        Box::new(move |answer| {
            let Some(answer) = answer else {
                on_refused(&run_routes);
                return;
            };
            match read_codex_object::<ThreadGoalSetAnswer>(answer.get()) {
                Some(ThreadGoalSetAnswer { goal: Some(goal) }) => {
                    run_routes.await_goal_replace_update(session_id, goal);
                }
                _ => run_routes.end_goal_replace(session_id),
            }
        })
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

// Codex's answer to `thread/goal/get`: the conversation's goal, or none.
#[derive(Deserialize)]
struct ThreadGoalGetAnswer {
    goal: Option<HeldGoal>,
}

// Codex's answer to `thread/goal/set`: the goal as set, the value its update carries.
#[derive(Deserialize)]
struct ThreadGoalSetAnswer {
    goal: Option<Value>,
}

// A conversation's goal as `thread/goal/get` answers it, in the members a set puts back.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeldGoal {
    objective: String,
    status: ThreadGoalStatus,
    token_budget: Option<i64>,
}

// The replace mark of a refused replace of `previous` to `refused_objective`: the updates of either
// goal draw no row, and the put-back's own draws none either, since the goal did not change.
fn absorbed_refused_replace(previous: &HeldGoal, refused_objective: &str) -> CodexGoalReplace {
    CodexGoalReplace {
        absorbed_objectives: vec![previous.objective.clone(), refused_objective.to_owned()],
        awaited_goal: None,
        is_drawn: false,
    }
}

// The words a set whose turn never started is refused with, and its goal's run ends failed on.
fn no_turn_words() -> String {
    format!(
        "Codex started no turn for the goal within {CODEX_TURN_START_TIMEOUT:?}, so the goal was \
         put back with its objective, status and budget."
    )
}

// A goal change Codex did not take, carrying `words`.
fn not_applied(words: String) -> DriverGoalResult {
    DriverGoalResult::Degraded {
        fallback_action: Some(FreeFormText::new(words).expect("the words fit a fallback action")),
    }
}

// A new goal set as the person's own act, `active`, as Codex's own terminal sets one: a person
// typing a goal wants it pursued now. It carries no token budget, so it starts with Codex's own.
fn new_goal_params(thread_id: String, goal_text: String) -> ThreadGoalSetParams {
    ThreadGoalSetParams {
        thread_id,
        origin: Some(ThreadGoalMutationOrigin::User),
        objective: Some(goal_text),
        status: Some(ThreadGoalStatus::Active),
        token_budget: None,
    }
}

// The conversation's goal, or `None` when it has none. Fails as the request fails, and with
// `CodexError::Transport` when the answer does not read as a goal.
async fn read_goal(
    connection: &CodexAppServerConnection,
    thread_id: &str,
) -> Result<Option<HeldGoal>, CodexError> {
    let answer = connection
        .request(
            THREAD_GOAL_GET_METHOD,
            &ThreadGoalGetParams {
                thread_id: thread_id.to_owned(),
            },
        )
        .await?;
    read_codex_object::<ThreadGoalGetAnswer>(answer.get())
        .map(|answer| answer.goal)
        .ok_or_else(|| CodexError::Transport {
            detail: "Codex's answer to a goal read is unreadable.".to_owned(),
            cause: None,
        })
}

// Puts the conversation's goal back to `previous`, clearing it where there was none. Fails as the
// request fails.
async fn restore_goal(
    connection: &CodexAppServerConnection,
    thread_id: String,
    previous: Option<&HeldGoal>,
) -> Result<(), CodexError> {
    let Some(goal) = previous else {
        return clear_goal(connection, thread_id).await;
    };
    connection
        .request(THREAD_GOAL_SET_METHOD, &held_goal_params(thread_id, goal))
        .await
        .map(drop)
}

// `goal` set back, its usage starting afresh, as Codex's own replace does. It goes as the person's
// own act, as the set did, so the model's history ends on the goal the conversation holds. A goal
// with no token budget sends none, keeping the new goal's: Codex gives a goal set with none, or
// with a cleared one, its configured default.
fn held_goal_params(thread_id: String, goal: &HeldGoal) -> ThreadGoalSetParams {
    ThreadGoalSetParams {
        thread_id,
        origin: Some(ThreadGoalMutationOrigin::User),
        objective: Some(goal.objective.clone()),
        status: Some(goal.status),
        token_budget: goal.token_budget,
    }
}

// Clears the conversation's goal as the person's own act. Fails as the request fails.
async fn clear_goal(
    connection: &CodexAppServerConnection,
    thread_id: String,
) -> Result<(), CodexError> {
    connection
        .request(
            THREAD_GOAL_CLEAR_METHOD,
            &ThreadGoalClearParams {
                thread_id,
                origin: Some(ThreadGoalMutationOrigin::User),
            },
        )
        .await
        .map(drop)
}

#[cfg(test)]
mod tests;
