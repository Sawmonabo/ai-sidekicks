//! The Preview page host's link between the daemon and the desktop's main process, over the
//! connection the app dials: main reports each page's debug target, relays its debugger traffic,
//! its menus, the input at the machine and its downloads, and the daemon edits a page from a
//! device's menu, moves staged files and reads, writes and clears the page host's cookies and site
//! data. Two method tables follow, one per direction; main's never joins the daemon's own method
//! map.

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::preview::marks::PreviewPoint;
use crate::preview::page::{PreviewAddress, PreviewPageId};
use crate::preview::screencast::{PreviewInputMessageId, PreviewMenuEdit, PreviewMenuEditResponse};
use crate::preview::staging::{
    PREVIEW_STAGED_FILE_ID_MAX_LEN, PreviewDownloadState, PreviewDownloadVerdict,
    PreviewFilePartResponse, PreviewPageDownloadReportRequest, PreviewPageDownloadReportResponse,
    PreviewPageFileReadRequest, PreviewPageFileStageRequest, PreviewPageStagingFolderReadResponse,
    PreviewSaveReadRequest, PreviewStagedFileId,
};
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::True;
use crate::wire::integer::{SafeInt, SafeSignedInt};
use crate::wire::list::BoundedVec;
use crate::wire::number::Number;
use crate::wire::record::JsonRecord;
use crate::wire::text::{BoundedText, NonEmptyText, branded_text};

branded_text! {
    /// A debug-protocol session id: the child session a message rides on.
    pub struct PreviewDebuggerSessionId(1..=usize::MAX);
}

branded_text! {
    /// A debug-protocol target id: the target behind one page's view.
    pub struct PreviewDebuggerTargetId(1..=usize::MAX);
}

/// A debug-protocol error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewDebuggerError {
    /// The protocol's error code.
    pub code: SafeSignedInt,
    /// What went wrong.
    pub message: String,
}

/// Declares one debug-protocol message arm: its own members, then the child session it rides on,
/// absent for the page's own session.
macro_rules! debugger_message_arm {
    ($(#[doc = $doc:literal])+ pub struct $name:ident { $($members:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        pub struct $name {
            $($members)*
            /// The child session it rides on; absent for the page's own session.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "PreviewDebuggerSessionId")]
            pub session_id: Option<PreviewDebuggerSessionId>,
        }
    };
}

debugger_message_arm! {
    /// A command.
    pub struct PreviewDebuggerCommand {
        /// The command's id, which its reply repeats.
        pub id: SafeSignedInt,
        /// The protocol method.
        pub method: NonEmptyText,
        /// Its parameters.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "JsonRecord")]
        pub params: Option<JsonRecord>,
    }
}

debugger_message_arm! {
    /// A command's result.
    pub struct PreviewDebuggerResult {
        /// The command's id.
        pub id: SafeSignedInt,
        /// The result.
        pub result: JsonRecord,
    }
}

debugger_message_arm! {
    /// A command's error.
    pub struct PreviewDebuggerFailure {
        /// The command's id.
        pub id: SafeSignedInt,
        /// The error.
        pub error: PreviewDebuggerError,
    }
}

debugger_message_arm! {
    /// An event.
    pub struct PreviewDebuggerEvent {
        /// The protocol method.
        pub method: NonEmptyText,
        /// Its parameters.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "JsonRecord")]
        pub params: Option<JsonRecord>,
    }
}

/// One debug-protocol message between the daemon's relay and a page's debugger in main: a command,
/// its result or error, or an event.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum PreviewDebuggerMessage {
    /// A command.
    Command(PreviewDebuggerCommand),
    /// A command's result.
    Result(PreviewDebuggerResult),
    /// A command's error.
    Failure(PreviewDebuggerFailure),
    /// An event.
    Event(PreviewDebuggerEvent),
}

/// Main reports the debug target behind one page's view, once the view exists.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPageTargetReportRequest {
    /// The page.
    pub page_id: PreviewPageId,
    /// Its debug target.
    pub target_id: PreviewDebuggerTargetId,
}

/// One debugger message for one page, in either direction: the daemon sends a command to main, and
/// main returns the results and events to the daemon.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPageDebuggerMessageRequest {
    /// The page.
    pub page_id: PreviewPageId,
    /// The message.
    pub message: PreviewDebuggerMessage,
}

/// The receiving end took the report or the message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewReceivedResponse {
    /// Always `true`.
    pub received: True,
}

/// Where a cookie is sent from another site's page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum PreviewCookieSameSite {
    /// Same-site requests only.
    Strict,
    /// Same-site requests and top-level navigations.
    Lax,
    /// Every request.
    None,
}

/// One cookie, in the record the daemon's browser library keeps. `expires` is in seconds since the
/// epoch, `-1` for a cookie that lasts the browsing session. Its value is a secret: it travels
/// only between the daemon and main, and its `Debug` form leaves it out.
#[derive(Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewCookie {
    /// The cookie's name.
    pub name: String,
    /// The cookie's value.
    pub value: String,
    /// The domain it is sent to.
    pub domain: NonEmptyText,
    /// The path it is sent under.
    pub path: BoundedText<1, FILE_PATH_MAX_LEN>,
    /// When it expires, in seconds since the epoch; `-1` for the browsing session.
    pub expires: Number,
    /// Whether scripts cannot read it.
    pub http_only: bool,
    /// Whether it is sent over `https:` only.
    pub secure: bool,
    /// Where it is sent from another site's page.
    pub same_site: PreviewCookieSameSite,
}

impl fmt::Debug for PreviewCookie {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreviewCookie")
            .field("name", &self.name)
            .field("value", &"<redacted>")
            .field("domain", &self.domain)
            .field("path", &self.path)
            .field("expires", &self.expires)
            .field("http_only", &self.http_only)
            .field("secure", &self.secure)
            .field("same_site", &self.same_site)
            .finish()
    }
}

/// A site's registrable domain, such as `example.com`, the unit site data is cleared by.
pub type PreviewSiteDomain = BoundedText<1, 253>;

/// Reads the Preview cookies of one registrable domain, or of every site where `domain` is absent,
/// as a host takes over from the other.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPageCookiesReadRequest {
    /// The site.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "PreviewSiteDomain")]
    pub domain: Option<PreviewSiteDomain>,
}

/// Every cookie the read covers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewPageCookiesReadResponse {
    /// The cookies.
    pub cookies: Vec<PreviewCookie>,
}

/// Writes cookies into the Preview site data; a cookie with the same name, domain and path is
/// replaced.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPageCookiesWriteRequest {
    /// The cookies.
    pub cookies: Vec<PreviewCookie>,
}

/// How many of the cookies were written.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewPageCookiesWriteResponse {
    /// The count written.
    pub written: SafeInt<0>,
}

/// Clears one site's cookies across its registrable domain, parent-domain cookies included, and
/// nothing else: its storage, cache and service workers stay.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPageCookiesClearRequest {
    /// The site.
    pub domain: PreviewSiteDomain,
}

/// Clears every kind of saved data for the named sites, or for every site where `origins` is
/// absent; a present list names at least one site.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPageSiteDataClearRequest {
    /// The sites' origins.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "BoundedVec<PreviewAddress, 1, { usize::MAX }>")]
    pub origins: Option<BoundedVec<PreviewAddress, 1, { usize::MAX }>>,
}

/// The clear finished.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewClearedResponse {
    /// Always `true`.
    pub cleared: True,
}

/// The right-click menu a press main relayed raised, for which main pops no menu, as the view's
/// `context-menu` event reports it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "the wire carries each switch as its own boolean member"
)]
pub struct PreviewPageMenu {
    /// Where it opened, in view points.
    pub point: PreviewPoint,
    /// The address of the frame it opened in.
    pub frame_address: PreviewAddress,
    /// The link under the press.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "PreviewAddress")]
    pub link_url: Option<PreviewAddress>,
    /// Whether the press landed in a field that takes text.
    pub is_editable: bool,
    /// Whether the page allows a cut there.
    pub can_cut: bool,
    /// Whether the page allows a copy there.
    pub can_copy: bool,
    /// Whether the page allows select all there.
    pub can_select_all: bool,
    /// The selected text; absent where the page allows no copy, as in a password field.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "String")]
    pub selection_text: Option<String>,
}

/// Main reports the menu a relayed press raised, named by that press's message id; it sends none
/// where another press at that moment could have raised the same menu. The daemon hands it to the
/// device whose press it was and drops it for an agent's.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPageMenuReportRequest {
    /// The page.
    pub page_id: PreviewPageId,
    /// The relayed press.
    pub message_id: PreviewInputMessageId,
    /// The menu.
    pub menu: PreviewPageMenu,
}

/// Main reports that a press or key at the machine reached a page, once after each relayed input
/// to it, so the page's next download or picker call is the person's at the machine.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPageLocalInputReportRequest {
    /// The page.
    pub page_id: PreviewPageId,
}

/// A device's act from a menu main reported, naming the menu by its press's message id. Main
/// applies it in the frame holding focus while that menu is still the page's current one, and
/// otherwise refuses it with `preview.edit_refused`, changing nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPageEditRequest {
    /// The page.
    pub page_id: PreviewPageId,
    /// The menu's press.
    pub message_id: PreviewInputMessageId,
    /// The act.
    pub edit: PreviewMenuEdit,
}

methods! {
    /// The `preview.*` link methods the daemon answers; main is their only caller.
    pub const PREVIEW_PAGE_LINK_METHOD_DESCRIPTORS = [
        /// Main reports a page's debug target.
        PreviewPageTargetReport = mutation "preview.pageTargetReport" {
            mutating: true,
            params: PreviewPageTargetReportRequest,
            result: PreviewReceivedResponse,
            refusals: [],
        },
        /// Main returns a page's debugger results and events.
        PreviewPageDebuggerReport = mutation "preview.pageDebuggerReport" {
            mutating: true,
            params: PreviewPageDebuggerMessageRequest,
            result: PreviewReceivedResponse,
            refusals: [],
        },
        /// Main reports the menu a relayed press raised.
        PreviewPageMenuReport = mutation "preview.pageMenuReport" {
            mutating: true,
            params: PreviewPageMenuReportRequest,
            result: PreviewReceivedResponse,
            refusals: [],
        },
        /// Main reads the folder it writes a relayed download into, once per connection.
        PreviewPageStagingFolderRead = query "preview.pageStagingFolderRead" {
            mutating: false,
            params: EmptyPayload,
            result: PreviewPageStagingFolderReadResponse,
            refusals: [],
        },
        /// Main reports that input at the machine reached a page.
        PreviewPageLocalInputReport = mutation "preview.pageLocalInputReport" {
            mutating: true,
            params: PreviewPageLocalInputReportRequest,
            result: PreviewReceivedResponse,
            refusals: [],
        },
        /// Main reports a relayed download in its end state.
        PreviewPageDownloadReport = mutation "preview.pageDownloadReport" {
            mutating: true,
            params: PreviewPageDownloadReportRequest,
            result: PreviewPageDownloadReportResponse,
            refusals: [PreviewFilePathRefused],
        },
        /// Main, in a desktop app reaching another machine, reads one part of a save its own
        /// daemon kept for it.
        PreviewSaveRead = query "preview.saveRead" {
            mutating: false,
            params: PreviewSaveReadRequest,
            result: PreviewFilePartResponse,
            refusals: [],
        },
    ];
}

methods! {
    /// The `preview.*` methods main's page host answers. The daemon is their only caller, over the
    /// connection the app dials, so they never join the daemon's own method map.
    pub const PREVIEW_PAGE_HOST_METHOD_DESCRIPTORS = [
        /// Sends a debugger command to a page.
        PreviewPageDebuggerSend = mutation "preview.pageDebuggerSend" {
            mutating: true,
            params: PreviewPageDebuggerMessageRequest,
            result: PreviewReceivedResponse,
            refusals: [],
        },
        /// Reads one part of a file main staged in its own folder, on a WSL 2 computer.
        PreviewPageFileRead = query "preview.pageFileRead" {
            mutating: false,
            params: PreviewPageFileReadRequest,
            result: PreviewFilePartResponse,
            refusals: [],
        },
        /// Sends main one part of a file to set or drop on a page, on a WSL 2 computer.
        PreviewPageFileStage = mutation "preview.pageFileStage" {
            mutating: true,
            params: PreviewPageFileStageRequest,
            result: PreviewReceivedResponse,
            refusals: [],
        },
        /// Applies a device's menu act to a page.
        PreviewPageEdit = mutation "preview.pageEdit" {
            mutating: true,
            params: PreviewPageEditRequest,
            result: PreviewMenuEditResponse,
            refusals: [PreviewEditRefused],
        },
        /// Reads cookies.
        PreviewPageCookiesRead = query "preview.pageCookiesRead" {
            mutating: false,
            params: PreviewPageCookiesReadRequest,
            result: PreviewPageCookiesReadResponse,
            refusals: [],
        },
        /// Writes cookies.
        PreviewPageCookiesWrite = mutation "preview.pageCookiesWrite" {
            mutating: true,
            params: PreviewPageCookiesWriteRequest,
            result: PreviewPageCookiesWriteResponse,
            refusals: [],
        },
        /// Clears one site's cookies.
        PreviewPageCookiesClear = mutation "preview.pageCookiesClear" {
            mutating: true,
            params: PreviewPageCookiesClearRequest,
            result: PreviewClearedResponse,
            refusals: [],
        },
        /// Clears site data.
        PreviewPageSiteDataClear = mutation "preview.pageSiteDataClear" {
            mutating: true,
            params: PreviewPageSiteDataClearRequest,
            result: PreviewClearedResponse,
            refusals: [],
        },
    ];
}

ts_constants! {
    /// The longest staged-file id main or the daemon mints.
    PREVIEW_STAGED_FILE_ID_MAX_LEN = PREVIEW_STAGED_FILE_ID_MAX_LEN;
}

/// The TypeScript module of the page host's link.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "preview/page-host",
    doc: "The Preview page host's link between the daemon and the desktop's main process: debug \
          targets, debugger traffic, menus, input at the machine, downloads, staged files, menu \
          acts, cookies and site data.",
    definitions: &[
        Definition::read::<PreviewDebuggerSessionId>(),
        Definition::read::<PreviewDebuggerTargetId>(),
        Definition::read::<PreviewDebuggerError>(),
        Definition::read::<PreviewDebuggerMessage>(),
        Definition::read::<PreviewPageTargetReportRequest>().checked(),
        Definition::read::<PreviewPageDebuggerMessageRequest>().checked(),
        Definition::read::<PreviewReceivedResponse>().checked(),
        Definition::read::<PreviewPageMenu>(),
        Definition::read::<PreviewPageMenuReportRequest>().checked(),
        Definition::read::<PreviewPageStagingFolderReadResponse>().checked(),
        Definition::read::<PreviewPageLocalInputReportRequest>().checked(),
        Definition::read::<PreviewStagedFileId>().checked(),
        Definition::read::<PreviewDownloadState>(),
        Definition::read::<PreviewPageDownloadReportRequest>().checked(),
        Definition::read::<PreviewDownloadVerdict>(),
        Definition::read::<PreviewPageDownloadReportResponse>().checked(),
        Definition::read::<PreviewSaveReadRequest>().checked(),
        Definition::read::<PreviewFilePartResponse>().checked(),
        Definition::read::<PreviewPageFileReadRequest>().checked(),
        Definition::read::<PreviewPageFileStageRequest>().checked(),
        Definition::read::<PreviewPageEditRequest>().checked(),
        Definition::read::<PreviewCookieSameSite>(),
        Definition::read::<PreviewCookie>(),
        Definition::read::<PreviewPageCookiesReadRequest>().checked(),
        Definition::read::<PreviewPageCookiesReadResponse>().checked(),
        Definition::read::<PreviewPageCookiesWriteRequest>().checked(),
        Definition::read::<PreviewPageCookiesWriteResponse>().checked(),
        Definition::read::<PreviewPageCookiesClearRequest>().checked(),
        Definition::read::<PreviewPageSiteDataClearRequest>().checked(),
        Definition::read::<PreviewClearedResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[
        &PREVIEW_PAGE_LINK_METHOD_DESCRIPTORS,
        &PREVIEW_PAGE_HOST_METHOD_DESCRIPTORS,
    ],
};
