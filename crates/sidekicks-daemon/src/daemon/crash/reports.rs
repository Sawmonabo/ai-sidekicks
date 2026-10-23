//! The crash report builder: each finished dump in the crash dumps folder, the service's and the
//! app's alike, becomes a report of the crashing thread's stack as module file names and offsets,
//! with no symbols read, then the dump is deleted, so the dump never outlives its report. A panic's
//! message and place join the report built from its crash, each path in them cut to its file name,
//! each credential scrubbed and each id hashed with a key this install keeps, so a forwarded report
//! names no folder, no secret and no id anyone could confirm. A dump still being written, the
//! monitor's or Crashpad's in its `new` folder, is passed over. A dump that does not build is named
//! in the service log and deleted. Every pass also deletes what a write cut short left: a partial
//! dump or a panic record without its dump in the dumps folder, and a temporary file of the key; it
//! takes each for a leftover, since the monitor exits after its one dump. While
//! `Keep crash reports` is off, no report is built and every dump, report and panic record goes.
//! Each pass is metered against its processor budget.

use std::error::Error;
use std::fs;
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
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CrashReportPass {
    /// The reports built.
    pub(crate) built: usize,
    /// The dumps that did not build, each deleted.
    pub(crate) failed: usize,
    /// The bytes of the dumps built or failed.
    pub(crate) dump_bytes: u64,
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
/// read or written.
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
    let dumps = meter
        .run_blocking(move || {
            remove_monitor_leftovers(&listed_folder)?;
            remove_atomic_write_leftovers(&key_path)?;
            list_finished_dumps(&listed_folder)
        })
        .await??;
    let mut pass = CrashReportPass::default();
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

// Deletes what a failed write of the monitor left in the dumps folder `folder`: each partial dump,
// and each panic record whose dump is not there.
fn remove_monitor_leftovers(folder: &Path) -> io::Result<()> {
    let Some(entries) = fs::read_dir(folder).none_if_missing()? else {
        return Ok(());
    };
    for entry in entries {
        let path = entry?.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let is_leftover = match name.strip_suffix(PANIC_RECORD_SUFFIX) {
            Some(stem) => !folder
                .join(format!("{stem}.{DUMP_EXTENSION}"))
                .try_exists()?,
            None => name.ends_with(DUMP_IN_PROGRESS_SUFFIX),
        };
        if is_leftover {
            fs::remove_file(&path).none_if_missing()?;
        }
    }
    Ok(())
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
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::Arc;

    use rstest::rstest;
    use sidekicks_contracts::machine::settings::MachineSettingsChange;
    use tokio_util::sync::CancellationToken;

    use super::{
        CrashReportDeps, REPORT_KEY_FILE_NAME, REPORT_KEY_LENGTH, build_crash_reports, make_key,
        read_crash_reports,
    };
    use crate::daemon::crash::monitor::{
        CRASH_DUMPS_FOLDER_NAME, DUMP_EXTENSION, DUMP_IN_PROGRESS_SUFFIX, PANIC_RECORD_SUFFIX,
        attach_crash_handler, connect_crash_monitor, crash_monitor_socket_path,
        serve_crash_monitor,
    };
    use crate::daemon::machine::settings::file::MachineSettingsFile;
    use crate::daemon::panic_hook::{install_panic_hook, send_panics_to_monitor};
    use crate::daemon::scheduler::budget::ProcessorMeter;
    use crate::daemon::service_log::CRASH_REPORTS_FOLDER_NAME;

    // The child's crash, its monitor's socket and its data folder, passed to the child.
    const CHILD_CRASH: &str = "SIDEKICKS_TEST_CRASH";
    const CHILD_SOCKET: &str = "SIDEKICKS_TEST_CRASH_SOCKET";
    const CHILD_DATA_FOLDER: &str = "SIDEKICKS_TEST_CRASH_DATA_FOLDER";

    // A secret the child holds in memory, so its dump carries it, and the session id, folder and
    // credentials its panic names.
    const PLANTED_TOKEN: &str = "planted-secret-held-in-the-crashing-stack";
    const SESSION_ID: &str = "0199f3a1-7c2e-7b44-9a51-3f0e6d2c8b17";
    const PRIVATE_FOLDER: &str = "/Users/someone/private project/src";
    const PLANTED_API_KEY: &str = "sk-plantedkey0123456789";
    const PLANTED_BEARER_TOKEN: &str = "x.y.z";

    // Runs as the crashing child: connects to the monitor, attaches the crash handler and crashes
    // as asked, a panic through the service's own hook or a bad read.
    #[expect(
        unsafe_code,
        reason = "the child reads a bad address to crash on purpose"
    )]
    fn crash_as_the_child(crash: &str) -> ! {
        let socket = PathBuf::from(std::env::var_os(CHILD_SOCKET).expect("the socket is passed"));
        let data_folder =
            PathBuf::from(std::env::var_os(CHILD_DATA_FOLDER).expect("the folder is passed"));
        // On the crashing thread's stack, which the dump holds.
        let mut held = [0_u8; PLANTED_TOKEN.len()];
        held.copy_from_slice(PLANTED_TOKEN.as_bytes());
        std::hint::black_box(&mut held);
        let client = Arc::new(connect_crash_monitor(&socket).expect("the monitor answers"));
        let _handler = attach_crash_handler(Arc::clone(&client)).expect("the handler attaches");
        if crash == "panic" {
            install_panic_hook(&data_folder, None);
            send_panics_to_monitor(client);
            panic!(
                "session {SESSION_ID} failed reading {PRIVATE_FOLDER}/main.rs:12:5 with key \
                 {PLANTED_API_KEY} and Authorization: Bearer {PLANTED_BEARER_TOKEN} ({})",
                std::hint::black_box(&held).len()
            );
        }
        // SAFETY: none holds; the read of a bad address crashes the child, which is the point.
        let crashed = unsafe { std::ptr::without_provenance::<u64>(8).read_volatile() };
        unreachable!(
            "the bad read crashed the child before it read {crashed} past {}",
            std::hint::black_box(&held).len()
        );
    }

    // Serves a monitor and runs this test's binary as a child that crashes as `crash`, then waits
    // for the monitor to write its dump.
    fn crash_a_child(crash: &str, data_folder: &Path) {
        // A folder per child: the in-process monitor's port name lives as long as this process.
        let run_folder = data_folder.join(crash);
        fs::create_dir_all(&run_folder).expect("the run folder is made");
        let socket = crash_monitor_socket_path(&run_folder, std::process::id());
        let dumps = data_folder.join(CRASH_DUMPS_FOLDER_NAME);
        let monitor_socket = socket.clone();
        let monitor = std::thread::spawn(move || serve_crash_monitor(&monitor_socket, &dumps));
        let test_path = module_path!()
            .split_once("::")
            .map(|(_crate, path)| path)
            .expect("the module path names its crate");
        let status = Command::new(std::env::current_exe().expect("the test knows its binary"))
            .args([
                "--exact",
                &format!("{test_path}::crashes_become_stripped_reports_and_none_while_off"),
                "--nocapture",
            ])
            .env(CHILD_CRASH, crash)
            .env(CHILD_SOCKET, &socket)
            .env(CHILD_DATA_FOLDER, data_folder)
            .status()
            .expect("the child runs");
        assert!(!status.success(), "the child crashed");
        monitor
            .join()
            .expect("the monitor's thread ends")
            .expect("the monitor served its child");
    }

    // A panic and a bad read in a child each leave one report of module file names and offsets;
    // the panic's report names its file and not its folder, holds the session id only as its
    // keyed hash and holds neither credential its message named, nor does either of the panic's
    // raw records, the hook's and the one the monitor writes beside the dump;
    // no report holds the secret the child's dump does; each dump is deleted once built. While
    // `Keep crash reports` is off, no report is built and every dump, report and panic record
    // goes. Killed by a path kept whole or cut at a space, by an unkeyed or raw id, by the
    // credential scrub dropped from the report or either raw record, by a dump left behind, by the
    // monitor not writing, by the switch not read, and by the raw record kept while it is off.
    #[tokio::test]
    async fn crashes_become_stripped_reports_and_none_while_off() {
        if let Ok(crash) = std::env::var(CHILD_CRASH) {
            crash_as_the_child(&crash);
        }
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let data_folder = scratch.path().join("data");
        fs::create_dir_all(&data_folder).expect("the data folder is made");
        crash_a_child("panic", &data_folder);
        crash_a_child("bad-read", &data_folder);
        let dumps = data_folder.join(CRASH_DUMPS_FOLDER_NAME);
        let dump_bytes: Vec<u8> = fs::read_dir(&dumps)
            .expect("the dumps list")
            .flat_map(|entry| fs::read(entry.expect("an entry").path()).unwrap_or_default())
            .collect();
        assert!(
            dump_bytes
                .windows(PLANTED_TOKEN.len())
                .any(|window| window == PLANTED_TOKEN.as_bytes()),
            "a dump holds the planted secret"
        );
        let monitor_records: Vec<String> = fs::read_dir(&dumps)
            .expect("the dumps list")
            .map(|entry| entry.expect("an entry").path())
            .filter(|path| path.to_string_lossy().ends_with(PANIC_RECORD_SUFFIX))
            .map(|path| fs::read_to_string(path).expect("the monitor's record reads"))
            .collect();
        assert_eq!(
            monitor_records.len(),
            1,
            "the monitor wrote the panic's record"
        );
        assert!(
            monitor_records[0].contains(SESSION_ID),
            "the monitor's record is the unstripped one"
        );
        assert!(!monitor_records[0].contains(PLANTED_API_KEY));
        assert!(!monitor_records[0].contains(PLANTED_BEARER_TOKEN));
        let settings = Arc::new(MachineSettingsFile::new(
            data_folder.join("machine-settings.json"),
        ));
        let deps = CrashReportDeps {
            data_folder: data_folder.clone(),
            settings: Arc::clone(&settings),
            app_version: "0.1.0".to_owned(),
            service_version: "0.1.0".to_owned(),
        };
        let stop = CancellationToken::new();
        let meter = ProcessorMeter::default();

        let pass = build_crash_reports(&deps, &stop, &meter)
            .await
            .expect("the pass runs");

        assert_eq!((pass.built, pass.failed), (2, 0));
        assert!(pass.dump_bytes > 0);
        assert_eq!(fs::read_dir(&dumps).expect("the dumps list").count(), 0);
        let reports = read_crash_reports(&data_folder).expect("the reports read");
        assert_eq!(reports.len(), 2);
        let report_text = serde_json::to_string(&reports).expect("the reports serialize");
        assert!(!report_text.contains(PLANTED_TOKEN));
        assert!(!report_text.contains("/Users/someone"));
        assert!(!report_text.contains("project"));
        assert!(!report_text.contains(SESSION_ID));
        assert!(!report_text.contains(PLANTED_API_KEY));
        assert!(!report_text.contains(PLANTED_BEARER_TOKEN));
        let raw_records = panic_records(&data_folder);
        assert_eq!(raw_records.len(), 1, "the panic's hook wrote its record");
        let raw_record = fs::read_to_string(&raw_records[0]).expect("the record reads");
        assert!(
            raw_record.contains(SESSION_ID),
            "the raw record is the unstripped one"
        );
        assert!(!raw_record.contains(PLANTED_API_KEY));
        assert!(!raw_record.contains(PLANTED_BEARER_TOKEN));
        for report in &reports {
            assert!(!report.stack.as_ref().is_empty(), "each report has a stack");
        }
        let panic = reports
            .iter()
            .find_map(|report| report.panic.as_ref())
            .expect("the panic's report carries it");
        let key = fs::read(data_folder.join(REPORT_KEY_FILE_NAME)).expect("the key reads");
        let key: [u8; 32] = key.try_into().expect("the key is 32 bytes");
        let hashed = blake3::keyed_hash(&key, SESSION_ID.as_bytes()).to_hex();
        assert!(
            panic
                .message
                .as_ref()
                .contains(&format!("id-{}", &hashed[..32]))
        );
        assert!(panic.message.as_ref().contains("main.rs:12:5"));
        assert!(panic.location.as_ref().starts_with("reports.rs:"));
        assert_eq!(
            reports
                .iter()
                .filter(|report| report.panic.is_some())
                .count(),
            1
        );

        settings
            .update(MachineSettingsChange::KeepCrashReports(false))
            .await
            .expect("the switch is turned off");
        fs::write(dumps.join("late.dmp"), b"a dump").expect("written");
        let pass = build_crash_reports(&deps, &stop, &meter)
            .await
            .expect("the pass runs");

        assert_eq!((pass.built, pass.failed), (0, 0));
        assert!(!dumps.join("late.dmp").exists());
        assert_eq!(panic_records(&data_folder), Vec::<PathBuf>::new());
        assert_eq!(
            read_crash_reports(&data_folder).expect("the reports read"),
            Vec::new()
        );
    }

    // What a failed write of the monitor left, a partial dump and a panic record whose dump is not
    // there, and a key's temporary file a process ended mid-write left, are deleted by a pass
    // whether reports are kept or not. Killed by a pass that reads only finished dumps, by a key's
    // temporary file kept, and by a sweep left out of either branch.
    #[rstest]
    #[case::reports_kept(true)]
    #[case::reports_off(false)]
    #[tokio::test]
    async fn a_pass_deletes_what_a_failed_dump_left(#[case] is_kept: bool) {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let data_folder = scratch.path().to_path_buf();
        let dumps = data_folder.join(CRASH_DUMPS_FOLDER_NAME);
        fs::create_dir_all(&dumps).expect("the dumps folder is made");
        let partial = format!("left.{DUMP_EXTENSION}{DUMP_IN_PROGRESS_SUFFIX}");
        fs::write(dumps.join(partial), b"part of a dump").expect("written");
        fs::write(dumps.join(format!("orphan{PANIC_RECORD_SUFFIX}")), b"{}").expect("written");
        let key_leftover = data_folder.join(format!("{REPORT_KEY_FILE_NAME}.a1b2c3.tmp"));
        fs::write(&key_leftover, b"part of a key").expect("written");
        let settings = Arc::new(MachineSettingsFile::new(
            data_folder.join("machine-settings.json"),
        ));
        settings
            .update(MachineSettingsChange::KeepCrashReports(is_kept))
            .await
            .expect("the switch is set");
        let deps = CrashReportDeps {
            data_folder,
            settings,
            app_version: "0.1.0".to_owned(),
            service_version: "0.1.0".to_owned(),
        };

        build_crash_reports(&deps, &CancellationToken::new(), &ProcessorMeter::default())
            .await
            .expect("the pass runs");

        let left: Vec<_> = fs::read_dir(&dumps)
            .expect("the dumps list")
            .map(|entry| entry.expect("an entry").file_name())
            .collect();
        assert_eq!(left, Vec::<std::ffi::OsString>::new());
        assert!(!key_leftover.exists());
    }

    // A key another pass made first stands, and the pass answers it in place of its own, leaving
    // no temporary file. Killed by replacing a key that stands, and by answering the pass's own.
    #[test]
    fn a_key_another_pass_made_first_stands() {
        let data_folder = tempfile::tempdir().expect("the test makes a temporary folder");
        let key_path = data_folder.path().join(REPORT_KEY_FILE_NAME);
        let standing = [1; REPORT_KEY_LENGTH];
        fs::write(&key_path, standing).expect("the standing key is written");

        let made = make_key(data_folder.path(), [2; REPORT_KEY_LENGTH]).expect("the key reads");

        assert_eq!(made, standing);
        let names: Vec<_> = fs::read_dir(data_folder.path())
            .expect("the data folder lists")
            .map(|entry| entry.expect("an entry").file_name())
            .collect();
        assert_eq!(names, [REPORT_KEY_FILE_NAME]);
        assert_eq!(fs::read(&key_path).expect("the key reads"), standing);
    }

    // The panic records the hook wrote into the crash reports folder.
    fn panic_records(data_folder: &Path) -> Vec<PathBuf> {
        let folder = data_folder.join(CRASH_REPORTS_FOLDER_NAME);
        fs::read_dir(folder)
            .expect("the reports folder lists")
            .map(|entry| entry.expect("an entry").path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "txt"))
            .collect()
    }
}
