//! The rollout files a Codex home's sessions folder holds, by the day folders Codex writes them
//! under, read for a launch's rollout fallback.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sidekicks_std::missing_entry::is_missing_entry;

/// The folder of a Codex home its rollout files are written under, by day.
pub(super) const SESSIONS_FOLDER: &str = "sessions";

// The rollout files under `sessions` written in day folders from the day before `since_ms`'s,
// in UTC, on, and modified since it, each with its size; a folder that cannot be read is logged
// and passed over. Blocking.
pub(super) fn find_rollouts(sessions: &Path, since_ms: u64) -> Vec<(PathBuf, u64)> {
    let since = UNIX_EPOCH + Duration::from_millis(since_ms);
    let first_day = i64::try_from(since_ms)
        .ok()
        .and_then(|since_ms| jiff::Timestamp::from_millisecond(since_ms).ok())
        .and_then(|since| {
            since
                .to_zoned(jiff::tz::TimeZone::UTC)
                .date()
                .yesterday()
                .ok()
        });
    let Some(first_day) = first_day else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for (year, year_folder) in numbered_folders(sessions) {
        if year < i64::from(first_day.year()) {
            continue;
        }
        for (month, month_folder) in numbered_folders(&year_folder) {
            if year == i64::from(first_day.year()) && month < i64::from(first_day.month()) {
                continue;
            }
            for (day, day_folder) in numbered_folders(&month_folder) {
                let date = i16::try_from(year)
                    .ok()
                    .zip(i8::try_from(month).ok())
                    .zip(i8::try_from(day).ok());
                let Some(((year, month), day)) = date else {
                    continue;
                };
                if jiff::civil::Date::new(year, month, day).is_ok_and(|date| date >= first_day) {
                    found.extend(modified_rollouts(&day_folder, since));
                }
            }
        }
    }
    found
}

// Each folder in `folder` named by a number, with its number.
fn numbered_folders(folder: &Path) -> Vec<(i64, PathBuf)> {
    read_entries(folder)
        .into_iter()
        .filter_map(|(name, path)| name.parse::<i64>().ok().map(|number| (number, path)))
        .collect()
}

// Each `rollout-*.jsonl` file in `folder` modified at or after `since`, with its size.
fn modified_rollouts(folder: &Path, since: SystemTime) -> Vec<(PathBuf, u64)> {
    read_entries(folder)
        .into_iter()
        .filter(|(name, path)| {
            name.starts_with("rollout-")
                && path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
        })
        .filter_map(|(_name, path)| {
            let metadata = std::fs::metadata(&path).ok()?;
            let modified = metadata.modified().ok()?;
            (modified >= since).then_some((path, metadata.len()))
        })
        .collect()
}

// Whether `path` is the rollout file of `thread_id`, which Codex names
// `rollout-<time>-<thread id>.jsonl`.
pub(super) fn is_rollout_of(path: &Path, thread_id: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with("rollout-") && name.ends_with(&format!("-{thread_id}.jsonl"))
        })
}

// The rollout file of `thread_id` under `sessions`, in the day folder, by this system's clock, of
// the first of `made_at_s`, Unix seconds its thread may have been made at, that holds it, as Codex
// names it, with its size; `None` where none is there. Blocking.
pub(super) fn find_thread_rollout(
    sessions: &Path,
    thread_id: &str,
    made_at_s: &[i64],
) -> Option<(PathBuf, u64)> {
    made_at_s.iter().find_map(|made_at_s| {
        let made_on = jiff::Timestamp::from_second(*made_at_s)
            .ok()?
            .to_zoned(jiff::tz::TimeZone::system())
            .date();
        let folder = sessions
            .join(format!("{:04}", made_on.year()))
            .join(format!("{:02}", made_on.month()))
            .join(format!("{:02}", made_on.day()));
        read_entries(&folder)
            .into_iter()
            .find(|(_name, path)| is_rollout_of(path, thread_id))
            .and_then(|(_name, path)| {
                let size = std::fs::metadata(&path).ok()?.len();
                Some((path, size))
            })
    })
}

// Each entry of `folder` by its name; a folder that is absent reads empty, and one that cannot be
// read is logged and reads empty.
fn read_entries(folder: &Path) -> Vec<(String, PathBuf)> {
    let entries = match std::fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if is_missing_entry(&error) => return Vec::new(),
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                folder = %folder.display(),
                "a codex rollout folder could not be read"
            );
            return Vec::new();
        }
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            Some((name, entry.path()))
        })
        .collect()
}
