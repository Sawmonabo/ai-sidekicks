//! The reading of one command window's evidence into the versions it records. A path a linked
//! shadow names is read by that shadow's comparison alone; a path with none is read by its
//! `diff-tree` letter between the window's two trees, or, when the after-capture left it out as
//! large or unread with no letter, as created. The reading reads no file and no row: its caller
//! gathers the evidence and writes what it answers.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_workspace::git::GITLINK_MODE;
use sidekicks_workspace::git::turn_snapshot::command_capture::{TreeChange, TreeEntry};

use crate::checkpoints::schema::NotKeptReason;
use crate::checkpoints::shadows::{ShadowComparison, recorded_path};
use crate::checkpoints::store::shadows::{Shadow, ShadowContent, ShadowId};

/// The git mode of a regular file.
const REGULAR_FILE_MODE: u32 = 0o100_644;

/// The git mode of an executable file.
const EXECUTABLE_FILE_MODE: u32 = 0o100_755;

/// The git mode of a symbolic link.
const SYMBOLIC_LINK_MODE: u32 = 0o120_000;

/// The git mode of a gitlink, read from the text git writes for it.
const GITLINK: u32 = match u32::from_str_radix(GITLINK_MODE, 8) {
    Ok(mode) => mode,
    Err(_) => panic!("git's gitlink mode is octal"),
};

/// What one window's close knows: the shadows its before-capture stood on, each compared with the
/// file at the after-capture, the paths the two trees differ at, and what the after-capture left
/// out. Every path but a shadow's is relative to the checkout.
#[derive(Clone, Copy, Debug)]
pub struct WindowChanges<'window> {
    /// The checkout's real path, which every recorded path is named under.
    pub checkout_real_path: &'window Path,
    /// The shadows the window's before-capture stood on, each with whether its file changed since.
    pub linked_shadows: &'window [(Shadow, ShadowComparison)],
    /// The paths whose shadow's take at the before-capture found no file.
    pub absent_before: &'window HashSet<PathBuf>,
    /// The paths whose entry differs between the window's two capture trees.
    pub changes: &'window [TreeChange],
    /// The after-capture's large and unread paths, which its tree left out.
    pub after_left_out: &'window [PathBuf],
    /// The paths the window's checkpoint already records, whose earlier version an undo puts back.
    pub recorded: &'window HashSet<FilesystemPath>,
}

/// What a version keeps of its path's content before the command, before any copy is made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlannedContent {
    /// The before tree's blob, which the caller copies, put back with its executable bit.
    BeforeImage {
        /// The blob.
        blob: GitObjectId,
        /// Whether the before entry was executable.
        is_executable: bool,
    },
    /// The path was absent before the command, so an undo removes it.
    Created,
    /// No copy can be kept, for `reason`.
    NotKept(NotKeptReason),
    /// The content before is the clone this shadow keeps.
    Shadow(ShadowId),
}

/// One version a window records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedVersion {
    /// The path, under the checkout's real path.
    pub path: FilesystemPath,
    /// The real path of the folder holding it.
    pub parent_real_path: FilesystemPath,
    /// What it keeps of the path's content before the command.
    pub content: PlannedContent,
}

/// What one window records: its versions, the paths that take a fresh shadow at the close, the
/// current shadows the close retires, and the paths no row can name. A path takes a fresh shadow
/// or has its shadow retired, never both, since the fresh take retires the current one itself.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WindowReading {
    /// The versions, by path.
    pub versions: Vec<PlannedVersion>,
    /// The paths, relative to the checkout, whose file the close shadows afresh.
    pub fresh_shadows: Vec<PathBuf>,
    /// The current shadows of paths that are no longer large, which the close retires.
    pub retired_shadows: Vec<ShadowId>,
    /// The paths no row can name, not UTF-8 or past the length bound, and a linked shadow's path
    /// that lies outside the checkout; none records anything.
    pub unnamable: Vec<PathBuf>,
}

/// `relative` named under the checkout's real path, its components pushed one at a time so the
/// separators are the system's. `None` when no row can hold it: not UTF-8, or past the length
/// bound.
pub fn checkout_path(checkout_real_path: &Path, relative: &Path) -> Option<FilesystemPath> {
    let mut path = checkout_real_path.to_path_buf();
    for component in relative.components() {
        path.push(component);
    }
    recorded_path(&path).ok()
}

/// The versions one window records, the fresh shadows its close takes and the shadows it retires,
/// read from `changes` alone.
pub fn read_window_changes(changes: &WindowChanges<'_>) -> WindowReading {
    let mut reading = WindowReading::default();
    let mut by_path: BTreeMap<&Path, PathEvidence<'_>> = BTreeMap::new();
    for (shadow, comparison) in changes.linked_shadows {
        let shadow_path = Path::new(shadow.path.as_str());
        match shadow_path.strip_prefix(changes.checkout_real_path) {
            Ok(relative) => {
                by_path.entry(relative).or_default().record = Some((shadow, *comparison));
            }
            Err(_) => reading.unnamable.push(shadow_path.to_path_buf()),
        }
    }
    for change in changes.changes {
        by_path.entry(changed_path(change)).or_default().change = Some(change);
    }
    for left_out in changes.after_left_out {
        by_path.entry(left_out).or_default().is_left_out_after = true;
    }
    for (relative, evidence) in by_path {
        // A path with no parent sits at the checkout's top.
        let parent = relative.parent().unwrap_or_else(|| Path::new(""));
        let (Some(path), Some(parent_real_path)) = (
            checkout_path(changes.checkout_real_path, relative),
            checkout_path(changes.checkout_real_path, parent),
        ) else {
            reading.unnamable.push(relative.to_path_buf());
            continue;
        };
        let (content, shadow_step) = read_path(&evidence, changes.absent_before.contains(relative));
        match shadow_step {
            ShadowStep::Keep => {}
            ShadowStep::Fresh => reading.fresh_shadows.push(relative.to_path_buf()),
            ShadowStep::Retire(shadow_id) => reading.retired_shadows.push(shadow_id),
        }
        // The checkpoint's earlier version of the path is the one an undo puts back.
        if let Some(content) = content
            && !changes.recorded.contains(&path)
        {
            reading.versions.push(PlannedVersion {
                path,
                parent_real_path,
                content,
            });
        }
    }
    reading
}

/// What the window knows of one path.
#[derive(Default)]
struct PathEvidence<'window> {
    /// The linked shadow of the path, with its comparison.
    record: Option<(&'window Shadow, ShadowComparison)>,
    /// The path's letter between the two trees.
    change: Option<&'window TreeChange>,
    /// Whether the after-capture left the path out as large or unread.
    is_left_out_after: bool,
}

/// What the close does with a path's shadow.
enum ShadowStep {
    /// Nothing: its current shadow, if any, stays.
    Keep,
    /// Takes a fresh shadow of the file, which retires the current one.
    Fresh,
    /// Retires the current shadow, since the file is no longer large.
    Retire(ShadowId),
}

// Reads one path: by its linked shadow when it has one, else by its letter, else as a file the
// after-capture left out with no letter, which the before-capture never saw.
fn read_path(
    evidence: &PathEvidence<'_>,
    is_absent_before: bool,
) -> (Option<PlannedContent>, ShadowStep) {
    let fresh_or = |otherwise| {
        if evidence.is_left_out_after {
            ShadowStep::Fresh
        } else {
            otherwise
        }
    };
    if let Some((shadow, comparison)) = evidence.record {
        return match comparison {
            ShadowComparison::Unchanged => (None, ShadowStep::Keep),
            ShadowComparison::Changed => {
                let content = match &shadow.content {
                    ShadowContent::Cloned { .. } => PlannedContent::Shadow(shadow.shadow_id),
                    ShadowContent::NotKept { reason } => PlannedContent::NotKept(*reason),
                };
                (
                    Some(content),
                    fresh_or(ShadowStep::Retire(shadow.shadow_id)),
                )
            }
        };
    }
    // A submodule's files are never put back, nor is a submodule removed.
    if evidence.change.is_some_and(is_gitlink_change) {
        return (None, ShadowStep::Keep);
    }
    let fresh = fresh_or(ShadowStep::Keep);
    // A tree's entry for a path whose take found nothing is a stale blob of the kept index.
    if is_absent_before {
        let is_standing_after = evidence.is_left_out_after
            || matches!(
                evidence.change,
                Some(
                    TreeChange::Added { .. }
                        | TreeChange::Modified { .. }
                        | TreeChange::TypeChanged { .. }
                )
            );
        return (is_standing_after.then_some(PlannedContent::Created), fresh);
    }
    let content = match evidence.change {
        None | Some(TreeChange::Added { .. }) => PlannedContent::Created,
        Some(
            TreeChange::Deleted { before, .. }
            | TreeChange::Modified { before, .. }
            | TreeChange::TypeChanged { before, .. },
        ) => before_image(before),
    };
    (Some(content), fresh)
}

// The content a path's before entry keeps.
fn before_image(before: &TreeEntry) -> PlannedContent {
    match before.mode {
        REGULAR_FILE_MODE | EXECUTABLE_FILE_MODE => PlannedContent::BeforeImage {
            blob: before.object.clone(),
            is_executable: before.mode == EXECUTABLE_FILE_MODE,
        },
        SYMBOLIC_LINK_MODE => PlannedContent::NotKept(NotKeptReason::SymbolicLink),
        _ => PlannedContent::NotKept(NotKeptReason::Failed),
    }
}

// Whether a gitlink stands on either side of the change.
fn is_gitlink_change(change: &TreeChange) -> bool {
    match change {
        TreeChange::Added { after, .. } => after.mode == GITLINK,
        TreeChange::Deleted { before, .. } => before.mode == GITLINK,
        TreeChange::Modified { before, after, .. }
        | TreeChange::TypeChanged { before, after, .. } => {
            before.mode == GITLINK || after.mode == GITLINK
        }
    }
}

fn changed_path(change: &TreeChange) -> &Path {
    match change {
        TreeChange::Added { path, .. }
        | TreeChange::Deleted { path, .. }
        | TreeChange::Modified { path, .. }
        | TreeChange::TypeChanged { path, .. } => path,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    use std::sync::LazyLock;
    use std::time::Duration;

    use rstest::rstest;
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::repo::git_reads::GitObjectId;
    use sidekicks_store::database::writer::test_file::test_session_id;
    use sidekicks_workspace::git::turn_snapshot::command_capture::{TreeChange, TreeEntry};

    use super::{
        PlannedContent, PlannedVersion, WindowChanges, WindowReading, checkout_path,
        read_window_changes,
    };
    use crate::checkpoints::schema::NotKeptReason;
    use crate::checkpoints::shadows::ShadowComparison;
    use crate::checkpoints::store::shadows::{Shadow, ShadowContent, ShadowId};

    const CHECKOUT: &str = "/repo";

    /// The one shadow a case links, so its expected reading can name it.
    static SHADOW_ID: LazyLock<ShadowId> = LazyLock::new(ShadowId::mint);

    /// One window's evidence, owned, built path by path.
    #[derive(Default)]
    struct Evidence {
        linked: Vec<(Shadow, ShadowComparison)>,
        absent_before: HashSet<PathBuf>,
        changes: Vec<TreeChange>,
        after_left_out: Vec<PathBuf>,
        recorded: HashSet<FilesystemPath>,
    }

    impl Evidence {
        /// Links the case's shadow of `relative`, holding `content`, compared as `comparison`.
        fn record(
            mut self,
            relative: &str,
            content: ShadowContent,
            comparison: ShadowComparison,
        ) -> Self {
            let shadow = Shadow {
                shadow_id: *SHADOW_ID,
                session_id: test_session_id(),
                path: path(&format!("{CHECKOUT}/{relative}")),
                content,
                facts: None,
                taken_at: jiff::Timestamp::UNIX_EPOCH,
                time_precision: Duration::from_nanos(1),
            };
            self.linked.push((shadow, comparison));
            self
        }

        fn change(mut self, change: TreeChange) -> Self {
            self.changes.push(change);
            self
        }

        fn left_out(mut self, relative: &str) -> Self {
            self.after_left_out.push(PathBuf::from(relative));
            self
        }

        fn absent(mut self, relative: &str) -> Self {
            self.absent_before.insert(PathBuf::from(relative));
            self
        }

        fn recorded(mut self, relative: &str) -> Self {
            self.recorded
                .insert(path(&format!("{CHECKOUT}/{relative}")));
            self
        }

        fn read(&self) -> WindowReading {
            read_window_changes(&WindowChanges {
                checkout_real_path: Path::new(CHECKOUT),
                linked_shadows: &self.linked,
                absent_before: &self.absent_before,
                changes: &self.changes,
                after_left_out: &self.after_left_out,
                recorded: &self.recorded,
            })
        }
    }

    fn path(text: &str) -> FilesystemPath {
        FilesystemPath::new(text.to_owned()).expect("a test path")
    }

    fn cloned() -> ShadowContent {
        ShadowContent::Cloned {
            clone_path: path("/owner/captures/large/clone"),
            volume_id: None,
        }
    }

    fn no_clone(reason: NotKeptReason) -> ShadowContent {
        ShadowContent::NotKept { reason }
    }

    /// The before tree's blob, which a stale kept index may also hold.
    fn before_blob() -> GitObjectId {
        GitObjectId::new("b".repeat(40)).expect("a test object id")
    }

    fn entry(mode: u32, digit: &str) -> TreeEntry {
        TreeEntry {
            mode,
            object: GitObjectId::new(digit.repeat(40)).expect("a test object id"),
        }
    }

    fn added(relative: &str, mode: u32) -> TreeChange {
        TreeChange::Added {
            path: PathBuf::from(relative),
            after: entry(mode, "a"),
        }
    }

    fn deleted(relative: &str, mode: u32) -> TreeChange {
        TreeChange::Deleted {
            path: PathBuf::from(relative),
            before: entry(mode, "b"),
        }
    }

    fn modified(relative: &str, before: u32, after: u32) -> TreeChange {
        TreeChange::Modified {
            path: PathBuf::from(relative),
            before: entry(before, "b"),
            after: entry(after, "a"),
        }
    }

    fn type_changed(relative: &str, before: u32, after: u32) -> TreeChange {
        TreeChange::TypeChanged {
            path: PathBuf::from(relative),
            before: entry(before, "b"),
            after: entry(after, "a"),
        }
    }

    /// The reading of one version of `recorded_path` in `parent`, with what it shadows.
    fn reading(
        recorded_path: &str,
        parent: &str,
        content: PlannedContent,
        fresh: &[&str],
        is_retired: bool,
    ) -> WindowReading {
        WindowReading {
            versions: vec![PlannedVersion {
                path: path(recorded_path),
                parent_real_path: path(parent),
                content,
            }],
            ..shadow_steps(fresh, is_retired)
        }
    }

    /// A reading with no version, only what it shadows.
    fn shadow_steps(fresh: &[&str], is_retired: bool) -> WindowReading {
        WindowReading {
            fresh_shadows: fresh.iter().map(PathBuf::from).collect(),
            retired_shadows: if is_retired {
                vec![*SHADOW_ID]
            } else {
                Vec::new()
            },
            ..WindowReading::default()
        }
    }

    fn the_shadow() -> PlannedContent {
        PlannedContent::Shadow(*SHADOW_ID)
    }

    fn before_image(is_executable: bool) -> PlannedContent {
        PlannedContent::BeforeImage {
            blob: before_blob(),
            is_executable,
        }
    }

    // Kills: a letter read for a path its shadow records, an unchanged shadow recorded, a gitlink
    // copied or removed, a link copied as a file, the before entry's executable bit dropped, a path
    // the checkpoint records recorded twice, a fresh shadow missed for a file that grew past the
    // bound, a stale blob copied for a path absent before, a path both fresh and retired, and the
    // parent of a top-level file named as anything but the checkout.
    #[rstest]
    #[case::shadow_unchanged_tracked(
        Evidence::default()
            .record("data/big.bin", cloned(), ShadowComparison::Unchanged)
            .change(deleted("data/big.bin", 0o100_644))
            .left_out("data/big.bin"),
        WindowReading::default()
    )]
    #[case::shadow_changed_then_deleted(
        Evidence::default()
            .record("data/big.bin", cloned(), ShadowComparison::Changed)
            .change(deleted("data/big.bin", 0o100_644)),
        reading("/repo/data/big.bin", "/repo/data", the_shadow(), &[], true)
    )]
    #[case::shadow_changed_still_large(
        Evidence::default()
            .record("data/big.bin", cloned(), ShadowComparison::Changed)
            .change(deleted("data/big.bin", 0o100_644))
            .left_out("data/big.bin"),
        reading("/repo/data/big.bin", "/repo/data", the_shadow(), &["data/big.bin"], false)
    )]
    #[case::shadow_changed_small_untracked(
        Evidence::default()
            .record("big.bin", cloned(), ShadowComparison::Changed)
            .change(added("big.bin", 0o100_644)),
        reading("/repo/big.bin", "/repo", the_shadow(), &[], true)
    )]
    #[case::shadow_changed_small_tracked(
        Evidence::default()
            .record("big.bin", cloned(), ShadowComparison::Changed)
            .change(modified("big.bin", 0o100_644, 0o100_644)),
        reading("/repo/big.bin", "/repo", the_shadow(), &[], true)
    )]
    #[case::shadow_without_clone(
        Evidence::default().record(
            "big.bin",
            no_clone(NotKeptReason::NoPlaceOnVolume),
            ShadowComparison::Changed
        ),
        reading(
            "/repo/big.bin",
            "/repo",
            PlannedContent::NotKept(NotKeptReason::NoPlaceOnVolume),
            &[],
            true
        )
    )]
    #[case::shadow_without_clone_still_large(
        Evidence::default()
            .record("big.bin", no_clone(NotKeptReason::TooLarge), ShadowComparison::Changed)
            .left_out("big.bin"),
        reading(
            "/repo/big.bin",
            "/repo",
            PlannedContent::NotKept(NotKeptReason::TooLarge),
            &["big.bin"],
            false
        )
    )]
    #[case::absent_before_standing_after(
        Evidence::default()
            .absent("big.bin")
            .change(modified("big.bin", 0o100_644, 0o100_644)),
        reading("/repo/big.bin", "/repo", PlannedContent::Created, &[], false)
    )]
    #[case::absent_before_large_after(
        Evidence::default().absent("big.bin").left_out("big.bin"),
        reading("/repo/big.bin", "/repo", PlannedContent::Created, &["big.bin"], false)
    )]
    #[case::absent_before_gone_after(
        Evidence::default()
            .absent("big.bin")
            .change(deleted("big.bin", 0o100_644)),
        WindowReading::default()
    )]
    #[case::added(
        Evidence::default().change(added("src/new.rs", 0o100_644)),
        reading("/repo/src/new.rs", "/repo/src", PlannedContent::Created, &[], false)
    )]
    #[case::deleted_file(
        Evidence::default().change(deleted("src/old.rs", 0o100_644)),
        reading("/repo/src/old.rs", "/repo/src", before_image(false), &[], false)
    )]
    #[case::modified_executable(
        Evidence::default().change(modified("run.sh", 0o100_755, 0o100_755)),
        reading("/repo/run.sh", "/repo", before_image(true), &[], false)
    )]
    #[case::executable_became_a_link(
        Evidence::default().change(type_changed("run.sh", 0o100_755, 0o120_000)),
        reading("/repo/run.sh", "/repo", before_image(true), &[], false)
    )]
    #[case::grew_past_the_bound(
        Evidence::default()
            .change(deleted("data.csv", 0o100_644))
            .left_out("data.csv"),
        reading("/repo/data.csv", "/repo", before_image(false), &["data.csv"], false)
    )]
    #[case::link_before(
        Evidence::default()
            .change(type_changed("current", 0o120_000, 0o100_644))
            .left_out("current"),
        reading(
            "/repo/current",
            "/repo",
            PlannedContent::NotKept(NotKeptReason::SymbolicLink),
            &["current"],
            false
        )
    )]
    #[case::gitlink_before(
        Evidence::default()
            .change(type_changed("vendor/lib", 0o160_000, 0o100_644))
            .left_out("vendor/lib"),
        WindowReading::default()
    )]
    #[case::gitlink_added(
        Evidence::default().change(added("vendor/lib", 0o160_000)),
        WindowReading::default()
    )]
    #[case::other_before_mode(
        Evidence::default().change(deleted("odd", 0o040_000)),
        reading(
            "/repo/odd",
            "/repo",
            PlannedContent::NotKept(NotKeptReason::Failed),
            &[],
            false
        )
    )]
    #[case::large_with_no_letter(
        Evidence::default().left_out("big.bin"),
        reading("/repo/big.bin", "/repo", PlannedContent::Created, &["big.bin"], false)
    )]
    #[case::recorded_by_letter(
        Evidence::default()
            .recorded("src/old.rs")
            .change(deleted("src/old.rs", 0o100_644)),
        WindowReading::default()
    )]
    #[case::recorded_by_shadow(
        Evidence::default()
            .recorded("big.bin")
            .record("big.bin", cloned(), ShadowComparison::Changed),
        shadow_steps(&[], true)
    )]
    #[case::unnamable(
        Evidence::default().change(deleted(&"x".repeat(5000), 0o100_644)),
        WindowReading {
            unnamable: vec![PathBuf::from("x".repeat(5000))],
            ..WindowReading::default()
        }
    )]
    fn a_window_records_each_path_by_its_best_evidence(
        #[case] evidence: Evidence,
        #[case] expected: WindowReading,
    ) {
        assert_eq!(evidence.read(), expected);
    }

    // Kills: a separator other than the system's, and the checkout's top named as anything but the
    // checkout itself.
    #[rstest]
    #[case::nested("src/lib/main.rs", "/repo/src/lib/main.rs")]
    #[case::top_level("main.rs", "/repo/main.rs")]
    #[case::the_checkout("", "/repo")]
    fn a_relative_path_is_named_under_the_checkout(#[case] relative: &str, #[case] named: &str) {
        assert_eq!(
            checkout_path(Path::new(CHECKOUT), Path::new(relative)),
            Some(path(named))
        );
    }

    // Kills: a path that is not UTF-8 renamed lossily, which would name another file.
    #[cfg(unix)]
    #[test]
    fn a_path_that_is_not_utf8_is_not_named() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt as _;

        let relative = Path::new(OsStr::from_bytes(b"caf\xe9.txt"));
        assert_eq!(checkout_path(Path::new(CHECKOUT), relative), None);
    }
}
