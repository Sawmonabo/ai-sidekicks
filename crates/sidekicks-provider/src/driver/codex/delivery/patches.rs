//! The patch of each file a Codex file change touched, with the lines it added and removed,
//! counted from the file's own `diff`: an update's unified diff line by line, an added file's
//! every line added and a deleted file's every line removed, since Codex sends those files whole.
//! A moved file is named by its new path, its old one kept beside it.

use serde_json::{Map, Value};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::transcript::content::{
    TranscriptPatchAbsentReason, TranscriptPatchUnreadableReason,
};
use sidekicks_store::transcript_whole_patch::WholePatchFile;

use crate::driver::unified_diff::{count_unified_diff, mark_every_line};
use crate::record_readers::read_non_empty_string;

/// Where a Codex update left its file (`kind.move_path`).
enum CodexFileMove {
    /// Not moved: no `move_path`, or `null`.
    InPlace,
    /// Moved to this path, as sent.
    To(FilesystemPath),
    /// A `move_path` that names no path the wire can carry.
    Unreadable,
}

/// How Codex says a file changed (`PatchChangeKind`).
enum CodexPatchChangeKind {
    Add,
    Delete,
    Update(CodexFileMove),
}

// Codex sends the kind as {type} or as the bare word.
fn read_change_kind(change: &Map<String, Value>) -> Option<CodexPatchChangeKind> {
    let kind = change.get("kind")?;
    let (word, move_path) = match kind.as_object() {
        Some(kind) => (kind.get("type")?, kind.get("move_path")),
        None => (kind, None),
    };
    match word.as_str()? {
        "add" => Some(CodexPatchChangeKind::Add),
        "delete" => Some(CodexPatchChangeKind::Delete),
        "update" => Some(CodexPatchChangeKind::Update(match move_path {
            None | Some(Value::Null) => CodexFileMove::InPlace,
            Some(move_path) => move_path
                .as_str()
                .and_then(|move_path| FilesystemPath::new(move_path.to_owned()).ok())
                .map_or(CodexFileMove::Unreadable, CodexFileMove::To),
        })),
        _ => None,
    }
}

/// One `FileUpdateChange` as a patch with its counts; `Absent` when it carries no `diff`, and
/// `Unreadable`, with the text as sent, when its `diff`, kind or `move_path` cannot be read.
/// `None` when it names no file the wire can carry.
fn read_codex_patch_file(change: &Value) -> Option<WholePatchFile> {
    let change = change.as_object()?;
    let path = FilesystemPath::new(read_non_empty_string(change, "path")?.to_owned()).ok()?;
    let kind = read_change_kind(change);
    // A move is named by its new path; an unreadable `move_path` leaves the change's own.
    let (named_path, old_path) =
        if let Some(CodexPatchChangeKind::Update(CodexFileMove::To(new_path))) = &kind {
            (new_path.clone(), Some(path.clone()))
        } else {
            (path.clone(), None)
        };
    let diff = match change.get("diff") {
        None | Some(Value::Null) => {
            return Some(WholePatchFile::Absent {
                path: named_path,
                old_path,
                unavailable: TranscriptPatchAbsentReason::Value,
            });
        }
        Some(Value::String(diff)) => diff,
        Some(diff) => {
            return Some(WholePatchFile::Unreadable {
                path: named_path,
                old_path,
                unavailable: TranscriptPatchUnreadableReason::Value,
                raw_patch: diff.to_string(),
            });
        }
    };
    Some(match kind {
        None | Some(CodexPatchChangeKind::Update(CodexFileMove::Unreadable)) => {
            WholePatchFile::Unreadable {
                path,
                old_path: None,
                unavailable: TranscriptPatchUnreadableReason::Value,
                raw_patch: diff.clone(),
            }
        }
        Some(CodexPatchChangeKind::Update(CodexFileMove::InPlace)) => {
            read_unified_diff(named_path, old_path, diff)
        }
        // Codex's app-server appends the move to a moved file's diff; its own terminal app strips
        // that exact line, and so does this read.
        Some(CodexPatchChangeKind::Update(CodexFileMove::To(new_path))) => {
            let suffix = format!("\n\nMoved to: {}", new_path.as_str());
            read_unified_diff(
                named_path,
                old_path,
                diff.strip_suffix(&suffix).unwrap_or(diff),
            )
        }
        Some(CodexPatchChangeKind::Add) => {
            let (patch, additions) = mark_every_line(diff, '+');
            WholePatchFile::Read {
                path: named_path,
                old_path,
                patch,
                additions,
                deletions: 0,
            }
        }
        Some(CodexPatchChangeKind::Delete) => {
            let (patch, deletions) = mark_every_line(diff, '-');
            WholePatchFile::Read {
                path: named_path,
                old_path,
                patch,
                additions: 0,
                deletions,
            }
        }
    })
}

fn read_unified_diff(
    path: FilesystemPath,
    old_path: Option<FilesystemPath>,
    patch: &str,
) -> WholePatchFile {
    let counts = count_unified_diff(patch);
    WholePatchFile::Read {
        path,
        old_path,
        patch: patch.to_owned(),
        additions: counts.additions,
        deletions: counts.deletions,
    }
}

/// Every file a `fileChange` item's `changes` touched, each with its whole patch and counts, or
/// why there is none; a change that names no file, or one whose path the wire refuses, is skipped.
pub(crate) fn read_codex_patch_files(item: &Map<String, Value>) -> Vec<WholePatchFile> {
    item.get("changes")
        .and_then(Value::as_array)
        .map(|changes| changes.iter().filter_map(read_codex_patch_file).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::transcript::content::{
        TranscriptPatchAbsentReason, TranscriptPatchUnreadableReason,
    };
    use sidekicks_store::transcript_whole_patch::WholePatchFile;

    use super::read_codex_patch_files;

    fn path(text: &str) -> FilesystemPath {
        FilesystemPath::new(text.to_owned()).expect("a test path is a valid path")
    }

    fn read(
        path_text: &str,
        old_path: Option<&str>,
        patch: &str,
        additions: u64,
        deletions: u64,
    ) -> WholePatchFile {
        WholePatchFile::Read {
            path: path(path_text),
            old_path: old_path.map(path),
            patch: patch.to_owned(),
            additions,
            deletions,
        }
    }

    #[rstest]
    #[case::update_counts_its_hunks(
        json!({
            "path": "/w/a.md",
            "kind": {"type": "update"},
            "diff": "@@ -1 +1,2 @@\n-old\n+new\n+added",
        }),
        read("/w/a.md", None, "@@ -1 +1,2 @@\n-old\n+new\n+added", 2, 1)
    )]
    #[case::empty_added_file_has_no_line(
        json!({"path": "/w/a.md", "kind": "add", "diff": ""}),
        read("/w/a.md", None, "", 0, 0)
    )]
    #[case::added_file_counts_whole(
        json!({"path": "/w/a.md", "kind": {"type": "add"}, "diff": "one\ntwo\n"}),
        read("/w/a.md", None, "+one\n+two", 2, 0)
    )]
    #[case::deleted_file_counts_whole(
        json!({"path": "/w/a.md", "kind": "delete", "diff": "one\n\nthree"}),
        read("/w/a.md", None, "-one\n-\n-three", 0, 3)
    )]
    #[case::no_diff_is_absent(
        json!({"path": "/w/a.md", "kind": {"type": "update", "move_path": null}}),
        WholePatchFile::Absent {
            path: path("/w/a.md"),
            old_path: None,
            unavailable: TranscriptPatchAbsentReason::Value,
        }
    )]
    #[case::a_move_with_no_diff_is_absent_under_its_new_path(
        json!({"path": "/w/old.rs", "kind": {"type": "update", "move_path": "/w/new.rs"}}),
        WholePatchFile::Absent {
            path: path("/w/new.rs"),
            old_path: Some(path("/w/old.rs")),
            unavailable: TranscriptPatchAbsentReason::Value,
        }
    )]
    #[case::a_diff_not_text_is_unreadable(
        json!({"path": "/w/a.md", "kind": {"type": "update", "move_path": null}, "diff": 5}),
        WholePatchFile::Unreadable {
            path: path("/w/a.md"),
            old_path: None,
            unavailable: TranscriptPatchUnreadableReason::Value,
            raw_patch: "5".to_owned(),
        }
    )]
    #[case::no_kind_is_unreadable(
        json!({"path": "/w/a.md", "diff": "@@ -1 +1 @@\n-a\n+b"}),
        WholePatchFile::Unreadable {
            path: path("/w/a.md"),
            old_path: None,
            unavailable: TranscriptPatchUnreadableReason::Value,
            raw_patch: "@@ -1 +1 @@\n-a\n+b".to_owned(),
        }
    )]
    #[case::an_unknown_kind_is_unreadable(
        json!({"path": "/w/a.md", "kind": {"type": "rename"}, "diff": "@@ -1 +1 @@\n-a\n+b"}),
        WholePatchFile::Unreadable {
            path: path("/w/a.md"),
            old_path: None,
            unavailable: TranscriptPatchUnreadableReason::Value,
            raw_patch: "@@ -1 +1 @@\n-a\n+b".to_owned(),
        }
    )]
    #[case::a_move_is_named_by_its_new_path(
        json!({
            "path": "/w/old.rs",
            "kind": {"type": "update", "move_path": "/w/new.rs"},
            "diff": "@@ -1 +1 @@\n-a\n+b\n\nMoved to: /w/new.rs",
        }),
        read("/w/new.rs", Some("/w/old.rs"), "@@ -1 +1 @@\n-a\n+b", 1, 1)
    )]
    #[case::a_move_with_no_lines_reads_empty(
        json!({
            "path": "/w/old.rs",
            "kind": {"type": "update", "move_path": "/w/new.rs"},
            "diff": "\n\nMoved to: /w/new.rs",
        }),
        read("/w/new.rs", Some("/w/old.rs"), "", 0, 0)
    )]
    #[case::an_unreadable_move_keeps_the_text_as_sent(
        json!({
            "path": "/w/old.rs",
            "kind": {"type": "update", "move_path": 7},
            "diff": "@@ -1 +1 @@\n-a\n+b\n\nMoved to: 7",
        }),
        WholePatchFile::Unreadable {
            path: path("/w/old.rs"),
            old_path: None,
            unavailable: TranscriptPatchUnreadableReason::Value,
            raw_patch: "@@ -1 +1 @@\n-a\n+b\n\nMoved to: 7".to_owned(),
        }
    )]
    #[case::a_null_move_is_a_plain_update(
        json!({
            "path": "/w/a.md",
            "kind": {"type": "update", "move_path": null},
            "diff": "@@ -1 +1 @@\n-a\n+b",
        }),
        read("/w/a.md", None, "@@ -1 +1 @@\n-a\n+b", 1, 1)
    )]
    fn reads_each_change_as_its_whole_patch(
        #[case] change: Value,
        #[case] expected: WholePatchFile,
    ) {
        let item = json!({"changes": [change]});

        assert_eq!(
            read_codex_patch_files(item.as_object().expect("an object")),
            vec![expected]
        );
    }
}
