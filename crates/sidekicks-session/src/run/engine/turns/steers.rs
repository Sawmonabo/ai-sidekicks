//! A steer's landing: the provider took one of the person's waiting messages into a running turn,
//! recorded with the checkpoint before that message in the same write, at the run's next position.
//! A message the person never sent, such as an answer the daemon wrote into the turn, is recorded
//! as nothing and takes no position.

use std::sync::Arc;

use sidekicks_contracts::event::envelope::SourcePosition;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::run::events::AgentTurnSteeredPayload;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::restore::SnapshotId;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::events::session::appender::SessionEventDraft;
use sidekicks_store::events::session::read::session_read_bound;

use super::read_sent_message;
use crate::checkpoints::store::{Checkpoint, insert_checkpoint_statement};
use crate::run::engine::errors::RunEngineError;
use crate::run::engine::{LiveAppend, RunEngine, safe_run_version};
use crate::transcript::turn_attribution::RunTurnReads;

/// What recording a steer did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SteerRecord {
    /// The steer and its checkpoint were written, as this event.
    Written(FreeFormText<EVENT_FIELD_MAX_LEN>),
    /// Nothing was written: the run had ended.
    RunEnded,
    /// Nothing was written: the log holds no message the person sent under the steer's id.
    NotSent,
}

impl RunEngine {
    /// Records that the provider took `message_id`'s message into turn `turn_number` of `run_id`:
    /// one `agent.turn.steered` at the run's next position, whose write keeps the checkpoint before
    /// that message at that position, guarded on the run's version and read again when the run
    /// moved in between. Writes nothing for a run that has ended or a message the person never
    /// sent. Fails with the read's or the append's failure, [`RunRefusal::NotFound`] for a run with
    /// no row among them.
    ///
    /// [`RunRefusal::NotFound`]: crate::run::refusals::RunRefusal::NotFound
    pub(crate) async fn record_steer(
        &self,
        run_id: RunId,
        turn_number: SafeInt<1>,
        message_id: QueueItemId,
    ) -> Result<SteerRecord, RunEngineError> {
        let session_id = self.require_run(run_id).await?.session_id;
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        let reading = self
            .pool
            .read(ReadLength::Short, move |reader| {
                let Some(message_sequence) = read_sent_message(reader, &session_id, message_id)?
                else {
                    return Ok::<_, RunEngineError>(None);
                };
                let log_end = session_read_bound(&*read_damaged_from_sequence, &session_id, None);
                let standing = RunTurnReads::new(reader, &*read_damaged_from_sequence)
                    .read_standing_before(&session_id, &run_id, log_end)?;
                Ok(Some((message_sequence, standing)))
            })
            .await?;
        let Some((message_sequence, standing)) = reading else {
            return Ok(SteerRecord::NotSent);
        };
        // One read serves every attempt: a rollback is refused while the run holds a turn with no
        // end, and a steer lands only in an open turn.
        let position = SourcePosition(
            SafeInt::new(standing.position.0.get() + 1)
                .expect("a run's positions number far fewer than 2^53"),
        );
        let recorded = self
            .append_while_live(run_id, |run| {
                Ok(LiveAppend {
                    draft: SessionEventDraft::of_session(
                        session_id,
                        &SessionEvent::AgentTurnSteered(AgentTurnSteeredPayload {
                            session_id,
                            run_id,
                            run_version: safe_run_version(run.version),
                            turn_number,
                            position,
                            message_id,
                        }),
                    )?,
                    preceding_events: Vec::new(),
                    statements: vec![insert_checkpoint_statement(&Checkpoint {
                        checkpoint_id: SnapshotId::new(mint_uuid_v7().to_string())
                            .expect("a minted UUID is a snapshot id"),
                        session_id,
                        message_sequence,
                        run_id,
                        turn_number,
                        turn: EpochPosition {
                            epoch: standing.epoch,
                            position,
                        },
                    })],
                    occurred_at: None,
                })
            })
            .await?;
        Ok(match recorded {
            Some((_run, receipt)) => SteerRecord::Written(receipt.id),
            None => SteerRecord::RunEnded,
        })
    }
}
