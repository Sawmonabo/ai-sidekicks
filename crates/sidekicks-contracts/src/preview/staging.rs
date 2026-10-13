//! Files a Preview page saves or takes, staged on the machine: the folder main writes a relayed
//! download into, main's report of that download, and the parts in which a staged file crosses
//! between the daemon, main and another device.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::{FILE_PATH_MAX_LEN, FilesystemPath};
use crate::preview::page::PreviewPageId;
use crate::preview::screencast::PreviewInputMessageId;
use crate::wire::attachment::Bytes;
use crate::wire::integer::SafeInt;
use crate::wire::text::{BoundedText, branded_text};

/// The most bytes one part of a staged file carries, the size of a shared port's buffer, so a part
/// never holds a shell's typing on the same channel behind a message near the attachment cap.
pub const PREVIEW_FILE_PART_MAX_BYTES: usize = 256 * 1024;

/// One part of a staged file: at most [`PREVIEW_FILE_PART_MAX_BYTES`].
pub type PreviewFilePart = Bytes<0, PREVIEW_FILE_PART_MAX_BYTES>;

/// The longest save id the daemon mints.
pub const PREVIEW_SAVE_ID_MAX_LEN: usize = 256;

branded_text! {
    /// The daemon's handle for one file a page saved for a device, which the device acknowledges
    /// once it has written the file.
    pub struct PreviewSaveId(1..=PREVIEW_SAVE_ID_MAX_LEN);
}

/// The longest staged-file id main or the daemon mints.
pub const PREVIEW_STAGED_FILE_ID_MAX_LEN: usize = 256;

branded_text! {
    /// A random id naming one file staged in a folder: a download main wrote, or a file the
    /// daemon sets or drops on a page. It is never a path.
    pub struct PreviewStagedFileId(1..=PREVIEW_STAGED_FILE_ID_MAX_LEN);
}

/// A staged file's own name, already cleaned.
pub type PreviewFileName = BoundedText<1, FILE_PATH_MAX_LEN>;

/// The folder main writes a relayed download into, read once per connection: `null` on a Windows
/// computer whose daemon runs inside WSL 2, where no Windows path crosses and main stages in a
/// folder of its own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewPageStagingFolderReadResponse {
    /// The folder.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<FilesystemPath>")]
    pub folder: Option<FilesystemPath>,
}

/// The state a relayed download ended in, as Electron's download item reports it when done.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PreviewDownloadState {
    /// Every byte was written.
    Completed,
    /// The download was canceled; the wire carries Electron's British spelling of the word.
    #[serde(rename = "cancelled")]
    Canceled,
    /// The download broke off.
    Interrupted,
}

/// A download a relayed input owns, which main wrote to `<staging folder>/<fileId>` and reports
/// once it is done in any state. The daemon resolves `fileId` inside its folder itself and refuses
/// one main did not mint with `preview.file_path_refused`; on a WSL 2 computer it reads the file
/// from main in parts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPageDownloadReportRequest {
    /// The page.
    pub page_id: PreviewPageId,
    /// The last relayed input main carried to the page, which owns the download.
    pub message_id: PreviewInputMessageId,
    /// The id main minted for the download.
    pub file_id: PreviewStagedFileId,
    /// The item's own name, which Chromium has already cleaned.
    pub file_name: PreviewFileName,
    /// The state it ended in.
    pub state: PreviewDownloadState,
}

/// What the daemon did with a reported download.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PreviewDownloadVerdict {
    /// The daemon took the file, to send or to hold for the device whose input it was; nothing is
    /// said yet about its delivery.
    Accepted,
    /// No person started it, or it did not complete; the daemon has deleted the file, and for a
    /// completed download main shows `Downloads are off in Preview` on this machine's own window.
    Refused,
}

/// The daemon's answer to a download report.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewPageDownloadReportResponse {
    /// What it did.
    pub verdict: PreviewDownloadVerdict,
}

/// WSL 2 only: reads one part of a file main staged in its own folder, a download or a file the
/// page wrote through a handle the daemon's drop gave it, from `offset`. Main deletes its copy of
/// a download once the last part is read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPageFileReadRequest {
    /// The page.
    pub page_id: PreviewPageId,
    /// The staged file.
    pub file_id: PreviewStagedFileId,
    /// The file's path inside a dropped folder.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FilesystemPath")]
    pub path: Option<FilesystemPath>,
    /// The byte the part starts at.
    pub offset: SafeInt<0>,
}

/// One part of a staged file and whether it is the last.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewFilePartResponse {
    /// The part's bytes.
    pub part: PreviewFilePart,
    /// Whether the file ends with this part.
    pub is_last_part: bool,
}

/// WSL 2 only: one part of a file the daemon sets on an input or drops on a page, which main writes
/// into its own folder as `<fileId>/<path>`. The debug-protocol command that sets or drops it names
/// the file `sidekicks-staged:<fileId>/<path>`, which main replaces with its own path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPageFileStageRequest {
    /// The page.
    pub page_id: PreviewPageId,
    /// The staged file.
    pub file_id: PreviewStagedFileId,
    /// The cleaned name, or the path inside a picked folder.
    pub path: FilesystemPath,
    /// The part's bytes.
    pub part: PreviewFilePart,
    /// Whether the file ends with this part.
    pub is_last_part: bool,
}

/// A desktop app reaching another machine reads one part of a save its own daemon kept for it, from
/// `offset`, once the system save dialog has a path, so no part crosses the renderer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewSaveReadRequest {
    /// The save.
    pub save_id: PreviewSaveId,
    /// The byte the part starts at.
    pub offset: SafeInt<0>,
}
