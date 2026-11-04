//! The restart's sweep: each tool call receipt the daemon's stop left in flight is resumed through
//! the dispatch's own race, on the client's tracker, so the client's stop waits for it.
//!
//! - Where the run's session stands is the caller's read: a damaged session's receipt is left in
//!   flight with nothing sent; a session the stop named resumes its receipts with their stop asked
//!   for; a run no session owns has its receipts resumed over a closed standing connection, which
//!   ends each unknown.
//! - A receipt with no task names no server, so it ends unknown at once, as a stdio task does.
//! - Each end the sweep does not write is logged and its receipt left in flight: a backgrounded
//!   call's end waits for its result's hand-off, and the client's stop leaves the end to the next
//!   start.

use std::error::Error;
use std::sync::Arc;

use rusqlite::Connection;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::client::McpClient;
use crate::client::connection::standing::McpStandingConnection;
use crate::client::dispatch::{McpCallCompletionError, McpToolDispatch};
use crate::client::tasks::McpTaskContact;
use crate::command_receipts::{InFlightReceipt, read_in_flight_receipts};

#[cfg(test)]
mod tests;

/// The distinct statements the sweep keeps prepared on each read connection, beside those of the
/// session read its caller passes.
pub const MCP_RESTART_SWEEP_STATEMENT_CAPACITY: usize = 1;

/// Where the run of a receipt in flight stands, as the restart's recovery reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpReceiptSession {
    /// The run's session goes on, so its receipt is resumed live.
    Continues(SessionId),
    /// The stop named the run's session, so its receipt is resumed with its stop asked for.
    Stopped(SessionId),
    /// The session's history is damaged, so its receipt is left in flight, nothing sent.
    Damaged,
    /// No session the daemon keeps owns the run, so its receipt ends unknown.
    Missing,
}

/// Why the sweep could not read the receipts in flight.
#[derive(Debug, thiserror::Error)]
pub enum McpRestartSweepError {
    /// The receipts' statement failed.
    #[error("the tool call receipts in flight could not be read")]
    Database(#[from] rusqlite::Error),
    /// The read reached no connection.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

/// The restart's sweep over the tool call receipts in flight: the client their sessions'
/// connections stand on, the dispatch that resumes each, and the reads that find them.
pub struct McpRestartSweep {
    client: Arc<McpClient>,
    dispatch: Arc<McpToolDispatch>,
    reads: Arc<DatabaseReadPool>,
}

/// A receipt the sweep resumes: in its run's session, its stop asked for or not, or in none.
struct SweptReceipt {
    receipt: InFlightReceipt,
    session_id: Option<SessionId>,
    is_stopped: bool,
}

impl McpRestartSweep {
    /// A sweep resuming over `client`'s standing connections through `dispatch`, reading the
    /// receipts on `reads`.
    pub fn new(
        client: Arc<McpClient>,
        dispatch: Arc<McpToolDispatch>,
        reads: Arc<DatabaseReadPool>,
    ) -> Self {
        Self {
            client,
            dispatch,
            reads,
        }
    }

    /// Starts resuming every receipt in flight on the client's tracker, with where its run stands
    /// as `session` reads it, and returns without waiting for them. Fails with
    /// [`McpRestartSweepError`] when the read fails, resuming nothing.
    pub async fn start<Reader>(&self, session: Reader) -> Result<(), McpRestartSweepError>
    where
        Reader: Fn(&Connection, &RunId) -> rusqlite::Result<McpReceiptSession> + Send + 'static,
    {
        // One read takes every receipt with its session; a row or session that does not read is
        // logged and left in flight.
        let swept = self
            .reads
            .read(ReadLength::Long, move |connection| {
                let receipts = read_in_flight_receipts(connection)?;
                Ok::<_, McpRestartSweepError>(
                    receipts
                        .into_iter()
                        .filter_map(|read| receipt_to_sweep(connection, &session, read))
                        .collect::<Vec<_>>(),
                )
            })
            .await?;
        for swept_receipt in swept {
            let client = Arc::clone(&self.client);
            let dispatch = Arc::clone(&self.dispatch);
            self.client
                .closings
                .spawn(async move { sweep_receipt(&client, &dispatch, swept_receipt).await });
        }
        Ok(())
    }
}

// The receipt `read` gives with where its run's session stands, or `None` when it is left in
// flight: a row that does not read, a session read that fails, or a damaged session.
fn receipt_to_sweep(
    connection: &Connection,
    session: &impl Fn(&Connection, &RunId) -> rusqlite::Result<McpReceiptSession>,
    read: rusqlite::Result<InFlightReceipt>,
) -> Option<SweptReceipt> {
    let receipt = match read {
        Ok(receipt) => receipt,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a tool call receipt in flight did not read; it is left in flight"
            );
            return None;
        }
    };
    let (session_id, is_stopped) = match session(connection, &receipt.run_id) {
        Ok(McpReceiptSession::Continues(session_id)) => (Some(session_id), false),
        Ok(McpReceiptSession::Stopped(session_id)) => (Some(session_id), true),
        Ok(McpReceiptSession::Missing) => (None, false),
        Ok(McpReceiptSession::Damaged) => return None,
        Err(error) => {
            tracing::warn!(
                run_id = %receipt.run_id,
                error = &error as &(dyn Error + 'static),
                "the session of a tool call receipt in flight was not read; it is left in flight"
            );
            return None;
        }
    };
    Some(SweptReceipt {
        receipt,
        session_id,
        is_stopped,
    })
}

// Resumes one receipt and writes its end, logging an end left unwritten.
async fn sweep_receipt(client: &McpClient, dispatch: &McpToolDispatch, swept: SweptReceipt) {
    let SweptReceipt {
        receipt,
        session_id,
        is_stopped,
    } = swept;
    let (receipt_id, run_id, is_backgrounded) =
        (receipt.id, receipt.run_id, receipt.is_backgrounded);
    let standing = match (session_id, &receipt.task) {
        (Some(session_id), Some(task)) => client.standing_connection(session_id, &task.server_name),
        // No task names a server to stand on, and a run no session owns has none open; reading
        // the client's stopping mark, so its stop still reads as the stop.
        (Some(_), None) | (None, _) => {
            McpStandingConnection::already_closed(client.stopping.clone())
        }
    };
    let cancellation = CancellationToken::new();
    if is_stopped {
        // The stop asked for before the restart.
        cancellation.cancel();
    }
    // No surface shows a swept receipt's contact, so the sweep publishes into its own.
    let contact = watch::Sender::new(McpTaskContact::Reached);
    // Boxed, so the resume's race is kept off the sweep task's own future.
    let resumed = Box::pin(dispatch.resume(&standing, receipt, &contact, &cancellation)).await;
    let dispatched = match resumed {
        Ok(dispatched) => dispatched,
        Err(error) => {
            tracing::debug!(
                receipt_id = ?receipt_id,
                run_id = %run_id,
                error = &error as &(dyn Error + 'static),
                "a swept tool call receipt was not resumed; it is left in flight"
            );
            return;
        }
    };
    let (_, written) = dispatched.complete().await;
    match written {
        Ok(()) | Err(McpCallCompletionError::Settled) => {}
        Err(McpCallCompletionError::ClientStopping) => tracing::debug!(
            receipt_id = ?receipt_id,
            run_id = %run_id,
            "a swept tool call ended as the client stopped; its receipt is left in flight"
        ),
        Err(McpCallCompletionError::Write(error)) if is_backgrounded => tracing::info!(
            receipt_id = ?receipt_id,
            run_id = %run_id,
            error = &error as &(dyn Error + 'static),
            "a swept backgrounded tool call's end is left in flight for its result's hand-off"
        ),
        Err(McpCallCompletionError::Write(error)) => tracing::warn!(
            receipt_id = ?receipt_id,
            run_id = %run_id,
            error = &error as &(dyn Error + 'static),
            "a swept tool call's end was not written; its receipt is left in flight"
        ),
    }
}
