//! Writes a project rule into each working folder of its project, so it reaches every session of
//! the project, and takes it back out of those already written when one write fails, so no folder
//! keeps a rule the daemon never recorded.

use std::path::{Path, PathBuf};

use futures::future::BoxFuture;

use crate::cleanup_failures::CleanupFailures;
use crate::policy::ask_rule::ProviderAskRule;

/// Writes `rule` into each of `project_folders` with `write`. When a write fails, removes the rule
/// with `remove` from every folder already written, `written_already` among them (those the rule
/// reached another way), trying each even after one removal fails; the error keeps the write's
/// failure and each removal's.
pub(crate) async fn write_into_project_folders<Write, Remove, WriteError, RemoveError>(
    project_folders: &[PathBuf],
    rule: &ProviderAskRule,
    write: Write,
    remove: Remove,
    written_already: &[PathBuf],
) -> Result<(), CleanupFailures<WriteError, RemoveError>>
where
    Write: for<'call> Fn(
        &'call Path,
        &'call ProviderAskRule,
    ) -> BoxFuture<'call, Result<(), WriteError>>,
    Remove: for<'call> Fn(
        &'call Path,
        &'call ProviderAskRule,
    ) -> BoxFuture<'call, Result<(), RemoveError>>,
{
    let mut written: Vec<&Path> = written_already.iter().map(PathBuf::as_path).collect();
    for project_folder in project_folders {
        if let Err(write_failure) = write(project_folder, rule).await {
            // Every folder is tried, so one failed removal never leaves more folders holding the
            // rule than it must.
            let mut removal_failures = Vec::new();
            for written_folder in written {
                if let Err(removal_failure) = remove(written_folder, rule).await {
                    removal_failures.push(removal_failure);
                }
            }
            return Err(CleanupFailures::new(
                write_failure,
                removal_failures,
                "writing the project rule into every folder",
            ));
        }
        written.push(project_folder);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use futures::FutureExt;
    use futures::future::BoxFuture;
    use sidekicks_contracts::approval::{RememberedRuleSense, RememberedScopeKind};

    use super::write_into_project_folders;
    use crate::policy::ask_rule::{ProviderAskActionKind, ProviderAskRule};

    #[derive(Debug, PartialEq, Eq)]
    struct FolderFailure(PathBuf);

    /// A file change that fails on `failing_folder` alone.
    fn change_failing_on(
        failing_folder: &str,
        folder: &Path,
    ) -> BoxFuture<'static, Result<(), FolderFailure>> {
        let outcome = if folder == Path::new(failing_folder) {
            Err(FolderFailure(folder.to_path_buf()))
        } else {
            Ok(())
        };
        async move { outcome }.boxed()
    }

    #[tokio::test]
    async fn a_failed_removal_still_cleans_every_later_folder() {
        let folders = ["/work/a", "/work/b", "/work/c", "/work/d"].map(PathBuf::from);
        let rule = ProviderAskRule {
            kind: RememberedScopeKind::Project,
            sense: RememberedRuleSense::Allow,
            action: ProviderAskActionKind::Command,
            subject: "git status".to_owned(),
        };
        let removals_tried = Mutex::new(Vec::new());

        // The fourth write fails after three folders took the rule; the second removal fails.
        let outcome = write_into_project_folders(
            &folders,
            &rule,
            |folder: &Path, _rule: &ProviderAskRule| change_failing_on("/work/d", folder),
            |folder: &Path, _rule: &ProviderAskRule| {
                removals_tried
                    .lock()
                    .expect("no test thread panics holding the lock")
                    .push(folder.to_path_buf());
                change_failing_on("/work/b", folder)
            },
            &[],
        )
        .await;

        let failures = outcome.expect_err("the fourth write failed");
        assert_eq!(
            failures.original(),
            &FolderFailure(PathBuf::from("/work/d"))
        );
        assert_eq!(
            failures.cleanup_failures(),
            [FolderFailure(PathBuf::from("/work/b"))]
        );
        // The third folder's removal still ran after the second one's failed.
        let removals_tried = removals_tried
            .into_inner()
            .expect("no test thread panicked holding the lock");
        assert_eq!(removals_tried, folders[..3]);
    }
}
