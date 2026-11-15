//! A kept record that does not read, damaged, cut short or of another shape, never stops a start:
//! its path and the kind of failure are logged, never its text or any value in it, since it holds
//! a live telemetry token; the record is removed; and the service it may still name, where its
//! process reads and still runs, is asked to drain, so the start launches fresh. No value of it is
//! carried into a new record.

use std::error::Error;
use std::io;
use std::path::Path;
use std::sync::Arc;

use crate::driver::codex::service::process::LastingCodexService;
use crate::driver::codex::service::record::{
    LastingServiceRecord, LockedServiceRecord, UnreadableServiceRecord,
};
use crate::driver::codex::service::supervisor::start::StartFailure;
use crate::driver::codex::service::supervisor::start::kept_records::{
    on_record, record_read_failed, remove_record, repin,
};

/// The record `read`, a read of the record `locked` holds, answered: one that does not read is
/// settled, the service it still names asked to drain at once, and answers `None`. A drain that
/// cannot be asked is logged: that service runs on unrecorded. Fails as any other read fails, and
/// as the settle does.
pub(super) async fn settle_record_read(
    locked: &Arc<LockedServiceRecord>,
    read: io::Result<Option<LastingServiceRecord>>,
) -> Result<Option<LastingServiceRecord>, StartFailure> {
    let unreadable = match read {
        Ok(record) => return Ok(record),
        Err(error) if UnreadableServiceRecord::is_cause_of(&error) => error,
        Err(error) => return Err(record_read_failed(error)),
    };
    let Some((lasting, record)) =
        settle_unreadable_record(locked, &unreadable, Path::new("")).await?
    else {
        return Ok(None);
    };
    // A service that never answered names no socket, so where no signal reaches a process its ask
    // has nowhere to go and fails.
    let control_socket = record.physical_socket.unwrap_or(record.home_socket);
    if let Err(error) = lasting.ask_to_drain(&control_socket).await {
        tracing::warn!(
            record = %locked.file().path().display(),
            error = &error as &(dyn Error + 'static),
            "the Codex service a record that does not read names could not be asked to drain; it \
             runs on unrecorded"
        );
    }
    Ok(None)
}

/// Settles the record `locked` holds, which does not read for `unreadable`: logs it by its path
/// and the kind of failure, removes it, and answers the service it still names while that runs,
/// with a record composed of what reads of it, its home socket `home_socket` where that does not
/// read, marked draining, so a start drains it as one and never joins it or points the home's link
/// at it. Fails as the file's read, the process table's read or the removal does.
pub(super) async fn settle_unreadable_record(
    locked: &Arc<LockedServiceRecord>,
    unreadable: &io::Error,
    home_socket: &Path,
) -> Result<Option<(LastingCodexService, LastingServiceRecord)>, StartFailure> {
    tracing::warn!(
        record = %locked.file().path().display(),
        error = unreadable as &(dyn Error + 'static),
        "a kept Codex service record does not read; it is removed and the service it names is \
         asked to drain"
    );
    let remnant = on_record(locked, LockedServiceRecord::read_remnant)
        .await
        .map_err(record_read_failed)?;
    remove_record(locked).await?;
    let Some(process) = remnant.process else {
        return Ok(None);
    };
    let Some(lasting) = repin(process.clone()).await? else {
        return Ok(None);
    };
    let record = LastingServiceRecord {
        process,
        home_socket: remnant
            .home_socket
            .unwrap_or_else(|| home_socket.to_owned()),
        physical_socket: remnant.physical_socket,
        is_draining: true,
        telemetry: None,
    };
    Ok(Some((lasting, record)))
}
