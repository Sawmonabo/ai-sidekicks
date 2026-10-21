//! One `session.search` page from sessions offered in order: whole sessions while their hits fit
//! the page's hit limit and one message, and where the next page starts. A session whose hits
//! alone overflow a page fills the page by itself and the next page continues it.

use std::num::NonZeroUsize;

use serde::Serialize;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::jsonrpc::page::{PAGE_MAX_BYTES, count_entries_fitting_one_frame};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{SessionSearchGroup, SessionSearchHit};
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::session::search::cursor::SearchPagePosition;

/// A hit offered to a page, with the index key of the row it shows, which a cursor names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PageHit {
    /// The index key of the row the hit shows.
    pub(crate) key: u64,
    /// The hit as the page carries it.
    pub(crate) hit: SessionSearchHit,
}

/// A session offered to a page: its hits no earlier page showed, best first, and its place in
/// the search's order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PageCandidate {
    /// The session.
    pub(crate) session_id: SessionId,
    /// Its name; `None` for an untitled session.
    pub(crate) name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// Its hits no earlier page showed, best first.
    pub(crate) hits: Vec<PageHit>,
    /// The session's place in the search's order.
    pub(crate) session_index: usize,
    /// The key of the last hit an earlier page showed in this session, if any.
    pub(crate) resume_after: Option<u64>,
}

impl PageCandidate {
    // The position of a page that starts at this session with `shown_hit_count` of its hits shown.
    fn position_at(&self, shown_hit_count: usize) -> SearchPagePosition {
        let after_hit_key = match shown_hit_count.checked_sub(1) {
            None => self.resume_after,
            Some(last_shown) => self.hits.get(last_shown).map(|shown| shown.key),
        };
        SearchPagePosition {
            session_index: self.session_index,
            after_hit_key,
        }
    }
}

/// A page's groups when hits remain: at least one, as a continuing page carries them.
pub(crate) type SearchGroups = BoundedVec<SessionSearchGroup, 1, { usize::MAX }>;

/// One page's groups, and where the next page starts while hits remain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SearchPage {
    /// Hits remain past this page.
    Continuing {
        /// The page's groups, at least one.
        groups: SearchGroups,
        /// Where the next page starts.
        next: SearchPagePosition,
    },
    /// The last page, possibly empty.
    Terminal {
        /// The page's groups.
        groups: Vec<SessionSearchGroup>,
    },
}

// What a page is measured as when its first group alone is over the budget: that group holding
// only its first hit, then each further hit.
#[derive(Serialize)]
#[serde(untagged)]
enum GroupPart<'page> {
    Group(&'page SessionSearchGroup),
    Hit(&'page SessionSearchHit),
}

/// Builds a page from `candidates` in order, at most `limit` hits. The candidates are read only up
/// to the first session that does not fit, which is where the next page starts; a candidate's
/// failure ends the read and is returned.
pub(crate) fn assemble_search_page<Failure>(
    candidates: impl IntoIterator<Item = Result<PageCandidate, Failure>>,
    limit: NonZeroUsize,
) -> Result<SearchPage, Failure> {
    let mut selections: Vec<PageCandidate> = Vec::new();
    let mut room = limit.get();
    let mut next = None;
    for candidate in candidates {
        let mut candidate = candidate?;
        let hit_count = candidate.hits.len();
        if hit_count == 0 {
            continue;
        }
        if hit_count <= room {
            room -= hit_count;
            selections.push(candidate);
            continue;
        }
        if selections.is_empty() {
            candidate.hits.truncate(room);
            next = Some(candidate.position_at(room));
            selections.push(candidate);
        } else {
            next = Some(candidate.position_at(0));
        }
        break;
    }
    Ok(fit_one_message(selections, next))
}

// Cuts the page to what one message carries: whole groups while they fit, or, when the first group
// alone is over, as many of its hits as fit.
fn fit_one_message(selections: Vec<PageCandidate>, next: Option<SearchPagePosition>) -> SearchPage {
    // Where a page starting at each selected session with none of its hits shown begins, and the
    // first session's hit keys, which name where a page continuing it begins.
    let starts: Vec<SearchPagePosition> = selections
        .iter()
        .map(|selection| selection.position_at(0))
        .collect();
    let first_hit_keys: Vec<u64> = selections
        .first()
        .map(|first| first.hits.iter().map(|shown| shown.key).collect())
        .unwrap_or_default();
    let mut groups: Vec<SessionSearchGroup> = selections.into_iter().map(group_of).collect();
    if groups.is_empty() {
        return SearchPage::Terminal { groups };
    }
    let first_group = &groups[0];
    let first_group_bytes = json_utf8_byte_length(&[first_group])
        .expect("a search group serializes: it holds only text and integers");
    if first_group_bytes > PAGE_MAX_BYTES {
        let hit_count = count_hits_fitting_one_group(first_group);
        let next = SearchPagePosition {
            session_index: starts[0].session_index,
            after_hit_key: hit_count
                .checked_sub(1)
                .and_then(|last_shown| first_hit_keys.get(last_shown))
                .copied(),
        };
        let first_group = groups.swap_remove(0);
        let mut hits = first_group.hits.into_vec();
        hits.truncate(hit_count);
        let first_group = SessionSearchGroup {
            hits: BoundedVec::new(hits).expect("at least one hit fits, since none would stall"),
            ..first_group
        };
        return SearchPage::Continuing {
            groups: SearchGroups::new(vec![first_group]).expect("the page holds its first group"),
            next,
        };
    }
    let group_count = count_entries_fitting_one_frame(
        &groups,
        groups.len(),
        PAGE_MAX_BYTES,
        json_utf8_byte_length,
    )
    .expect("a search group serializes: it holds only text and integers");
    let first_left_out = starts.get(group_count).copied();
    groups.truncate(group_count);
    match first_left_out.or(next) {
        Some(next) => SearchPage::Continuing {
            groups: SearchGroups::new(groups)
                .expect("at least one group fits, since none would stall"),
            next,
        },
        None => SearchPage::Terminal { groups },
    }
}

// A selected session's group, its hits as the page carries them.
fn group_of(selection: PageCandidate) -> SessionSearchGroup {
    let hits = selection.hits.into_iter().map(|shown| shown.hit).collect();
    SessionSearchGroup {
        session_id: selection.session_id,
        name: selection.name,
        hits: BoundedVec::new(hits)
            .expect("a selected session holds at least one hit: the page skips one with none"),
    }
}

// How many of a group's leading hits fit one message together with the group's own members. The
// list measured is the group holding only its first hit, then each further hit: its JSON is the
// page's byte for byte, each further hit adding itself and one comma either way.
fn count_hits_fitting_one_group(group: &SessionSearchGroup) -> usize {
    let hits = group.hits.as_slice();
    let group_with_first_hit = SessionSearchGroup {
        session_id: group.session_id,
        name: group.name.clone(),
        hits: BoundedVec::new(hits[..1].to_vec()).expect("a group holds at least one hit"),
    };
    let parts: Vec<GroupPart<'_>> = std::iter::once(GroupPart::Group(&group_with_first_hit))
        .chain(hits[1..].iter().map(GroupPart::Hit))
        .collect();
    count_entries_fitting_one_frame(&parts, hits.len(), PAGE_MAX_BYTES, json_utf8_byte_length)
        .expect("a search group serializes: it holds only text and integers")
}
