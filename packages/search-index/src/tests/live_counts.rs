//! Rows deleted from an index, still on disk until a merge, never sway a count or a score: the live
//! counts and rankings equal those of an index built without the deleted rows.

use std::collections::{HashMap, HashSet};

use crate::version::IndexVersion;
use crate::{IndexBatch, IndexRow, IndexRowKind, RemovedOwner, SearchQuery};

use super::seeded_set::{SeededSetSize, generate};
use super::support::{
    ScratchFolder, batch, key_of, live_counts, members, open_engine, queries_over, rank_all,
};

const SIZE: SeededSetSize =
    SeededSetSize { sessions: 40, messages: 3_000, groups: 4, tags: 60, links: 0 };
// The set's largest session, which every fiftieth message goes to, and another.
const PURGED_SESSIONS: [u64; 2] = [2, 5];

fn assert_same_counts(
    deleted: &IndexVersion,
    rebuilt: &IndexVersion,
    queries: &[SearchQuery],
    when: &str,
) {
    for query in queries {
        let counts = live_counts(rebuilt, query);
        assert!(counts.2.iter().all(|rows| *rows > 0), "{when}: {:?} matches", query.words);
        assert_eq!(live_counts(deleted, query), counts, "{when}: counts of {:?}", query.words);
        assert_eq!(rank_all(deleted, query), rank_all(rebuilt, query), "{when}: {:?}", query.words);
    }
}

#[test]
fn live_counts_after_deletes_equal_an_index_built_without_the_deleted_rows() {
    let mut rows: Vec<IndexRow> = Vec::new();
    let directory = generate(SIZE, |row| rows.push(row));
    let removed_group = directory.group_members[0].0;
    let events: Vec<&IndexRow> =
        rows.iter().filter(|row| row.kind == IndexRowKind::Event).collect();
    let removed_keys: HashSet<u64> =
        events.iter().step_by(9).take(40).map(|row| key_of(row)).collect();
    let replacements: HashMap<u64, IndexRow> = events
        .iter()
        .skip(4)
        .step_by(9)
        .filter(|row| !PURGED_SESSIONS.contains(&(row.owner_key as u64)))
        .take(30)
        .map(|row| {
            let replaced = IndexRow { text: format!("{} kalo", row.text), ..(*row).clone() };
            (key_of(row), replaced)
        })
        .collect();
    let is_removed = |row: &IndexRow| match row.kind {
        IndexRowKind::Group => row.owner_key as u64 == removed_group,
        _ => {
            PURGED_SESSIONS.contains(&(row.owner_key as u64)) || removed_keys.contains(&key_of(row))
        }
    };
    let surviving: Vec<IndexRow> = rows
        .iter()
        .filter(|row| !is_removed(row))
        .map(|row| replacements.get(&key_of(row)).cloned().unwrap_or_else(|| row.clone()))
        .collect();
    let kept_groups: Vec<(u64, Vec<u64>)> = directory
        .group_members
        .iter()
        .filter(|(group, _)| *group != removed_group)
        .cloned()
        .collect();

    let deleted_folder = ScratchFolder::new("live-counts-deleted");
    let deleted = open_engine(deleted_folder.path());
    let half = rows.len() / 2;
    let second_half = rows.split_off(half);
    deleted
        .apply(&IndexBatch { group_members: members(&directory.group_members), ..batch(1, rows) })
        .expect("the first half applies");
    deleted.apply(&batch(2, second_half)).expect("the second half applies");
    let mut removed_owners: Vec<RemovedOwner> = PURGED_SESSIONS
        .iter()
        .map(|session| RemovedOwner { owner_key: *session as i64, is_group: false })
        .collect();
    removed_owners.push(RemovedOwner { owner_key: removed_group as i64, is_group: true });
    let removals = IndexBatch {
        removed_keys: removed_keys.iter().map(|key| *key as i64).collect(),
        removed_owners,
        group_members: members(&[(removed_group, Vec::new())]),
        ..batch(3, replacements.into_values().collect())
    };
    deleted.apply(&removals).expect("the removals apply");

    let rebuilt_folder = ScratchFolder::new("live-counts-rebuilt");
    let rebuilt = open_engine(rebuilt_folder.path());
    let queries = queries_over(&surviving);
    rebuilt
        .apply(&IndexBatch { group_members: members(&kept_groups), ..batch(1, surviving) })
        .expect("the surviving rows apply");

    let rebuilt_version = rebuilt.current_version();
    let deleted_version = deleted.current_version();
    assert_eq!(deleted_version.live_rows, rebuilt_version.live_rows);
    assert_eq!(deleted_version.live_tokens, rebuilt_version.live_tokens);
    assert_same_counts(&deleted_version, &rebuilt_version, &queries, "before merging");

    while deleted.merge_while_idle().expect("a merge step runs") {}
    let merged_version = deleted.current_version();
    assert_eq!(merged_version.searcher.segment_readers().len(), 1);
    assert_eq!(merged_version.live_tokens, rebuilt_version.live_tokens);
    assert_same_counts(&merged_version, &rebuilt_version, &queries, "after merging");
}
