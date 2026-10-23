//! The crash report builder: each finished dump in the crash dumps folder, the service's and the
//! app's alike, becomes a report of the crashing thread's stack as module file names and offsets,
//! with no symbols read, then the dump is deleted, so the dump never outlives its report. A panic's
//! message and place join the report built from its crash, each path in them cut to its file name,
//! each credential scrubbed and each id hashed with a key this install keeps, so a forwarded report
//! names no folder, no secret and no id anyone could confirm. A dump still being written, the
//! monitor's or Crashpad's in its `new` folder, is passed over. A dump that does not build is named
//! in the service log and deleted. Every pass also deletes what a write cut short left: a partial
//! dump no monitor holds locked while writing it, a panic record with neither its dump nor such a
//! partial dump in the dumps folder, and a temporary file of the key. A leftover that cannot be
//! removed is named beside the pass's result and the pass runs on. While `Keep crash reports` is
//! off, no report is built and every dump, report and panic record goes. Each pass is metered
//! against its processor budget.

use std::error::Error;
use std::fs::{self, File, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use minidump::system_info::Os;
use minidump::{Minidump, MinidumpCrashpadInfo, Module as _};
use minidump_processor::ProcessState;
use minidump_unwind::MultiSymbolProvider;
use regex::{Captures, Regex};
use sidekicks_contracts::daemon::status::{
    CRASH_REPORT_STACK_MAX_FRAMES, CrashModuleFileName, CrashPanic, CrashReport, CrashStackFrame,
    DAEMON_STATUS_TEXT_MAX_LEN,
};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_platforms::{
    create_file_atomically, remove_atomic_write_leftovers, replace_file_atomically,
};
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

use crate::cleanup_failures::CleanupFailures;
use crate::daemon::crash::monitor::{
    CRASH_DUMPS_FOLDER_NAME, DUMP_EXTENSION, DUMP_IN_PROGRESS_SUFFIX, PANIC_RECORD_SUFFIX,
    PanicRecord, panic_record_path,
};
use crate::daemon::machine::settings::file::MachineSettingsFile;
use crate::daemon::panic_hook::{PANIC_RECORD_FILE_EXTENSION, PANIC_RECORD_FILE_PREFIX};
use crate::daemon::scheduler::ScheduledJobOutcome;
use crate::daemon::scheduler::budget::{
    BudgetTerm, JobBudget, JobWorkload, MeteredJobOutcome, ProcessorMeter, WorkUnit, metered_job,
};
use crate::daemon::service_log::CRASH_REPORTS_FOLDER_NAME;
use crate::missing_entry::MissingEntry as _;
use crate::redaction::{DRIVE_PATH, UNC_PATH, UNIX_PATH, scrub_credentials};
use crate::text_cut::cut_to_code_points;

/// A report's file extension in the crash reports folder.
pub(crate) const REPORT_EXTENSION: &str = "json";

// The key the ids in reports are hashed with, in the data folder, readable by the person alone.
const REPORT_KEY_FILE_NAME: &str = "crash-report.key";
const REPORT_KEY_LENGTH: usize = 32;
const REPORT_FILE_MODE: u32 = 0o600;

// The folder Crashpad writes a dump in while it is still being written.
const CRASHPAD_IN_PROGRESS_FOLDER_NAME: &str = "new";

// The annotation Crashpad records a process's type under, and the type of a dump without it, the
// service's own.
const PROCESS_TYPE_ANNOTATION: &str = "ptype";
const SERVICE_PROCESS_TYPE: &str = "service";

// The annotation Crashpad records the crashed app's own version under; a dump without it, the
// service's, takes the version the pass is given.
const APP_VERSION_ANNOTATION: &str = "_version";

// A build's processor time: under 2 s per 64 MiB of dump.
const CRASH_REPORT_BUDGET: JobBudget = JobBudget::new(&[BudgetTerm {
    figure: Duration::from_secs(2),
    per: 64 * 1024 * 1024,
    unit: WorkUnit::DumpBytes,
}]);

// The hex digits of a hashed id a report keeps.
const HASHED_ID_LENGTH: usize = 32;

// Any UUID, in either case; a session id is one.
static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
        .expect("the UUID pattern is a valid regex")
});

/// What a pass reads and writes.
pub(crate) struct CrashReportDeps {
    /// The data folder, which holds the dumps, the reports and the key.
    pub(crate) data_folder: PathBuf,
    /// The settings file holding `Keep crash reports`.
    pub(crate) settings: Arc<MachineSettingsFile>,
    /// The app's version, recorded in each report whose dump does not name its own.
    pub(crate) app_version: String,
    /// The service's version, recorded in each report.
    pub(crate) service_version: String,
}

/// What one pass did.
#[derive(Debug, Default)]
pub(crate) struct CrashReportPass {
    /// The reports built.
    pub(crate) built: usize,
    /// The dumps that did not build, each deleted.
    pub(crate) failed: usize,
    /// The bytes of the dumps built or failed.
    pub(crate) dump_bytes: u64,
    /// What the sweep of leftovers could not remove, the first failure carrying the rest; the pass
    /// ran on past them. `None` once every leftover is gone.
    pub(crate) leftover_failures: Option<CleanupFailures<io::Error>>,
}

/// Why a dump did not build.
#[derive(Debug, thiserror::Error)]
enum DumpBuildError {
    /// The dump does not read.
    #[error("the crash dump does not read")]
    Read(#[source] minidump::Error),
    /// The dump's threads did not process.
    #[error("the crash dump does not process")]
    Process(#[source] minidump_processor::ProcessError),
    /// The dump names no crashing thread, as a cut-short dump does.
    #[error("the crash dump names no crashing thread")]
    NoCrashingThread,
    /// The panic record beside it could not be read.
    #[error("the panic record beside the crash dump could not be read")]
    PanicRead(#[source] io::Error),
    /// The panic record beside it is not a panic record.
    #[error("the panic record beside the crash dump does not parse")]
    Panic(#[source] serde_json::Error),
}

/// The body of the pass the daemon's start schedules, metered against its processor budget:
/// builds every finished dump's report, or, while `Keep crash reports` is off, deletes every dump,
/// report and panic record. Fails when the settings, a folder or the key cannot be read or written.
#[expect(
    dead_code,
    reason = "the daemon's start schedules the crash report pass"
)]
pub(crate) fn crash_report_job(
    deps: Arc<CrashReportDeps>,
) -> impl FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static {
    metered_job(
        CRASH_REPORT_BUDGET,
        Box::new(move |stop, meter| {
            let deps = Arc::clone(&deps);
            async move { run_crash_report_pass(&deps, &stop, &meter).await }.boxed()
        }),
    )
}

// One metered pass: its workload is the bytes of the dumps it built, none when it built none.
async fn run_crash_report_pass(
    deps: &CrashReportDeps,
    stop: &CancellationToken,
    meter: &ProcessorMeter,
) -> MeteredJobOutcome {
    let pass = build_crash_reports(deps, stop, meter).await?;
    if let Some(failures) = &pass.leftover_failures {
        tracing::warn!(
            error = failures as &(dyn Error + 'static),
            "what failed crash dumps left could not all be removed"
        );
    }
    if pass.built == 0 && pass.failed == 0 {
        return Ok(None);
    }
    tracing::info!(
        built = pass.built,
        failed = pass.failed,
        "the crash dumps were built into reports"
    );
    Ok(Some(JobWorkload::of(WorkUnit::DumpBytes, pass.dump_bytes)))
}

/// One pass over the crash dumps folder, as the module's doc says, its blocking work charged to
/// `meter`; checks `stop` between dumps. Fails when the settings, a folder or the key cannot be
/// read or written; a leftover that cannot be removed is answered in the pass instead.
pub(crate) async fn build_crash_reports(
    deps: &CrashReportDeps,
    stop: &CancellationToken,
    meter: &ProcessorMeter,
) -> Result<CrashReportPass, Box<dyn Error + Send + Sync>> {
    let is_kept = deps.settings.read().await?.settings.keep_crash_reports;
    let dumps_folder = deps.data_folder.join(CRASH_DUMPS_FOLDER_NAME);
    let reports_folder = deps.data_folder.join(CRASH_REPORTS_FOLDER_NAME);
    let listed_folder = dumps_folder.clone();
    let key_path = deps.data_folder.join(REPORT_KEY_FILE_NAME);
    let (dumps, leftover_failures) = meter
        .run_blocking(move || {
            let mut failures = remove_monitor_leftovers(&listed_folder);
            failures.extend(remove_atomic_write_leftovers(&key_path));
            list_finished_dumps(&listed_folder).map(|dumps| (dumps, failures))
        })
        .await??;
    let mut leftover_failures = leftover_failures.into_iter();
    let mut pass = CrashReportPass {
        leftover_failures: leftover_failures.next().map(|first| {
            CleanupFailures::new(
                first,
                leftover_failures.collect(),
                "the crash leftovers' sweep",
            )
        }),
        ..CrashReportPass::default()
    };
    if !is_kept {
        let reports = reports_folder.clone();
        meter
            .run_blocking(move || {
                for (dump, _bytes) in &dumps {
                    remove_dump(dump)?;
                }
                remove_reports(&reports)
            })
            .await??;
        return Ok(pass);
    }
    if dumps.is_empty() {
        return Ok(pass);
    }
    let key_folder = deps.data_folder.clone();
    let key = meter
        .run_blocking(move || read_or_make_key(&key_folder))
        .await??;
    for (dump, bytes) in dumps {
        if stop.is_cancelled() {
            break;
        }
        pass.dump_bytes = pass.dump_bytes.saturating_add(bytes);
        match build_report(&dump, &key, deps).await {
            Ok(report) => {
                let name = dump
                    .with_extension(REPORT_EXTENSION)
                    .file_name()
                    .expect("a dump's path names its file")
                    .to_owned();
                let report_path = reports_folder.join(name);
                let reports = reports_folder.clone();
                let bytes = serde_json::to_vec(&report).expect("a report serializes as JSON");
                meter
                    .run_blocking(move || {
                        sidekicks_platforms::create_private_folder(&reports)?;
                        replace_file_atomically(&report_path, &bytes, REPORT_FILE_MODE)
                            .map_err(io::Error::other)?;
                        remove_dump(&dump)
                    })
                    .await??;
                pass.built += 1;
            }
            Err(failure) => {
                tracing::warn!(
                    dump = %dump.display(),
                    error = &failure as &(dyn Error + 'static),
                    "the crash dump did not build into a report and is deleted"
                );
                meter.run_blocking(move || remove_dump(&dump)).await??;
                pass.failed += 1;
            }
        }
    }
    Ok(pass)
}

/// The crash reports in the data folder `data_folder`, newest first; a report that does not read
/// is named in the service log and passed over. Fails when the folder does not list.
pub(crate) fn read_crash_reports(data_folder: &Path) -> io::Result<Vec<CrashReport>> {
    let folder = data_folder.join(CRASH_REPORTS_FOLDER_NAME);
    let Some(entries) = fs::read_dir(&folder).none_if_missing()? else {
        return Ok(Vec::new());
    };
    let mut reports = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if path
            .extension()
            .is_none_or(|extension| extension != REPORT_EXTENSION)
        {
            continue;
        }
        let read = fs::read(&path)
            .map_err(|failure| failure.to_string())
            .and_then(|bytes| {
                serde_json::from_slice::<CrashReport>(&bytes).map_err(|failure| failure.to_string())
            });
        match read {
            Ok(report) => reports.push(report),
            Err(reason) => tracing::warn!(
                report = %path.display(),
                reason,
                "the crash report does not read and is passed over"
            ),
        }
    }
    reports.sort_by(|left, right| {
        right
            .crashed_at
            .unix_millisecond()
            .cmp(&left.crashed_at.unix_millisecond())
    });
    Ok(reports)
}

// Every finished dump under `folder`, at any depth, with its size in bytes, Crashpad's `new` folder
// passed over.
fn list_finished_dumps(folder: &Path) -> io::Result<Vec<(PathBuf, u64)>> {
    if fs::symlink_metadata(folder).none_if_missing()?.is_none() {
        return Ok(Vec::new());
    }
    let mut dumps = Vec::new();
    let walk = WalkDir::new(folder).into_iter().filter_entry(|entry| {
        !(entry.depth() > 0
            && entry.file_type().is_dir()
            && entry.file_name() == CRASHPAD_IN_PROGRESS_FOLDER_NAME)
    });
    for entry in walk {
        let entry = entry.map_err(io::Error::from)?;
        if entry.file_type().is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|extension| extension == DUMP_EXTENSION)
        {
            let bytes = entry.metadata().map_err(io::Error::from)?.len();
            dumps.push((entry.into_path(), bytes));
        }
    }
    Ok(dumps)
}

// Deletes what a failed write of the monitor left in the dumps folder `folder`: each partial dump
// no monitor holds, and each panic record whose dump is not there. Runs on past a check or a
// removal that fails, answering each failure.
fn remove_monitor_leftovers(folder: &Path) -> Vec<io::Error> {
    let entries = match fs::read_dir(folder).none_if_missing() {
        Ok(Some(entries)) => entries,
        Ok(None) => return Vec::new(),
        Err(failure) => return vec![failure],
    };
    let mut failures = Vec::new();
    for entry in entries {
        let path = match entry {
            Ok(entry) => entry.path(),
            Err(failure) => {
                failures.push(failure);
                break;
            }
        };
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let is_leftover = match name.strip_suffix(PANIC_RECORD_SUFFIX) {
            Some(stem) => is_record_orphaned(folder, stem),
            None if name.ends_with(DUMP_IN_PROGRESS_SUFFIX) => is_held(&path).map(|held| !held),
            None => Ok(false),
        };
        let removed = is_leftover.and_then(|is_leftover| {
            if is_leftover {
                fs::remove_file(&path).none_if_missing().map(drop)
            } else {
                Ok(())
            }
        });
        if let Err(failure) = removed {
            failures.push(failure);
        }
    }
    failures
}

// Whether the panic record of the dump `<stem>.dmp` has lost its dump: no monitor holds the dump
// while writing it, and it is not finished either. The partial dump is looked at first, since a
// monitor renames it to the finished name while it holds it.
fn is_record_orphaned(folder: &Path, stem: &str) -> io::Result<bool> {
    let dump = folder.join(format!("{stem}.{DUMP_EXTENSION}"));
    let mut partial = dump.clone().into_os_string();
    partial.push(DUMP_IN_PROGRESS_SUFFIX);
    Ok(!is_held(Path::new(&partial))? && !dump.try_exists()?)
}

// Whether a monitor holds the partial dump at `path` locked while it writes it; one gone is not.
fn is_held(path: &Path) -> io::Result<bool> {
    let Some(file) = File::open(path).none_if_missing()? else {
        return Ok(false);
    };
    match file.try_lock() {
        Ok(()) => Ok(false),
        Err(TryLockError::WouldBlock) => Ok(true),
        Err(TryLockError::Error(failure)) => Err(failure),
    }
}

// Deletes the dump at `dump` and the panic record beside it.
fn remove_dump(dump: &Path) -> io::Result<()> {
    fs::remove_file(dump).none_if_missing()?;
    fs::remove_file(panic_record_path(dump)).none_if_missing()?;
    Ok(())
}

// Deletes every report and every panic record in `folder`.
fn remove_reports(folder: &Path) -> io::Result<()> {
    let Some(entries) = fs::read_dir(folder).none_if_missing()? else {
        return Ok(());
    };
    for entry in entries {
        let path = entry?.path();
        let is_report = path
            .extension()
            .is_some_and(|extension| extension == REPORT_EXTENSION);
        let is_panic_record = path
            .extension()
            .is_some_and(|extension| extension == PANIC_RECORD_FILE_EXTENSION)
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(PANIC_RECORD_FILE_PREFIX));
        if is_report || is_panic_record {
            fs::remove_file(&path).none_if_missing()?;
        }
    }
    Ok(())
}

// The install's key, made once with random bytes.
fn read_or_make_key(data_folder: &Path) -> io::Result<[u8; REPORT_KEY_LENGTH]> {
    let path = data_folder.join(REPORT_KEY_FILE_NAME);
    if let Some(bytes) = fs::read(&path).none_if_missing()? {
        return <[u8; REPORT_KEY_LENGTH]>::try_from(bytes.as_slice()).map_err(|_wrong_length| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "the crash report key is damaged",
            )
        });
    }
    let mut key = [0_u8; REPORT_KEY_LENGTH];
    getrandom::fill(&mut key).map_err(io::Error::other)?;
    sidekicks_platforms::create_private_folder(data_folder)?;
    make_key(data_folder, key)
}

// Makes `key` the install's key, whole or not at all, unless another pass made one first, and
// answers the key that stands.
fn make_key(
    data_folder: &Path,
    key: [u8; REPORT_KEY_LENGTH],
) -> io::Result<[u8; REPORT_KEY_LENGTH]> {
    match create_file_atomically(
        &data_folder.join(REPORT_KEY_FILE_NAME),
        &key,
        REPORT_FILE_MODE,
    ) {
        Ok(()) => Ok(key),
        // Another pass made it first.
        Err(failure)
            if failure.failure.kind() == io::ErrorKind::AlreadyExists
                && failure.removal_failure.is_none() =>
        {
            read_or_make_key(data_folder)
        }
        Err(failure) => Err(io::Error::other(failure)),
    }
}

// The report of the dump at `dump`, with the panic record beside it.
async fn build_report(
    dump: &Path,
    key: &[u8; REPORT_KEY_LENGTH],
    deps: &CrashReportDeps,
) -> Result<CrashReport, DumpBuildError> {
    let minidump = Minidump::read_path(dump).map_err(DumpBuildError::Read)?;
    let state = minidump_processor::process_minidump(&minidump, &MultiSymbolProvider::new())
        .await
        .map_err(DumpBuildError::Process)?;
    let stack = crashing_stack(&state).ok_or(DumpBuildError::NoCrashingThread)?;
    let annotations = minidump
        .get_stream::<MinidumpCrashpadInfo>()
        .ok()
        .map(|info| info.simple_annotations);
    let annotation = |name: &str| {
        annotations
            .as_ref()
            .and_then(|annotations| annotations.get(name).cloned())
    };
    let process_type =
        annotation(PROCESS_TYPE_ANNOTATION).unwrap_or_else(|| SERVICE_PROCESS_TYPE.to_owned());
    let app_version =
        annotation(APP_VERSION_ANNOTATION).unwrap_or_else(|| deps.app_version.clone());
    let panic = match fs::read(panic_record_path(dump))
        .none_if_missing()
        .map_err(DumpBuildError::PanicRead)?
    {
        Some(bytes) => {
            let record: PanicRecord =
                serde_json::from_slice(&bytes).map_err(DumpBuildError::Panic)?;
            Some(CrashPanic {
                message: status_text(&strip(&record.message, key)),
                location: status_text(&strip(&cut_to_file_name(&record.location), key)),
            })
        }
        None => None,
    };
    let crashed_at = jiff::Timestamp::try_from(state.time)
        .ok()
        .and_then(WireInstant::from_timestamp)
        .unwrap_or_else(WireInstant::now);
    Ok(CrashReport {
        crashed_at,
        process_type: status_text(&process_type),
        app_version: status_text(&app_version),
        service_version: status_text(&deps.service_version),
        platform: status_text(&platform_name(state.system_info.os)),
        stack,
        panic,
    })
}

// The crashing thread's frames that sit in a module, at most the report's bound.
fn crashing_stack(
    state: &ProcessState,
) -> Option<BoundedVec<CrashStackFrame, 0, CRASH_REPORT_STACK_MAX_FRAMES>> {
    let thread = state.threads.get(state.requesting_thread?)?;
    let frames: Vec<CrashStackFrame> = thread
        .frames
        .iter()
        .filter_map(|frame| {
            let module = frame.module.as_ref()?;
            let code_file = module.code_file();
            let name = cut_to_file_name(&code_file);
            Some(CrashStackFrame {
                module: CrashModuleFileName::new(name)?,
                offset: SafeInt::new(frame.instruction.saturating_sub(module.base_address()))?,
            })
        })
        .take(CRASH_REPORT_STACK_MAX_FRAMES)
        .collect();
    BoundedVec::new(frames)
}

// `text` with every credential scrubbed, every path cut to its file name and every UUID replaced by
// its keyed hash.
fn strip(text: &str, key: &[u8; REPORT_KEY_LENGTH]) -> String {
    let scrubbed = scrub_credentials(text);
    let cut = UNIX_PATH.replace_all(&scrubbed, |captures: &Captures<'_>| {
        let boundary = &captures[1];
        let path = &captures[0][boundary.len()..];
        format!("{boundary}{}", cut_to_file_name(path))
    });
    let cut = UNC_PATH.replace_all(&cut, |captures: &Captures<'_>| {
        cut_to_file_name(&captures[0])
    });
    let cut = DRIVE_PATH.replace_all(&cut, |captures: &Captures<'_>| {
        cut_to_file_name(&captures[0])
    });
    UUID.replace_all(&cut, |captures: &Captures<'_>| {
        let hash = blake3::keyed_hash(key, captures[0].to_ascii_lowercase().as_bytes()).to_hex();
        format!("id-{}", &hash[..HASHED_ID_LENGTH])
    })
    .into_owned()
}

// The last component of a path written with either separator, its trailing separator dropped.
fn cut_to_file_name(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(trimmed)
        .to_owned()
}

// A report's text, cut to its bound; empty text reads as a dash, since none may be empty.
fn status_text(text: &str) -> BoundedText<1, DAEMON_STATUS_TEXT_MAX_LEN> {
    let kept = cut_to_code_points(text, DAEMON_STATUS_TEXT_MAX_LEN);
    BoundedText::new(if kept.is_empty() {
        "-".to_owned()
    } else {
        kept.to_owned()
    })
    .expect("cut, non-empty text is within the bound")
}

// The platform a dump's system names, in Node's spelling where it is one of the three.
fn platform_name(os: Os) -> String {
    match os {
        Os::MacOs => "darwin".to_owned(),
        Os::Linux => "linux".to_owned(),
        Os::Windows => "win32".to_owned(),
        Os::Ios | Os::Solaris | Os::Android | Os::Ps3 | Os::NaCl | Os::Unknown(_) => {
            os.long_name().into_owned()
        }
    }
}

#[cfg(test)]
mod tests;
