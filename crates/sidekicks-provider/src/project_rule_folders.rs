//! Writes a project rule into each working folder of its project, so it reaches every session of
//! the project, and takes it back out of those already written when one write fails, so no folder
//! keeps a rule the daemon never recorded. Every rule file the write reaches is held from before
//! the first write until the last take-back, so no other edit lands between a write and its
//! take-back.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_policy::ask_rule::ProviderAskRule;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};

/// The edit locks of every rule file a project rule write reaches, held together for the whole
/// write and any take-back, each file named as its caller names it.
pub(crate) struct RuleFileHolds {
    // Each file's hold by its name; names of one file share its hold.
    holds: HashMap<PathBuf, Arc<KeyHold<'static, PathBuf>>>,
}

impl RuleFileHolds {
    /// Holds `lock`'s key of each of `files`, a name and the key the lock compares, every key
    /// taken in one order as [`KeyedLock::acquire_all`] takes them.
    pub(crate) async fn acquire(
        lock: &'static KeyedLock<PathBuf>,
        files: Vec<(PathBuf, PathBuf)>,
    ) -> Self {
        let by_key: HashMap<PathBuf, Arc<KeyHold<'static, PathBuf>>> = lock
            .acquire_all(files.iter().map(|(_, key)| key.clone()))
            .await
            .into_iter()
            .map(|hold| (hold.key().clone(), Arc::new(hold)))
            .collect();
        let holds = files
            .into_iter()
            .map(|(name, key)| {
                let hold = by_key.get(&key).expect("every key asked for is held");
                (name, Arc::clone(hold))
            })
            .collect();
        Self { holds }
    }

    /// The hold on the file named `name`, one of the files held.
    pub(crate) fn hold(&self, name: &Path) -> Arc<KeyHold<'static, PathBuf>> {
        Arc::clone(
            self.holds
                .get(name)
                .expect("every file a write reaches is held before it"),
        )
    }
}

/// Writes `rule` into each of `project_folders` with `write`, which answers what `remove` needs to
/// take that folder's change back. When a write fails, takes the rule back with `remove` from every
/// folder already written, `written_already` among them (those the rule reached another way), the
/// last written first so a file written twice ends as it began, trying each even after one removal
/// fails; the error keeps the write's failure and each removal's.
pub(crate) async fn write_into_project_folders<Written, Write, Remove, WriteError, RemoveError>(
    project_folders: &[PathBuf],
    rule: &ProviderAskRule,
    write: Write,
    remove: Remove,
    written_already: Vec<(PathBuf, Written)>,
) -> Result<(), CleanupFailures<WriteError, RemoveError>>
where
    Write: for<'call> Fn(
        &'call Path,
        &'call ProviderAskRule,
    ) -> BoxFuture<'call, Result<Written, WriteError>>,
    Remove: for<'call> Fn(
        &'call Path,
        &'call ProviderAskRule,
        &'call Written,
    ) -> BoxFuture<'call, Result<(), RemoveError>>,
{
    let mut written = written_already;
    for project_folder in project_folders {
        match write(project_folder, rule).await {
            Ok(change) => written.push((project_folder.clone(), change)),
            Err(write_failure) => {
                // Every folder is tried, so one failed removal never leaves more folders holding
                // the rule than it must.
                let mut removal_failures = Vec::new();
                for (written_folder, change) in written.iter().rev() {
                    if let Err(removal_failure) = remove(written_folder, rule, change).await {
                        removal_failures.push(removal_failure);
                    }
                }
                return Err(CleanupFailures::new(
                    write_failure,
                    removal_failures,
                    "writing the project rule into every folder",
                ));
            }
        }
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
    use sidekicks_contracts::provider::tool_call::ToolCallActionKind;
    use sidekicks_policy::ask_rule::ProviderAskRule;

    use super::write_into_project_folders;

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
            action: ToolCallActionKind::Command,
            subject: "git status".to_owned(),
        };
        let removals_tried = Mutex::new(Vec::new());

        // The fourth write fails after three folders took the rule; the second removal fails.
        let outcome = write_into_project_folders(
            &folders,
            &rule,
            |folder: &Path, _rule: &ProviderAskRule| change_failing_on("/work/d", folder),
            |folder: &Path, _rule: &ProviderAskRule, _change: &()| {
                removals_tried
                    .lock()
                    .expect("no test thread panics holding the lock")
                    .push(folder.to_path_buf());
                change_failing_on("/work/b", folder)
            },
            Vec::new(),
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
        // The first folder's removal still ran after the second one's failed.
        let removals_tried = removals_tried
            .into_inner()
            .expect("no test thread panicked holding the lock");
        assert_eq!(
            removals_tried,
            [&folders[2], &folders[1], &folders[0]].map(PathBuf::clone)
        );
    }
}
