//! The `preview.*` page, dev-server, marks and live-picture methods the daemon answers. Its other
//! `preview.*` methods are the page host's link (`page_host`) and the shared ports (`port`).

use crate::jsonrpc::refusal::RefusalCode;
use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::preview::dev_server::{
    PreviewDevServer, PreviewDevServerListFrame, PreviewDevServerSubscribeRequest,
};
use crate::preview::marks::{
    PreviewElementRef, PreviewMark, PreviewMarkElement, PreviewMarkSendRequest,
    PreviewMarkSendResponse, PreviewPoint, PreviewRect,
};
use crate::preview::page::{
    PreviewAddressRefusedDetails, PreviewAddressRefusedReason, PreviewFavicon,
    PreviewNavigationTarget, PreviewPage, PreviewPageActivateResponse, PreviewPageCloseResponse,
    PreviewPageId, PreviewPageListFrame, PreviewPageLoadState, PreviewPageNavigateRequest,
    PreviewPageNavigateResponse, PreviewPageOpenRequest, PreviewPageOpenResponse,
    PreviewPageReorderRequest, PreviewPageReorderResponse, PreviewPageRequest,
    PreviewPageSubscribeRequest, PreviewPageTarget, PreviewPageZoomUpdateRequest,
    PreviewPageZoomUpdateResponse, PreviewUnparsedAddress, PreviewZoomFactor,
};
use crate::preview::screencast::{
    PreviewChosenFile, PreviewDeviceInput, PreviewFileChooserMode, PreviewInputMessageId,
    PreviewKeyAction, PreviewMenuEdit, PreviewMenuEditResponse, PreviewMouseAction,
    PreviewMouseButton, PreviewScreencastAckToken, PreviewScreencastAcknowledgeRequest,
    PreviewScreencastEditRequest, PreviewScreencastElement, PreviewScreencastFileChooseRequest,
    PreviewScreencastFileChooseResponse, PreviewScreencastFrameMetadata,
    PreviewScreencastInputSendRequest, PreviewScreencastInputSendResponse,
    PreviewScreencastSaveAcknowledgeRequest, PreviewScreencastSubscribeRequest, PreviewTouchAction,
    PreviewTouchPoint,
};
use crate::preview::staging::PreviewSaveId;
use crate::preview::{marks, page, screencast, staging};
use crate::typescript::{Definition, TypeScriptModule, ts_constants};

methods! {
    /// The `preview.*` page, dev-server, marks and live-picture methods the daemon answers.
    pub const PREVIEW_METHOD_DESCRIPTORS = [
        /// Streams a session's pages.
        PreviewPageSubscribe = subscription "preview.page.subscribe" {
            mutating: false,
            params: PreviewPageSubscribeRequest,
            result: SubscribeAckResponse,
            emission: PreviewPageListFrame,
            refusals: [SessionNotFound],
        },
        /// Opens a page.
        PreviewPageOpen = mutation "preview.page.open" {
            mutating: true,
            params: PreviewPageOpenRequest,
            result: PreviewPageOpenResponse,
            refusals: [SessionNotFound, PreviewAddressRefused],
        },
        /// Closes a page.
        PreviewPageClose = mutation "preview.page.close" {
            mutating: true,
            params: PreviewPageRequest,
            result: PreviewPageCloseResponse,
            refusals: [SessionNotFound],
        },
        /// Makes a page the one the pane shows.
        PreviewPageActivate = mutation "preview.page.activate" {
            mutating: true,
            params: PreviewPageRequest,
            result: PreviewPageActivateResponse,
            refusals: [SessionNotFound],
        },
        /// Moves a page within its session's order.
        PreviewPageReorder = mutation "preview.page.reorder" {
            mutating: true,
            params: PreviewPageReorderRequest,
            result: PreviewPageReorderResponse,
            refusals: [SessionNotFound],
        },
        /// Navigates a page.
        PreviewPageNavigate = mutation "preview.page.navigate" {
            mutating: true,
            params: PreviewPageNavigateRequest,
            result: PreviewPageNavigateResponse,
            refusals: [SessionNotFound, PreviewAddressRefused],
        },
        /// Sets a page's zoom.
        PreviewPageZoomUpdate = mutation "preview.page.zoom.update" {
            mutating: true,
            params: PreviewPageZoomUpdateRequest,
            result: PreviewPageZoomUpdateResponse,
            refusals: [SessionNotFound],
        },
        /// Streams the dev servers discovered in a session's project.
        PreviewDevServerSubscribe = subscription "preview.devServer.subscribe" {
            mutating: false,
            params: PreviewDevServerSubscribeRequest,
            result: SubscribeAckResponse,
            emission: PreviewDevServerListFrame,
            refusals: [SessionNotFound],
        },
        /// Sends the marks on a page to the session's provider.
        PreviewMarkSend = mutation "preview.mark.send" {
            mutating: true,
            params: PreviewMarkSendRequest,
            result: PreviewMarkSendResponse,
            refusals: [SessionNotFound],
        },
        /// Streams a page's live picture to another device.
        PreviewScreencastSubscribe = subscription "preview.screencast.subscribe" {
            mutating: false,
            params: PreviewScreencastSubscribeRequest,
            result: SubscribeAckResponse,
            emission: PreviewScreencastElement,
            refusals: [SessionNotFound],
        },
        /// Acknowledges one frame of the live picture.
        PreviewScreencastAcknowledge = mutation "preview.screencast.acknowledge" {
            mutating: true,
            params: PreviewScreencastAcknowledgeRequest,
            result: EmptyPayload,
            refusals: [SessionNotFound],
        },
        /// Sends one input from another device to a page.
        PreviewScreencastInputSend = mutation "preview.screencast.input.send" {
            mutating: true,
            params: PreviewScreencastInputSendRequest,
            result: PreviewScreencastInputSendResponse,
            refusals: [SessionNotFound],
        },
        /// Applies an act from the menu a device's input raised.
        PreviewScreencastEdit = mutation "preview.screencast.edit" {
            mutating: true,
            params: PreviewScreencastEditRequest,
            result: PreviewMenuEditResponse,
            refusals: [SessionNotFound, PreviewEditRefused],
        },
        /// Answers a file chooser or a picker a device's input opened.
        PreviewScreencastFileChoose = mutation "preview.screencast.file.choose" {
            mutating: true,
            params: PreviewScreencastFileChooseRequest,
            result: PreviewScreencastFileChooseResponse,
            refusals: [SessionNotFound, PreviewFilePathRefused],
        },
        /// Acknowledges a save the device has written or thrown away.
        PreviewScreencastSaveAcknowledge = mutation "preview.screencast.save.acknowledge" {
            mutating: true,
            params: PreviewScreencastSaveAcknowledgeRequest,
            result: EmptyPayload,
            refusals: [SessionNotFound],
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
        Definition::read::<PreviewPageSubscribeRequest>().checked(),
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
        Definition::read::<PreviewPageNavigateRequest>().checked(),
        Definition::read::<PreviewPageNavigateResponse>().checked(),
        Definition::read::<PreviewPageZoomUpdateRequest>().checked(),
        Definition::read::<PreviewPageZoomUpdateResponse>().checked(),
        Definition::read::<PreviewDevServerSubscribeRequest>().checked(),
        Definition::read::<PreviewDevServer>(),
        Definition::read::<PreviewDevServerListFrame>().checked(),
        Definition::read::<PreviewPoint>(),
        Definition::read::<PreviewRect>(),
        Definition::read::<PreviewElementRef>(),
        Definition::read::<PreviewMarkElement>(),
        Definition::read::<PreviewMark>(),
        Definition::read::<PreviewMarkSendRequest>().checked(),
        Definition::read::<PreviewMarkSendResponse>().checked(),
        Definition::read::<PreviewScreencastSubscribeRequest>().checked(),
        Definition::read::<PreviewScreencastFrameMetadata>(),
        Definition::read::<PreviewScreencastAckToken>(),
        Definition::read::<PreviewInputMessageId>().checked(),
        Definition::read::<PreviewSaveId>().checked(),
        Definition::read::<PreviewFileChooserMode>(),
        Definition::read::<PreviewScreencastElement>().checked(),
        Definition::read::<PreviewScreencastAcknowledgeRequest>().checked(),
        Definition::read::<PreviewMouseAction>(),
        Definition::read::<PreviewMouseButton>(),
        Definition::read::<PreviewTouchAction>(),
        Definition::read::<PreviewTouchPoint>(),
        Definition::read::<PreviewKeyAction>(),
        Definition::read::<PreviewDeviceInput>(),
        Definition::read::<PreviewScreencastInputSendRequest>().checked(),
        Definition::read::<PreviewScreencastInputSendResponse>().checked(),
        Definition::read::<PreviewMenuEdit>(),
        Definition::read::<PreviewScreencastEditRequest>().checked(),
        Definition::read::<PreviewMenuEditResponse>().checked(),
        Definition::read::<PreviewChosenFile>(),
        Definition::read::<PreviewScreencastFileChooseRequest>().checked(),
        Definition::read::<PreviewScreencastFileChooseResponse>().checked(),
        Definition::read::<PreviewScreencastSaveAcknowledgeRequest>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&PREVIEW_METHOD_DESCRIPTORS],
};
