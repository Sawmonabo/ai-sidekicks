//! A session's shells as a client addresses them: the live list, opening, closing and ordering,
//! one shell's output stream, writing and resizing, the appearance a program's questions about its
//! terminal are answered from, and (in [`control`]) flow control and the per-shell control lease.
//!
//! Every request names the session and the terminal, and a take or a write names the pane's output
//! subscription it comes through. A request naming a shell its session does not have is refused
//! `pty.not_found`, so a terminal id alone never reaches another session's shell. The flow-control
//! signal is the one exception: naming such a shell changes nothing, since it may race a closing
//! shell. A take or write whose subscription is not the calling connection's open subscription to
//! that shell is refused `pty.output_subscription_not_found`, so a hold is never bound to another
//! connection's pane.

pub mod control;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::color::HexColor;
use crate::command::ExitCode;
use crate::event::registry::SessionEventType;
use crate::jsonrpc::framing::MAX_ONE_ATTACHMENT_BYTES;
use crate::jsonrpc::streaming::{STREAM_FRAME_MAX_CHANGES, SubscribeAckResponse, SubscriptionId};
use crate::method::methods;
use crate::method_descriptor::NullPayload;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::attachment::Bytes;
use crate::wire::id::ClientUuid;
use crate::wire::integer::SafeInt;
use crate::wire::list::{BoundedVec, ListKey, UniqueList};
use crate::wire::text::{BoundedText, branded_text};
use crate::wire::{NullableSchema, True, nullable};
use control::{
    LeaseVersion, PtyControlChangedPayload, PtyControlChangedReason, PtyControlHeldByOtherDetails,
    SessionSetTerminalFlowControlRequest, SessionSetTerminalFlowControlResponse,
    SessionTakeControlRequest, SessionTakeControlResponse, TERMINAL_CONTROL_METHOD_DESCRIPTORS,
    TerminalControlHolder,
};

ts_constants! {
    /// How many colors a terminal's ANSI palette holds: eight and their eight bright forms.
    pub const TERMINAL_PALETTE_LENGTH: usize = 16;
    /// The longest terminal id the daemon accepts.
    pub const TERMINAL_ID_MAX_LEN: usize = 256;
    /// The longest title a shell carries on the wire; the daemon cuts a longer title the shell
    /// sets to this many UTF-16 units, on a grapheme boundary.
    pub const SHELL_TITLE_MAX_LEN: usize = 256;
    /// The event every change of one shell's holder is broadcast on.
    pub const PTY_CONTROL_CHANGED_EVENT: &str = SessionEventType::PtyControlChanged.as_str();
    /// Every reason a shell's holder can change.
    PTY_CONTROL_CHANGED_REASONS = PtyControlChangedReason::VARIANTS;
}

branded_text! {
    /// The daemon-minted id of one shell in a session, opaque to every client.
    pub struct TerminalId(1..=TERMINAL_ID_MAX_LEN);
}

/// How many bytes of a shell's output, its marks taken out, came before a point in its stream.
pub type OutputOffset = SafeInt<0>;

/// `pty.list`: the session whose shells the subscription follows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PtyListRequest {
    /// The session.
    pub session_id: SessionId,
}

/// Where one shell's process stands. A shell that ends keeps its entry with its exit code until it
/// is closed; a shell that could not start keeps its entry with the daemon's words for why, and
/// takes no input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PtyShellStatus {
    /// Running.
    Running {},
    /// Its program ended.
    Exited {
        /// The program's exit code.
        exit_code: ExitCode,
    },
    /// It could not start.
    DidNotStart {
        /// The daemon's words for why.
        cause: BoundedText<1, { usize::MAX }>,
    },
}

/// One shell as the tab strip draws it. `title` is the title the shell set for itself, or its
/// program's base name until it sets one. `holder` is `null` while nobody holds the shell, and
/// `leaseVersion` is the lease version that holder was read at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PtyListEntry {
    /// The shell.
    pub terminal_id: TerminalId,
    /// Its title.
    pub title: BoundedText<1, SHELL_TITLE_MAX_LEN>,
    /// Where its process stands.
    pub status: PtyShellStatus,
    /// Who holds it, or `null`.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<TerminalControlHolder>")]
    #[garde(dive)]
    pub holder: Option<TerminalControlHolder>,
    /// The lease version the holder was read at.
    pub lease_version: LeaseVersion,
}

/// The session's whole set of shells, sent on every change, in tab order. The order is the
/// daemon's, so every device draws the same strip. A shell gone before the list was first read is
/// not in it, and a shell appears at most once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PtyListUpdate {
    /// The session.
    #[garde(skip)]
    pub session_id: SessionId,
    /// Its shells, in tab order.
    #[garde(dive)]
    pub terminals: UniqueList<PtyListEntry, 0, { usize::MAX }>,
}

/// `pty.open`: another shell for the session, the person's own login shell in the session's tree,
/// so the request carries no program, arguments or folder. The caller mints the key, and a retry
/// with the same key never opens a second shell.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PtyOpenRequest {
    /// The session.
    pub session_id: SessionId,
    /// The caller's key for this open.
    pub client_idempotency_key: ClientUuid,
}

/// The new shell's id. A shell that fails to start still has one: its tab stays and its list entry
/// reads `did_not_start` with the cause.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PtyOpenResponse {
    /// The shell.
    pub terminal_id: TerminalId,
}

/// `pty.close`: closes one shell and ends its process; closing several sends this once per shell.
/// The daemon refuses it while a run holds the shell, and while another device holds it unless
/// `force` is true, which the screen sends only after the person confirmed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PtyCloseRequest {
    /// The session.
    pub session_id: SessionId,
    /// The shell.
    pub terminal_id: TerminalId,
    /// Whether to close it off another device.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub force: Option<bool>,
}

/// `pty.reorder`: the session's shells in their new tab order, each named at most once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PtyReorderRequest {
    /// The session.
    #[garde(skip)]
    pub session_id: SessionId,
    /// The shells, in their new order.
    #[garde(dive)]
    #[schemars(extend("uniqueItems" = true))]
    pub terminal_ids: UniqueList<TerminalId, 1, { usize::MAX }>,
}

/// `pty.outputSubscribe`: the shell whose output the subscription streams. `afterOffset` is where
/// a watcher that reconnects got to: while that offset is still inside the scrollback window it
/// gets only the bytes after it, and a fresh `scrollback` otherwise.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PtyOutputSubscribeRequest {
    /// The session.
    pub session_id: SessionId,
    /// The shell.
    pub terminal_id: TerminalId,
    /// The output offset the watcher already has.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "OutputOffset")]
    pub after_offset: Option<OutputOffset>,
}

/// One change on a shell's output stream; `cursor` is the shell's output offset once the change is
/// applied, in bytes since the shell started. `scrollback` opens the scrollback window, starting at
/// its first whole line, with the columns and rows it was last drawn at (so a running program's
/// boxes come back unwrapped) and who holds it at which lease version; a window too large for one
/// message goes on in `scrollback_continuation` changes, each in a frame of its own, before any
/// output. `output` is what the shell wrote next, in order; `exited` is its program's end. Output
/// and scrollback travel as raw bytes, an attachment each, with no character held back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum PtyOutputChange {
    /// The scrollback window opens.
    Scrollback {
        /// The session.
        session_id: SessionId,
        /// The shell.
        terminal_id: TerminalId,
        /// The window's bytes.
        data: Bytes<0, MAX_ONE_ATTACHMENT_BYTES>,
        /// The columns it was last drawn at.
        columns: SafeInt<1>,
        /// The rows it was last drawn at.
        rows: SafeInt<1>,
        /// Who holds the shell, or `null`.
        #[serde(deserialize_with = "nullable")]
        #[schemars(with = "NullableSchema<TerminalControlHolder>")]
        #[garde(dive)]
        holder: Option<TerminalControlHolder>,
        /// The lease version the holder was read at.
        lease_version: LeaseVersion,
        /// The output offset after the change.
        cursor: OutputOffset,
    },
    /// The scrollback window goes on.
    ScrollbackContinuation {
        /// The session.
        session_id: SessionId,
        /// The shell.
        terminal_id: TerminalId,
        /// The window's next bytes.
        data: Bytes<1, MAX_ONE_ATTACHMENT_BYTES>,
        /// The output offset after the change.
        cursor: OutputOffset,
    },
    /// What the shell wrote next.
    Output {
        /// The session.
        session_id: SessionId,
        /// The shell.
        terminal_id: TerminalId,
        /// The bytes.
        data: Bytes<1, MAX_ONE_ATTACHMENT_BYTES>,
        /// The output offset after the change.
        cursor: OutputOffset,
    },
    /// The shell's program ended.
    Exited {
        /// The session.
        session_id: SessionId,
        /// The shell.
        terminal_id: TerminalId,
        /// The program's exit code.
        exit_code: ExitCode,
        /// The output offset after the change.
        cursor: OutputOffset,
    },
}

/// One notify of a shell's output stream. The first frame opens with the `scrollback` change, and
/// the frames that continue the window follow it. A watcher that fell behind stops receiving
/// output, and once it has caught up its next frame carries the drop mark and a fresh `scrollback`
/// change, so it redraws from the scrollback window and no byte reaches it twice; one still behind
/// when the shell exits gets the drop mark, a fresh `scrollback` change and the `exited` change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PtyOutputFrame {
    /// The changes, oldest first.
    #[garde(dive)]
    pub changes: BoundedVec<PtyOutputChange, 1, STREAM_FRAME_MAX_CHANGES>,
    /// Present on the frame after a drop.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "True")]
    #[garde(skip)]
    pub dropped: Option<True>,
}

/// `pty.write`: input for one shell, written as it arrives; the writer's connection must hold the
/// shell. The write is bound to `outputSubscriptionId`, the writing pane's own
/// `pty.outputSubscribe` subscription to that shell: a first write to a shell nobody holds takes it
/// through that subscription, and a holding connection's write binds it to the hold. `keys` is
/// typed text. A `paste` is pasted text sent in one or more parts, each under the wire's message
/// cap, all naming the client-minted `pasteId` and the last one `isLastPart`; when the program in
/// the shell asked for pasted text to be marked as pasted, the daemon marks the whole paste once
/// around all its parts. Each pane has one paste open at a time: a part naming a new `pasteId`
/// closes the pane's earlier paste first. The daemon answers a write once its bytes reach the
/// shell's terminal, so a client that sends a paste's next part after the answer to the last pastes
/// no faster than the program reads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum PtyWriteRequest {
    /// Typed text.
    Keys {
        /// The session.
        session_id: SessionId,
        /// The shell.
        terminal_id: TerminalId,
        /// The writing pane's output subscription.
        output_subscription_id: SubscriptionId,
        /// The text.
        data: String,
    },
    /// One part of a paste.
    Paste {
        /// The session.
        session_id: SessionId,
        /// The shell.
        terminal_id: TerminalId,
        /// The writing pane's output subscription.
        output_subscription_id: SubscriptionId,
        /// The part's text.
        data: String,
        /// The paste, minted by the client.
        paste_id: ClientUuid,
        /// Whether this is the paste's last part.
        is_last_part: bool,
    },
}

/// `pty.resize`: a shell's new size in character cells. Only a connection holding it sets it;
/// watchers follow.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PtyResizeRequest {
    /// The session.
    pub session_id: SessionId,
    /// The shell.
    pub terminal_id: TerminalId,
    /// Columns.
    pub columns: SafeInt<1>,
    /// Rows.
    pub rows: SafeInt<1>,
}

/// The colors a terminal draws with, which a program asking its terminal for them is answered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalColors {
    /// The text color.
    pub foreground: HexColor,
    /// The background.
    pub background: HexColor,
    /// The cursor.
    pub cursor: HexColor,
    /// The sixteen ANSI colors in their numbered order, black first and bright white last.
    pub palette: BoundedVec<HexColor, TERMINAL_PALETTE_LENGTH, TERMINAL_PALETTE_LENGTH>,
}

/// One character cell of a pane's grid, in CSS pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalCellSize {
    /// Width.
    pub width: SafeInt<1>,
    /// Height.
    pub height: SafeInt<1>,
}

/// `pty.reportTerminalAppearance`: the appearance the daemon answers a program's questions about
/// its terminal from, as no screen answers them. `console_theme` is the console theme's terminal
/// colors, which the desktop reports on connecting and at every change of appearance; it serves
/// every shell whose holder reported none. `holding_pane` is the colors and cell size of the pane
/// holding the shell, which only a connection the shell's hold is bound to may report, refused as a
/// resize from another is; it outranks the console theme until the shell changes holder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "source",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum PtyReportTerminalAppearanceRequest {
    /// The console theme's colors.
    ConsoleTheme {
        /// The colors.
        colors: TerminalColors,
    },
    /// The holding pane's colors and cell size.
    HoldingPane {
        /// The session.
        session_id: SessionId,
        /// The shell.
        terminal_id: TerminalId,
        /// The colors.
        colors: TerminalColors,
        /// The cell size.
        cell_size: TerminalCellSize,
    },
}

methods! {
    /// Every `pty.*` method.
    pub const PTY_METHOD_DESCRIPTORS = [
        /// Follows the session's shells.
        PtyList = subscription "pty.list" {
            mutating: false,
            params: PtyListRequest,
            result: SubscribeAckResponse,
            emission: PtyListUpdate,
            refusals: [SessionNotFound],
        },
        /// Opens another shell.
        PtyOpen = mutation "pty.open" {
            mutating: true,
            params: PtyOpenRequest,
            result: PtyOpenResponse,
            refusals: [
                SessionNotFound,
                PtyChatUnsupported,
                PtyBackendUnavailable,
                SessionWorkingFolderUnavailable,
            ],
        },
        /// Closes one shell.
        PtyClose = mutation "pty.close" {
            mutating: true,
            params: PtyCloseRequest,
            result: NullPayload,
            refusals: [SessionNotFound, PtyNotFound, PtyControlHeldByOther],
        },
        /// Reorders the session's shells.
        PtyReorder = mutation "pty.reorder" {
            mutating: true,
            params: PtyReorderRequest,
            result: NullPayload,
            refusals: [SessionNotFound, PtyNotFound],
        },
        /// Streams one shell's output.
        PtyOutputSubscribe = subscription "pty.outputSubscribe" {
            mutating: false,
            params: PtyOutputSubscribeRequest,
            result: SubscribeAckResponse,
            emission: PtyOutputFrame,
            refusals: [SessionNotFound, PtyNotFound],
        },
        /// Writes input to one shell.
        PtyWrite = mutation "pty.write" {
            mutating: true,
            params: PtyWriteRequest,
            result: NullPayload,
            refusals: [
                SessionNotFound,
                PtyNotFound,
                PtyControlNotHeld,
                PtyOutputSubscriptionNotFound,
            ],
        },
        /// Resizes one shell.
        PtyResize = mutation "pty.resize" {
            mutating: true,
            params: PtyResizeRequest,
            result: NullPayload,
            refusals: [SessionNotFound, PtyNotFound, PtyControlHeldByOther, PtyControlNotHeld],
        },
        /// Reports the appearance a program's questions are answered from.
        PtyReportTerminalAppearance = mutation "pty.reportTerminalAppearance" {
            mutating: true,
            params: PtyReportTerminalAppearanceRequest,
            result: NullPayload,
            refusals: [SessionNotFound, PtyNotFound, PtyControlHeldByOther, PtyControlNotHeld],
        },
    ];
}

/// The TypeScript module of a session's shells.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "pty",
    doc: "A session's shells as a client addresses them: the live list, opening, closing and \
          ordering, one shell's output stream, writing and resizing, terminal appearance, flow \
          control, and the per-shell control lease.",
    definitions: &[
        Definition::read::<TerminalId>().checked(),
        Definition::read::<TerminalControlHolder>().checked(),
        Definition::read::<PtyListRequest>().checked(),
        Definition::read::<PtyShellStatus>(),
        Definition::read::<PtyListEntry>(),
        Definition::read::<PtyListUpdate>().checked(),
        Definition::read::<PtyOpenRequest>().checked(),
        Definition::read::<PtyOpenResponse>().checked(),
        Definition::read::<PtyCloseRequest>().checked(),
        Definition::read::<PtyReorderRequest>().checked(),
        Definition::read::<PtyOutputSubscribeRequest>().checked(),
        Definition::read::<PtyOutputChange>(),
        Definition::read::<PtyOutputFrame>().checked(),
        Definition::read::<PtyWriteRequest>().checked(),
        Definition::read::<PtyResizeRequest>().checked(),
        Definition::read::<TerminalColors>().checked(),
        Definition::read::<TerminalCellSize>().checked(),
        Definition::read::<PtyReportTerminalAppearanceRequest>().checked(),
        Definition::read::<SessionSetTerminalFlowControlRequest>().checked(),
        Definition::read::<SessionSetTerminalFlowControlResponse>().checked(),
        Definition::read::<SessionTakeControlRequest>().checked(),
        Definition::read::<SessionTakeControlResponse>().checked(),
        Definition::read::<PtyControlChangedReason>(),
        Definition::read::<PtyControlChangedPayload>().checked(),
        Definition::read::<PtyControlHeldByOtherDetails>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[
        &PTY_METHOD_DESCRIPTORS,
        &TERMINAL_CONTROL_METHOD_DESCRIPTORS,
    ],
};

impl ListKey for PtyListEntry {
    type Key = TerminalId;

    fn list_key(&self) -> TerminalId {
        self.terminal_id.clone()
    }

    fn validate_item(&self, parent: &mut dyn FnMut() -> garde::Path, report: &mut garde::Report) {
        garde::Validate::validate_into(self, &(), parent, report);
    }
}

impl ListKey for TerminalId {
    type Key = Self;

    fn list_key(&self) -> Self {
        self.clone()
    }
}
