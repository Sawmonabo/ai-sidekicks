//! The wait for a daemon that is starting: the handshake is tried again after a pause that starts
//! at 50 ms and doubles to at most 1,000 ms, until it is answered or a deadline passes, so a daemon
//! still binding its socket or writing its token is waited for with about 14 connects in 10 s. A
//! daemon repairing its database file is alive and busy, so each of its answers moves the deadline
//! on; the caller's own future, such as a started child's exit, ends the wait first.

use std::future::Future;
use std::io;
use std::pin::pin;
use std::time::Duration;

use sidekicks_contracts::daemon::recovery::DaemonRepairingDetails;
use sidekicks_contracts::jsonrpc::message::ConnectionUnavailableReason;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use tokio::time::{Instant, sleep};

use super::{DaemonConnection, DaemonConnector};
use crate::error::{ClientError, LinkFault};

/// The first pause between handshakes.
const FIRST_PAUSE: Duration = Duration::from_millis(50);

/// The longest pause between handshakes.
const LONGEST_PAUSE: Duration = Duration::from_secs(1);

/// How the wait for a starting daemon ended without failing.
pub enum HandshakeWaitEnd<T> {
    /// The daemon answered the handshake.
    Connected(DaemonConnection),
    /// The caller's future finished first, with its output.
    Ended(T),
}

/// Connects through `connector` again and again until the daemon answers the handshake, while
/// `deadline` has not passed since the wait began or since the daemon's latest `daemon.repairing`
/// answer (`HANDSHAKE_DEADLINE` where the caller sets none); hands each such answer's details to `on_repairing` once, and ends as soon as
/// `ended_early` finishes. Fails at the deadline with the last attempt's failure, or with
/// `ClientError::Unavailable` when no attempt finished; fails at once on a failure no starting
/// daemon gives, such as a run folder that is not this account's alone.
pub async fn wait_for_handshake<C, F>(
    connector: C,
    deadline: Duration,
    mut on_repairing: impl FnMut(DaemonRepairingDetails),
    ended_early: F,
) -> Result<HandshakeWaitEnd<F::Output>, ClientError>
where
    C: DaemonConnector + Clone,
    F: Future,
{
    let mut ended_early = pin!(ended_early);
    let mut gives_up = pin!(sleep(deadline));
    let mut pause = FIRST_PAUSE;
    let mut last_failure = None;
    loop {
        let failure = tokio::select! {
            outcome = DaemonConnection::connect(connector.clone()) => match outcome {
                Ok(connection) => return Ok(HandshakeWaitEnd::Connected(connection)),
                Err(failure) => failure,
            },
            output = &mut ended_early => return Ok(HandshakeWaitEnd::Ended(output)),
            () = &mut gives_up => return Err(last_failure.unwrap_or_else(unanswered)),
        };
        if let ClientError::Remote(refusal) = &failure
            && let Some(details) = refusal.repairing_details()
        {
            gives_up.as_mut().reset(Instant::now() + deadline);
            on_repairing(details);
        } else if !is_not_ready_yet(&failure) {
            return Err(failure);
        }
        tokio::select! {
            () = sleep(pause) => {}
            output = &mut ended_early => return Ok(HandshakeWaitEnd::Ended(output)),
            () = &mut gives_up => return Err(failure),
        }
        last_failure = Some(failure);
        pause = (pause * 2).min(LONGEST_PAUSE);
    }
}

/// Whether `failure` is one a daemon still starting gives: no socket yet, a handshake unanswered,
/// a token not yet written, or a token refused while the daemon writes its new one.
fn is_not_ready_yet(failure: &ClientError) -> bool {
    match failure {
        ClientError::Unavailable { .. } => true,
        ClientError::Token { source, .. } => source.kind() == io::ErrorKind::NotFound,
        ClientError::Remote(refusal) => refusal.is_refusal(RefusalCode::AuthTokenInvalid),
        ClientError::Reply { .. }
        | ClientError::Request { .. }
        | ClientError::Canceled
        | ClientError::RunFolder(_) => false,
    }
}

/// The failure of a wait whose deadline passed before any attempt finished.
fn unanswered() -> ClientError {
    ClientError::Unavailable {
        reason: ConnectionUnavailableReason::Unreachable,
        cause: LinkFault::Silent,
    }
}
