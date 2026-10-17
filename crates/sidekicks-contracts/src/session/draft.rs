//! The composer's daemon-held store for one session: the unsent draft, the staged files, covering
//! part of a staged picture, and the refusals staging can answer with.
//!
//! The daemon holds all of it, scoped to the session, so a half-typed message and its staged files
//! reach the person's other devices and Send needs no upload step. A staged file is copied to the
//! daemon when it is staged and kept outside the checkout; from then on it is addressed by its
//! artifact id and its original path is never read again.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::artifacts::id::ArtifactId;
use crate::free_form_string::{FILE_PATH_MAX_LEN, FilesystemPath};
use crate::jsonrpc::refusal::RefusalCode;
use crate::mcp::server::McpServerName;
use crate::method::methods;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::id::ClientUuid;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::literal;
use crate::wire::text::{BoundedText, NonEmptyText};

/// Saves a session's draft. `text` is the whole draft and replaces the one held; an empty string
/// clears it, which is what Send does. The text has no length limit of its own: a message's limit
/// is the send's to state, so a draft the send would take is never refused here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionDraftUpdateRequest {
    /// The session.
    pub session_id: SessionId,
    /// The whole draft; empty clears it.
    pub text: String,
}

/// When the daemon stored the draft.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionDraftUpdateResponse {
    /// The session.
    pub session_id: SessionId,
    /// When the draft was stored.
    #[garde(dive)]
    pub updated_at: WireInstant,
}

/// One staged file as the daemon holds it. Every member is what the daemon found in the bytes it
/// copied, never what the caller declared: the name it stored the file under, the media type it
/// read from the bytes, and the size it measured.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAttachmentSummary {
    /// The staged file's artifact.
    pub artifact_id: ArtifactId,
    /// The name the daemon stored it under.
    pub file_name: BoundedText<1, FILE_PATH_MAX_LEN>,
    /// The media type read from its bytes.
    pub mime_type: NonEmptyText,
    /// Its size in bytes, as measured.
    pub size_bytes: SafeInt<0>,
}

/// One thing to stage: a file picked, dropped or pasted, by its path, or a resource a tool server
/// publishes. A path reaches the daemon only from the main process or the command line; a
/// resource's address names it on its server and is never read as a path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SessionAttachmentItem {
    /// A file, by its path.
    File {
        /// The client's id for this one item, so a retried stage never stages it twice.
        client_staging_id: ClientUuid,
        /// The file's path.
        path: FilesystemPath,
    },
    /// A resource a tool server publishes.
    McpResource {
        /// The client's id for this one item, so a retried stage never stages it twice.
        client_staging_id: ClientUuid,
        /// The session's name for the server.
        server_name: McpServerName,
        /// The resource's own address on the server.
        uri: NonEmptyText,
    },
}

/// Stages files for the next message. The count is not limited here: a pick over the message's
/// limit stages as many as fit and refuses each of the rest by name; an empty list is refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionAttachmentAddRequest {
    /// The session.
    pub session_id: SessionId,
    /// The things to stage; at least one.
    pub items: BoundedVec<SessionAttachmentItem, 1, { usize::MAX }>,
}

ts_constants! {
    /// The code for a file the session cannot stage.
    SESSION_ATTACHMENT_REFUSED_CODE = RefusalCode::SessionAttachmentRefused;
}

literal! {
    /// The code of an item the session could not stage.
    pub enum SessionAttachmentRefusedCode = const RefusalCode::SessionAttachmentRefused.as_str();
    /// The code of a file the free disk cannot hold even with nothing else being taken.
    pub enum ArtifactTooLargeCode = const RefusalCode::ArtifactTooLarge.as_str();
    /// The code of a file that only waits on the files already being taken.
    pub enum ArtifactIngestCapacityExhaustedCode =
        const RefusalCode::ArtifactIngestCapacityExhausted.as_str();
}

literal! {
    /// The provider's own limit, or its refusal of a picture.
    pub enum ProviderRefusedReason = "providerRefused";
    /// The copy to the daemon did not complete.
    pub enum CopyFailedReason = "copyFailed";
}

/// Why the session would not stage a file, by a rule of its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SessionAttachmentLimitReason {
    /// The message already carries as many files as the provider takes.
    CountLimit,
    /// A folder was offered; an agent reads a folder where it is.
    Folder,
    /// The session's provider accepts no files.
    ProviderTakesNoAttachments,
    /// A card above the composer is waiting on the person.
    CardWaiting,
}

/// A session rule refused the item.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SessionAttachmentLimitRefusal {
    /// Always `session.attachment.refused`.
    pub code: SessionAttachmentRefusedCode,
    /// The rule.
    pub reason: SessionAttachmentLimitReason,
}

/// The provider would not take the file: its own limit, or its refusal of a picture.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SessionAttachmentProviderRefusal {
    /// Always `session.attachment.refused`.
    pub code: SessionAttachmentRefusedCode,
    /// Always `providerRefused`.
    pub reason: ProviderRefusedReason,
    /// The provider's own words, shown as given.
    pub provider_message: NonEmptyText,
}

/// The copy to the daemon did not complete.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SessionAttachmentCopyFailure {
    /// Always `session.attachment.refused`.
    pub code: SessionAttachmentRefusedCode,
    /// Always `copyFailed`.
    pub reason: CopyFailedReason,
    /// The daemon's own cause, the text after `·` on the refusal line.
    pub detail: NonEmptyText,
}

/// The free disk cannot hold the file even with nothing else being taken.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SessionAttachmentDiskFull {
    /// Always `artifact.tooLarge`.
    pub code: ArtifactTooLargeCode,
    /// The room the disk has, in bytes.
    pub available_bytes: SafeInt<0>,
}

/// The file only waits on the files already being taken.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SessionAttachmentIngestBusy {
    /// Always `artifact.ingest.capacityExhausted`.
    pub code: ArtifactIngestCapacityExhaustedCode,
}

/// Why one item was not staged: a session rule, the provider's refusal with its words, a failed
/// copy with the daemon's cause, a disk too full with the room it has, or the ingest being busy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum SessionAttachmentRefusalCause {
    /// A session rule.
    Limit(SessionAttachmentLimitRefusal),
    /// The provider's refusal.
    ProviderRefused(SessionAttachmentProviderRefusal),
    /// A failed copy.
    CopyFailed(SessionAttachmentCopyFailure),
    /// A disk too full.
    DiskFull(SessionAttachmentDiskFull),
    /// The ingest is busy.
    IngestBusy(SessionAttachmentIngestBusy),
}

/// One item the daemon did not stage, by the name the refusal line shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAttachmentRefusal {
    /// The client's id for the item.
    pub client_staging_id: ClientUuid,
    /// The name the refusal line shows.
    pub name: NonEmptyText,
    /// Why it was not staged.
    pub cause: SessionAttachmentRefusalCause,
}

/// The whole staged set after the add, so a client draws what the daemon holds rather than merging
/// its own add, and each item it did not stage with the cause.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionAttachmentAddResponse {
    /// The session.
    pub session_id: SessionId,
    /// The staged set.
    pub attachments: Vec<SessionAttachmentSummary>,
    /// The items not staged.
    pub refused: Vec<SessionAttachmentRefusal>,
}

/// Unstages one file. The artifact itself keeps its own life; only its place in the staged set
/// goes. Removing a file that is no longer staged answers with the set as it is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionAttachmentRemoveRequest {
    /// The session.
    pub session_id: SessionId,
    /// The staged file's artifact.
    pub artifact_id: ArtifactId,
}

/// The whole staged set left after the removal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionAttachmentRemoveResponse {
    /// The session.
    pub session_id: SessionId,
    /// The staged set.
    pub attachments: Vec<SessionAttachmentSummary>,
}

/// One box to cover, in the picture's own pixels from its top-left corner; never empty.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAttachmentCoverBox {
    /// The left edge.
    pub x: SafeInt<0>,
    /// The top edge.
    pub y: SafeInt<0>,
    /// The width; at least one.
    pub width: SafeInt<1>,
    /// The height; at least one.
    pub height: SafeInt<1>,
}

/// Covers parts of a staged picture before Send. The daemon draws the boxes into the pixels, stores
/// the covered copy as a new artifact that takes the old one's place in the staged set, and deletes
/// the uncovered copy, so the provider only ever receives the covered picture. A picture already
/// sent cannot be covered; an empty box list is refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionAttachmentCoverRequest {
    /// The staged picture.
    pub attachment_id: ArtifactId,
    /// The boxes to cover; at least one.
    pub boxes: BoundedVec<SessionAttachmentCoverBox, 1, { usize::MAX }>,
}

/// The covered copy, which is now the staged attachment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionAttachmentCoverResponse {
    /// The covered copy.
    pub attachment: SessionAttachmentSummary,
}

methods! {
    /// The composer store's methods, each with its types.
    pub const SESSION_DRAFT_METHOD_DESCRIPTORS = [
        /// Saves the session's draft.
        SessionDraftUpdate = mutation "session.draft.update" {
            mutating: true,
            params: SessionDraftUpdateRequest,
            result: SessionDraftUpdateResponse,
            refusals: [SessionNotFound],
        },
        /// Stages files for the next message; each refused item rides in the reply.
        SessionAttachmentAdd = mutation "session.attachment.add" {
            mutating: true,
            params: SessionAttachmentAddRequest,
            result: SessionAttachmentAddResponse,
            refusals: [SessionNotFound],
        },
        /// Unstages one file.
        SessionAttachmentRemove = mutation "session.attachment.remove" {
            mutating: true,
            params: SessionAttachmentRemoveRequest,
            result: SessionAttachmentRemoveResponse,
            refusals: [SessionNotFound],
        },
        /// Covers parts of a staged picture.
        SessionAttachmentCover = mutation "session.attachment.cover" {
            mutating: true,
            params: SessionAttachmentCoverRequest,
            result: SessionAttachmentCoverResponse,
            refusals: [],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/draft",
    doc: "The composer's daemon-held store for one session: the unsent draft, the staged files, \
          covering part of a staged picture, and the refusals staging can answer with.",
    definitions: &[
        Definition::read::<SessionDraftUpdateRequest>().checked(),
        Definition::read::<SessionDraftUpdateResponse>().checked(),
        Definition::read::<SessionAttachmentSummary>(),
        Definition::read::<SessionAttachmentItem>(),
        Definition::read::<SessionAttachmentAddRequest>().checked(),
        Definition::read::<SessionAttachmentLimitReason>(),
        Definition::read::<SessionAttachmentRefusalCause>(),
        Definition::read::<SessionAttachmentRefusal>(),
        Definition::read::<SessionAttachmentAddResponse>().checked(),
        Definition::read::<SessionAttachmentRemoveRequest>().checked(),
        Definition::read::<SessionAttachmentRemoveResponse>().checked(),
        Definition::read::<SessionAttachmentCoverBox>(),
        Definition::read::<SessionAttachmentCoverRequest>().checked(),
        Definition::read::<SessionAttachmentCoverResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&SESSION_DRAFT_METHOD_DESCRIPTORS],
};
