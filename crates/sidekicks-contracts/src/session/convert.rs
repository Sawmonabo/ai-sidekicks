//! Converting a chat to a project: the request, the copy's outcome, the `session.converted`
//! payload and the read of the files the copy skipped.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::jsonrpc::page::fits_one_page;
use crate::repo::mount::RepoMountId;
use crate::session::draft::ClientUuid;
use crate::session::id::SessionId;
use crate::transcript::operations::BoolLiteral;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::{BoundedInt, SafeInt};
use crate::wire::text::{FreeFormText, Text};

/// Converts a chat to a project. `path` is the folder the person typed; it travels as data and the
/// daemon checks it, reusing the machine's mount for that folder or attaching one, and refusing a
/// folder that is not a git repository.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionConvertRequest {
    /// The chat.
    pub session_id: SessionId,
    /// The folder.
    pub path: FreeFormText<FILE_PATH_MAX_LEN>,
    /// The key that makes a repeated convert one conversion.
    pub client_idempotency_key: ClientUuid,
}

/// Why one of the workspace's files was not copied.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
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
    pub path: Text<1, FILE_PATH_MAX_LEN>,
    /// Why it was not copied.
    pub reason: SessionConvertSkipReason,
}

/// How many of the workspace's files were copied into the repository and how many were not. A
/// file not copied stays in the chat's workspace, which the session keeps, and nothing is merged.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionConvertResponse {
    /// Files copied.
    pub copied_count: SafeInt<0>,
    /// Files not copied, each read with its reason through `session.convertSkippedFileList`.
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

/// The most skipped files one `session.convertSkippedFileList` page carries, and its default.
pub const SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX: usize = 256;

/// The longest skipped-file cursor accepted: the daemon's encoding of a path, at most four
/// characters for each of the path's UTF-16 units.
const SESSION_CONVERT_SKIPPED_FILE_CURSOR_MAX_LEN: usize = FILE_PATH_MAX_LEN * 4;

/// The skipped-file cursor's pattern: base64url without padding.
const SESSION_CONVERT_SKIPPED_FILE_CURSOR_PATTERN: &str = "^[A-Za-z0-9_-]+$";

/// Where the next `session.convertSkippedFileList` page starts: a bounded base64url string. The
/// daemon writes it and owns its format; a client passes it back unchanged with the same session.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct SessionConvertSkippedFileCursor(String);

impl SessionConvertSkippedFileCursor {
    /// Checks `text`; refuses anything but 1 to the bound of base64url characters.
    pub fn new(text: String) -> Option<Self> {
        let is_base64url = text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
        let is_in_bounds =
            !text.is_empty() && text.len() <= SESSION_CONVERT_SKIPPED_FILE_CURSOR_MAX_LEN;
        (is_base64url && is_in_bounds).then_some(Self(text))
    }

    /// The cursor's text as received.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for SessionConvertSkippedFileCursor {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).ok_or_else(|| {
            serde::de::Error::custom("a skipped-file cursor is 1 or more base64url characters")
        })
    }
}

impl JsonSchema for SessionConvertSkippedFileCursor {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "SessionConvertSkippedFileCursor".into()
    }

    fn json_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "description": "Where the next `session.convertSkippedFileList` page starts.",
            "type": "string",
            "minLength": 1,
            "maxLength": SESSION_CONVERT_SKIPPED_FILE_CURSOR_MAX_LEN,
            "pattern": SESSION_CONVERT_SKIPPED_FILE_CURSOR_PATTERN,
            "tsType": "string & { readonly __brand: \"SessionConvertSkippedFileCursor\" }",
        })
    }
}

/// How many skipped files a page may carry: 1 to [`SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX`].
pub type SessionConvertSkippedFileLimit = BoundedInt<1, 256>;

/// The `session.convertSkippedFileList` input: the converted session and, past the first page,
/// the previous page's `nextCursor`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionConvertSkippedFileListRequest {
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
    /// The files, in path order.
    #[garde(length(min = 1, max = SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX), custom(fits_one_page))]
    #[schemars(length(min = 1, max = 256))]
    pub files: Vec<SessionConvertSkippedFile>,
    /// More files follow.
    pub has_more: BoolLiteral<true>,
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
    /// The files, in path order.
    #[garde(length(max = SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX), custom(fits_one_page))]
    #[schemars(length(max = 256))]
    pub files: Vec<SessionConvertSkippedFile>,
    /// No files follow.
    pub has_more: BoolLiteral<false>,
}

/// One page of the files a conversion did not copy, in path order, split on `hasMore`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum SessionConvertSkippedFileListResponse {
    /// More files follow.
    Continuing(#[garde(dive)] SessionConvertSkippedFilesContinuing),
    /// The last page.
    Terminal(#[garde(dive)] SessionConvertSkippedFilesTerminal),
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/convert",
    doc: "Converting a chat to a project: the request, the copy's outcome, the \
          `session.converted` payload and the read of the files the copy skipped.",
    definitions: &[
        Definition::read::<SessionConvertRequest>().checked(),
        Definition::read::<SessionConvertSkipReason>(),
        Definition::read::<SessionConvertSkippedFile>(),
        Definition::read::<SessionConvertResponse>().checked(),
        Definition::read::<SessionConvertedPayload>().checked(),
        Definition::read::<SessionConvertSkippedFileCursor>(),
        Definition::read::<SessionConvertSkippedFileListRequest>().checked(),
        Definition::read::<SessionConvertSkippedFileListResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
