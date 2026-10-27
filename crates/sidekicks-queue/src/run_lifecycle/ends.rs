//! What a run's end leaves of its place at the memory gate and of the lead's messages still
//! waiting for it: the place parked for an interrupted run that rests for its continue, else
//! released, and the messages moved on to the run before it resting again, the lead run live, else
//! a next run queued for them.

use std::sync::Arc;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_session::queue_store::{CurrentLeadRun, QueueItemReader, QueueItemRecord};
use sidekicks_session::run::agent::read_lead_agent_through;
use sidekicks_session::run::read::read_run_through;
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_store::database::connection::read_pool::ReadLength;

use super::{MovedLeftovers, QueueRunLifecycle};
use crate::error::QueueError;
use crate::recorder::{RetargetRun, lead_run_queued};

impl QueueRunLifecycle {
    // Under `hold`: what a run's end leaves of its place and its waiting messages.
    pub(super) async fn settle_end(
        self: &Arc<Self>,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
    ) -> Result<(), QueueError> {
        let session_id = *hold.key();
        let Some(run) = read_run_through::<QueueError>(&self.deps.pool, run_id).await? else {
            return Ok(());
        };
        // A run continued since is handed its messages as it runs.
        if !run.state.is_terminal() {
            return Ok(());
        }
        {
            let mut state = self.lock();
            if state.resting_run_by_session.get(&session_id) == Some(&run_id) {
                state.resting_run_by_session.remove(&session_id);
            }
            // Messages moved on to this run went with it, beyond an interrupt of the run they
            // left.
            state
                .moved_leftovers_by_run
                .retain(|_, moved| moved.to_run_id != run_id);
        }
        let current = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(
                    QueueItemReader::new(reader).read_current_lead_run(&session_id)?,
                )
            })
            .await?;
        // Only the session's current lead run rests interrupted for a continue; an older one's
        // messages go on as any ended run's do.
        let is_resting = run.state == RunState::Interrupted
            && current
                .as_ref()
                .is_some_and(|current| current.run_id == run_id);
        let admission = &self.deps.admission;
        if is_resting {
            admission.park_interrupted(session_id, run_id);
        } else {
            admission.release(run_id);
        }
        admission.settle_opening(run_id).await?;
        let delivery = &self.deps.delivery;
        delivery.settle(session_id).await;
        delivery.end_run(session_id, run_id);
        if is_resting {
            self.rest(session_id, run_id);
            return self.continue_interrupted_run(hold, run_id, false).await;
        }
        // A message the provider's process keeps for its next turn is not sent again.
        let waiting: Vec<QueueItemRecord> = self
            .read_waiting(run_id)
            .await?
            .into_iter()
            .filter(|item| item.child_handle.is_none() && !delivery.is_handed(&item.id))
            .collect();
        self.move_leftovers(hold, run_id, current, waiting).await
    }

    // The ended run's leftovers go to the run before it resting interrupted again, the lead run
    // live, else a next run queued for them.
    async fn move_leftovers(
        self: &Arc<Self>,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        current: Option<CurrentLeadRun>,
        waiting: Vec<QueueItemRecord>,
    ) -> Result<(), QueueError> {
        let session_id = *hold.key();
        let now = WireInstant::now();
        let recorder = &self.deps.recorder;
        // A lead run newer than the current one failed to start: the interrupted run before it is
        // current again, so it rests for its continue once more and takes this run's messages.
        let resting_again = current
            .filter(|current| current.state == RunState::Interrupted && current.run_id < run_id)
            .map(|current| current.run_id);
        if let Some(resting_again) = resting_again {
            if self.lock().resting_run_by_session.get(&session_id) != Some(&resting_again) {
                self.rest(session_id, resting_again);
            }
            if !waiting.is_empty() {
                recorder
                    .record_retarget(RetargetRun::Interrupted(resting_again), &waiting, &now)
                    .await?;
                self.note_moved(session_id, run_id, resting_again, &waiting);
            }
            return self
                .continue_interrupted_run(hold, resting_again, false)
                .await;
        }
        if waiting.is_empty() {
            return Ok(());
        }
        let live_run_id = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(QueueItemReader::new(reader).read_live_lead_run(&session_id)?)
            })
            .await?;
        if let Some(live_run_id) = live_run_id {
            recorder
                .record_retarget(RetargetRun::Live(live_run_id), &waiting, &now)
                .await?;
            self.note_moved(session_id, run_id, live_run_id, &waiting);
            self.deps.delivery.hand_waiting(hold, live_run_id).await?;
            return Ok(());
        }
        let next_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let agent_id = read_lead_agent_through::<QueueError>(&self.deps.pool, session_id).await?;
        recorder
            .record_next_run(
                lead_run_queued(session_id, next_run_id, agent_id),
                &waiting,
                &now,
            )
            .await?;
        self.note_moved(session_id, run_id, next_run_id, &waiting);
        self.deps.admission.start(session_id, next_run_id);
        Ok(())
    }

    fn note_moved(
        &self,
        session_id: SessionId,
        from_run_id: RunId,
        to_run_id: RunId,
        moved: &[QueueItemRecord],
    ) {
        self.lock().moved_leftovers_by_run.insert(
            from_run_id,
            MovedLeftovers {
                session_id,
                to_run_id,
                item_ids: moved.iter().map(|item| item.id).collect(),
            },
        );
    }
}
