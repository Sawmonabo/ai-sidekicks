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
use crate::version::IndexVersion;

/// How many sessions the first pruned ranking holds; a later page past them doubles it.
const FIRST_TOP_SESSIONS: usize = 32;

/// One search over one version of the index; every page of it reads that version.
pub struct SearchView {
    version: Arc<IndexVersion>,
    query: Option<PreparedQuery>,
    within: Option<SessionSet>,
    order: SessionOrder,
    read_cache: Arc<ReadCache>,
}

enum SessionOrder {
    NotRanked,
    /// Every matching session, with every one's hits.
    Whole(ScoredSessions),
    /// The best `k` sessions; fewer than `k` means the order is complete.
    Top { k: usize, sessions: Vec<u64> },
}

impl SearchView {
    /// Prepares `query` against `version`, its phrase counts read now; with `within_sessions`, only
    /// those sessions and their groups' rows count.
    pub fn open(
        version: Arc<IndexVersion>,
        query: &SearchQuery,
        within_sessions: Option<&[u64]>,
    ) -> tantivy::Result<SearchView> {
        let read_cache = Arc::new(ReadCache::default());
        let _reading = ReadCache::enter(&read_cache);
        let prepared = PreparedQuery::prepare(&version, query_phrases(query))?;
        let within =
            within_sessions.map(|sessions| SessionSet::new(sessions, &version.membership));
        Ok(SearchView {
            version,
            query: prepared,
            within,
            order: SessionOrder::NotRanked,
            read_cache,
        })
    }

    /// The sessions ranked `from` to `from + count - 1`, best first; fewer past the end.
    pub fn sessions_at(&mut self, from: usize, count: usize) -> tantivy::Result<Vec<u64>> {
        let Some(query) = &self.query else { return Ok(Vec::new()) };
        let _reading = ReadCache::enter(&self.read_cache);
        let end = from.saturating_add(count);
        loop {
            match &self.order {
                SessionOrder::Whole(scored) => return Ok(page_of(&scored.order, from, end)),
                SessionOrder::Top { k, sessions }
                    if end <= sessions.len() || sessions.len() < *k =>
                {
                    return Ok(page_of(sessions, from, end));
                }
                SessionOrder::Top { .. } | SessionOrder::NotRanked => {}
            }
            self.order = rank(&self.version, query, self.within.as_ref(), &self.order, end)?;
        }
    }

    /// Each named session's matching row keys, best first, in the order the sessions are named.
    pub fn hits_of(&self, sessions: &[u64]) -> tantivy::Result<Vec<Vec<u64>>> {
        let Some(query) = &self.query else { return Ok(vec![Vec::new(); sessions.len()]) };
        if let SessionOrder::Whole(scored) = &self.order {
            return Ok(sessions
                .iter()
                .map(|session| scored.hits.get(session).cloned().unwrap_or_default())
                .collect());
        }
        let _reading = ReadCache::enter(&self.read_cache);
        hits_of(&self.version, query, sessions)
    }
}

fn page_of(order: &[u64], from: usize, end: usize) -> Vec<u64> {
    order[from.min(order.len())..end.min(order.len())].to_vec()
}

// A narrow query and a search within sessions score every matching row once and keep every hit; a
// broad one ranks the best k sessions, k doubled or raised to the page's end each time a page
// runs past them.
fn rank(
    version: &IndexVersion,
    query: &PreparedQuery,
    within: Option<&SessionSet>,
    order: &SessionOrder,
    end: usize,
) -> tantivy::Result<SessionOrder> {
    if within.is_some() || query.fewest_rows() < FULL_PASS_BELOW {
        return Ok(SessionOrder::Whole(score_every_session(version, query, within)?));
    }
    let k = match order {
        SessionOrder::Top { k, .. } => (k * 2).max(end),
        SessionOrder::NotRanked | SessionOrder::Whole(_) => FIRST_TOP_SESSIONS.max(end),
    };
    Ok(match top_sessions(version, query, k)? {
        Some(sessions) => SessionOrder::Top { k, sessions },
        None => SessionOrder::Whole(score_every_session(version, query, None)?),
    })
}
