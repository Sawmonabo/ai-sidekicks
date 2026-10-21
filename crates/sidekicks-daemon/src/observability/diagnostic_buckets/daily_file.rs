//! A diagnostic bucket kept as newline-delimited JSON, one file per local day in the bucket's own
//! folder: each record is one line stamped with the time it was recorded, written straight to the
//! day's file so the last line before an end is kept. The expiry deletes a day's file whole once
//! it is past `Keep diagnostic logs for`. A failed write loses its record, which a diagnostic log
//! may, and is told once in the service log until a write succeeds again.

use std::error::Error;
use std::fs::{File, OpenOptions};
use std::io::{self, Write as _};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

use jiff::Zoned;
use jiff::civil::Date;
use serde::Serialize;
use sidekicks_platforms::create_private_folder;

/// A bucket's day files: `<YYYY-MM-DD>.ndjson`, the local day its lines were recorded on.
pub(crate) struct DailyFileBucket {
    folder: PathBuf,
    open_day: Mutex<Option<OpenDay>>,
    is_failing: AtomicBool,
}

// The file of the day the last line was recorded on, held open for the next.
struct OpenDay {
    day: Date,
    file: File,
}

// One line: the record's own members beside the time it was recorded, in RFC 3339.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StampedRecord<'record, Record> {
    recorded_at: String,
    #[serde(flatten)]
    record: &'record Record,
}

impl DailyFileBucket {
    /// A bucket writing its day files into `folder`, made private at the first record.
    pub(crate) fn new(folder: PathBuf) -> Self {
        Self {
            folder,
            open_day: Mutex::new(None),
            is_failing: AtomicBool::new(false),
        }
    }

    /// Appends `record`, whose members serialize as a JSON object, as one line of today's file.
    pub(crate) fn append<Record: Serialize>(&self, record: &Record) {
        match self.write_line(&Zoned::now(), record) {
            Ok(()) => self.is_failing.store(false, Ordering::Relaxed),
            Err(failure) => {
                if !self.is_failing.swap(true, Ordering::Relaxed) {
                    tracing::warn!(
                        folder = %self.folder.display(),
                        error = &failure as &(dyn Error + 'static),
                        "A diagnostic record could not be written; records are lost until a write \
                         succeeds"
                    );
                }
            }
        }
    }

    fn write_line<Record: Serialize>(&self, now: &Zoned, record: &Record) -> io::Result<()> {
        let mut line = serde_json::to_vec(&StampedRecord {
            recorded_at: now.timestamp().to_string(),
            record,
        })?;
        line.push(b'\n');
        let day = now.date();
        let mut open_day = self.open_day.lock().unwrap_or_else(PoisonError::into_inner);
        let open = match open_day.take() {
            Some(open) if open.day == day => open_day.insert(open),
            _ => {
                create_private_folder(&self.folder)?;
                let file = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(self.folder.join(format!("{day}.ndjson")))?;
                open_day.insert(OpenDay { day, file })
            }
        };
        open.file.write_all(&line)
    }
}
