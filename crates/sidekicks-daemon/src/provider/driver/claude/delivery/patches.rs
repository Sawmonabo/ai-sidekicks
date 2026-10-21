//! The patch a Claude Code file-changing call made, with the lines it added and removed, read from
//! the call's own result: `gitDiff` where Claude Code sends one; a created file's whole text; a
//! notebook cell's edit, diffed from its old source to its new; else the `structuredPatch` hunks,
//! counted line by line. A result with no patch reads as absent, and one whose patch cannot be read
//! keeps the patch's text as sent.

use std::fmt::Display;

use diffy::Line;
use serde_json::{Map, Value};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::transcript::content::{
    TranscriptPatchAbsentReason, TranscriptPatchUnreadableReason,
};

use crate::provider::driver::unified_diff::{count_unified_diff, mark_every_line};
use crate::provider::record_readers::{read_count, read_non_empty_string};
use crate::transcript::whole_patch::WholePatchFile;

// The tools whose result is one file's change.
const CLAUDE_FILE_CHANGING_TOOL_NAMES: [&str; 4] = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

/// Whether a tool's result is one file's change, read for its patch.
pub(crate) fn is_claude_file_changing_tool(tool_name: &str) -> bool {
    CLAUDE_FILE_CHANGING_TOOL_NAMES.contains(&tool_name)
}

/// The patch one file-changing call's result carries, read in this order: `gitDiff`, a created
/// file's `content`, a notebook cell's sources, then `structuredPatch`, which reads `Absent` when
/// missing or empty and `Unreadable` when malformed. `None` for a result that names no file, or a
/// path the wire refuses (a NUL, past the cap). `tool_use_result` is untrusted provider output.
pub(crate) fn read_claude_patch_file(tool_use_result: &Value) -> Option<WholePatchFile> {
    let result = tool_use_result.as_object()?;
    let path = read_non_empty_string(result, "filePath")
        .or_else(|| read_non_empty_string(result, "notebook_path"))?;
    let path = FilesystemPath::new(path.to_owned()).ok()?;
    let patch = read_git_diff(result)
        .or_else(|| read_created_file(result))
        .or_else(|| read_notebook_cell_edit(result));
    if let Some((patch, additions, deletions)) = patch {
        return Some(WholePatchFile::Read {
            path,
            old_path: None,
            patch,
            additions,
            deletions,
        });
    }
    let hunks = match result.get("structuredPatch") {
        None | Some(Value::Null) => None,
        Some(Value::Array(hunks)) if hunks.is_empty() => None,
        Some(hunks) => Some(hunks),
    };
    let Some(hunks) = hunks else {
        // Claude Code sends no hunks when nothing changed, the diff timed out or the old text was
        // too large to diff.
        return Some(WholePatchFile::Absent {
            path,
            old_path: None,
            unavailable: TranscriptPatchAbsentReason::Value,
        });
    };
    Some(match read_structured_patch(hunks) {
        Some((patch, additions, deletions)) => WholePatchFile::Read {
            path,
            old_path: None,
            patch,
            additions,
            deletions,
        },
        None => WholePatchFile::Unreadable {
            path,
            old_path: None,
            unavailable: TranscriptPatchUnreadableReason::Value,
            raw_patch: hunks.to_string(),
        },
    })
}

// A patch with the lines it adds and removes.
type CountedPatch = (String, u64, u64);

// The counts of `patch` from the provider's own report where it sends both, else its lines.
fn count_patch(patch: String, reported: Option<(u64, u64)>) -> CountedPatch {
    let (additions, deletions) = reported.unwrap_or_else(|| {
        let counts = count_unified_diff(&patch);
        (counts.additions, counts.deletions)
    });
    (patch, additions, deletions)
}

fn read_git_diff(result: &Map<String, Value>) -> Option<CountedPatch> {
    let git_diff = result.get("gitDiff")?.as_object()?;
    let patch = git_diff.get("patch")?.as_str()?;
    let reported = read_count(git_diff, "additions").zip(read_count(git_diff, "deletions"));
    Some(count_patch(patch.to_owned(), reported))
}

// Claude Code sends a created file with no hunks and its whole text in `content`.
fn read_created_file(result: &Map<String, Value>) -> Option<CountedPatch> {
    if result.get("type")?.as_str()? != "create" {
        return None;
    }
    let (patch, additions) = mark_every_line(result.get("content")?.as_str()?, '+');
    Some((patch, additions, 0))
}

// A notebook edit's one cell, from its old source to its new: an inserted cell from nothing, a
// deleted one to nothing. A failed edit, which changed nothing, carries `error` and reads no patch.
fn read_notebook_cell_edit(result: &Map<String, Value>) -> Option<CountedPatch> {
    if result.contains_key("error") {
        return None;
    }
    let old_source = || result.get("old_source")?.as_str();
    let new_source = result.get("new_source")?.as_str()?;
    let (old_source, new_source) = match result.get("edit_mode")?.as_str()? {
        "replace" => (old_source()?, new_source),
        "insert" => ("", new_source),
        "delete" => (old_source()?, ""),
        _ => return None,
    };
    let cell_patch = diffy::create_patch(old_source, new_source);
    let mut text: Vec<String> = Vec::new();
    for hunk in cell_patch.hunks() {
        let (old_range, new_range) = (hunk.old_range(), hunk.new_range());
        text.push(write_hunk_header(
            old_range.start(),
            old_range.len(),
            new_range.start(),
            new_range.len(),
        ));
        for line in hunk.lines() {
            let (mark, line) = match line {
                Line::Context(line) => (' ', *line),
                Line::Delete(line) => ('-', *line),
                Line::Insert(line) => ('+', *line),
            };
            text.push(format!("{mark}{}", line.strip_suffix('\n').unwrap_or(line)));
        }
    }
    Some(count_patch(text.join("\n"), None))
}

// A unified hunk header, both ranges written with their lengths.
fn write_hunk_header(
    old_start: impl Display,
    old_lines: impl Display,
    new_start: impl Display,
    new_lines: impl Display,
) -> String {
    format!("@@ -{old_start},{old_lines} +{new_start},{new_lines} @@")
}

// Each hunk as its unified header and lines, counted as any unified diff is; `None` when the
// hunks are malformed.
fn read_structured_patch(hunks: &Value) -> Option<CountedPatch> {
    let mut text: Vec<String> = Vec::new();
    for hunk in hunks.as_array()? {
        let hunk = hunk.as_object()?;
        let lines = hunk.get("lines")?.as_array()?;
        text.push(write_hunk_header(
            read_count(hunk, "oldStart")?,
            read_count(hunk, "oldLines")?,
            read_count(hunk, "newStart")?,
            read_count(hunk, "newLines")?,
        ));
        for line in lines {
            text.push(line.as_str()?.to_owned());
        }
    }
    Some(count_patch(text.join("\n"), None))
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::transcript::content::{
        TranscriptPatchAbsentReason, TranscriptPatchUnreadableReason,
    };

    use super::read_claude_patch_file;
    use crate::transcript::whole_patch::WholePatchFile;

    fn path(text: &str) -> FilesystemPath {
        FilesystemPath::new(text.to_owned()).expect("a test path is a valid path")
    }

    fn read(patch: &str, additions: u64, deletions: u64) -> WholePatchFile {
        WholePatchFile::Read {
            path: path("/work/notes.md"),
            old_path: None,
            patch: patch.to_owned(),
            additions,
            deletions,
        }
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
        read("@@ -1 +1 @@\n-old\n+new", 7, 3)
    )]
    #[case::git_diff_counts_not_numbers_count_its_lines(
        json!({
            "filePath": "/work/notes.md",
            "gitDiff": {"patch": "@@ -1 +1,2 @@\n-old\n+new\n+added", "additions": "7"},
        }),
        read("@@ -1 +1,2 @@\n-old\n+new\n+added", 2, 1)
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
        read(
            concat!(
                "@@ -1,2 +1,3 @@\n keep\n-gone\n+added\n+also added\n",
                "@@ -9,1 +10,0 @@\n--- a rule",
            ),
            2,
            2,
        )
    )]
    #[case::a_created_file_reads_its_content(
        json!({
            "type": "create",
            "filePath": "/work/notes.md",
            "content": "one\ntwo\n",
            "structuredPatch": [],
        }),
        read("+one\n+two", 2, 0)
    )]
    #[case::a_notebook_edit_reads_its_cell(
        json!({
            "notebook_path": "/work/notes.md",
            "edit_mode": "replace",
            "old_source": "a = 1\nprint(a)",
            "new_source": "a = 2\nprint(a)",
        }),
        read("@@ -1,2 +1,2 @@\n-a = 1\n+a = 2\n print(a)", 1, 1)
    )]
    #[case::empty_hunks_are_absent(
        json!({"type": "update", "filePath": "/work/notes.md", "structuredPatch": []}),
        WholePatchFile::Absent { path: path("/work/notes.md"), old_path: None, unavailable: TranscriptPatchAbsentReason::Value }
    )]
    #[case::no_hunks_are_absent(
        json!({"filePath": "/work/notes.md", "gitDiff": {"filename": "notes.md"}}),
        WholePatchFile::Absent { path: path("/work/notes.md"), old_path: None, unavailable: TranscriptPatchAbsentReason::Value }
    )]
    #[case::malformed_hunks_keep_their_text(
        json!({"filePath": "/work/notes.md", "structuredPatch": [{"oldStart": "x"}]}),
        WholePatchFile::Unreadable {
            path: path("/work/notes.md"),
            old_path: None,
            unavailable: TranscriptPatchUnreadableReason::Value,
            raw_patch: r#"[{"oldStart":"x"}]"#.to_owned(),
        }
    )]
    fn reads_the_patch_a_file_change_carries(
        #[case] tool_use_result: Value,
        #[case] expected: WholePatchFile,
    ) {
        assert_eq!(read_claude_patch_file(&tool_use_result), Some(expected));
    }
}
