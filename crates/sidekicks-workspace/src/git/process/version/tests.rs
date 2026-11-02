use rstest::rstest;

use super::{GitFeature, GitVersion};
use crate::git::process::test_git_runner;

// Each feature is met from its first release and missed just before it, whatever build suffix
// follows the patch. Fails on a major-only compare, a suffix that fails the parse, or a floor
// moved.
#[rstest]
#[case::apple_build(
    b"git version 2.54.0 (Apple Git-157)\n",
    GitFeature::SparseCheckoutCheckRules,
    true
)]
#[case::windows_build(
    b"git version 2.41.0.windows.1\n",
    GitFeature::SparseCheckoutCheckRules,
    true
)]
#[case::below_the_check_rules_floor(
    b"git version 2.40.5\n",
    GitFeature::SparseCheckoutCheckRules,
    false
)]
#[case::below_the_fsync_floor(b"git version 2.35.9\n", GitFeature::CoreFsync, false)]
#[case::above_the_geometric_floor(b"git version 2.35.9\n", GitFeature::RepackGeometric, true)]
#[case::below_the_geometric_floor(b"git version 2.31.8\n", GitFeature::RepackGeometric, false)]
fn a_feature_is_met_from_its_first_release(
    #[case] output: &[u8],
    #[case] feature: GitFeature,
    #[case] is_met: bool,
) {
    let version = GitVersion::from_version_output(output).expect("the version reads");

    assert_eq!(version.has(feature), is_met);
}

// A version with no number is no version, so no feature is taken to be there. Fails when an
// unreadable answer reads as a release.
#[test]
fn a_version_with_no_number_does_not_read() {
    assert_eq!(GitVersion::from_version_output(b"git version\n"), None);
    assert_eq!(GitVersion::from_version_output(b"git version \n"), None);
}

// The running git's own answer reads, so the runner's check answers rather than failing on every
// call. Fails when the read cannot parse what `git version --build-options` prints.
#[tokio::test]
async fn the_running_git_names_a_version_that_reads() {
    let git = test_git_runner();

    let has_geometric = git
        .version(None, GitFeature::RepackGeometric)
        .await
        .map(|version| version.has(GitFeature::RepackGeometric));

    assert!(matches!(has_geometric, Ok(true)), "got {has_geometric:?}");
}

// A refusal reads the build again only when the program's stat data changed since the record:
// kept facts answer the kept release, stale ones the running git's. Fails when every refusal reads
// git again, or when a changed program is never read again.
#[rstest]
#[case::unchanged_program_keeps_the_record(true)]
#[case::changed_program_is_read_again(false)]
#[tokio::test]
async fn a_refusal_reads_the_build_again_only_after_the_program_changed(
    #[case] are_facts_current: bool,
) {
    let running = test_git_runner()
        .version(None, GitFeature::RepackGeometric)
        .await
        .expect("the running git's version reads");
    let kept = GitVersion::from_version_output(b"git version 2.35.9\n").expect("the version reads");
    let git = test_git_runner()
        .reading_version_as(b"git version 2.35.9\n", are_facts_current)
        .await;

    let answered = git
        .version(None, GitFeature::CoreFsync)
        .await
        .expect("the version answers");

    let expected = if are_facts_current { kept } else { running };
    assert_eq!(answered, expected);
}
