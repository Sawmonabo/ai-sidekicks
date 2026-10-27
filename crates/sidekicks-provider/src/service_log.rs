//! The log of a provider's lasting service, one per provider and home in the daemon's `logs/`
//! folder, `<provider id>-service-<home key>.log`: begun empty at each start with the former
//! start's last 256 KiB kept beside it as `.previous.log`, written by the service in append mode,
//! and cut the same way in place once it passes [`SERVICE_LOG_CAP_BYTES`], so a service that runs
//! for weeks never fills the disk. The diagnostic-log expiry deletes these files with the daemon's
//! own.

use std::error::Error;
use std::io::{self, SeekFrom};
use std::path::{Path, PathBuf};

use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::id::{ProviderId, is_provider_id};
use sidekicks_std::process_exit::OutputTail;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// How much of the log is kept beside it when a start or the cap begins it again.
const PREVIOUS_LOG_TAIL_BYTES: u64 = 256 * 1024;

/// The size past which a running service's log is cut: 64 MiB.
pub const SERVICE_LOG_CAP_BYTES: u64 = 64 * 1024 * 1024;

/// The hex digits of a home's key: the first 16 of its path's `blake3` hash.
const HOME_KEY_HEX_DIGITS: usize = 16;

/// Between the provider id and the home key in a log's name.
const SERVICE_LOG_NAME_INFIX: &str = "-service-";

/// The endings of a log, of the tail kept beside it, and of that tail while it is written.
const SERVICE_LOG_ENDINGS: [&str; 3] = [".previous.log.tmp", ".previous.log", ".log"];

/// The key a provider's home is known by in the daemon's files: the first 16 hex digits of the
/// `blake3` hash of `home`, its path with every link resolved, so two spellings of one home share
/// one key and nothing is written into the home itself.
pub(crate) fn provider_home_key(home: &Path) -> String {
    let hash = blake3::hash(home.as_os_str().as_encoded_bytes()).to_hex();
    hash.as_str()[..HOME_KEY_HEX_DIGITS].to_owned()
}

/// The log of `provider_id`'s lasting service on `home`, in the daemon's `logs_folder`; `home` is
/// resolved first. Fails with the resolve's error, a missing home among them.
pub(crate) fn provider_service_log_file(
    logs_folder: &Path,
    provider_id: &ProviderId,
    home: &Path,
) -> io::Result<PathBuf> {
    let key = provider_home_key(&sidekicks_platforms::real_path(home)?);
    Ok(provider_service_log_file_of_key(
        logs_folder,
        provider_id,
        &key,
    ))
}

/// The log of `provider_id`'s lasting service on the home whose key is `home_key`, in the daemon's
/// `logs_folder`.
pub(crate) fn provider_service_log_file_of_key(
    logs_folder: &Path,
    provider_id: &ProviderId,
    home_key: &str,
) -> PathBuf {
    let provider_id = provider_id.as_str();
    logs_folder.join(format!(
        "{provider_id}{SERVICE_LOG_NAME_INFIX}{home_key}.log"
    ))
}

/// Whether `file_name` names a provider service's log, the tail kept beside it, or that tail
/// while it is written: `<provider id>-service-<16 hex digits>` and one of their endings.
pub fn is_provider_service_log_file_name(file_name: &str) -> bool {
    let Some(stem) = SERVICE_LOG_ENDINGS
        .iter()
        .find_map(|ending| file_name.strip_suffix(ending))
    else {
        return false;
    };
    stem.rsplit_once(SERVICE_LOG_NAME_INFIX)
        .is_some_and(|(provider_id, key)| {
            is_provider_id(provider_id)
                && key.len() == HOME_KEY_HEX_DIGITS
                && key
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

/// Opens `log_file` for a new start of its service: the former start's tail kept beside it, then
/// the log begun empty, opened in append mode so every writer, a former service still finishing
/// among them, writes at its end and an in-place cut leaves no gap. A tail that cannot be kept is
/// logged and the start goes on. Fails with the open's or the cut's error.
pub(crate) async fn open_provider_service_log(log_file: &Path) -> io::Result<std::fs::File> {
    if let Err(error) = keep_previous_log_tail(log_file).await {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            log_file = %log_file.display(),
            "the provider service's previous log tail could not be kept"
        );
    }
    // Emptied through a write open, since an append-only open on Windows lacks the right to cut.
    tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(log_file)
        .await?;
    let log = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file)
        .await?;
    Ok(log.into_std().await)
}

/// Cuts a running service's `log_file` once it passes `cap_bytes`, [`SERVICE_LOG_CAP_BYTES`]
/// outside a test: its last 256 KiB kept beside it, then the log emptied in place. The cut is
/// safe only because every writer appends: each write lands at the file's end as it is then, so
/// after the cut the service writes from the start, where a writer holding its own offset would
/// leave a hole of NUL bytes as long as the log was. It is logrotate's copy and truncate, with
/// its gap: what the service appends between the tail's read and the cut lands in neither file.
/// A missing log is left alone. Fails with the read's, the keep's or the cut's error.
pub async fn cap_provider_service_log(log_file: &Path, cap_bytes: u64) -> io::Result<()> {
    match tokio::fs::symlink_metadata(log_file).await {
        Ok(metadata) if metadata.is_file() && metadata.len() > cap_bytes => {}
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    keep_previous_log_tail(log_file).await?;
    tokio::fs::OpenOptions::new()
        .write(true)
        .open(log_file)
        .await?
        .set_len(0)
        .await
}

/// The tail of what the service wrote to `log_file` since its current start, as a failure reports
/// it; the log is then cut if it has passed its cap. Fails when the log cannot be read or cut.
pub(crate) async fn read_provider_service_log_tail(
    log_file: &Path,
) -> io::Result<OutputTail<PROVIDER_FAILURE_DETAIL_MAX_LEN>> {
    // At most four bytes a code point, and three more for a sequence the start cuts into, so the
    // bytes read hold the whole tail however the log is written.
    let count = u64::try_from(4 * PROVIDER_FAILURE_DETAIL_MAX_LEN + 3)
        .expect("the tail's byte count fits 64 bits");
    let mut tail = OutputTail::new();
    tail.push(&read_last_bytes(log_file, count).await?);
    cap_provider_service_log(log_file, SERVICE_LOG_CAP_BYTES).await?;
    Ok(tail)
}

// The tail kept beside the log: `<name>.previous.log`.
fn previous_log_file(log_file: &Path) -> PathBuf {
    log_file.with_extension("previous.log")
}

// Keeps the last stretch of the log beside it, written to a temporary file and renamed into
// place; a missing or empty log leaves the last kept tail as it was.
async fn keep_previous_log_tail(log_file: &Path) -> io::Result<()> {
    match tokio::fs::symlink_metadata(log_file).await {
        Ok(metadata) if metadata.is_file() && metadata.len() > 0 => {}
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    let bytes = read_last_bytes(log_file, PREVIOUS_LOG_TAIL_BYTES).await?;
    let previous = previous_log_file(log_file);
    let temporary = previous.with_extension("log.tmp");
    let kept = async {
        tokio::fs::write(&temporary, &bytes).await?;
        tokio::fs::rename(&temporary, &previous).await
    }
    .await;
    if kept.is_err()
        && let Err(error) = tokio::fs::remove_file(&temporary).await
        && error.kind() != io::ErrorKind::NotFound
    {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            temporary_file = %temporary.display(),
            "the previous log tail's temporary file could not be removed"
        );
    }
    kept
}

// The last `count` bytes of `file`, or all of it when it is shorter.
async fn read_last_bytes(file: &Path, count: u64) -> io::Result<Vec<u8>> {
    let mut opened = tokio::fs::File::open(file).await?;
    let length = opened.metadata().await?.len();
    opened
        .seek(SeekFrom::Start(length.saturating_sub(count)))
        .await?;
    let mut bytes = Vec::new();
    opened.take(count).read_to_end(&mut bytes).await?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;
    use std::io::Write as _;

    use rstest::rstest;

    use super::{
        PREVIOUS_LOG_TAIL_BYTES, cap_provider_service_log, is_provider_service_log_file_name,
        open_provider_service_log, previous_log_file,
    };

    // Fails when the keep copies the whole log or its first 256 KiB, when the start leaves the
    // former log in place, or when the log opens without append, so a former service's next write
    // lands past a hole of NUL bytes.
    #[tokio::test]
    async fn a_service_log_start_keeps_the_last_256_kib_and_appends_after_the_cut() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let log_file = folder.path().join("first-service-0123456789abcdef.log");
        let mut log = String::new();
        let mut line = 0_u32;
        while log.len() < 300 * 1024 {
            writeln!(log, "line {line:06}").expect("a line is written into a string");
            line += 1;
        }
        log.truncate(300 * 1024);
        std::fs::write(&log_file, &log).expect("the log is written");
        let mut former_writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&log_file)
            .expect("the former service's log opens");

        let mut new_writer = open_provider_service_log(&log_file)
            .await
            .expect("the log opens for the new start");
        former_writer
            .write_all(b"former\n")
            .expect("the former service writes");
        new_writer
            .write_all(b"new\n")
            .expect("the new service writes");

        let kept = std::fs::read(previous_log_file(&log_file)).expect("the previous tail is read");
        let kept_len = usize::try_from(PREVIOUS_LOG_TAIL_BYTES).expect("256 KiB fits a usize");
        assert_eq!(kept.as_slice(), &log.as_bytes()[log.len() - kept_len..]);
        assert_eq!(
            std::fs::read_to_string(&log_file).expect("the log is read"),
            "former\nnew\n"
        );
    }

    // Fails when the cut runs below its cap, leaves the log whole, keeps no tail, or loses the
    // writer's place, so its next line lands past a hole of NUL bytes.
    #[tokio::test]
    async fn a_service_log_past_its_cap_is_cut_and_written_on_from_its_start() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let log_file = folder.path().join("first-service-0123456789abcdef.log");
        let mut writer = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_file)
            .expect("the service's log opens");
        writer.write_all(b"0123456789").expect("the service writes");

        cap_provider_service_log(&log_file, 10)
            .await
            .expect("a log at its cap is left");
        let at_cap = std::fs::read(&log_file).expect("the log is read");
        cap_provider_service_log(&log_file, 9)
            .await
            .expect("a log past its cap is cut");
        writer.write_all(b"next\n").expect("the service writes on");

        assert_eq!(at_cap, b"0123456789");
        assert_eq!(
            std::fs::read(previous_log_file(&log_file)).expect("the kept tail is read"),
            b"0123456789"
        );
        assert_eq!(
            std::fs::read(&log_file).expect("the log is read"),
            b"next\n"
        );
    }

    // Fails when the expiry's match takes another file in `logs/`, or misses a tail.
    #[rstest]
    #[case::a_log("first-service-0123456789abcdef.log", true)]
    #[case::its_tail("second-provider-service-0123456789abcdef.previous.log", true)]
    #[case::a_tail_being_written("first-service-0123456789abcdef.previous.log.tmp", true)]
    #[case::a_short_key("first-service-0123456789abcde.log", false)]
    #[case::an_upper_case_key("first-service-0123456789ABCDEF.log", false)]
    #[case::no_provider("-service-0123456789abcdef.log", false)]
    #[case::the_daemon_log("service-2026-10-12T21-05-48-642.log", false)]
    fn provider_service_log_file_names_are_the_logs_and_their_tails(
        #[case] file_name: &str,
        #[case] is_service_log: bool,
    ) {
        assert_eq!(is_provider_service_log_file_name(file_name), is_service_log);
    }
}
