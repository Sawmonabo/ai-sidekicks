//! The drain of a lasting Codex service another holds the home's link in place of: its record
//! marked draining under the Codex folder's lock as Codex's own hang-up is sent, so no start joins
//! it or points the link at it, then a wait for its end with no bound while it finishes its running
//! replies, after which what it left is ended and its record removed. A daemon that stops calls the
//! wait off and leaves the marked record for its next start, which asks again.

use std::io;
use std::sync::Arc;

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::provider::driver::codex::service::process::{LastingCodexService, LastingServiceDrain};
use crate::provider::driver::codex::service::record::{
    LastingServiceRecordFile, LockedServiceRecord,
};
use crate::provider::driver::codex::service::supervisor::runner::report_stop_failed;

/// Marks the record `locked` holds draining while it names `lasting`, then asks the service to
/// drain, both under the folder's lock the caller holds. Blocking. Fails as the record's read or
/// write does, or the hang-up.
pub(super) fn hang_up_recorded_service(
    locked: &LockedServiceRecord,
    lasting: &LastingCodexService,
) -> io::Result<LastingServiceDrain> {
    if let Some(mut kept) = locked.read()?
        && kept.process == *lasting.record()
        && !kept.is_draining
    {
        kept.is_draining = true;
        locked.write(&kept)?;
    }
    lasting.hang_up()
}

/// Drains `lasting`, whose record `record_file` keeps, as its stop: its record marked and the
/// hang-up sent under the folder's lock, then [`finish_drain`] with no one told of the end.
/// Answers whether it ended; a failure is reported.
pub(super) async fn drain_lasting_service(
    drains: &CancellationToken,
    lasting: LastingCodexService,
    record_file: LastingServiceRecordFile,
) -> bool {
    let marking = record_file.clone();
    let hung_up = tokio::task::spawn_blocking(move || {
        let locked = marking.lock()?;
        hang_up_recorded_service(&locked, &lasting)
    })
    .await
    .map_err(io::Error::other)
    .and_then(|hung_up| hung_up);
    match hung_up {
        Ok(drain) => finish_drain(drains, drain, record_file, None).await,
        Err(error) => {
            report_stop_failed(error);
            false
        }
    }
}

/// Asks `lasting`, whose record `locked` holds under the start's own hold, to drain, and runs the
/// drain to its end in a task of its own; the receiver answers once the service ended, before the
/// record's removal waits for the folder's lock the start holds. Fails as the hang-up does.
pub(super) async fn drain_in_background(
    drains: &CancellationToken,
    locked: &Arc<LockedServiceRecord>,
    lasting: LastingCodexService,
) -> io::Result<oneshot::Receiver<()>> {
    let held = Arc::clone(locked);
    let drain = tokio::task::spawn_blocking(move || hang_up_recorded_service(&held, &lasting))
        .await
        .map_err(io::Error::other)??;
    let (ended, end) = oneshot::channel();
    let record_file = locked.file().clone();
    let drains = drains.clone();
    tokio::spawn(async move { finish_drain(&drains, drain, record_file, Some(ended)).await });
    Ok(end)
}

/// Waits for a drained service's end until `drains` is called off; once it ended, tells `ended`,
/// then ends what it left and removes its record from `record_file` while it still names it.
/// Answers whether it ended; a failure is reported.
async fn finish_drain(
    drains: &CancellationToken,
    drain: LastingServiceDrain,
    record_file: LastingServiceRecordFile,
    ended: Option<oneshot::Sender<()>>,
) -> bool {
    match drain.wait_for_end(drains).await {
        Ok(true) => {
            if let Some(ended) = ended {
                // A start that stopped waiting no longer reads the end.
                let _told = ended.send(());
            }
            if let Err(error) = drain.retire(record_file).await {
                report_stop_failed(error);
            }
            true
        }
        Ok(false) => false,
        Err(error) => {
            report_stop_failed(error);
            false
        }
    }
}
