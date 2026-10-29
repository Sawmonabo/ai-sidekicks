//! Converting a chat to a project: the request, the copy's outcome, the `session.converted`
//! payload, the read of the files the copy skipped, and the details of a refused or incomplete
//! conversion.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::free_form_string::{FILE_PATH_MAX_LEN, FilesystemPath};
use crate::jsonrpc::page::{PAGE_MAX_BYTES, fits_one_page};
use crate::method::KeyedRequest;
use crate::place::Place;
use crate::repo::mount::RepoMountId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::id::ClientUuid;
use crate::wire::integer::{BoundedInt, SafeInt, count_bound};
use crate::wire::list::BoundedVec;
use crate::wire::text::pattern_text;
use crate::wire::{False, True};

/// Converts a chat to a project. `path` is the folder the person typed; it travels as data and the
/// daemon checks it, reusing the machine's mount for that folder or attaching one, and refusing a
/// folder that is not a git repository. The path is read in the chat's own place: a Linux path in
/// the chat's distribution, a drive path or its `/mnt/<drive>` form on Windows; a folder in another
/// place is refused with `session.conversion.refused`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionConvertRequest {
    /// The chat.
    pub session_id: SessionId,
    /// The folder.
    pub path: FilesystemPath,
    /// The key that makes a repeated convert one conversion.
    pub client_idempotency_key: ClientUuid,
}

impl KeyedRequest for SessionConvertRequest {}

/// Why one of the workspace's files was not copied.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    IntoStaticStr,
    VariantArray,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum SessionConvertSkipReason {
    /// The repository already holds its path.
    RepositoryHasFile,
    /// A folder on its path is a file or a link in the repository.
    RepositoryPathNotAFolder,
    /// The workspace's entry is a link, which is not copied.
    Link,
    /// The workspace's entry is a pipe, a socket or a device, which is not copied.
    SpecialFile,
}

/// One file the conversion did not copy, by its path relative to the workspace, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionConvertSkippedFile {
    /// The path; any name the filesystem holds, a name of spaces alone included.
    pub path: FilesystemPath,
    /// Why it was not copied.
    pub reason: SessionConvertSkipReason,
}

/// How many of the workspace's files were copied into the repository and how many were not. A
/// file not copied stays in the chat's workspace, which the session keeps, and nothing is merged.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionConvertResponse {
    /// Files copied.
    pub copied_count: SafeInt<0>,
    /// Files not copied, each read with its reason through `session.conversion.skippedFile.list`.
    pub skipped_count: SafeInt<0>,
}

/// The `session.converted` payload: the project the chat became, and the copy's outcome.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionConvertedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The repository it now works in.
    pub repo_mount_id: RepoMountId,
    /// Files copied.
    pub copied_count: SafeInt<0>,
    /// Files not copied.
    pub skipped_count: SafeInt<0>,
}

/// The most skipped files one `session.conversion.skippedFile.list` page carries, and its default.
pub const SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX: usize = 256;

/// The longest skipped-file cursor accepted: the daemon's encoding of a path, at most four
/// characters for each of the path's UTF-16 units.
const SESSION_CONVERT_SKIPPED_FILE_CURSOR_MAX_LEN: usize = FILE_PATH_MAX_LEN * 4;

pattern_text! {
    /// Where the next `session.conversion.skippedFile.list` page starts: base64url without padding,
    /// at least one character and at most four for each UTF-16 unit of the longest path. The daemon
    /// writes it and owns its format; a client passes it back unchanged with the same session.
    pub struct SessionConvertSkippedFileCursor(
        "^[A-Za-z0-9_-]+$",
        max = SESSION_CONVERT_SKIPPED_FILE_CURSOR_MAX_LEN
    ) branded;
}

/// How many skipped files a page may carry: 1 to [`SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX`].
pub type SessionConvertSkippedFileLimit =
    BoundedInt<1, { count_bound(SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX) }>;

/// The `session.conversion.skippedFile.list` input: the converted session and, past the first page,
/// the previous page's `nextCursor`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionConversionSkippedFileListRequest {
    /// The session.
    pub session_id: SessionId,
    /// Continue from this cursor.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionConvertSkippedFileCursor")]
    pub after_cursor: Option<SessionConvertSkippedFileCursor>,
    /// The most files on one page; the default is the most.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionConvertSkippedFileLimit")]
    pub limit: Option<SessionConvertSkippedFileLimit>,
}

/// A page of skipped files with more after it: at least one file, and the cursor to continue from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct SessionConvertSkippedFilesContinuing {
    /// The files, in the order of their path keys.
    #[garde(custom(fits_one_page))]
    #[schemars(extend("maxJsonBytes" = PAGE_MAX_BYTES))]
    pub files:
        BoundedVec<SessionConvertSkippedFile, 1, SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX>,
    /// More files follow.
    pub has_more: True,
    /// Where to continue.
    pub next_cursor: SessionConvertSkippedFileCursor,
}

/// The last page of skipped files; a session never converted, or one that copied every file,
/// answers it empty.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct SessionConvertSkippedFilesTerminal {
    /// The files, in the order of their path keys.
    #[garde(custom(fits_one_page))]
    #[schemars(extend("maxJsonBytes" = PAGE_MAX_BYTES))]
    pub files:
        BoundedVec<SessionConvertSkippedFile, 0, SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX>,
    /// No files follow.
    pub has_more: False,
}

/// One page of the files a conversion did not copy, in the order of their path keys, split on
/// `hasMore`. A path key is the path's stable bytes compared byte by byte: on macOS and Linux the
/// path's own bytes, on Windows its UTF-16 units as two little-endian bytes each, so the order
/// follows no text collation and a client keeps it as given.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum SessionConversionSkippedFileListResponse {
    /// More files follow.
    Continuing(#[garde(dive)] SessionConvertSkippedFilesContinuing),
    /// The last page.
    Terminal(#[garde(dive)] SessionConvertSkippedFilesTerminal),
}

/// Why a `session.conversion.refused` refusal turned the convert away; a session that is not a chat
/// is refused with no reason.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    IntoStaticStr,
    VariantArray,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum SessionConversionRefusedReason {
    /// The chat has no managed workspace to convert.
    NoManagedWorkspace,
    /// The `clientIdempotencyKey` belongs to another session's conversion.
    IdempotencyKeyReused,
    /// The chat's conversion into another folder stopped part way.
    ConversionUnfinished,
    /// The folder is outside the chat's place, which never changes.
    FolderInAnotherPlace,
}

/// The details of a `session.conversion.refused` refusal: its reason, the mount of the stopped
/// conversion a `conversionUnfinished` names, and the chat's place a `folderInAnotherPlace` names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionConversionRefusedDetails {
    /// Why; absent for a session that is not a chat.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionConversionRefusedReason")]
    pub reason: Option<SessionConversionRefusedReason>,
    /// The mount the stopped conversion copies into.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RepoMountId")]
    pub repo_mount_id: Option<RepoMountId>,
    /// The chat's place.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
}

/// The details of a `session.conversion.incomplete` failure: what the conversion did before it
/// stopped. The session still reads as a chat.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionConversionIncompleteDetails {
    /// The session.
    pub session_id: SessionId,
    /// The mount the repository is attached as.
    pub repo_mount_id: RepoMountId,
    /// Files copied into it so far.
    pub copied_count: SafeInt<0>,
    /// Files not copied so far.
    pub skipped_count: SafeInt<0>,
    /// Whether the session was bound to the project.
    pub is_bound: bool,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/convert",
    doc: "Converting a chat to a project: the request, the copy's outcome, the \
          `session.converted` payload, the read of the files the copy skipped, and the details \
          of a refused or incomplete conversion.",
    definitions: &[
        Definition::read::<SessionConvertRequest>().checked(),
        Definition::read::<SessionConvertSkipReason>(),
        Definition::read::<SessionConvertSkippedFile>(),
        Definition::read::<SessionConvertResponse>().checked(),
        Definition::read::<SessionConvertedPayload>().checked(),
        Definition::read::<SessionConvertSkippedFileCursor>(),
        Definition::read::<SessionConversionSkippedFileListRequest>().checked(),
        Definition::read::<SessionConversionSkippedFileListResponse>().checked(),
        Definition::read::<SessionConversionRefusedReason>(),
        Definition::read::<SessionConversionRefusedDetails>(),
        Definition::read::<SessionConversionIncompleteDetails>(),
    ],
    constants: &[],
    method_tables: &[],
};
