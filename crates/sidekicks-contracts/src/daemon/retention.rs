//! The two retention bounds on Settings › Runtime, and `Delete old data`. Only the service's
//! diagnostic logs go on their own past a bound; a session is removed only by the purge, which the
//! person confirms after reading the count, and a workflow run's step data stays until its run or
//! its session is deleted.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;

/// `Keep diagnostic logs for` as the app starts out: seven days.
const DEFAULT_KEEP_DIAGNOSTIC_LOGS_DAYS: u64 = 7;

ts_constants! {
    /// `Keep diagnostic logs for` as the app starts out, seven days, in milliseconds.
    pub const DEFAULT_KEEP_DIAGNOSTIC_LOGS_MS: u64 =
        DEFAULT_KEEP_DIAGNOSTIC_LOGS_DAYS * 24 * 60 * 60 * 1000;
}

/// The two bounds, each in whole days.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonRetentionBounds {
    /// The service's own logs and, in each account home, what the provider writes and never reads
    /// back for a session. Any period is taken as set.
    pub keep_diagnostic_logs_days: SafeInt<1>,
    /// How long a finished session stays before it can be deleted.
    pub keep_sessions_days: SafeInt<1>,
}

/// What `Delete old data` would remove if it ran now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonRetentionPurgePreview {
    /// How many archived sessions the purge would remove.
    pub archived_session_count: SafeInt<0>,
    /// Sessions archived before this moment are the ones counted.
    #[garde(dive)]
    pub cutoff_at: WireInstant,
}

/// The bounds, and the count the purge's confirm names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonRetentionReadResponse {
    /// `Keep diagnostic logs for`, in whole days.
    pub keep_diagnostic_logs_days: SafeInt<1>,
    /// How long a finished session stays before it can be deleted, in whole days.
    pub keep_sessions_days: SafeInt<1>,
    /// What the purge would remove now.
    #[garde(dive)]
    pub purge: DaemonRetentionPurgePreview,
}

/// `daemon.retentionUpdate`: exactly one bound, as `{"<bound>": days}`. Setting a bound deletes
/// nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum DaemonRetentionUpdateRequest {
    /// `Keep diagnostic logs for`, in whole days.
    KeepDiagnosticLogsDays(SafeInt<1>),
    /// How long a finished session stays, in whole days.
    KeepSessionsDays(SafeInt<1>),
}

/// `daemon.retentionPurge`: the cutoff the confirm was read against, so the purge removes exactly
/// what the confirm named and a second press removes nothing more.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonRetentionPurgeRequest {
    /// The cutoff the confirm named.
    #[garde(dive)]
    pub cutoff_at: WireInstant,
}

/// How many sessions the purge removed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonRetentionPurgeResponse {
    /// The sessions removed.
    pub deleted_session_count: SafeInt<0>,
}

methods! {
    /// The retention methods.
    pub const DAEMON_RETENTION_METHOD_DESCRIPTORS = [
        /// Reads the bounds and what the purge would remove.
        DaemonRetentionRead = query "daemon.retentionRead" {
            mutating: false,
            params: EmptyPayload,
            result: DaemonRetentionReadResponse,
            refusals: [],
        },
        /// Sets one bound.
        DaemonRetentionUpdate = mutation "daemon.retentionUpdate" {
            mutating: true,
            params: DaemonRetentionUpdateRequest,
            result: DaemonRetentionBounds,
            refusals: [],
        },
        /// Removes the sessions archived before the confirmed cutoff.
        DaemonRetentionPurge = mutation "daemon.retentionPurge" {
            mutating: true,
            params: DaemonRetentionPurgeRequest,
            result: DaemonRetentionPurgeResponse,
            refusals: [],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "daemon/retention",
    doc: "The two retention bounds on Settings › Runtime, and `Delete old data`.",
    definitions: &[
        Definition::read::<DaemonRetentionBounds>().checked(),
        Definition::read::<DaemonRetentionPurgePreview>(),
        Definition::read::<DaemonRetentionReadResponse>().checked(),
        Definition::read::<DaemonRetentionUpdateRequest>().checked(),
        Definition::read::<DaemonRetentionPurgeRequest>().checked(),
        Definition::read::<DaemonRetentionPurgeResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&DAEMON_RETENTION_METHOD_DESCRIPTORS],
};
