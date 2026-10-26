//! The drains of the lasting Codex services another holds the home's link in place of, one per
//! record across every service of a driver: Codex is asked once to drain, its own graceful end,
//! and the record is marked draining only once the ask was delivered, so no start joins it, points
//! the link at it or asks it again; one task then waits for its end with no bound and no thread
//! while it finishes its running replies, tells every start and stop waiting on it, ends what it
//! left and removes its record. The daemon's stop calls every wait off and leaves the marked
//! records for its next start, which waits on them again.

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use sidekicks_platforms::ProcessRecord;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::mutex_lock::lock;
use crate::provider::driver::codex::service::process::{
    LastingCodexService, codex_lasting_service_environment_entry,
};
use crate::provider::driver::codex::service::record::{
    LastingServiceRecordFile, LockedServiceRecord,
};
use crate::provider::driver::codex::service::supervisor::runner::report_stop_failed;
use crate::provider::driver::codex::service::supervisor::start::kept_records::on_record;

/// How a drain ended, as its one waiting task tells it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LastingServiceDrainEnd {
    /// The service ended by itself.
    Ended,
    /// The daemon's stop called the wait off; the service drains on by itself.
    CalledOff,
    /// The wait failed, which was reported.
    Failed,
}

/// The end of one drain as it comes: `None` while the service still drains.
pub(crate) type LastingServiceDrainWatch = watch::Receiver<Option<LastingServiceDrainEnd>>;

// The drains under way, by the file of each drained service's record.
type DrainsUnderWay = Arc<Mutex<HashMap<LastingServiceRecordFile, LastingServiceDrainWatch>>>;

/// The drains under way of one driver's lasting services, one per record file, and the one call-off
/// the registry's shutdown makes.
#[derive(Default)]
pub(crate) struct LastingServiceDrains {
    under_way: DrainsUnderWay,
    call_off: CancellationToken,
}

impl LastingServiceDrains {
    /// Calls off the wait of every drain, those begun later included: each service drains on by
    /// itself, and its marked record stays for the next daemon's start.
    pub(crate) fn call_off(&self) {
        self.call_off.cancel();
    }

    /// Drains `lasting`, whose record `locked` holds under the folder's lock the caller holds, and
    /// answers the watch of its end: one already under way for the record is shared and nothing
    /// is sent; a record marked draining, asked by a former start, is only waited on; otherwise
    /// the service is asked once, over `control_socket` where it takes no signal, and its record
    /// marked once the ask was delivered. Fails as the ask or the mark does, the record then left
    /// unmarked or unasked.
    pub(super) async fn drain(
        &self,
        locked: &Arc<LockedServiceRecord>,
        lasting: LastingCodexService,
        control_socket: &Path,
    ) -> io::Result<LastingServiceDrainWatch> {
        if let Some(end) = self.lock().get(locked.file()) {
            return Ok(end.clone());
        }
        let process = lasting.record().clone();
        let is_marked = on_record(locked, LockedServiceRecord::read)
            .await?
            .is_some_and(|kept| kept.process == process && kept.is_draining);
        if !is_marked && lasting.ask_to_drain(control_socket).await? {
            on_record(locked, move |locked| mark_draining(locked, &process)).await?;
        }
        let (told, end) = watch::channel(None);
        let record_file = locked.file().clone();
        self.lock().insert(record_file.clone(), end.clone());
        tokio::spawn(wait_for_drained_end(
            lasting,
            record_file,
            told,
            Arc::clone(&self.under_way),
            self.call_off.clone(),
        ));
        Ok(end)
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<LastingServiceRecordFile, LastingServiceDrainWatch>> {
        lock(&self.under_way)
    }
}

/// Drains `lasting`, whose record `record_file` keeps, as a replaced service's stop, its control
/// socket at `control_socket`: the drain begun under the folder's lock, then its end awaited with
/// the lock let go of. Answers whether the service ended; a failure is reported.
pub(super) async fn drain_lasting_service(
    drains: &LastingServiceDrains,
    lasting: LastingCodexService,
    record_file: LastingServiceRecordFile,
    control_socket: &Path,
) -> bool {
    let begun = async {
        let locked = tokio::task::spawn_blocking(move || record_file.lock())
            .await
            .map_err(io::Error::other)??;
        drains
            .drain(&Arc::new(locked), lasting, control_socket)
            .await
    };
    match begun.await {
        Ok(end) => read_drain_end(end).await == Some(LastingServiceDrainEnd::Ended),
        Err(error) => {
            report_stop_failed(error);
            false
        }
    }
}

/// How the drain `end` watches ended, once it has; `None` for a drain whose task ended without
/// telling, which never happens short of a panic.
pub(super) async fn read_drain_end(
    mut end: LastingServiceDrainWatch,
) -> Option<LastingServiceDrainEnd> {
    end.wait_for(Option::is_some)
        .await
        .ok()
        .and_then(|end| *end)
}

// Marks the record `locked` holds draining while it names `process`. Blocking.
fn mark_draining(locked: &LockedServiceRecord, process: &ProcessRecord) -> io::Result<()> {
    if let Some(mut kept) = locked.read()?
        && kept.process == *process
        && !kept.is_draining
    {
        kept.is_draining = true;
        locked.write(&kept)?;
    }
    Ok(())
}

// The one wait of a drain: until the service ends or the daemon's stop calls it off; tells the
// end first, since a start waiting on it holds the folder's lock the removal takes, then ends what
// the ended service left and removes its record from `record_file` while it still names it.
async fn wait_for_drained_end(
    lasting: LastingCodexService,
    record_file: LastingServiceRecordFile,
    told: watch::Sender<Option<LastingServiceDrainEnd>>,
    under_way: DrainsUnderWay,
    call_off: CancellationToken,
) {
    let end = tokio::select! {
        biased;
        () = call_off.cancelled() => LastingServiceDrainEnd::CalledOff,
        waited = lasting.wait_for_end() => match waited {
            Ok(()) => LastingServiceDrainEnd::Ended,
            Err(error) => {
                report_stop_failed(error);
                LastingServiceDrainEnd::Failed
            }
        },
    };
    told.send_replace(Some(end));
    if end == LastingServiceDrainEnd::Ended {
        let ended = lasting.record().clone();
        let retiring = record_file.clone();
        let retired =
            tokio::task::spawn_blocking(move || retire_drained_service(&ended, &retiring))
                .await
                .map_err(io::Error::other)
                .and_then(|retired| retired);
        if let Err(error) = retired {
            report_stop_failed(error);
        }
    }
    lock(&under_way).remove(&record_file);
}

// Ends what the drained service `ended` left running, then removes its record from `record_file`
// while the record still names it. Blocking. Fails as the removal does; a failed end of what it
// left is logged.
fn retire_drained_service(
    ended: &ProcessRecord,
    record_file: &LastingServiceRecordFile,
) -> io::Result<()> {
    if let Err(error) = ended.end_survivors(&codex_lasting_service_environment_entry()) {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "what a drained Codex service left running could not be ended"
        );
    }
    record_file.remove_if_naming(ended)
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::{Child, Command, Stdio};
    use std::sync::Arc;

    use sidekicks_platforms::{CAN_SIGNAL_A_STOP, pin_child_process};

    use super::LastingServiceDrains;
    use crate::provider::driver::codex::service::process::{
        LastingCodexService, repin_lasting_codex_service,
    };
    use crate::provider::driver::codex::service::record::{
        LastingServiceRecord, LastingServiceRecordFile, LockedServiceRecord,
    };

    // A shell standing in for a lasting service that keeps running past a hang-up, its record kept
    // in `folder` under the held lock answered with it.
    fn start_recorded_shell(
        folder: &Path,
    ) -> (Child, Arc<LockedServiceRecord>, LastingCodexService) {
        let child = Command::new("/bin/sh")
            .args(["-c", "trap '' HUP; read never"])
            .stdin(Stdio::piped())
            .spawn()
            .expect("the shell starts");
        let process = pin_child_process(child.id())
            .expect("the shell pins")
            .record()
            .expect("the record reads")
            .expect("the shell runs");
        let record_file =
            LastingServiceRecordFile::of_socket(folder, folder, &folder.join("codex.sock"))
                .expect("the record file is named");
        let locked = Arc::new(record_file.lock().expect("the records lock"));
        locked
            .write(&LastingServiceRecord::launched(process.clone()))
            .expect("the record is kept");
        let lasting = repin_lasting_codex_service(process)
            .expect("the process table reads")
            .expect("the shell runs");
        (child, locked, lasting)
    }

    // Fails when a second drain of a record already draining waits on its own, which each start
    // meeting the record would add again, each ending what the service left and removing its
    // record.
    #[tokio::test]
    async fn two_drains_of_one_record_share_one_wait() {
        if !CAN_SIGNAL_A_STOP {
            return;
        }
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let (mut child, locked, lasting) = start_recorded_shell(folder.path());
        let again = repin_lasting_codex_service(lasting.record().clone())
            .expect("the process table reads")
            .expect("the shell runs");
        let drains = LastingServiceDrains::default();

        let first = drains
            .drain(&locked, lasting, folder.path())
            .await
            .expect("the first drain begins");
        let second = drains
            .drain(&locked, again, folder.path())
            .await
            .expect("the second drain begins");
        let is_marked = locked
            .read()
            .expect("the record reads")
            .is_some_and(|kept| kept.is_draining);
        drains.call_off();
        child.kill().expect("the test ends its own child");
        child.wait().expect("the shell is reaped");

        assert!(first.same_channel(&second), "a second wait began");
        assert!(is_marked);
    }

    // Fails when the record is marked draining before the ask is delivered, here to a service
    // already gone, which leaves a service no one asked marked, so no later start asks it, joins
    // it or points the home's link at it.
    #[tokio::test]
    async fn a_drain_whose_ask_was_not_delivered_leaves_the_record_unmarked() {
        if !CAN_SIGNAL_A_STOP {
            return;
        }
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let (mut child, locked, lasting) = start_recorded_shell(folder.path());
        child.kill().expect("the test ends its own child");
        child.wait().expect("the shell is reaped");
        let drains = LastingServiceDrains::default();

        let drained = drains.drain(&locked, lasting, folder.path()).await;
        // The removal after the end waits for the lock the test still holds.
        let kept = locked.read().expect("the record reads");
        drop(locked);

        assert!(drained.is_ok(), "{:?}", drained.err());
        assert!(
            kept.is_some_and(|kept| !kept.is_draining),
            "the record was marked though the ask was never delivered"
        );
    }
}
