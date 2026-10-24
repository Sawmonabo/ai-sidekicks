//! Backups of what the person would lose with the disk: reading where they stand, starting one
//! now, the events a run records, and each backup's manifest.
//!
//! A restore replaces the service's own store, so it runs with the service stopped and reads each
//! manifest straight from the folder; that is why the manifest's shape is a contract. A backup is
//! a plain copy that holds no key, so any computer can restore it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::error::ERROR_MESSAGE_MAX_LEN;
use crate::free_form_string::FilesystemPath;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::place::DistroName;
use crate::release_manifest::ReleaseVersion;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::{ListKey, UniqueList};
use crate::wire::text::{FreeFormText, branded_free_form_text};

/// The manifest's file name, beside each backup's database copy.
pub const BACKUP_MANIFEST_FILE_NAME: &str = "manifest.json";

/// The database copy's file name inside each backup's folder, beside its manifest; a backup's
/// writer, its restore and the daemon's repair of a damaged store all read it there.
pub const BACKUP_DATABASE_FILE_NAME: &str = "daemon.db";

/// The folder backups go to inside the service's data folder when the person picked none.
pub const BACKUP_DEFAULT_FOLDER_NAME: &str = "backups";

ts_constants! {
    /// The longest backup id or computer name accepted, in code points.
    pub const BACKUP_LABEL_MAX_LEN: usize = 256;
}

branded_free_form_text! {
    /// One backup's id, minted by the service when it writes the backup. Opaque to every client.
    pub struct BackupId(BACKUP_LABEL_MAX_LEN);
}

/// What a backup records about itself: when it was taken, the app and service versions that wrote
/// it, its size and the computer that wrote it. On a Windows computer it also names each WSL 2
/// distribution whose part it holds, so a restore writes each part back into the distribution of
/// that name and keeps a part whose distribution is not on the computer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct BackupManifest {
    /// The backup.
    pub backup_id: BackupId,
    /// When it was taken.
    #[garde(dive)]
    pub taken_at: WireInstant,
    /// The app version that wrote it.
    pub app_version: ReleaseVersion,
    /// The service version that wrote it.
    pub service_version: ReleaseVersion,
    /// Its size in bytes.
    pub total_bytes: SafeInt<0>,
    /// The computer that wrote it.
    pub computer_name: FreeFormText<BACKUP_LABEL_MAX_LEN>,
    /// The WSL 2 distributions whose parts it holds, by name; absent where it holds none.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "UniqueList<DistroName, 1, { usize::MAX }>")]
    #[garde(dive)]
    pub distribution_parts: Option<UniqueList<DistroName, 1, { usize::MAX }>>,
}

/// One backup in the folder, as `Restore…` lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct BackupListEntry {
    /// The backup.
    pub backup_id: BackupId,
    /// When it was taken.
    #[garde(dive)]
    pub taken_at: WireInstant,
    /// Its size in bytes.
    pub total_bytes: SafeInt<0>,
    /// The app version that wrote it.
    pub app_version: ReleaseVersion,
    /// The computer that wrote it.
    pub computer_name: FreeFormText<BACKUP_LABEL_MAX_LEN>,
}

/// How the last backup run ended: `completed`, or `failed` with the service's own words for the
/// cause. A failed run keeps the backups already there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum BackupLastRun {
    /// The run wrote a backup.
    Completed {
        /// When it finished.
        #[garde(dive)]
        finished_at: WireInstant,
    },
    /// The run did not finish.
    Failed {
        /// When it stopped.
        #[garde(dive)]
        finished_at: WireInstant,
        /// The cause, in the service's own words.
        message: FreeFormText<ERROR_MESSAGE_MAX_LEN>,
    },
}

/// Where the backups stand: the folder and whether it sits on the service's own disk, the
/// folder's total size, the last run (`null` before the first) and every backup in the folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonBackupReadResponse {
    /// The folder.
    pub folder: FilesystemPath,
    /// Whether the folder sits on the service's own disk.
    pub folder_on_service_disk: bool,
    /// The folder's total size in bytes.
    pub total_bytes: SafeInt<0>,
    /// The last run, or `null` before the first.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<BackupLastRun>")]
    #[garde(dive)]
    pub last_run: Option<BackupLastRun>,
    /// Every backup in the folder.
    #[garde(dive)]
    pub backups: Vec<BackupListEntry>,
}

/// `daemon.backup.completed`: a run wrote a backup.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonBackupCompletedPayload {
    /// The backup.
    pub backup_id: BackupId,
    /// Its size in bytes.
    pub total_bytes: SafeInt<0>,
}

/// `daemon.backup.failed`: a run did not finish, in the service's own words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonBackupFailedPayload {
    /// The cause.
    pub message: FreeFormText<ERROR_MESSAGE_MAX_LEN>,
}

/// One WSL 2 distribution's part a restore kept in the backup, because no distribution of that
/// name is on this computer, with how many sessions it holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupKeptDistributionPart {
    /// The distribution, by name.
    pub distro: DistroName,
    /// How many sessions the part holds.
    pub session_count: SafeInt<0>,
}

impl ListKey for BackupKeptDistributionPart {
    type Key = DistroName;

    fn list_key(&self) -> DistroName {
        self.distro.clone()
    }

    // It carries no rule its read does not hold.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

/// `daemon.backup.restored`: the service started again from a backup, naming each distribution part
/// it kept in the backup.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonBackupRestoredPayload {
    /// The backup.
    pub backup_id: BackupId,
    /// The distribution parts kept in the backup; absent where every part was written back.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "UniqueList<BackupKeptDistributionPart, 1, { usize::MAX }>")]
    #[garde(dive)]
    pub kept_distribution_parts: Option<UniqueList<BackupKeptDistributionPart, 1, { usize::MAX }>>,
}

methods! {
    /// The backup methods. A run started now reports its end through the `daemon.backup.*` events.
    pub const DAEMON_BACKUP_METHOD_DESCRIPTORS = [
        /// Reads where the backups stand.
        DaemonBackupRead = query "daemon.backup.read" {
            mutating: false,
            params: EmptyPayload,
            result: DaemonBackupReadResponse,
            refusals: [],
        },
        /// Starts a backup run now.
        DaemonBackupStart = mutation "daemon.backup.start" {
            mutating: true,
            params: EmptyPayload,
            result: EmptyPayload,
            refusals: [],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "daemon/backup",
    doc: "Backups of what the person would lose with the disk: where they stand, starting one now, \
          the events a run records, and each backup's manifest.",
    definitions: &[
        Definition::read::<BackupId>().checked(),
        Definition::read::<BackupManifest>().checked(),
        Definition::read::<BackupListEntry>(),
        Definition::read::<BackupLastRun>(),
        Definition::read::<DaemonBackupReadResponse>().checked(),
        Definition::read::<DaemonBackupCompletedPayload>().checked(),
        Definition::read::<DaemonBackupFailedPayload>().checked(),
        Definition::read::<BackupKeptDistributionPart>(),
        Definition::read::<DaemonBackupRestoredPayload>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&DAEMON_BACKUP_METHOD_DESCRIPTORS],
};
