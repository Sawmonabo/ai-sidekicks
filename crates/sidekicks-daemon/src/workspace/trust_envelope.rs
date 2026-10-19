//! The trust envelope: proves a picked folder belongs to the repository mount a session binds, at
//! the pick and never again. A mount admits its canonical root, the working trees git lists for
//! its repository (read at every pick, never kept), and the roots the daemon made for it, which
//! stay admitted whatever git's list says.
//!
//! Every folder it admits was resolved by the file system and then shown to lie, component by
//! component, inside an admitted root, so `<root>-evil` is not inside `<root>`, and a `..` reaches
//! the file system as written, never collapsed before a link. A folder counts by the working tree
//! git says it sits in, so a worktree nested under the canonical root is admitted only while git
//! lists it. The proof holds at the moment of the pick; what runs there later is the execution
//! boundary's to guard.

use std::error::Error;
use std::io;
use std::path::{Component, Path, PathBuf};

use sidekicks_contracts::repo::folders::RepoMountOutsideTrustEnvelopeReason;
use sidekicks_platforms::PathRules;

use crate::file::bounded_read::read_within_ceiling;
use crate::file::real_location::resolve_real_path;
use crate::missing_entry::is_missing_entry;
use crate::workspace::repo::errors::RepoRefusal;
use crate::workspace::repo::root_resolver::{RepoRootResolver, refusal_of_filesystem_failure};

/// One picked folder; the caller supplies every root, so the validator looks nothing up.
#[derive(Clone, Copy, Debug)]
pub(crate) struct WorkspaceExecutionRootCandidate<'a> {
    /// The canonical root of the bind's repository mount, resolved, used as given.
    pub(crate) mount_canonical_root: &'a Path,
    /// A folder relative to the mount's root, or an absolute one naming a listed working tree or
    /// a folder inside one; `None` or empty picks the root. A rooted path naming no volume is
    /// refused, and a `..` is left to the file system.
    pub(crate) directory: Option<&'a Path>,
    /// The canonical roots of every attached repository mount; none admits nothing.
    pub(crate) attached_mount_roots: &'a [PathBuf],
    /// The roots the daemon made for this mount, admitted whatever git lists.
    pub(crate) provenance_roots: &'a [PathBuf],
}

/// A folder the envelope admitted, both paths with every link resolved, the only paths safe to
/// keep or run in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AdmittedExecutionRoot {
    /// The picked folder itself.
    pub(crate) execution_root: PathBuf,
    /// The top level of the working tree the folder sits in.
    pub(crate) checkout_root: PathBuf,
}

/// Resolves and admits one picked folder, asking `resolver` which working tree it sits in and
/// which trees the mount's repository has; nothing is kept between picks. Fails with
/// [`RepoRefusal::OutsideTrustEnvelope`] (`outsideProject`) on every refusal, a vanished mount
/// among them, and with the resolver's `rootResolutionFailed` refusal when git cannot answer or
/// the folder's resolve or listing gets no answer within the bounded read's ceiling, which says
/// nothing of where the folder lies.
#[cfg_attr(not(test), expect(dead_code, reason = "a run starting in a workspace"))]
pub(crate) async fn validate_execution_root(
    resolver: &RepoRootResolver,
    candidate: WorkspaceExecutionRootCandidate<'_>,
) -> Result<AdmittedExecutionRoot, RepoRefusal> {
    let anchor = candidate.mount_canonical_root;
    // A relative anchor would be completed against the daemon's working folder by the join.
    if !PathRules::NATIVE.names_complete_location(&anchor.to_string_lossy()) {
        return Err(outside_project());
    }
    // Admission before the file system is touched: the anchor is an attached root.
    if !candidate
        .attached_mount_roots
        .iter()
        .any(|attached| components_equal(attached, anchor))
    {
        return Err(outside_project());
    }

    let spelled = join_candidate_path(anchor, candidate.directory)?;
    // A folder the file system will not resolve cannot be shown to lie inside a root.
    let resolved = resolve_real_path(&spelled)
        .await
        .map_err(|error| unread_folder_refusal(&error, "a picked folder could not be resolved"))?;

    let working_tree = resolver.read_working_tree_root(&resolved).await?;
    let provenance_checkout = admit_by_provenance(
        &resolved,
        working_tree.as_deref(),
        candidate.provenance_roots,
    )
    .await?;
    let checkout_root = match provenance_checkout {
        Some(checkout_root) => checkout_root,
        None => admit_by_working_tree(resolver, &resolved, working_tree, anchor).await?,
    };

    // The folder becomes a workspace's bound root and nothing after re-asks, so a file or a
    // folder that cannot be listed, or does not answer within the bounded read's ceiling, is
    // refused here, after the other checks.
    if let Err(error) =
        read_within_ceiling(&resolved, |resolved| std::fs::read_dir(resolved).map(drop)).await
    {
        return Err(unread_folder_refusal(
            &error,
            "a picked folder could not be listed",
        ));
    }
    Ok(AdmittedExecutionRoot {
        execution_root: resolved,
        checkout_root,
    })
}

/// Whether `candidate` is `anchor` or lies beneath it, compared component by component in the
/// running system's comparable form, so `/repo-evil` is not inside `/repo`. Both are compared as
/// given: a caller resolves links first.
pub(crate) fn is_contained_within(candidate: &Path, anchor: &Path) -> bool {
    PathRules::NATIVE
        .comparable_components(candidate)
        .starts_with(&PathRules::NATIVE.comparable_components(anchor))
}

/// Whether `left` and `right` name one location, compared component by component in the running
/// system's comparable form. Both are compared as given: a caller resolves links first.
pub(crate) fn components_equal(left: &Path, right: &Path) -> bool {
    PathRules::NATIVE.comparable_components(left) == PathRules::NATIVE.comparable_components(right)
}

// The refusal for a picked folder whose read failed: `notReadable` when the file system gave no
// answer in time, which says nothing of where the folder lies, else `outsideProject`.
fn unread_folder_refusal(error: &io::Error, failure: &'static str) -> RepoRefusal {
    tracing::debug!(error = error as &(dyn Error + 'static), "{failure}");
    if error.kind() == io::ErrorKind::TimedOut {
        refusal_of_filesystem_failure(error)
    } else {
        outside_project()
    }
}

fn outside_project() -> RepoRefusal {
    RepoRefusal::OutsideTrustEnvelope {
        reason: RepoMountOutsideTrustEnvelopeReason::OutsideProject,
    }
}

// The folder's own working tree when a root the daemon made holds the folder, or that root when
// git names no tree inside it; `None` when no such root holds it. Such a root stays admitted after
// git stops listing it, and one that names nothing any more holds no folder.
async fn admit_by_provenance(
    resolved: &Path,
    working_tree: Option<&Path>,
    provenance_roots: &[PathBuf],
) -> Result<Option<PathBuf>, RepoRefusal> {
    for provenance_root in provenance_roots {
        let provenance_root = match resolve_real_path(provenance_root).await {
            Ok(provenance_root) => provenance_root,
            // A root the daemon made that is gone holds no folder; the next may hold this one.
            Err(error) if is_missing_entry(&error) => continue,
            // Any other failure leaves the root unprovable, so the pick is refused.
            Err(error) => {
                tracing::debug!(
                    error = &error as &(dyn Error + 'static),
                    "a root the daemon made could not be resolved"
                );
                return Err(outside_project());
            }
        };
        if !is_contained_within(resolved, &provenance_root) {
            continue;
        }
        // A tree of its own inside the daemon's root (a submodule, say) is the folder's checkout.
        if let Some(working_tree) = working_tree
            && is_contained_within(resolved, working_tree)
            && is_contained_within(working_tree, &provenance_root)
        {
            return Ok(Some(working_tree.to_path_buf()));
        }
        return Ok(Some(provenance_root));
    }
    Ok(None)
}

// The working tree the folder sits in, when it is the mount's canonical root or a working tree
// git lists for the mount's repository now; refused otherwise.
async fn admit_by_working_tree(
    resolver: &RepoRootResolver,
    resolved: &Path,
    working_tree: Option<PathBuf>,
    anchor: &Path,
) -> Result<PathBuf, RepoRefusal> {
    let Some(working_tree) = working_tree else {
        return Err(outside_project());
    };
    if !is_contained_within(resolved, &working_tree) {
        return Err(outside_project());
    }
    if components_equal(&working_tree, anchor) {
        return Ok(working_tree);
    }
    let is_listed = resolver
        .list_working_trees(anchor)
        .await?
        .iter()
        .any(|listed| components_equal(listed, &working_tree));
    if is_listed {
        Ok(working_tree)
    } else {
        Err(outside_project())
    }
}

// The anchor, the anchor joined with a relative `directory`, or a rooted `directory` on its own,
// with no lexical clean-up, so a `..` reaches the file system intact. A rooted `directory` that
// names no complete location (`\evil`, `C:evil` on Windows) is refused.
fn join_candidate_path(anchor: &Path, directory: Option<&Path>) -> Result<PathBuf, RepoRefusal> {
    let Some(directory) = directory.filter(|directory| !directory.as_os_str().is_empty()) else {
        return Ok(anchor.to_path_buf());
    };
    let is_rooted = matches!(
        directory.components().next(),
        Some(Component::Prefix(_) | Component::RootDir)
    );
    if !is_rooted {
        return Ok(anchor.join(directory));
    }
    if PathRules::NATIVE.names_complete_location(&directory.to_string_lossy()) {
        Ok(directory.to_path_buf())
    } else {
        Err(outside_project())
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use sidekicks_contracts::repo::folders::RepoMountOutsideTrustEnvelopeReason;
    use sidekicks_platforms::{make_folder_link, real_path};

    use super::{WorkspaceExecutionRootCandidate, validate_execution_root};
    use crate::git::process::{GitCall, test_git_runner};
    use crate::workspace::repo::errors::RepoRefusal;
    use crate::workspace::repo::root_resolver::RepoRootResolver;

    // How a picked folder tries to leave its mount.
    #[derive(Clone, Copy, Debug)]
    enum Escape {
        // A sibling whose name starts with the root's, picked under a root the daemon made at
        // the mount's root.
        SiblingSharingAPrefix,
        // A link inside the root to a folder outside, followed by `..`.
        ParentThroughALink,
        // A repository of its own inside the root, which git does not list for the mount.
        UnlistedNestedWorktree,
    }

    // Catches a text compare, a `..` collapsed before a link, or an unlisted working tree admitted.
    #[rstest]
    #[case::sibling_sharing_a_prefix(Escape::SiblingSharingAPrefix)]
    #[case::parent_through_a_link(Escape::ParentThroughALink)]
    #[case::unlisted_nested_worktree(Escape::UnlistedNestedWorktree)]
    #[tokio::test]
    async fn a_folder_outside_the_mount_is_refused(#[case] escape: Escape) {
        let git = test_git_runner();
        let temporary = tempfile::tempdir().expect("the temporary folder is made");
        let outer = real_path(temporary.path()).expect("the temporary folder resolves");
        let root = outer.join("repository");
        git.run(None, GitCall::read([OsStr::new("init"), root.as_os_str()]))
            .await
            .expect("the repository is made");
        let resolver = RepoRootResolver::new(git.clone());
        let attached = [root.clone()];

        let mut provenance: Vec<PathBuf> = Vec::new();
        let directory: PathBuf = match escape {
            Escape::SiblingSharingAPrefix => {
                let sibling = outer.join("repository-evil");
                tokio::fs::create_dir(&sibling)
                    .await
                    .expect("the sibling is made");
                provenance.push(root.clone());
                sibling
            }
            Escape::ParentThroughALink => {
                let deep = outer.join("outside").join("deep");
                tokio::fs::create_dir_all(&deep)
                    .await
                    .expect("the outside folder is made");
                make_folder_link(&deep, &root.join("link")).expect("the link is made");
                Path::new("link").join("..")
            }
            Escape::UnlistedNestedWorktree => {
                let nested = root.join("nested");
                git.run(
                    None,
                    GitCall::read([OsStr::new("init"), nested.as_os_str()]),
                )
                .await
                .expect("the nested repository is made");
                PathBuf::from("nested")
            }
        };

        // The mount's own root is admitted, so the refusal below is the escape's.
        let admitted = validate_execution_root(
            &resolver,
            WorkspaceExecutionRootCandidate {
                mount_canonical_root: &root,
                directory: None,
                attached_mount_roots: &attached,
                provenance_roots: &provenance,
            },
        )
        .await
        .expect("the mount's root is admitted");
        assert_eq!(admitted.execution_root, root);

        let refused = validate_execution_root(
            &resolver,
            WorkspaceExecutionRootCandidate {
                mount_canonical_root: &root,
                directory: Some(directory.as_path()),
                attached_mount_roots: &attached,
                provenance_roots: &provenance,
            },
        )
        .await;

        assert!(
            matches!(
                refused,
                Err(RepoRefusal::OutsideTrustEnvelope {
                    reason: RepoMountOutsideTrustEnvelopeReason::OutsideProject
                })
            ),
            "{escape:?}: {refused:?}"
        );
    }
}
