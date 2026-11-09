//! The turn's write: each turn drafted with its run's status move, appended alone or beside other
//! runs' turns across their sessions in one all-or-nothing write, and answered once it commits.

use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::run::status::WorkflowRunStatus;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventEmitError, SessionEventLinkage,
};

use super::{
    RunLiveStep, RunTurnCommit, RunTurnCommitFailure, RunTurnCommitted, SessionEventId, StepMove,
};
use crate::definitions::kept_values::KeptArtifactReads;
use crate::engine::event_record::{EngineDecision, RunEngineRecord};
use crate::engine::tick::run_status::{RunPersonWait, RunStepCounts};

#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
impl RunTurnCommit {
    /// Commits the turn through `appender` in one write: its events, then the run event its
    /// status move or its ending implies as the last, and every statement ahead of the rows, the
    /// run's own after the steps'. `live_steps` are the run's steps the tick keeps live after the
    /// turn, which a resumption point names beside the steps this turn readied. Once it commits,
    /// each report that moved its step, each gate answer and the run's status go to `record`, and
    /// it answers the artifacts its write's own reads found the replaced kept values naming. A
    /// turn with nothing writes nothing. Fails with [`RunTurnCommitFailure`], nothing of the turn
    /// stored.
    pub(crate) async fn append<'tick>(
        self,
        appender: &SessionEventAppender,
        record: &RunEngineRecord,
        live_steps: impl IntoIterator<Item = RunLiveStep<'tick>>,
    ) -> Result<RunTurnCommitted, RunTurnCommitFailure> {
        let DraftedTurn {
            session_id: _,
            mut drafts,
            statements,
            artifact_ids,
            kept_reads,
            answer,
        } = self.drafted(live_steps)?;
        let event_count = drafts.len();
        let Some(last) = drafts.pop() else {
            return Ok(answer.unwritten());
        };
        let linkage = SessionEventLinkage {
            transactional_prelude: statements,
            preceding_events: drafts,
            ..SessionEventLinkage::default()
        };
        match appender.append(last, linkage).await {
            Ok(receipt) => Ok(answer
                .recorded(
                    sequences_ending_at(receipt.sequence, event_count),
                    receipt_event_ids(receipt.preceding_ids, receipt.id),
                    Some(record),
                    kept_reads.unnamed_artifact_ids(&receipt.prelude_results),
                )
                .await),
            Err(error) => Err(RunTurnCommitFailure {
                error: error.into(),
                artifact_ids,
            }),
        }
    }

    /// Commits the turns of `writes`, each beside its run's live steps and record, in one write
    /// across every session they live in, all or none: the turns of one session in one append, in
    /// the order given, and the sessions in the order their first turn comes. Each turn is drafted
    /// and answers as [`RunTurnCommit::append`] says, and a turn of a run the tick does not drive,
    /// handed no record, records nothing; each answers the artifacts its own statements' results
    /// found the replaced kept values naming. Every session's turns hold an event. Fails
    /// with [`RunTurnCommitFailure`], nothing of any turn stored, naming every turn's artifacts;
    /// a refused statement's index counts across the whole write.
    pub(crate) async fn append_together<'tick>(
        writes: Vec<(
            RunTurnCommit,
            Vec<RunLiveStep<'tick>>,
            Option<&'tick RunEngineRecord>,
        )>,
        appender: &SessionEventAppender,
    ) -> Result<Vec<RunTurnCommitted>, RunTurnCommitFailure> {
        let mut drafted = Vec::with_capacity(writes.len());
        let mut draft_error = None;
        let mut artifact_ids = Vec::new();
        for (commit, live_steps, record) in writes {
            match commit.drafted(live_steps) {
                Ok(turn) => {
                    artifact_ids.extend(turn.artifact_ids.iter().copied());
                    drafted.push((turn, record));
                }
                Err(failure) => {
                    artifact_ids.extend(failure.artifact_ids);
                    draft_error.get_or_insert(failure.error);
                }
            }
        }
        if let Some(error) = draft_error {
            return Err(RunTurnCommitFailure {
                error,
                artifact_ids,
            });
        }
        // Each session's turns, by their place in `drafted`, in the order the sessions first come.
        let mut sessions: Vec<(SessionId, Vec<usize>)> = Vec::new();
        for (place, (turn, _)) in drafted.iter().enumerate() {
            match sessions
                .iter_mut()
                .find(|(session_id, _)| *session_id == turn.session_id)
            {
                Some((_, places)) => places.push(place),
                None => sessions.push((turn.session_id, vec![place])),
            }
        }
        let event_counts: Vec<usize> = drafted.iter().map(|(turn, _)| turn.drafts.len()).collect();
        let statement_counts: Vec<usize> = drafted
            .iter()
            .map(|(turn, _)| turn.statements.len())
            .collect();
        let mut appends = Vec::with_capacity(sessions.len());
        for (_, places) in &sessions {
            let mut drafts = Vec::new();
            let mut statements = Vec::new();
            for &place in places {
                let turn = &mut drafted[place].0;
                drafts.append(&mut turn.drafts);
                statements.append(&mut turn.statements);
            }
            let last = drafts
                .pop()
                .expect("every session's turns of a write hold an event");
            appends.push((
                last,
                SessionEventLinkage {
                    transactional_prelude: statements,
                    preceding_events: drafts,
                    ..SessionEventLinkage::default()
                },
            ));
        }
        let receipts = match appender.append_together(appends).await {
            Ok(receipts) => receipts,
            Err(error) => {
                return Err(RunTurnCommitFailure {
                    error: error.into(),
                    artifact_ids,
                });
            }
        };
        let mut sequences: Vec<Vec<SafeInt<0>>> = vec![Vec::new(); drafted.len()];
        let mut ids: Vec<Vec<SessionEventId>> = vec![Vec::new(); drafted.len()];
        let mut dropped: Vec<Vec<ArtifactId>> = vec![Vec::new(); drafted.len()];
        for ((_, places), receipt) in sessions.iter().zip(receipts) {
            // Each turn's statements sit in its session's prelude in the order they were joined.
            let mut prelude_start = 0;
            for &place in places {
                let prelude_end = prelude_start + statement_counts[place];
                dropped[place] = drafted[place]
                    .0
                    .kept_reads
                    .unnamed_artifact_ids(&receipt.prelude_results[prelude_start..prelude_end]);
                prelude_start = prelude_end;
            }
            let session_count: usize = places.iter().map(|&place| event_counts[place]).sum();
            let mut session_sequences =
                sequences_ending_at(receipt.sequence, session_count).into_iter();
            let mut session_ids = receipt_event_ids(receipt.preceding_ids, receipt.id).into_iter();
            for &place in places {
                sequences[place] = session_sequences
                    .by_ref()
                    .take(event_counts[place])
                    .collect();
                ids[place] = session_ids.by_ref().take(event_counts[place]).collect();
            }
        }
        let mut committed = Vec::with_capacity(drafted.len());
        for ((((turn, record), turn_sequences), turn_ids), turn_dropped) in
            drafted.into_iter().zip(sequences).zip(ids).zip(dropped)
        {
            committed.push(
                turn.answer
                    .recorded(turn_sequences, turn_ids, record, turn_dropped)
                    .await,
            );
        }
        Ok(committed)
    }

    /// The turn drafted for its write: the run's ending added where the turn ends it, else its
    /// status move, then each event drafted at its instant. Fails with [`RunTurnCommitFailure`]
    /// when an event does not draft.
    fn drafted<'tick>(
        mut self,
        live_steps: impl IntoIterator<Item = RunLiveStep<'tick>>,
    ) -> Result<DraftedTurn, RunTurnCommitFailure> {
        let (run_status, ending_event) = match self.ending.take() {
            Some(ending) => {
                let (status, ending_event) = self.add_run_ending(ending);
                (Some(status), Some(ending_event))
            }
            None => (self.add_run_status_move(live_steps), None),
        };
        let Self {
            keys,
            run_id: _,
            counts,
            status_before: _,
            person_wait,
            payloads: _,
            events,
            statements,
            pending,
            artifact_ids,
            kept_reads,
            moves,
            gates,
            ending: _,
            posts_results: _,
        } = self;
        let drafted = events
            .into_iter()
            .map(|turn_event| {
                Ok(
                    SessionEventDraft::of_session(keys.session_id, &turn_event.event)?
                        .with_occurred_at(turn_event.at),
                )
            })
            .collect::<Result<Vec<_>, SessionEventEmitError>>();
        match drafted {
            Ok(drafts) => Ok(DraftedTurn {
                session_id: keys.session_id,
                drafts,
                statements,
                artifact_ids,
                kept_reads,
                answer: TurnAnswer {
                    pending,
                    moves,
                    gates,
                    run_status,
                    ending_event,
                    counts,
                    person_wait,
                },
            }),
            Err(error) => Err(RunTurnCommitFailure {
                error,
                artifact_ids,
            }),
        }
    }
}

/// A turn drafted for its write: its session, its events and statements, the artifacts its
/// payload refs name, where its statements' results name the kept-value artifacts no row names
/// once it commits, and what it answers once the write commits.
struct DraftedTurn {
    session_id: SessionId,
    drafts: Vec<SessionEventDraft>,
    statements: Vec<WriteStatement>,
    artifact_ids: Vec<ArtifactId>,
    kept_reads: KeptArtifactReads,
    answer: TurnAnswer,
}

/// What a drafted turn records and answers once its write commits.
struct TurnAnswer {
    /// Each step whose `pending` row the turn writes, beside the index of the event it rides.
    pending: Vec<(WorkflowStepKey, usize)>,
    moves: Vec<(WorkflowStepKey, StepMove)>,
    gates: Vec<(ApprovalDecision, Option<WorkflowNodeId>)>,
    /// The status the turn stored on the run, where it moved it.
    run_status: Option<WorkflowRunStatus>,
    /// The index of the run's ending event, where the turn ended the run.
    ending_event: Option<usize>,
    counts: RunStepCounts,
    person_wait: RunPersonWait,
}

impl TurnAnswer {
    /// The answer of a turn that wrote nothing: the counts and the columns as handed in.
    fn unwritten(self) -> RunTurnCommitted {
        RunTurnCommitted {
            event_sequences: Vec::new(),
            readied: Vec::new(),
            counts: self.counts,
            person_wait: self.person_wait,
            dropped_kept_artifact_ids: Vec::new(),
            ending_event_id: None,
        }
    }

    /// The answer of a turn whose events committed at `event_sequences` under `event_ids`, both in
    /// write order, and whose write replaced the kept values naming `dropped_kept_artifact_ids`,
    /// once each move, gate answer and status move went to `record`, where there is one.
    async fn recorded(
        self,
        event_sequences: Vec<SafeInt<0>>,
        mut event_ids: Vec<SessionEventId>,
        record: Option<&RunEngineRecord>,
        dropped_kept_artifact_ids: Vec<ArtifactId>,
    ) -> RunTurnCommitted {
        let readied = self
            .pending
            .into_iter()
            .map(|(step, readying_event)| (step, event_sequences[readying_event]))
            .collect();
        if let Some(record) = record {
            for (step, step_move) in &self.moves {
                record.decision(Some(step), step_move.decision()).await;
            }
            for (outcome, node_id) in self.gates {
                record
                    .decision(None, EngineDecision::GateResolved { outcome, node_id })
                    .await;
            }
            if let Some(status) = self.run_status {
                record
                    .decision(None, EngineDecision::RunStatus(status))
                    .await;
            }
        }
        RunTurnCommitted {
            ending_event_id: self
                .ending_event
                .map(|ending_event| event_ids.swap_remove(ending_event)),
            event_sequences,
            readied,
            counts: self.counts,
            person_wait: self.person_wait,
            dropped_kept_artifact_ids,
        }
    }
}

/// The ids of one session's write's events, in write order: its `preceding` events', then the
/// `last` one's.
fn receipt_event_ids(
    mut preceding: Vec<SessionEventId>,
    last: SessionEventId,
) -> Vec<SessionEventId> {
    preceding.push(last);
    preceding
}

/// The sequences of `count` events of one session's write, consecutive and ending at `last`.
fn sequences_ending_at(last: SafeInt<0>, count: usize) -> Vec<SafeInt<0>> {
    let count = SafeInt::from_usize(count).get();
    let first = last.get() + 1 - count;
    (0..count)
        .map(|offset| {
            SafeInt::new(first + offset).expect("a sequence below the last one's is safe")
        })
        .collect()
}
