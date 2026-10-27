//! A session's close cancels the asks it left open: a follower of every session hands each
//! committed close to one task, which cancels the session's pending asks, and a start cancels those
//! of sessions that closed with an ask still pending. No run is moved, since every provider leg of
//! a session ended before its close.

use std::error::Error;
use std::sync::Arc;

use sidekicks_contracts::event::registry::SessionEventType;
use tokio::task::{JoinError, JoinHandle};
use tokio_util::sync::CancellationToken;

use super::{ApprovalService, RaisedCardKey, RaisedRequestSettlement};
use sidekicks_std::keyed_wait::KeyedWaits;
use sidekicks_store::events::session::followers::{FollowerAttachment, SessionEventFollowers};

/// The task that cancels closed sessions' asks and its follower of closes, from
/// [`ApprovalService::start`] until [`ApprovalSweep::stop`].
pub(crate) struct ApprovalSweep {
    /// Hears every committed close; dropping it detaches.
    attachment: FollowerAttachment,
    /// Ends the task after the cancels under way.
    stop: CancellationToken,
    /// The task that cancels the asks.
    task: JoinHandle<()>,
    /// Whoever still waits on a raised card, told of the stop.
    raised_cards: KeyedWaits<RaisedCardKey, RaisedRequestSettlement>,
}

impl ApprovalSweep {
    /// Stops hearing closes, settles once the cancels under way are done, then settles every wait
    /// on a raised card still open as stopped. Fails only when the task itself ended abnormally.
    pub(crate) async fn stop(self) -> Result<(), JoinError> {
        let Self {
            attachment,
            stop,
            task,
            raised_cards,
        } = self;
        drop(attachment);
        stop.cancel();
        let ended = task.await;
        raised_cards.settle_where(|_key| true, RaisedRequestSettlement::Stopped);
        ended
    }
}

impl ApprovalService {
    /// Follows `followers` to cancel the pending asks of every session that closes, and cancels
    /// those of sessions that closed with an ask still pending, both until the returned handle's
    /// stop.
    pub(crate) fn start(self: &Arc<Self>, followers: &Arc<SessionEventFollowers>) -> ApprovalSweep {
        let service = Arc::clone(self);
        // Runs on the writer's pump, so it only names the session for the task.
        let attachment = followers.follow_all(move |event| {
            if event.envelope.event_type() == SessionEventType::SessionClosed {
                service.closed_sessions.add(event.envelope.session_id());
            }
            Ok(())
        });
        let stop = CancellationToken::new();
        let task = tokio::spawn(cancel_closed_sessions_until_stopped(
            Arc::clone(self),
            stop.clone(),
        ));
        ApprovalSweep {
            attachment,
            stop,
            task,
            raised_cards: self.raised_cards.clone(),
        }
    }
}

// No caller waits on a sweep, so a failed one is logged; the next start's sweep cancels the
// session's asks still pending. A stop lets the batch under way finish.
async fn cancel_closed_sessions_until_stopped(
    service: Arc<ApprovalService>,
    stop: CancellationToken,
) {
    #[expect(
        clippy::redundant_closure_for_method_calls,
        reason = "the method named alone is not general over the reader's lifetime"
    )]
    let ended = service
        .read(|reader| reader.list_ended_sessions_with_pending())
        .await;
    match ended {
        Ok(ended) => {
            for session_id in ended {
                service.closed_sessions.add(session_id);
            }
        }
        Err(error) => tracing::error!(
            error = &error as &(dyn Error + 'static),
            "approval_session_sweep_failed"
        ),
    }
    loop {
        let closed = tokio::select! {
            biased;
            () = stop.cancelled() => return,
            closed = service.closed_sessions.take() => closed,
        };
        for session_id in closed {
            if let Err(error) = service.cancel_pending_for_session(session_id).await {
                tracing::error!(
                    %session_id,
                    error = &error as &(dyn Error + 'static),
                    "approval_session_cancel_failed"
                );
            }
        }
    }
}
