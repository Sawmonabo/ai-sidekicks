//! bun, which the daemon fetches for itself at its start: its release archive for this build,
//! pinned by version and SHA-256, downloaded and checked before anything opens it, and its one
//! program unpacked into `tools/bun/<version>/`. A fetch the network or the server failed is
//! tried again on the program's retry schedule; a refusal waits for the next start.

use std::error::Error;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use reqwest::Client;
use reqwest::redirect::Policy;
use sidekicks_contracts::platform::Arch;
use sidekicks_platforms::{IS_MUSL_BUILD, PerSystem, RUNNING_ARCH, create_new_file};
use sidekicks_provider::port::bun_program::{BunProgram, BunUnavailable};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::file::publish_without_replacing::publish_without_replacing;
use sidekicks_std::file::removal_after_failure::remove_file_after_failure;
use sidekicks_std::file::version_folders::{
    remove_other_versions, remove_temporary_files, temporary_file_name,
};
use sidekicks_std::missing_entry::MissingEntry as _;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::outbound_http::download::{
    CheckedDownloadError, ExpectedDigest, download_checked,
};
use sidekicks_std::outbound_http::outbound_client_builder;
use sidekicks_std::retry::waits::retry_wait;
use sidekicks_std::scheduler::{JobCondition, ScheduleError, Scheduler};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;
use zip::ZipArchive;
use zip::result::ZipError;

/// The bun release this service pins.
pub(crate) const BUN_VERSION: &str = "1.4.4";

// Where bun's releases are downloaded from; each one answers with one redirect to GitHub's asset
// host.
const BUN_RELEASES_URL: &str = "https://github.com/oven-sh/bun/releases/download";

// The folder in the tools folder that holds bun's versions.
const BUN_FOLDER_NAME: &str = "bun";

// The archive is about 40 MB and its program about 90 MB; each cap leaves room past that.
const ARCHIVE_SIZE_CAP: u64 = 128 * 1024 * 1024;
const PROGRAM_SIZE_CAP: u64 = 256 * 1024 * 1024;

// The download holds one connection, follows GitHub's redirect and stops on a read that stalls.
const IDLE_CONNECTIONS_PER_HOST: usize = 1;
const REDIRECTS_ALLOWED: usize = 5;
const READ_TIMEOUT: Duration = Duration::from_mins(1);

// What an unpacking failure says it was doing.
const UNPACKING: &str = "unpacking bun's program";

// The job's name in the program's log.
const BUN_INSTALL_JOB: &str = "bun install";

// bun's release asset for one build: its target name, as the archive and the folder in it are
// named, and the SHA-256 the release's `SHASUMS256.txt` lists for its archive.
struct BunAsset {
    arch: Arch,
    is_musl: bool,
    target: &'static str,
    sha256: &'static str,
}

// bun's assets on one system, and the name its program has there.
struct BunSystemAssets {
    program_name: &'static str,
    assets: &'static [BunAsset],
}

// bun's x64 build picks its processor paths at run time, so no `-baseline` asset is pinned.
const BUN_ASSETS: PerSystem<BunSystemAssets> = PerSystem {
    macos: BunSystemAssets {
        program_name: "bun",
        assets: &[
            BunAsset {
                arch: Arch::Arm64,
                is_musl: false,
                target: "darwin-aarch64",
                sha256: "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510",
            },
            BunAsset {
                arch: Arch::X64,
                is_musl: false,
                target: "darwin-x64",
                sha256: "50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e",
            },
        ],
    },
    linux: BunSystemAssets {
        program_name: "bun",
        assets: &[
            BunAsset {
                arch: Arch::Arm64,
                is_musl: true,
                target: "linux-aarch64-musl",
                sha256: "57f01b02ac7113c61c935f28f38c2eab849e3c970dab21f8b640a87b1ef65009",
            },
            BunAsset {
                arch: Arch::Arm64,
                is_musl: false,
                target: "linux-aarch64",
                sha256: "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e",
            },
            BunAsset {
                arch: Arch::X64,
                is_musl: true,
                target: "linux-x64-musl",
                sha256: "a5a8ccc5e74dcb883fe974f125a7bdb3b41e5195ed1b870e73f17effd3eb2b2d",
            },
            BunAsset {
                arch: Arch::X64,
                is_musl: false,
                target: "linux-x64",
                sha256: "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c",
            },
        ],
    },
    windows: BunSystemAssets {
        program_name: "bun.exe",
        assets: &[
            BunAsset {
                arch: Arch::Arm64,
                is_musl: false,
                target: "windows-aarch64",
                sha256: "2d57a0eec0cb44d95c918c3f9734f60455a1306ae5085d76fc68f44e3ee30d09",
            },
            BunAsset {
                arch: Arch::X64,
                is_musl: false,
                target: "windows-x64",
                sha256: "cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5",
            },
        ],
    },
};

/// The bun release one install fetches: its version, its archive's target, its program's name
/// and the digest its archive must have.
#[derive(Clone, Debug)]
pub(crate) struct BunPin {
    /// The version, which names its folder.
    version: &'static str,
    /// The target its archive and the folder in it are named for.
    target: &'static str,
    /// The program's file name.
    program_name: &'static str,
    /// The archive's digest.
    digest: ExpectedDigest,
}

impl BunPin {
    /// The pinned release's asset for this build's system, processor and C library.
    pub(crate) fn running() -> Self {
        let system = BUN_ASSETS.native();
        let asset = system
            .assets
            .iter()
            .find(|asset| asset.arch == RUNNING_ARCH && asset.is_musl == IS_MUSL_BUILD)
            .expect("bun's release has an asset for every build the service ships");
        let mut digest = [0; 32];
        base16ct::lower::decode(asset.sha256, &mut digest)
            .expect("each pinned SHA-256 is 64 lowercase hex digits");
        Self {
            version: BUN_VERSION,
            target: asset.target,
            program_name: system.program_name,
            digest: ExpectedDigest::Sha256(digest),
        }
    }

    // The archive's address under `releases_url`.
    fn archive_url(&self, releases_url: &str) -> String {
        format!(
            "{releases_url}/bun-v{}/bun-{}.zip",
            self.version, self.target
        )
    }

    // The program's entry in the archive.
    fn entry_name(&self) -> String {
        format!("bun-{}/{}", self.target, self.program_name)
    }
}

/// Where the install stands, as a step that needs bun waits on it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BunInstallState {
    /// The fetch is under way or waits to be tried again.
    Installing,
    /// bun is installed at this path.
    Installed(PathBuf),
    /// The fetch was refused, for these words, until the next start.
    Refused(String),
}

/// The daemon's copy of bun: fetched, checked and installed in the background, and answered to a
/// driver once it is in place.
pub(crate) struct BunInstall {
    /// `tools/bun/`, which holds one folder per version.
    bun_folder: PathBuf,
    /// The client the archive is downloaded through.
    client: Client,
    /// The address the release folders sit under.
    releases_url: String,
    /// The release to install.
    pin: BunPin,
    /// Where the install stands.
    state: watch::Sender<BunInstallState>,
    /// The run under way or the last one, which a due run checks before starting another.
    task: Mutex<Option<AbortOnDropHandle<()>>>,
}

/// Why one install run failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum BunInstallError {
    /// The scheduler's stop ended the run; nothing it made is left.
    #[error("the daemon's stop ended bun's install")]
    Stopped,
    /// The archive could not be downloaded or did not pass its check.
    #[error("bun's archive could not be downloaded")]
    Download(#[source] CleanupFailures<CheckedDownloadError, io::Error>),
    /// bun's folder could not be read, made or cleared.
    #[error("bun's folder could not be prepared")]
    Folder(#[source] io::Error),
    /// The system gave no random bytes for a temporary file's name.
    #[error("a temporary file for bun could not be named")]
    TemporaryName(#[source] getrandom::Error),
    /// The checked archive is not one the program can be read from.
    #[error("bun's archive could not be read")]
    Archive(#[source] ZipError),
    /// The archive holds no regular file at the program's entry, or one past its size cap.
    #[error("bun's archive holds no program at {0}, or one past {PROGRAM_SIZE_CAP} bytes")]
    ProgramRefused(String),
    /// The program could not be written out of the archive.
    #[error("bun's program could not be unpacked")]
    Unpack(#[source] CleanupFailures<io::Error>),
    /// The program could not be given its name.
    #[error("bun's program could not be named")]
    Publish(#[source] CleanupFailures<io::Error>),
    /// The unpacking task ended without an answer.
    #[error("bun's unpacking ended without an answer")]
    UnpackTask(#[source] tokio::task::JoinError),
}

impl BunInstallError {
    // Whether a later run can end differently: a network, server or disk failure can, while a
    // refused archive would only be fetched again for the same refusal.
    fn is_passing(&self) -> bool {
        match self {
            Self::Download(failure) => failure.original().is_passing(),
            Self::Folder(_) | Self::TemporaryName(_) | Self::Unpack(_) | Self::Publish(_) => true,
            Self::Stopped | Self::Archive(_) | Self::ProgramRefused(_) | Self::UnpackTask(_) => {
                false
            }
        }
    }
}

impl BunInstall {
    /// The install of this build's pinned bun into `tools_folder`, fetched from bun's releases
    /// over `https` alone. Fails when the client cannot be built.
    pub(crate) fn for_release(tools_folder: &Path) -> Result<Self, reqwest::Error> {
        let client = outbound_client_builder(IDLE_CONNECTIONS_PER_HOST)
            .https_only(true)
            .redirect(Policy::limited(REDIRECTS_ALLOWED))
            .read_timeout(READ_TIMEOUT)
            .build()?;
        Ok(Self::new(
            tools_folder,
            client,
            BUN_RELEASES_URL.to_owned(),
            BunPin::running(),
        ))
    }

    /// The install of `pin` into `tools_folder`, its archive downloaded through `client` from
    /// under `releases_url`; nothing runs until it is scheduled.
    pub(crate) fn new(
        tools_folder: &Path,
        client: Client,
        releases_url: String,
        pin: BunPin,
    ) -> Self {
        Self {
            bun_folder: tools_folder.join(BUN_FOLDER_NAME),
            client,
            releases_url,
            pin,
            state: watch::Sender::new(BunInstallState::Installing),
            task: Mutex::new(None),
        }
    }

    // One install run: what a stopped run left goes, a program already in place answers with no
    // request, and otherwise the archive is downloaded, checked and its program unpacked and
    // named; then every other version goes.
    async fn install(&self, stop: &CancellationToken) -> Result<PathBuf, BunInstallError> {
        let version_folder = self.bun_folder.join(self.pin.version);
        let program = version_folder.join(self.pin.program_name);
        remove_temporary_files(&self.bun_folder)
            .await
            .map_err(BunInstallError::Folder)?;
        remove_temporary_files(&version_folder)
            .await
            .map_err(BunInstallError::Folder)?;
        if tokio::fs::try_exists(&program)
            .await
            .map_err(BunInstallError::Folder)?
        {
            // Every other version, each about 90 MB, goes.
            remove_other_versions(&self.bun_folder, &[self.pin.version])
                .await
                .map_err(BunInstallError::Folder)?;
            return Ok(program);
        }
        tokio::fs::create_dir_all(&version_folder)
            .await
            .map_err(BunInstallError::Folder)?;
        let archive = self
            .bun_folder
            .join(temporary_file_name(".zip").map_err(BunInstallError::TemporaryName)?);
        let url = self.pin.archive_url(&self.releases_url);
        tokio::select! {
            biased;
            () = stop.cancelled() => {
                tokio::fs::remove_file(&archive)
                    .await
                    .none_if_missing()
                    .map_err(BunInstallError::Folder)?;
                return Err(BunInstallError::Stopped);
            }
            downloaded = download_checked(
                &self.client,
                &url,
                &self.pin.digest,
                ARCHIVE_SIZE_CAP,
                &archive,
            ) => downloaded.map_err(BunInstallError::Download)?,
        }
        let unpacked = {
            let (archive, entry_name, unpacked) = (
                archive.clone(),
                self.pin.entry_name(),
                version_folder
                    .join(temporary_file_name("").map_err(BunInstallError::TemporaryName)?),
            );
            tokio::task::spawn_blocking(move || unpack_program(&archive, &entry_name, &unpacked))
                .await
        };
        tokio::fs::remove_file(&archive)
            .await
            .none_if_missing()
            .map_err(BunInstallError::Folder)?;
        let unpacked = unpacked.map_err(BunInstallError::UnpackTask)??;
        if stop.is_cancelled() {
            tokio::fs::remove_file(&unpacked)
                .await
                .none_if_missing()
                .map_err(BunInstallError::Folder)?;
            return Err(BunInstallError::Stopped);
        }
        // Another run's program already named answers as this one's.
        publish_without_replacing(&unpacked, &program)
            .await
            .map_err(BunInstallError::Publish)?;
        // Every other version, each about 90 MB, goes.
        remove_other_versions(&self.bun_folder, &[self.pin.version])
            .await
            .map_err(BunInstallError::Folder)?;
        Ok(program)
    }
}

impl BunProgram for BunInstall {
    fn bun_program(&self) -> BoxFuture<'_, Result<PathBuf, BunUnavailable>> {
        let mut state = self.state.subscribe();
        async move {
            loop {
                let settled = match &*state.borrow_and_update() {
                    BunInstallState::Installing => None,
                    BunInstallState::Installed(program) => Some(Ok(program.clone())),
                    BunInstallState::Refused(refusal) => Some(Err(BunUnavailable {
                        refusal: refusal.clone(),
                    })),
                };
                if let Some(settled) = settled {
                    return settled;
                }
                state
                    .changed()
                    .await
                    .expect("the install holds its state's sender while it is borrowed");
            }
        }
        .boxed()
    }
}

/// Schedules `install`'s first run on `scheduler` at once. Each due run starts the install on its
/// own task, so the scheduler's other jobs never wait on the download, and starts nothing while
/// one is live. A run that fails for a passing cause schedules the next on the program's retry
/// schedule; any other failure leaves the install refused until the next start. Fails when the
/// scheduler has stopped.
pub(crate) fn schedule_bun_install(
    install: Arc<BunInstall>,
    scheduler: &Arc<Scheduler>,
) -> Result<(), ScheduleError> {
    schedule_install_run(
        install,
        Arc::downgrade(scheduler),
        scheduler,
        Duration::ZERO,
        0,
    )
}

// Schedules one run `delay` from now, after `failed_tries` runs that failed for a passing cause.
fn schedule_install_run(
    install: Arc<BunInstall>,
    scheduler_handle: Weak<Scheduler>,
    scheduler: &Scheduler,
    delay: Duration,
    failed_tries: usize,
) -> Result<(), ScheduleError> {
    scheduler
        .schedule(BUN_INSTALL_JOB, JobCondition::Always, delay, move |stop| {
            start_install_task(&install, scheduler_handle.clone(), failed_tries, stop);
            async { Ok(()) }.boxed()
        })
        .map(drop)
}

// Starts one install run on its own task, ended by the scheduler's `stop`, unless a run is live.
fn start_install_task(
    install: &Arc<BunInstall>,
    scheduler_handle: Weak<Scheduler>,
    failed_tries: usize,
    stop: CancellationToken,
) {
    let mut task = lock(&install.task);
    if task.as_ref().is_some_and(|task| !task.is_finished()) {
        return;
    }
    let running = Arc::clone(install);
    *task = Some(AbortOnDropHandle::new(tokio::spawn(async move {
        run_install(running, scheduler_handle, failed_tries, stop).await;
    })));
}

// One install run to its end: installed, refused until the next start, or scheduled again on the
// retry schedule after a passing failure.
async fn run_install(
    install: Arc<BunInstall>,
    scheduler_handle: Weak<Scheduler>,
    failed_tries: usize,
    stop: CancellationToken,
) {
    let failure = match install.install(&stop).await {
        Ok(program) => {
            install
                .state
                .send_replace(BunInstallState::Installed(program));
            return;
        }
        Err(BunInstallError::Stopped) => return,
        Err(failure) => failure,
    };
    if !failure.is_passing() {
        tracing::error!(
            error = &failure as &(dyn Error + 'static),
            "bun's install was refused until the next start"
        );
        install
            .state
            .send_replace(BunInstallState::Refused(describe_error(&failure)));
        return;
    }
    tracing::warn!(
        error = &failure as &(dyn Error + 'static),
        "bun's install failed and will be tried again"
    );
    let Some(scheduler) = scheduler_handle.upgrade() else {
        return;
    };
    match schedule_install_run(
        install,
        scheduler_handle,
        &scheduler,
        retry_wait(failed_tries),
        failed_tries + 1,
    ) {
        Ok(()) | Err(ScheduleError::Stopped { .. }) => {}
        Err(refused) => tracing::error!(
            error = &refused as &(dyn Error + 'static),
            "bun's next install run could not be scheduled"
        ),
    }
}

// Writes the regular file at `entry_name` in the checked `archive` to a new executable file at
// `unpacked` and answers its path. An encrypted entry, a link, a folder or an entry past its cap is
// refused; the archive's own mode is not kept. Reads and writes files, so it runs off the async
// workers.
fn unpack_program(
    archive: &Path,
    entry_name: &str,
    unpacked: &Path,
) -> Result<PathBuf, BunInstallError> {
    let archive = File::open(archive).map_err(BunInstallError::Folder)?;
    let mut archive = ZipArchive::new(archive).map_err(BunInstallError::Archive)?;
    let mut entry = match archive.by_name(entry_name) {
        Ok(entry) => entry,
        Err(ZipError::FileNotFound) => {
            return Err(BunInstallError::ProgramRefused(entry_name.to_owned()));
        }
        Err(error) => return Err(BunInstallError::Archive(error)),
    };
    if !entry.is_file() || entry.size() > PROGRAM_SIZE_CAP {
        return Err(BunInstallError::ProgramRefused(entry_name.to_owned()));
    }
    let mut file = create_new_file(unpacked, 0o755).map_err(|error| {
        BunInstallError::Unpack(CleanupFailures::new(error, Vec::new(), UNPACKING))
    })?;
    let written = io::copy(&mut entry, &mut file).and_then(|_copied| file.sync_all());
    // Closed before any removal, which Windows refuses for an open file.
    drop(file);
    match written {
        Ok(()) => Ok(unpacked.to_path_buf()),
        Err(error) => Err(BunInstallError::Unpack(remove_file_after_failure(
            error, unpacked, UNPACKING,
        ))),
    }
}

#[cfg(test)]
mod tests;
