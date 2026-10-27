//! Waiting on work for a bounded time, so a stop never hangs on work that does not end.

use std::pin::Pin;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

/// Waits on `work` until it finishes, returning its output, or until `bound` passes or `cancel` is
/// canceled first, returning `None`. The work is only borrowed, never canceled: a caller still
/// holds it, or its `JoinHandle`, and may await it again after a `None`.
pub(crate) async fn wait_within<Work: Future>(
    work: Pin<&mut Work>,
    bound: Duration,
    cancel: Option<&CancellationToken>,
) -> Option<Work::Output> {
    let canceled = async {
        match cancel {
            Some(cancel) => cancel.cancelled().await,
            None => std::future::pending().await,
        }
    };
    tokio::select! {
        biased;
        () = canceled => None,
        output = work => Some(output),
        () = tokio::time::sleep(bound) => None,
    }
}
