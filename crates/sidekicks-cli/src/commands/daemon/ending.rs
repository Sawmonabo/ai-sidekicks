//! The one ending of the running background service that `daemon stop`, `restart` and `uninstall`
//! share: the client's ending, which a Ctrl-C cuts short, its failure carrying the client's error
//! in its chain so the exit code and the repair's line read it.

use anyhow::Context as _;
use sidekicks_client::daemon_connection::DaemonEndpoint;
use sidekicks_client::daemon_ending::{DaemonEnd, DaemonEndingTerms, DaemonEndingVerb, end_daemon};
use sidekicks_client::error::ClientError;
use sidekicks_platforms::CtrlCListener;

/// Ends this machine's background service with `verb` through the client's ending, and answers
/// which end took effect. Fails with `ClientError::Canceled` after a Ctrl-C, and as the ending
/// does, under the context `doing`, a failed call's `ClientError` kept in the chain.
pub(crate) async fn end_running_daemon(
    verb: DaemonEndingVerb,
    doing: &'static str,
    ctrl_c: &mut CtrlCListener,
) -> anyhow::Result<DaemonEnd> {
    let endpoint = DaemonEndpoint::this_machine()
        .context("could not find where the background service listens")?;
    let terms = DaemonEndingTerms::default();
    let ended = tokio::select! {
        ended = end_daemon(endpoint, verb, &terms) => ended,
        _ = ctrl_c.recv() => return Err(ClientError::Canceled.into()),
    };
    ended.context(doing)
}
