//! The `preview.*` page, dev-server, marks and live-picture methods the daemon answers. Its other
//! `preview.*` methods are the page host's link (`page_host`) and the shared ports (`port`).

use crate::jsonrpc::refusal::RefusalCode;
use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::preview::dev_server::{
    PreviewDevServer, PreviewDevServerListFrame, PreviewDevServerListRequest,
};
use crate::preview::marks::{
    PreviewElementRef, PreviewMark, PreviewMarkElement, PreviewMarksSendRequest,
    PreviewMarksSendResponse, PreviewPoint, PreviewRect,
};
use crate::preview::page::{
    PreviewAddressRefusedDetails, PreviewAddressRefusedReason, PreviewFavicon,
    PreviewNavigateRequest, PreviewNavigateResponse, PreviewNavigationTarget, PreviewPage,
    PreviewPageActivateResponse, PreviewPageCloseResponse, PreviewPageId, PreviewPageListFrame,
    PreviewPageListRequest, PreviewPageLoadState, PreviewPageOpenRequest, PreviewPageOpenResponse,
    PreviewPageReorderRequest, PreviewPageReorderResponse, PreviewPageRequest, PreviewPageTarget,
    PreviewUnparsedAddress, PreviewZoomFactor, PreviewZoomRequest, PreviewZoomResponse,
};
use crate::preview::screencast::{
    PreviewChosenFile, PreviewDeviceInput, PreviewFileChooserMode, PreviewInputMessageId,
    PreviewKeyAction, PreviewMenuEdit, PreviewMenuEditResponse, PreviewMouseAction,
    PreviewMouseButton, PreviewScreencastAckRequest, PreviewScreencastAckToken,
    PreviewScreencastEditRequest, PreviewScreencastElement, PreviewScreencastFileChooseRequest,
    PreviewScreencastFileChooseResponse, PreviewScreencastFrameMetadata,
    PreviewScreencastInputRequest, PreviewScreencastInputResponse, PreviewScreencastSaveAckRequest,
    PreviewScreencastSubscribeRequest, PreviewTouchAction, PreviewTouchPoint,
};
use crate::preview::staging::PreviewSaveId;
use crate::preview::{marks, page, screencast, staging};
use crate::typescript::{Definition, TypeScriptModule, ts_constants};

methods! {
    /// The `preview.*` page, dev-server, marks and live-picture methods the daemon answers.
    pub const PREVIEW_METHOD_DESCRIPTORS = [
        /// Streams a session's pages.
        PreviewPageList = subscription "preview.pageList" {
            mutating: false,
            params: PreviewPageListRequest,
            result: SubscribeAckResponse,
            emission: PreviewPageListFrame,
            refusals: [],
        },
        /// Opens a page.
        PreviewPageOpen = mutation "preview.pageOpen" {
            mutating: true,
            params: PreviewPageOpenRequest,
            result: PreviewPageOpenResponse,
            refusals: [PreviewAddressRefused],
        },
        /// Closes a page.
        PreviewPageClose = mutation "preview.pageClose" {
            mutating: true,
            params: PreviewPageRequest,
            result: PreviewPageCloseResponse,
            refusals: [],
        },
        /// Makes a page the one the pane shows.
        PreviewPageActivate = mutation "preview.pageActivate" {
            mutating: true,
            params: PreviewPageRequest,
            result: PreviewPageActivateResponse,
            refusals: [],
        },
        /// Moves a page within its session's order.
        PreviewPageReorder = mutation "preview.pageReorder" {
            mutating: true,
            params: PreviewPageReorderRequest,
            result: PreviewPageReorderResponse,
            refusals: [],
        },
        /// Navigates a page.
        PreviewNavigate = mutation "preview.navigate" {
            mutating: true,
            params: PreviewNavigateRequest,
            result: PreviewNavigateResponse,
            refusals: [PreviewAddressRefused],
        },
        /// Sets a page's zoom.
        PreviewZoom = mutation "preview.zoom" {
            mutating: true,
            params: PreviewZoomRequest,
            result: PreviewZoomResponse,
            refusals: [],
        },
        /// Streams the dev servers discovered in a session's project.
        PreviewDevServerList = subscription "preview.devServerList" {
            mutating: false,
            params: PreviewDevServerListRequest,
            result: SubscribeAckResponse,
            emission: PreviewDevServerListFrame,
            refusals: [],
        },
        /// Sends the marks on a page to the session's provider.
        PreviewMarksSend = mutation "preview.marksSend" {
            mutating: true,
            params: PreviewMarksSendRequest,
            result: PreviewMarksSendResponse,
            refusals: [],
        },
        /// Streams a page's live picture to another device.
        PreviewScreencastSubscribe = subscription "preview.screencastSubscribe" {
            mutating: false,
            params: PreviewScreencastSubscribeRequest,
            result: SubscribeAckResponse,
            emission: PreviewScreencastElement,
            refusals: [],
        },
        /// Acknowledges one frame of the live picture.
        PreviewScreencastAck = mutation "preview.screencastAck" {
            mutating: true,
            params: PreviewScreencastAckRequest,
            result: EmptyPayload,
            refusals: [],
        },
        /// Sends one input from another device to a page.
        PreviewScreencastInput = mutation "preview.screencastInput" {
            mutating: true,
            params: PreviewScreencastInputRequest,
            result: PreviewScreencastInputResponse,
            refusals: [],
        },
        /// Applies an act from the menu a device's input raised.
        PreviewScreencastEdit = mutation "preview.screencastEdit" {
            mutating: true,
            params: PreviewScreencastEditRequest,
            result: PreviewMenuEditResponse,
            refusals: [PreviewEditRefused],
        },
        /// Answers a file chooser or a picker a device's input opened.
        PreviewScreencastFileChoose = mutation "preview.screencastFileChoose" {
            mutating: true,
            params: PreviewScreencastFileChooseRequest,
            result: PreviewScreencastFileChooseResponse,
            refusals: [PreviewFilePathRefused],
        },
        /// Acknowledges a save the device has written or thrown away.
        PreviewScreencastSaveAck = mutation "preview.screencastSaveAck" {
            mutating: true,
            params: PreviewScreencastSaveAckRequest,
            result: EmptyPayload,
            refusals: [],
        },
    ];
}

ts_constants! {
    /// The longest page id the daemon mints.
    PREVIEW_PAGE_ID_MAX_LEN = page::PREVIEW_PAGE_ID_MAX_LEN;
    /// The longest address Preview takes: Chromium's own limit on a URL's length.
    PREVIEW_ADDRESS_MAX_LEN = page::PREVIEW_ADDRESS_MAX_LEN;
    /// The zoom factors a page steps through, Chromium's own presets from 50 % to 200 %.
    PREVIEW_ZOOM_FACTORS = page::PREVIEW_ZOOM_FACTORS;
    /// An address Preview will not open, refused with its cause and the page left where it was.
    /// Nothing is ever searched on the web.
    PREVIEW_ADDRESS_REFUSED_CODE = RefusalCode::PreviewAddressRefused;
    /// Every reason an address is refused.
    PREVIEW_ADDRESS_REFUSED_REASONS = page::PREVIEW_ADDRESS_REFUSED_REASONS;
    /// The longest note a comment or a box carries.
    PREVIEW_MARK_NOTE_MAX_LEN = marks::PREVIEW_MARK_NOTE_MAX_LEN;
    /// The longest input message id the daemon mints.
    PREVIEW_INPUT_MESSAGE_ID_MAX_LEN = screencast::PREVIEW_INPUT_MESSAGE_ID_MAX_LEN;
    /// The longest save id the daemon mints.
    PREVIEW_SAVE_ID_MAX_LEN = staging::PREVIEW_SAVE_ID_MAX_LEN;
    /// The most bytes one part of a staged file carries.
    PREVIEW_FILE_PART_MAX_BYTES = staging::PREVIEW_FILE_PART_MAX_BYTES;
    /// A menu act for a menu that is no longer the page's current one; nothing changes.
    PREVIEW_EDIT_REFUSED_CODE = RefusalCode::PreviewEditRefused;
    /// A chosen file's path inside a folder that is empty, absolute, holds an empty, `.` or `..`
    /// segment, or is missing, or a download report naming its file by anything but an id main
    /// minted; nothing is set, dropped or staged.
    PREVIEW_FILE_PATH_REFUSED_CODE = RefusalCode::PreviewFilePathRefused;
}

/// The TypeScript module of the Preview pane's wire.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "preview/methods",
    doc: "The Preview pane's wire: the pages a session owns and the verbs that move them, the dev \
          servers the daemon discovers, the marks sent to the provider, and the live picture for \
          another device with the input, menu acts, chosen files and saves that answer it.",
    definitions: &[
        Definition::read::<PreviewPageId>().checked(),
        Definition::read::<PreviewZoomFactor>(),
        Definition::read::<PreviewUnparsedAddress>(),
        Definition::read::<PreviewAddressRefusedReason>(),
        Definition::read::<PreviewAddressRefusedDetails>().checked(),
        Definition::read::<PreviewFavicon>(),
        Definition::read::<PreviewPageLoadState>(),
        Definition::read::<PreviewPage>().checked(),
        Definition::read::<PreviewPageListRequest>().checked(),
        Definition::read::<PreviewPageListFrame>().checked(),
        Definition::read::<PreviewPageTarget>(),
        Definition::read::<PreviewPageOpenRequest>().checked(),
        Definition::read::<PreviewPageOpenResponse>().checked(),
        Definition::read::<PreviewPageRequest>().checked(),
        Definition::read::<PreviewPageCloseResponse>().checked(),
        Definition::read::<PreviewPageActivateResponse>().checked(),
        Definition::read::<PreviewPageReorderRequest>().checked(),
        Definition::read::<PreviewPageReorderResponse>().checked(),
        Definition::read::<PreviewNavigationTarget>(),
        Definition::read::<PreviewNavigateRequest>().checked(),
        Definition::read::<PreviewNavigateResponse>().checked(),
        Definition::read::<PreviewZoomRequest>().checked(),
        Definition::read::<PreviewZoomResponse>().checked(),
        Definition::read::<PreviewDevServerListRequest>().checked(),
        Definition::read::<PreviewDevServer>(),
        Definition::read::<PreviewDevServerListFrame>().checked(),
        Definition::read::<PreviewPoint>(),
        Definition::read::<PreviewRect>(),
        Definition::read::<PreviewElementRef>(),
        Definition::read::<PreviewMarkElement>(),
        Definition::read::<PreviewMark>(),
        Definition::read::<PreviewMarksSendRequest>().checked(),
        Definition::read::<PreviewMarksSendResponse>().checked(),
        Definition::read::<PreviewScreencastSubscribeRequest>().checked(),
        Definition::read::<PreviewScreencastFrameMetadata>(),
        Definition::read::<PreviewScreencastAckToken>(),
        Definition::read::<PreviewInputMessageId>().checked(),
        Definition::read::<PreviewSaveId>().checked(),
        Definition::read::<PreviewFileChooserMode>(),
        Definition::read::<PreviewScreencastElement>().checked(),
        Definition::read::<PreviewScreencastAckRequest>().checked(),
        Definition::read::<PreviewMouseAction>(),
        Definition::read::<PreviewMouseButton>(),
        Definition::read::<PreviewTouchAction>(),
        Definition::read::<PreviewTouchPoint>(),
        Definition::read::<PreviewKeyAction>(),
        Definition::read::<PreviewDeviceInput>(),
        Definition::read::<PreviewScreencastInputRequest>().checked(),
        Definition::read::<PreviewScreencastInputResponse>().checked(),
        Definition::read::<PreviewMenuEdit>(),
        Definition::read::<PreviewScreencastEditRequest>().checked(),
        Definition::read::<PreviewMenuEditResponse>().checked(),
        Definition::read::<PreviewChosenFile>(),
        Definition::read::<PreviewScreencastFileChooseRequest>().checked(),
        Definition::read::<PreviewScreencastFileChooseResponse>().checked(),
        Definition::read::<PreviewScreencastSaveAckRequest>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&PREVIEW_METHOD_DESCRIPTORS],
};
