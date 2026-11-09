//! The Agent SDK's one file, fetched for a Claude Code version from the npm registry on a task of
//! its own and checked by the registry's SHA-512 before it is unpacked, and the fork of a Claude
//! Code conversation its `forkSession` makes under bun.

use std::collections::HashMap;
use std::error::Error;
use std::fs::File;
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use flate2::read::GzDecoder;
use reqwest::redirect::Policy;
use reqwest::{Client, Url};
use semver::Version;
use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_platforms::create_new_file;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::file::publish_without_replacing::publish_without_replacing;
use sidekicks_std::file::removal_after_failure::remove_file_after_failure;
use sidekicks_std::file::version_folders::{
    remove_other_versions, remove_temporary_files, temporary_file_name,
};
use sidekicks_std::missing_entry::MissingEntry as _;
use sidekicks_std::outbound_http::download::{
    CheckedDownloadError, ExpectedDigest, download_checked,
};
use sidekicks_std::outbound_http::{CappedBodyError, outbound_client_builder, read_capped_body};
use sidekicks_std::retry::waits::retry_wait;
use tokio::sync::{Mutex, watch};
use tokio_util::task::AbortOnDropHandle;

mod fork;

// The registry's full record of the SDK's releases, the one form that names each release's
// Claude Code.
const AGENT_SDK_RECORD_URL: &str = "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk";

// The folder in the tools folder that holds one folder per Claude Code version.
const AGENT_SDK_FOLDER_NAME: &str = "claude-agent-sdk";

// The SDK's one file, as it is kept and as its tarball names it.
const SDK_FILE_NAME: &str = "sdk.mjs";
const SDK_ENTRY_PATH: &[u8] = b"package/sdk.mjs";

// The record is about 1.1 MB, a tarball up to 30 MB and its tar up to 81 MB, and the file up to
// 1.4 MB; each cap leaves room past that.
const RECORD_SIZE_CAP: usize = 32 * 1024 * 1024;
const TARBALL_SIZE_CAP: u64 = 32 * 1024 * 1024;
const TAR_SIZE_CAP: u64 = 128 * 1024 * 1024;
const SDK_FILE_SIZE_CAP: u64 = 8 * 1024 * 1024;

// Both reads hold one connection and stop on a read that stalls.
const IDLE_CONNECTIONS_PER_HOST: usize = 1;
const READ_TIMEOUT: Duration = Duration::from_mins(1);

// The integrity member this check reads.
const SHA512_MEMBER_PREFIX: &str = "sha512-";

// What an unpacking failure says it was doing.
const UNPACKING: &str = "unpacking the Agent SDK's file";

/// The Agent SDK's files a driver fetches through, or why their client could not be built, which
/// the fork that needs the file answers with.
pub(crate) type ClaudeAgentSdkClient = Result<Arc<ClaudeAgentSdk>, Arc<reqwest::Error>>;

/// The Agent SDK's file for each Claude Code version asked since the daemon started, fetched on a
/// task of its own per version and kept in `tools/claude-agent-sdk/<version>/`.
pub(crate) struct ClaudeAgentSdk {
    /// `tools/claude-agent-sdk/`, which holds one folder per Claude Code version.
    sdk_folder: PathBuf,
    /// The client the record and the tarballs are read through.
    client: Client,
    /// The registry's record of the SDK's releases.
    record_url: Url,
    /// Each version asked since the daemon started, with its last fetch; the sweep holds it from
    /// reading its keys to its last removal.
    fetches: Arc<Mutex<HashMap<Version, AgentSdkFetch>>>,
}

// One version's fetch: where it stands, and its task, which ends with the table.
struct AgentSdkFetch {
    state: watch::Receiver<AgentSdkFetchState>,
    task: AbortOnDropHandle<()>,
}

// Where one fetch stands.
enum AgentSdkFetchState {
    Fetching,
    Fetched(AgentSdkModule),
    Failed(Arc<AgentSdkFetchError>),
}

impl AgentSdkFetchState {
    // The fetch's answer once it has one.
    fn settled(&self) -> Option<Result<AgentSdkModule, Arc<AgentSdkFetchError>>> {
        match self {
            Self::Fetching => None,
            Self::Fetched(module) => Some(Ok(module.clone())),
            Self::Failed(failure) => Some(Err(Arc::clone(failure))),
        }
    }
}

// What a fetch asked for finds of a refused fetch: kept for a session start's fetch, which only
// readies the file, or fetched again for the undo, which needs it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SettledRefusal {
    Kept,
    FetchedAgain,
}

/// The version folder holding `sdk.mjs`; the fork runs bun in this folder and imports `sdk.mjs`
/// from it by path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AgentSdkModule {
    /// The folder `sdk.mjs` is in.
    folder: PathBuf,
}

/// Why a fetch of the Agent SDK's file failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum AgentSdkFetchError {
    /// The registry's record could not be requested, or it answered something other than success.
    #[error("the Agent SDK's registry record could not be fetched")]
    Record(#[source] CheckedDownloadError),
    /// The record's body could not be read, or it passed its cap.
    #[error("the Agent SDK's registry record could not be read")]
    RecordBody(#[source] CappedBodyError),
    /// The record is not the registry's JSON.
    #[error("the Agent SDK's registry record could not be parsed")]
    RecordParse(#[source] serde_json::Error),
    /// No release names this Claude Code version.
    #[error("no Agent SDK release names Claude Code {claude_code_version}")]
    NoPairedRelease {
        /// The Claude Code version asked.
        claude_code_version: Version,
    },
    /// The paired release carries no SHA-512 its tarball can be checked by.
    #[error("the paired Agent SDK release carries no SHA-512 integrity")]
    Integrity,
    /// The paired release's tarball is not at the record's origin.
    #[error("the paired Agent SDK release's tarball is not at the registry's origin")]
    ForeignTarball,
    /// The tarball could not be downloaded or did not pass its check.
    #[error("the Agent SDK's tarball could not be downloaded")]
    Download(#[source] CleanupFailures<CheckedDownloadError, io::Error>),
    /// The version's folder could not be read, made or cleared.
    #[error("the Agent SDK's folder could not be prepared")]
    Folder(#[source] io::Error),
    /// The system gave no random bytes for a temporary file's name.
    #[error("a temporary file for the Agent SDK could not be named")]
    TemporaryName(#[source] getrandom::Error),
    /// The checked tarball's gzip or tar stream does not read.
    #[error("the Agent SDK's tarball could not be read")]
    Archive(#[source] io::Error),
    /// The tarball's tar reached its cap.
    #[error("the Agent SDK's tarball unpacks past {TAR_SIZE_CAP} bytes")]
    ArchiveTooLarge,
    /// The tarball's `package/sdk.mjs` is refused, for the reason it carries.
    #[error("the Agent SDK's tarball's package/sdk.mjs is refused: {0}")]
    EntryRefused(&'static str),
    /// The tarball holds no `package/sdk.mjs`.
    #[error("the Agent SDK's tarball holds no package/sdk.mjs")]
    MissingEntry,
    /// The file could not be made or written.
    #[error("the Agent SDK's file could not be unpacked")]
    Unpack(#[source] CleanupFailures<io::Error>),
    /// The file could not be given its name.
    #[error("the Agent SDK's file could not be named")]
    Publish(#[source] CleanupFailures<io::Error>),
    /// A blocking step ended without an answer.
    #[error("a step of the Agent SDK's fetch ended without an answer")]
    Task(#[source] tokio::task::JoinError),
    /// The fetch's task ended with no answer.
    #[error("the Agent SDK's fetch ended without an answer")]
    Ended,
}

impl AgentSdkFetchError {
    // Whether a later try can end differently: a network, server or disk failure can, while a
    // refused record or tarball would only be fetched again for the same refusal.
    fn is_passing(&self) -> bool {
        match self {
            Self::Record(failure) => failure.is_passing(),
            Self::RecordBody(failure) => match failure {
                CappedBodyError::Read(_) => true,
                CappedBodyError::TooLarge { .. } => false,
            },
            Self::Download(failure) => failure.original().is_passing(),
            Self::Folder(_) | Self::TemporaryName(_) | Self::Unpack(_) | Self::Publish(_) => true,
            Self::RecordParse(_)
            | Self::NoPairedRelease { .. }
            | Self::Integrity
            | Self::ForeignTarball
            | Self::Archive(_)
            | Self::ArchiveTooLarge
            | Self::EntryRefused(_)
            | Self::MissingEntry
            | Self::Task(_)
            | Self::Ended => false,
        }
    }
}

impl ClaudeAgentSdk {
    /// The SDK's files under `tools_folder`, fetched from the npm registry over `https` alone, or
    /// the failure to build their client.
    pub(crate) fn for_registry(tools_folder: &Path) -> ClaudeAgentSdkClient {
        let client = outbound_client_builder(IDLE_CONNECTIONS_PER_HOST)
            .https_only(true)
            .redirect(Policy::none())
            .read_timeout(READ_TIMEOUT)
            .build()
            .map_err(Arc::new)?;
        let record_url =
            Url::parse(AGENT_SDK_RECORD_URL).expect("the registry's record address parses");
        Ok(Arc::new(Self::new(tools_folder, client, record_url)))
    }

    /// The SDK's files under `tools_folder`, the record read through `client` from `record_url`
    /// and each tarball from the same origin; nothing is fetched until a version is asked.
    pub(crate) fn new(tools_folder: &Path, client: Client, record_url: Url) -> Self {
        Self {
            sdk_folder: tools_folder.join(AGENT_SDK_FOLDER_NAME),
            client,
            record_url,
            fetches: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Starts the fetch for `claude_code_version` unless one is live or one was refused, and
    /// answers once it is started, without waiting on it; a refusal stands for the daemon's run,
    /// so each session start does not fetch the record again for the same refusal.
    pub(crate) async fn start_fetch(&self, claude_code_version: &Version) {
        drop(
            self.fetch_for(claude_code_version, SettledRefusal::Kept)
                .await,
        );
    }

    /// The SDK's file for `claude_code_version`, from a live fetch, a new one, or the folder
    /// already holding it; a passing failure is tried again until it ends, so the caller bounds
    /// the wait. Fails with the fetch's refusal, or with `Ended` when its task ended unanswered.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the undo's fork before Claude Code's last compaction runs it"
        )
    )]
    pub(crate) async fn ensure_for(
        &self,
        claude_code_version: &Version,
    ) -> Result<AgentSdkModule, Arc<AgentSdkFetchError>> {
        let mut state = self
            .fetch_for(claude_code_version, SettledRefusal::FetchedAgain)
            .await;
        let mut settled = None;
        // A closed channel with no answer leaves `settled` empty.
        drop(
            state
                .wait_for(|state| {
                    settled = state.settled();
                    settled.is_some()
                })
                .await,
        );
        settled.unwrap_or_else(|| Err(Arc::new(AgentSdkFetchError::Ended)))
    }

    // The live fetch for `claude_code_version`, a refused one where `refusal` keeps it, or a new
    // one in place of a settled one.
    async fn fetch_for(
        &self,
        claude_code_version: &Version,
        refusal: SettledRefusal,
    ) -> watch::Receiver<AgentSdkFetchState> {
        let mut fetches = self.fetches.lock().await;
        if let Some(fetch) = fetches.get(claude_code_version)
            && (!fetch.task.is_finished()
                || (refusal == SettledRefusal::Kept
                    && matches!(*fetch.state.borrow(), AgentSdkFetchState::Failed(_))))
        {
            return fetch.state.clone();
        }
        let (sender, state) = watch::channel(AgentSdkFetchState::Fetching);
        let attempt = AgentSdkAttempt {
            client: self.client.clone(),
            record_url: self.record_url.clone(),
            sdk_folder: self.sdk_folder.clone(),
            claude_code_version: claude_code_version.clone(),
            fetches: Arc::downgrade(&self.fetches),
        };
        let task = AbortOnDropHandle::new(tokio::spawn(run_fetch(attempt, sender)));
        fetches.insert(
            claude_code_version.clone(),
            AgentSdkFetch {
                state: state.clone(),
                task,
            },
        );
        state
    }
}

// What one version's fetch task holds: no table, so its tasks keep none alive.
struct AgentSdkAttempt {
    client: Client,
    record_url: Url,
    sdk_folder: PathBuf,
    claude_code_version: Version,
    fetches: Weak<Mutex<HashMap<Version, AgentSdkFetch>>>,
}

// The release a Claude Code version pairs with: its tarball and the digest it must have.
struct AgentSdkRelease {
    tarball_url: Url,
    digest: [u8; 64],
}

// The record's releases, each kept only for its Claude Code and its `dist`, which is parsed only
// for the chosen release, so one malformed release does not fail the record.
#[derive(Deserialize)]
struct PackageRecord {
    versions: HashMap<String, ReleaseRecord>,
}

#[derive(Deserialize)]
struct ReleaseRecord {
    #[serde(rename = "claudeCodeVersion")]
    claude_code_version: Option<serde_json::Value>,
    dist: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
struct ReleaseDist {
    tarball: String,
    integrity: Option<String>,
}

// Runs tries until one answers or is refused, waiting on the retry schedule after each passing
// failure.
async fn run_fetch(attempt: AgentSdkAttempt, state: watch::Sender<AgentSdkFetchState>) {
    let mut failed_tries = 0;
    loop {
        let failure = match attempt.fetch().await {
            Ok(module) => {
                state.send_replace(AgentSdkFetchState::Fetched(module));
                return;
            }
            Err(failure) => failure,
        };
        if !failure.is_passing() {
            tracing::error!(
                error = &failure as &(dyn Error + 'static),
                claude_code_version = %attempt.claude_code_version,
                "the Agent SDK's fetch was refused"
            );
            state.send_replace(AgentSdkFetchState::Failed(Arc::new(failure)));
            return;
        }
        tracing::warn!(
            error = &failure as &(dyn Error + 'static),
            claude_code_version = %attempt.claude_code_version,
            "the Agent SDK's fetch failed and will be tried again"
        );
        tokio::time::sleep(retry_wait(failed_tries)).await;
        failed_tries += 1;
    }
}

impl AgentSdkAttempt {
    // One try: what a stopped try left goes, a file already in place answers with no request,
    // and otherwise the paired release's tarball is downloaded, checked and its file unpacked and
    // named; then every version folder no call has asked for goes.
    async fn fetch(&self) -> Result<AgentSdkModule, AgentSdkFetchError> {
        let folder = self.sdk_folder.join(self.claude_code_version.to_string());
        let sdk_file = folder.join(SDK_FILE_NAME);
        remove_temporary_files(&folder)
            .await
            .map_err(AgentSdkFetchError::Folder)?;
        if !tokio::fs::try_exists(&sdk_file)
            .await
            .map_err(AgentSdkFetchError::Folder)?
        {
            self.download(&folder, &sdk_file).await?;
        }
        self.remove_unasked_versions().await?;
        Ok(AgentSdkModule { folder })
    }

    // Reads the record, downloads the paired release's tarball into `folder` and names its
    // `package/sdk.mjs` `sdk_file`.
    async fn download(&self, folder: &Path, sdk_file: &Path) -> Result<(), AgentSdkFetchError> {
        let response = self
            .client
            .get(self.record_url.clone())
            .send()
            .await
            .map_err(|error| {
                AgentSdkFetchError::Record(CheckedDownloadError::Request(error.without_url()))
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(AgentSdkFetchError::Record(CheckedDownloadError::Status(
                status,
            )));
        }
        let body = read_capped_body(response, RECORD_SIZE_CAP)
            .await
            .map_err(AgentSdkFetchError::RecordBody)?;
        let release = {
            let (version, record_url) = (self.claude_code_version.clone(), self.record_url.clone());
            tokio::task::spawn_blocking(move || choose_release(&body, &version, &record_url))
                .await
                .map_err(AgentSdkFetchError::Task)??
        };
        tokio::fs::create_dir_all(folder)
            .await
            .map_err(AgentSdkFetchError::Folder)?;
        let name = |extension| {
            temporary_file_name(extension)
                .map(|name| folder.join(name))
                .map_err(AgentSdkFetchError::TemporaryName)
        };
        let (tarball, unpacked) = (name(".tgz")?, name("")?);
        download_checked(
            &self.client,
            release.tarball_url.as_str(),
            &ExpectedDigest::Sha512(release.digest),
            TARBALL_SIZE_CAP,
            &tarball,
        )
        .await
        .map_err(AgentSdkFetchError::Download)?;
        let taken = {
            let (tarball, unpacked) = (tarball.clone(), unpacked.clone());
            tokio::task::spawn_blocking(move || take_sdk_file(&tarball, &unpacked)).await
        };
        tokio::fs::remove_file(&tarball)
            .await
            .none_if_missing()
            .map_err(AgentSdkFetchError::Folder)?;
        taken.map_err(AgentSdkFetchError::Task)??;
        // Another fetch's file already named answers as this one's.
        publish_without_replacing(&unpacked, sdk_file)
            .await
            .map_err(AgentSdkFetchError::Publish)?;
        Ok(())
    }

    // Removes every version folder whose version no call has asked for since the daemon started,
    // holding the table so a version asked meanwhile is either kept or fetched again after.
    async fn remove_unasked_versions(&self) -> Result<(), AgentSdkFetchError> {
        let Some(fetches) = self.fetches.upgrade() else {
            return Ok(());
        };
        let fetches = fetches.lock().await;
        let asked: Vec<String> = fetches.keys().map(Version::to_string).collect();
        let asked: Vec<&str> = asked.iter().map(String::as_str).collect();
        remove_other_versions(&self.sdk_folder, &asked)
            .await
            .map_err(AgentSdkFetchError::Folder)
    }
}

// The release whose `claudeCodeVersion` is `claude_code_version`, the highest SDK version among
// several, with its tarball's address, which must have `record_url`'s origin, and its SHA-512.
fn choose_release(
    record: &[u8],
    claude_code_version: &Version,
    record_url: &Url,
) -> Result<AgentSdkRelease, AgentSdkFetchError> {
    let record: PackageRecord =
        serde_json::from_slice(record).map_err(AgentSdkFetchError::RecordParse)?;
    let paired = record
        .versions
        .into_iter()
        .filter_map(|(sdk_version, release)| {
            let named = Version::parse(release.claude_code_version.as_ref()?.as_str()?).ok()?;
            let sdk_version = Version::parse(&sdk_version).ok()?;
            (named == *claude_code_version).then_some((sdk_version, release.dist))
        })
        .max_by(|(left, _), (right, _)| left.cmp(right));
    let Some((_sdk_version, dist)) = paired else {
        return Err(AgentSdkFetchError::NoPairedRelease {
            claude_code_version: claude_code_version.clone(),
        });
    };
    let dist = dist.ok_or(AgentSdkFetchError::Integrity)?;
    let dist: ReleaseDist =
        serde_json::from_str(dist.get()).map_err(AgentSdkFetchError::RecordParse)?;
    let digest = dist
        .integrity
        .as_deref()
        .and_then(sha512_digest)
        .ok_or(AgentSdkFetchError::Integrity)?;
    let tarball_url = Url::parse(&dist.tarball)
        .ok()
        .filter(|tarball_url| tarball_url.origin() == record_url.origin())
        .ok_or(AgentSdkFetchError::ForeignTarball)?;
    Ok(AgentSdkRelease {
        tarball_url,
        digest,
    })
}

// The SHA-512 of a Subresource Integrity string: its first `sha512-` member, anything after a
// `?` dropped, decoded to exactly 64 bytes.
fn sha512_digest(integrity: &str) -> Option<[u8; 64]> {
    let member = integrity
        .split_whitespace()
        .find_map(|member| member.strip_prefix(SHA512_MEMBER_PREFIX))?;
    let encoded = member
        .split_once('?')
        .map_or(member, |(encoded, _)| encoded);
    STANDARD.decode(encoded).ok()?.try_into().ok()
}

// Writes the checked `tarball`'s one regular `package/sdk.mjs` to a new file at `unpacked`, made
// readable by its owner alone. Every entry is read, the tar held to its cap, and the file is
// written only once the whole tarball has passed, so a refusal leaves nothing behind. Reads and
// writes files, so it runs off the async workers.
fn take_sdk_file(tarball: &Path, unpacked: &Path) -> Result<(), AgentSdkFetchError> {
    let tarball = File::open(tarball).map_err(AgentSdkFetchError::Folder)?;
    let mut archive = tar::Archive::new(GzDecoder::new(tarball).take(TAR_SIZE_CAP));
    let read = read_sdk_entry(&mut archive);
    // A stream that reached the cap is refused however its read ended, and a cap that falls on an
    // entry's boundary ends the entries as the archive's end would.
    if archive.into_inner().limit() == 0 {
        return Err(AgentSdkFetchError::ArchiveTooLarge);
    }
    let sdk_bytes = read?.ok_or(AgentSdkFetchError::MissingEntry)?;
    let mut file = create_new_file(unpacked, 0o600).map_err(|error| {
        AgentSdkFetchError::Unpack(CleanupFailures::new(error, Vec::new(), UNPACKING))
    })?;
    let written = file.write_all(&sdk_bytes).and_then(|()| file.sync_all());
    // Closed before any removal, which Windows refuses for an open file.
    drop(file);
    written.map_err(|error| {
        AgentSdkFetchError::Unpack(remove_file_after_failure(error, unpacked, UNPACKING))
    })
}

// Reads every entry of `archive` and answers the bytes of its one regular `package/sdk.mjs` held
// to its cap, or none when it has no such entry.
fn read_sdk_entry(
    archive: &mut tar::Archive<impl io::Read>,
) -> Result<Option<Vec<u8>>, AgentSdkFetchError> {
    let mut sdk_bytes = None;
    for entry in archive.entries().map_err(AgentSdkFetchError::Archive)? {
        let mut entry = entry.map_err(AgentSdkFetchError::Archive)?;
        if entry.path_bytes().as_ref() != SDK_ENTRY_PATH {
            continue;
        }
        if sdk_bytes.is_some() {
            return Err(AgentSdkFetchError::EntryRefused("it is there twice"));
        }
        if !entry.header().entry_type().is_file() {
            return Err(AgentSdkFetchError::EntryRefused("it is not a regular file"));
        }
        let size = entry.size();
        if size > SDK_FILE_SIZE_CAP {
            return Err(AgentSdkFetchError::EntryRefused("it is past 8 MiB"));
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(AgentSdkFetchError::Archive)?;
        // A stream cut inside the entry reads short, with no error.
        if bytes.len() as u64 != size {
            return Err(AgentSdkFetchError::EntryRefused(
                "it ends short of its size",
            ));
        }
        sdk_bytes = Some(bytes);
    }
    Ok(sdk_bytes)
}

#[cfg(test)]
mod tests;
