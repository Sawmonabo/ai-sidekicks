//! Everything the service keeps for the person: the data folder it lives in, and the two acts on
//! it, export and erase, which Settings › Runtime sends as these verbs. The command line sends
//! the same export, and erases through a mode of the daemon's own program while the service is
//! stopped.

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::error::ERROR_MESSAGE_MAX_LEN;
use crate::free_form_string::FilesystemPath;
use crate::internal::branded::branded_uuid_id;
use crate::jsonrpc::streaming::SubscribeAcknowledgmentResponse;
use crate::keychain::KeychainRefusalCause;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::provider::account::record::ProviderAccountId;
use crate::provider::id::ProviderId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The service's data folder, inside the person's home folder: its database, the machine's
    /// settings and every other file it keeps.
    pub const DAEMON_DATA_FOLDER_NAME: &str = ".ai-sidekicks";
}

/// The lock file in the data folder, which the service, or a mode of its program, holds for as long
/// as it uses the folder.
pub const DAEMON_LOCK_FILE_NAME: &str = "daemon.lock";

/// The file beside the lock file its holder writes its process id to, since a locked file cannot
/// be read on every system.
pub const DAEMON_PROCESS_ID_FILE_NAME: &str = "daemon.pid";

/// Writes the refusal a person reads when another daemon holds the data folder, naming the
/// holder's `process_id` when it is known.
pub fn write_data_folder_held(
    formatter: &mut fmt::Formatter<'_>,
    process_id: Option<u32>,
) -> fmt::Result {
    match process_id {
        Some(process_id) => write!(
            formatter,
            "The background service is already running (process {process_id})."
        ),
        None => write!(formatter, "The background service is already running."),
    }
}

/// The arguments the daemon's own program is started with to erase everything with the service
/// stopped.
pub const DATA_ERASE_MODE: [&str; 2] = ["data", "erase"];

branded_uuid_id! {
    /// The id of one export job, minted by the service.
    DataExportJobId
}

/// Starts an export into a new folder. `destination` is the folder's path: the one the platform's
/// save dialog picked, which the desktop app's main process turns from its token into a path, or
/// the one typed on the command line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonDataExportStartRequest {
    /// The new folder's path.
    pub destination: FilesystemPath,
}

/// The export job the request started; its progress streams on `daemon.dataExport.subscribe`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonDataExportStartResponse {
    /// The job.
    pub job_id: DataExportJobId,
}

/// The export job whose progress to stream.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonDataExportSubscribeRequest {
    /// The job.
    pub job_id: DataExportJobId,
}

/// The export job to stop. A job already finished stays as it ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonDataExportCancelRequest {
    /// The job.
    pub job_id: DataExportJobId,
}

/// The details of `daemon.dataExport.alreadyRunning`: the export that runs now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonDataExportAlreadyRunningDetails {
    /// The running job.
    pub job_id: DataExportJobId,
}

/// The details of `daemon.dataExport.destination.notWritable`: the folder that could not be made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonDataExportDestinationNotWritableDetails {
    /// The folder.
    pub path: FilesystemPath,
}

/// Where an export stands, told apart by its `state`. A running export exports one session at a
/// time, so it counts sessions, never past its total.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
#[garde(custom(|progress: &Self, (): &()| progress.counts_within_total()))]
pub enum DataExportProgress {
    /// The export is running.
    Running {
        /// The sessions exported so far; never more than `sessionsTotal`.
        #[schemars(extend("maximum" = { "$data": "1/sessionsTotal" }))]
        sessions_exported: SafeInt<0>,
        /// The sessions the export holds.
        sessions_total: SafeInt<0>,
    },
    /// The export finished: the folder, the sessions it holds and its size.
    Completed {
        /// The folder written.
        path: FilesystemPath,
        /// The sessions exported.
        sessions_exported: SafeInt<0>,
        /// Its size in bytes.
        total_bytes: SafeInt<0>,
    },
    /// The export failed, with the service's own words for the cause.
    Failed {
        /// The cause.
        message: FreeFormText<ERROR_MESSAGE_MAX_LEN>,
    },
    /// The person canceled the export; the folder holds what was written before.
    Canceled {
        /// The folder the export was writing.
        path: FilesystemPath,
    },
}

impl DataExportProgress {
    /// Refuses a running export that counts more sessions exported than it holds.
    fn counts_within_total(&self) -> garde::Result {
        match self {
            Self::Running {
                sessions_exported,
                sessions_total,
            } if sessions_exported > sessions_total => Err(garde::Error::new(
                "sessionsExported cannot exceed sessionsTotal",
            )),
            Self::Running { .. }
            | Self::Completed { .. }
            | Self::Failed { .. }
            | Self::Canceled { .. } => Ok(()),
        }
    }
}

/// The details of `daemon.data.storeUnavailable`: why the keychain the erase must empty could not
/// be used. The erase is refused before anything is erased, so it can be sent again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonDataStoreUnavailableDetails {
    /// Why the keychain could not be used: `locked`, or it cannot be used (`unavailable`).
    pub cause: KeychainRefusalCause,
}

/// Why the erase left an account signed in with its provider: no registered provider runs its
/// sign-out (`noProvider`), the provider's own sign-out failed or was refused (`refused`), or it
/// did not end within its bound (`timedOut`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DataEraseSignOutFailure {
    /// No registered provider runs the account's sign-out.
    NoProvider,
    /// The provider's own sign-out failed or was refused.
    Refused,
    /// The sign-out did not end within its bound.
    TimedOut,
}

/// How an account the erase left signed in stood on the account list: listed there (`listed`),
/// removed from it, its home kept (`removed`), or minted by a sign-in that did not finish, so it
/// never reached the list (`signInUnfinished`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DataEraseAccountListing {
    /// The account is on the list.
    Listed,
    /// The account was removed from the list, or its removal had begun.
    Removed,
    /// The account's sign-in did not finish, so no row ever listed it.
    SignInUnfinished,
}

/// An account the erase could not sign out, which stays signed in with its provider once its home
/// is deleted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DataEraseSignedInAccount {
    /// The account.
    pub account_id: ProviderAccountId,
    /// The account's provider, named here since a removed account has no row to name it.
    pub provider: ProviderId,
    /// How the account stood on the account list.
    pub listing: DataEraseAccountListing,
    /// Why it was not signed out.
    pub cause: DataEraseSignOutFailure,
}

/// The erase's answer, sent once every account's sign-out has ended and the sessions' folders on
/// other volumes were removed, and before the work stops; the rest of the erase follows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonDataEraseResponse {
    /// Each account left signed in with its provider, with why; empty when every one signed out.
    pub signed_in_accounts: Vec<DataEraseSignedInAccount>,
    /// Whether the account list could not all be read: none was signed out where it could not be
    /// read at all, and a row naming no valid account or provider id was left signed in while the
    /// rest were signed out.
    pub is_account_list_unread: bool,
    /// Each session's own folder on another volume that stays once the data folder is gone, its
    /// volume not connected or its removal refused; empty when every one went.
    pub volume_folders_left: Vec<FilesystemPath>,
    /// Whether the sessions' folders on other volumes could not be read, so none was removed.
    pub is_volume_folder_list_unread: bool,
}

methods! {
    /// The data methods. The export stream's acknowledgment is the subscription, and each
    /// emission is the job's progress as it changes.
    pub const DAEMON_DATA_METHOD_DESCRIPTORS = [
        /// Starts an export.
        DaemonDataExportStart = mutation "daemon.dataExport.start" {
            mutating: true,
            params: DaemonDataExportStartRequest,
            result: DaemonDataExportStartResponse,
            refusals: [
                DaemonDataExportAlreadyRunning,
                DaemonDataExportDestinationAlreadyExists,
                DaemonDataExportDestinationNotWritable,
            ],
        },
        /// Streams an export's progress: where it stands, then each change.
        DaemonDataExportSubscribe = subscription "daemon.dataExport.subscribe" {
            mutating: false,
            params: DaemonDataExportSubscribeRequest,
            result: SubscribeAcknowledgmentResponse,
            emission: DataExportProgress,
            refusals: [DaemonDataExportNotFound],
        },
        /// Stops a running export.
        DaemonDataExportCancel = mutation "daemon.dataExport.cancel" {
            mutating: true,
            params: DaemonDataExportCancelRequest,
            result: EmptyPayload,
            refusals: [DaemonDataExportNotFound],
        },
        /// Erases everything the service keeps.
        DaemonDataErase = mutation "daemon.data.erase" {
            mutating: true,
            params: EmptyPayload,
            result: DaemonDataEraseResponse,
            refusals: [DaemonDataStoreUnavailable, DaemonDataEraseRunning],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "daemon/data",
    doc: "Everything the service keeps for the person: the data folder, and the two acts on it, \
          export and erase.",
    definitions: &[
        Definition::read::<DataExportJobId>(),
        Definition::read::<DaemonDataExportStartRequest>(),
        Definition::read::<DaemonDataExportStartResponse>(),
        Definition::read::<DaemonDataExportSubscribeRequest>(),
        Definition::read::<DaemonDataExportCancelRequest>(),
        Definition::read::<DaemonDataExportAlreadyRunningDetails>(),
        Definition::read::<DaemonDataExportDestinationNotWritableDetails>(),
        Definition::read::<DataExportProgress>(),
        Definition::read::<DaemonDataStoreUnavailableDetails>(),
        Definition::read::<DataEraseSignOutFailure>(),
        Definition::read::<DataEraseAccountListing>(),
        Definition::read::<DataEraseSignedInAccount>(),
        Definition::read::<DaemonDataEraseResponse>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&DAEMON_DATA_METHOD_DESCRIPTORS],
};
