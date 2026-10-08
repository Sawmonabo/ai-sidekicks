//! A search's tags: the sessions carrying every queried tag or one nested under it, read from the
//! tag field's postings without scoring, each with its last activity, and the tag rows that matched.

use std::collections::{HashMap, HashSet};

use tantivy::schema::IndexRecordOption;
use tantivy::{DocSet, TERMINATED};

use crate::schema::{Owner, owner_of, tag_term};
use crate::version::IndexVersion;

/// The sessions carrying every queried tag, or a tag nested under it, with each one's last
/// activity.
pub struct TaggedSessions {
    folds: Vec<String>,
    activity: HashMap<u64, u64>,
}

impl TaggedSessions {
    /// The sessions `version` holds tag rows of for every one of `folds`; none for no fold.
    pub fn read(version: &IndexVersion, folds: Vec<String>) -> tantivy::Result<TaggedSessions> {
        let mut carrying: Option<HashMap<u64, u64>> = None;
        for fold in &folds {
            let mut sessions: HashMap<u64, u64> = HashMap::new();
            visit_tag_rows(version, fold, |session, _, activity| {
                let held = sessions.entry(session).or_insert(activity);
                *held = (*held).max(activity);
            })?;
            carrying = Some(match carrying {
                None => sessions,
                Some(earlier) => earlier
                    .into_iter()
                    .filter_map(|(session, activity)| {
                        let later = sessions.get(&session)?;
                        Some((session, activity.max(*later)))
                    })
                    .collect(),
            });
        }
        Ok(TaggedSessions {
            folds,
            activity: carrying.unwrap_or_default(),
        })
    }

    /// The sessions, in no order.
    pub fn sessions(&self) -> Vec<u64> {
        self.activity.keys().copied().collect()
    }

    /// The sessions most recently active first, sessions equally active in session key order.
    pub fn by_activity(&self) -> Vec<u64> {
        let mut sessions: Vec<(u64, u64)> = self
            .activity
            .iter()
            .map(|(session, activity)| (*session, *activity))
            .collect();
        sessions.sort_unstable_by(|(left, left_activity), (right, right_activity)| {
            right_activity.cmp(left_activity).then(left.cmp(right))
        });
        sessions.into_iter().map(|(session, _)| session).collect()
    }

    /// Each named session's tag rows a queried tag matches, by key ascending, in the order the
    /// sessions are named.
    pub fn hits_of(
        &self,
        version: &IndexVersion,
        sessions: &[u64],
    ) -> tantivy::Result<Vec<Vec<u64>>> {
        let wanted: HashSet<u64> = sessions.iter().copied().collect();
        let mut rows: HashMap<u64, Vec<u64>> = HashMap::new();
        for fold in &self.folds {
            visit_tag_rows(version, fold, |session, key, _| {
                if wanted.contains(&session) {
                    rows.entry(session).or_default().push(key);
                }
            })?;
        }
        for keys in rows.values_mut() {
            keys.sort_unstable();
            keys.dedup();
        }
        Ok(sessions
            .iter()
            .map(|session| rows.remove(session).unwrap_or_default())
            .collect())
    }
}

// Every live tag row of the tag `fold` or one nested under it: its session, its key and the
// session's last activity.
fn visit_tag_rows(
    version: &IndexVersion,
    fold: &str,
    mut visit: impl FnMut(u64, u64, u64),
) -> tantivy::Result<()> {
    let term = tag_term(&version.fields, fold);
    for (ordinal, segment) in version.searcher.segment_readers().iter().enumerate() {
        let inverted = segment.inverted_index(version.fields.tag)?;
        let Some(mut postings) = inverted.read_postings(&term, IndexRecordOption::Basic)? else {
            continue;
        };
        let columns = &version.segments[ordinal].columns;
        let alive = segment.alive_bitset();
        let mut doc = postings.doc();
        while doc != TERMINATED {
            // A tag row is always a session's own.
            if alive.is_none_or(|alive| alive.is_alive(doc))
                && let Owner::Session(session) = owner_of(columns.owner.get_val(doc))
            {
                visit(
                    session,
                    columns.key.get_val(doc),
                    columns.activity.get_val(doc),
                );
            }
            doc = postings.advance();
        }
    }
    Ok(())
}
