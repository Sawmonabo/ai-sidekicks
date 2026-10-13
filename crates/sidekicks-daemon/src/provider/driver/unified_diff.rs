//! Line counts of a unified diff, as a transcript patch row shows them.

/// The added and removed lines of a unified diff.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct UnifiedDiffCounts {
    /// Lines added inside the hunks.
    pub(crate) additions: u64,
    /// Lines removed inside the hunks.
    pub(crate) deletions: u64,
}

/// Counts the added and removed lines inside a unified diff's hunks only, so a removed line whose
/// own text starts with `--` reads `---` and is still a removal.
pub(crate) fn count_unified_diff(diff: &str) -> UnifiedDiffCounts {
    let mut counts = UnifiedDiffCounts {
        additions: 0,
        deletions: 0,
    };
    let mut is_in_hunk = false;
    for line in diff.split('\n') {
        if line.starts_with("@@") {
            is_in_hunk = true;
        } else if is_in_hunk && line.starts_with('+') {
            counts.additions += 1;
        } else if is_in_hunk && line.starts_with('-') {
            counts.deletions += 1;
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{UnifiedDiffCounts, count_unified_diff};

    #[rstest]
    #[case::header_before_any_hunk(
        "--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n-old\n+new\n same",
        1,
        1
    )]
    #[case::removed_line_starting_with_two_dashes(
        "--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n--- a rule\n+a heading",
        1,
        1
    )]
    #[case::lines_before_the_first_hunk(
        "diff --git a/x b/x\n-not counted\n+not counted\n@@ -1 +1,2 @@\n+one\n+two",
        2,
        0
    )]
    #[case::two_hunks(
        "@@ -1,2 +1,1 @@\n-gone\n-also gone\n@@ -10 +9,2 @@\n context\n+added\n+added again\n-left",
        2,
        3
    )]
    #[case::empty("", 0, 0)]
    fn counts_lines_inside_hunks_only(
        #[case] diff: &str,
        #[case] additions: u64,
        #[case] deletions: u64,
    ) {
        assert_eq!(
            count_unified_diff(diff),
            UnifiedDiffCounts {
                additions,
                deletions,
            }
        );
    }
}
