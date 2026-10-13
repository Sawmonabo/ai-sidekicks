//! A page's live picture for another device, and that device's acknowledgment of each frame.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::jsonrpc::framing::MAX_ATTACHMENT_BYTES;
use crate::preview::page::PreviewPageId;
use crate::session::id::SessionId;
use crate::wire::attachment::Bytes;
use crate::wire::bounded_text::BoundedText;
use crate::wire::number::{NonNegativeNumber, Number, PositiveNumber};

/// The page whose live picture another device watches while it has the pane open.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

/// The token a watcher returns to acknowledge one frame.
pub type PreviewScreencastAckToken = BoundedText<1, { usize::MAX }>;

/// One frame of the live picture: a JPEG, what maps its pixels back to page coordinates, and the
/// token the watcher returns to acknowledge it. The stream sends the newest image once the last is
/// acknowledged: a frame the page draws while one waits replaces any frame not yet sent, so a slow
/// watcher sees the page as it is now and no frame is marked as dropped.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewScreencastFrame {
    /// The page.
    pub page_id: PreviewPageId,
    /// The JPEG.
    pub image_data: Bytes<1, MAX_ATTACHMENT_BYTES>,
    /// What maps its pixels back to the page.
    pub metadata: PreviewScreencastFrameMetadata,
    /// The token that acknowledges it.
    pub ack_token: PreviewScreencastAckToken,
}

/// Acknowledges one frame by its token, which lets the stream send the newest image.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewScreencastAckRequest {
    /// The session.
    pub session_id: SessionId,
    /// The page.
    pub page_id: PreviewPageId,
    /// The frame's token.
    pub ack_token: PreviewScreencastAckToken,
}
