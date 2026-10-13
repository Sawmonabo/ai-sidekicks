//! What the desktop app records about itself, which its main process hands the service to write in
//! its diagnostic log, so it is kept, and dropped, with the service's own lines: an error nothing
//! handled, a line a window's diagnostic capture took, the window process going away, and a count
//! of what was not written. Each text is bounded here; main fills a record with an error's name,
//! its message with every quoted run taken out, and its stack frames, and never with a value a
//! promise was rejected with.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::{SafeInt, SafeSignedInt};
use crate::wire::text::Text;

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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
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
#[serde(rename_all = "kebab-case")]
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
    pub const APP_DIAGNOSTIC_ROLES: [AppDiagnosticRole; 4] = [
        AppDiagnosticRole::Main,
        AppDiagnosticRole::ConsoleDocument,
        AppDiagnosticRole::ConsoleWindow,
        AppDiagnosticRole::PaneWindow,
    ];
    /// Every severity of a captured line, worst first.
    pub const APP_DIAGNOSTIC_SEVERITIES: [AppDiagnosticSeverity; 3] = [
        AppDiagnosticSeverity::Error,
        AppDiagnosticSeverity::Warning,
        AppDiagnosticSeverity::Notice,
    ];
}

/// How an unhandled error arrived: an exception nothing caught, or a promise rejected with nothing
/// to handle it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
#[schemars(inline)]
pub enum AppErrorThrownKind {
    /// An exception nothing caught.
    UncaughtError,
    /// A promise rejected with nothing to handle it.
    UnhandledRejection,
}

/// Where a script error was thrown: the script's address, and the line and column from 1.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppErrorSource {
    /// The script's address, without its query or fragment.
    pub address: Text<0, 2048>,
    /// The line.
    pub line: SafeInt<0>,
    /// The column.
    pub column: SafeInt<0>,
}

/// An exception nothing caught, or a promise rejected with nothing to handle it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AppErrorThrown {
    /// How it arrived.
    pub kind: AppErrorThrownKind,
    /// When it happened.
    #[garde(dive)]
    pub at: WireInstant,
    /// Where in the app it went unhandled.
    pub role: AppDiagnosticRole,
    /// The error's name, or `null` for a thrown value that is no error.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<Text<0, 128>>")]
    pub name: Option<Text<0, 128>>,
    /// Its message, with every quoted run taken out.
    pub message: Text<0, 1024>,
    /// Its stack frames, one per line, or `null` where it has none.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<Text<0, 8192>>")]
    pub stack: Option<Text<0, 8192>>,
    /// Where it was thrown, or `null` where that is not known.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<AppErrorSource>")]
    pub source: Option<AppErrorSource>,
}

/// The word `captured`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
#[schemars(inline)]
pub enum AppCapturedKind {
    /// A captured line.
    Captured,
}

/// A line a window's diagnostic capture took: something the app could not do or could not read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AppCapturedDiagnostic {
    /// Always `captured`.
    pub kind: AppCapturedKind,
    /// When the window captured it.
    #[garde(dive)]
    pub at: WireInstant,
    /// How bad it is.
    pub severity: AppDiagnosticSeverity,
    /// The module that captured it.
    pub source: Text<0, 128>,
    /// What kind of line it is, in that module's own words.
    pub captured_kind: Text<0, 128>,
    /// What happened, with every quoted run taken out.
    pub detail: Text<0, 1024>,
}

/// The word `renderer-gone`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
#[schemars(inline)]
pub enum AppRendererGoneKind {
    /// The window process went away.
    RendererGone,
}

/// The process drawing every window went away; main reloads it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AppRendererGone {
    /// Always `renderer-gone`.
    pub kind: AppRendererGoneKind,
    /// When it went.
    #[garde(dive)]
    pub at: WireInstant,
    /// Why it went, in Electron's own word.
    pub reason: Text<0, 64>,
    /// Its exit code.
    pub exit_code: SafeSignedInt,
}

/// The word `held-back`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
#[schemars(inline)]
pub enum AppDiagnosticHeldBackKind {
    /// Records were not written.
    HeldBack,
}

/// How many records were not written, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AppDiagnosticHeldBack {
    /// Always `held-back`.
    pub kind: AppDiagnosticHeldBackKind,
    /// When it was counted.
    #[garde(dive)]
    pub at: WireInstant,
    /// How many records were not written.
    pub count: SafeInt<0>,
    /// Why.
    pub cause: AppDiagnosticHeldBackCause,
}

/// One record of `daemon.appDiagnostic.record`, told apart by its `kind`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum AppDiagnosticRecord {
    /// An error nothing handled.
    Thrown(#[garde(dive)] AppErrorThrown),
    /// A captured line.
    Captured(#[garde(dive)] AppCapturedDiagnostic),
    /// The window process went away.
    RendererGone(#[garde(dive)] AppRendererGone),
    /// Records not written.
    HeldBack(#[garde(dive)] AppDiagnosticHeldBack),
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
        Definition::read::<AppErrorThrown>(),
        Definition::read::<AppCapturedDiagnostic>(),
        Definition::read::<AppRendererGone>(),
        Definition::read::<AppDiagnosticHeldBack>(),
        Definition::read::<AppDiagnosticRecord>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS],
};
