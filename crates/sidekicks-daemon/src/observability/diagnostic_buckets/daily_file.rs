//! A diagnostic bucket kept as newline-delimited JSON, one file per local day in the bucket's own
//! folder: each record is one line stamped with the instant it was recorded, written straight to
//! the day's file on a blocking thread so the last line before an end is kept and no async thread
//! waits on the disk. The expiry deletes a day's file whole once it is past
//! `Keep diagnostic logs for`. A failed write loses its record, which a diagnostic log may, and is
//! told once in the service log until a write succeeds again; the part of its line it wrote is cut
//! off again, so the next record starts a line of its own.

use std::error::Error;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use jiff::Zoned;
use jiff::civil::Date;
use serde::Serialize;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::create_private_folder;

use crate::cleanup_failures::CleanupFailures;
use crate::mutex_lock::lock;

/// A bucket's day files: `<YYYY-MM-DD>.ndjson`, the local day its lines were recorded on.
pub(crate) struct DailyFileBucket {
    files: Arc<DayFiles>,
}

// The bucket's folder and the file of the day the last line was recorded on, held open for the
// next; shared with the blocking thread each write runs on.
struct DayFiles {
    folder: PathBuf,
    open_day: Mutex<Option<OpenDay>>,
    is_failing: AtomicBool,
}

struct OpenDay {
    day: Date,
    file: File,
    // The file's length in bytes: read at its open, and grown by each line written whole.
    length: u64,
}

// One line: the record's own members beside the instant it was recorded, in the stored form.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StampedRecord<'record, Record> {
    recorded_at: WireInstant,
    #[serde(flatten)]
    record: &'record Record,
}

impl DailyFileBucket {
    /// A bucket writing its day files into `folder`, made private at the first record.
    pub(crate) fn new(folder: PathBuf) -> Self {
        Self {
            files: Arc::new(DayFiles {
                folder,
                open_day: Mutex::new(None),
                is_failing: AtomicBool::new(false),
            }),
        }
    }

    /// Appends `record`, whose members serialize as a JSON object, as one line of today's file,
    /// written on a blocking thread; resolves once the line is written or its loss told.
    pub(crate) async fn append<Record: Serialize>(&self, record: &Record) {
        let now = Zoned::now();
        let line = serde_json::to_vec(&StampedRecord {
            recorded_at: WireInstant::from_timestamp(now.timestamp())
                .expect("the clock reads after year 0000"),
            record,
        });
        let written = match line {
            Ok(mut line) => {
                line.push(b'\n');
                let files = Arc::clone(&self.files);
                tokio::task::spawn_blocking(move || files.write_line(now.date(), &line))
                    .await
                    .unwrap_or_else(|interrupted| Err(io::Error::other(interrupted)))
            }
            Err(failure) => Err(failure.into()),
        };
        match written {
            Ok(()) => self.files.is_failing.store(false, Ordering::Relaxed),
            Err(failure) => {
                if !self.files.is_failing.swap(true, Ordering::Relaxed) {
                    tracing::warn!(
                        folder = %self.files.folder.display(),
                        error = &failure as &(dyn Error + 'static),
                        "a diagnostic record could not be written; records are lost until a write \
                         succeeds"
                    );
                }
            }
        }
    }
}

impl DayFiles {
    fn write_line(&self, day: Date, line: &[u8]) -> io::Result<()> {
        self.write_line_through(day, line, <File as Write>::write_all)
    }

    // Appends `line` to `day`'s file through `write`. A failed write cuts the file back to its
    // length before it and closes it, so no part of the line stays for the next to join; a failed
    // cut rides beside the write's failure.
    fn write_line_through(
        &self,
        day: Date,
        line: &[u8],
        write: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
    ) -> io::Result<()> {
        let mut open_day = lock(&self.open_day);
        let open = match open_day.take() {
            Some(open) if open.day == day => open_day.insert(open),
            _ => {
                create_private_folder(&self.folder)?;
                let file = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(self.folder.join(format!("{day}.ndjson")))?;
                let length = file.metadata()?.len();
                open_day.insert(OpenDay { day, file, length })
            }
        };
        let Err(failure) = write(&mut open.file, line) else {
            open.length += line.len() as u64;
            return Ok(());
        };
        let cut = open_day
            .take()
            .map(|open| open.file.set_len(open.length))
            .transpose();
        match cut {
            Ok(_cut) => Err(failure),
            Err(cut_failure) => Err(io::Error::new(
                failure.kind(),
                CleanupFailures::new(failure, vec![cut_failure], "a diagnostic record's write"),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::io::{self, Write as _};

    use jiff::civil::date;

    use super::DailyFileBucket;

    // A write the disk refuses partway: half the line, then a failure.
    fn write_half_then_fail(file: &mut File, line: &[u8]) -> io::Result<()> {
        file.write_all(&line[..line.len() / 2])?;
        Err(io::Error::from(io::ErrorKind::StorageFull))
    }

    // A line whose write fails halfway leaves none of itself in the day's file, so the next
    // record's line parses whole. Killed by a failed write that keeps its part of the line.
    #[test]
    fn a_line_whose_write_fails_halfway_leaves_none_of_itself() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let bucket = DailyFileBucket::new(scratch.path().join("bucket"));
        let day = date(2026, 10, 23);
        bucket
            .files
            .write_line(day, b"{\"record\":1}\n")
            .expect("the first line is written");

        bucket
            .files
            .write_line_through(day, b"{\"record\":2}\n", write_half_then_fail)
            .expect_err("the second line's write fails");
        bucket
            .files
            .write_line(day, b"{\"record\":3}\n")
            .expect("the third line is written");

        let text = fs::read_to_string(scratch.path().join("bucket/2026-10-23.ndjson"))
            .expect("the day's file reads");
        let records: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).expect("each line parses"))
            .collect();
        assert_eq!(
            records,
            [
                serde_json::json!({"record": 1}),
                serde_json::json!({"record": 3})
            ]
        );
    }
}
