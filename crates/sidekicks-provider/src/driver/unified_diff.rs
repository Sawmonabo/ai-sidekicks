//! Unified diffs as a transcript patch row shows them: the lines a diff adds and removes, and a
//! whole file's text written as a diff that adds or removes every line.

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

/// A whole file's text as patch lines, each with `mark` (`+` for a file added, `-` for one
/// removed), and how many there are. A file that ends in a newline has no line after it, and an
/// empty file has none at all.
pub(crate) fn mark_every_line(text: &str, mark: char) -> (String, u64) {
    let mut patch = String::with_capacity(text.len());
    let mut count: u64 = 0;
    for line in text.split_terminator('\n') {
        if count > 0 {
            patch.push('\n');
        }
        patch.push(mark);
        patch.push_str(line);
        count += 1;
    }
    (patch, count)
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{UnifiedDiffCounts, count_unified_diff};

    #[rstest]
    #[case::removed_line_starting_with_two_dashes(
        "--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n--- a rule\n+a heading",
        1,
        1
    )]
    #[case::lines_before_the_first_hunk(
        "diff --git a/x b/x\n-not counted\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n same",
        1,
        1
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
