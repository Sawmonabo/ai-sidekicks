//! `daemon.status.read`: the service's own facts in one reply, the WSL 2 distributions it works in
//! among them, and `daemon.crashReport.list`: the crash reports this machine keeps. Processor and
//! memory figures are read when called and stamped with the time taken; nothing samples them on a
//! timer.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::daemon::recovery::DaemonRecoveryStatus;
use crate::free_form_string::FilesystemPath;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::place::DistroName;
use crate::process_identity::ProcessIdentity;
use crate::release_manifest::ReleaseVersion;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::{BoundedVec, ListKey, UniqueList};
use crate::wire::number::Percent;
use crate::wire::text::{BoundedText, pattern_text};

ts_constants! {
    /// The longest free-form text the status carries, in code points.
    pub const DAEMON_STATUS_TEXT_MAX_LEN: usize = 4_096;

    /// The most frames a report keeps of the crashing thread's stack.
    pub const CRASH_REPORT_STACK_MAX_FRAMES: usize = 256;
}

/// A text the status carries.
type StatusText = BoundedText<1, DAEMON_STATUS_TEXT_MAX_LEN>;

/// Where the service is in its own life.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
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

/// Where one WSL 2 distribution stands: running, stopped, or not answering since the time WSL
/// stopped answering.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum DaemonWslDistributionStatus {
    /// The distribution runs.
    Running {},
    /// The distribution is stopped.
    Stopped {},
    /// WSL does not answer for it.
    NotAnswering {
        /// When WSL stopped answering.
        #[garde(dive)]
        since: WireInstant,
    },
}

/// One line of the WSL block: a WSL 2 distribution with a WSL server running or a session in it,
/// where it stands and how many sessions run in it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonWslDistribution {
    /// The distribution.
    pub distro: DistroName,
    /// Where it stands.
    #[garde(dive)]
    pub status: DaemonWslDistributionStatus,
    /// How many sessions run in it.
    pub session_count: SafeInt<0>,
}

impl ListKey for DaemonWslDistribution {
    type Key = DistroName;

    fn list_key(&self) -> DistroName {
        self.distro.clone()
    }

    fn validate_item(&self, parent: &mut dyn FnMut() -> garde::Path, report: &mut garde::Report) {
        garde::Validate::validate_into(self, &(), parent, report);
    }
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
    pub data_directory: FilesystemPath,
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
    /// Where the service stands in its recovery from the last restart; writes wait for `healthy`.
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
    /// One line per WSL 2 distribution with a WSL server running or a session in it; absent where
    /// there is none.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "UniqueList<DaemonWslDistribution, 1, { usize::MAX }>")]
    #[garde(dive)]
    pub wsl: Option<UniqueList<DaemonWslDistribution, 1, { usize::MAX }>>,
    /// The file the service keeps its secrets in, how they are protected and, while they cannot be
    /// opened, why: present while it holds an item or cannot be opened. That is on Linux, and on a
    /// Mac from the logged-out service's takeover until uninstall moves them back, including after
    /// it is turned off in Login Items & Extensions.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "DaemonSecretsFile")]
    pub secrets_file: Option<DaemonSecretsFile>,
}

/// Declares the secrets file: each protection's arm repeats the file's path, then adds its own
/// member.
macro_rules! secrets_file {
    (
        $(#[doc = $doc:literal])+
        pub enum $name:ident {
            $($(#[doc = $arm_doc:literal])+ $arm:ident { $($extra:tt)* },)+
        }
    ) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(
            tag = "protection",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        pub enum $name {$(
            $(#[doc = $arm_doc])+
            $arm {
                /// The file's path; only this account can read it.
                path: FilesystemPath,
                $($extra)*
            },
        )+}
    };
}

secrets_file! {
    /// The file the service keeps its secrets in, tagged by how they are protected: a sealed file
    /// by the weakest key any of them is sealed with, carrying why it cannot be opened while it
    /// cannot, and a plain file carrying why it is plain on Linux.
    pub enum DaemonSecretsFile {
        /// Each sealed by systemd's credential service with the security chip and the system key.
        SealedWithChip {
            /// Why the file cannot be opened; absent while it opens.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "DaemonSecretsFileUnopened")]
            cannot_open: Option<DaemonSecretsFileUnopened>,
        },
        /// Each sealed by systemd's credential service with the system key alone.
        SealedWithSystemKey {
            /// Why the file cannot be opened; absent while it opens.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "DaemonSecretsFileUnopened")]
            cannot_open: Option<DaemonSecretsFileUnopened>,
        },
        /// Kept as given.
        Plain {
            /// Why the file on Linux is plain; absent on a Mac.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "DaemonSecretsPlainReason")]
            reason: Option<DaemonSecretsPlainReason>,
        },
    }
}

/// Why the file on Linux keeps its secrets plain.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DaemonSecretsPlainReason {
    /// systemd's credential service is absent: systemd older than 256, or no systemd.
    NoSealService,
    /// The service refused to seal at the first start, as in most containers.
    SealFailed,
    /// The service would bind each seal to the boot state, which a Secure Boot update changes.
    BootBound,
}

/// Why the sealed file cannot be opened.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DaemonSecretsFileUnopened {
    /// systemd's credential service is not running, or cannot open the key form that sealed an
    /// item.
    SealServiceMissing,
    /// The service does not answer, or answers with a failure, or the items file cannot be read.
    SealServiceFailing,
    /// The security chip the secrets were sealed with cannot be used now.
    ChipUnavailable,
    /// The key the secrets were sealed with is gone: the chip cleared or replaced, the Secure
    /// Boot settings, the account or the machine id changed.
    KeyChanged,
}

pattern_text! {
    /// A stack frame's module: its file name, never its path, so no user folder leaks; it holds no
    /// `/` or `\`.
    pub struct CrashModuleFileName("^[^\\\\/]+$", max = DAEMON_STATUS_TEXT_MAX_LEN);
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

/// What a panic said: its message and the place in the source it was raised at, each stripped as
/// the rest of the report is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrashPanic {
    /// The panic's message, with file paths cut to their names and session ids replaced by
    /// stable hashes.
    pub message: StatusText,
    /// The source file's name and the line and column the panic was raised at.
    pub location: StatusText,
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
    pub stack: BoundedVec<CrashStackFrame, 0, CRASH_REPORT_STACK_MAX_FRAMES>,
    /// What the panic said, on a crash the service's own panic ended.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "CrashPanic")]
    pub panic: Option<CrashPanic>,
}

/// The reports this machine keeps, newest first; kept as long as its diagnostic logs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonCrashReportListResponse {
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
        DaemonCrashReportList = query "daemon.crashReport.list" {
            mutating: false,
            params: EmptyPayload,
            result: DaemonCrashReportListResponse,
            refusals: [],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "daemon/status",
    doc: "`daemon.status.read`: the service's own facts in one reply, and \
          `daemon.crashReport.list`: the crash reports this machine keeps.",
    definitions: &[
        Definition::read::<DaemonProcessState>(),
        Definition::read::<DaemonProcessorReading>(),
        Definition::read::<DaemonMemoryReading>(),
        Definition::read::<DaemonRelayDevice>(),
        Definition::read::<DaemonRelayStatus>(),
        Definition::read::<DaemonWslDistributionStatus>(),
        Definition::read::<DaemonWslDistribution>(),
        Definition::read::<DaemonSecretsPlainReason>(),
        Definition::read::<DaemonSecretsFileUnopened>(),
        Definition::read::<DaemonSecretsFile>(),
        Definition::read::<DaemonStatusReadResponse>().checked(),
        Definition::read::<CrashModuleFileName>(),
        Definition::read::<CrashStackFrame>(),
        Definition::read::<CrashPanic>(),
        Definition::read::<CrashReport>(),
        Definition::read::<DaemonCrashReportListResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&DAEMON_STATUS_METHOD_DESCRIPTORS],
};

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{CrashStackFrame, DAEMON_STATUS_TEXT_MAX_LEN, DaemonSecretsFile};

    #[rstest]
    #[case::file_name("libsidekicks.dylib".to_owned(), true)]
    #[case::posix_path("/Users/someone/app/libsidekicks.dylib".to_owned(), false)]
    #[case::relative_path("app/libsidekicks.dylib".to_owned(), false)]
    #[case::windows_path("C:\\Users\\someone\\sidekicks.dll".to_owned(), false)]
    #[case::trailing_separator("sidekicks\\".to_owned(), false)]
    #[case::empty(String::new(), false)]
    #[case::at_the_bound("a".repeat(DAEMON_STATUS_TEXT_MAX_LEN), true)]
    #[case::past_the_bound("a".repeat(DAEMON_STATUS_TEXT_MAX_LEN + 1), false)]
    fn a_stack_frame_names_its_module_file_never_a_path(
        #[case] module: String,
        #[case] is_accepted: bool,
    ) {
        let frame = serde_json::json!({ "module": module, "offset": 16 });
        let parsed = serde_json::from_value::<CrashStackFrame>(frame);
        assert_eq!(parsed.is_ok(), is_accepted);
    }

    /// Each protection reads and writes back byte for byte, with only its own member, and a member
    /// of another protection is refused. Mutation: drop `deny_unknown_fields` from the arms, so a
    /// sealed file carrying a plain file's reason reads.
    #[rstest]
    #[case::sealed_with_chip(r#"{"protection":"sealedWithChip","path":"/secrets.json"}"#, true)]
    #[case::sealed_with_the_system_key_that_cannot_open(
        r#"{"protection":"sealedWithSystemKey","path":"/secrets.json","cannotOpen":"keyChanged"}"#,
        true
    )]
    #[case::plain_for_a_reason(
        r#"{"protection":"plain","path":"/secrets.json","reason":"bootBound"}"#,
        true
    )]
    #[case::plain_on_a_mac(r#"{"protection":"plain","path":"/secrets.json"}"#, true)]
    #[case::sealed_with_a_reason(
        r#"{"protection":"sealedWithChip","path":"/secrets.json","reason":"bootBound"}"#,
        false
    )]
    #[case::plain_that_cannot_open(
        r#"{"protection":"plain","path":"/secrets.json","cannotOpen":"keyChanged"}"#,
        false
    )]
    fn a_secrets_file_carries_only_its_protections_member(
        #[case] text: &str,
        #[case] is_accepted: bool,
    ) {
        let parsed = serde_json::from_str::<DaemonSecretsFile>(text);

        assert_eq!(parsed.is_ok(), is_accepted, "{text}");
        if let Ok(file) = parsed {
            assert_eq!(serde_json::to_string(&file).expect("the file writes"), text);
        }
    }
}
