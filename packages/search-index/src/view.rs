//! A search's point-in-time view: the version it opened on, the query prepared against it, and the
//! session order computed as far as its pages have asked.

use std::sync::Arc;

use crate::SearchQuery;
use crate::collector::{
    FULL_PASS_BELOW, PreparedQuery, ScoredSessions, SessionSet, hits_of, score_every_session,
    top_sessions,
};
use crate::directory::ReadCache;
use crate::phrase::query_phrases;
use crate::tags::TaggedSessions;
use crate::version::IndexVersion;

/// How many sessions the first pruned ranking holds; a later page past them doubles it.
const FIRST_TOP_SESSIONS: usize = 32;

/// One search over one version of the index; every page of it reads that version.
pub struct SearchView {
    version: Arc<IndexVersion>,
    search: Search,
    read_cache: Arc<ReadCache>,
}

// What a search ranks: words, limited to the tagged sessions when it names tags; tags alone; or
// nothing a row can match.
enum Search {
    Words {
        query: PreparedQuery,
        within: Option<SessionSet>,
        order: SessionOrder,
    },
    Tags {
        tags: TaggedSessions,
        /// The tagged sessions most recently active first.
        order: Vec<u64>,
    },
    Empty,
}

enum SessionOrder {
    NotRanked,
    /// Every matching session, with every one's hits.
    Whole(ScoredSessions),
    /// The best `k` sessions; fewer than `k` means the order is complete.
    Top {
        k: usize,
        sessions: Vec<u64>,
    },
}

impl SearchView {
    /// Prepares the search against `version`, its phrase counts and tagged sessions read now. With
    /// `tag_folds`, only the sessions carrying each tag or one nested under it count: ranked by
    /// `query` when it is given, most recently active first when it is not.
    pub fn open(
        version: Arc<IndexVersion>,
        query: Option<&SearchQuery>,
        tag_folds: Vec<String>,
    ) -> tantivy::Result<SearchView> {
        let read_cache = Arc::new(ReadCache::default());
        let _reading = ReadCache::enter(&read_cache);
        let tags = if tag_folds.is_empty() {
            None
        } else {
            Some(TaggedSessions::read(&version, tag_folds)?)
        };
        let search = match (query, tags) {
            (None, None) => Search::Empty,
            (None, Some(tags)) => {
                let order = tags.by_activity();
                Search::Tags { tags, order }
            }
            (Some(query), tags) => {
                let within =
                    tags.map(|tags| SessionSet::new(&tags.sessions(), &version.membership));
                let prepared = if within.as_ref().is_some_and(SessionSet::is_empty) {
                    None
                } else {
                    PreparedQuery::prepare(&version, query_phrases(query))?
                };
                match prepared {
                    Some(query) => Search::Words {
                        query,
                        within,
                        order: SessionOrder::NotRanked,
                    },
                    None => Search::Empty,
                }
            }
        };
        Ok(SearchView {
            version,
            search,
            read_cache,
        })
    }

    /// The sessions ranked `from` to `from + count - 1`, best first; fewer past the end.
    pub fn sessions_at(&mut self, from: usize, count: usize) -> tantivy::Result<Vec<u64>> {
        let end = from.saturating_add(count);
        let (query, within, order) = match &mut self.search {
            Search::Empty => return Ok(Vec::new()),
            Search::Tags { order, .. } => return Ok(page_of(order, from, end)),
            Search::Words {
                query,
                within,
                order,
            } => (&*query, within.as_ref(), order),
        };
        let _reading = ReadCache::enter(&self.read_cache);
        loop {
            match &*order {
                SessionOrder::Whole(scored) => return Ok(page_of(&scored.order, from, end)),
                SessionOrder::Top { k, sessions }
                    if end <= sessions.len() || sessions.len() < *k =>
                {
                    return Ok(page_of(sessions, from, end));
                }
                SessionOrder::Top { .. } | SessionOrder::NotRanked => {}
            }
            *order = rank(&self.version, query, within, order, end)?;
        }
    }

    /// Each named session's matching row keys, best first, in the order the sessions are named; a
    /// search by tags alone gives each session's matching tag rows by key.
    pub fn hits_of(&self, sessions: &[u64]) -> tantivy::Result<Vec<Vec<u64>>> {
        let _reading = ReadCache::enter(&self.read_cache);
        match &self.search {
            Search::Empty => Ok(vec![Vec::new(); sessions.len()]),
            Search::Tags { tags, .. } => tags.hits_of(&self.version, sessions),
            Search::Words {
                order: SessionOrder::Whole(scored),
                ..
            } => Ok(sessions
                .iter()
                .map(|session| scored.hits.get(session).cloned().unwrap_or_default())
                .collect()),
            Search::Words { query, .. } => hits_of(&self.version, query, sessions),
        }
    }
}

fn page_of(order: &[u64], from: usize, end: usize) -> Vec<u64> {
    order[from.min(order.len())..end.min(order.len())].to_vec()
}

// A narrow query, and one within sessions whose own rows are few, score every matching row once
// and keep every hit; a broad one ranks the best k sessions, k doubled or raised to the page's end
// each time a page runs past them.
fn rank(
    version: &IndexVersion,
    query: &PreparedQuery,
    within: Option<&SessionSet>,
    order: &SessionOrder,
    end: usize,
) -> tantivy::Result<SessionOrder> {
    let mut fewest_rows = query.fewest_rows();
    if let Some(set) = within {
        fewest_rows = fewest_rows.min(set.estimated_rows(version)?);
    }
    if fewest_rows < FULL_PASS_BELOW {
        return Ok(SessionOrder::Whole(score_every_session(
            version, query, within,
        )?));
    }
    let k = match order {
        SessionOrder::Top { k, .. } => (k * 2).max(end),
        SessionOrder::NotRanked | SessionOrder::Whole(_) => FIRST_TOP_SESSIONS.max(end),
    };
    Ok(match top_sessions(version, query, k, within)? {
        Some(sessions) => SessionOrder::Top { k, sessions },
        None => SessionOrder::Whole(score_every_session(version, query, within)?),
    })
}
