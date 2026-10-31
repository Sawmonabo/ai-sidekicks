//! Stand-ins for the sources a worktree creator reads, for the tests that make trees: a project
//! named `app` whose branch pattern is its title alone, no setup steps, and scripted live runs.

use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::machine::settings::{BranchNamePattern, BranchNamePatternChange};
use sidekicks_contracts::project::ProjectSetup;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::worktree::lifecycle::WorktreeId;
use sidekicks_std::mutex_lock::lock;

use super::{LiveRunFolder, LiveRunFolderReadError, LiveRunFolderReader};
use crate::git::worktree::naming::{
    WorktreeNamingError, WorktreeNamingSources, WorktreeProjectNaming,
};
use crate::git::worktree::setup::{WorktreeSetupError, WorktreeSetupSources};

/// The branch pattern every test tree is named by: the title alone, so a test reads its branch as
/// the tail it gave.
pub fn title_only_pattern() -> BranchNamePattern {
    BranchNamePattern::new(
        BranchNamePatternChange::new("{title}".to_owned()).expect("a bounded pattern"),
    )
    .expect("a pattern holding {title}")
}

/// The project's naming facts: slug `app` and the title-only pattern; the session has no title.
pub struct FixedNaming;

impl WorktreeNamingSources for FixedNaming {
    fn read_project_naming<'a>(
        &'a self,
        _repo_mount_id: &'a RepoMountId,
    ) -> BoxFuture<'a, Result<WorktreeProjectNaming, WorktreeNamingError>> {
        async {
            Ok(WorktreeProjectNaming {
                slug: "app".to_owned(),
                branch_pattern: Some(title_only_pattern()),
            })
        }
        .boxed()
    }

    fn read_machine_branch_pattern(
        &self,
    ) -> BoxFuture<'_, Result<BranchNamePattern, WorktreeNamingError>> {
        async { Ok(title_only_pattern()) }.boxed()
    }

    fn read_session_title_words<'a>(
        &'a self,
        _session_id: &'a SessionId,
        _fallback_message: Option<&'a str>,
    ) -> BoxFuture<'a, Result<String, WorktreeNamingError>> {
        async { Ok(String::new()) }.boxed()
    }
}

/// A project with no setup steps of its own.
pub struct NoSetupSteps;

impl WorktreeSetupSources for NoSetupSteps {
    fn require_worktree<'a>(
        &'a self,
        _worktree_id: &'a WorktreeId,
    ) -> BoxFuture<'a, Result<(), WorktreeSetupError>> {
        async { Ok(()) }.boxed()
    }

    fn read_retired<'a>(
        &'a self,
        _worktree_ids: &'a [WorktreeId],
    ) -> BoxFuture<'a, Result<HashSet<WorktreeId>, WorktreeSetupError>> {
        async { Ok(HashSet::new()) }.boxed()
    }

    fn read_project_setup<'a>(
        &'a self,
        _worktree_id: &'a WorktreeId,
    ) -> BoxFuture<'a, Result<ProjectSetup, WorktreeSetupError>> {
        async {
            Ok(ProjectSetup {
                files_to_copy: Vec::new(),
                commands: Vec::new(),
                time_limit_seconds: None,
            })
        }
        .boxed()
    }

    fn read_command_environment<'a>(
        &'a self,
        _worktree_id: &'a WorktreeId,
    ) -> BoxFuture<'a, Result<Vec<(String, String)>, WorktreeSetupError>> {
        async { Ok(std::env::vars().collect()) }.boxed()
    }
}

/// Answers each read with the next scripted list of live runs, and none once the script is spent,
/// standing in for the session crate's reader.
#[derive(Default)]
pub struct ScriptedLiveRuns {
    /// The lists still to answer, in order.
    pub answers: Mutex<VecDeque<Vec<LiveRunFolder>>>,
}

impl LiveRunFolderReader for ScriptedLiveRuns {
    fn read_other_sessions_live_runs<'a>(
        &'a self,
        _session_id: &'a SessionId,
    ) -> BoxFuture<'a, Result<Vec<LiveRunFolder>, LiveRunFolderReadError>> {
        let answer = lock(&self.answers).pop_front().unwrap_or_default();
        async move { Ok(answer) }.boxed()
    }
}
