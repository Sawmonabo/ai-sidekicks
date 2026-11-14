//! A task's follow across its server's Reconnects and the daemon's restart. A follow on a server
//! at an address that its connection's close cut waits for the connection a Reconnect publishes in
//! its place, and goes on there through `resume_task`, adopting the task's watch with its open and
//! kept questions and its asked keys; a stdio server's task died with its process, so its end
//! stays unknown.
//!
//! - While it waits, the contact reads why no connection of the task's endpoint is live, read
//!   again at each publication: none is (`NotConfigured`), or the live one reaches another address
//!   (`Reconfigured`). While the connection that ended is still the one published, as when its
//!   transport ended on its own, nothing reaches the server, so 300 s after the task's last
//!   answered poll, or after the wait's start when none was answered, the contact reads what a
//!   failed poll then reads: a sign-in not accepted, errors that persisted, or `Lost`. The re-bind
//!   writes back the arm the contact held before.
//! - The wait never times out. The session's close ends it with the end unknown, which the
//!   dispatch writes; the caller's cancel ends it unknown for the caller to write, as a live end,
//!   so a backgrounded call's hand-off stays owed; the client's stop ends it writing nothing. A
//!   wait that ends without a re-bind ends the task's watch, which withdraws its questions.
//! - After a restart, a receipt in flight is resumed through the dispatch's own race. The start
//!   withdrew every question the client had asked, so nothing is withdrawn here: a plain call's
//!   end and a stdio server's task read unknown at once, a 2026-07-28 task asks each input anew,
//!   and a 2025-11-25 task found waiting on input is canceled before anything is held.

use std::sync::{Arc, Mutex};

use sidekicks_contracts::run::id::RunId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::client::connection::McpServerConnection;
use crate::client::connection::standing::{
    McpConnectionAbsence, McpReplacement, McpStandingConnection,
};
use crate::client::dispatch::{
    CallHandleSink, CallRace, McpDispatchedCall, McpToolDispatch, McpToolDispatchError, race_call,
};
use crate::client::poll::{CONTACT_LOST_AFTER, cause_at_contact_lost};
use crate::client::tasks::{
    McpServerEndpoint, McpTaskContact, McpTaskGeneration, McpTaskResumption, McpToolCallEnd,
    McpToolCallError,
};
use crate::command_receipts::{CommandOutcome, InFlightReceipt};

#[cfg(test)]
mod tests;

impl McpToolDispatch {
    /// Resumes `receipt`, which the daemon's restart left in flight, over `standing`, with the
    /// marks and the race of [`Self::call`]: a plain call's end, or a stdio server's task's, reads
    /// unknown at once, nothing sent. A task at an address waits for a live connection of its
    /// endpoint, `contact` reading why none is, and is followed there from a fresh poll; a
    /// 2025-11-25 task its first answered poll reads waiting on input is canceled first, its end
    /// then lost, and a refusal reads `CancelRefused` that no stop asked for. A canceled
    /// `cancellation`, a stop asked for before the restart, cancels the task as the caller's
    /// cancel does. Fails with `ClientStopping`, writing nothing, while the client stops.
    pub(crate) async fn resume(
        &self,
        standing: &McpStandingConnection,
        receipt: InFlightReceipt,
        contact: &watch::Sender<McpTaskContact>,
        cancellation: &CancellationToken,
    ) -> Result<McpDispatchedCall, McpToolDispatchError> {
        // Taken before the marks are read, so a close that marks after the read waits for it.
        let _tracked = standing.track();
        if standing.is_stopping() {
            return Err(McpToolDispatchError::ClientStopping);
        }
        // A plain call's server keeps nothing to resume, and a stdio server's task died with its
        // process.
        let Some(task) = receipt.task.filter(|task| task.endpoint.is_address()) else {
            let race = CallRace::Ended(Ok(McpToolCallEnd::ConnectionClosed));
            return self.end_dispatch(standing, receipt.id, race).await;
        };
        let connection = if let Ok(live) = standing.live(&task.endpoint) {
            live
        } else {
            let waited =
                wait_for_connection(standing, None, None, &task.endpoint, contact, cancellation);
            match waited.await {
                Ok(joined) => joined,
                Err(race) => return self.end_dispatch(standing, receipt.id, race).await,
            }
        };
        let (run_id, generation) = (receipt.run_id, task.mcp_task_generation);
        let sink = CallHandleSink {
            recorder: &self.recorder,
            handle: Mutex::new(Some((generation, task.mcp_task_id.clone()))),
        };
        let following = Mutex::new(Arc::clone(&connection));
        let ending = async {
            // Boxed, so the follow's future is held only once a task is resumed.
            let end = Box::pin(connection.resume_task(
                standing,
                run_id,
                generation,
                &task.mcp_task_id,
                McpTaskResumption::AfterRestart,
                contact,
            ))
            .await;
            follow_across_reconnects(
                standing,
                run_id,
                (generation, task.mcp_task_id.clone()),
                Ok(end),
                &following,
                contact,
                cancellation,
            )
            .await
        };
        // Boxed, so the race, which holds the follow, is kept off the caller's future.
        let race = Box::pin(race_call(
            standing,
            &sink,
            &following,
            ending,
            contact,
            cancellation,
        ))
        .await;
        self.end_dispatch(standing, receipt.id, race).await
    }
}

/// Follows run `run_id`'s task, accepted under the handle's generation and id, on from `end`, the
/// end its follow on `following`'s connection reached: while that end is the close of a
/// connection to a server at an address, it waits for the connection that replaces it, sets
/// `following` to it and resumes the follow there. Comes to the race the last follow's end, or the
/// wait's, gives.
pub(super) async fn follow_across_reconnects(
    standing: &McpStandingConnection,
    run_id: RunId,
    (generation, mcp_task_id): (McpTaskGeneration, String),
    mut end: Result<McpToolCallEnd, McpToolCallError>,
    following: &Mutex<Arc<McpServerConnection>>,
    contact: &watch::Sender<McpTaskContact>,
    cancellation: &CancellationToken,
) -> CallRace {
    loop {
        let closed = Arc::clone(&lock(following));
        if !matches!(end, Ok(McpToolCallEnd::ConnectionClosed))
            || !closed.task_endpoint().is_address()
        {
            return CallRace::Ended(end);
        }
        let replacement = match wait_for_replacement(
            standing,
            &closed,
            run_id,
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
            run_id,
            generation,
            &mcp_task_id,
            McpTaskResumption::AfterReconnect,
            contact,
        ))
        .await);
    }
}

/// Waits for the connection that replaces `closed` at its endpoint, as [`wait_for_connection`]
/// does. The task `mcp_task_id`'s watch is held meanwhile, so a wait dropped with its dispatch
/// withdraws the task's questions; it is left for the follow on the replacement to adopt, or
/// dropped when the wait ends otherwise.
async fn wait_for_replacement(
    standing: &McpStandingConnection,
    closed: &Arc<McpServerConnection>,
    run_id: RunId,
    mcp_task_id: &str,
    contact: &watch::Sender<McpTaskContact>,
    cancellation: &CancellationToken,
) -> Result<Arc<McpServerConnection>, CallRace> {
    let task_watch = closed
        .scope
        .task_watches
        .watch(&closed.scope, run_id, mcp_task_id, contact);
    let replacement = wait_for_connection(
        standing,
        Some(closed),
        task_watch.contact.answered_at(),
        closed.task_endpoint(),
        contact,
        cancellation,
    )
    .await;
    if replacement.is_ok() {
        task_watch.leave();
    } else {
        // Dropped rather than finished, so its questions are withdrawn in a task of their own and
        // the wait's end reaches the race in the same poll as the mark that ended it, before the
        // race reads that mark itself.
        drop(task_watch);
    }
    replacement
}

/// Waits for a live connection other than `after` that reaches `endpoint`, `contact` reading
/// meanwhile why none is, read again at each publication, the arm the cause it held picks once
/// 300 s pass from `answered_at`, the task's last answered poll, or from the wait's start when no
/// poll was answered, while `after` is still the one published, and, once one is, the arm it held
/// before. A wait that ends otherwise gives the race its end unknown: written by the dispatch at
/// the session's close and by the caller at its cancel, and nothing written at the client's stop.
async fn wait_for_connection(
    standing: &McpStandingConnection,
    after: Option<&Arc<McpServerConnection>>,
    answered_at: Option<Instant>,
    endpoint: &McpServerEndpoint,
    contact: &watch::Sender<McpTaskContact>,
    cancellation: &CancellationToken,
) -> Result<Arc<McpServerConnection>, CallRace> {
    let held = *contact.borrow();
    let lost_at = answered_at.unwrap_or_else(Instant::now) + CONTACT_LOST_AFTER;
    let show_absence = |absence: Option<McpConnectionAbsence>| {
        let arm = match absence {
            Some(McpConnectionAbsence::NotConfigured) => McpTaskContact::NotConfigured,
            Some(McpConnectionAbsence::Reconfigured) => McpTaskContact::Reconfigured,
            // The connection that ended is still published, so nothing reaches the server; the
            // cause the contact held picks the arm, as a follow's own failed poll does.
            None if Instant::now() >= lost_at => cause_at_contact_lost(held),
            None => held,
        };
        contact.send_if_modified(|state| {
            let is_new = *state != arm;
            *state = arm;
            is_new
        });
    };
    let mut is_lost_due = false;
    // The replacement's wait reads the client's stop first, then the session's close, so a stop
    // that also cancels writes nothing. Lost's clock coming due starts the wait again, which reads
    // the absence anew.
    let replaced = loop {
        tokio::select! {
            biased;
            replaced = standing.replacement(after, endpoint, &show_absence) => break Some(replaced),
            () = cancellation.cancelled() => break None,
            () = tokio::time::sleep_until(lost_at), if !is_lost_due => is_lost_due = true,
        }
    };
    match replaced {
        Some(McpReplacement::Replaced(replacement)) => {
            let is_absence_shown = matches!(
                *contact.borrow(),
                McpTaskContact::NotConfigured | McpTaskContact::Reconfigured
            );
            if is_absence_shown {
                contact.send_modify(|state| *state = held);
            }
            Ok(replacement)
        }
        Some(McpReplacement::SessionClosed) => Err(CallRace::Settled(
            Ok(McpToolCallEnd::ConnectionClosed),
            CommandOutcome::Unknown,
        )),
        None => Err(CallRace::Ended(Ok(McpToolCallEnd::ConnectionClosed))),
        Some(McpReplacement::ClientStopping) => Err(CallRace::ClientStopping),
    }
}
