//! A steer's landing: the provider took one of the person's waiting messages into a running turn,
//! recorded with the checkpoint before that message in the same write, at the run position the
//! steer opens.

use std::sync::Arc;

use sidekicks_contracts::event::envelope::SourcePosition;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::events::AgentTurnSteeredPayload;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::restore::SnapshotId;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::events::session::appender::SessionEventDraft;
use sidekicks_store::events::session::read::session_read_bound;

use super::read_sent_message;
use crate::checkpoints::store::{Checkpoint, insert_checkpoint_statement};
use crate::interventions::store::run_at_version_statement;
use crate::run::engine::errors::RunEngineError;
use crate::run::engine::{RunEngine, safe_run_version};
use crate::run::read::RunRead;
use crate::transcript::turn_attribution::RunTurnReads;

impl RunEngine {
    /// Records that the provider took `message_id`'s message into turn `turn_number` of `run_id`
    /// at run position `position`: one `agent.turn.steered`, guarded on the run still at the
    /// version `run` read, whose write keeps the checkpoint before that message at the run's
    /// epoch and `position` where the message is recorded; a message already kept keeps its
    /// first. Fails with the read's or the append's failure, a run moved since `run` among them.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the session records a steer when its binding delivers a message taken into \
                      a turn another message opened"
        )
    )]
    pub(crate) async fn record_steer(
        &self,
        run_id: RunId,
        run: &RunRead,
        turn_number: SafeInt<1>,
        position: SourcePosition,
        message_id: QueueItemId,
    ) -> Result<(), RunEngineError> {
        let session_id = run.session_id;
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        let message = self
            .pool
            .read(ReadLength::Short, move |reader| {
                let Some(message_sequence) = read_sent_message(reader, &session_id, message_id)?
                else {
                    return Ok::<_, RunEngineError>(None);
                };
                let log_end = session_read_bound(&*read_damaged_from_sequence, &session_id, None);
                let standing = RunTurnReads::new(reader, &*read_damaged_from_sequence)
                    .read_standing_before(&session_id, &run_id, log_end)?;
                Ok(Some((message_sequence, standing.epoch)))
            })
            .await?;
        // The version guard leads, so a rollback since the read refuses the steer and its row.
        let mut transactional_prelude = vec![run_at_version_statement(&run_id, run.version)];
        if let Some((message_sequence, epoch)) = message {
            transactional_prelude.push(insert_checkpoint_statement(&Checkpoint {
                checkpoint_id: SnapshotId::new(mint_uuid_v7().to_string())
                    .expect("a minted UUID is a snapshot id"),
                session_id,
                message_sequence,
                run_id,
                turn: EpochPosition { epoch, position },
            }));
        }
        let draft = SessionEventDraft::of_session(
            session_id,
            &SessionEvent::AgentTurnSteered(AgentTurnSteeredPayload {
                session_id,
                run_id,
                run_version: safe_run_version(run.version),
                turn_number,
                position,
                message_id,
            }),
        )?;
        self.append(draft, transactional_prelude, Vec::new(), None)
            .await?;
        Ok(())
    }
}
