//! The patch a Claude Code file-changing call made, with the lines it added and removed, read from
//! the call's own result: `gitDiff` where Claude Code sends one, which carries its own counts, else
//! the result's `structuredPatch` hunks, counted line by line. A result carrying neither reads as
//! a file whose patch cannot be read.

use serde_json::{Map, Value};
use sidekicks_contracts::event::envelope::HydratedContentUnavailableReason;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::transcript::content::TranscriptPatchFileUnavailable;

use crate::provider::driver::unified_diff::count_unified_diff;
use crate::provider::record_readers::{read_count, read_non_empty_string};
use crate::transcript::whole_patch::WholePatchFile;

// The tools whose result is one file's change.
const CLAUDE_FILE_CHANGING_TOOL_NAMES: [&str; 4] = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

/// Whether a tool's result is one file's change, read for its patch.
pub(crate) fn is_claude_file_changing_tool(tool_name: &str) -> bool {
    CLAUDE_FILE_CHANGING_TOOL_NAMES.contains(&tool_name)
}

/// The patch one file-changing call's result carries, from `gitDiff` first, then from its
/// `structuredPatch`; unavailable for a result naming its file but carrying neither. `None` for a
/// result that names no file, or a path the wire refuses (a NUL, past the cap).
/// `tool_use_result` is untrusted provider output.
pub(crate) fn read_claude_patch_file(tool_use_result: &Value) -> Option<WholePatchFile> {
    let result = tool_use_result.as_object()?;
    let path = read_non_empty_string(result, "filePath")
        .or_else(|| read_non_empty_string(result, "notebook_path"))?;
    let path = FilesystemPath::new(path.to_owned()).ok()?;
    if let Some(from_git_diff) = read_git_diff(result) {
        return Some(from_git_diff);
    }
    let from_hunks = result
        .get("structuredPatch")
        .and_then(Value::as_array)
        .and_then(|hunks| read_structured_patch(&path, hunks));
    Some(from_hunks.unwrap_or_else(|| {
        WholePatchFile::Unavailable(TranscriptPatchFileUnavailable {
            path,
            unavailable: HydratedContentUnavailableReason::Absent,
        })
    }))
}

fn read_git_diff(result: &Map<String, Value>) -> Option<WholePatchFile> {
    let git_diff = result.get("gitDiff")?.as_object()?;
    let path = read_non_empty_string(git_diff, "filename")?;
    let patch = git_diff.get("patch")?.as_str()?;
    let additions = read_count(git_diff, "additions")?;
    let deletions = read_count(git_diff, "deletions")?;
    Some(WholePatchFile::Read {
        path: FilesystemPath::new(path.to_owned()).ok()?,
        patch: patch.to_owned(),
        additions,
        deletions,
    })
}

// Each hunk as its unified header and lines, counted as any unified diff is; `None` when a hunk
// is malformed.
fn read_structured_patch(path: &FilesystemPath, hunks: &[Value]) -> Option<WholePatchFile> {
    let mut text: Vec<String> = Vec::new();
    for hunk in hunks {
        let hunk = hunk.as_object()?;
        let lines = hunk.get("lines")?.as_array()?;
        let old_start = read_count(hunk, "oldStart")?;
        let old_lines = read_count(hunk, "oldLines")?;
        let new_start = read_count(hunk, "newStart")?;
        let new_lines = read_count(hunk, "newLines")?;
        text.push(format!(
            "@@ -{old_start},{old_lines} +{new_start},{new_lines} @@"
        ));
        for line in lines {
            text.push(line.as_str()?.to_owned());
        }
    }
    let patch = text.join("\n");
    let counts = count_unified_diff(&patch);
    Some(WholePatchFile::Read {
        path: path.clone(),
        patch,
        additions: counts.additions,
        deletions: counts.deletions,
    })
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::event::envelope::HydratedContentUnavailableReason;
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::transcript::content::TranscriptPatchFileUnavailable;

    use super::read_claude_patch_file;
    use crate::transcript::whole_patch::WholePatchFile;

    fn path(text: &str) -> FilesystemPath {
        FilesystemPath::new(text.to_owned()).expect("a test path is a valid path")
    }

    #[rstest]
    #[case::git_diff_counts_win(
        json!({
            "filePath": "/work/notes.md",
            "gitDiff": {
                "filename": "notes.md",
                "patch": "@@ -1 +1 @@\n-old\n+new",
                "additions": 7,
                "deletions": 3.0,
            },
            "structuredPatch": [
                {"oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 1,
                 "lines": ["-a", "+b"]},
            ],
        }),
        WholePatchFile::Read {
            path: path("notes.md"),
            patch: "@@ -1 +1 @@\n-old\n+new".to_owned(),
            additions: 7,
            deletions: 3,
        }
    )]
    #[case::hunks_counted(
        json!({
            "filePath": "/work/notes.md",
            "structuredPatch": [
                {"oldStart": 1, "oldLines": 2, "newStart": 1, "newLines": 3,
                 "lines": [" keep", "-gone", "+added", "+also added"]},
                {"oldStart": 9, "oldLines": 1, "newStart": 10, "newLines": 0,
                 "lines": ["--- a rule"]},
            ],
        }),
        WholePatchFile::Read {
            path: path("/work/notes.md"),
            patch: concat!(
                "@@ -1,2 +1,3 @@\n keep\n-gone\n+added\n+also added\n",
                "@@ -9,1 +10,0 @@\n--- a rule",
            )
            .to_owned(),
            additions: 2,
            deletions: 2,
        }
    )]
    #[case::neither_is_unavailable(
        json!({"notebook_path": "/work/book.ipynb", "gitDiff": {"filename": "book.ipynb"}}),
        WholePatchFile::Unavailable(TranscriptPatchFileUnavailable {
            path: path("/work/book.ipynb"),
            unavailable: HydratedContentUnavailableReason::Absent,
        })
    )]
    fn reads_the_patch_a_file_change_carries(
        #[case] tool_use_result: Value,
        #[case] expected: WholePatchFile,
    ) {
        assert_eq!(read_claude_patch_file(&tool_use_result), Some(expected));
    }
}
