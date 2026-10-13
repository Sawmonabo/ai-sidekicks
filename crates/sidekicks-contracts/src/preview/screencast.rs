//! A page's live picture for another device and what comes back from it: the stream's frames,
//! menus, file choosers and saves, and the device's acknowledgments, input, menu edits, chosen
//! files and saved-file acknowledgments. A subscription runs one way, so everything the device
//! sends rides a method of its own.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::artifacts::id::ArtifactId;
use crate::free_form_string::{FILE_PATH_MAX_LEN, FilesystemPath};
use crate::jsonrpc::framing::MAX_ONE_ATTACHMENT_BYTES;
use crate::preview::marks::PreviewPoint;
use crate::preview::page::{PreviewAddress, PreviewPageId};
use crate::preview::staging::{PREVIEW_FILE_PART_MAX_BYTES, PreviewFileName, PreviewSaveId};
use crate::session::id::SessionId;
use crate::wire::True;
use crate::wire::attachment::Bytes;
use crate::wire::integer::{BoundedInt, SafeInt};
use crate::wire::number::{NonNegativeNumber, Number, PositiveNumber};
use crate::wire::text::{BoundedText, NonEmptyText, branded_text};

/// The page whose live picture another device watches while it has the pane open.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewScreencastSubscribeRequest {
    /// The session.
    pub session_id: SessionId,
    /// The page.
    pub page_id: PreviewPageId,
}

/// What maps a frame's pixels back to page coordinates, so a mark drawn on the picture lands on the
/// same element as one drawn on the page.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewScreencastFrameMetadata {
    /// The top offset in CSS pixels.
    pub offset_top: Number,
    /// The page's scale factor.
    pub page_scale_factor: PositiveNumber,
    /// The device's width in CSS pixels.
    pub device_width: NonNegativeNumber,
    /// The device's height in CSS pixels.
    pub device_height: NonNegativeNumber,
    /// The horizontal scroll offset in CSS pixels.
    pub scroll_offset_x: Number,
    /// The vertical scroll offset in CSS pixels.
    pub scroll_offset_y: Number,
}

branded_text! {
    /// The token a watcher returns to acknowledge one frame.
    pub struct PreviewScreencastAckToken(1..=usize::MAX);
}

/// The longest input message id the daemon mints.
pub const PREVIEW_INPUT_MESSAGE_ID_MAX_LEN: usize = 256;

branded_text! {
    /// The daemon's id for one input it relayed to a page, which a menu, a file chooser or a
    /// download that input raised names.
    pub struct PreviewInputMessageId(1..=PREVIEW_INPUT_MESSAGE_ID_MAX_LEN);
}

/// What a file chooser lets the device pick.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PreviewFileChooserMode {
    /// One file.
    SelectSingle,
    /// One file or more.
    SelectMultiple,
    /// One folder and the files inside it.
    SelectFolder,
}

/// One part of a save's bytes: at least one byte and at most [`PREVIEW_FILE_PART_MAX_BYTES`].
pub type PreviewSavePart = Bytes<1, PREVIEW_FILE_PART_MAX_BYTES>;

/// Declares the live picture's element union: each kind's arm adds its own members to the page
/// every element names.
macro_rules! preview_screencast_element {
    (
        $(#[doc = $doc:literal])+
        pub enum $name:ident {
            $($(#[doc = $arm_doc:literal])+ $arm:ident { $($extra:tt)* },)+
        }
    ) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
        #[serde(
            tag = "kind",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        pub enum $name {$(
            $(#[doc = $arm_doc])+
            $arm {
                /// The page.
                page_id: PreviewPageId,
                $($extra)*
            },
        )+}
    };
}

preview_screencast_element! {
    /// One element of a page's live picture, tagged on `kind`. A menu, a file chooser and a
    /// download name the `messageId` of the device's input that raised them, so the device knows
    /// which of its presses each answers.
    pub enum PreviewScreencastElement {
        /// One frame: a JPEG, what maps its pixels back to page coordinates, and the token the
        /// watcher returns to acknowledge it. The stream sends the newest image once the last is
        /// acknowledged, so a slow watcher sees the page as it is now.
        Frame {
            /// The JPEG.
            image_data: Bytes<1, MAX_ONE_ATTACHMENT_BYTES>,
            /// What maps its pixels back to the page.
            metadata: PreviewScreencastFrameMetadata,
            /// The token that acknowledges it.
            ack_token: PreviewScreencastAckToken,
        },
        /// The page's right-click menu, sent when the page leaves a device's menu uncanceled.
        Menu {
            /// The input that raised it.
            message_id: PreviewInputMessageId,
            /// Where it opened, in frame pixels.
            point: PreviewPoint,
            /// The link under the press.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "PreviewAddress")]
            link_url: Option<PreviewAddress>,
            /// Whether the press landed in a field that takes text, neither read-only nor
            /// disabled.
            is_editable: bool,
            /// Whether the page allows a cut there.
            can_cut: bool,
            /// Whether the page allows a copy there.
            can_copy: bool,
            /// The selected text; absent where the page allows no copy, as in a password field.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "String")]
            selection_text: Option<String>,
        },
        /// A file chooser or a File System Access picker a device's press or key opened; the
        /// device opens its own picker.
        FileChooser {
            /// The input that opened it.
            message_id: PreviewInputMessageId,
            /// What it lets the device pick.
            mode: PreviewFileChooserMode,
            /// The input's own `accept`, or a picker's types where it excludes every other file,
            /// which the device's picker honors.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "NonEmptyText")]
            accept: Option<NonEmptyText>,
        },
        /// A file the page saved for this device: a download its press or key started, or a write
        /// the page finished through a handle its picker gave. Its bytes follow as `savePart`
        /// elements, one save at a time; a save held while the device had no stream is sent again,
        /// whole, when it opens Preview on the session again.
        Save {
            /// The press or key that started a download; absent for a picker's write.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "PreviewInputMessageId")]
            message_id: Option<PreviewInputMessageId>,
            /// The save.
            save_id: PreviewSaveId,
            /// The file's name, which the device cleans as the daemon cleans a staged name.
            file_name: PreviewFileName,
            /// The file's path inside a folder the device picked.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "FilesystemPath")]
            folder_path: Option<FilesystemPath>,
            /// Its size in bytes.
            size: SafeInt<0>,
            /// Whether it was held while the device was away; the device asks before saving it.
            is_held: bool,
        },
        /// One part of a save. A device that loses its stream before the last part throws the
        /// save away.
        SavePart {
            /// The save.
            save_id: PreviewSaveId,
            /// This part's bytes.
            part: PreviewSavePart,
            /// Whether the file ends with this part.
            is_last_part: bool,
        },
        /// A download on this page no person started, an agent's click or a workflow step; the
        /// pane reads `Downloads are off in Preview`.
        DownloadRefused {},
        /// A save canceled because staging it would leave the staging folder's volume under 2 GiB
        /// free; the pane reads that the machine is low on disk space.
        SaveCanceled {
            /// The file's name.
            file_name: PreviewFileName,
        },
    }
}

/// Acknowledges one frame by its token, which lets the stream send the newest image.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewScreencastAckRequest {
    /// The session.
    pub session_id: SessionId,
    /// The page.
    pub page_id: PreviewPageId,
    /// The frame's token.
    pub ack_token: PreviewScreencastAckToken,
}

/// The modifier keys held during an input, a bit each: Alt 1, Ctrl 2, Meta 4, Shift 8.
pub type PreviewInputModifiers = BoundedInt<0, 15>;

/// What a mouse input does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PreviewMouseAction {
    /// A button went down.
    Press,
    /// The pointer moved.
    Move,
    /// A button came up.
    Release,
}

/// The mouse button an input names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PreviewMouseButton {
    /// No button.
    None,
    /// The left button.
    Left,
    /// The middle button.
    Middle,
    /// The right button.
    Right,
}

/// What a touch input does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PreviewTouchAction {
    /// Touches began.
    Start,
    /// Touches moved.
    Move,
    /// Touches ended.
    End,
    /// Touches were canceled.
    Cancel,
}

/// One touch point, in frame pixels.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewTouchPoint {
    /// From the left edge.
    pub x: Number,
    /// From the top edge.
    pub y: Number,
    /// The touch's own id, the same while it lasts.
    pub id: SafeInt<0>,
}

/// What a key input does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PreviewKeyAction {
    /// The key went down.
    Down,
    /// The key came up.
    Up,
}

/// One input from another device, tagged on `kind`. Points are frame pixels, which the daemon maps
/// to page points from the frame's metadata and the page's zoom; touches reach the page as touch
/// events and keys as key input.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PreviewDeviceInput {
    /// A mouse press, move or release.
    Mouse {
        /// What it does.
        #[serde(rename = "type")]
        action: PreviewMouseAction,
        /// From the left edge.
        x: Number,
        /// From the top edge.
        y: Number,
        /// The button.
        button: PreviewMouseButton,
        /// How many presses in a row this one is.
        click_count: SafeInt<0>,
        /// The modifier keys held.
        modifiers: PreviewInputModifiers,
    },
    /// A wheel turn.
    Wheel {
        /// From the left edge.
        x: Number,
        /// From the top edge.
        y: Number,
        /// The horizontal scroll.
        delta_x: Number,
        /// The vertical scroll.
        delta_y: Number,
        /// The modifier keys held.
        modifiers: PreviewInputModifiers,
    },
    /// A touch start, move, end or cancel.
    Touch {
        /// What it does.
        #[serde(rename = "type")]
        action: PreviewTouchAction,
        /// The touch points still down.
        points: Vec<PreviewTouchPoint>,
    },
    /// A key going down or up.
    Key {
        /// What it does.
        #[serde(rename = "type")]
        action: PreviewKeyAction,
        /// The key's value, as `KeyboardEvent.key` names it.
        key: NonEmptyText,
        /// The physical key, as `KeyboardEvent.code` names it; empty where the key has none.
        code: String,
        /// The text the key types.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "NonEmptyText")]
        text: Option<NonEmptyText>,
        /// The modifier keys held.
        modifiers: PreviewInputModifiers,
    },
}

/// Sends one input from the device to a page.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewScreencastInputRequest {
    /// The session.
    pub session_id: SessionId,
    /// The page.
    pub page_id: PreviewPageId,
    /// The input.
    pub input: PreviewDeviceInput,
}

/// The id the daemon gave the input, which a menu, a file chooser or a download it raised names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewScreencastInputResponse {
    /// The input's id.
    pub message_id: PreviewInputMessageId,
}

/// One act from a page's right-click menu, tagged on `kind`: `Paste` with its text, `Select all`,
/// or `Cut`'s removal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PreviewMenuEdit {
    /// Pastes the device's text.
    Paste {
        /// The text.
        text: String,
    },
    /// Selects everything in the focused field or page.
    SelectAll {},
    /// Removes the selection, which the device has already copied.
    Cut {},
}

/// A device's act from the menu its input raised, naming that menu by its input's id. Refused with
/// `preview.edit_refused`, changing nothing, where the page took other input after the menu opened.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewScreencastEditRequest {
    /// The session.
    pub session_id: SessionId,
    /// The page.
    pub page_id: PreviewPageId,
    /// The menu's input.
    pub message_id: PreviewInputMessageId,
    /// The act.
    pub edit: PreviewMenuEdit,
}

/// The menu's act reached the page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewMenuEditResponse {
    /// Always `true`.
    pub applied: True,
}

/// A path the device gives for a file inside a folder it picked, `/`-separated. Its rules are the
/// method's refusal, not the schema's, so an empty path still reaches the daemon.
pub type PreviewChosenFilePath = BoundedText<0, FILE_PATH_MAX_LEN>;

/// One file the device picked, already staged on the machine through the attachment ingest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewChosenFile {
    /// The staged artifact, from its ingest's completion.
    pub artifact_id: ArtifactId,
    /// For a folder, the file's path inside it, as `sub/b.txt`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "PreviewChosenFilePath")]
    pub path: Option<PreviewChosenFilePath>,
}

/// The device's answer to a file chooser or a picker its input opened: the files it picked, which
/// the daemon sets on the page's input or drops on the page for a picker, or none for a cancel.
/// More than one only for `selectMultiple` or `selectFolder`. A path that is empty, absolute, holds
/// an empty, `.` or `..` segment, or is missing from a folder's answer is refused with
/// `preview.file_path_refused`, setting and dropping nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewScreencastFileChooseRequest {
    /// The session.
    pub session_id: SessionId,
    /// The page.
    pub page_id: PreviewPageId,
    /// The chooser's input.
    pub message_id: PreviewInputMessageId,
    /// The files; empty for a cancel.
    pub files: Vec<PreviewChosenFile>,
    /// The picked folder's own name, for `selectFolder`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "PreviewFileName")]
    pub folder_name: Option<PreviewFileName>,
}

/// How many files the page received: set on the input, or dropped for a picker.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewScreencastFileChooseResponse {
    /// The count.
    pub set: SafeInt<0>,
}

/// The device has written a save's last part where its host keeps it, or thrown a held save away,
/// so the daemon deletes its copy and starts that device's next save.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewScreencastSaveAckRequest {
    /// The session.
    pub session_id: SessionId,
    /// The page.
    pub page_id: PreviewPageId,
    /// The save.
    pub save_id: PreviewSaveId,
}
