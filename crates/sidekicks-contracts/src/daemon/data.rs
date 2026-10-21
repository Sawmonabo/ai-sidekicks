//! Everything the service keeps for the person: the data folder it lives in, and the two acts on
//! it, export and erase, which Settings › Runtime and the command line send as the same verbs.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::error::ERROR_MESSAGE_MAX_LEN;
use crate::free_form_string::FilesystemPath;
use crate::internal::branded::branded_uuid_id;
use crate::jsonrpc::streaming::SubscribeAcknowledgmentResponse;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The service's data folder, inside the person's home folder: its database, the machine's
    /// settings and every other file it keeps.
    pub const DAEMON_DATA_FOLDER_NAME: &str = ".ai-sidekicks";
}

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
    /// The export finished: the folder and its size.
    Completed {
        /// The folder written.
        path: FilesystemPath,
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

methods! {
    /// The data methods. The export stream's acknowledgment is the subscription, and each
    /// emission is the job's progress as it changes.
    pub const DAEMON_DATA_METHOD_DESCRIPTORS = [
        /// Starts an export.
        DaemonDataExportStart = mutation "daemon.dataExport.start" {
            mutating: true,
            params: DaemonDataExportStartRequest,
            result: DaemonDataExportStartResponse,
            refusals: [DaemonDataExportAlreadyRunning, DaemonDataExportDestinationAlreadyExists],
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
            result: EmptyPayload,
            refusals: [],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "daemon/data",
    doc: "Everything the service keeps for the person: the data folder, and the two acts on it, \
          export and erase.",
    definitions: &[
        Definition::read::<DataExportJobId>().checked(),
        Definition::read::<DaemonDataExportStartRequest>().checked(),
        Definition::read::<DaemonDataExportStartResponse>().checked(),
        Definition::read::<DaemonDataExportSubscribeRequest>().checked(),
        Definition::read::<DaemonDataExportCancelRequest>().checked(),
        Definition::read::<DaemonDataExportAlreadyRunningDetails>().checked(),
        Definition::read::<DataExportProgress>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&DAEMON_DATA_METHOD_DESCRIPTORS],
};
