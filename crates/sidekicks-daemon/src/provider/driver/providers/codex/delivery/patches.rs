//! The patch of each file a Codex file change touched, with the lines it added and removed,
//! counted from the file's own `diff`: an update's unified diff line by line, an added file's
//! every line added and a deleted file's every line removed, since Codex sends those files whole.

use serde_json::{Map, Value};
use sidekicks_contracts::free_form_string::FilesystemPath;

use crate::provider::driver::unified_diff::count_unified_diff;
use crate::provider::record_readers::read_non_empty_string;
use crate::transcript::whole_patch::WholePatchFile;

/// How Codex says a file changed (`PatchChangeKind`).
#[derive(Clone, Copy)]
enum CodexPatchChangeKind {
    Add,
    Delete,
    Update,
}

/// The change's kind, sent as `{type}` or as the bare word.
fn read_change_kind(change: &Map<String, Value>) -> Option<CodexPatchChangeKind> {
    let kind = change.get("kind")?;
    let kind = kind
        .as_object()
        .map_or(Some(kind), |kind| kind.get("type"))?;
    match kind.as_str()? {
        "add" => Some(CodexPatchChangeKind::Add),
        "delete" => Some(CodexPatchChangeKind::Delete),
        "update" => Some(CodexPatchChangeKind::Update),
        _ => None,
    }
}

/// A whole file's text as patch lines, each with `mark`, and how many there are. A file that ends
/// in a newline has no line after it, and an empty file has none at all.
fn mark_every_line(text: &str, mark: char) -> (String, u64) {
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

/// One `FileUpdateChange` as a patch with its counts, or `None` when it names no file the wire can
/// carry, has no diff or has an unknown kind.
fn read_codex_patch_file(change: &Value) -> Option<WholePatchFile> {
    let change = change.as_object()?;
    let path = read_non_empty_string(change, "path")?;
    let diff = change.get("diff")?.as_str()?;
    let kind = read_change_kind(change)?;
    let path = FilesystemPath::new(path.to_owned()).ok()?;
    Some(match kind {
        CodexPatchChangeKind::Update => {
            let counts = count_unified_diff(diff);
            WholePatchFile::Read {
                path,
                patch: diff.to_owned(),
                additions: counts.additions,
                deletions: counts.deletions,
            }
        }
        CodexPatchChangeKind::Add => {
            let (patch, additions) = mark_every_line(diff, '+');
            WholePatchFile::Read {
                path,
                patch,
                additions,
                deletions: 0,
            }
        }
        CodexPatchChangeKind::Delete => {
            let (patch, deletions) = mark_every_line(diff, '-');
            WholePatchFile::Read {
                path,
                patch,
                additions: 0,
                deletions,
            }
        }
    })
}

/// Every file a `fileChange` item's `changes` touched, each with its whole patch and counts; a
/// change that names no file, or one whose path the wire refuses, is skipped.
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

    use super::read_codex_patch_files;
    use crate::transcript::whole_patch::WholePatchFile;

    #[rstest]
    #[case::update_counts_its_hunks(
        json!({"type": "update"}),
        "--- a/notes.md\n+++ b/notes.md\n@@ -1 +1,2 @@\n-old\n+new\n+added",
        "--- a/notes.md\n+++ b/notes.md\n@@ -1 +1,2 @@\n-old\n+new\n+added",
        2,
        1
    )]
    #[case::empty_added_file_has_no_line(json!("add"), "", "", 0, 0)]
    #[case::added_file_counts_whole(json!({"type": "add"}), "one\ntwo\n", "+one\n+two", 2, 0)]
    #[case::deleted_file_counts_whole(json!("delete"), "one\n\nthree", "-one\n-\n-three", 0, 3)]
    fn reads_each_change_as_its_whole_patch(
        #[case] kind: Value,
        #[case] diff: &str,
        #[case] patch: &str,
        #[case] additions: u64,
        #[case] deletions: u64,
    ) {
        let item = json!({"changes": [{"path": "notes.md", "kind": kind, "diff": diff}]});
        let item = item.as_object().unwrap();

        assert_eq!(
            read_codex_patch_files(item),
            vec![WholePatchFile::Read {
                path: FilesystemPath::new("notes.md".to_owned()).unwrap(),
                patch: patch.to_owned(),
                additions,
                deletions,
            }]
        );
    }
}
