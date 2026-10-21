//! The paged transcript reads: `transcript.read`, the reasoning read and the child-run expansion,
//! each page held to the shared page budget. A continuing page carries at least one entry and the
//! cursor to continue from; a terminal page may be empty and may still say where the window ended,
//! which a client needs to open the live stream from exactly there. The reasoning read names no
//! principal: the caller is the authenticated connection.

use std::collections::HashSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::event::version::EVENT_FIELD_MAX_LEN;
use crate::jsonrpc::byte_length::{fits_budget, json_utf8_byte_length};
use crate::jsonrpc::page::{PAGE_MAX_BYTES, fits_one_page};
use crate::run::id::RunId;
use crate::run::state::RunState;
use crate::session::event_cursor::EventCursor;
use crate::session::id::SessionId;
use crate::transcript::child_run_summary::refuse_self_parenting_run;
use crate::transcript::content::{
    TranscriptBodyReadRequest, TranscriptBodyReadResponse, TranscriptPatchCursor,
    TranscriptPatchFile, TranscriptPatchListRequest, TranscriptPatchListResponse,
};
use crate::transcript::limits::TRANSCRIPT_READ_LIMIT_MAX;
use crate::transcript::row::TranscriptReadRow;
use crate::transcript::run_facts::{
    RUN_STATE_EVENT_TYPES, RunStateEventType, TranscriptRunFacts, USER_MESSAGE_EVENT_TYPE,
};
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::{BoundedInt, SafeInt, count_bound};
use crate::wire::list::BoundedVec;
use crate::wire::text::{BoundedText, FreeFormText};
use crate::wire::{False, True, literal};

/// Refuses entries that go backwards in sequence: a page runs oldest to newest, nondecreasing.
fn require_nondecreasing_sequence<T>(
    entries: &[T],
    sequence_of: impl Fn(&T) -> u64,
) -> garde::Result {
    for (index, pair) in entries.windows(2).enumerate() {
        let (previous, current) = (sequence_of(&pair[0]), sequence_of(&pair[1]));
        if current < previous {
            return Err(garde::Error::new(format!(
                "entries run oldest to newest: entry {} goes back in sequence, so this page is \
                 out of order",
                index + 1
            )));
        }
    }
    Ok(())
}

/// Holds a window's rows: they run oldest to newest and fit the page budget left beside `runs`,
/// which rides in the same frame.
fn require_window_rows(
    entries: &[TranscriptReadRow],
    runs: &[TranscriptRunFacts],
) -> garde::Result {
    let runs_bytes = json_utf8_byte_length(&runs)
        // serde's message can quote a value, so the failure is named, never carried.
        .map_err(|_unquoted| garde::Error::new("the runs do not serialize as JSON"))?;
    fits_budget(&entries, PAGE_MAX_BYTES.saturating_sub(runs_bytes))?;
    require_nondecreasing_sequence(entries, |entry| entry.sequence().get())
}

/// Holds `runs` to one fact per run the entries name and no other: a run named twice leaves a
/// client to choose, a fact no entry names is a run the window never shows, and an entry whose run
/// has none would draw its header from nothing.
fn require_one_fact_per_named_run(
    runs: &[TranscriptRunFacts],
    entries: &[TranscriptReadRow],
) -> garde::Result {
    let named_run_ids: HashSet<&RunId> = entries
        .iter()
        .filter_map(TranscriptReadRow::run_id)
        .collect();
    let mut fact_run_ids = HashSet::new();
    for facts in runs {
        if !fact_run_ids.insert(&facts.run_id) {
            return Err(garde::Error::new("runs names one run twice"));
        }
        if !named_run_ids.contains(&facts.run_id) {
            return Err(garde::Error::new("runs carries a run no entry names"));
        }
    }
    if entries
        .iter()
        .filter_map(TranscriptReadRow::run_id)
        .any(|run_id| !fact_run_ids.contains(run_id))
    {
        return Err(garde::Error::new(
            "an entry names a run that runs carries no facts for",
        ));
    }
    Ok(())
}

/// Holds an expansion to its own run: a row attributed to another run would render as this run's
/// activity. A `general` row carries no run and rides as context, and a child of this run is
/// drawn as a child: its summarized row, which names this run as its parent.
fn require_entries_to_belong_to_run(
    run_id: &RunId,
    entries: &[TranscriptReadRow],
) -> garde::Result {
    let is_own_child_row = |entry: &TranscriptReadRow| {
        entry
            .child_run_summary()
            .is_some_and(|summary| summary.parent_run_id == *run_id)
    };
    if entries.iter().any(|entry| {
        entry.run_id().is_some_and(|named| named != run_id) && !is_own_child_row(entry)
    }) {
        return Err(garde::Error::new(
            "a child-run expansion carries only that run's rows and its children's summarized \
             rows, and an entry names another run",
        ));
    }
    Ok(())
}

/// How many rows a read may ask for: 1 to [`TRANSCRIPT_READ_LIMIT_MAX`].
pub type TranscriptReadLimit = BoundedInt<1, { count_bound(TRANSCRIPT_READ_LIMIT_MAX) }>;

/// Refuses an anchored read that also names `afterCursor` or `beforeCursor`: the anchor alone
/// decides where its window stands.
fn require_anchor_alone(
    around_cursor: Option<&EventCursor>,
    after_cursor: Option<&EventCursor>,
    before_cursor: Option<&EventCursor>,
) -> garde::Result {
    if around_cursor.is_some() && (after_cursor.is_some() || before_cursor.is_some()) {
        return Err(garde::Error::new(
            "aroundCursor stands alone: a read anchored at one row names no afterCursor or \
             beforeCursor",
        ));
    }
    Ok(())
}

/// A bounded read window over one session's transcript. A cursor is a position in the log, and
/// the cursor an event carries is the position right after it: `afterCursor` answers the events
/// after its position and `beforeCursor` those before it, so a page before a window's head and the
/// stream after it meet with nothing missed or repeated. `aroundCursor` names one row by its cursor
/// and answers the window around it, that row always among the entries, or refuses the read with
/// `transcript.row.notFound` when no row stands there; its page continues as a `beforeCursor`
/// page does, `nextCursor` toward the start, and the rows after it are read from its newest row's
/// cursor.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TranscriptReadRequest {
    /// The session.
    pub session_id: SessionId,
    /// Answer the events after this position.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "EventCursor")]
    pub after_cursor: Option<EventCursor>,
    /// Answer the events before this position.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "EventCursor")]
    pub before_cursor: Option<EventCursor>,
    /// Answer the window around the row at this cursor, refused when no row stands there.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "EventCursor")]
    #[garde(custom(|around_cursor: &Option<EventCursor>, (): &()| {
        require_anchor_alone(
            around_cursor.as_ref(),
            self.after_cursor.as_ref(),
            self.before_cursor.as_ref(),
        )
    }))]
    pub around_cursor: Option<EventCursor>,
    /// The most rows to answer.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "TranscriptReadLimit")]
    pub limit: Option<TranscriptReadLimit>,
}

/// A page's rows, `MIN` to [`TRANSCRIPT_READ_LIMIT_MAX`] of them.
pub type ReadEntries<const MIN: usize> =
    BoundedVec<TranscriptReadRow, MIN, TRANSCRIPT_READ_LIMIT_MAX>;

/// The facts of a window's runs, at most one per row.
pub type WindowRunFacts = BoundedVec<TranscriptRunFacts, 0, TRANSCRIPT_READ_LIMIT_MAX>;

/// A read window with more after it: at least one row, and the cursor to continue from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct TranscriptReadContinuing {
    /// The rows, oldest first, within the page budget the runs leave.
    #[garde(dive)]
    #[garde(custom(|entries: &ReadEntries<1>, (): &()| {
        require_window_rows(entries.as_slice(), self.runs.as_slice())
    }))]
    pub entries: ReadEntries<1>,
    /// The facts of each run the entries name, folded over the whole log, one per run.
    #[garde(custom(|runs: &WindowRunFacts, (): &()| {
        require_one_fact_per_named_run(runs.as_slice(), self.entries.as_slice())
    }))]
    pub runs: WindowRunFacts,
    /// More rows follow.
    pub has_more: True,
    /// Where to continue.
    pub next_cursor: EventCursor,
    /// The newest event the page's rows joined their pieces through. A reader opens its stream at
    /// the earliest page's, so a piece stored after it reaches the reader on the stream, placed in
    /// its row by its offset.
    pub joined_through: EventCursor,
}

/// The last read window: possibly empty, and possibly saying where the window ended.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct TranscriptReadTerminal {
    /// The rows, oldest first, within the page budget the runs leave.
    #[garde(dive)]
    #[garde(custom(|entries: &ReadEntries<0>, (): &()| {
        require_window_rows(entries.as_slice(), self.runs.as_slice())
    }))]
    pub entries: ReadEntries<0>,
    /// The facts of each run the entries name, folded over the whole log, one per run.
    #[garde(custom(|runs: &WindowRunFacts, (): &()| {
        require_one_fact_per_named_run(runs.as_slice(), self.entries.as_slice())
    }))]
    pub runs: WindowRunFacts,
    /// No rows follow.
    pub has_more: False,
    /// Where the window ended.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "EventCursor")]
    pub next_cursor: Option<EventCursor>,
    /// The newest event the page's rows joined their pieces through; absent on a session with no
    /// readable event.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "EventCursor")]
    pub joined_through: Option<EventCursor>,
}

/// One read window, split on `hasMore`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum TranscriptReadResponse {
    /// More rows follow.
    Continuing(#[garde(dive)] TranscriptReadContinuing),
    /// The last window.
    Terminal(#[garde(dive)] TranscriptReadTerminal),
}

ts_constants! {
    /// The most entries one reasoning page carries. Durable reasoning is summary-first, so a reply
    /// needing more has stopped being a summary.
    pub const REASONING_SURFACE_ENTRIES_MAX: usize = 256;
    /// The longest one reasoning entry's `content`, in code points.
    pub const REASONING_ENTRY_CONTENT_MAX_LEN: usize = 16_384;
    /// Every `agent.run.<state>` event type, in the order the states are declared.
    RUN_STATE_EVENT_TYPES = RUN_STATE_EVENT_TYPES;
    /// The type of a person's message, which is never a run's own event even when it steers one.
    USER_MESSAGE_EVENT_TYPE = USER_MESSAGE_EVENT_TYPE;
}

/// A run's reasoning, from `afterCursor` when continuing. The cursor is an event position, since a
/// reasoning entry is projected from the run's events.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TranscriptReasoningReadRequest {
    /// The run.
    pub run_id: RunId,
    /// Continue after this position.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "EventCursor")]
    pub after_cursor: Option<EventCursor>,
}

/// One reasoning entry: consecutive pieces of one reasoning row, joined, up to one entry's cap. A
/// text longer than that spans consecutive entries of the same row, which a reader joins.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ReasoningEntry {
    /// The sequence of the last event it holds, so a page continues exactly after it.
    pub sequence: SafeInt<0>,
    /// The row it belongs to: the id of the row's first event.
    pub row_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// The reasoning text, whitespace kept as the provider sent it.
    pub content: BoundedText<1, REASONING_ENTRY_CONTENT_MAX_LEN>,
    /// When it was produced.
    #[garde(dive)]
    pub timestamp: WireInstant,
}

literal! {
    /// The `available` word of a reasoning reply.
    pub enum ReasoningAvailable = "available";

    /// The `unavailable` word of a reasoning reply.
    pub enum ReasoningUnavailable = "unavailable";
}

/// Holds a reasoning page to the page budget and to sequence order.
fn require_reasoning_page(entries: &[ReasoningEntry]) -> garde::Result {
    fits_one_page(&entries, &())?;
    require_nondecreasing_sequence(entries, |entry| entry.sequence.get())
}

/// A reasoning page's entries, `MIN` to [`REASONING_SURFACE_ENTRIES_MAX`] of them.
pub type ReasoningEntries<const MIN: usize> =
    BoundedVec<ReasoningEntry, MIN, REASONING_SURFACE_ENTRIES_MAX>;

/// A reasoning page with more after it: at least one entry, and the cursor to continue from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct ReasoningSurfaceContinuing {
    /// The reasoning is readable.
    pub availability: ReasoningAvailable,
    /// The entries, oldest first.
    #[garde(dive)]
    #[garde(custom(|entries: &ReasoningEntries<1>, (): &()| {
        require_reasoning_page(entries.as_slice())
    }))]
    #[schemars(extend("maxJsonBytes" = PAGE_MAX_BYTES))]
    pub reasoning_entries: ReasoningEntries<1>,
    /// More entries follow.
    pub has_more: True,
    /// Where to continue.
    pub next_cursor: EventCursor,
}

/// The last reasoning page. It may be empty: a caller re-asking from the end has reached the end
/// of something that exists, which is not `unavailable`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct ReasoningSurfaceTerminal {
    /// The reasoning is readable.
    pub availability: ReasoningAvailable,
    /// The entries, oldest first.
    #[garde(dive)]
    #[garde(custom(|entries: &ReasoningEntries<0>, (): &()| {
        require_reasoning_page(entries.as_slice())
    }))]
    #[schemars(extend("maxJsonBytes" = PAGE_MAX_BYTES))]
    pub reasoning_entries: ReasoningEntries<0>,
    /// No entries follow.
    pub has_more: False,
    /// Where the page ended.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "EventCursor")]
    pub next_cursor: Option<EventCursor>,
}

/// The run has no readable reasoning.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct ReasoningSurfaceUnavailable {
    /// The reasoning is not readable.
    pub availability: ReasoningUnavailable,
}

/// The reasoning reply: an `available` page, continuing or last, or `unavailable`, which carries
/// neither entries nor a cursor.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum TranscriptReasoningReadResponse {
    /// More entries follow.
    Continuing(#[garde(dive)] ReasoningSurfaceContinuing),
    /// The last page.
    Terminal(#[garde(dive)] ReasoningSurfaceTerminal),
    /// No reasoning.
    Unavailable(#[garde(dive)] ReasoningSurfaceUnavailable),
}

/// Expands one summarized child-run row into its own rows, continuing from `afterCursor` when the
/// previous expansion did not reach the end.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TranscriptChildRunExpandRequest {
    /// The child run.
    pub run_id: RunId,
    /// Continue after this position.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "EventCursor")]
    pub after_cursor: Option<EventCursor>,
}

/// Holds an expansion's rows to the page budget, to sequence order and to its own run.
fn require_expansion_rows(run_id: &RunId, entries: &[TranscriptReadRow]) -> garde::Result {
    fits_one_page(&entries, &())?;
    require_nondecreasing_sequence(entries, |entry| entry.sequence().get())?;
    require_entries_to_belong_to_run(run_id, entries)
}

/// Declares one arm of the child-run expansion, the members both arms share written once.
macro_rules! child_run_expand_arm {
    (
        $(#[doc = $doc:literal])+
        $name:ident {
            entries: $min:literal,
            $($arm_member:tt)*
        }
    ) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            /// The child run.
            pub run_id: RunId,
            /// The run that started it; never the child itself.
            #[garde(custom(|parent_run_id: &RunId, (): &()| {
                refuse_self_parenting_run(&self.run_id, parent_run_id)
            }))]
            #[schemars(extend("type" = "string", "not" = { "const": { "$data": "1/runId" } }))]
            pub parent_run_id: RunId,
            /// The child's state.
            pub state: RunState,
            /// The run's rows, oldest first, each with its body.
            #[garde(dive)]
            #[garde(custom(|entries: &ReadEntries<$min>, (): &()| {
                require_expansion_rows(&self.run_id, entries.as_slice())
            }))]
            #[schemars(extend("maxJsonBytes" = PAGE_MAX_BYTES, "not" = { "contains": {
                "type": "object",
                "properties": { "runId": { "not": { "const": { "$data": "3/runId" } } } },
                "required": ["runId"],
                "not": {
                    "type": "object",
                    "properties": { "childRunSummary": {
                        "type": "object",
                        "properties": { "parentRunId": { "const": { "$data": "4/runId" } } },
                        "required": ["parentRunId"],
                    } },
                    "required": ["childRunSummary"],
                },
            } }))]
            pub entries: ReadEntries<$min>,
            $($arm_member)*
        }
    };
}

child_run_expand_arm! {
    /// An expansion with more after it: at least one row, and the cursor to continue from.
    TranscriptChildRunExpandContinuing {
        entries: 1,
        /// More rows follow.
        pub has_more: True,
        /// Where to continue.
        pub next_cursor: EventCursor,
        /// The newest event the page's rows joined their pieces through.
        pub joined_through: EventCursor,
    }
}

child_run_expand_arm! {
    /// The last expansion page: possibly empty, and possibly saying where it ended.
    TranscriptChildRunExpandTerminal {
        entries: 0,
        /// No rows follow.
        pub has_more: False,
        /// Where the expansion ended.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "EventCursor")]
        pub next_cursor: Option<EventCursor>,
        /// The newest event the page's rows joined their pieces through; absent on a session with
        /// no readable event.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "EventCursor")]
        pub joined_through: Option<EventCursor>,
    }
}

/// The expansion, split on `hasMore` like the read window: a long-running child run can produce
/// more rows than fit one frame.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum TranscriptChildRunExpandResponse {
    /// More rows follow.
    Continuing(#[garde(dive)] TranscriptChildRunExpandContinuing),
    /// The last page.
    Terminal(#[garde(dive)] TranscriptChildRunExpandTerminal),
}

/// The module's TypeScript face: the transcript reads, and the run facts a window serves, whose
/// reader is hand-written.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "transcript/operations",
    doc: "The transcript reads: `transcript.read`, the reasoning read and the child-run \
          expansion, each page held to the shared page budget; the run facts a window serves; and \
          the reads of a row's large body and of a tool call's left-out patches.",
    definitions: &[
        Definition::read::<RunStateEventType>().checked(),
        Definition::read::<TranscriptRunFacts>().checked(),
        Definition::read::<TranscriptBodyReadRequest>().checked(),
        Definition::read::<TranscriptBodyReadResponse>().checked(),
        Definition::read::<TranscriptPatchCursor>(),
        Definition::read::<TranscriptPatchListRequest>().checked(),
        Definition::read::<TranscriptPatchFile>(),
        Definition::read::<TranscriptPatchListResponse>().checked(),
        Definition::read::<TranscriptReadRequest>().checked(),
        Definition::read::<TranscriptReadResponse>().checked(),
        Definition::read::<TranscriptReasoningReadRequest>().checked(),
        Definition::read::<ReasoningEntry>().checked(),
        Definition::read::<TranscriptReasoningReadResponse>().checked(),
        Definition::read::<TranscriptChildRunExpandRequest>().checked(),
        Definition::read::<TranscriptChildRunExpandResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
