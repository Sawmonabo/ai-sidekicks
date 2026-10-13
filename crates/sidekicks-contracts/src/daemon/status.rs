//! `daemon.status.read`: the service's own facts in one reply, and `daemon.crashList`: the crash
//! reports this machine keeps. Processor and memory figures are read when called and stamped with
//! the time taken; nothing samples them on a timer.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::daemon::recovery::DaemonRecoveryStatus;
use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::process_identity::ProcessIdentity;
use crate::release_manifest::ReleaseVersion;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::percent::Percent;
use crate::wire::text::Text;

/// The longest free-form text the status carries, in code points.
pub const DAEMON_STATUS_TEXT_MAX_LEN: usize = 4_096;

/// The most frames a report keeps of the crashing thread's stack.
pub const CRASH_REPORT_STACK_MAX_FRAMES: usize = 256;

/// A text the status carries.
type StatusText = Text<1, DAEMON_STATUS_TEXT_MAX_LEN>;

/// A path the status carries.
type StatusPath = Text<1, FILE_PATH_MAX_LEN>;

/// Where the service is in its own life.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DaemonProcessState {
    /// It serves.
    Running,
    /// It is starting.
    Starting,
    /// It is stopping.
    Stopping,
    /// It serves with a fault.
    Degraded,
}

/// How much of the machine's processor the service and every process it started use.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonProcessorReading {
    /// A share of the whole machine's processor, from 0 to 100.
    pub percent: Percent,
    /// When it was read.
    #[garde(dive)]
    pub read_at: WireInstant,
}

/// How much memory the service and every process it started hold.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonMemoryReading {
    /// The resident bytes.
    pub resident_bytes: SafeInt<0>,
    /// When it was read.
    #[garde(dive)]
    pub read_at: WireInstant,
}

/// One linked device as the relay last saw it, counted since the service started.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonRelayDevice {
    /// The device's name.
    pub name: StatusText,
    /// Whether it is connected.
    pub connected: bool,
    /// How long ago the last frame went out; absent when none has.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub last_frame_out_age_ms: Option<SafeInt<0>>,
    /// How long ago the last frame came in; absent when none has.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub last_frame_in_age_ms: Option<SafeInt<0>>,
    /// How many times it reconnected.
    pub reconnect_count: SafeInt<0>,
    /// How many of its frames were refused.
    pub rejected_frame_count: SafeInt<0>,
}

/// The relay block, present only while a relay is configured.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonRelayStatus {
    /// The linked devices.
    pub devices: Vec<DaemonRelayDevice>,
    /// The pinned relay presented a key other than the one pinned when it was linked.
    pub pin_refused: bool,
}

/// Everything a status reader prints, in one reply.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonStatusReadResponse {
    /// Where the service is in its own life.
    pub process_state: DaemonProcessState,
    /// The service's own process as the system knows it, by which a client that found it running
    /// ends it and never a process that took over its id.
    pub process_identity: ProcessIdentity,
    /// The service's own version.
    pub version: ReleaseVersion,
    /// The protocol version it speaks.
    pub protocol_version: StatusText,
    /// Where it listens.
    pub transport_endpoint: StatusText,
    /// When it started.
    #[garde(dive)]
    pub started_at: WireInstant,
    /// How long it has run, in milliseconds.
    pub uptime_ms: SafeInt<0>,
    /// The data directory this service holds; a second service cannot hold it.
    pub data_directory: StatusPath,
    /// The processor reading, or `null` when it could not be taken at this call.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<DaemonProcessorReading>")]
    #[garde(dive)]
    pub processor: Option<DaemonProcessorReading>,
    /// The memory reading, or `null` when it could not be taken at this call.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<DaemonMemoryReading>")]
    #[garde(dive)]
    pub memory: Option<DaemonMemoryReading>,
    /// Where the node stands in its recovery from the last restart; writes wait for `healthy`.
    #[garde(dive)]
    pub recovery: DaemonRecoveryStatus,
    /// The relay, while one is configured.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "DaemonRelayStatus")]
    pub relay: Option<DaemonRelayStatus>,
    /// The file the service keeps its secrets in, readable by this account alone: present only on
    /// Linux where no Secret Service answers, and on a Mac while the secrets are in
    /// `secrets.json`, from the approved logged-out service's takeover until uninstall moves them
    /// back, including after it is turned off in Login Items & Extensions; absent while it waits
    /// for approval.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "StatusPath")]
    pub secrets_file: Option<StatusPath>,
}

/// The pattern of a stack frame's module: a file name, with no `/` or `\`.
const MODULE_FILE_NAME_PATTERN: &str = "^[^\\\\/]+$";

/// A stack frame's module: its file name, never its path, so no user folder leaks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct CrashModuleFileName(String);

impl CrashModuleFileName {
    /// Checks `name`; refuses an empty name, one past the status's text bound, or a path.
    pub fn new(name: String) -> Option<Self> {
        let is_file_name = !name.is_empty()
            && name.chars().nth(DAEMON_STATUS_TEXT_MAX_LEN).is_none()
            && !name.contains(['/', '\\']);
        is_file_name.then_some(Self(name))
    }

    /// The file name.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for CrashModuleFileName {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?)
            .ok_or_else(|| D::Error::custom("a stack frame names its module's file, never a path"))
    }
}

impl JsonSchema for CrashModuleFileName {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "CrashModuleFileName".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "maxLength": DAEMON_STATUS_TEXT_MAX_LEN,
            "pattern": MODULE_FILE_NAME_PATTERN,
        })
    }
}

/// One frame of the crashing thread's stack: the module's file name, never its path, and the
/// offset into it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrashStackFrame {
    /// The module's file name.
    pub module: CrashModuleFileName,
    /// The offset into it.
    pub offset: SafeInt<0>,
}

/// A report the service built on this machine from a crash's dump, with personal data stripped:
/// file paths cut to their names and session ids replaced by stable hashes. The dump itself never
/// leaves the machine.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct CrashReport {
    /// When it crashed.
    #[garde(dive)]
    pub crashed_at: WireInstant,
    /// The crashed process's type as the crash dump records it, such as `renderer`.
    pub process_type: StatusText,
    /// The app's version.
    pub app_version: StatusText,
    /// The service's version.
    pub service_version: StatusText,
    /// The platform.
    pub platform: StatusText,
    /// The crashing thread's stack, at most [`CRASH_REPORT_STACK_MAX_FRAMES`] frames.
    #[garde(length(max = CRASH_REPORT_STACK_MAX_FRAMES))]
    #[schemars(length(max = 256))]
    pub stack: Vec<CrashStackFrame>,
}

/// The reports this machine keeps, newest first; kept as long as its diagnostic logs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonCrashListResponse {
    /// The reports, newest first.
    #[garde(dive)]
    pub reports: Vec<CrashReport>,
}

methods! {
    /// The status read and the crash list.
    pub const DAEMON_STATUS_METHOD_DESCRIPTORS = [
        /// Reads the service's own facts.
        DaemonStatusRead = query "daemon.status.read" {
            mutating: false,
            params: EmptyPayload,
            result: DaemonStatusReadResponse,
            refusals: [],
        },
        /// Lists the crash reports this machine keeps.
        DaemonCrashList = query "daemon.crashList" {
            mutating: false,
            params: EmptyPayload,
            result: DaemonCrashListResponse,
            refusals: [],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "daemon/status",
    doc: "`daemon.status.read`: the service's own facts in one reply, and `daemon.crashList`: the \
          crash reports this machine keeps.",
    definitions: &[
        Definition::read::<DaemonProcessState>(),
        Definition::read::<DaemonProcessorReading>(),
        Definition::read::<DaemonMemoryReading>(),
        Definition::read::<DaemonRelayDevice>(),
        Definition::read::<DaemonRelayStatus>(),
        Definition::read::<DaemonStatusReadResponse>().checked(),
        Definition::read::<CrashStackFrame>(),
        Definition::read::<CrashReport>(),
        Definition::read::<DaemonCrashListResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[&DAEMON_STATUS_METHOD_DESCRIPTORS],
};
