//! What a sweep packs again in a capture folder beyond each capture's own pack: the trees of
//! captures whose base no ref reaches, the captures whose own pack failed, packed on their base's
//! tree as their pack would have, and the folder's loose objects.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_std::mutex_lock::lock;

use super::answers::{BasePresence, read_bases_present, read_object_ids};
use super::{
    BaseReach, CapturePacking, CapturedCommit, PACK_SIZE_LIMIT_PIN, PATH_WALK_PIN, PackingError,
    SnapshotPoint, log_base_lost, pack_name_base,
};
use crate::git::cat_file::object_lines;
use crate::git::process::GitCall;
use crate::git::turn_snapshot::capture::CORE_FSYNC_PIN;
use crate::git::turn_snapshot::capture_folder::{CaptureFolder, in_git_folder};
use crate::git::turn_snapshot::capture_steps::UNRESOLVED_NAME_EXIT_CODE;
use crate::git::turn_snapshot::diagnostics::CaptureDiagnostic;

/// The captures of one capture folder whose own pack failed, with the folder they go into.
#[derive(Clone)]
pub(super) struct FailedPacks {
    capture_folder: CaptureFolder,
    points: Vec<SnapshotPoint>,
}

// What a read of the captures whose own pack failed found: the ones it can pack, as they are
// packed, the same ones as recorded, and those whose tree is gone.
#[derive(Default)]
struct FailedPointsRead {
    packable: Vec<SnapshotPoint>,
    recorded: Vec<SnapshotPoint>,
    gone: Vec<SnapshotPoint>,
}

impl CapturePacking {
    // Keeps `captured`, whose own pack into `folder` failed, for the folder's next fold or sweep.
    pub(super) fn keep_failed_pack(&self, folder: PathBuf, captured: &CapturedCommit) {
        let point = SnapshotPoint {
            commit: captured.commit.clone(),
            tree: captured.tree.clone(),
            base: captured.base.clone(),
        };
        lock(&self.failed_packs)
            .entry(folder)
            .or_insert_with(|| FailedPacks {
                capture_folder: captured.capture_folder.clone(),
                points: Vec::new(),
            })
            .points
            .push(point);
    }

    // Packs the captures of `folder` whose own pack failed, each tree on its base's tree and the
    // commits after, and forgets them once that pack succeeds. A capture whose tree is gone from
    // the folder and the repository is logged and forgotten, since nothing can pack it, and one
    // whose base is gone or names no commit is packed whole. Never fails: a failure is logged and
    // the captures kept.
    pub(super) async fn pack_failed_captures(
        &self,
        place: Option<&Place>,
        folder: &Path,
        hold: &KeyHold<'_, PathBuf>,
    ) {
        let Some(failed) = lock(&self.failed_packs).get(folder).cloned() else {
            return;
        };
        let packed = match self.read_failed_points(place, &failed).await {
            Ok(read) => read,
            Err(failure) => {
                CaptureDiagnostic::PackFailed {
                    capture_folder: folder.to_path_buf(),
                    detail: Box::new(failure),
                }
                .warn();
                return;
            }
        };
        if !packed.gone.is_empty() {
            CaptureDiagnostic::ObjectsGone {
                capture_folder: folder.to_path_buf(),
                objects: packed.gone.iter().map(|point| point.tree.clone()).collect(),
            }
            .warn();
            self.forget_failed_points(folder, &packed.gone);
        }
        if packed.packable.is_empty() {
            return;
        }
        let points: Vec<&SnapshotPoint> = packed.packable.iter().collect();
        let commits: Vec<GitObjectId> = packed
            .packable
            .iter()
            .map(|point| point.commit.clone())
            .collect();
        let pack = match self
            .pack_stale_points(place, &failed.capture_folder, &points, hold)
            .await
        {
            Ok(()) => {
                self.pack_listed_objects(place, folder, &commits, hold)
                    .await
            }
            Err(failure) => Err(failure),
        };
        if let Err(failure) = pack {
            CaptureDiagnostic::PackFailed {
                capture_folder: folder.to_path_buf(),
                detail: Box::new(failure),
            }
            .warn();
            return;
        }
        self.forget_failed_points(folder, &packed.recorded);
    }

    // Reads which of `failed`'s captures can be packed, the folder and the repository read
    // together: a capture whose tree is gone cannot, and one whose base is gone or names no
    // commit is packed with no base. Fails as git's read does.
    async fn read_failed_points(
        &self,
        place: Option<&Place>,
        failed: &FailedPacks,
    ) -> Result<FailedPointsRead, PackingError> {
        let ids: Vec<&GitObjectId> = failed
            .points
            .iter()
            .flat_map(|point| std::iter::once(&point.tree).chain(point.base.as_ref()))
            .collect();
        let arguments = in_git_folder(
            failed.capture_folder.folder(),
            &[],
            &["cat-file", "--batch-check"],
        );
        let mut call = GitCall::read(arguments).with_input(object_lines(ids.iter().copied()));
        for (name, value) in failed.capture_folder.write_environment() {
            call = call.with_environment(name, value);
        }
        let output = self.git.run(place, call).await?;
        let mut presence = read_bases_present(&output.stdout, &ids)?.into_iter();
        let mut read = FailedPointsRead::default();
        for point in &failed.points {
            let is_tree_gone = presence.next() == Some(BasePresence::Missing);
            let is_base_commit =
                point.base.is_none() || presence.next() == Some(BasePresence::Commit);
            if is_tree_gone {
                read.gone.push(point.clone());
                continue;
            }
            let mut packable = point.clone();
            if !is_base_commit {
                packable.base = None;
            }
            read.packable.push(packable);
            read.recorded.push(point.clone());
        }
        Ok(read)
    }

    // Forgets `points` among `folder`'s captures whose own pack failed, never one a pack failing
    // meanwhile kept.
    fn forget_failed_points(&self, folder: &Path, points: &[SnapshotPoint]) {
        let mut failed_packs = lock(&self.failed_packs);
        if let Some(kept) = failed_packs.get_mut(folder) {
            kept.points.retain(|point| !points.contains(point));
            if kept.points.is_empty() {
                failed_packs.remove(folder);
            }
        }
    }

    // The distinct bases of `points` by whether a ref of the repository reaches each; a base gone
    // or naming no commit is logged and counted as unreached.
    pub(super) async fn read_base_reach(
        &self,
        place: Option<&Place>,
        folder: &Path,
        common_folder: &Path,
        points: &[SnapshotPoint],
        _hold: &KeyHold<'_, PathBuf>,
    ) -> Result<BaseReach, PackingError> {
        let mut bases: Vec<&GitObjectId> = points
            .iter()
            .filter_map(|point| point.base.as_ref())
            .collect();
        bases.sort_unstable();
        bases.dedup();
        if bases.is_empty() {
            return Ok(BaseReach::default());
        }
        let input = object_lines(bases.iter().copied());
        let arguments = in_git_folder(common_folder, &[], &["cat-file", "--batch-check"]);
        let output = self
            .git
            .run(place, GitCall::read(arguments).with_input(input))
            .await?;
        let presence = read_bases_present(&output.stdout, &bases)?;
        let mut reach = BaseReach::default();
        let mut commits = Vec::new();
        for (base, presence) in bases.into_iter().zip(presence) {
            match presence {
                BasePresence::Commit => commits.push(base),
                BasePresence::Missing => {
                    log_base_lost(folder, base, None);
                    reach.unreached.insert(base.clone());
                }
                BasePresence::NotACommit(found_type) => {
                    log_base_lost(folder, base, Some(found_type));
                    reach.unreached.insert(base.clone());
                }
            }
        }
        if commits.is_empty() {
            return Ok(reach);
        }
        // One walk for every base: what it prints no ref reaches, a base among the rest.
        let arguments = in_git_folder(
            common_folder,
            &[],
            &["rev-list", "--stdin", "--not", "--all"],
        );
        let call = GitCall::read(arguments).with_input(object_lines(commits.iter().copied()));
        let output = self.git.run(place, call).await?;
        let unreached: HashSet<GitObjectId> = read_object_ids(&output.stdout, "rev-list")?
            .into_iter()
            .collect();
        for base in commits {
            if unreached.contains(base) {
                reach.unreached.insert(base.clone());
            } else {
                reach.reached.insert(base.clone());
            }
        }
        Ok(reach)
    }

    // Packs `trees` into the capture folder less what the repository's `HEAD` tree holds, the
    // repository attached, then removes the loose copies.
    pub(super) async fn pack_unreached_trees(
        &self,
        place: Option<&Place>,
        capture_folder: &CaptureFolder,
        common_folder: &Path,
        trees: &[&GitObjectId],
        hold: &KeyHold<'_, PathBuf>,
    ) -> Result<(), PackingError> {
        let mut revisions = String::new();
        for tree in trees {
            revisions.push_str(tree.as_str());
            revisions.push('\n');
        }
        let arguments = in_git_folder(
            common_folder,
            &[],
            &["rev-parse", "--verify", "-q", "HEAD^{tree}"],
        );
        // An unborn `HEAD` has no tree, so nothing is left out.
        match self.git.run(place, GitCall::read(arguments)).await {
            Ok(output) => {
                let head_tree =
                    GitObjectId::new(String::from_utf8_lossy(&output.stdout).trim().to_owned())
                        .ok_or(PackingError::UnreadableAnswer {
                            command: "rev-parse",
                            reason: "the HEAD tree is not an object id",
                        })?;
                revisions.push_str("--not\n");
                revisions.push_str(head_tree.as_str());
                revisions.push('\n');
            }
            Err(unresolved) if unresolved.exit_code() == Some(UNRESOLVED_NAME_EXIT_CODE) => {}
            Err(failure) => return Err(failure.into()),
        }
        self.pack_revisions(place, capture_folder, revisions.into_bytes(), hold)
            .await?;
        Ok(())
    }

    // Packs, as each capture's own pack would have, the trees of `points` less what the tree of
    // the base each stands on holds, one pack per base, the repository attached. The negative is
    // the base's tree, never its commit, which leaves nothing out of a tree.
    pub(super) async fn pack_stale_points(
        &self,
        place: Option<&Place>,
        capture_folder: &CaptureFolder,
        points: &[&SnapshotPoint],
        hold: &KeyHold<'_, PathBuf>,
    ) -> Result<(), PackingError> {
        let mut trees_by_base: HashMap<Option<&GitObjectId>, Vec<&GitObjectId>> = HashMap::new();
        for point in points {
            trees_by_base
                .entry(point.base.as_ref())
                .or_default()
                .push(&point.tree);
        }
        for (base, trees) in trees_by_base {
            let mut revisions = String::new();
            for tree in trees {
                revisions.push_str(tree.as_str());
                revisions.push('\n');
            }
            if let Some(base) = base {
                revisions.push_str("--not\n");
                revisions.push_str(base.as_str());
                revisions.push_str("^{tree}\n");
            }
            self.pack_revisions(place, capture_folder, revisions.into_bytes(), hold)
                .await?;
        }
        Ok(())
    }

    // Packs the folder's own `objects` not yet in a pack, nothing attached, so an id the folder
    // lacks fails the pack, then removes the loose copies.
    pub(super) async fn pack_listed_objects(
        &self,
        place: Option<&Place>,
        folder: &Path,
        objects: &[GitObjectId],
        _hold: &KeyHold<'_, PathBuf>,
    ) -> Result<(), PackingError> {
        // `--incremental` leaves out what the passes above packed; nothing is borrowed here.
        let mut arguments = in_git_folder(
            folder,
            &[&CORE_FSYNC_PIN, &PACK_SIZE_LIMIT_PIN, &PATH_WALK_PIN],
            &["pack-objects", "-q", "--incremental", "--non-empty"],
        );
        arguments.push(pack_name_base(folder));
        let call = GitCall::read(arguments).with_input(object_lines(objects));
        self.git.run(place, call).await?;
        self.prune_packed(place, folder).await?;
        Ok(())
    }
}
