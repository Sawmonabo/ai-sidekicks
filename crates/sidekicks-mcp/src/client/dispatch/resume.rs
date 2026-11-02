//! A task's follow across its server's Reconnects. A follow on a server at an address that its
//! connection's close cut waits for the connection a Reconnect publishes in its place, and goes on
//! there through `resume_task`, adopting the task's watch with its open and kept questions and its
//! asked keys; a stdio server's task died with its process, so its end stays unknown.
//!
//! - While it waits, the contact reads at once why no connection of the task's endpoint is live:
//!   none is (`NotConfigured`), or the live one reaches another address (`Reconfigured`). The
//!   re-bind writes back the arm the contact held before, a refused cancel's included.
//! - The wait never times out. The session's close or the caller's cancel ends it with the end
//!   unknown, which the dispatch writes; the client's stop ends it writing nothing. A wait that
//!   ends without a re-bind ends the task's watch, which withdraws its questions.

use std::sync::{Arc, Mutex};

use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::client::connection::McpServerConnection;
use crate::client::connection::standing::{
    McpConnectionAbsence, McpReplacement, McpStandingConnection,
};
use crate::client::dispatch::CallRace;
use crate::client::tasks::{
    McpTaskContact, McpTaskGeneration, McpToolCall, McpToolCallEnd, McpToolCallError,
};
use crate::command_receipts::CommandOutcome;

#[cfg(test)]
mod tests;

/// Follows `call`'s task, accepted under the handle's generation and id, on from `end`, the end
/// its follow on `following`'s connection reached: while that end is the close of a connection
/// to a server at an address, it waits for the connection that replaces it, sets `following` to
/// it and resumes the follow there. Comes to the race the last follow's end, or the wait's, gives.
pub(super) async fn follow_across_reconnects(
    standing: &McpStandingConnection,
    call: &McpToolCall,
    (generation, mcp_task_id): (McpTaskGeneration, String),
    mut end: Result<McpToolCallEnd, McpToolCallError>,
    following: &Mutex<Arc<McpServerConnection>>,
    contact: &watch::Sender<McpTaskContact>,
    cancellation: &CancellationToken,
) -> CallRace {
    loop {
        let closed = Arc::clone(&lock(following));
        if !matches!(end, Ok(McpToolCallEnd::ConnectionClosed)) || !closed.endpoint.is_address() {
            return CallRace::Ended(end);
        }
        let replacement = match wait_for_replacement(
            standing,
            &closed,
            call,
            &mcp_task_id,
            contact,
            cancellation,
        )
        .await
        {
            Ok(replacement) => replacement,
            Err(race) => return race,
        };
        *lock(following) = Arc::clone(&replacement);
        // Boxed, so the resumed follow's future is held only once a task is re-bound.
        end = Ok(Box::pin(replacement.resume_task(
            standing,
            call.clone(),
            generation,
            &mcp_task_id,
            contact,
        ))
        .await);
    }
}

/// Waits for the connection that replaces `closed` at its endpoint, `contact` reading meanwhile
/// why none is live and, once one is, the arm it held before. The task `mcp_task_id`'s watch is
/// held meanwhile, so a wait dropped with its dispatch withdraws the task's questions; it is left
/// for the follow on the replacement to adopt, or dropped when the wait ends otherwise: with the
/// end unknown, which the dispatch writes, at the session's close or the caller's cancel, and
/// with nothing written at the client's stop.
async fn wait_for_replacement(
    standing: &McpStandingConnection,
    closed: &Arc<McpServerConnection>,
    call: &McpToolCall,
    mcp_task_id: &str,
    contact: &watch::Sender<McpTaskContact>,
    cancellation: &CancellationToken,
) -> Result<Arc<McpServerConnection>, CallRace> {
    let task_watch = closed
        .scope
        .task_watches
        .watch(&closed.scope, call, mcp_task_id);
    let held = *contact.borrow();
    let absence = match standing.live(&closed.endpoint) {
        Ok(_live) => None,
        Err(McpConnectionAbsence::NotConfigured) => Some(McpTaskContact::NotConfigured),
        Err(McpConnectionAbsence::Reconfigured) => Some(McpTaskContact::Reconfigured),
    };
    if let Some(absence) = absence {
        contact.send_modify(|state| *state = absence);
    }
    // The replacement's wait reads the client's stop first, then the session's close, so a stop
    // that also cancels writes nothing.
    let replaced = tokio::select! {
        biased;
        replaced = standing.replacement(closed, &closed.endpoint) => Some(replaced),
        () = cancellation.cancelled() => None,
    };
    let ended = match replaced {
        Some(McpReplacement::Replaced(replacement)) => {
            task_watch.leave();
            if absence.is_some() {
                contact.send_modify(|state| *state = held);
            }
            return Ok(replacement);
        }
        Some(McpReplacement::SessionClosed) | None => CallRace::Settled(
            Ok(McpToolCallEnd::ConnectionClosed),
            CommandOutcome::Unknown,
        ),
        Some(McpReplacement::ClientStopping) => CallRace::ClientStopping,
    };
    // Dropped rather than finished, so its questions are withdrawn in a task of their own and the
    // wait's end reaches the race in the same poll as the mark that ended it, before the race
    // reads that mark itself.
    drop(task_watch);
    Err(ended)
}
