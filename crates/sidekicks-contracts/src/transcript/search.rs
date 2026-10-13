//! `transcript.search`: one session's own search over every row it holds, loaded on screen or not.
//! The find box's `N of M` speaks for the whole session, and stepping to a match in unloaded
//! history loads that history then. The count and each hit's position come from the daemon.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::event::version::EVENT_FIELD_MAX_LEN;
use crate::jsonrpc::page::fits_one_page;
use crate::session::event_cursor::EventCursor;
use crate::session::id::SessionId;
use crate::session::methods::{SearchMatchRange, require_match_ranges_in_order_within};
use crate::transcript::limits::{TRANSCRIPT_READ_LIMIT_MAX, TRANSCRIPT_SEARCH_TEXT_MAX_LEN};
use crate::transcript::operations::TranscriptReadLimit;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::BoolLiteral;
use crate::wire::integer::SafeInt;
use crate::wire::text::{BoundedText, FreeFormText};

/// Searches one session. Hits come newest first; `beforeCursor` continues from the previous page's
/// `nextCursor`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TranscriptSearchRequest {
    /// The session.
    pub session_id: SessionId,
    /// The text to find.
    pub query: FreeFormText<TRANSCRIPT_SEARCH_TEXT_MAX_LEN>,
    /// Continue before this position.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "EventCursor")]
    pub before_cursor: Option<EventCursor>,
    /// The most hits to answer.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "TranscriptReadLimit")]
    pub limit: Option<TranscriptReadLimit>,
}

/// One row holding a match: where it is in the session, and the line the match sits in. Its
/// ranges run in order, never overlap, and sit inside the snippet, counted in UTF-16 units.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TranscriptSearchHit {
    /// The row.
    pub row_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// The row's position, which a `transcript.read` around it loads from.
    pub cursor: EventCursor,
    /// The line the match sits in.
    pub snippet: BoundedText<1, TRANSCRIPT_SEARCH_TEXT_MAX_LEN>,
    /// The matched stretches to mark.
    #[garde(length(min = 1), dive)]
    #[garde(custom(|match_ranges: &Vec<SearchMatchRange>, (): &()| {
        require_match_ranges_in_order_within(self.snippet.as_str(), match_ranges)
    }))]
    #[schemars(length(min = 1))]
    pub match_ranges: Vec<SearchMatchRange>,
}

/// Holds a page's hits to the page budget and its `matchCount` to at least the matches it carries,
/// since the count speaks for the whole session.
fn require_hits_counted(hits: &[TranscriptSearchHit], match_count: SafeInt<0>) -> garde::Result {
    fits_one_page(&hits, &())?;
    let page_match_count: usize = hits.iter().map(|hit| hit.match_ranges.len()).sum();
    if u64::try_from(page_match_count).is_ok_and(|count| count > match_count.get()) {
        return Err(garde::Error::new(format!(
            "matchCount counts the whole session, so it is at least the {page_match_count} matches \
             this page carries"
        )));
    }
    Ok(())
}

/// A page of hits with more after it: at least one hit, and the cursor to continue from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct TranscriptSearchContinuing {
    /// The session's whole match count.
    pub match_count: SafeInt<0>,
    /// The hits, newest first.
    #[garde(length(min = 1, max = TRANSCRIPT_READ_LIMIT_MAX), dive)]
    #[garde(custom(|hits: &Vec<TranscriptSearchHit>, (): &()| {
        require_hits_counted(hits, self.match_count)
    }))]
    #[schemars(length(min = 1, max = 256))]
    pub hits: Vec<TranscriptSearchHit>,
    /// More hits follow.
    pub has_more: BoolLiteral<true>,
    /// Where to continue.
    pub next_cursor: EventCursor,
}

/// The last page of hits, possibly empty.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct TranscriptSearchTerminal {
    /// The session's whole match count.
    pub match_count: SafeInt<0>,
    /// The hits, newest first.
    #[garde(length(max = TRANSCRIPT_READ_LIMIT_MAX), dive)]
    #[garde(custom(|hits: &Vec<TranscriptSearchHit>, (): &()| {
        require_hits_counted(hits, self.match_count)
    }))]
    #[schemars(length(max = 256))]
    pub hits: Vec<TranscriptSearchHit>,
    /// No hits follow.
    pub has_more: BoolLiteral<false>,
}

/// One page of hits and the session's whole match count, split on `hasMore`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum TranscriptSearchResponse {
    /// More hits follow.
    Continuing(#[garde(dive)] TranscriptSearchContinuing),
    /// The last page.
    Terminal(#[garde(dive)] TranscriptSearchTerminal),
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "transcript/search",
    doc: "`transcript.search`: one session's own search over every row it holds, loaded on screen \
          or not.",
    definitions: &[
        Definition::read::<TranscriptSearchRequest>().checked(),
        Definition::read::<TranscriptSearchHit>(),
        Definition::read::<TranscriptSearchResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
