//! A turn Codex starts on a session by itself, such as its work on an active goal: the session's
//! own run opens on the turn's `turn/started`, never before, so a goal Codex leaves alone makes no
//! run. The open runs on the session's task before that frame is delivered, so the frames behind it
//! wait in the session's queue, in order, and none of the turn's frames reaches the run engine
//! before its run exists. The open runs on the conversation as it stands and waits for no config
//! fork, whose call sits behind it in the same queue. A turn whose run cannot open, such as one
//! Codex starts while a lead run waits to start, is interrupted, so no turn runs with no run, and a
//! start waits for its end.

use std::error::Error;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use serde::Deserialize;
use serde_json::value::RawValue;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::run::start::record::{CodexRunCallDependencies, route_accepted_turn};
use crate::driver::codex::run::turn_interrupt::{CodexTurnInterrupt, interrupt_codex_turn};
use crate::driver::codex::session::calls::CodexSessionTask;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::fork::bind_codex_first_run;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::transport::connection::read_codex_object;
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::driver::run_control::{DaemonTurnBinding, DaemonTurnBindingResolver};
use crate::port::run_host::RunHost;
use crate::run::start_request::DaemonTurnStartRequest;
use sidekicks_std::mutex_lock::lock;

const TURN_STARTED_METHOD: &str = "turn/started";

/// What opening the run of a turn Codex started acts through beside the record's own.
pub(crate) struct CodexSelfStartedTurnDependencies {
    /// The run engine, which opens the session's own run.
    pub(crate) engine: Arc<dyn RunHost>,
    /// Opens the run's binding.
    pub(crate) daemon_turn_bindings: Arc<dyn DaemonTurnBindingResolver>,
}

/// The members of a `turn/started` the open reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnStartedFrame {
    thread_id: Option<String>,
    turn: Option<StartedTurn>,
}

#[derive(Deserialize)]
struct StartedTurn {
    id: Option<String>,
}

/// Opens the session's own run for a turn Codex started by itself on the session's conversation,
/// on the session's task before the frame `method` with `params` is delivered: the run takes the
/// turn, so the frame and those behind it reach it. A turn whose run does not open is kept as one
/// no run holds and interrupted; each failure is reported. Any other frame passes untouched.
pub(crate) async fn open_codex_self_started_turn(
    task: &mut CodexSessionTask<'_>,
    runs: &CodexRunCallDependencies,
    dependencies: &CodexSelfStartedTurnDependencies,
    method: &str,
    params: &RawValue,
) {
    let Some(turn_id) = read_self_started_turn_id(task.record, method, params) else {
        return;
    };
    let record = &mut *task.record;
    record
        .delivery
        .self_started_turn_ids
        .insert(turn_id.clone());
    record.delivery.self_started_turn_opening = Some(turn_id.clone());
    task.waiters.settle(record);
    let opened = open_run(record, runs, dependencies, &turn_id).await;
    record.delivery.self_started_turn_opening = None;
    if let Err(error) = opened {
        // No run takes the turn: its frames go on as frames of a turn no run holds.
        if !record.is_turn_settled(&turn_id) {
            record.delivery.unowned_turn_ids.insert(turn_id.clone());
        }
        CodexTransportDiagnostic::ProviderTurnRunFailed {
            session_id: record.session_id,
            error,
        }
        .report();
        interrupt_unowned_turn(record, &turn_id).await;
    }
    task.waiters.settle(record);
}

// Opens the run through the run engine, the turn's id standing for the reply a turn the daemon
// starts waits for, then binds the run and routes the turn to it.
async fn open_run(
    record: &mut CodexSessionRecord,
    runs: &CodexRunCallDependencies,
    dependencies: &CodexSelfStartedTurnDependencies,
    turn_id: &str,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let session_id = record.session_id;
    let opened_binding: Arc<Mutex<Option<DaemonTurnBinding>>> = Arc::new(Mutex::new(None));
    let resolver = Arc::clone(&dependencies.daemon_turn_bindings);
    let binding_slot = Arc::clone(&opened_binding);
    let connection = record.service.connection()?;
    let thread_id = record.thread_id.clone();
    let interrupted_turn_id = turn_id.to_owned();
    let run_id = dependencies
        .engine
        .start_daemon_turn(DaemonTurnStartRequest {
            session_id,
            provider: DESCRIPTOR.provider_id(),
            admitted_provider_account_id: record.provider_account_id.clone(),
            execution_posture: record.execution_posture.clone(),
            is_provider_started: true,
            is_apart: false,
            start_turn: Box::new(move |run_id| {
                let resolver = Arc::clone(&resolver);
                let binding_slot = Arc::clone(&binding_slot);
                async move {
                    let binding = resolver
                        .open_daemon_turn_binding(run_id, session_id)
                        .await?;
                    *lock(&binding_slot) = Some(binding);
                    Ok(())
                }
                .boxed()
            }),
            interrupt_turn: Box::new(move |_run_id| {
                let connection = Arc::clone(&connection);
                let thread_id = thread_id.clone();
                let turn_id = interrupted_turn_id.clone();
                async move {
                    match interrupt_codex_turn(&connection, &thread_id, &turn_id).await {
                        // A turn that already ended has nothing left to stop.
                        Ok(CodexTurnInterrupt::Stopped | CodexTurnInterrupt::AlreadyEnded) => {
                            Ok(())
                        }
                        Err(error) => Err(Box::new(error) as Box<dyn Error + Send + Sync>),
                    }
                }
                .boxed()
            }),
        })
        .await?;
    let binding = lock(&opened_binding)
        .take()
        .ok_or_else(|| CodexError::Transport {
            detail: format!(
                "The run of the turn Codex started on \"{session_id}\" has no binding."
            ),
            cause: None,
        })?;
    runs.run_routes.bind_run_delivery(
        run_id,
        CodexRunBinding {
            session_id,
            binding_id: binding.binding_id.clone(),
            agent_id: binding.agent_id,
            step_bound: binding.step_bound,
        },
    );
    let adoption = runs.adoptions.adopt(record, binding.binding_id.clone());
    // The run already runs, so a failed write leaves those conversations owed to the next one.
    if adoption.is_first_binding()
        && let Err(error) =
            bind_codex_first_run(record, runs.bindings.as_ref(), &binding.binding_id).await
    {
        tracing::error!(
            session_id = %session_id,
            run_id = %run_id,
            error = &error as &(dyn Error + 'static),
            "the conversations a Codex session left were not recorded on its first run's binding"
        );
    }
    route_accepted_turn(&runs.run_routes, record, run_id, turn_id);
    Ok(())
}

// Ends a turn no run holds, unless its frames already ended it or the daemon is already stopping
// it.
async fn interrupt_unowned_turn(record: &CodexSessionRecord, turn_id: &str) {
    if !record.delivery.unowned_turn_ids.contains(turn_id)
        || record.interrupted_turn_run(turn_id).is_some()
    {
        return;
    }
    let interrupted = match record.service.connection() {
        Ok(connection) => interrupt_codex_turn(&connection, &record.thread_id, turn_id).await,
        Err(error) => Err(error),
    };
    if let Err(error) = interrupted {
        CodexTransportDiagnostic::ProviderTurnInterruptFailed {
            session_id: record.session_id,
            error: Box::new(error),
        }
        .report();
    }
}

// The turn a `turn/started` names on the session's own conversation when no run started it: no
// turn of the session's runs in flight, nothing starting, and not one whose run already failed to
// open or that already ended.
fn read_self_started_turn_id(
    record: &CodexSessionRecord,
    method: &str,
    params: &RawValue,
) -> Option<String> {
    if method != TURN_STARTED_METHOD {
        return None;
    }
    let frame = read_codex_object::<TurnStartedFrame>(params.get())?;
    if frame.thread_id.as_deref() != Some(record.thread_id.as_str()) {
        return None;
    }
    let turn_id = frame.turn?.id.filter(|id| !id.is_empty())?;
    let is_taken = record.is_turn_in_flight(None)
        || record.is_turn_settled(&turn_id)
        || record.delivery.unowned_turn_ids.contains(&turn_id);
    (!is_taken).then_some(turn_id)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use crate::driver::codex::session::test_session::{
        TestCodexSession, answer_fork, turn_completed, turn_started,
    };

    /// How long the test waits before it counts a hold on the session's task as a deadlock.
    const DEADLOCK_BOUND: Duration = Duration::from_secs(10);

    // Kills: the open of a turn Codex started joining the config fork in flight, whose call waits
    // behind the open in the session's queue (the test times out).
    #[tokio::test]
    async fn a_turn_codex_starts_while_a_config_fork_waits_opens_its_run_and_the_fork_goes_after() {
        let mut session = TestCodexSession::start().await;
        let binding_id = session.record_binding().await;
        session.daemon_turn_bindings.open_on(binding_id);
        session.task.record.is_config_fork_owed = true;
        let session_id = session.task.record.session_id;
        let inbound = session.task.record.inbound.clone();
        let config_forks = Arc::clone(&session.task.calls.runs.config_forks);
        let settings = session.task.record.thread_settings.clone();
        // The turn's start queues first, then a config fork's call behind it.
        session.scripted.script.send(&turn_started("turn-1"));
        let started = session.task.next_item().await;
        let waiting_fork = tokio::spawn(config_forks.fork(session_id, &inbound));
        let fork_call = session.task.next_item().await;
        let task = &mut session.task;
        let script = &mut session.scripted.script;
        let flow = async {
            task.handle(started).await;
            let run_id = task
                .record
                .active_turn_run("turn-1")
                .expect("the turn's run opened before its frame went on");
            task.handle(fork_call).await;
            let has_forked = waiting_fork
                .await
                .expect("the fork's task ends")
                .expect("the fork does not fail");
            assert!(!has_forked, "no fork goes while the turn runs");
            script.send(&turn_completed("thread-1", "turn-1", "completed"));
            task.handle_next().await;
            assert!(task.record.active_turns.is_empty(), "the turn ended");
            assert_eq!(task.record.thread_id, "thread-1");
            tokio::join!(
                task.handle_next(),
                answer_fork(script, "thread-2", &settings)
            );
            run_id
        };
        tokio::time::timeout(DEADLOCK_BOUND, flow)
            .await
            .expect("the run opens without waiting on the fork behind it");
        assert_eq!(
            session.task.record.thread_id, "thread-2",
            "the fork went after the turn"
        );
        assert!(!session.task.record.is_config_fork_owed);
    }
}
