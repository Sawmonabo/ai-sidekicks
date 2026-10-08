//! Replaying a batch never double-counts: applying it again, before or after the index reopens,
//! leaves every count and ranking as one apply does, and the commit's outbox id survives the
//! reopen.

use std::collections::HashMap;

use crate::engine::IndexEngine;
use crate::{IndexBatch, IndexRow, IndexRowKind, RemovedOwner, SearchQuery};

use super::seeded_set::{SeededSetSize, generate};
use super::support::{
    ScratchFolder, batch, live_counts, members, open_engine, queries_over, rank_all,
};

const SIZE: SeededSetSize =
    SeededSetSize { sessions: 30, messages: 2_000, groups: 3, tags: 40, links: 0 };
const REPLAYED_OUTBOX_ID: i64 = 7;

type Snapshot = Vec<((u64, u64, Vec<u64>), (Vec<u64>, HashMap<u64, Vec<u64>>))>;

fn snapshot(engine: &IndexEngine, queries: &[SearchQuery]) -> Snapshot {
    let version = engine.current_version();
    queries.iter().map(|query| (live_counts(&version, query), rank_all(&version, query))).collect()
}

#[test]
fn applying_a_batch_twice_equals_applying_it_once_and_its_outbox_id_survives_a_reopen() {
    let mut rows: Vec<IndexRow> = Vec::new();
    let directory = generate(SIZE, |row| rows.push(row));
    let later_rows = rows.split_off(rows.len() * 2 / 3);
    let replaced: Vec<IndexRow> = rows
        .iter()
        .filter(|row| row.kind == IndexRowKind::Event)
        .step_by(7)
        .take(25)
        .map(|row| IndexRow { text: format!("{} nezi nezi", row.text), ..row.clone() })
        .collect();
    let removed_keys: Vec<i64> = rows
        .iter()
        .filter(|row| row.kind == IndexRowKind::Event)
        .skip(3)
        .step_by(11)
        .take(20)
        .map(|row| row.key)
        .collect();
    let (changed_group, changed_members) = {
        let (group, sessions) = &directory.group_members[0];
        (*group, sessions[..sessions.len() / 2].to_vec())
    };
    let queries = queries_over(&rows);
    // The batch the test replays: new rows, rows replaced by key, rows removed by key and by
    // owner, and a group's members changed.
    let replayed = || IndexBatch {
        removed_keys: removed_keys.clone(),
        removed_owners: vec![RemovedOwner { owner_key: 4, is_group: false }],
        group_members: members(&[(changed_group, changed_members.clone())]),
        ..batch(REPLAYED_OUTBOX_ID, later_rows.iter().chain(&replaced).cloned().collect())
    };

    let folder = ScratchFolder::new("apply");
    let engine = open_engine(folder.path());
    assert_eq!(engine.current_version().last_applied_outbox_id, 0);
    engine
        .apply(&IndexBatch { group_members: members(&directory.group_members), ..batch(1, rows) })
        .expect("the first batch applies");
    engine.apply(&replayed()).expect("the batch applies");
    let once = snapshot(&engine, &queries);
    engine.apply(&replayed()).expect("the batch applies again");
    assert_eq!(snapshot(&engine, &queries), once, "applied twice");
    engine.close().expect("the index closes");
    drop(engine);

    let reopened = open_engine(folder.path());
    assert_eq!(reopened.current_version().last_applied_outbox_id, REPLAYED_OUTBOX_ID as u64);
    let final_members = directory
        .group_members
        .iter()
        .map(|(group, sessions)| match *group == changed_group {
            true => (*group, changed_members.clone()),
            false => (*group, sessions.clone()),
        })
        .collect();
    reopened.set_group_members(final_members).expect("the members load");
    assert_eq!(snapshot(&reopened, &queries), once, "reopened");
    reopened.apply(&replayed()).expect("the batch applies after the reopen");
    assert_eq!(snapshot(&reopened, &queries), once, "applied again after the reopen");
}
