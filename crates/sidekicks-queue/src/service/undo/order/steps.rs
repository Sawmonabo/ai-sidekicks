//! The undo's steps as the service takes them, over the run queue, the interventions and the
//! undo's stops.

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::{
    SessionRestoreFileOutcome, SessionRestoreResend, SessionRestoreScope, SessionRestoreStops,
    SessionRestoreTarget,
};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_session::checkpoints::resends::{stage_resend_statement, unstage_resend_statement};
use sidekicks_session::checkpoints::restore_cuts::{
    RecordedCut, read_recorded_cut, record_files_statement,
};
use sidekicks_session::interventions::service::InterventionError;
use sidekicks_session::queue_store::{CurrentLeadRun, QueueItemReader};
use sidekicks_session::run::engine::undo::RollbackCompanions;
use sidekicks_store::database::connection::read_pool::ReadLength;

use super::{UndoPoint, UndoService, UndoSteps};
use crate::error::QueueError;
use crate::provider_session::errors::ProviderSessionError;
use crate::service::undo::{ConversationCut, ConversationCutError, ProviderCut, UndoHold};
use crate::undo::{UndoStopError, UndoStopSet};

impl UndoSteps for UndoService {
    type Hold = UndoHold;

    fn hold(&self, session_id: SessionId, undo_key: ClientUuid) -> BoxFuture<'_, UndoHold> {
        self.queue.hold_for_undo(session_id, undo_key).boxed()
    }

    fn read_recorded_cut(
        &self,
        session_id: SessionId,
        undo_key: ClientUuid,
    ) -> BoxFuture<'_, Result<Option<RecordedCut>, QueueError>> {
        self.queue
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(read_recorded_cut(reader, session_id, &undo_key)?)
            })
            .boxed()
    }

    fn read_point(
        &self,
        session_id: SessionId,
        target: SessionRestoreTarget,
        scope: SessionRestoreScope,
        edited: Option<SessionRestoreResend>,
    ) -> BoxFuture<'_, Result<UndoPoint, ConversationCutError>> {
        async move {
            let reach = self
                .queue
                .read_undo_reach(session_id, &target, scope)
                .await?;
            Ok(UndoPoint {
                resend: edited.map(|edited| reach.resend_with(edited)),
                checkpoint: reach.checkpoint,
            })
        }
        .boxed()
    }

    fn read_lead(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<CurrentLeadRun>, QueueError>> {
        self.queue
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(
                    QueueItemReader::new(reader).read_current_lead_run(&session_id)?,
                )
            })
            .boxed()
    }

    fn wait_out_pause(&self, run_id: RunId) -> BoxFuture<'_, ()> {
        self.queue.pauses.wait_out_calls(run_id).boxed()
    }

    fn is_live(&self, session_id: SessionId) -> bool {
        self.queue.provider_sessions.is_opened(session_id)
    }

    fn read_stops(
        &self,
        session_id: SessionId,
        after_sequence: i64,
    ) -> BoxFuture<'_, Result<UndoStopSet, UndoStopError>> {
        self.stops
            .read_started_after(session_id, after_sequence)
            .boxed()
    }

    fn make_live(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ProviderSessionError>> {
        self.queue
            .provider_sessions
            .open(session_id, run_id)
            .boxed()
    }

    fn read_provider_cut(
        &self,
        session_id: SessionId,
        target: SessionRestoreTarget,
    ) -> BoxFuture<'_, Result<ProviderCut, ConversationCutError>> {
        async move { self.queue.read_provider_cut(session_id, &target).await }.boxed()
    }

    fn stop(
        &self,
        session_id: SessionId,
        after_sequence: i64,
        consented: Option<SessionRestoreStops>,
    ) -> BoxFuture<'_, Result<(), UndoStopError>> {
        async move {
            self.stops
                .stop_started_after(session_id, after_sequence, consented.as_ref())
                .await?;
            Ok(())
        }
        .boxed()
    }

    fn settle_held_calls(
        &self,
        session_id: SessionId,
        after_sequence: i64,
    ) -> BoxFuture<'_, Result<(), ProviderSessionError>> {
        self.queue
            .provider_sessions
            .settle_cut_held_tool_calls(session_id, after_sequence)
            .boxed()
    }

    fn interrupt(
        &self,
        run_id: RunId,
        undo_key: ClientUuid,
    ) -> BoxFuture<'_, Result<(), InterventionError>> {
        self.interventions
            .interrupt_for_undo(run_id, undo_key)
            .boxed()
    }

    fn stage_resend(
        &self,
        session_id: SessionId,
        undo_key: ClientUuid,
        resend: SessionRestoreResend,
    ) -> BoxFuture<'_, Result<(), QueueError>> {
        async move {
            self.queue
                .writer
                .write(vec![stage_resend_statement(session_id, &undo_key, &resend)])
                .await?;
            Ok(())
        }
        .boxed()
    }

    fn cut<'a>(
        &'a self,
        hold: &'a UndoHold,
        target: SessionRestoreTarget,
        companions: RollbackCompanions,
        provider_cut: ProviderCut,
    ) -> BoxFuture<'a, Result<ConversationCut, ConversationCutError>> {
        async move {
            self.queue
                .cut_conversation(hold, &target, companions, provider_cut)
                .await
        }
        .boxed()
    }

    fn record_files(
        &self,
        session_id: SessionId,
        undo_key: ClientUuid,
        files: SessionRestoreFileOutcome,
    ) -> BoxFuture<'_, Result<(), QueueError>> {
        async move {
            self.queue
                .writer
                .write(vec![record_files_statement(session_id, &undo_key, &files)])
                .await?;
            Ok(())
        }
        .boxed()
    }

    fn release(
        &self,
        hold: UndoHold,
        resend: Option<SessionRestoreResend>,
        device_id: DeviceId,
    ) -> BoxFuture<'_, Result<(), QueueError>> {
        self.queue
            .release_undo_hold(hold, resend, device_id)
            .boxed()
    }

    fn unstage_resend(
        &self,
        session_id: SessionId,
        undo_key: ClientUuid,
    ) -> BoxFuture<'_, Result<(), QueueError>> {
        async move {
            self.queue
                .writer
                .write(vec![unstage_resend_statement(session_id, &undo_key)])
                .await?;
            Ok(())
        }
        .boxed()
    }
}
