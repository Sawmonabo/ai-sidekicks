//! The status file the service writes in its run folder when its start fails, on every operating
//! system: why it cannot start, which the desktop's main process and `sidekicks daemon status` read
//! while the service is not answering.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FilesystemPath;
use crate::typescript::{Definition, TypeScriptModule};

/// Why the service cannot start.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DaemonCannotStartReason {
    /// Another account's process holds the service's connection name: Windows.
    ConnectionNameTaken,
    /// The service is turned off in Login Items: macOS.
    TurnedOffInLoginItems,
    /// The saved sessions are damaged and their repair could not heal them; nothing was changed.
    SavedSessionsUnrepaired,
    /// The saved sessions are from another version of the service, which this one never migrates.
    SavedSessionsFromAnotherVersion,
}

/// Why the service cannot start, with the folder a damaged store's copy sits in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonCannotStart {
    /// Why.
    pub reason: DaemonCannotStartReason,
    /// The folder the damaged saved sessions are copied aside in, for `savedSessionsUnrepaired`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FilesystemPath")]
    pub aside_folder: Option<FilesystemPath>,
}

/// The status file's content.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ServiceStatusFile {
    /// Why the last start failed.
    pub cannot_start: DaemonCannotStart,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "daemon/service-status",
    doc: "The status file the service writes in its run folder when its start fails: why it \
          cannot start.",
    definitions: &[
        Definition::read::<DaemonCannotStartReason>(),
        Definition::read::<DaemonCannotStart>(),
        Definition::read::<ServiceStatusFile>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
