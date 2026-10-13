//! A session's Preview pages and the verbs that move them: open, close, activate, reorder,
//! navigate and zoom. The daemon owns every page and mints every page id; a client reads the list
//! and sends requests keyed by session and page.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use strum::VariantArray;

use crate::jsonrpc::framing::MAX_ONE_ATTACHMENT_BYTES;
use crate::session::id::SessionId;
use crate::web_address::WebAddressFault;
use crate::wire::True;
use crate::wire::attachment::Bytes;
use crate::wire::integer::{BoundedInt, MAX_SAFE_SIGNED_INTEGER, Port, SafeInt};
use crate::wire::number::UnitFraction;
use crate::wire::text::{BoundedText, branded_text};

/// The longest page id the daemon mints.
pub const PREVIEW_PAGE_ID_MAX_LEN: usize = 256;

branded_text! {
    /// The daemon's own handle for one page. Opaque to every client.
    pub struct PreviewPageId(1..=PREVIEW_PAGE_ID_MAX_LEN);
}

/// The longest address Preview takes: Chromium's own limit on a URL's length.
pub const PREVIEW_ADDRESS_MAX_LEN: usize = 2 * 1024 * 1024;

/// An address as it crosses the wire; what it may name is judged where it lands.
pub type PreviewAddress = BoundedText<1, PREVIEW_ADDRESS_MAX_LEN>;

/// The zoom factors a page steps through, Chromium's own presets from 50 % to 200 %. 67 % is
/// Chromium's 2/3 exactly, so both ends compare the same number.
pub const PREVIEW_ZOOM_FACTORS: [f64; 11] = [
    0.5,
    2.0 / 3.0,
    0.75,
    0.8,
    0.9,
    1.0,
    1.1,
    1.25,
    1.5,
    1.75,
    2.0,
];

/// A page's zoom: one of [`PREVIEW_ZOOM_FACTORS`] and nothing between them.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct PreviewZoomFactor(f64);

impl PreviewZoomFactor {
    /// `factor` when it is a preset, else `None`.
    pub fn new(factor: f64) -> Option<Self> {
        PREVIEW_ZOOM_FACTORS
            .contains(&factor)
            .then_some(Self(factor))
    }

    /// The factor.
    pub const fn get(self) -> f64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for PreviewZoomFactor {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(f64::deserialize(deserializer)?)
            .ok_or_else(|| D::Error::custom("zoomFactor must be one of the preset zoom factors"))
    }
}

impl JsonSchema for PreviewZoomFactor {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "PreviewZoomFactor".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "A page's zoom: one of the preset factors and nothing between them.",
            "type": "number",
            "enum": PREVIEW_ZOOM_FACTORS,
        })
    }
}

/// An image's media type, `image/<subtype>` in lower case.
const IMAGE_MEDIA_TYPE_PATTERN: &str = "^image/[a-z0-9.+-]+$";

/// [`IMAGE_MEDIA_TYPE_PATTERN`], compiled once.
static IMAGE_MEDIA_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(IMAGE_MEDIA_TYPE_PATTERN).expect("the media type pattern is a valid regex")
});

/// An image's media type, such as `image/png`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct PreviewImageMediaType(String);

impl<'de> Deserialize<'de> for PreviewImageMediaType {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        if IMAGE_MEDIA_TYPE.is_match(&text) {
            Ok(Self(text))
        } else {
            Err(D::Error::custom("mediaType must be an image type"))
        }
    }
}

impl JsonSchema for PreviewImageMediaType {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "PreviewImageMediaType".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "pattern": IMAGE_MEDIA_TYPE_PATTERN })
    }
}

/// A page's own icon, as the image's bytes rather than its address: the app draws only images it
/// holds, and another device cannot reach an icon a loopback page serves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewFavicon {
    /// The image's media type.
    pub media_type: PreviewImageMediaType,
    /// The image.
    pub data: Bytes<1, MAX_ONE_ATTACHMENT_BYTES>,
}

/// Where a page's load stands, tagged on `kind`: loading, with the fraction the engine reports or
/// `null` when it reports none; loaded; or failed, which the pane reads as `<host> did not answer.`
/// with a try-again.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PreviewPageLoadState {
    /// Loading.
    Loading {
        /// The share loaded; `null` draws an indeterminate mark.
        #[serde(deserialize_with = "crate::wire::nullable")]
        #[schemars(with = "crate::wire::NullableSchema<UnitFraction>")]
        progress: Option<UnitFraction>,
    },
    /// Loaded.
    Loaded {},
    /// Failed.
    Failed {},
}

/// One open page in a session's Preview pane.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewPage {
    /// The page.
    pub page_id: PreviewPageId,
    /// Its address.
    pub address: PreviewAddress,
    /// Its host, shown in place of an empty `title`, so it is carried rather than re-parsed.
    pub host: String,
    /// The page's own title; may be empty.
    pub title: String,
    /// Its icon; `null` where it has none.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<PreviewFavicon>")]
    pub favicon: Option<PreviewFavicon>,
    /// Where its load stands.
    pub load_state: PreviewPageLoadState,
    /// How far its history reaches back; going back is possible above zero.
    pub back_depth: SafeInt<0>,
    /// How far its history reaches forward; going forward is possible above zero.
    pub forward_depth: SafeInt<0>,
    /// Its own zoom, applied on the machine that runs it.
    pub zoom_factor: PreviewZoomFactor,
    /// The page's view was destroyed to free memory or by a restart; its address, order and zoom
    /// are kept, and it reloads when shown.
    pub released: bool,
}

/// The session whose pages a `preview.pageList` subscription streams.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPageListRequest {
    /// The session.
    pub session_id: SessionId,
}

/// The index of the page the pane shows, or `-1` for none.
pub type PreviewActiveIndex = BoundedInt<-1, MAX_SAFE_SIGNED_INTEGER>;

/// One frame of a session's page list: every page in the session's order, and the index of the
/// one the pane shows, `-1` where the session has no page open. The first frame is the list as it
/// stands; after a change the stream sends the newest list once the reader has room, never a queue
/// of the lists between.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(active_index_names_a_page))]
pub struct PreviewPageListFrame {
    /// The pages.
    pub pages: Vec<PreviewPage>,
    /// The page the pane shows.
    pub active_index: PreviewActiveIndex,
}

/// Whether a frame's active index names a page in its list, or none. JSON Schema cannot compare a
/// number with an array's length, so the check has no schema twin.
#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "garde passes a check's context by reference"
)]
fn active_index_names_a_page(frame: &PreviewPageListFrame, (): &()) -> garde::Result {
    let names_a_page = usize::try_from(frame.active_index.get())
        .ok()
        .is_none_or(|index| index < frame.pages.len());
    if names_a_page {
        Ok(())
    } else {
        Err(garde::Error::new(
            "activeIndex must name a page in the list, or be -1",
        ))
    }
}

/// What a page opens on, tagged on `kind`: an address the person or an agent gave, or a dev server
/// the daemon discovered. A closed union, so a caller cannot ask for both and leave the daemon to
/// choose. A popup a page opens reaches the list the same way, as an address main hands over.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PreviewPageTarget {
    /// An address.
    Address {
        /// The address.
        address: PreviewAddress,
    },
    /// A discovered dev server.
    DevServer {
        /// Its port.
        port: Port,
    },
}

/// Opens one page in a session. A retried open makes a second page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPageOpenRequest {
    /// The session.
    pub session_id: SessionId,
    /// What the page opens on.
    pub target: PreviewPageTarget,
}

/// The page opened, and the address it loads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewPageOpenResponse {
    /// The page.
    pub page_id: PreviewPageId,
    /// The address it loads.
    pub address: PreviewAddress,
    /// The dev server's own port where the page loads on another one because that port was
    /// taken on the side the page runs; `null` where the port did not move.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<Port>")]
    pub moved_from: Option<Port>,
    /// The page released to make room for this one, where one was. Its address is kept and it
    /// reloads when shown, so this is a fact the pane may report, never a refusal.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "PreviewPageId")]
    pub released_page_id: Option<PreviewPageId>,
}

/// Names one page of one session: close it, or make it the one the pane shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPageRequest {
    /// The session.
    pub session_id: SessionId,
    /// The page.
    pub page_id: PreviewPageId,
}

/// A page closed. Closing a page that is already gone answers the same.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewPageCloseResponse {
    /// Always `true`.
    pub closed: True,
}

/// The page the pane now shows. Activating the active page answers the same.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewPageActivateResponse {
    /// The page.
    pub active_page_id: PreviewPageId,
}

/// Moves one page within its session's order; `toIndex` is a position in the list without that
/// page in it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPageReorderRequest {
    /// The session.
    pub session_id: SessionId,
    /// The page.
    pub page_id: PreviewPageId,
    /// Where it goes.
    pub to_index: SafeInt<0>,
}

/// The session's page order after the move. The order is the session's, so every device draws the
/// same strip; moving a page to where it already is answers the order unchanged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewPageReorderResponse {
    /// The pages in order.
    pub page_ids: Vec<PreviewPageId>,
}

/// Where a navigation takes a page, tagged on `kind`. Back, forward and reload ride the same verb
/// as an address, because all four move the same page within its own history.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PreviewNavigationTarget {
    /// An address.
    Address {
        /// The address.
        address: PreviewAddress,
    },
    /// One step back.
    Back {},
    /// One step forward.
    Forward {},
    /// The same page again.
    Reload {},
}

/// Navigates one page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewNavigateRequest {
    /// The session.
    pub session_id: SessionId,
    /// The page.
    pub page_id: PreviewPageId,
    /// Where it goes.
    pub to: PreviewNavigationTarget,
}

/// Where the page stands after the navigation: the address it loads, with `movedFrom` as on
/// [`PreviewPageOpenResponse`], and its history depths.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewNavigateResponse {
    /// The page.
    pub page_id: PreviewPageId,
    /// The address it loads.
    pub address: PreviewAddress,
    /// The dev server's own port where the page loads on another; `null` where it did not move.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<Port>")]
    pub moved_from: Option<Port>,
    /// How far its history reaches back.
    pub back_depth: SafeInt<0>,
    /// How far its history reaches forward.
    pub forward_depth: SafeInt<0>,
}

/// Sets one page's zoom on the machine that runs it, so the live picture carries the result. A new
/// page starts at 1; each open page keeps its own factor.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewZoomRequest {
    /// The session.
    pub session_id: SessionId,
    /// The page.
    pub page_id: PreviewPageId,
    /// The factor.
    pub zoom_factor: PreviewZoomFactor,
}

/// The factor the page now has.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewZoomResponse {
    /// The page.
    pub page_id: PreviewPageId,
    /// The factor.
    pub zoom_factor: PreviewZoomFactor,
}

/// A refused address's text that is not an address at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PreviewUnparsedAddress {
    /// The text is not an address.
    NotAnAddress,
}

/// Why an address was refused: its scheme is one the pane cannot open, or the text is not an
/// address at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum PreviewAddressRefusedReason {
    /// An address the pane does not open.
    Fault(WebAddressFault),
    /// Not an address.
    Unparsed(PreviewUnparsedAddress),
}

/// The details a `preview.address_refused` refusal carries. It never echoes the address.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewAddressRefusedDetails {
    /// Why.
    pub reason: PreviewAddressRefusedReason,
}

/// Every reason an address is refused: each fault an address can have, then text that is not an
/// address at all.
pub const PREVIEW_ADDRESS_REFUSED_REASONS: [PreviewAddressRefusedReason;
    WebAddressFault::VARIANTS.len() + 1] = {
    let mut reasons = [PreviewAddressRefusedReason::Unparsed(PreviewUnparsedAddress::NotAnAddress);
        WebAddressFault::VARIANTS.len() + 1];
    let mut index = 0;
    while index < WebAddressFault::VARIANTS.len() {
        reasons[index] = PreviewAddressRefusedReason::Fault(WebAddressFault::VARIANTS[index]);
        index += 1;
    }
    reasons
};
