//! What the desktop app records about itself, which its main process hands the service to write in
//! its diagnostic log, so it is kept, and dropped, with the service's own lines: an error nothing
//! handled, a line a window's diagnostic capture took, the window process going away, and a count
//! of what was not written. Each text is bounded here; main fills a record with an error's name,
//! its message with every quoted run taken out, and its stack frames, and never with a value a
//! promise was rejected with.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::command::ExitCode;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::BoundedText;

/// The longest each text of an app diagnostic record may be, in code points; a sender that cuts a
/// text to the bound in UTF-16 code units stays within it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct AppDiagnosticTextBounds {
    /// An error's name, such as `TypeError`.
    pub name: usize,
    /// An error's message, or what a captured line says happened.
    pub message: usize,
    /// Its stack frames, one per line; about sixty frames of the app's own bundle.
    pub stack: usize,
    /// The address of the script it was thrown in, without its query or fragment.
    pub address: usize,
    /// Why the window's process went, in Electron's own word.
    pub reason: usize,
    /// The module that captured a line, or what kind of line it is.
    pub label: usize,
}

/// Where in the app an error went unhandled: main; the hidden console document, which runs the
/// code of every window, so its errors read here; or a window of session views or a pane's own
/// window, for what that window's own objects raise.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, VariantArray)]
#[serde(rename_all = "camelCase")]
pub enum AppDiagnosticRole {
    /// The main process.
    Main,
    /// The hidden console document.
    ConsoleDocument,
    /// A window of session views.
    ConsoleWindow,
    /// A pane's own window.
    PaneWindow,
}

/// How bad a captured line is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, VariantArray)]
#[serde(rename_all = "camelCase")]
pub enum AppDiagnosticSeverity {
    /// An error.
    Error,
    /// A warning.
    Warning,
    /// A notice.
    Notice,
}

/// Why records were not written.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AppDiagnosticHeldBackCause {
    /// A window had more to send than it holds while it waited to send.
    WindowBufferFull,
    /// Past the rate at which the app writes records.
    PastRate,
    /// The service could not be reached and the app holds no more.
    ServiceUnreachable,
    /// The service was reached and did not take them.
    ServiceRefused,
}

ts_constants! {
    /// The longest each text of an app diagnostic record may be.
    pub const APP_DIAGNOSTIC_TEXT_BOUNDS: AppDiagnosticTextBounds = AppDiagnosticTextBounds {
        name: 128,
        message: 1024,
        stack: 8192,
        address: 2048,
        reason: 64,
        label: 128,
    };
    /// Every place an error can go unhandled, in order.
    APP_DIAGNOSTIC_ROLES = AppDiagnosticRole::VARIANTS;
    /// Every severity of a captured line, worst first.
    APP_DIAGNOSTIC_SEVERITIES = AppDiagnosticSeverity::VARIANTS;
}

/// An error's name.
type AppErrorName = BoundedText<0, { APP_DIAGNOSTIC_TEXT_BOUNDS.name }>;

/// An error's message, or what a captured line says happened.
type AppDiagnosticMessage = BoundedText<0, { APP_DIAGNOSTIC_TEXT_BOUNDS.message }>;

/// An error's stack frames.
type AppErrorStack = BoundedText<0, { APP_DIAGNOSTIC_TEXT_BOUNDS.stack }>;

/// A script's address.
type AppScriptAddress = BoundedText<0, { APP_DIAGNOSTIC_TEXT_BOUNDS.address }>;

/// Why the window's process went.
type AppRendererGoneReason = BoundedText<0, { APP_DIAGNOSTIC_TEXT_BOUNDS.reason }>;

/// The module that captured a line, or what kind of line it is.
type AppDiagnosticLabel = BoundedText<0, { APP_DIAGNOSTIC_TEXT_BOUNDS.label }>;

/// Where a script error was thrown: the script's address, and the line and column it names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppErrorSource {
    /// The script's address, without its query or fragment.
    pub address: AppScriptAddress,
    /// The line.
    pub line: SafeInt<0>,
    /// The column.
    pub column: SafeInt<0>,
}

/// Declares [`AppDiagnosticRecord`], writing the members of an unhandled error's two arms once.
macro_rules! app_diagnostic_record {
    ($($(#[doc = $doc:literal])+ $arm:ident,)+) => {
        /// One record of `daemon.appDiagnostic.record`, told apart by its `kind`.
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(
            tag = "kind",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[garde(allow_unvalidated)]
        pub enum AppDiagnosticRecord {
            $(
                $(#[doc = $doc])+
                $arm {
                    /// When it happened.
                    #[garde(dive)]
                    at: WireInstant,
                    /// Where in the app it went unhandled.
                    role: AppDiagnosticRole,
                    /// The error's name, or `null` for a thrown value that is no error.
                    #[serde(deserialize_with = "crate::wire::nullable")]
                    #[schemars(with = "crate::wire::NullableSchema<AppErrorName>")]
                    name: Option<AppErrorName>,
                    /// Its message, with every quoted run taken out.
                    message: AppDiagnosticMessage,
                    /// Its stack frames, one per line, or `null` where it has none.
                    #[serde(deserialize_with = "crate::wire::nullable")]
                    #[schemars(with = "crate::wire::NullableSchema<AppErrorStack>")]
                    stack: Option<AppErrorStack>,
                    /// Where it was thrown, or `null` where that is not known.
                    #[serde(deserialize_with = "crate::wire::nullable")]
                    #[schemars(with = "crate::wire::NullableSchema<AppErrorSource>")]
                    source: Option<AppErrorSource>,
                },
            )+
            /// A line a window's diagnostic capture took: something the app could not do or could
            /// not read.
            Captured {
                /// When the window captured it.
                #[garde(dive)]
                at: WireInstant,
                /// How bad it is.
                severity: AppDiagnosticSeverity,
                /// The module that captured it.
                source: AppDiagnosticLabel,
                /// What kind of line it is, in that module's own words.
                captured_kind: AppDiagnosticLabel,
                /// What happened, with every quoted run taken out.
                detail: AppDiagnosticMessage,
            },
            /// The process drawing every window went away; main reloads it.
            RendererGone {
                /// When it went.
                #[garde(dive)]
                at: WireInstant,
                /// Why it went, in Electron's own word.
                reason: AppRendererGoneReason,
                /// Its exit code.
                exit_code: ExitCode,
            },
            /// How many records were not written, and why.
            HeldBack {
                /// When it was counted.
                #[garde(dive)]
                at: WireInstant,
                /// How many records were not written.
                count: SafeInt<0>,
                /// Why.
                cause: AppDiagnosticHeldBackCause,
            },
        }
    };
}

app_diagnostic_record! {
    /// An exception nothing caught.
    UncaughtError,
    /// A promise rejected with nothing to handle it.
    UnhandledRejection,
}

methods! {
    /// The method main writes an app diagnostic with.
    pub const DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS = [
        /// Writes one record to the service's diagnostic log; answers once it is written. It
        /// writes the log and no state, so neither a recovery nor a version apart refuses it.
        DaemonAppDiagnosticRecord = mutation "daemon.appDiagnostic.record" {
            mutating: false,
            params: AppDiagnosticRecord,
            result: EmptyPayload,
            refusals: [],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "daemon/app-diagnostic",
    doc: "What the desktop app records about itself, which its main process hands the service to \
          write in its diagnostic log.",
    definitions: &[
        Definition::read::<AppDiagnosticRole>(),
        Definition::read::<AppDiagnosticSeverity>(),
        Definition::read::<AppDiagnosticHeldBackCause>(),
        Definition::read::<AppErrorSource>(),
        Definition::read::<AppDiagnosticRecord>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS],
};
