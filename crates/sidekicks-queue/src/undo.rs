//! What an undo stops before its cut: every command, command wrapper and agent started after the
//! undo's point, named by one reader, stopped at once and waited on until each has ended, so
//! nothing is left writing into the files the undo puts back.

use std::collections::HashSet;
use std::io;
use std::panic::resume_unwind;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use sidekicks_contracts::agent::tree::AgentTreeMember;
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::children::ChildStopOutcome;
use sidekicks_contracts::run::events::{DaemonInterventionActor, InterventionActor};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::SessionRestoreStops;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::command::channel::PartyId;
use sidekicks_provider::command::channel::stop::StoppedCommandParties;
use sidekicks_provider::command::running_set::RunningCommandSets;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::port::running_command_publisher::CommandStopCause;
use sidekicks_session::agent_tree::read::AgentTreeReadError;
use sidekicks_session::agent_tree::sweep::{
    AgentTreeSweep, AgentTreeSweepError, Descendant, DescendantStop, SweepRoot, read_descendants,
};
use sidekicks_session::driver_resolution::read_session_driver;
use sidekicks_session::run::read::RunStateReader;
use sidekicks_session::transcript::turn_attribution::{RunTurnReads, TurnAttributionError};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::read::{
    DamagedFromSequenceReader, SessionEventFilter, SessionEventReads, SessionLogReadError,
    session_read_bound,
};
use tokio::task::JoinSet;
use tokio::time::{Instant, sleep_until};

/// How long an undo waits, from the call that stops what started after its point, for every
/// command's ending, every stopped process's end and every agent's terminal state.
pub const UNDO_STOP_END_BOUND: Duration = Duration::from_secs(10);

// The payload member of `agent.command.ended` that names the command.
const COMMAND_ID_PAYLOAD_KEY: &str = "commandId";

/// What started after an undo's point: the running commands, the wrappers whose command the
/// provider has not named yet, and the agents.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UndoStopSet {
    /// The running commands, in start order.
    pub commands: Vec<CommandId>,
    /// The wrappers admitted after the point's message whose command the provider has not named.
    pub unpaired_wrappers: Vec<PartyId>,
    /// The agents, in dispatch order.
    pub agents: Vec<Descendant>,
}

impl UndoStopSet {
    /// What the person is asked to agree to stop: the commands, a wrapper whose command the
    /// provider has not named counted as a command by its process id, and the agents; the lead's
    /// own turn is the caller's to add.
    pub fn named_stops(&self) -> SessionRestoreStops {
        SessionRestoreStops {
            command_ids: self.commands.clone(),
            unnamed_command_wrappers: self.unpaired_wrappers.clone(),
            agents: self
                .agents
                .iter()
                .map(|agent| agent.member.clone())
                .collect(),
            lead_run_id: None,
        }
    }

    /// Whether the set names a command, an unnamed command's wrapper or an agent `consented` does
    /// not, compared by id.
    pub fn has_grown_past(&self, consented: &SessionRestoreStops) -> bool {
        self.commands
            .iter()
            .any(|command_id| !consented.command_ids.contains(command_id))
            || self
                .unpaired_wrappers
                .iter()
                .any(|party| !consented.unnamed_command_wrappers.contains(party))
            || self
                .agents
                .iter()
                .any(|agent| !consented.agents.contains(&agent.member))
    }
}

/// A wrapper an undo waits on: a running command's, or one whose command the provider has not
/// named.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum UndoStopWrapper {
    /// The wrapper of this running command.
    Command(CommandId),
    /// This wrapper, whose command the provider has not named.
    Unpaired(PartyId),
}

/// Why an undo's stops did not leave everything after its point ended.
#[derive(Debug, thiserror::Error)]
pub enum UndoStopError {
    /// The read pool did not run a read.
    #[error("an undo's read did not run")]
    Pool(#[from] DatabaseReadError),
    /// SQLite refused a read.
    #[error("an undo's read failed")]
    Database(#[from] rusqlite::Error),
    /// The session's log could not be read.
    #[error(transparent)]
    Log(#[from] SessionLogReadError),
    /// Where a command's tool call opened could not be read.
    #[error(transparent)]
    ToolCalls(#[from] TurnAttributionError),
    /// The session's agents could not be read.
    #[error(transparent)]
    Agents(#[from] AgentTreeReadError),
    /// The sweep could not read the agents it stops.
    #[error(transparent)]
    Sweep(#[from] AgentTreeSweepError),
    /// The session or its provider was refused.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// More started after the point than the person agreed to stop; nothing was stopped.
    #[error("more started after the undo's point than the person agreed to stop")]
    Grew {
        /// What the undo would stop now.
        stops: SessionRestoreStops,
    },
    /// The point's sequence holds no event the session's log reads.
    #[error("the undo's point, sequence {sequence}, is not in the session's log")]
    PointNotFound {
        /// The point's sequence.
        sequence: i64,
    },
    /// Every stop answered and some did not stop: each refused command, each wrapper whose stop
    /// or whose parties' end could not be followed, and each agent whose stop failed.
    #[error("an undo's stops did not all stop")]
    NotStopped {
        /// The commands whose stop was refused, each with its refusal.
        commands: Vec<(CommandId, HandlerError)>,
        /// The wrappers whose stop or end failed, each with its failure.
        wrappers: Vec<(UndoStopWrapper, io::Error)>,
        /// The agents whose stop failed.
        agents: Vec<AgentTreeMember>,
    },
    /// The bound passed with something still running: each command with no ending in the log,
    /// each wrapper whose stop or whose parties had not ended, and each agent not yet ended.
    #[error("what an undo stopped still ran past its bound")]
    StillRunning {
        /// The commands with no ending.
        commands: Vec<CommandId>,
        /// The wrappers not ended.
        wrappers: Vec<UndoStopWrapper>,
        /// The agents not ended.
        agents: Vec<AgentTreeMember>,
    },
}

/// What [`UndoStops`] reads and stops through.
pub struct UndoStopsDeps {
    /// The read pool the log, the running commands' calls and the agents are read on.
    pub pool: Arc<DatabaseReadPool>,
    /// The session's log, whose change count wakes the wait for the ends.
    pub event_log: Arc<EventLogService>,
    /// The drivers a session's commands are stopped through.
    pub providers: Arc<ProviderRegistry>,
    /// Where each session's log is damaged from, so its reads stop before it.
    pub read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    /// The sessions' running commands and their wrappers.
    pub running_commands: Arc<RunningCommandSets>,
    /// The sweep that stops the agents.
    pub sweep: AgentTreeSweep,
}

/// The undo's step that reads and stops every command, wrapper and agent started after its point.
pub struct UndoStops {
    pool: Arc<DatabaseReadPool>,
    event_log: Arc<EventLogService>,
    providers: Arc<ProviderRegistry>,
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    running_commands: Arc<RunningCommandSets>,
    sweep: Arc<AgentTreeSweep>,
}

// One stop's answer, with what it stopped.
enum StopAnswer {
    Command(CommandId, Result<StoppedCommandParties, HandlerError>),
    Unpaired(PartyId, io::Result<StoppedCommandParties>),
}

// What the stops answered so far and what the wait still waits on.
struct StopProgress {
    // The wrappers whose stop has not answered or whose parties have not ended.
    wrappers: Vec<UndoStopWrapper>,
    // Whether the sweep has answered.
    is_swept: bool,
    // Each agent the sweep stopped, with the run whose terminal state ends it.
    stopped_agents: Vec<(AgentTreeMember, RunId)>,
    refused_commands: Vec<(CommandId, HandlerError)>,
    failed_wrappers: Vec<(UndoStopWrapper, io::Error)>,
    failed_agents: Vec<AgentTreeMember>,
}

// What the log holds of the ends: the commands with an ending past the head, and the runs read
// still running.
struct LoggedEnds {
    ended_commands: HashSet<String>,
    running_runs: Vec<RunId>,
}

impl UndoStops {
    /// The step over `deps`.
    pub fn new(deps: UndoStopsDeps) -> Self {
        Self {
            pool: deps.pool,
            event_log: deps.event_log,
            providers: deps.providers,
            read_damaged_from_sequence: deps.read_damaged_from_sequence,
            running_commands: deps.running_commands,
            sweep: Arc::new(deps.sweep),
        }
    }

    /// Every command, unpaired wrapper and agent of `session_id` started after the event at
    /// `after_sequence`, read up to the session's head now: a command whose call's newest opening
    /// sits past the point, or, with no call or no opening in the log, that started after the
    /// point's message; a wrapper admitted after that message; an agent queued after the point.
    /// Fails as a read fails, and with [`UndoStopError::PointNotFound`] for a point the log lacks.
    pub async fn read_started_after(
        &self,
        session_id: SessionId,
        after_sequence: i64,
    ) -> Result<UndoStopSet, UndoStopError> {
        let head = self.read_head(session_id).await?;
        self.read_set(
            session_id,
            after_sequence,
            self.read_bound(session_id, head),
        )
        .await
    }

    /// Stops everything [`UndoStops::read_started_after`] names, all at once: each command by the
    /// provider's verb and its wrapper's `Stop` with no run told, each unpaired wrapper by its
    /// `Stop`, each agent by the sweep. Answers the set once every command's ending is in the log,
    /// every stopped party's process has ended and every stopped agent reads a terminal state.
    /// With `consented`, stops nothing and fails [`UndoStopError::Grew`] when the set names a
    /// command, an unnamed command's wrapper or an agent the person did not agree to stop. Fails
    /// [`UndoStopError::NotStopped`] once every stop answered and one did not stop, and
    /// [`UndoStopError::StillRunning`] when [`UNDO_STOP_END_BOUND`] passes first; a stop under way
    /// at the bound carries on unwatched.
    pub async fn stop_started_after(
        &self,
        session_id: SessionId,
        after_sequence: i64,
        consented: Option<&SessionRestoreStops>,
    ) -> Result<UndoStopSet, UndoStopError> {
        let deadline = Instant::now() + UNDO_STOP_END_BOUND;
        // Counted before the head is read, so no ending appended after it goes unseen.
        let mut changes = self.event_log.change_count(&session_id);
        let head = self.read_head(session_id).await?;
        let read_bound = self.read_bound(session_id, head);
        let set = self
            .read_set(session_id, after_sequence, read_bound)
            .await?;
        if consented.is_some_and(|consented| set.has_grown_past(consented)) {
            return Err(UndoStopError::Grew {
                stops: set.named_stops(),
            });
        }
        let mut stops = JoinSet::new();
        // The driver is read only for commands to stop, so a set without one needs no provider.
        if !set.commands.is_empty() {
            let (_, _, driver) = read_session_driver::<UndoStopError>(
                &self.pool,
                &self.providers,
                self.read_damaged_from_sequence.as_ref(),
                session_id,
            )
            .await?;
            for command_id in &set.commands {
                let running = Arc::clone(&self.running_commands);
                let driver = Arc::clone(&driver);
                let command_id = command_id.clone();
                stops.spawn(async move {
                    let stopped = running
                        .stop(
                            driver.as_ref(),
                            session_id,
                            &command_id,
                            CommandStopCause::Undo,
                        )
                        .await;
                    StopAnswer::Command(command_id, stopped)
                });
            }
        }
        for &party in &set.unpaired_wrappers {
            let running = Arc::clone(&self.running_commands);
            stops.spawn(async move {
                StopAnswer::Unpaired(party, running.stop_wrapper(session_id, party).await)
            });
        }
        let sweep = Arc::clone(&self.sweep);
        let mut swept = tokio::spawn(async move {
            sweep
                .stop_descendants(
                    session_id,
                    SweepRoot::Session,
                    Some(after_sequence),
                    read_bound,
                    InterventionActor::Daemon(DaemonInterventionActor::Value),
                )
                .await
        });
        let mut progress = StopProgress {
            wrappers: set
                .commands
                .iter()
                .cloned()
                .map(UndoStopWrapper::Command)
                .chain(
                    set.unpaired_wrappers
                        .iter()
                        .map(|&party| UndoStopWrapper::Unpaired(party)),
                )
                .collect(),
            is_swept: false,
            stopped_agents: Vec::new(),
            refused_commands: Vec::new(),
            failed_wrappers: Vec::new(),
            failed_agents: Vec::new(),
        };
        let mut party_ends = JoinSet::new();

        let waited = loop {
            if stops.is_empty() && progress.is_swept {
                if let Some(not_stopped) = progress.take_not_stopped() {
                    break Err(not_stopped);
                }
                if progress.wrappers.is_empty() {
                    let runs = progress.stopped_agent_runs();
                    match self.read_logged_ends(session_id, head, runs).await {
                        Ok(ends) if ends.has_ended(&set.commands) => break Ok(()),
                        Ok(_) => {}
                        Err(error) => break Err(error),
                    }
                }
            }
            tokio::select! {
                () = sleep_until(deadline) => {
                    break Err(self.still_running(session_id, head, &set, &progress).await);
                }
                Some(joined) = stops.join_next() => {
                    progress.take_stop(joined.unwrap_or_else(|panic| {
                        resume_unwind(panic.into_panic())
                    }), &mut party_ends);
                }
                joined = &mut swept, if !progress.is_swept => {
                    let outcomes = joined.unwrap_or_else(|panic| resume_unwind(panic.into_panic()));
                    match outcomes {
                        Ok(outcomes) => progress.take_sweep(&set.agents, outcomes),
                        Err(error) => break Err(error.into()),
                    }
                }
                Some(joined) = party_ends.join_next() => {
                    let (wrapper, ended) =
                        joined.unwrap_or_else(|panic| resume_unwind(panic.into_panic()));
                    progress.take_party_end(wrapper, ended);
                }
                Ok(()) = changes.changed() => {}
            }
        };
        // Neither the bound nor a failure cancels a stop or a wait halfway; the sweep's task
        // carries on past its dropped handle.
        stops.detach_all();
        party_ends.detach_all();
        waited.map(|()| set)
    }

    // The session's head now.
    async fn read_head(&self, session_id: SessionId) -> Result<Option<i64>, UndoStopError> {
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        self.pool
            .read(
                ReadLength::Short,
                move |reader| -> Result<_, UndoStopError> {
                    Ok(SessionEventReads::new(reader, &*read_damaged_from_sequence)
                        .read_head(&session_id)?)
                },
            )
            .await
    }

    // The sequence every read of the set stops before: just past `head`.
    fn read_bound(&self, session_id: SessionId, head: Option<i64>) -> i64 {
        session_read_bound(
            self.read_damaged_from_sequence.as_ref(),
            &session_id,
            Some(head.map_or(0, |head| head + 1)),
        )
    }

    // The set started after `after_sequence`, read before `read_bound`.
    async fn read_set(
        &self,
        session_id: SessionId,
        after_sequence: i64,
        read_bound: i64,
    ) -> Result<UndoStopSet, UndoStopError> {
        let starts = self.running_commands.running_starts(session_id);
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        let (point_at, commands, agents) = self
            .pool
            .read(
                ReadLength::Long,
                move |reader| -> Result<_, UndoStopError> {
                    let point_at = SessionEventReads::new(reader, &*read_damaged_from_sequence)
                        .read_at_sequences(&session_id, &[after_sequence])?
                        .first()
                        .and_then(|point| point.occurred_at.timestamp())
                        .ok_or(UndoStopError::PointNotFound {
                            sequence: after_sequence,
                        })?;
                    let calls = RunTurnReads::new(reader, &*read_damaged_from_sequence);
                    let mut commands = Vec::new();
                    for start in starts {
                        let opening = match &start.tool_call_id {
                            Some(tool_call_id) => calls.read_tool_call_opening_sequence(
                                &session_id,
                                &start.run_id,
                                tool_call_id.as_str(),
                                read_bound,
                            )?,
                            None => None,
                        };
                        let is_after = match opening {
                            Some(opening_sequence) => opening_sequence > after_sequence,
                            // An instant that does not read as one is stopped, never left running.
                            None => start
                                .started_at
                                .timestamp()
                                .is_none_or(|started_at| started_at > point_at),
                        };
                        if is_after {
                            commands.push(start.command_id);
                        }
                    }
                    let agents = read_descendants(
                        reader,
                        &session_id,
                        &SweepRoot::Session,
                        Some(after_sequence),
                        read_bound,
                    )?;
                    Ok((point_at, commands, agents))
                },
            )
            .await?;
        Ok(UndoStopSet {
            commands,
            unpaired_wrappers: self
                .running_commands
                .unpaired_wrappers_after(session_id, point_at),
            agents,
        })
    }

    // The commands with an ending past `head`, and which of `runs` still run.
    async fn read_logged_ends(
        &self,
        session_id: SessionId,
        head: Option<i64>,
        runs: Vec<RunId>,
    ) -> Result<LoggedEnds, UndoStopError> {
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        self.pool
            .read(
                ReadLength::Short,
                move |reader| -> Result<_, UndoStopError> {
                    let ended_type = [SessionEventType::AgentCommandEnded.as_str()];
                    let ended_commands =
                        SessionEventReads::new(reader, &*read_damaged_from_sequence)
                            .read_after(
                                &session_id,
                                head.unwrap_or(-1),
                                -1,
                                SessionEventFilter {
                                    event_types: Some(&ended_type),
                                    before_sequence: None,
                                    is_sparse: false,
                                },
                            )?
                            .iter()
                            .filter_map(|ending| {
                                ending
                                    .payload
                                    .get(COMMAND_ID_PAYLOAD_KEY)
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                            })
                            .collect();
                    let states = RunStateReader::new(reader);
                    let mut running_runs = Vec::new();
                    for run_id in runs {
                        if states
                            .read_run(&run_id)?
                            .is_some_and(|run| !run.state.is_terminal())
                        {
                            running_runs.push(run_id);
                        }
                    }
                    Ok(LoggedEnds {
                        ended_commands,
                        running_runs,
                    })
                },
            )
            .await
    }

    // What still runs at the bound: each command with no ending, each wrapper not ended, and each
    // agent not ended, every agent of the set while the sweep has not answered.
    async fn still_running(
        &self,
        session_id: SessionId,
        head: Option<i64>,
        set: &UndoStopSet,
        progress: &StopProgress,
    ) -> UndoStopError {
        let agents: Vec<(AgentTreeMember, RunId)> = if progress.is_swept {
            progress.stopped_agents.clone()
        } else {
            set.agents
                .iter()
                .map(|agent| (agent.member.clone(), descendant_run(agent)))
                .collect()
        };
        let runs = agents.iter().map(|(_, run_id)| *run_id).collect();
        let ends = match self.read_logged_ends(session_id, head, runs).await {
            Ok(ends) => ends,
            Err(error) => return error,
        };
        UndoStopError::StillRunning {
            commands: set
                .commands
                .iter()
                .filter(|command_id| !ends.ended_commands.contains(command_id.as_str()))
                .cloned()
                .collect(),
            wrappers: progress.wrappers.clone(),
            agents: agents
                .into_iter()
                .filter(|(_, run_id)| ends.running_runs.contains(run_id))
                .map(|(member, _)| member)
                .collect(),
        }
    }
}

impl StopProgress {
    // Takes one stop's answer: a stop that reached its parties starts the wait on their ends.
    fn take_stop(
        &mut self,
        answer: StopAnswer,
        party_ends: &mut JoinSet<(UndoStopWrapper, io::Result<()>)>,
    ) {
        let (wrapper, stopped) = match answer {
            StopAnswer::Command(command_id, stopped) => {
                let wrapper = UndoStopWrapper::Command(command_id.clone());
                match stopped {
                    Ok(parties) => (wrapper, Ok(parties)),
                    Err(refusal) => {
                        self.wrappers.retain(|waited| *waited != wrapper);
                        self.refused_commands.push((command_id, refusal));
                        return;
                    }
                }
            }
            StopAnswer::Unpaired(party, stopped) => (UndoStopWrapper::Unpaired(party), stopped),
        };
        match stopped {
            Ok(parties) => {
                party_ends.spawn(async move { (wrapper, parties.wait_for_end().await) });
            }
            Err(failure) => self.take_party_end(wrapper, Err(failure)),
        }
    }

    // Takes the end of `wrapper`'s parties, or the failure to follow it.
    fn take_party_end(&mut self, wrapper: UndoStopWrapper, ended: io::Result<()>) {
        self.wrappers.retain(|waited| *waited != wrapper);
        if let Err(failure) = ended {
            self.failed_wrappers.push((wrapper, failure));
        }
    }

    // Takes the sweep's outcomes: a stopped agent is waited on through its run in `agents`.
    fn take_sweep(&mut self, agents: &[Descendant], outcomes: Vec<ChildStopOutcome>) {
        self.is_swept = true;
        for outcome in outcomes {
            match outcome {
                ChildStopOutcome::Stopped { child, .. } => {
                    if let Some(agent) = agents.iter().find(|agent| agent.member == child) {
                        self.stopped_agents.push((child, descendant_run(agent)));
                    }
                }
                ChildStopOutcome::AlreadyEnded { .. } => {}
                ChildStopOutcome::Failed { child, .. } => self.failed_agents.push(child),
            }
        }
    }

    // The runs of the agents the sweep stopped.
    fn stopped_agent_runs(&self) -> Vec<RunId> {
        self.stopped_agents
            .iter()
            .map(|(_, run_id)| *run_id)
            .collect()
    }

    // The failure naming every stop that did not stop, once there is one.
    fn take_not_stopped(&mut self) -> Option<UndoStopError> {
        let is_stopped = self.refused_commands.is_empty()
            && self.failed_wrappers.is_empty()
            && self.failed_agents.is_empty();
        (!is_stopped).then(|| UndoStopError::NotStopped {
            commands: std::mem::take(&mut self.refused_commands),
            wrappers: std::mem::take(&mut self.failed_wrappers),
            agents: std::mem::take(&mut self.failed_agents),
        })
    }
}

impl LoggedEnds {
    // Whether every one of `commands` has its ending and no run still runs.
    fn has_ended(&self, commands: &[CommandId]) -> bool {
        self.running_runs.is_empty()
            && commands
                .iter()
                .all(|command_id| self.ended_commands.contains(command_id.as_str()))
    }
}

// The run whose terminal state ends `agent`: a bridged or workflow run's own, a helper's newest.
fn descendant_run(agent: &Descendant) -> RunId {
    match agent.stop {
        DescendantStop::Run { run_id } | DescendantStop::Helper { run_id, .. } => run_id,
    }
}

#[cfg(test)]
mod tests;
