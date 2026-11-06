//! How a run a restart left live settles when recovery cannot resume it: interrupted when the
//! person had asked to stop it or it was a child held when the daemon went down, interrupted or
//! stopped with its limit when its log still owes one, left alone when it is queued behind a
//! message still waiting to start it or is a lead the person paused, a lead's pause under way
//! reached, failed otherwise; a provider's helper beneath a run whose stop wins reads interrupted,
//! cut by the restart. A run with open turns ends them as the daemon's own report, each turn a
//! limit's interrupt row names with that limit's cause, the newest in the run's own write. And
//! how a run moves once a resume succeeded, from its state before the restart and what its
//! provider holds of its turn: left while the provider runs or ends its turn or the run rests,
//! paused out of `pausing`, and interrupted with `daemonRestart` where its turn is gone; a run
//! a pending stop waits on, or a helper beneath one, is never resumed past that stop. And how the
//! person's stop of the service settles each live run: by its own stops, a paused lead left, a
//! run waiting on the refusal choice failed with that refusal, a queued run stopped, and any other
//! interrupted with `daemonStop`, its open turns ending with that cause.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::event::envelope::EventCategory;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::orchestration::InterruptReason;
use sidekicks_contracts::run::control::StopTrigger;
use sidekicks_contracts::run::events::{
    AgentInterventionAppliedPayload, AgentInterventionAppliedState, InterventionActor,
    InterventionDeviceActor, TurnEndCause,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    InterruptInterventionRecord, InterventionId, InterventionState, InterventionType, RunLimit,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::session_control::ProviderTurnAnswer;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};
use sidekicks_store::events::session::appender::{SessionEventDraft, SessionEventDraftError};

use crate::interventions::store::{
    InterventionTransition, UnresolvedInterventionState, move_intervention_statement, stored_actor,
    unresolved_state_of,
};
use crate::queue_store::{QueueItemReader, SELECT_WAITING_FOR_RUN_SQL};
use crate::run::engine::errors::RunEngineError;
use crate::run::engine::turns::guards::TURN_END_TYPES_SQL;
use crate::run::provider_choice::run_end::read_waiting_refusal;
use crate::run::read::{LiveRun, read_helper_lead};
use crate::run::state_change::RunWriteCompanions;

// The interrupts with no outcome yet of the run the SQL expression `run_id` names (a parameter or
// a column of an outer query), the person's or the daemon's own at a limit, in the order they were
// asked for. An applied one ends its run in the outcome's own write, so a live run never holds one.
// An undo's is left out: the undo it served ended with its process, so it is no stop, and the
// run's end or the turn's end settles it.
fn pending_interrupts_sql(run_id: &str) -> String {
    format!(
        "SELECT id, state, device_id, payload, expected_run_version, client_idempotency_key
  FROM interventions
  WHERE target_run_id = {run_id}
    AND type = '{}'
    AND state IN ('{}', '{}')
    AND json_extract(payload, '$.undoKey') IS NULL
  ORDER BY created_at, id",
        <&'static str>::from(InterventionType::Interrupt),
        <&'static str>::from(InterventionState::Requested),
        <&'static str>::from(InterventionState::Accepted)
    )
}

static SELECT_PENDING_INTERRUPTS_SQL: LazyLock<String> =
    LazyLock::new(|| pending_interrupts_sql("@run_id"));

// The limit still owed by the run the SQL expression `run_id` names: one whose reached event no
// end of the run by that limit followed. A token limit is discharged only by `agent.run.stopped`
// with its trigger, since a stopped run is never live again; a step limit by any later
// `agent.run.interrupted`, after which a continue counts the steps afresh. A token limit wins over
// a step limit, since its end is final.
fn owed_limit_sql(run_id: &str) -> String {
    let step = SessionEventType::AgentRunStepLimitReached;
    let token = SessionEventType::AgentRunTokenLimitReached;
    let interrupted = SessionEventType::AgentRunInterrupted;
    let stopped = SessionEventType::AgentRunStopped;
    let token_trigger =
        serde_json::to_value(StopTrigger::TokenLimit).expect("a closed word serializes");
    format!(
        "SELECT reached.type FROM session_events AS reached
  WHERE reached.run_id = {run_id}
    AND ((reached.category = '{token_category}' AND reached.type = '{token}')
      OR (reached.category = '{step_category}' AND reached.type = '{step}'))
    AND NOT EXISTS (
      SELECT 1 FROM session_events AS ended
       WHERE ended.run_id = {run_id}
         AND ended.sequence > reached.sequence
         AND ((reached.type = '{token}'
             AND ended.category = '{stopped_category}'
             AND ended.type = '{stopped}'
             AND json_extract(ended.payload, '$.trigger') = '{token_trigger}')
           OR (reached.type = '{step}'
             AND ended.category = '{interrupted_category}'
             AND ended.type = '{interrupted}')))
  ORDER BY CASE reached.type WHEN '{token}' THEN 0 ELSE 1 END
  LIMIT 1",
        token = token.as_str(),
        token_category = token.category().as_str(),
        step = step.as_str(),
        step_category = step.category().as_str(),
        interrupted = interrupted.as_str(),
        interrupted_category = interrupted.category().as_str(),
        stopped = stopped.as_str(),
        stopped_category = stopped.category().as_str(),
        token_trigger = token_trigger
            .as_str()
            .expect("a closed word serializes as text"),
    )
}

static SELECT_OWED_LIMIT_SQL: LazyLock<String> = LazyLock::new(|| owed_limit_sql("@run_id"));

/// Holds when a stop of the run the SQL expression `run_id` names (a parameter or a column of an
/// outer query) settles it, as [`read_has_own_stop`] reads its stops: an interrupt with no outcome
/// yet, or a limit it still owes.
pub(crate) fn run_has_own_stop_sql(run_id: &str) -> String {
    format!(
        "(EXISTS ({}) OR EXISTS ({}))",
        pending_interrupts_sql(run_id),
        owed_limit_sql(run_id)
    )
}

// Every open turn of the run a limit's interrupt row names as the turn its stop cut, with that
// limit: the row is the cut's one mark, read in any state but a failed or refused one's. The open
// turns are read through the turn events' own run columns.
static SELECT_TURN_CUTS_SQL: LazyLock<String> = LazyLock::new(|| {
    let started = SessionEventType::AgentTurnStarted;
    format!(
        "SELECT started.turn_number, json_extract(intervention.payload, '$.limit')
  FROM interventions AS intervention
  JOIN session_events AS started
    ON started.category = '{started_category}'
   AND started.type = '{started}'
   AND started.run_id = @run_id
   AND started.turn_number = json_extract(intervention.payload, '$.turnNumber')
  WHERE intervention.target_run_id = @run_id
    AND json_extract(intervention.payload, '$.limit') IS NOT NULL
    AND intervention.state IN ('{requested}', '{accepted}', '{applied}', '{degraded}')
    AND NOT EXISTS (
      SELECT 1 FROM session_events AS turn_end
       WHERE turn_end.category = '{turn_end_category}'
         AND turn_end.type IN ({turn_ends})
         AND turn_end.run_id = @run_id
         AND turn_end.turn_number = started.turn_number)",
        started = started.as_str(),
        started_category = started.category().as_str(),
        requested = <&'static str>::from(InterventionState::Requested),
        accepted = <&'static str>::from(InterventionState::Accepted),
        applied = <&'static str>::from(InterventionState::Applied),
        degraded = <&'static str>::from(InterventionState::Degraded),
        turn_end_category = EventCategory::RunLifecycle.as_str(),
        turn_ends = *TURN_END_TYPES_SQL,
    )
});

/// An interrupt a restart found with no outcome: its row, the state it leaves, who asked, its
/// stored record, which says whether the daemon was stopping the run at a limit, and the version
/// and key it was asked under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PendingInterrupt {
    /// The intervention.
    pub(crate) intervention_id: InterventionId,
    /// Where it stands.
    pub(crate) state: UnresolvedInterventionState,
    /// Who it is from: the device a person's came from, or the daemon for its own.
    pub(crate) actor: InterventionActor,
    /// Its stored record: a person's, or the daemon's own stop at a limit; an undo's is never read
    /// as pending.
    pub(crate) record: InterruptInterventionRecord,
    /// The run version it was asked against.
    pub(crate) expected_run_version: SafeInt<0>,
    /// The key it was asked under.
    pub(crate) client_idempotency_key: ClientUuid,
}

/// An open turn the log shows a limit cut, with the highest-ranked limit whose mark names it: what
/// a restart reads from the interrupts' rows, where no stop's identity is kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TurnCut {
    /// The turn.
    pub(crate) turn_number: SafeInt<1>,
    /// The limit it ends with.
    pub(crate) limit: RunLimit,
}

/// What a restart reads of a live run to decide how it settles: its pending interrupts, the limit
/// it still owes, every open turn a limit's interrupt row names as cut, whether it is stopping,
/// whether a message still waits in the queue for it, and whether it waits on the refusal choice.
/// A turn's cause is its cut's and the row is a cut's one mark, so a restart ends each turn with
/// the live path's limit, except where the turn's end races its stop's row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RestartFacts {
    /// The run's interrupts with no outcome yet, in the order they were asked for.
    pub(crate) pending_interrupts: Vec<PendingInterrupt>,
    /// The limit the run reached and no end of it by that limit followed, read whether or not an
    /// interrupt is pending: the daemon was stopping the run at it.
    pub(crate) owed_limit: Option<RunLimit>,
    /// Each open turn a limit's interrupt row names as cut, oldest first.
    pub(crate) turn_cuts: Vec<TurnCut>,
    /// Whether a stop wins over the run, its own or that of the run a provider's helper was
    /// dispatched beneath, as read before any run of the session settled; never for a queued
    /// run.
    pub(crate) is_stopping: bool,
    /// Whether a queued message targets the run, which starts it when its queue reaches it.
    pub(crate) has_queued_item: bool,
    /// Whether the run waits on the refusal choice no answer has settled; never for a run that
    /// is not `waitingForInput`.
    pub(crate) is_refusal_waiting: bool,
}

/// How a restart settles a live run: the end it gives it, or a lead's pause under way reached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RestartSettlement {
    /// `interrupted`, with the daemon's own reason where the interrupt was its own.
    Interrupted {
        /// Why the daemon interrupted the run; `None` for a person's interrupt.
        trigger: Option<InterruptReason>,
    },
    /// `stopped`, by the daemon at a limit.
    Stopped {
        /// Why the daemon stopped the run.
        trigger: StopTrigger,
    },
    /// `failed`, by the restart.
    Failed,
    /// `failed` with the refusal the run waits on, its choice settled `canceled`.
    Refused,
    /// `pausing → paused`: the lead's pause reached, since no provider runs its turn on.
    Paused,
}

/// How a restart or the person's stop of the service ends an open turn no limit cut, with the
/// decision's cause, reported by the daemon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RestartTurnEnd {
    /// `agent.turn.interrupted`.
    Interrupted,
    /// `agent.turn.failed`.
    Failed,
}

/// How a restart or the person's stop of the service settles one live run: its end or its pause
/// reached, and how an open turn no limit cut ends. A turn's cause is its cut's whatever settles
/// the run: each cut turn ends interrupted with its limit, every other open turn as
/// `open_turn_end` with `turn_cause`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RestartDecision {
    /// The run's end, or its pause reached.
    pub(crate) settlement: RestartSettlement,
    /// How an open turn no limit cut ends; `None` for a queued run, which started none.
    pub(crate) open_turn_end: Option<RestartTurnEnd>,
    /// The cause an open turn no limit cut ends with: `daemonRestart`, or `daemonStop` under the
    /// person's stop of the service.
    pub(crate) turn_cause: TurnEndCause,
}

/// Reads what [`decide_restart_settlement`] and [`decide_stop_settlement`] need of `run` on
/// `reader`: a queued run's waiting messages, any other run's pending interrupts, the limit it
/// still owes, its open turns' cuts and, while it waits for input, whether the refusal choice
/// waits, beside `is_stopping`, which the caller read before any run of the session settled, since
/// a lead's own settle discharges the stop its helper waits on. Fails when SQLite refuses a read
/// or a stored row does not read as its type, an interrupt's record or a refusal's request among
/// them.
pub(crate) fn read_restart_facts(
    reader: &Connection,
    run: &LiveRun,
    is_stopping: bool,
) -> Result<RestartFacts, RunEngineError> {
    if run.run.state == RunState::Queued {
        let has_queued_item = !QueueItemReader::new(reader)
            .list_waiting_for_run(&run.run_id)?
            .is_empty();
        return Ok(RestartFacts {
            pending_interrupts: Vec::new(),
            owed_limit: None,
            turn_cuts: Vec::new(),
            is_stopping: false,
            has_queued_item,
            is_refusal_waiting: false,
        });
    }
    let (pending_interrupts, owed_limit) = read_run_stops(reader, &run.run_id)?;
    let is_refusal_waiting = run.run.state == RunState::WaitingForInput
        && read_waiting_refusal(reader, run.run.session_id, run.run_id)?.is_some();
    Ok(RestartFacts {
        pending_interrupts,
        owed_limit,
        turn_cuts: read_turn_cuts(reader, &run.run_id)?,
        is_stopping,
        has_queued_item: false,
        is_refusal_waiting,
    })
}

/// The stops `run_id` still waits on, read on `reader`: its interrupts with no outcome yet, oldest
/// first, and the limit its log still owes. Fails when SQLite refuses a read or a pending row does
/// not read as its type, its record among them.
pub(crate) fn read_run_stops(
    reader: &Connection,
    run_id: &RunId,
) -> rusqlite::Result<(Vec<PendingInterrupt>, Option<RunLimit>)> {
    Ok((
        read_pending_interrupts(reader, run_id)?,
        read_owed_limit(reader, run_id)?,
    ))
}

/// The limit `run_id` still owes, read on `reader` from its log alone: a limit whose reached event
/// no end of the run by that limit followed, the token limit before the step limit. Whether an
/// interrupt was recorded, is pending or failed since does not decide it. Fails when SQLite refuses
/// the read.
pub(crate) fn read_owed_limit(
    reader: &Connection,
    run_id: &RunId,
) -> rusqlite::Result<Option<RunLimit>> {
    let reached_type = reader
        .prepare_cached(&SELECT_OWED_LIMIT_SQL)?
        .query_row(named_params! { "@run_id": run_id.text().as_str() }, |row| {
            row.get::<_, String>(0)
        })
        .optional()?;
    // The read selects only the two reached types.
    Ok(reached_type.map(|reached_type| {
        if reached_type == SessionEventType::AgentRunTokenLimitReached.as_str() {
            RunLimit::TokenLimit
        } else {
            RunLimit::StepLimit
        }
    }))
}

/// Every open turn of `run_id` a limit's interrupt row names as cut, read on `reader`, oldest
/// first, each with the highest-ranked limit whose row names it: the row is a cut's one mark, so a
/// turn end resolved from the log takes the live path's limit, except where the turn's end races
/// its stop's row. Fails when SQLite refuses the read or a stored turn number or limit is not one.
pub(crate) fn read_turn_cuts(
    reader: &Connection,
    run_id: &RunId,
) -> rusqlite::Result<Vec<TurnCut>> {
    let mut statement = reader.prepare_cached(&SELECT_TURN_CUTS_SQL)?;
    let mut rows = statement.query(named_params! { "@run_id": run_id.text().as_str() })?;
    let mut turn_cuts: Vec<TurnCut> = Vec::new();
    while let Some(row) = rows.next()? {
        let turn_number = safe_int_column(row, 0)?;
        let limit = text_column(row, 1, closed_word::<RunLimit>)?;
        match turn_cuts
            .iter_mut()
            .find(|cut| cut.turn_number == turn_number)
        {
            Some(cut) => cut.limit = outranking_limit(cut.limit, limit),
            None => turn_cuts.push(TurnCut { turn_number, limit }),
        }
    }
    turn_cuts.sort_by_key(|cut| cut.turn_number);
    Ok(turn_cuts)
}

/// Of two limits, in either order, the one a turn both cut takes and a run both stop settles at:
/// the token limit's end is final, and the spend limit stands over the session and refuses its
/// next send, where the step limit bounds one turn.
pub(crate) fn outranking_limit(one: RunLimit, other: RunLimit) -> RunLimit {
    if limit_rank(one) <= limit_rank(other) {
        one
    } else {
        other
    }
}

// A limit's rank, the highest first.
fn limit_rank(limit: RunLimit) -> u8 {
    match limit {
        RunLimit::TokenLimit => 0,
        RunLimit::SpendLimit => 1,
        RunLimit::StepLimit => 2,
    }
}

/// How a run's stops settle it, or `None` when it waits on none: an owed token limit stops it
/// whatever else is pending, its end being final; else a person's pending interrupt settles it as
/// theirs; else a pending limit interrupt by its limit, the spend limit's over the step limit's;
/// else an owed step limit interrupts it with that limit.
pub(crate) fn settlement_by_stops(
    pending_interrupts: &[PendingInterrupt],
    owed_limit: Option<RunLimit>,
) -> Option<RestartSettlement> {
    if owed_limit == Some(RunLimit::TokenLimit) {
        return Some(limit_settlement(RunLimit::TokenLimit));
    }
    if pending_interrupts
        .iter()
        .any(|pending| matches!(pending.record, InterruptInterventionRecord::Person(_)))
    {
        // The person's interrupt stays theirs: the run carries no trigger of the daemon's.
        return Some(RestartSettlement::Interrupted { trigger: None });
    }
    pending_interrupts
        .iter()
        .filter_map(|pending| pending.record.limit())
        .reduce(outranking_limit)
        .or(owed_limit)
        .map(limit_settlement)
}

/// Whether a stop of `run_id`'s own settles it at a restart, as [`settlement_by_stops`] reads its
/// stops on `reader`; a lead's stop never counts for its helper. Fails when SQLite refuses a read
/// or a stored row does not read as its type, a pending interrupt's record among them.
pub fn read_has_own_stop(reader: &Connection, run_id: &RunId) -> rusqlite::Result<bool> {
    let (pending_interrupts, owed_limit) = read_run_stops(reader, run_id)?;
    Ok(settlement_by_stops(&pending_interrupts, owed_limit).is_some())
}

/// Whether `run_id` is stopping at a restart, read on `reader`: its own stops settle it, as
/// [`read_has_own_stop`] reads them, or it is a provider's helper, at any depth, beneath a run
/// whose stops do, since that stop ends the process the helper runs in. Fails when SQLite refuses a
/// read or a stored row does not read as its type, a pending interrupt's record among them.
pub fn read_is_run_stopping(reader: &Connection, run_id: &RunId) -> rusqlite::Result<bool> {
    let mut run_id = *run_id;
    loop {
        if read_has_own_stop(reader, &run_id)? {
            return Ok(true);
        }
        match read_helper_lead(reader, &run_id)? {
            Some(lead) => run_id = lead,
            None => return Ok(false),
        }
    }
}

/// Decides how `run` settles, or `None` for a run left as it is. A queued run is left while a
/// message waits to start it and fails otherwise, since nothing else will. Any other run settles
/// by its stops; with none, a provider's helper beneath a run whose stop wins reads interrupted
/// with `daemonRestart`, cut by the restart, since that stop never reaches it; a child held in a
/// pause the restart orphaned reads interrupted and continues from its own box, a paused lead
/// stays paused, a pausing lead becomes paused, and any other run fails. Whatever settles the run,
/// each open turn a limit's interrupt row names keeps that limit's cause.
pub(crate) fn decide_restart_settlement(
    run: &LiveRun,
    facts: &RestartFacts,
) -> Option<RestartDecision> {
    if run.run.state == RunState::Queued {
        return (!facts.has_queued_item).then_some(RestartDecision {
            settlement: RestartSettlement::Failed,
            open_turn_end: None,
            turn_cause: TurnEndCause::DaemonRestart,
        });
    }
    // The person's pending interrupt, if any, is applied by the token limit's end in its write.
    let settlement = match settlement_by_stops(&facts.pending_interrupts, facts.owed_limit) {
        Some(settlement) => settlement,
        // Stopping with no stop of its own: a helper whose lead's stop wins.
        None if facts.is_stopping => RestartSettlement::Interrupted {
            trigger: Some(InterruptReason::DaemonRestart),
        },
        None => match (run.run.state, run.parent_run_id.is_some()) {
            (RunState::Paused | RunState::Pausing, true) => RestartSettlement::Interrupted {
                trigger: Some(InterruptReason::DaemonRestart),
            },
            // A paused run is no work in progress: the person's pause holds.
            (RunState::Paused, false) => return None,
            (RunState::Pausing, false) => RestartSettlement::Paused,
            _ => RestartSettlement::Failed,
        },
    };
    Some(RestartDecision {
        settlement,
        open_turn_end: Some(open_turn_end_of(settlement)),
        turn_cause: TurnEndCause::DaemonRestart,
    })
}

/// Decides how the person's stop of the service settles `run`, each open turn no limit cut ending
/// with `daemonStop`, or `None` for a paused lead with no stop of its own, which stays paused.
pub(crate) fn decide_stop_settlement(
    run: &LiveRun,
    facts: &RestartFacts,
) -> Option<RestartDecision> {
    // A queued run is stopped and never starts, whether or not a message waits for it.
    if run.run.state == RunState::Queued {
        return Some(RestartDecision {
            settlement: RestartSettlement::Stopped {
                trigger: StopTrigger::DaemonStop,
            },
            open_turn_end: None,
            turn_cause: TurnEndCause::DaemonStop,
        });
    }
    // Any other run settles by its stops; with none, a run waiting on the refusal choice fails with
    // that refusal, and any other, a pausing lead, a paused child and a helper beneath a stopping
    // lead among them, reads interrupted with `daemonStop`.
    let settlement = match settlement_by_stops(&facts.pending_interrupts, facts.owed_limit) {
        Some(settlement) => settlement,
        None if run.run.state == RunState::Paused && run.parent_run_id.is_none() => return None,
        None if facts.is_refusal_waiting => RestartSettlement::Refused,
        None => RestartSettlement::Interrupted {
            trigger: Some(InterruptReason::DaemonStop),
        },
    };
    Some(RestartDecision {
        settlement,
        open_turn_end: Some(open_turn_end_of(settlement)),
        turn_cause: TurnEndCause::DaemonStop,
    })
}

// How an open turn no limit cut ends under `settlement`: failed with a run the settle fails on its
// own, else interrupted.
fn open_turn_end_of(settlement: RestartSettlement) -> RestartTurnEnd {
    match settlement {
        RestartSettlement::Interrupted { .. }
        | RestartSettlement::Stopped { .. }
        | RestartSettlement::Paused
        | RestartSettlement::Refused => RestartTurnEnd::Interrupted,
        RestartSettlement::Failed => RestartTurnEnd::Failed,
    }
}

/// How a resume that succeeded moves a run a restart left live.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResumedRunMove {
    /// Left as it is: queued, resting, waiting on its provider's own end of the turn or of its
    /// ask, or held on the person, whose answer continues it.
    Left,
    /// Left as it is with its provider running its turn again, so the limits it owes and its
    /// pending interrupts, a person's or a limit's, go again.
    Running,
    /// `pausing → paused`; its open turns end interrupted with `daemonRestart` where the turn is
    /// gone, and are otherwise left to the provider's own end.
    Paused {
        /// Whether the provider holds no turn of the run.
        is_turn_gone: bool,
    },
    /// Its turn is gone, or a stop it waits on wins over the resume: settled by its stops, else
    /// interrupted with `daemonRestart`.
    TurnGone,
}

/// What a resume's finalize did to a run: the move it decided, and whether that move's write landed
/// with the caller's companions in it, which `Left` and `Running` never write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResumedRunFinalized {
    /// The move the finalize decided.
    pub resumed_move: ResumedRunMove,
    /// Whether the move's write landed; a run that moved since is left as it now is, unwritten.
    pub is_written: bool,
}

/// Decides how a resume that succeeded moves a run that read `state_before` before the restart, a
/// child where `is_child` and one a pending stop waits on where `is_stopping`, from what its
/// provider holds of its turn. A queued run is left whatever the answer. A stop wins over the
/// resume before any pause: a stopping run whose turn still runs, `paused` aside, goes on with the
/// limits it owes and its pending interrupts handed again, and any other stopping run
/// settles by its stops. A run held on the person is left as it is, its card or question kept. A
/// turn still running leaves the run as it is, the provider going on; a turn its provider ended
/// leaves the run to that end, except that `pausing` reaches its boundary. A gone turn interrupts
/// the run, except that a lead's pause holds: `paused` stays and `pausing` becomes `paused`; a
/// child's gone turn interrupts it in any state.
pub(crate) fn decide_resumed_move(
    state_before: RunState,
    is_child: bool,
    is_stopping: bool,
    answer: ProviderTurnAnswer,
) -> ResumedRunMove {
    match (state_before, answer) {
        (
            RunState::Queued
            | RunState::Completed
            | RunState::Interrupted
            | RunState::Stopped
            | RunState::Failed,
            _,
        ) => ResumedRunMove::Left,
        // A paused run's stop is never handed to a turn still running there: the stop ends it.
        (
            RunState::Starting
            | RunState::Running
            | RunState::WaitingForApproval
            | RunState::WaitingForInput
            | RunState::Pausing,
            ProviderTurnAnswer::StillRunning,
        ) if is_stopping => ResumedRunMove::Running,
        _ if is_stopping => ResumedRunMove::TurnGone,
        (_, ProviderTurnAnswer::Gone) if is_child => ResumedRunMove::TurnGone,
        (RunState::Starting | RunState::Running, ProviderTurnAnswer::StillRunning) => {
            ResumedRunMove::Running
        }
        (RunState::Pausing, ProviderTurnAnswer::EndedByProvider) => ResumedRunMove::Paused {
            is_turn_gone: false,
        },
        (RunState::Pausing, ProviderTurnAnswer::Gone) => {
            ResumedRunMove::Paused { is_turn_gone: true }
        }
        (
            RunState::Starting
            | RunState::Running
            | RunState::WaitingForApproval
            | RunState::WaitingForInput,
            ProviderTurnAnswer::Gone,
        ) => ResumedRunMove::TurnGone,
        (
            RunState::Starting
            | RunState::Running
            | RunState::WaitingForApproval
            | RunState::WaitingForInput
            | RunState::Pausing
            | RunState::Paused,
            ProviderTurnAnswer::StillRunning | ProviderTurnAnswer::EndedByProvider,
        )
        | (RunState::Paused, ProviderTurnAnswer::Gone)
        // A run held on the person keeps its card or question; a pausing or paused lead answers
        // `Waiting` only when its state moved after the driver read it, and is left as it now is.
        | (_, ProviderTurnAnswer::Waiting) => ResumedRunMove::Left,
    }
}

/// Decides how a run whose turn a resume found gone settles, or `None` for a queued run, which is
/// left: by its stops as a restart settles it, else interrupted with `daemonRestart`, its
/// conversation kept for the next send; every open turn ends interrupted.
pub(crate) fn decide_turn_gone_settlement(
    run: &LiveRun,
    facts: &RestartFacts,
) -> Option<RestartDecision> {
    (run.run.state != RunState::Queued).then(|| RestartDecision {
        settlement: settlement_by_stops(&facts.pending_interrupts, facts.owed_limit).unwrap_or(
            RestartSettlement::Interrupted {
                trigger: Some(InterruptReason::DaemonRestart),
            },
        ),
        open_turn_end: Some(RestartTurnEnd::Interrupted),
        turn_cause: TurnEndCause::DaemonRestart,
    })
}

// The end `limit` gives its run.
fn limit_settlement(limit: RunLimit) -> RestartSettlement {
    match limit {
        RunLimit::StepLimit => RestartSettlement::Interrupted {
            trigger: Some(InterruptReason::StepLimit),
        },
        RunLimit::SpendLimit => RestartSettlement::Interrupted {
            trigger: Some(InterruptReason::SpendLimit),
        },
        RunLimit::TokenLimit => RestartSettlement::Stopped {
            trigger: StopTrigger::TokenLimit,
        },
    }
}

/// The turn end cause a limit cuts a turn with.
pub(crate) fn limit_turn_cause(limit: RunLimit) -> TurnEndCause {
    match limit {
        RunLimit::StepLimit => TurnEndCause::StepLimit,
        RunLimit::SpendLimit => TurnEndCause::SpendLimit,
        RunLimit::TokenLimit => TurnEndCause::TokenLimit,
    }
}

/// The interrupts of `run_id` that have no outcome yet, read on `reader`, oldest first. Fails when
/// SQLite refuses the read or a stored column does not read as its type; a stored record that is
/// neither a person's interrupt nor the daemon's at a limit fails it too. An undo's row is left
/// out, since it is no stop.
pub(crate) fn read_pending_interrupts(
    reader: &Connection,
    run_id: &RunId,
) -> rusqlite::Result<Vec<PendingInterrupt>> {
    reader
        .prepare_cached(&SELECT_PENDING_INTERRUPTS_SQL)?
        .query_map(named_params! { "@run_id": run_id.text().as_str() }, |row| {
            Ok(PendingInterrupt {
                intervention_id: text_column(row, 0, |text| InterventionId::new(&text))?,
                state: text_column(row, 1, unresolved_state_of)?,
                actor: stored_actor(optional_text_column(
                    row,
                    2,
                    closed_word::<InterventionDeviceActor>,
                )?),
                record: text_column(row, 3, |text| {
                    serde_json::from_str::<InterruptInterventionRecord>(&text)
                })?,
                expected_run_version: safe_int_column(row, 4)?,
                client_idempotency_key: text_column(row, 5, ClientUuid::new)?,
            })
        })?
        .collect()
}

/// The statement that refuses a settle once an interrupt it did not read is pending, written after
/// the settle moves the ones it read, so the settle never contradicts the person's last word.
pub(crate) fn no_pending_interrupt_statement(run_id: &RunId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(SELECT_PENDING_INTERRUPTS_SQL.as_str()),
        bindings: StatementBindings::Named(vec![text_binding("@run_id", run_id.text().as_str())]),
        expected_row_count: Some(0),
    }
}

/// The statement that refuses a settle once a queued message it did not read targets the run: a
/// restart's `failed` end of a queued run its queue still starts, or a stop's end of any run whose
/// waiting messages it ends in the same write.
pub(crate) fn no_waiting_item_statement(run_id: &RunId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(SELECT_WAITING_FOR_RUN_SQL.as_str()),
        bindings: StatementBindings::Positional(vec![Value::Text(
            run_id.text().as_str().to_owned(),
        )]),
        expected_row_count: Some(0),
    }
}

/// Every pending interrupt of `run_id` in `session_id` moved to `applied`, each with its event,
/// for the write that ends the run. Fails when an event breaks a check of its type.
pub(crate) fn applied_pending_interrupts_of(
    run_id: RunId,
    session_id: SessionId,
    pending_interrupts: &[PendingInterrupt],
) -> Result<RunWriteCompanions, SessionEventDraftError> {
    let mut companions = RunWriteCompanions::default();
    for pending_interrupt in pending_interrupts {
        companions
            .settled_interventions
            .push(pending_interrupt.intervention_id);
        companions.statements.push(move_intervention_statement(
            &pending_interrupt.intervention_id,
            &InterventionTransition::Apply {
                from: pending_interrupt.state,
            },
        ));
        let applied = AgentInterventionAppliedPayload {
            session_id,
            intervention_id: pending_interrupt.intervention_id,
            target_run_id: run_id,
            intervention_type: InterventionType::Interrupt,
            state: AgentInterventionAppliedState::Value,
            actor: pending_interrupt.actor.clone(),
        };
        companions
            .preceding_events
            .push(SessionEventDraft::of_session(
                session_id,
                &SessionEvent::AgentInterventionApplied(applied),
            )?);
    }
    Ok(companions)
}

#[cfg(test)]
mod tests;
