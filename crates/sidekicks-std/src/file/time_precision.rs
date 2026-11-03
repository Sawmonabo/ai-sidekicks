//! The precision of the modification times a folder keeps: file systems keep a time to a
//! nanosecond (APFS, ext4), 100 ns (NTFS), 10 ms (exFAT) or two seconds (FAT).

use std::fs::{self, File};
use std::io;
use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

/// The coarsest modification-time precision any supported file system keeps: FAT's two seconds,
/// the precision of a folder that keeps no time a probe set to the second.
pub const COARSEST_TIME_PRECISION: Duration = Duration::from_secs(2);

// The file a precision probe sets times on, removed once it has read them back.
const TIME_PROBE_FILE_NAME: &str = ".sidekicks-time-probe";

// An even second well inside every file system's range, FAT's from 1980 among them, that a probe
// adds each fraction to.
const TIME_PROBE_BASE: Duration = Duration::from_secs(1_700_000_000);

/// The precision of the modification times `folder` keeps: a file there is given a time 1 ns past
/// an even second, then 10 ns, 100 ns and so on up to 1 s, and the first that reads back whole is
/// it; two seconds when none does. The file is removed after. Blocking. Fails when the file cannot
/// be made, timed, read or removed.
pub fn probe_time_precision(folder: &Path) -> io::Result<Duration> {
    let probe = folder.join(TIME_PROBE_FILE_NAME);
    let file = File::create(&probe)?;
    let base = UNIX_EPOCH + TIME_PROBE_BASE;
    let mut fraction = Duration::from_nanos(1);
    let precision = loop {
        let set = base + fraction;
        file.set_modified(set)?;
        if fs::metadata(&probe)?.modified()? == set {
            break fraction;
        }
        if fraction >= Duration::from_secs(1) {
            break COARSEST_TIME_PRECISION;
        }
        fraction *= 10;
    };
    drop(file);
    fs::remove_file(&probe)?;
    Ok(precision)
}
