//! The marks a person draws on a frozen picture of a page and sends to the session's provider as
//! one attachment.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::color::HexColor;
use crate::jsonrpc::framing::MAX_ATTACHMENT_BYTES;
use crate::preview::page::{PreviewAddress, PreviewPageId};
use crate::session::id::SessionId;
use crate::wire::True;
use crate::wire::attachment::Bytes;
use crate::wire::bounded_text::BoundedText;
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::number::{NonNegativeNumber, Number};

/// The longest note a comment or a box carries.
pub const PREVIEW_MARK_NOTE_MAX_LEN: usize = 4096;

/// A point on the page, in viewport CSS pixels.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewPoint {
    /// From the left edge.
    pub x: Number,
    /// From the top edge.
    pub y: Number,
}

/// A rectangle on the page, in viewport CSS pixels.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewRect {
    /// Its left edge.
    pub x: Number,
    /// Its top edge.
    pub y: Number,
    /// Its width.
    pub width: NonNegativeNumber,
    /// Its height.
    pub height: NonNegativeNumber,
}

/// The element a mark landed on, as the page snapshot taken when the mark was made names it: the
/// snapshot's element reference and that element's box. A reference holds only for the snapshot
/// that minted it, so its generation rides with it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewMarkElement {
    /// The snapshot's reference to the element.
    #[serde(rename = "ref")]
    pub element_ref: BoundedText<1, { usize::MAX }>,
    /// The element's box.
    #[serde(rename = "box")]
    pub element_box: PreviewRect,
    /// The snapshot that minted the reference.
    pub snapshot_generation: SafeInt<0>,
}

/// A comment's or a box's note.
pub type PreviewMarkNote = BoundedText<1, PREVIEW_MARK_NOTE_MAX_LEN>;

/// Declares the mark union: each kind's arm adds its own members to the element every mark names.
macro_rules! preview_mark {
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
            rename_all = "snake_case",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        pub enum $name {$(
            $(#[doc = $arm_doc])+
            $arm {
                $($extra)*
                /// The element it landed on; `null` where it hit none.
                #[serde(deserialize_with = "crate::wire::nullable")]
                #[schemars(with = "crate::wire::NullableSchema<PreviewMarkElement>")]
                element: Option<PreviewMarkElement>,
            },
        )+}
    };
}

preview_mark! {
    /// One mark on the frozen picture, tagged on `kind`: a numbered comment pin, a numbered box,
    /// or an unnumbered freehand stroke.
    pub enum PreviewMark {
        /// A numbered comment pin.
        Comment {
            /// Its number.
            number: SafeInt<1>,
            /// The person's note; `null` where they wrote none.
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::wire::NullableSchema<PreviewMarkNote>")]
            note: Option<PreviewMarkNote>,
            /// Where it is pinned.
            point: PreviewPoint,
        },
        /// A numbered box.
        Box {
            /// Its number.
            number: SafeInt<1>,
            /// The person's note; `null` where they wrote none.
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::wire::NullableSchema<PreviewMarkNote>")]
            note: Option<PreviewMarkNote>,
            /// The box.
            rect: PreviewRect,
        },
        /// An unnumbered freehand stroke.
        Stroke {
            /// Its points, at least one.
            points: BoundedVec<PreviewPoint, 1, { usize::MAX }>,
            /// Its sRGB color.
            color: HexColor,
        },
    }
}

/// The media type of a frozen picture.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum PreviewPictureMediaType {
    /// A PNG.
    #[serde(rename = "image/png")]
    Png,
    /// A JPEG.
    #[serde(rename = "image/jpeg")]
    Jpeg,
}

/// The frozen picture the marks were drawn on, at the pixel size it was captured. It is never
/// captured again at send, which would not match the marks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewMarksPicture {
    /// The image's media type.
    pub media_type: PreviewPictureMediaType,
    /// The image.
    pub data: Bytes<1, MAX_ATTACHMENT_BYTES>,
    /// Its width in pixels.
    pub width: SafeInt<1>,
    /// Its height in pixels.
    pub height: SafeInt<1>,
}

/// Sends the marks on one page to the session's provider as one attachment: the picture, the marks
/// that exist now, the page's address and its width in CSS pixels. An attachment whose last mark
/// was removed is not sent, so `marks` is never empty.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewMarksSendRequest {
    /// The session.
    pub session_id: SessionId,
    /// The page.
    pub page_id: PreviewPageId,
    /// The frozen picture.
    pub picture: PreviewMarksPicture,
    /// The marks.
    pub marks: BoundedVec<PreviewMark, 1, { usize::MAX }>,
    /// The page's address.
    pub address: PreviewAddress,
    /// The page's width in CSS pixels when it was frozen.
    pub page_width: SafeInt<1>,
}

/// The attachment reached the provider, in that provider's own image shape, which differs per
/// provider, so nothing about the encoding reaches a client.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewMarksSendResponse {
    /// Always `true`.
    pub delivered: True,
}
