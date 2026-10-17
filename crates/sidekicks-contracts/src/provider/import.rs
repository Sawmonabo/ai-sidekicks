//! Importing a provider's own conversations into the sessions list. One import runs per provider
//! and belongs to the service, not the page that started it; its stream is keyed by provider, and
//! the service keeps each provider's last outcome until the next import and sends it first.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FilesystemPath;
use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::place::{PlacedPath, WslPlace};
use crate::provider::id::ProviderId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::text::{FreeFormText, branded_text};

ts_constants! {
    /// The longest import id.
    pub const PROVIDER_IMPORT_ID_MAX_LEN: usize = 256;
    /// The longest reason text.
    pub const PROVIDER_IMPORT_REASON_MAX_LEN: usize = 1024;
    /// The longest project name in a settled line.
    pub const PROVIDER_IMPORT_PROJECT_NAME_MAX_LEN: usize = 256;
    /// The most failures, unreadable files or attached projects one settled line may list.
    pub const PROVIDER_IMPORT_LIST_MAX: usize = 10_000;
}

/// The service's reason, in its own words.
type ImportReason = FreeFormText<PROVIDER_IMPORT_REASON_MAX_LEN>;
/// A list one settled line carries.
type ImportList<T> = BoundedVec<T, 0, PROVIDER_IMPORT_LIST_MAX>;

branded_text! {
    /// The daemon-minted id of one import, opaque to every client.
    pub struct ProviderImportId(1..=PROVIDER_IMPORT_ID_MAX_LEN);
}

/// A request naming the provider whose conversations are imported.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderImportProviderRequest {
    /// The provider.
    pub provider: ProviderId,
}

/// How many projects the app does not have the import would attach. A count above zero is
/// confirmed before the import runs, because attaching a project trusts its folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderImportPreviewResponse {
    /// The provider.
    pub provider: ProviderId,
    /// The projects the import would attach.
    pub projects_to_attach: SafeInt<0>,
}

/// The import now running for that provider: a new one, or the one already running.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderImportStartResponse {
    /// The import.
    pub import_id: ProviderImportId,
}

/// One conversation the import could not bring in, and the service's reason.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderImportFailure {
    /// The conversation's file.
    pub source: FilesystemPath,
    /// The distribution the file is in, its path in Linux form; absent elsewhere.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WslPlace")]
    pub place: Option<WslPlace>,
    /// Why it was not brought in.
    pub reason: ImportReason,
}

/// How an import ended. `nothingNew` still reports what was already here and what could not be
/// read, so an empty result is never blank; `stopped` leaves the sessions already read in the list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderImportOutcome {
    /// The import read everything it found.
    Finished {
        /// The conversations imported.
        imported: SafeInt<0>,
        /// The conversations read.
        total: SafeInt<0>,
        /// The conversations already here.
        already_here: SafeInt<0>,
        /// Each conversation not brought in, with its reason.
        failures: ImportList<ProviderImportFailure>,
        /// The files that could not be opened, each with the distribution it is in.
        unreadable_files: ImportList<PlacedPath>,
        /// The projects the import attached.
        attached_projects: ImportList<FreeFormText<PROVIDER_IMPORT_PROJECT_NAME_MAX_LEN>>,
    },
    /// Nothing new was found.
    NothingNew {
        /// The conversations already here.
        already_here: SafeInt<0>,
        /// The files that could not be opened, each with the distribution it is in.
        unreadable_files: ImportList<PlacedPath>,
    },
    /// The person stopped it.
    Stopped {},
    /// The service refused it.
    Refused {
        /// The service's own words.
        reason: ImportReason,
    },
}

/// One message on a provider's import stream: the running import's count of conversations read so
/// far, or how the last import ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum ProviderImportProgress {
    /// The running import's count so far.
    Progress {
        /// The provider.
        provider: ProviderId,
        /// The import.
        import_id: ProviderImportId,
        /// The conversations read so far.
        read: SafeInt<0>,
    },
    /// How the last import ended.
    Settled {
        /// The provider.
        provider: ProviderId,
        /// The import.
        import_id: ProviderImportId,
        /// How it ended.
        settlement: ProviderImportOutcome,
    },
}

/// Stop one import. The conversations already read stay in the sessions list, and the stopped
/// outcome arrives on the provider's stream; stopping a settled import changes nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderImportStopRequest {
    /// The import.
    pub import_id: ProviderImportId,
}

methods! {
    /// The four import methods: their names, how each answers, and their shapes.
    pub const SESSION_IMPORT_METHOD_DESCRIPTORS = [
        /// Counts the projects an import would attach.
        SessionImportPreview = query "session.import.preview" {
            mutating: false,
            params: ProviderImportProviderRequest,
            result: ProviderImportPreviewResponse,
            refusals: [],
        },
        /// Starts a provider's import, or answers the one running.
        SessionImport = mutation "session.import.start" {
            mutating: true,
            params: ProviderImportProviderRequest,
            result: ProviderImportStartResponse,
            refusals: [],
        },
        /// Streams a provider's import, its last outcome first.
        SessionImportSubscribe = subscription "session.import.subscribe" {
            mutating: false,
            params: ProviderImportProviderRequest,
            result: SubscribeAckResponse,
            emission: ProviderImportProgress,
            refusals: [],
        },
        /// Stops one import.
        SessionImportStop = mutation "session.import.stop" {
            mutating: true,
            params: ProviderImportStopRequest,
            result: EmptyPayload,
            refusals: [],
        },
    ];
}

/// The TypeScript module of provider imports.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/import",
    doc: "Importing a provider's own conversations into the sessions list.",
    definitions: &[
        Definition::read::<ProviderImportId>(),
        Definition::read::<ProviderImportProviderRequest>(),
        Definition::read::<ProviderImportPreviewResponse>(),
        Definition::read::<ProviderImportStartResponse>(),
        Definition::read::<ProviderImportFailure>(),
        Definition::read::<ProviderImportOutcome>(),
        Definition::read::<ProviderImportProgress>(),
        Definition::read::<ProviderImportStopRequest>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&SESSION_IMPORT_METHOD_DESCRIPTORS],
};
