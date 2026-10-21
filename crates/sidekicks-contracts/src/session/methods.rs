//! The session read and subscribe shapes, the frame a session's stream sends, the verbs called on
//! one session (rename, archive, reactivate, close, pin, mute, restart, and the two actions of a
//! session whose history is damaged), the two searches and the read of a conversion's skipped
//! files. The events those verbs append are in `session::events`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::agent::definition::AgentId;
use crate::event::envelope::EventEnvelope;
use crate::event::version::EVENT_FIELD_MAX_LEN;
use crate::free_form_string::FilesystemPath;
use crate::jsonrpc::page::{PAGE_MAX_BYTES, fits_one_page};
use crate::jsonrpc::streaming::stream_frame;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::place::Place;
use crate::provider::account::record::ProviderAccountId;
use crate::run::id::RunId;
use crate::run::state::RunState;
use crate::session::convert::{
    SessionConversionSkippedFileListRequest, SessionConversionSkippedFileListResponse,
};
use crate::session::draft::SessionAttachmentSummary;
use crate::session::event_cursor::EventCursor;
use crate::session::id::SessionId;
use crate::session::name::SESSION_NAME_MAX_LEN;
use crate::session::search::{
    SESSION_SEARCH_HIT_LINE_MAX_LEN, SESSION_SEARCH_PAGE_LIMIT_MAX, SESSION_SEARCH_QUERY_MAX_LEN,
};
use crate::tag::TagList;
use crate::transcript::child_run_summary::ChildRunSummary;
use crate::transcript::content::{BlockCutFailure, BlockStarts, TranscriptRowContent};
use crate::transcript::row::TranscriptRunStamp;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::{BoundedInt, SafeInt, count_bound};
use crate::wire::list::{BoundedVec, ListKey, UniqueList};
use crate::wire::text::{BoundedText, FreeFormText, NulFreeText, branded_text};
use crate::wire::{False, True};

/// Where a session is in its lifecycle.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    IntoStaticStr,
    VariantArray,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum SessionState {
    /// Being made.
    Provisioning,
    /// Taking work.
    Active,
    /// Put aside; reactivated on request.
    Archived,
    /// Ended; takes no change.
    Closed,
    /// Being deleted.
    PurgeRequested,
}

/// What a session is bound to, kept as a stored fact rather than a mode flag: a `chat` works in a
/// managed workspace the daemon owns, a `project` in a repository the person attached. Converting
/// a chat changes it in place, so it is read from the session, never fixed at creation.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    IntoStaticStr,
    VariantArray,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum SessionShape {
    /// A managed workspace.
    Chat,
    /// An attached repository.
    Project,
}

/// The working-folder move a session's next run boundary applies.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SessionPendingWorkingFolder {
    /// The folder it moves to.
    pub path: FilesystemPath,
}

/// One session as `session.read` answers it. Its tags fit the shared page budget.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionRecord {
    /// The session.
    pub id: SessionId,
    /// Its lifecycle state.
    pub state: SessionState,
    /// Its shape.
    pub shape: SessionShape,
    /// Where it runs, written at its creation and never changed; absent on macOS and Linux.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
    /// Its name; absent while untitled, when a surface shows its first message.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
    pub name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// Whether the person muted its notifications.
    pub muted: bool,
    /// The move its next run boundary applies, or `null` when none waits.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<SessionPendingWorkingFolder>")]
    pub pending_working_folder: Option<SessionPendingWorkingFolder>,
    /// When it was made.
    #[garde(dive)]
    pub created_at: WireInstant,
    /// When it last changed.
    #[garde(dive)]
    pub updated_at: WireInstant,
    /// The unsent composer draft, whole; empty when none is held.
    pub draft: String,
    /// The whole staged set of files, so every device opens the same half-written message.
    pub attachments: Vec<SessionAttachmentSummary>,
    /// The session's own bound on the steps one turn may take; absent where the person set none,
    /// and the machine's Runtime value applies.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<1>")]
    pub max_steps_per_turn: Option<SafeInt<1>>,
    /// The addresses another session writes to when it messages this one: an inbox the daemon
    /// holds for it in each place where a provider that messages other sessions is installed, the
    /// session's own place first, each stable for its whole life.
    #[garde(dive)]
    pub addresses: UniqueList<SessionAddress, 1, { usize::MAX }>,
    /// Its tags as first written, in the order of their case fold.
    #[garde(dive, custom(fits_one_page))]
    #[schemars(extend("maxJsonBytes" = PAGE_MAX_BYTES))]
    pub tags: TagList,
}

/// One inbox the daemon holds for a session, in one place. A computer without a WSL 2
/// distribution holds one, which names no place.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAddress {
    /// The place.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
    /// The inbox's address, in that place's own form.
    pub address: FilesystemPath,
}

impl ListKey for SessionAddress {
    type Key = Option<Place>;

    fn list_key(&self) -> Option<Place> {
        self.place.clone()
    }

    // An address carries no rule its read does not hold.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

/// The session `session.read` answers with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionReadRequest {
    /// The session.
    pub session_id: SessionId,
}

/// One run of the session not yet ended, as the daemon's run record holds it now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionLiveRun {
    /// The run.
    pub run_id: RunId,
    /// The run that started it; absent on a lead run.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunId")]
    pub parent_run_id: Option<RunId>,
    /// Present on a run whose turn runs in a process of its own, which is never the lead run.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "True")]
    pub is_apart: Option<True>,
    /// Its state now.
    pub state: RunState,
    /// Its record's version.
    pub run_version: SafeInt<0>,
    /// The agent the run was created for, as its `agent.run.queued` names it.
    pub agent_id: AgentId,
    /// Who the run's first event naming anyone names, as sent; absent while none has.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<EVENT_FIELD_MAX_LEN>")]
    pub actor: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The account the run was admitted under, as its creation named it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderAccountId")]
    pub admitted_provider_account_id: Option<ProviderAccountId>,
    /// When the run's newest `runLifecycle` event occurred.
    #[garde(dive)]
    pub touched_at: WireInstant,
}

/// One event of the session's log a `session.read` carries whole, at the position the stream
/// delivers it at.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionStandingEvent {
    /// Its position.
    pub cursor: EventCursor,
    /// The event.
    #[garde(dive)]
    pub event: EventEnvelope,
}

/// A session's transcript cursors.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SessionTranscriptCursors {
    /// The position just before the oldest surviving event, so a read after it misses none.
    pub earliest: EventCursor,
    /// The newest position.
    pub latest: EventCursor,
}

/// The `session.read` result: the session, its transcript cursors, its runs not yet ended and its
/// standing events. A reader opens its window at `latest`; the live runs and the standing events
/// give it what the events above that window settled.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionReadResponse {
    /// The session.
    #[garde(dive)]
    pub session: SessionRecord,
    /// Its transcript cursors.
    pub transcript_cursors: SessionTranscriptCursors,
    /// Every run not yet ended, with the state it is in now, so a window opened below a run's
    /// earlier events still knows whether that run is working or waiting.
    #[garde(dive)]
    pub live_runs: Vec<SessionLiveRun>,
    /// The newest event of each kind a reader keeps a standing fact from, in sequence order, so a
    /// window opened below them still reads those facts.
    #[garde(dive)]
    pub standing_events: Vec<SessionStandingEvent>,
}

/// The `session.event.subscribe` input: the session to follow and an `afterCursor` to catch up
/// from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionEventSubscribeRequest {
    /// The session.
    pub session_id: SessionId,
    /// Catch up from after this position.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "EventCursor")]
    pub after_cursor: Option<EventCursor>,
}

/// One change on a session's stream: an event of the session's log, the cursor it sits at and,
/// exactly when the event belongs to a run, the daemon's run stamp for it. A piece of a reply or of
/// reasoning also carries its text and its place in its row; a child run's event carries the
/// child's summary; and a change that ends rows carries the rest of their block starts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionStreamChange {
    /// The event's position.
    pub cursor: EventCursor,
    /// The event, as its envelope, so a type this reader does not know still parses.
    #[garde(dive)]
    pub event: EventEnvelope,
    /// The run stamp; absent on a session-level event.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "TranscriptRunStamp")]
    #[garde(dive)]
    pub run_stamp: Option<TranscriptRunStamp>,
    /// On a piece of a reply or of reasoning: its text and where it sits in its row.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionStreamPiece")]
    #[garde(dive)]
    pub piece: Option<SessionStreamPiece>,
    /// On an event of a child run: the child's summary as of this event.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ChildRunSummary")]
    #[garde(dive)]
    pub child_run_summary: Option<ChildRunSummary>,
    /// The rows this event ends, each with the block starts it had not yet sent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "BoundedVec<SessionStreamEndedRow, 1, { usize::MAX }>")]
    pub ended_rows: Option<BoundedVec<SessionStreamEndedRow, 1, { usize::MAX }>>,
}

/// One piece of a reply or of reasoning on the stream: the row it joins, where its text starts in
/// that row's whole body, its text, and the block starts the row froze with it. A reader places a
/// piece it already read in a row by its offset, so a piece the stream and a read both carry is
/// never drawn twice.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionStreamPiece {
    /// The row: the id of its first event, which a read and `transcript.body.read` name it by.
    pub row_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// Where the piece's text starts in the row's whole body, as a UTF-8 byte offset.
    pub offset: SafeInt<0>,
    /// The piece's text, or its size alone when it is too large to travel inline.
    #[garde(dive)]
    pub content: TranscriptRowContent,
    /// The row's block starts this piece froze, as UTF-16 offsets into the row's whole drawn
    /// body; a frozen start never moves.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "BlockStarts")]
    pub block_starts: Option<BlockStarts>,
    /// Why the row's cut failed with this piece, after which its later pieces carry no starts.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "BlockCutFailure")]
    pub block_cut_failure: Option<BlockCutFailure>,
}

/// A row an event ended, with the block starts its last pieces left unsent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionStreamEndedRow {
    /// The row: the id of its first event.
    pub row_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// The rest of its block starts, as UTF-16 offsets into its whole drawn body; absent when
    /// none.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "BlockStarts")]
    pub block_starts: Option<BlockStarts>,
    /// Why the cut of its last text failed; never beside starts.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "BlockCutFailure")]
    pub block_cut_failure: Option<BlockCutFailure>,
}

stream_frame! {
    /// The value of each `session.event.subscribe` notify: the changes since the previous frame.
    pub struct SessionStreamFrame(SessionStreamChange);
}

/// The request of every verb that acts on one session and takes nothing else.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionTargetRequest {
    /// The session.
    pub session_id: SessionId,
}

/// The `session.rename` input. `null` clears the name, and the session reads as untitled again.
/// Renaming never renames the session's branch or worktree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionRenameRequest {
    /// The session.
    pub session_id: SessionId,
    /// The new name, or `null` to clear it.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<FreeFormText<SESSION_NAME_MAX_LEN>>")]
    pub name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
}

/// The `session.rename` result: the name the session now holds, `null` when untitled.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionRenameResponse {
    /// The session.
    pub session_id: SessionId,
    /// The name, or `null`.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<FreeFormText<SESSION_NAME_MAX_LEN>>")]
    pub name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
}

/// The longest `session.search` cursor accepted; a guard against pathological lengths.
const SESSION_SEARCH_CURSOR_MAX_LEN: usize = 256;

branded_text! {
    /// Where the next `session.search` page starts. The daemon writes it and owns its format; a
    /// client passes it back unchanged with the same query. A cursor of a search the daemon has
    /// let go is refused, and the client searches again.
    pub struct SessionSearchCursor(1..=SESSION_SEARCH_CURSOR_MAX_LEN);
}

/// A list of at least one item, bounded only by the message cap.
type NonEmptyList<T> = BoundedVec<T, 1, { usize::MAX }>;

/// How many hits one `session.search` page may carry: 1 to [`SESSION_SEARCH_PAGE_LIMIT_MAX`].
pub type SessionSearchLimit = BoundedInt<1, { count_bound(SESSION_SEARCH_PAGE_LIMIT_MAX) }>;

/// The `session.search` input: the text typed in the search box and, past the first page, the
/// previous page's `nextCursor`. The daemon matches it against every session's title, message
/// text, tool calls, group name and tags, archived sessions included.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionSearchRequest {
    /// The text to find.
    pub query: FreeFormText<SESSION_SEARCH_QUERY_MAX_LEN>,
    /// Continue from this cursor.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionSearchCursor")]
    pub after_cursor: Option<SessionSearchCursor>,
    /// The most hits on one page; the default is the most.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionSearchLimit")]
    pub limit: Option<SessionSearchLimit>,
}

/// A matched stretch of a search hit's text, in UTF-16 code units: `start` inclusive, `end`
/// exclusive, ending after it starts.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SearchMatchRange {
    /// The first unit matched.
    pub start: SafeInt<0>,
    /// The unit after the last matched.
    #[garde(custom(|end: &SafeInt<1>, (): &()| {
        if end.get() > self.start.get() {
            Ok(())
        } else {
            Err(garde::Error::new("a match range ends after it starts"))
        }
    }))]
    #[schemars(extend("exclusiveMinimum" = { "$data": "1/start" }))]
    pub end: SafeInt<1>,
}

/// Refuses a range that starts before the one before it ends or ends past `text`, both in UTF-16
/// code units, so a hit's ranges run in order, never overlap, and sit inside the text they mark.
pub fn require_match_ranges_in_order_within(
    text: &str,
    match_ranges: &[SearchMatchRange],
) -> garde::Result {
    let text_length = text.encode_utf16().count() as u64;
    let mut previous_end = 0;
    for (index, range) in match_ranges.iter().enumerate() {
        if range.start.get() < previous_end || range.end.get() > text_length {
            return Err(garde::Error::new(format!(
                "match range {index} is out of order, overlaps the one before it, or ends past \
                 the text it marks"
            )));
        }
        previous_end = range.end.get();
    }
    Ok(())
}

/// One hit: the line of the message the match sits in, the matched stretches to mark, and the
/// message's cursor, which lands the transcript on it and loads whatever history that takes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionSearchHit {
    /// The message's position.
    pub cursor: EventCursor,
    /// The line the match sits in.
    pub line: BoundedText<0, SESSION_SEARCH_HIT_LINE_MAX_LEN>,
    /// The matched stretches.
    #[garde(dive)]
    #[garde(custom(|match_ranges: &NonEmptyList<SearchMatchRange>, (): &()| {
        require_match_ranges_in_order_within(self.line.as_str(), match_ranges.as_slice())
    }))]
    pub match_ranges: NonEmptyList<SearchMatchRange>,
}

/// The hits in one session, under that session's name; an untitled session has no `name`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionSearchGroup {
    /// The session.
    pub session_id: SessionId,
    /// Its name.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
    pub name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// Its hits, best first.
    #[garde(dive)]
    pub hits: NonEmptyList<SessionSearchHit>,
}

/// Holds a search page to at most [`SESSION_SEARCH_PAGE_LIMIT_MAX`] hits across its groups and to
/// the page budget.
fn require_search_page(groups: &[SessionSearchGroup]) -> garde::Result {
    let hit_count: usize = groups.iter().map(|group| group.hits.as_slice().len()).sum();
    if hit_count > SESSION_SEARCH_PAGE_LIMIT_MAX {
        return Err(garde::Error::new(format!(
            "a page carries at most {SESSION_SEARCH_PAGE_LIMIT_MAX} hits"
        )));
    }
    fits_one_page(&groups, &())
}

/// A search page with more after it: at least one group, and the cursor to continue from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct SessionSearchContinuing {
    /// The hits grouped by session, sessions in the order of their best hit.
    #[garde(dive)]
    #[garde(custom(|groups: &NonEmptyList<SessionSearchGroup>, (): &()| {
        require_search_page(groups.as_slice())
    }))]
    #[schemars(extend("maxJsonBytes" = PAGE_MAX_BYTES))]
    pub groups: NonEmptyList<SessionSearchGroup>,
    /// More hits follow.
    pub has_more: True,
    /// Where to continue.
    pub next_cursor: SessionSearchCursor,
}

/// The last search page, possibly empty.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct SessionSearchTerminal {
    /// The hits grouped by session, sessions in the order of their best hit.
    #[garde(dive)]
    #[garde(custom(|groups: &Vec<SessionSearchGroup>, (): &()| require_search_page(groups)))]
    #[schemars(extend("maxJsonBytes" = PAGE_MAX_BYTES))]
    pub groups: Vec<SessionSearchGroup>,
    /// No hits follow.
    pub has_more: False,
}

/// One `session.search` page: hits grouped by session, each session's hits best first. A
/// session's hits stay on one page unless they alone overflow it; then the next page continues
/// that session under the same `sessionId`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum SessionSearchResponse {
    /// More hits follow.
    Continuing(#[garde(dive)] SessionSearchContinuing),
    /// The last page.
    Terminal(#[garde(dive)] SessionSearchTerminal),
}

/// The `session.file.search` input: the text typed after `@` in a session's draft. An empty query
/// lists the working folder's files and folders; the list narrows as the name is typed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionFileSearchRequest {
    /// The session.
    pub session_id: SessionId,
    /// The text typed.
    pub query: NulFreeText<SESSION_SEARCH_QUERY_MAX_LEN>,
}

/// What a `session.file.search` row names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, IntoStaticStr)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum SessionFileSearchEntryKind {
    /// A file.
    File,
    /// A folder.
    Folder,
}

/// One `session.file.search` row: a path relative to the working folder, and whether it names a
/// file or a folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionFileSearchEntry {
    /// The path, relative to the working folder.
    pub path: FilesystemPath,
    /// What it names.
    pub kind: SessionFileSearchEntryKind,
}

/// The `session.file.search` result: the matching files and folders, each path relative to the
/// working folder, best first, and how many files the query was matched against, never fewer than
/// the files it matched. A search that failed is an error, never an empty result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionFileSearchResponse {
    /// The files and folders, best first.
    #[garde(custom(|entries: &Vec<SessionFileSearchEntry>, (): &()| {
        let file_count = entries
            .iter()
            .filter(|entry| entry.kind == SessionFileSearchEntryKind::File)
            .count();
        if u64::try_from(file_count).is_ok_and(|count| count <= self.searched_file_count.get()) {
            Ok(())
        } else {
            Err(garde::Error::new("a file search cannot match more files than it searched"))
        }
    }))]
    pub entries: Vec<SessionFileSearchEntry>,
    /// How many files the query was matched against.
    pub searched_file_count: SafeInt<0>,
}

methods! {
    /// The `session.*` methods on one session, its searches and its conversion's skipped files.
    pub const SESSION_METHOD_DESCRIPTORS = [
        /// Reads one session.
        SessionRead = query "session.read" {
            mutating: false,
            params: SessionReadRequest,
            result: SessionReadResponse,
            refusals: [SessionNotFound],
        },
        /// Renames a session, or clears its name.
        SessionRename = mutation "session.rename" {
            mutating: true,
            params: SessionRenameRequest,
            result: SessionRenameResponse,
            refusals: [SessionNotFound, SessionAlreadyClosed, SessionChangeRefused],
        },
        /// Archives a session.
        SessionArchive = mutation "session.archive" {
            mutating: true,
            params: SessionTargetRequest,
            result: EmptyPayload,
            refusals: [SessionNotFound, SessionAlreadyClosed, SessionChangeRefused],
        },
        /// Brings an archived session back.
        SessionReactivate = mutation "session.reactivate" {
            mutating: true,
            params: SessionTargetRequest,
            result: EmptyPayload,
            refusals: [SessionNotFound, SessionAlreadyClosed, SessionChangeRefused],
        },
        /// Closes a session.
        SessionClose = mutation "session.close" {
            mutating: true,
            params: SessionTargetRequest,
            result: EmptyPayload,
            refusals: [
                SessionNotFound,
                SessionAlreadyClosed,
                SessionChangeRefused,
                ProviderUnavailable,
                ProviderNotFound,
            ],
        },
        /// Pins a session.
        SessionPin = mutation "session.pin" {
            mutating: true,
            params: SessionTargetRequest,
            result: EmptyPayload,
            refusals: [SessionNotFound, SessionAlreadyClosed, SessionChangeRefused],
        },
        /// Unpins a session.
        SessionUnpin = mutation "session.unpin" {
            mutating: true,
            params: SessionTargetRequest,
            result: EmptyPayload,
            refusals: [SessionNotFound, SessionAlreadyClosed, SessionChangeRefused],
        },
        /// Mutes a session's notifications.
        SessionMute = mutation "session.mute" {
            mutating: true,
            params: SessionTargetRequest,
            result: EmptyPayload,
            refusals: [SessionNotFound, SessionAlreadyClosed, SessionChangeRefused],
        },
        /// Unmutes a session's notifications.
        SessionUnmute = mutation "session.unmute" {
            mutating: true,
            params: SessionTargetRequest,
            result: EmptyPayload,
            refusals: [SessionNotFound, SessionAlreadyClosed, SessionChangeRefused],
        },
        /// Restarts a session's provider.
        SessionRestart = mutation "session.restart" {
            mutating: true,
            params: SessionTargetRequest,
            result: EmptyPayload,
            refusals: [
                SessionNotFound,
                ProviderNotFound,
                ProviderUnavailable,
                ProviderCapabilityUnsupported,
                ProviderAccountNotAuthenticated,
            ],
        },
        /// `Continue from here`: the session's last good point becomes its end, its damaged events
        /// are skipped from then on, and it takes new work again.
        SessionRecoveryContinue = mutation "session.recovery.continue" {
            mutating: true,
            params: SessionTargetRequest,
            result: EmptyPayload,
            refusals: [SessionNotFound, SessionRecoveryRefused],
        },
        /// `Delete session` on a session whose history is damaged: every row of it goes, the copy
        /// set aside before the repair stays.
        SessionRecoveryDelete = mutation "session.recovery.delete" {
            mutating: true,
            params: SessionTargetRequest,
            result: EmptyPayload,
            refusals: [SessionNotFound, SessionRecoveryRefused],
        },
        /// Searches every session.
        SessionSearch = query "session.search" {
            mutating: false,
            params: SessionSearchRequest,
            result: SessionSearchResponse,
            refusals: [SessionSearchCursorUnresolvable],
        },
        /// Lists a session's working-folder files and folders matching what was typed after `@`.
        SessionFileSearch = query "session.file.search" {
            mutating: false,
            params: SessionFileSearchRequest,
            result: SessionFileSearchResponse,
            refusals: [SessionNotFound, SessionWorkingFolderMissing],
        },
        /// Reads the files a conversion did not copy, page by page.
        SessionConversionSkippedFileList = query "session.conversion.skippedFile.list" {
            mutating: false,
            params: SessionConversionSkippedFileListRequest,
            result: SessionConversionSkippedFileListResponse,
            refusals: [SessionNotFound],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/methods",
    doc: "The session read and subscribe shapes, the frame a session's stream sends, the verbs \
          called on one session, the two searches and the read of a conversion's skipped files.",
    definitions: &[
        Definition::read::<SessionState>().checked(),
        Definition::read::<SessionShape>().checked(),
        Definition::read::<SessionAddress>(),
        Definition::read::<SessionRecord>().checked(),
        Definition::read::<SessionReadRequest>().checked(),
        Definition::read::<SessionLiveRun>(),
        Definition::read::<SessionStandingEvent>(),
        Definition::read::<SessionReadResponse>().checked(),
        Definition::read::<SessionEventSubscribeRequest>().checked(),
        Definition::read::<SessionStreamPiece>().checked(),
        Definition::read::<SessionStreamEndedRow>(),
        Definition::read::<SessionStreamChange>(),
        Definition::read::<SessionStreamFrame>().checked(),
        Definition::read::<SessionTargetRequest>().checked(),
        Definition::read::<SessionRenameRequest>().checked(),
        Definition::read::<SessionRenameResponse>().checked(),
        Definition::read::<SessionSearchCursor>(),
        Definition::read::<SessionSearchRequest>().checked(),
        Definition::read::<SearchMatchRange>().checked(),
        Definition::read::<SessionSearchHit>(),
        Definition::read::<SessionSearchGroup>(),
        Definition::read::<SessionSearchResponse>().checked(),
        Definition::read::<SessionFileSearchRequest>().checked(),
        Definition::read::<SessionFileSearchEntryKind>(),
        Definition::read::<SessionFileSearchEntry>(),
        Definition::read::<SessionFileSearchResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[&SESSION_METHOD_DESCRIPTORS],
};
