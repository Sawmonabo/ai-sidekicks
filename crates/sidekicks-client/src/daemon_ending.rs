//! The one ending of the daemon for a stop or a restart, which the command line and the desktop's
//! main process share. It reads the process the daemon runs as and pins it, so no process given its
//! id later is ever signaled; asks the daemon to flush, then sends the stop or the restart and
//! gives the daemon's own drain its whole bound to end the process; only a process still running
//! after that is ended by the system, and one that never answered the request, or speaks a
//! protocol this client cannot, is ended at once with a grace that still covers the drain. A daemon
//! repairing its database file is stopped on the link it refused, and nothing answering is a daemon
//! not running.

use std::io;
use std::pin::pin;
use std::sync::Arc;
use std::time::Duration;

use futures::future::Either;
use serde::Deserialize;
use sidekicks_contracts::daemon::lifecycle::{
    DAEMON_STOP_DRAIN_BOUND_MS, DaemonFlush, DaemonRestart, DaemonStop,
};
use sidekicks_contracts::daemon::status::DaemonStatusRead;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::process_identity::ProcessIdentity;
use sidekicks_platforms::{ChildEnd, PinnedProcess, pin_identified_process};
use tokio::time::{Instant, sleep_until, timeout};
use tokio_util::sync::CancellationToken;

use crate::daemon_connection::{DaemonConnection, DaemonConnector, OpenedConnection};
use crate::error::ClientError;
use crate::transport::json_rpc::{JsonRpcClient, typed_request};
use crate::{DAEMON_FLUSH_WAIT, DAEMON_KILL_GRACE};

/// Ends a pinned process: asks it to stop, then kills it once the grace passes without its exit.
/// Blocking; answers the end that took effect and fails with the system's error.
pub type ProcessEnding =
    Arc<dyn Fn(&PinnedProcess, Duration) -> io::Result<ChildEnd> + Send + Sync>;

/// What the daemon is asked to do before it ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DaemonEndingVerb {
    /// `daemon.stop`.
    Stop,
    /// `daemon.restart`; the caller starts the daemon again once it has ended.
    Restart,
}

/// The bounds the ending waits within and how it ends the daemon's process.
#[derive(Clone)]
pub struct DaemonEndingTerms {
    /// How long the flush may take before the ending goes on without its answer.
    pub flush_wait: Duration,
    /// How long after the stop or restart is sent the daemon's own drain may run.
    pub drain_bound: Duration,
    /// How long a process asked to stop has before it is killed.
    pub kill_grace: Duration,
    /// How the process still running after the drain is ended.
    pub end_process: ProcessEnding,
}

/// The real bounds, and the daemon's process ended alone, the lasting sessions it started spared.
impl Default for DaemonEndingTerms {
    fn default() -> Self {
        Self {
            flush_wait: DAEMON_FLUSH_WAIT,
            drain_bound: Duration::from_millis(DAEMON_STOP_DRAIN_BOUND_MS),
            kill_grace: DAEMON_KILL_GRACE,
            end_process: Arc::new(PinnedProcess::stop_sparing_lasting_sessions),
        }
    }
}

/// Which end took effect, so the caller can say what happened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DaemonEnd {
    /// Nothing answered at the daemon's socket: no daemon was running.
    NotRunning,
    /// A daemon repairing its database file took the stop or restart on the link it refused.
    StoppedWhileRepairing,
    /// The daemon's process ended by itself within the drain bound.
    Exited,
    /// The daemon's process was ended by the system: [`ChildEnd::Stop`] when it ended on the stop
    /// it was asked, [`ChildEnd::Kill`] when the kill ended it.
    Ended(ChildEnd),
    /// The process the daemon named is not running now, so nothing was waited on or ended; a daemon
    /// that speaks this client's protocol took the stop or restart, or closed its link instead.
    ProcessNotFound,
}

/// Why the ending failed.
#[derive(Debug, thiserror::Error)]
pub enum DaemonEndingError {
    /// A call to the daemon failed: the connect, the status read, a stop or restart the daemon
    /// refused while its process could not be followed, or one sent on a repairing link.
    #[error(transparent)]
    Client(#[from] ClientError),
    /// The daemon's status names no process identity this client reads.
    #[error("The background service's status names no process it runs as")]
    Identity(#[source] serde_json::Error),
    /// The daemon's process could not be pinned.
    #[error("The background service's process could not be read")]
    Pin(#[source] io::Error),
    /// The wait for the daemon's process to end failed.
    #[error("The wait for the background service's process to end failed")]
    Wait(#[source] io::Error),
    /// The system could not end the daemon's process.
    #[error("The background service's process could not be ended")]
    End(#[source] io::Error),
    /// The task ending the daemon's process stopped before it answered.
    #[error("The ending of the background service's process stopped")]
    EndTask(#[source] tokio::task::JoinError),
}

/// Ends the daemon `connector` reaches with `verb`, within `terms`; answers which end took
/// effect. Fails as [`DaemonEndingError`] names, a connect that fails other than with nothing
/// answering among them.
pub async fn end_daemon<C: DaemonConnector>(
    connector: C,
    verb: DaemonEndingVerb,
    terms: &DaemonEndingTerms,
) -> Result<DaemonEnd, DaemonEndingError> {
    let connection = match DaemonConnection::connect_or_repairing(connector).await {
        Ok(OpenedConnection::Open(connection)) => connection,
        // The repairing daemon ends on either verb by itself; it has no process to follow here.
        Ok(OpenedConnection::Repairing(repairing)) => {
            match verb {
                DaemonEndingVerb::Stop => repairing.stop().await?,
                DaemonEndingVerb::Restart => repairing.restart().await?,
            }
            return Ok(DaemonEnd::StoppedWhileRepairing);
        }
        Err(ClientError::Unavailable { .. }) => return Ok(DaemonEnd::NotRunning),
        Err(error) => return Err(error.into()),
    };
    let client = connection.client().clone();
    let identity = read_process_identity(&client).await?;
    // Pinned before the flush, so a daemon that ends meanwhile is still followed and a process
    // given its id afterwards is never signaled.
    let process = pin_identified_process(&identity).map_err(DaemonEndingError::Pin)?;
    if !connection.initialize_response().compatible {
        // The daemon refuses every mutating call on this protocol, the flush and the stop among
        // them, so its process is ended as one that never answered.
        connection.close().await;
        let Some(process) = process else {
            return Ok(DaemonEnd::ProcessNotFound);
        };
        return end_unanswered_process(terms, process)
            .await
            .map(DaemonEnd::Ended);
    }

    flush(&client, terms.flush_wait).await;
    let sent_at = Instant::now();
    let answered = {
        let mut answer = pin!(send(&client, verb));
        let mut ended = pin!(async {
            match &process {
                Some(process) => process.wait_for_end().await,
                None => std::future::pending().await,
            }
        });
        let mut drained_at = pin!(sleep_until(sent_at + terms.drain_bound));
        let mut answered = None;
        loop {
            tokio::select! {
                end = &mut ended => {
                    end.map_err(DaemonEndingError::Wait)?;
                    connection.close().await;
                    return Ok(DaemonEnd::Exited);
                }
                reply = &mut answer, if answered.is_none() => {
                    answered = Some(reply);
                    // A process the ending cannot follow is waited on no further than the answer.
                    if process.is_none() {
                        break;
                    }
                }
                () = &mut drained_at => break,
            }
        }
        answered
    };
    connection.close().await;

    let Some(process) = process else {
        return match answered {
            // A link that ended before the answer is the daemon leaving.
            None | Some(Ok(()) | Err(ClientError::Unavailable { .. })) => {
                Ok(DaemonEnd::ProcessNotFound)
            }
            Some(Err(error)) => Err(error.into()),
        };
    };
    // A daemon that took the request had its drain; any other gets the drain's time once more.
    let grace = match answered {
        Some(Ok(())) => terms.kill_grace,
        None | Some(Err(_)) => terms.drain_bound + terms.kill_grace,
    };
    end_process(terms, process, grace)
        .await
        .map(DaemonEnd::Ended)
}

/// The process the daemon runs as, read from its status as that one member alone, so a daemon on a
/// protocol this client cannot speak, whose other members may not read here, still names it.
async fn read_process_identity(
    client: &JsonRpcClient,
) -> Result<ProcessIdentity, DaemonEndingError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StatusProcess {
        process_identity: ProcessIdentity,
    }

    let request = typed_request::<DaemonStatusRead>(&EmptyPayload {})?;
    let reply = client.call_raw(request, &CancellationToken::new()).await?;
    let status = serde_json::from_str::<StatusProcess>(reply.json.get())
        .map_err(DaemonEndingError::Identity)?;
    Ok(status.process_identity)
}

/// Asks the daemon to make every pending write durable, waiting at most `flush_wait`; a flush that
/// fails or takes longer is logged and the ending goes on, since the daemon's drain writes too.
async fn flush(client: &JsonRpcClient, flush_wait: Duration) {
    match timeout(flush_wait, client.call::<DaemonFlush>(&EmptyPayload {})).await {
        Ok(Ok(_flushed)) => {}
        Ok(Err(error)) => tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "The background service's flush before its stop failed"
        ),
        Err(_elapsed) => {
            tracing::warn!("The background service did not flush within the wait before its stop")
        }
    }
}

/// Sends `verb`; settles once the daemon took it.
async fn send(client: &JsonRpcClient, verb: DaemonEndingVerb) -> Result<(), ClientError> {
    let answer = match verb {
        DaemonEndingVerb::Stop => Either::Left(client.call::<DaemonStop>(&EmptyPayload {})),
        DaemonEndingVerb::Restart => Either::Right(client.call::<DaemonRestart>(&EmptyPayload {})),
    };
    answer.await.map(|_accepted| ())
}

/// Ends `process`, a daemon that never answered, through `terms`' ending at once, with a grace that
/// still covers the drain it may be running; answers the end that took effect. Fails as
/// [`DaemonEndingError::End`] and [`DaemonEndingError::EndTask`] name.
pub async fn end_unanswered_process(
    terms: &DaemonEndingTerms,
    process: PinnedProcess,
) -> Result<ChildEnd, DaemonEndingError> {
    end_process(terms, process, terms.drain_bound + terms.kill_grace).await
}

/// Ends `process` with `grace` through `terms`' ending, on the blocking pool.
async fn end_process(
    terms: &DaemonEndingTerms,
    process: PinnedProcess,
    grace: Duration,
) -> Result<ChildEnd, DaemonEndingError> {
    let ending = Arc::clone(&terms.end_process);
    tokio::task::spawn_blocking(move || ending(&process, grace))
        .await
        .map_err(DaemonEndingError::EndTask)?
        .map_err(DaemonEndingError::End)
}
