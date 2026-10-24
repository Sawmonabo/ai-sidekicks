//! A turn's start on the session's record, in two calls on the session's task around the request
//! that starts it, which goes off the task: the first checks the session can take the turn, points
//! the session's binding at the run's, and puts the run first among the runs whose turn is
//! starting, so a turn Codex starts before it answers is the run's; the second reads Codex's
//! answer, routes the accepted turn to its run and takes the run off that list. A start Codex
//! refused leaves the session as it was; one whose outcome is unknown stops the turn Codex may have
//! accepted and lets the session's conversation go.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::Value;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;

use crate::provider::driver::codex::attachments::compose_codex_message_input;
use crate::provider::driver::codex::capabilities::read_codex_service_model_catalog;
use crate::provider::driver::codex::output_speed::{
    CodexSettledOutputSpeed, arm_codex_run_output_speed, compose_codex_service_tier,
    resolve_codex_output_speed_level,
};
use crate::provider::driver::codex::permission_level::compose_codex_approvals_reviewer;
use crate::provider::driver::codex::run::routes::CodexRunRoutes;
use crate::provider::driver::codex::run::turn_interrupt::interrupt_codex_turn;
use crate::provider::driver::codex::session::calls::CodexSessionTask;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::fork::bind_codex_first_run;
use crate::provider::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::provider::driver::codex::session::state::{
    CodexSessionRecord, CodexTurnInput, CodexTurnMessage,
};
use crate::provider::driver::codex::thread::settings::{
    CodexTurnStartParams, compose_codex_collaboration_mode,
};
use crate::provider::driver::codex::transport::connection::CodexAppServerConnection;
use crate::provider::driver::codex::transport::diagnostics::{
    CodexTeardownStep, CodexTransportDiagnostic,
};
use crate::provider::runtime_binding::rebinder::RuntimeBindingRebinder;

/// One run's turn to start: the person's messages with their skills and files, in send order, and
/// what the turn carries.
#[derive(Clone, Debug)]
pub(crate) struct CodexTurnRequest {
    /// The messages.
    pub(crate) messages: Vec<CodexTurnMessage>,
    /// The ids the messages went under, which an undo's cut later names.
    pub(crate) client_message_ids: Vec<String>,
    /// The model the turn runs on from this turn on; `None` keeps the conversation's.
    pub(crate) model: Option<String>,
    /// The output speed the run asks for; `None` keeps the session's.
    pub(crate) output_speed: Option<String>,
    /// A level for this turn alone, the conversation keeping its own for the turns after it.
    pub(crate) output_speed_for_turn: Option<String>,
    /// The JSON Schema the turn's final message must follow.
    pub(crate) output_schema: Option<Value>,
    /// The run's level, whose reviewer the turn carries; `None` keeps the conversation's.
    pub(crate) level: Option<PermissionLevel>,
}

/// What a turn's start asks of the record: the run, its turn, or none for a turn the daemon starts
/// with a request of its own, and the binding the session takes for it.
#[derive(Clone, Debug)]
pub(crate) struct CodexTurnBegin {
    /// The run.
    pub(crate) run_id: RunId,
    /// The run's turn; `None` for a turn the daemon starts itself.
    pub(crate) turn: Option<CodexTurnRequest>,
    /// The run's binding, which a fork during or after the start points at its conversation.
    pub(crate) binding_id: RuntimeBindingId,
    /// Set once the run no longer wants the turn, which then goes unsent; `None` for a start no
    /// one withdraws.
    pub(crate) withdrawn: Option<Arc<AtomicBool>>,
}

/// How the record took a turn's start.
pub(crate) enum CodexTurnBeginAnswer {
    /// The turn goes now: the run waits as the turn starting next.
    Ready(Box<CodexTurnSend>),
    /// A turn the daemon is stopping, or one Codex started that no run holds, ends first.
    WaitForStoppedTurns,
    /// The conversation owes a fork onto a changed config first.
    ForkOwed,
    /// The session cannot take the turn.
    Refused(CodexError),
}

/// A turn's start the record took, to send off the task.
pub(crate) struct CodexTurnSend {
    /// The connection the turn goes on.
    pub(crate) connection: Arc<CodexAppServerConnection>,
    /// The conversation it starts on.
    pub(crate) thread_id: String,
    /// The `turn/start` params; `None` for a turn the daemon starts with a request of its own.
    pub(crate) params: Option<CodexTurnStartParams>,
    /// What the turn's acceptance changes on the record.
    pub(crate) accepted: CodexAcceptedTurn,
}

/// What a turn's acceptance changes on the record, and the binding its start adopted.
pub(crate) struct CodexAcceptedTurn {
    adoption: CodexBindingAdoption,
    /// What a run's own turn carries; `None` for a turn the daemon starts.
    run_turn: Option<CodexAcceptedRunTurn>,
}

/// What a run's own turn changes on the record once Codex accepts it.
struct CodexAcceptedRunTurn {
    /// The model the conversation runs on from the turn on.
    model: String,
    /// The output speed the conversation is asked to run at from the turn on.
    output_speed_request: Option<String>,
    /// The level the turn was sent at, which its speed report compares.
    sent_output_speed: Option<String>,
    /// The turn's input, kept for a faster-model retry.
    input: CodexTurnInput,
}

/// How a turn's start went at Codex: the turn it started, or the request's failure, with whether
/// that failure proves no turn started.
pub(crate) enum CodexTurnStartOutcome {
    /// Codex started the turn.
    Started {
        /// The turn.
        turn_id: String,
    },
    /// Codex started no turn: it refused the request, the request was never sent, or no turn
    /// started within the start's deadline.
    NotStarted(CodexError),
    /// The request failed in a way that may hide a turn Codex accepted.
    Unclear(CodexError),
}

impl CodexTurnStartOutcome {
    /// The outcome of a request whose reply names the turn, or that failed with `error`: a refusal
    /// Codex answered and a request too large to send prove no turn started.
    pub(crate) fn of_request(turn_id: Result<String, CodexError>) -> Self {
        match turn_id {
            Ok(turn_id) => Self::Started { turn_id },
            Err(
                error @ (CodexError::ProviderRequest { .. } | CodexError::RequestTooLarge { .. }),
            ) => Self::NotStarted(error),
            Err(error) => Self::Unclear(error),
        }
    }
}

/// Lets a session whose turn's start had an unknown outcome go, its conversation unsubscribed so
/// nothing of a turn Codex may have accepted runs on unseen; the service stays.
pub(crate) trait CodexSessionDisposal: Send + Sync {
    /// Lets `session_id`'s record go, off the caller's task.
    fn dispose(&self, session_id: SessionId);
}

/// Each session's latest binding adoption, so a failed start undoes only an adoption no later
/// start made since, even one adopting the same binding.
#[derive(Default)]
pub(crate) struct CodexBindingAdoptions {
    latest_by_session: Mutex<HashMap<SessionId, u64>>,
}

/// One start's adoption of its run's binding as the session's: the binding the session had, and
/// the adoption's place among the session's.
pub(crate) struct CodexBindingAdoption {
    binding_id: RuntimeBindingId,
    previous_binding_id: Option<RuntimeBindingId>,
    generation: u64,
}

impl CodexBindingAdoption {
    /// Whether the session had no binding before this adoption, so its first run records the
    /// conversations it left.
    pub(crate) fn is_first_binding(&self) -> bool {
        self.previous_binding_id.is_none()
    }
}

impl CodexBindingAdoptions {
    /// Makes `binding_id` the binding of `record`'s session.
    pub(crate) fn adopt(
        &self,
        record: &mut CodexSessionRecord,
        binding_id: RuntimeBindingId,
    ) -> CodexBindingAdoption {
        let generation = {
            let mut latest = self.lock();
            let generation = latest
                .get(&record.session_id)
                .map_or(1, |latest| latest + 1);
            latest.insert(record.session_id, generation);
            generation
        };
        let previous_binding_id = record.binding_id.replace(binding_id.clone());
        CodexBindingAdoption {
            binding_id,
            previous_binding_id,
            generation,
        }
    }

    /// Restores the binding `adoption` replaced, while it is still the session's latest adoption
    /// and the session still holds its binding.
    pub(crate) fn undo(&self, record: &mut CodexSessionRecord, adoption: CodexBindingAdoption) {
        let is_latest = self.lock().get(&record.session_id) == Some(&adoption.generation);
        if is_latest && record.binding_id.as_ref() == Some(&adoption.binding_id) {
            record.binding_id = adoption.previous_binding_id;
        }
    }

    /// Forgets a closed session's adoptions.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        self.lock().remove(&session_id);
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<SessionId, u64>> {
        self.latest_by_session
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

/// What a turn's start acts through on the record.
pub(crate) struct CodexRunCallDependencies {
    /// The driver's run routes.
    pub(crate) run_routes: Arc<CodexRunRoutes>,
    /// The config forks, which a start that leaves no turn running lets go on.
    pub(crate) config_forks: Arc<CodexConfigForks>,
    /// The sessions' binding adoptions.
    pub(crate) adoptions: Arc<CodexBindingAdoptions>,
    /// The runtime bindings, where a session's first run records the conversations it left.
    pub(crate) bindings: Arc<dyn RuntimeBindingRebinder>,
    /// Lets a session whose start had an unknown outcome go.
    pub(crate) disposal: Arc<dyn CodexSessionDisposal>,
}

/// Takes a turn's start on the record, on the session's task: refuses it while a turn Codex
/// started by itself runs as a run's, a turn the daemon starts while any turn is in flight, since
/// Codex would fold it in, and a turn its run withdrew; owes a wait or a fork first where one is
/// owed; else adopts the run's binding, resolves the turn's output speed against the model's tier
/// list and puts the run first among the runs whose turn is starting.
pub(crate) async fn begin_codex_turn_start(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexRunCallDependencies,
    begin: CodexTurnBegin,
) -> CodexTurnBeginAnswer {
    let record = &mut *task.record;
    let session_id = record.session_id;
    let session_turn_in_flight =
        || CodexTurnBeginAnswer::Refused(CodexError::SessionTurnInFlight { session_id });
    if begin
        .withdrawn
        .as_ref()
        .is_some_and(|withdrawn| withdrawn.load(Ordering::Acquire))
    {
        return CodexTurnBeginAnswer::Refused(CodexError::TurnWithdrawn {
            run_id: begin.run_id,
        });
    }
    // Codex would fold a turn the daemon starts into one in flight, which the queue holds it for.
    if begin.turn.is_none() && record.is_turn_in_flight(None) {
        return session_turn_in_flight();
    }
    if !record.ending_turn_ids().is_empty() || !record.delivery.unowned_turn_ids.is_empty() {
        return CodexTurnBeginAnswer::WaitForStoppedTurns;
    }
    let is_self_started_turn_running = record
        .delivery
        .self_started_turn_ids
        .iter()
        .any(|turn_id| record.active_turn_run(turn_id).is_some());
    if is_self_started_turn_running {
        return session_turn_in_flight();
    }
    if record.is_config_fork_owed {
        return CodexTurnBeginAnswer::ForkOwed;
    }
    let connection = match record.service.connection() {
        Ok(connection) => connection,
        Err(error) => return CodexTurnBeginAnswer::Refused(error),
    };
    let run_turn = match begin.turn {
        Some(turn) => match compose_run_turn(record, &connection, turn).await {
            Ok(run_turn) => Some(run_turn),
            Err(error) => return CodexTurnBeginAnswer::Refused(error),
        },
        None => None,
    };
    let adoption = dependencies
        .adoptions
        .adopt(record, begin.binding_id.clone());
    if adoption.is_first_binding()
        && let Err(error) =
            bind_codex_first_run(record, dependencies.bindings.as_ref(), &begin.binding_id).await
    {
        dependencies.adoptions.undo(record, adoption);
        return CodexTurnBeginAnswer::Refused(error);
    }
    // Frames of the turn that arrive before Codex answers belong to this run.
    record
        .delivery
        .starting_turn_run_ids
        .push_back(begin.run_id);
    let params = run_turn.as_ref().map(|(params, _)| params.clone());
    CodexTurnBeginAnswer::Ready(Box::new(CodexTurnSend {
        connection,
        thread_id: record.thread_id.clone(),
        params,
        accepted: CodexAcceptedTurn {
            adoption,
            run_turn: run_turn.map(|(_, accepted)| accepted),
        },
    }))
}

// A run's turn as `turn/start` carries it, and what the turn changes once Codex accepts it: the
// run's level wins and the conversation's request is the fallback, each resolved against the
// model's tier list afresh, since the catalog can change.
async fn compose_run_turn(
    record: &CodexSessionRecord,
    connection: &CodexAppServerConnection,
    turn: CodexTurnRequest,
) -> Result<(CodexTurnStartParams, CodexAcceptedRunTurn), CodexError> {
    let model = turn
        .model
        .clone()
        .unwrap_or_else(|| record.thread_settings.model.clone());
    let output_speed_request = turn
        .output_speed
        .clone()
        .or_else(|| record.output_speed_request.clone());
    let sent_output_speed =
        resolve_output_speed(connection, &model, output_speed_request.clone()).await?;
    let output_speed_for_turn =
        resolve_output_speed(connection, &model, turn.output_speed_for_turn.clone()).await?;
    let params = CodexTurnStartParams {
        thread_id: record.thread_id.clone(),
        input: compose_codex_message_input(&turn.messages),
        approvals_reviewer: Some(
            compose_codex_approvals_reviewer(turn.level.unwrap_or(record.thread_settings.level))
                .into(),
        ),
        // Every turn names its mode: Codex's own plan mode in Plan, its default in Build.
        collaboration_mode: Some(compose_codex_collaboration_mode(
            record.session_mode,
            model.clone(),
            record.reasoning_effort.as_deref(),
        )),
        model: turn.model,
        client_user_message_id: turn.client_message_ids.first().cloned(),
        output_schema: turn.output_schema,
        service_tier: compose_codex_service_tier(sent_output_speed.as_deref()),
        // Codex applies it to this turn's copy of the settings alone, and reads `default` as
        // standard.
        service_tier_for_turn: output_speed_for_turn,
    };
    Ok((
        params,
        CodexAcceptedRunTurn {
            model,
            output_speed_request,
            sent_output_speed,
            input: CodexTurnInput {
                messages: turn.messages,
                client_message_ids: turn.client_message_ids,
                output_speed_for_turn: turn.output_speed_for_turn,
            },
        },
    ))
}

/// Settles a turn's start on the record with Codex's outcome, on the session's task: the run
/// leaves the runs whose turn is starting; a started turn is routed to the run, unless a turn of
/// another run already took its id, which fails the start; a start that started no turn lets a
/// fork owed meanwhile go on; one whose outcome is unknown stops the run's turn where its first
/// frame named one and lets the session's conversation go. A failed start gives the session back
/// its binding. Answers the speed report a turn that already ended settled at.
pub(crate) async fn settle_codex_turn_start(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexRunCallDependencies,
    run_id: RunId,
    accepted: CodexAcceptedTurn,
    outcome: CodexTurnStartOutcome,
) -> Result<Option<CodexSettledOutputSpeed>, CodexError> {
    let record = &mut *task.record;
    if let Some(at) = record
        .delivery
        .starting_turn_run_ids
        .iter()
        .position(|starting| *starting == run_id)
    {
        record.delivery.starting_turn_run_ids.remove(at);
    }
    let turn_id = match outcome {
        CodexTurnStartOutcome::Started { turn_id } => turn_id,
        CodexTurnStartOutcome::NotStarted(error) => {
            dependencies.adoptions.undo(record, accepted.adoption);
            note_start_settled(dependencies, record);
            return Err(error);
        }
        CodexTurnStartOutcome::Unclear(error) => {
            dependencies.adoptions.undo(record, accepted.adoption);
            abandon_unclear_turn(dependencies, record, run_id).await;
            return Err(error);
        }
    };
    // Codex took the run's input into a turn it started by itself, which the run claimed as it
    // started; a turn another run holds cannot be this run's.
    if let Some(holder) = record.active_turn_run(&turn_id)
        && holder != run_id
    {
        tracing::error!(
            session_id = %record.session_id,
            run_id = %run_id,
            holder_run_id = %holder,
            turn_id = turn_id.as_str(),
            "Codex answered a run's turn start with a turn another run holds"
        );
        dependencies.adoptions.undo(record, accepted.adoption);
        return Err(CodexError::Transport {
            detail: format!(
                "Codex answered the turn start of run \"{run_id}\" with turn \"{turn_id}\", which \
                 another run holds."
            ),
            cause: None,
        });
    }
    let mut settled = None;
    let mut input = None;
    if let Some(run_turn) = accepted.run_turn {
        // The provider applies a turn's model and tier from that turn on, so the conversation now
        // holds them, and a resume after a crash sends them again.
        record.thread_settings.model = run_turn.model;
        record.output_speed_request = run_turn.output_speed_request;
        settled = arm_codex_run_output_speed(
            record,
            turn_id.clone(),
            run_id,
            run_turn.sent_output_speed.as_deref(),
        );
        for client_message_id in &run_turn.input.client_message_ids {
            record
                .turn_id_by_client_message_id
                .insert(client_message_id.clone(), turn_id.clone());
        }
        input = Some(run_turn.input);
    }
    if route_accepted_turn(&dependencies.run_routes, record, run_id, &turn_id) {
        if let Some(input) = input {
            record.turn_input_by_turn_id.insert(turn_id, input);
        }
    } else {
        // The turn ended before its answer, while it still counted as starting.
        note_start_settled(dependencies, record);
    }
    Ok(settled)
}

/// Records an accepted turn's boundary and routes it to its run; `false` for a turn already over,
/// which gets no route, since nothing would ever retire it.
pub(crate) fn route_accepted_turn(
    run_routes: &CodexRunRoutes,
    record: &mut CodexSessionRecord,
    run_id: RunId,
    turn_id: &str,
) -> bool {
    // Appended at acceptance, not completion: a completion-time ledger would omit interrupted and
    // failed turns and misname later positions.
    if !record
        .turn_boundaries
        .iter()
        .any(|boundary| boundary == turn_id)
    {
        record.turn_boundaries.push(turn_id.to_owned());
    }
    if record.is_turn_settled(turn_id) {
        return false;
    }
    if record.active_turn_run(turn_id).is_none() {
        record.add_active_turn(turn_id.to_owned(), run_id);
        run_routes.bind_run(run_id, record.session_id);
    }
    true
}

// A start that left no turn running: a fork owed meanwhile goes on, since no turn's end will come
// to say so.
fn note_start_settled(dependencies: &CodexRunCallDependencies, record: &CodexSessionRecord) {
    dependencies.config_forks.note_turn_settled(record);
}

// After a start whose outcome is unknown: the turn Codex may have accepted, where its first frame
// named it, is stopped, then the session's conversation is let go, so nothing of it runs on
// unseen. The service stays for its other conversations.
async fn abandon_unclear_turn(
    dependencies: &CodexRunCallDependencies,
    record: &CodexSessionRecord,
    run_id: RunId,
) {
    if let Some(turn_id) = record.newest_active_turn_for_run(run_id)
        && let Ok(connection) = record.service.connection()
        && let Err(error) = interrupt_codex_turn(&connection, &record.thread_id, turn_id).await
    {
        CodexTransportDiagnostic::TeardownStepFailed {
            step: CodexTeardownStep::TurnInterrupt,
            error: Box::new(error),
        }
        .report();
    }
    dependencies.disposal.dispose(record.session_id);
}

async fn resolve_output_speed(
    connection: &CodexAppServerConnection,
    model: &str,
    level: Option<String>,
) -> Result<Option<String>, CodexError> {
    resolve_codex_output_speed_level(
        || read_codex_service_model_catalog(connection),
        model,
        level,
    )
    .await
    .map_err(CodexError::Driver)
}
