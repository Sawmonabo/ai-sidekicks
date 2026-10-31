//! The stream's hand-offs to the run engine: rows through the reorder buffer, streamed pieces as
//! rows of their block, a row or marker of the lead's run, and each delivery with the frame kind it
//! came from.

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use tokio::time::Instant;

use super::{ClaudeDeliveryStream, ClaudeSessionStream, bound};
use crate::driver::claude::delivery::claude_delivery_origin;
use crate::driver::claude::delivery::run_readings::{ClaudeMessageKey, ClaudeRowDelivery};
use crate::driver::claude::delivery::streamed_blocks::ClaudeStreamedPiece;
use crate::driver::claude::run::routes::ClaudeBoundRun;
use crate::driver::delivery_dispatch::dispatch_delivery;
use crate::driver::reorder_buffer::ReorderBufferedEvent;
use crate::run::delivery::{InboundDelivery, InboundOutcome, LateAppendableRow, RunMarker};

impl ClaudeDeliveryStream {
    // Admits rows through the reorder buffer and sends what it releases.
    pub(super) async fn admit_rows(
        &self,
        session: &ClaudeSessionStream,
        rows: Vec<ReorderBufferedEvent<ClaudeRowDelivery>>,
        wire: &str,
    ) {
        for row in rows {
            let released = session.lock().buffer.admit(row, Instant::now());
            self.send_rows(session, released, Some(wire)).await;
        }
    }

    // Sends streamed pieces as rows of the block they were streamed in.
    pub(super) async fn send_pieces(
        &self,
        session: &ClaudeSessionStream,
        binding_id: &RuntimeBindingId,
        pieces: Vec<ClaudeStreamedPiece>,
    ) {
        let rows = pieces
            .into_iter()
            .map(|piece| {
                ClaudeRowDelivery::of_message(
                    binding_id,
                    piece.row,
                    Some(ClaudeMessageKey::Block(piece.block_key)),
                )
            })
            .collect();
        self.admit_rows(session, rows, "stream_event").await;
    }

    // Sends rows the buffer released, keeping the event each row of a message or block was
    // written as.
    pub(super) async fn send_rows(
        &self,
        session: &ClaudeSessionStream,
        rows: Vec<ClaudeRowDelivery>,
        wire: Option<&str>,
    ) {
        for row in rows {
            let ClaudeRowDelivery {
                binding_id,
                operation,
                row,
                body,
                message_key,
            } = row;
            let outcome = self
                .send(
                    session,
                    row.into_inbound(binding_id, operation.as_ref(), body),
                    wire,
                )
                .await;
            if let (Some(key), Some(event_id)) = (
                message_key,
                outcome.as_ref().and_then(InboundOutcome::event_id),
            ) {
                session
                    .lock()
                    .event_ids_by_message_key
                    .entry(key)
                    .or_default()
                    .push(event_id.clone());
            }
        }
    }

    pub(super) async fn send_row(
        &self,
        session: &ClaudeSessionStream,
        lead: &ClaudeBoundRun,
        row: LateAppendableRow,
        wire: &str,
    ) {
        let delivery = InboundDelivery::SessionRow {
            binding: bound(lead),
            row,
            content: None,
        };
        self.send(session, delivery, Some(wire)).await;
    }

    pub(super) async fn send_marker(
        &self,
        session: &ClaudeSessionStream,
        lead: &ClaudeBoundRun,
        marker: RunMarker,
        wire: Option<&str>,
    ) {
        let delivery = InboundDelivery::RunMarker {
            binding: bound(lead),
            marker,
        };
        self.send(session, delivery, wire).await;
    }

    // Hands one delivery to the run engine and waits for its outcome.
    pub(super) async fn send(
        &self,
        session: &ClaudeSessionStream,
        delivery: InboundDelivery<'_>,
        wire: Option<&str>,
    ) -> Option<InboundOutcome> {
        let origin = claude_delivery_origin(Some(session.provider_account_id.clone()), wire);
        dispatch_delivery(&*self.dependencies.dispatch, origin, delivery).await
    }
}
