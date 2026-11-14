use rstest::rstest;
use sidekicks_contracts::repo::git_reads::GitObjectId;

use super::{BasePresence, ObjectCounts, read_bases_present, read_object_counts, read_points};
use crate::git::turn_snapshot::repack::SnapshotPoint;

const COMMIT: &str = "1111111111111111111111111111111111111111";
const TREE: &str = "2222222222222222222222222222222222222222";
const BASE: &str = "3333333333333333333333333333333333333333";
const SECOND_PARENT: &str = "4444444444444444444444444444444444444444";

fn id(text: &str) -> GitObjectId {
    GitObjectId::new(text.to_owned()).expect("the test's id reads")
}

// The capture of the test's tree over `base`.
fn point(base: Option<&str>) -> SnapshotPoint {
    SnapshotPoint {
        commit: id(COMMIT),
        tree: id(TREE),
        base: base.map(id),
    }
}

// A count read from anything but one decimal `count:`, `packs:` and `garbage:` line each would let
// a missing pack count read as 0 and skip a due fold, a missing garbage count read as 0 and never
// walk a fan-out folder for git's temporaries, or a garbled one skip the sweep. Fails when a
// missing, repeated or non-decimal count reads, or when another line is not ignored.
#[rstest]
#[case::every_count(
    b"count: 0\nsize: 0\nin-pack: 3\npacks: 11\nsize-pack: 1\ngarbage: 2\nsize-garbage: 0\n"
        .as_slice(),
    Some(ObjectCounts { loose: 0, packs: 11, garbage: 2 })
)]
#[case::loose_objects(
    b"count: 4\npacks: 0\ngarbage: 0\n".as_slice(),
    Some(ObjectCounts { loose: 4, packs: 0, garbage: 0 })
)]
#[case::packs_missing(b"count: 0\nsize: 0\ngarbage: 0\n".as_slice(), None)]
#[case::count_missing(b"packs: 2\ngarbage: 0\n".as_slice(), None)]
#[case::garbage_missing(b"count: 0\npacks: 2\nsize-garbage: 0\n".as_slice(), None)]
#[case::packs_repeated(b"count: 0\npacks: 1\npacks: 2\ngarbage: 0\n".as_slice(), None)]
#[case::packs_not_decimal(b"count: 0\npacks: +2\ngarbage: 0\n".as_slice(), None)]
#[case::count_empty(b"count: \npacks: 2\ngarbage: 0\n".as_slice(), None)]
fn object_counts_read_only_from_one_decimal_count_pack_and_garbage_line(
    #[case] answer: &[u8],
    #[case] expected: Option<ObjectCounts>,
) {
    assert_eq!(read_object_counts(answer).ok(), expected);
}

// A point read from a ref that is not one capture over at most one base would pack the wrong tree
// or skip a capture's base. Fails when a two-parent, empty-tree or non-id line reads as a point,
// or when a capture with no base is refused rather than read with none.
#[rstest]
#[case::one_parent(
    format!("refs/sidekicks/runs/a {COMMIT} {TREE} {BASE}"),
    Some(point(Some(BASE)))
)]
#[case::no_parent(format!("refs/sidekicks/runs/a {COMMIT} {TREE} "), Some(point(None)))]
#[case::two_parents(
    format!("refs/sidekicks/runs/a {COMMIT} {TREE} {BASE} {SECOND_PARENT}"),
    None
)]
#[case::no_tree(format!("refs/sidekicks/runs/a {COMMIT}  "), None)]
#[case::parent_not_an_id(format!("refs/sidekicks/runs/a {COMMIT} {TREE} HEAD"), None)]
#[case::three_fields(format!("refs/sidekicks/runs/a {COMMIT} {TREE}"), None)]
fn a_point_reads_only_from_one_capture_over_at_most_one_base(
    #[case] line: String,
    #[case] expected: Option<SnapshotPoint>,
) {
    let (points, unreadable) = read_points(format!("{line}\n").as_bytes());

    match expected {
        Some(point) => assert_eq!((points, unreadable), (vec![point], Vec::<String>::new())),
        None => assert_eq!((points, unreadable), (Vec::new(), vec![line])),
    }
}

// A base read as present when it is gone, or a tree base read as a commit, would hand `rev-list` a
// tree that reads as reached and leave the captures unpacked. Fails when a non-commit type reads
// as a commit, a missing base as present, or an answer for another id or of the wrong length
// reads at all.
#[rstest]
#[case::a_commit(format!("{BASE} commit 230\n"), Some(BasePresence::Commit))]
#[case::missing(format!("{BASE} missing\n"), Some(BasePresence::Missing))]
#[case::a_tree(format!("{BASE} tree 40\n"), Some(BasePresence::NotACommit("tree".to_owned())))]
#[case::another_id(format!("{COMMIT} commit 230\n"), None)]
#[case::no_line(String::new(), None)]
#[case::an_extra_line(format!("{BASE} commit 230\n{COMMIT} commit 230\n"), None)]
fn a_base_is_present_only_when_its_own_line_names_a_commit(
    #[case] answer: String,
    #[case] expected: Option<BasePresence>,
) {
    let base = id(BASE);

    let read = read_bases_present(answer.as_bytes(), &[&base]).ok();

    assert_eq!(read, expected.map(|presence| vec![presence]));
}
