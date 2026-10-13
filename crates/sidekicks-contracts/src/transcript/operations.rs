//! The paged transcript reads: `transcript.read`, the reasoning read and the child-run expansion,
//! each page held to the shared page budget. A continuing page carries at least one entry and the
//! cursor to continue from; a terminal page may be empty and may still say where the window ended,
//! which a client needs to open the live stream from exactly there. The reasoning read names no
//! principal: the caller is the authenticated connection.

use std::borrow::Cow;
use std::collections::HashSet;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::jsonrpc::byte_length::json_utf8_byte_length;
use crate::jsonrpc::page::{PAGE_MAX_BYTES, fits_one_page};
use crate::run::id::RunId;
use crate::run::state::RunState;
use crate::session::event_cursor::EventCursor;
use crate::session::id::SessionId;
use crate::transcript::child_run_summary::refuse_self_parenting_run;
use crate::transcript::limits::TRANSCRIPT_READ_LIMIT_MAX;
use crate::transcript::row::TranscriptReadRow;
use crate::transcript::run_facts::TranscriptRunFacts;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::{BoundedInt, SafeInt};
use crate::wire::text::FreeFormText;

/// A member whose one value is the boolean `VALUE`: a page's `hasMore`, or a mark that is `true`
/// when present.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct BoolLiteral<const VALUE: bool>;

impl<const VALUE: bool> Serialize for BoolLiteral<VALUE> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(VALUE)
    }
}

impl<'de, const VALUE: bool> Deserialize<'de> for BoolLiteral<VALUE> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? == VALUE {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format!(
                "this member is always `{VALUE}`"
            )))
        }
    }
}

impl<const VALUE: bool> JsonSchema for BoolLiteral<VALUE> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("BoolLiteral{VALUE}").into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "boolean", "const": VALUE })
    }
}

/// Refuses entries that go backwards in sequence: a page runs oldest to newest, nondecreasing.
fn require_nondecreasing_sequence<T>(
    entries: &[T],
    sequence_of: impl Fn(&T) -> u64,
) -> garde::Result {
    for (index, pair) in entries.windows(2).enumerate() {
        let (previous, current) = (sequence_of(&pair[0]), sequence_of(&pair[1]));
        if current < previous {
            return Err(garde::Error::new(format!(
                "entries run oldest to newest: entry {} has sequence {current} after {previous}, \
                 so this page is out of order",
                index + 1
            )));
        }
    }
    Ok(())
}

/// The JSON length of a member the window's budget measures.
fn json_length_of<T: Serialize>(member: &T) -> Result<usize, garde::Error> {
    json_utf8_byte_length(member)
        .map_err(|error| garde::Error::new(format!("the member does not serialize: {error}")))
}

/// Holds a window's rows: they run oldest to newest and fit the page budget left beside `runs`,
/// which rides in the same frame.
fn require_window_rows(
    entries: &[TranscriptReadRow],
    runs: &[TranscriptRunFacts],
) -> garde::Result {
    let budget_bytes = PAGE_MAX_BYTES.saturating_sub(json_length_of(&runs)?);
    let entries_bytes = json_length_of(&entries)?;
    if entries_bytes > budget_bytes {
        return Err(garde::Error::new(format!(
            "the entries measure {entries_bytes} JSON bytes, over the {budget_bytes} bytes the \
             page budget leaves beside the runs"
        )));
    }
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
            return Err(garde::Error::new(format!(
                "runs names run {} twice",
                facts.run_id.as_str()
            )));
        }
        if !named_run_ids.contains(&facts.run_id) {
            return Err(garde::Error::new(format!(
                "runs carries run {}, which no entry names",
                facts.run_id.as_str()
            )));
        }
    }
    match named_run_ids
        .iter()
        .find(|run_id| !fact_run_ids.contains(*run_id))
    {
        Some(run_id) => Err(garde::Error::new(format!(
            "an entry names run {}, which runs carries no facts for",
            run_id.as_str()
        ))),
        None => Ok(()),
    }
}

/// Holds an expansion to its own run: a row attributed to another run would render as this run's
/// activity. A `general` row carries no run and rides as context.
fn require_entries_to_belong_to_run(
    run_id: &RunId,
    entries: &[TranscriptReadRow],
) -> garde::Result {
    match entries
        .iter()
        .find_map(|entry| entry.run_id().filter(|named| *named != run_id))
    {
        Some(other) => Err(garde::Error::new(format!(
            "a child-run expansion carries only that run's rows: an entry names run {}",
            other.as_str()
        ))),
        None => Ok(()),
    }
}

/// How many rows a read may ask for: 1 to [`TRANSCRIPT_READ_LIMIT_MAX`].
pub type TranscriptReadLimit = BoundedInt<1, 256>;

/// A bounded read window over one session's transcript. A cursor is a position in the log, and
/// the cursor an event carries is the position right after it: `afterCursor` answers the events
/// after its position and `beforeCursor` those before it, so a page before a window's head and the
/// stream after it meet with nothing missed or repeated.
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
    /// The most rows to answer.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "TranscriptReadLimit")]
    pub limit: Option<TranscriptReadLimit>,
}

/// A read window with more after it: at least one row, and the cursor to continue from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct TranscriptReadContinuing {
    /// The rows, oldest first, within the page budget the runs leave.
    #[garde(length(min = 1, max = TRANSCRIPT_READ_LIMIT_MAX), dive)]
    #[garde(custom(|entries: &Vec<TranscriptReadRow>, (): &()| {
        require_window_rows(entries, &self.runs)
    }))]
    #[schemars(length(min = 1, max = 256))]
    pub entries: Vec<TranscriptReadRow>,
    /// The facts of each run the entries name, folded over the whole log, one per run.
    #[garde(length(max = TRANSCRIPT_READ_LIMIT_MAX))]
    #[garde(custom(|runs: &Vec<TranscriptRunFacts>, (): &()| {
        require_one_fact_per_named_run(runs, &self.entries)
    }))]
    #[schemars(length(max = 256))]
    pub runs: Vec<TranscriptRunFacts>,
    /// More rows follow.
    pub has_more: BoolLiteral<true>,
    /// Where to continue.
    pub next_cursor: EventCursor,
}

/// The last read window: possibly empty, and possibly saying where the window ended.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct TranscriptReadTerminal {
    /// The rows, oldest first, within the page budget the runs leave.
    #[garde(length(max = TRANSCRIPT_READ_LIMIT_MAX), dive)]
    #[garde(custom(|entries: &Vec<TranscriptReadRow>, (): &()| {
        require_window_rows(entries, &self.runs)
    }))]
    #[schemars(length(max = 256))]
    pub entries: Vec<TranscriptReadRow>,
    /// The facts of each run the entries name, folded over the whole log, one per run.
    #[garde(length(max = TRANSCRIPT_READ_LIMIT_MAX))]
    #[garde(custom(|runs: &Vec<TranscriptRunFacts>, (): &()| {
        require_one_fact_per_named_run(runs, &self.entries)
    }))]
    #[schemars(length(max = 256))]
    pub runs: Vec<TranscriptRunFacts>,
    /// No rows follow.
    pub has_more: BoolLiteral<false>,
    /// Where the window ended.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "EventCursor")]
    pub next_cursor: Option<EventCursor>,
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
}

/// A run's reasoning, from `afterCursor` when continuing. The cursor is an event position, since a
/// reasoning entry is projected from the run's events.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ReasoningSurfaceReadRequest {
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

/// One normalized reasoning entry, ordered by its originating `sequence`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ReasoningEntry {
    /// The sequence of the event it was projected from.
    pub sequence: SafeInt<0>,
    /// The reasoning text.
    pub content: FreeFormText<REASONING_ENTRY_CONTENT_MAX_LEN>,
    /// When it was produced.
    #[garde(dive)]
    pub timestamp: WireInstant,
}

/// The `available` word of a reasoning reply.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(inline)]
pub enum ReasoningAvailable {
    /// The one value.
    #[serde(rename = "available")]
    Value,
}

/// The `unavailable` word of a reasoning reply.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(inline)]
pub enum ReasoningUnavailable {
    /// The one value.
    #[serde(rename = "unavailable")]
    Value,
}

/// Holds a reasoning page to the page budget and to sequence order.
fn require_reasoning_page(entries: &[ReasoningEntry]) -> garde::Result {
    fits_one_page(&entries, &())?;
    require_nondecreasing_sequence(entries, |entry| entry.sequence.get())
}

/// A reasoning page with more after it: at least one entry, and the cursor to continue from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct ReasoningSurfaceContinuing {
    /// The reasoning is readable.
    pub availability: ReasoningAvailable,
    /// The entries, oldest first.
    #[garde(length(min = 1, max = REASONING_SURFACE_ENTRIES_MAX), dive)]
    #[garde(custom(|entries: &Vec<ReasoningEntry>, (): &()| require_reasoning_page(entries)))]
    #[schemars(length(min = 1, max = 256))]
    pub reasoning_entries: Vec<ReasoningEntry>,
    /// More entries follow.
    pub has_more: BoolLiteral<true>,
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
    #[garde(length(max = REASONING_SURFACE_ENTRIES_MAX), dive)]
    #[garde(custom(|entries: &Vec<ReasoningEntry>, (): &()| require_reasoning_page(entries)))]
    #[schemars(length(max = 256))]
    pub reasoning_entries: Vec<ReasoningEntry>,
    /// No entries follow.
    pub has_more: BoolLiteral<false>,
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
pub enum ReasoningSurfaceReadResponse {
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
pub struct ChildRunExpandRequest {
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
            entries: $(#[$entries_attribute:meta])+,
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
            $(#[$entries_attribute])+
            #[garde(custom(|entries: &Vec<TranscriptReadRow>, (): &()| {
                require_expansion_rows(&self.run_id, entries)
            }))]
            pub entries: Vec<TranscriptReadRow>,
            $($arm_member)*
        }
    };
}

child_run_expand_arm! {
    /// An expansion with more after it: at least one row, and the cursor to continue from.
    ChildRunExpandContinuing {
        entries:
            #[garde(length(min = 1, max = TRANSCRIPT_READ_LIMIT_MAX), dive)]
            #[schemars(length(min = 1, max = 256))],
        /// More rows follow.
        pub has_more: BoolLiteral<true>,
        /// Where to continue.
        pub next_cursor: EventCursor,
    }
}

child_run_expand_arm! {
    /// The last expansion page: possibly empty, and possibly saying where it ended.
    ChildRunExpandTerminal {
        entries:
            #[garde(length(max = TRANSCRIPT_READ_LIMIT_MAX), dive)]
            #[schemars(length(max = 256))],
        /// No rows follow.
        pub has_more: BoolLiteral<false>,
        /// Where the expansion ended.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "EventCursor")]
        pub next_cursor: Option<EventCursor>,
    }
}

/// The expansion, split on `hasMore` like the read window: a long-running child run can produce
/// more rows than fit one frame.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum ChildRunExpandResponse {
    /// More rows follow.
    Continuing(#[garde(dive)] ChildRunExpandContinuing),
    /// The last page.
    Terminal(#[garde(dive)] ChildRunExpandTerminal),
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "transcript/operations",
    doc: "The paged transcript reads: `transcript.read`, the reasoning read and the child-run \
          expansion, each page held to the shared page budget.",
    definitions: &[
        Definition::read::<TranscriptReadRequest>().checked(),
        Definition::read::<TranscriptReadResponse>().checked(),
        Definition::read::<ReasoningSurfaceReadRequest>().checked(),
        Definition::read::<ReasoningEntry>().checked(),
        Definition::read::<ReasoningSurfaceReadResponse>().checked(),
        Definition::read::<ChildRunExpandRequest>().checked(),
        Definition::read::<ChildRunExpandResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
