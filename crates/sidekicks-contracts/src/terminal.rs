//! A session's shells as a client addresses them: the live list, opening, closing and ordering,
//! one shell's output stream, writing and resizing, the appearance a program's questions about its
//! terminal are answered from, and (in [`control`]) flow control and the per-shell control lease.
//!
//! Every request names the session and the terminal, and a take or a write names the pane's output
//! subscription it comes through. A request naming a shell its session does not have is refused
//! `terminal.notFound`, so a terminal id alone never reaches another session's shell. The
//! flow-control signal is the one exception: naming such a shell changes nothing, since it may race
//! a closing shell. A take or write whose subscription is not the calling connection's open
//! subscription to that shell is refused `terminal.output.subscriptionNotFound`, so a hold is never
//! bound to another connection's pane.

pub mod control;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::color::HexColor;
use crate::command::ExitCode;
use crate::event::registry::SessionEventType;
use crate::jsonrpc::byte_length::fits_budget;
use crate::jsonrpc::framing::MAX_ONE_ATTACHMENT_BYTES;
use crate::jsonrpc::streaming::{
    STREAM_FRAME_MAX_CHANGES, SubscribeAcknowledgmentResponse, SubscriptionId,
};
use crate::method::methods;
use crate::method_descriptor::NullPayload;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::attachment::Bytes;
use crate::wire::id::ClientUuid;
use crate::wire::integer::SafeInt;
use crate::wire::list::{BoundedVec, ListKey, UniqueList};
use crate::wire::text::{BoundedText, NonEmptyText, branded_text};
use crate::wire::{NullableSchema, True, nullable};
use control::{
    LeaseVersion, TERMINAL_CONTROL_METHOD_DESCRIPTORS, TerminalControlChangedPayload,
    TerminalControlChangedReason, TerminalControlHeldByOtherDetails, TerminalControlHolder,
    TerminalControlTakeRequest, TerminalControlTakeResponse, TerminalFlowControlUpdateRequest,
    TerminalFlowControlUpdateResponse,
};

ts_constants! {
    /// How many colors a terminal's ANSI palette holds: eight and their eight bright forms.
    pub const TERMINAL_PALETTE_LENGTH: usize = 16;
    /// The longest terminal id the daemon accepts.
    pub const TERMINAL_ID_MAX_LEN: usize = 256;
    /// The longest title a shell carries on the wire, in code points; the daemon cuts a longer
    /// title the shell sets to whole graphemes within it, and within it to whole code points only
    /// when one grapheme alone is longer.
    pub const SHELL_TITLE_MAX_LEN: usize = 256;
    /// The most bytes one `terminal.write`'s `data` measures as its JSON travels.
    pub const TERMINAL_WRITE_MAX_BYTES: usize = 65_536;
    /// How many writes to one shell a client keeps waiting for an answer before it joins its next
    /// typed keys into later writes, sent in order as answers return.
    pub const TERMINAL_WRITES_WAITING_PER_SHELL: usize = 8;
    /// How many of one connection's writes to one shell may wait for an answer; a write that finds
    /// this many waiting is refused `terminal.write.limitReached`. Twice the client's own figure,
    /// so an interrupt, quit or suspend key sent at once with the keys before it still fits.
    pub const TERMINAL_WRITES_WAITING_LIMIT: usize = 2 * TERMINAL_WRITES_WAITING_PER_SHELL;
    /// The event every change of one shell's holder is broadcast on.
    pub const TERMINAL_CONTROL_CHANGED_EVENT: &str =
        SessionEventType::TerminalControlChanged.as_str();
    /// Every reason a shell's holder can change.
    TERMINAL_CONTROL_CHANGED_REASONS = TerminalControlChangedReason::VARIANTS;
}

branded_text! {
    /// The daemon-minted id of one shell in a session, opaque to every client.
    pub struct TerminalId(1..=TERMINAL_ID_MAX_LEN);
}

/// How many bytes of a shell's output, its marks taken out, came before a point in its stream.
pub type OutputOffset = SafeInt<0>;

/// `terminal.subscribe`: the session whose shells the subscription follows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TerminalSubscribeRequest {
    /// The session.
    pub session_id: SessionId,
}

/// Where one shell's process stands. A shell that ends keeps its entry with its exit code until it
/// is closed; a shell that could not start keeps its entry with the daemon's words for why, and
/// takes no input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TerminalShellStatus {
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
        cause: NonEmptyText,
    },
}

/// One shell as the tab strip draws it. `title` is the title the shell set for itself, or its
/// program's base name until it sets one. `holder` is `null` while nobody holds the shell, and
/// `leaseVersion` is the lease version that holder was read at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TerminalListEntry {
    /// The shell.
    pub terminal_id: TerminalId,
    /// Its title.
    pub title: BoundedText<1, SHELL_TITLE_MAX_LEN>,
    /// Where its process stands.
    pub status: TerminalShellStatus,
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
pub struct TerminalListUpdate {
    /// The session.
    #[garde(skip)]
    pub session_id: SessionId,
    /// Its shells, in tab order.
    #[garde(dive)]
    pub terminals: UniqueList<TerminalListEntry, 0, { usize::MAX }>,
}

/// `terminal.open`: another shell for the session, the person's own login shell in the session's
/// tree, so the request carries no program, arguments or folder. The caller mints the key, and a
/// retry with the same key never opens a second shell.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TerminalOpenRequest {
    /// The session.
    pub session_id: SessionId,
    /// The caller's key for this open.
    pub client_idempotency_key: ClientUuid,
}

/// The new shell's id. A shell that fails to start still has one: its tab stays and its list entry
/// reads `didNotStart` with the cause.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TerminalOpenResponse {
    /// The shell.
    pub terminal_id: TerminalId,
}

/// `terminal.close`: closes one shell and ends its process; closing several sends this once per
/// shell. The daemon refuses it while a run holds the shell, and while another device holds it
/// unless `force` is true, which the screen sends only after the person confirmed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TerminalCloseRequest {
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

/// `terminal.reorder`: the session's shells in their new tab order, each named at most once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalReorderRequest {
    /// The session.
    #[garde(skip)]
    pub session_id: SessionId,
    /// The shells, in their new order.
    #[garde(dive)]
    pub terminal_ids: UniqueList<TerminalId, 1, { usize::MAX }>,
}

/// `terminal.output.subscribe`: the shell whose output the subscription streams. `afterOffset` is
/// where a watcher that reconnects got to: while that offset is still inside the scrollback window
/// it gets only the bytes after it, and a fresh `scrollback` otherwise.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TerminalOutputSubscribeRequest {
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
/// message goes on in `scrollbackContinuation` changes, each in a frame of its own, before any
/// output. `output` is what the shell wrote next, in order; `exited` is its program's end. Output
/// and scrollback travel as raw bytes, an attachment each, with no character held back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum TerminalOutputChange {
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
pub struct TerminalOutputFrame {
    /// The changes, oldest first.
    #[garde(dive)]
    pub changes: BoundedVec<TerminalOutputChange, 1, STREAM_FRAME_MAX_CHANGES>,
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

/// `terminal.write`: input for one shell, written as it arrives; the writer's connection must hold
/// the shell. The write is bound to `outputSubscriptionId`, the writing pane's own
/// output feed (`terminal.output.subscribe`) of that shell: a first write to a shell nobody holds
/// takes it through that subscription, and a holding connection's write binds it to the hold.
/// `keys` is typed text. A `paste` is pasted text sent in one or more parts, each under the wire's
/// message cap, all naming the client-minted `pasteId` and the last one `isLastPart`; when the
/// program in the shell asked for pasted text to be marked as pasted, the daemon marks the whole
/// paste once around all its parts. Each pane has one paste open at a time: a part naming a new
/// `pasteId` closes the pane's earlier paste first. Each write's `data` is at most
/// `TERMINAL_WRITE_MAX_BYTES`. The daemon answers a write once the shell's write queue takes it,
/// which it does while the queue holds less than 64 KiB, so typing into a program that is not
/// reading holds no call open and a paste past the queue's bound is paced by the shell. A write
/// takes no slot of the connection's call cap: a client keeps at most
/// `TERMINAL_WRITES_WAITING_PER_SHELL` writes per shell waiting for an answer, and the daemon
/// refuses one that finds `TERMINAL_WRITES_WAITING_LIMIT` of its connection's writes to that shell
/// waiting.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum TerminalWriteRequest {
    /// Typed text.
    Keys {
        /// The session.
        session_id: SessionId,
        /// The shell.
        terminal_id: TerminalId,
        /// The writing pane's output subscription.
        output_subscription_id: SubscriptionId,
        /// The text, at most [`TERMINAL_WRITE_MAX_BYTES`] as its JSON travels.
        #[garde(custom(|data: &String, (): &()| fits_budget(data, TERMINAL_WRITE_MAX_BYTES)))]
        #[schemars(extend("maxJsonBytes" = TERMINAL_WRITE_MAX_BYTES))]
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
        /// The part's text, at most [`TERMINAL_WRITE_MAX_BYTES`] as its JSON travels.
        #[garde(custom(|data: &String, (): &()| fits_budget(data, TERMINAL_WRITE_MAX_BYTES)))]
        #[schemars(extend("maxJsonBytes" = TERMINAL_WRITE_MAX_BYTES))]
        data: String,
        /// The paste, minted by the client.
        paste_id: ClientUuid,
        /// Whether this is the paste's last part.
        is_last_part: bool,
    },
}

/// `terminal.resize`: a shell's new size in character cells. Only a connection holding it sets it;
/// watchers follow.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TerminalResizeRequest {
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

/// `terminal.appearance.report`: the appearance the daemon answers a program's questions about
/// its terminal from, as no screen answers them. `consoleTheme` is the console theme's terminal
/// colors, which the desktop reports on connecting and at every change of appearance; it serves
/// every shell whose holder reported none. `holdingPane` is the colors and cell size of the pane
/// holding the shell, which only a connection the shell's hold is bound to may report, refused as a
/// resize from another is; it outranks the console theme until the shell changes holder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "source",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum TerminalAppearanceReportRequest {
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
    /// Every `terminal.*` method.
    pub const TERMINAL_METHOD_DESCRIPTORS = [
        /// Follows the session's shells.
        TerminalSubscribe = subscription "terminal.subscribe" {
            mutating: false,
            params: TerminalSubscribeRequest,
            result: SubscribeAcknowledgmentResponse,
            emission: TerminalListUpdate,
            refusals: [SessionNotFound],
        },
        /// Opens another shell.
        TerminalOpen = mutation "terminal.open" {
            mutating: true,
            params: TerminalOpenRequest,
            result: TerminalOpenResponse,
            refusals: [
                SessionNotFound,
                TerminalChatUnsupported,
                TerminalBackendUnavailable,
                SessionWorkingFolderMissing,
            ],
        },
        /// Closes one shell.
        TerminalClose = mutation "terminal.close" {
            mutating: true,
            params: TerminalCloseRequest,
            result: NullPayload,
            refusals: [SessionNotFound, TerminalNotFound, TerminalControlHeldByOther],
        },
        /// Reorders the session's shells.
        TerminalReorder = mutation "terminal.reorder" {
            mutating: true,
            params: TerminalReorderRequest,
            result: NullPayload,
            refusals: [SessionNotFound, TerminalNotFound],
        },
        /// Streams one shell's output.
        TerminalOutputSubscribe = subscription "terminal.output.subscribe" {
            mutating: false,
            params: TerminalOutputSubscribeRequest,
            result: SubscribeAcknowledgmentResponse,
            emission: TerminalOutputFrame,
            refusals: [SessionNotFound, TerminalNotFound],
        },
        /// Writes input to one shell.
        TerminalWrite = mutation "terminal.write" {
            mutating: true,
            params: TerminalWriteRequest,
            result: NullPayload,
            refusals: [
                SessionNotFound,
                TerminalNotFound,
                TerminalControlNotHeld,
                TerminalOutputSubscriptionNotFound,
                TerminalWriteLimitReached,
            ],
        },
        /// Resizes one shell.
        TerminalResize = mutation "terminal.resize" {
            mutating: true,
            params: TerminalResizeRequest,
            result: NullPayload,
            refusals: [
                SessionNotFound,
                TerminalNotFound,
                TerminalControlHeldByOther,
                TerminalControlNotHeld,
            ],
        },
        /// Reports the appearance a program's questions are answered from.
        TerminalAppearanceReport = mutation "terminal.appearance.report" {
            mutating: true,
            params: TerminalAppearanceReportRequest,
            result: NullPayload,
            refusals: [
                SessionNotFound,
                TerminalNotFound,
                TerminalControlHeldByOther,
                TerminalControlNotHeld,
            ],
        },
    ];
}

/// The TypeScript module of a session's shells.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "terminal",
    doc: "A session's shells as a client addresses them: the live list, opening, closing and \
          ordering, one shell's output stream, writing and resizing, terminal appearance, flow \
          control, and the per-shell control lease.",
    definitions: &[
        Definition::read::<TerminalId>().checked(),
        Definition::read::<TerminalControlHolder>().checked(),
        Definition::read::<TerminalSubscribeRequest>().checked(),
        Definition::read::<TerminalShellStatus>(),
        Definition::read::<TerminalListEntry>(),
        Definition::read::<TerminalListUpdate>().checked(),
        Definition::read::<TerminalOpenRequest>().checked(),
        Definition::read::<TerminalOpenResponse>().checked(),
        Definition::read::<TerminalCloseRequest>().checked(),
        Definition::read::<TerminalReorderRequest>().checked(),
        Definition::read::<TerminalOutputSubscribeRequest>().checked(),
        Definition::read::<TerminalOutputChange>(),
        Definition::read::<TerminalOutputFrame>().checked(),
        Definition::read::<TerminalWriteRequest>().checked(),
        Definition::read::<TerminalResizeRequest>().checked(),
        Definition::read::<TerminalColors>().checked(),
        Definition::read::<TerminalCellSize>().checked(),
        Definition::read::<TerminalAppearanceReportRequest>().checked(),
        Definition::read::<TerminalFlowControlUpdateRequest>().checked(),
        Definition::read::<TerminalFlowControlUpdateResponse>().checked(),
        Definition::read::<TerminalControlTakeRequest>().checked(),
        Definition::read::<TerminalControlTakeResponse>().checked(),
        Definition::read::<TerminalControlChangedReason>(),
        Definition::read::<TerminalControlChangedPayload>().checked(),
        Definition::read::<TerminalControlHeldByOtherDetails>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[
        &TERMINAL_METHOD_DESCRIPTORS,
        &TERMINAL_CONTROL_METHOD_DESCRIPTORS,
    ],
};

impl ListKey for TerminalListEntry {
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

    // An id carries no rule its read does not hold.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

#[cfg(test)]
mod tests {
    use garde::Validate;
    use serde_json::json;

    use super::{TERMINAL_WRITE_MAX_BYTES, TerminalWriteRequest};

    #[test]
    fn a_write_s_data_fits_its_byte_cap_as_its_json_travels_on_both_arms() {
        let write = |kind: &str, data: String| -> TerminalWriteRequest {
            let mut request = json!({
                "kind": kind,
                "sessionId": "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e",
                "terminalId": "terminal-1",
                "outputSubscriptionId": "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0001",
                "data": data,
            });
            if kind == "paste" {
                request["pasteId"] = json!("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0002");
                request["isLastPart"] = json!(true);
            }
            serde_json::from_value(request).expect("a well-formed write")
        };
        // The two quotes count toward the cap, as do an escape's extra bytes.
        let fitting = "a".repeat(TERMINAL_WRITE_MAX_BYTES - 2);
        for kind in ["keys", "paste"] {
            assert!(write(kind, fitting.clone()).validate().is_ok(), "{kind}");
            for over in [
                fitting.clone() + "a",
                "\n".repeat(TERMINAL_WRITE_MAX_BYTES / 2),
            ] {
                assert!(write(kind, over).validate().is_err(), "{kind}");
            }
        }
    }
}
