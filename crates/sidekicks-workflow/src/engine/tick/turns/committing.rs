//! A run's share of a turn: what reached it gathered, held while its pause point is pending,
//! applied through its commit in one write, and what the write readied, answered or ended followed
//! once it commits; a run whose write fails is dropped.

use std::collections::VecDeque;
use std::sync::Arc;

use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;

use super::retries::arm_retry;
use super::{
    EngineTick, ReadiedNext, RunArrivals, RunTurn, TurnReadied, ending, still_ready,
    sweep_released_run,
};
use crate::definitions::kept_values::remove_dropped;
use crate::engine::event_record::EngineFault;
use crate::engine::tick::commit::{RunTurnCommit, RunTurnCommitFailure};
use crate::engine::tick::dispatch::stop_agent_run;
use crate::engine::tick::live_runs::{LiveRun, LiveStep};
use crate::engine::tick::{ParkedAgentRun, ReadyStep};

impl EngineTick {
    /// The share of the run `run_id` in this turn of what `arrived`: a starting node run's walk's
    /// first turn, its reused skips and the steps they ready, then its next batch, whose reports
    /// an earlier turn answered, so what that turn decided stands, then the answers, then the
    /// reports, then the person's Resumes, then their cancels, each through the run's commit, the
    /// walk's answers added, a quiet run flushed, its ending added where it is over, all in one
    /// write; each settled answer and each Resume taken is replied to once the write commits, a
    /// cancel once the write of the run's ending does, and each approval whose point is taken is
    /// asked after it. Answers the steps to dispatch, the retry attempts come due among them while
    /// they are still live, `pending` and undispatched, or `None` when the run is not live. A run
    /// whose write ends it leaves the live set; a run whose write fails leaves it with its steps
    /// canceled.
    ///
    /// While a point of the run's pause is pending, the run is held: its answers, reports, due
    /// retries, Resumes and cancels are kept unwritten and unreplied, and it is never batched. The
    /// turn in which its last point ends, or any point once a cancel waits, takes its next batch,
    /// the held answers then its own, the held reports then its own, the held Resumes and cancels
    /// each then its own, and after the write the held dispatches, then what it readied, then its
    /// own due retries, then the pause's cards in the order they were opened, which a cancel leaves
    /// unraised. A pause this turn begins keeps the steps it readied for that turn.
    pub(super) async fn run_turn(
        &mut self,
        run_id: WorkflowRunId,
        arrived: RunArrivals,
    ) -> Option<Vec<ReadyStep>> {
        let RunArrivals {
            answers,
            reports,
            due,
            taken,
            resumes,
            cancels,
            seed,
        } = arrived;
        let mut live = self.runs.remove(&run_id)?;
        // A cancel waits only for the capture under way, so the first point to end abandons the
        // pause and lets the cancel run before any further point.
        let is_cancel_due =
            !taken.is_empty() && (!cancels.is_empty() || !live.held.cancels.is_empty());
        for point in taken {
            if let Some(turn_ask) = live
                .pausing
                .iter_mut()
                .find(|turn_ask| turn_ask.opened.wait_id == point.wait_id)
            {
                turn_ask.is_point_taken = true;
            }
        }
        if live.is_pausing() && !is_cancel_due {
            live.held.answers.extend(answers);
            live.held.reports.extend(reports);
            live.held.dispatches.extend(due);
            live.held.resumes.extend(resumes);
            live.held.cancels.extend(cancels);
            self.runs.insert(run_id, live);
            return Some(Vec::new());
        }
        let answers = held_first(&mut live.held.answers, answers);
        let reports = held_first(&mut live.held.reports, reports);
        let resumes = held_first(&mut live.held.resumes, resumes);
        let cancels = held_first(&mut live.held.cancels, cancels);
        let held_dispatches = std::mem::take(&mut live.held.dispatches);
        let asks = std::mem::take(&mut live.pausing);
        let mut turn = RunTurn {
            commit: RunTurnCommit::new(
                live.event_keys(),
                run_id,
                live.epoch,
                live.counts,
                std::mem::take(&mut live.person_wait),
                Arc::clone(&self.payloads),
            ),
            readied: Vec::new(),
            asks,
            replies: Vec::new(),
            follow_ups: VecDeque::new(),
            resumes: Vec::new(),
            resume_replies: Vec::new(),
            last_readying_event: None,
        };
        if let Some(seed) = seed {
            // The trigger's reused skip is the seed's first event, which every step it readies
            // follows.
            self.take_walk(&mut live, &mut turn, seed, (0, WireInstant::now()))
                .await;
        }
        for report in std::mem::take(&mut live.next_batch) {
            self.apply_report(&mut live, &mut turn, report).await;
            self.apply_follow_ups(&mut live, &mut turn).await;
        }
        for intake in answers {
            self.apply_answer(&mut live, &mut turn, intake).await;
            self.apply_follow_ups(&mut live, &mut turn).await;
        }
        for report in reports {
            self.apply_report(&mut live, &mut turn, report).await;
            self.apply_follow_ups(&mut live, &mut turn).await;
        }
        for intake in resumes {
            self.apply_resume(&mut live, &mut turn, intake).await;
            self.apply_follow_ups(&mut live, &mut turn).await;
        }
        for intake in cancels {
            self.apply_cancel(&mut live, &mut turn, intake).await;
            self.apply_follow_ups(&mut live, &mut turn).await;
        }
        if live.steps.is_empty() {
            self.flush(&mut live, &mut turn).await;
        }
        ending::end_when_over(&mut live, &mut turn);
        let RunTurn {
            commit,
            readied,
            asks,
            replies,
            resumes,
            resume_replies,
            ..
        } = turn;
        match commit
            .append(&self.appender, &live.record, live.live_steps())
            .await
        {
            Ok(committed) => {
                // The replaced kept values' artifacts go while the run's record can still take
                // what was left behind.
                for (_, removal) in
                    remove_dropped(&*self.payloads, &committed.dropped_kept_artifact_ids).await
                {
                    live.record
                        .fault(None, EngineFault::TurnPayloadLeftBehind, &*removal)
                        .await;
                }
                let ending_event_id = committed.ending_event_id;
                live.counts = committed.counts;
                live.person_wait = committed.person_wait;
                live.follow_cap(&self.deadlines, ending_event_id.is_some());
                let mut dispatched: Vec<ReadyStep> = held_dispatches
                    .into_iter()
                    .filter_map(|step| still_ready(&live, step))
                    .collect();
                // The write answers each readied step in the order the turn readied it.
                for (turn_readied, (_step, readying_sequence)) in
                    readied.into_iter().zip(committed.readied)
                {
                    let TurnReadied {
                        ready,
                        inputs,
                        input_ref,
                        next,
                    } = turn_readied;
                    match next {
                        ReadiedNext::Dispatch => dispatched.push(ReadyStep {
                            step: ready.step.clone(),
                            run_index: ready.run_index,
                            inputs: inputs.clone(),
                            input_ref: input_ref.clone(),
                            is_taken_back: false,
                        }),
                        ReadiedNext::Retry(wait) => arm_retry(
                            &mut self.retries,
                            ready.step.clone(),
                            wait,
                            live.scope.cancel.clone(),
                        ),
                        ReadiedNext::Fail(reports) => live.next_batch.extend(reports),
                        ReadiedNext::Canceled => continue,
                    }
                    live.steps.insert(
                        ready.step.execution_index.get(),
                        LiveStep::readied(ready, inputs, input_ref, readying_sequence),
                    );
                }
                dispatched.extend(due.into_iter().filter_map(|step| still_ready(&live, step)));
                for reply in replies {
                    let _unheard = reply.send(Ok(()));
                }
                for (reply, left_version) in resume_replies {
                    let _unheard = reply.send(Ok(left_version));
                }
                for (step, line) in std::mem::take(&mut live.deadline_lines) {
                    live.record.decision(step.as_ref(), line).await;
                }
                self.resume_parked(&live, resumes);
                self.ask_people(&mut live, asks).await;
                self.needs_deadline_read |= std::mem::take(&mut live.needs_deadline_read);
                if let Some(ending_event_id) = ending_event_id {
                    self.binder.note_context_changed(live.scope.session_id);
                    if live.scope.is_bound {
                        sweep_released_run(
                            &mut self.released_sweeps,
                            Arc::clone(&self.binder),
                            live.scope.session_id,
                            live.record.clone(),
                        );
                    }
                    for reply in live.cancel_replies.drain(..) {
                        let _unheard = reply.send(Ok(ending_event_id.clone()));
                    }
                    // A retry's wait for a step the ending stopped ends with its run.
                    live.scope.cancel.cancel();
                    self.deadlines.forget_cap(run_id);
                    self.recorder.end_run(run_id);
                    return Some(Vec::new());
                }
                if live.is_pausing() {
                    live.held
                        .dispatches
                        .extend(dispatched.into_iter().map(|ready| ready.step));
                    self.runs.insert(run_id, live);
                    return Some(Vec::new());
                }
                if !live.next_batch.is_empty() {
                    self.batched.push(run_id);
                }
                self.runs.insert(run_id, live);
                Some(dispatched)
            }
            Err(failure) => {
                self.drop_failed_run(live, failure, resumes).await;
                None
            }
        }
    }

    /// Applies the reports the turn's last report queued, in order, each queuing its own after it.
    async fn apply_follow_ups(&self, live: &mut LiveRun, turn: &mut RunTurn) {
        while let Some(follow_up) = turn.follow_ups.pop_front() {
            self.apply_report(live, turn, follow_up).await;
        }
    }

    /// Ends the run of `live`, whose turn's write was refused: cancels its steps, stops each agent
    /// run a spent account parked, each of the turn's `resumes` and the stored run of each step
    /// the restart took back and has not dispatched, which no cancel reaches, deletes every
    /// artifact the write would have named and records the failure; the restart settles what the
    /// log holds. Its stored waits stay off the deadline clock, and an answer to one is not taken.
    async fn drop_failed_run(
        &mut self,
        mut live: LiveRun,
        failure: RunTurnCommitFailure,
        resumes: Vec<(WorkflowStepKey, ParkedAgentRun)>,
    ) {
        let RunTurnCommitFailure {
            error,
            artifact_ids,
        } = failure;
        live.scope.cancel.cancel();
        let parked: Vec<(WorkflowStepKey, ParkedAgentRun)> = live
            .steps
            .values_mut()
            .filter_map(|live_step| {
                let parked = live_step.parked_agent_run.take()?;
                Some((live_step.step.clone(), parked))
            })
            .collect();
        for (step, parked) in parked.into_iter().chain(resumes) {
            stop_agent_run(&live.record, &step, Ok(Some(parked.run))).await;
        }
        let taken_back: Vec<WorkflowStepKey> = live
            .taken_back
            .iter()
            .map(|index| live.steps[index].step.clone())
            .collect();
        for step in taken_back {
            live.stop_taken_back(&self.dispatch, &step).await;
        }
        self.dropped_waits.extend(
            live.steps
                .values()
                .filter_map(|live_step| live_step.wait_id),
        );
        self.deadlines.skip_run(live.scope.run_id);
        // The dropped run's deadline may be the one armed.
        self.needs_deadline_read = true;
        for (_, removal) in remove_dropped(&*self.payloads, &artifact_ids).await {
            live.record
                .fault(None, EngineFault::TurnPayloadLeftBehind, &*removal)
                .await;
        }
        live.record
            .fault(None, EngineFault::TurnWriteFailed, &error)
            .await;
        self.recorder.end_run(live.scope.run_id);
    }
}

/// `own` after what was `held` of its kind, which is left empty; `own` itself when nothing was
/// held, so no copy is made.
fn held_first<T>(held: &mut Vec<T>, own: Vec<T>) -> Vec<T> {
    if held.is_empty() {
        return own;
    }
    let mut taken = std::mem::take(held);
    taken.extend(own);
    taken
}
