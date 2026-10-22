//! A diagnostic bucket kept as newline-delimited JSON, one file per local day in the bucket's own
//! folder: each record is one line stamped with the instant it was recorded, written straight to
//! the day's file on a blocking thread so the last line before an end is kept and no async thread
//! waits on the disk. The expiry deletes a day's file whole once it is past
//! `Keep diagnostic logs for`. A failed write loses its record, which a diagnostic log may, and is
//! told once in the service log until a write succeeds again.

use std::error::Error;
use std::fs::{File, OpenOptions};
use std::io::{self, Write as _};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use jiff::Zoned;
use jiff::civil::Date;
use serde::Serialize;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::create_private_folder;

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
                        "A diagnostic record could not be written; records are lost until a write \
                         succeeds"
                    );
                }
            }
        }
    }
}

impl DayFiles {
    fn write_line(&self, day: Date, line: &[u8]) -> io::Result<()> {
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
        open.file.write_all(line)
    }
}
