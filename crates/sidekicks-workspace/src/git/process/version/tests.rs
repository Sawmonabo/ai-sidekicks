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
#[case::below_the_path_format_floor(b"git version 2.30.9\n", GitFeature::RevParsePathFormat, false)]
#[case::at_the_missing_floor(b"git version 2.16.0\n", GitFeature::RevListMissing, true)]
#[case::below_the_missing_floor(b"git version 2.15.4\n", GitFeature::RevListMissing, false)]
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
// call. Fails when the read cannot parse what git prints.
#[tokio::test]
async fn the_running_git_names_a_version_that_reads() {
    let git = test_git_runner();

    let has_missing = git
        .version(None)
        .await
        .map(|version| version.has(GitFeature::RevListMissing));

    assert!(matches!(has_missing, Ok(true)), "got {has_missing:?}");
}
