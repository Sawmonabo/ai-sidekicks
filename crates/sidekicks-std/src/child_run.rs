//! One run of a child program to its end, bounded in time and in output, leading a process tree of
//! its own that ends whole when the run fails.

use std::error::Error;
use std::io;
use std::time::Duration;

use sidekicks_platforms::{
    ChildTree, ChildTreeOutput, ChildTreeOutputError, Spawner, start_child_tree,
};
use tokio::process::Command;
use tokio_util::task::TaskTracker;

/// Why a child did not run to its end within its bounds.
#[derive(Debug, thiserror::Error)]
pub enum ChildRunError {
    /// The child could not be built or started.
    #[error("the program could not be started")]
    Start(#[source] io::Error),
    /// Its input could not be written, its output could not be read, or one stream passed its
    /// bound.
    #[error("the program's output could not be read")]
    Output(#[source] ChildTreeOutputError),
    /// It did not exit within its deadline.
    #[error("the program did not exit within its deadline")]
    TimedOut,
}

/// Runs the command `build` makes to its end and answers what it printed and how it exited,
/// whatever the exit status, which the caller reads. `build` runs on the spawner thread, which
/// starts the child leading a tree of its own with the standard streams `build` set; `input`, when
/// given, is written to its standard input. The child must exit within `deadline`, each output
/// stream held to `output_bound` bytes. On any failure the answer comes at once and the whole tree
/// is ended after: on a task `tree_ends` tracks, so a shutdown can wait for it, or by its drop,
/// which ends it on a blocking thread, when `None`. So no process holds the caller past the
/// deadline.
pub async fn run_child_to_end(
    spawner: &Spawner,
    build: impl FnOnce() -> io::Result<Command> + Send + 'static,
    input: Option<Vec<u8>>,
    deadline: Duration,
    output_bound: usize,
    tree_ends: Option<&TaskTracker>,
) -> Result<ChildTreeOutput, ChildRunError> {
    let daemon_pid = std::process::id();
    let mut child = spawner
        .run(move || start_child_tree(build()?, daemon_pid))
        .await
        .map_err(ChildRunError::Start)?
        .map_err(ChildRunError::Start)?;
    // Boxed, so a caller's future, which may hold this one deep in its own, stays small.
    let waited = Box::pin(child.wait_with_output(input, output_bound));
    let failure = match tokio::time::timeout(deadline, waited).await {
        Ok(Ok(output)) => return Ok(output),
        Ok(Err(error)) => ChildRunError::Output(error),
        Err(_elapsed) => ChildRunError::TimedOut,
    };
    if let Some(tree_ends) = tree_ends {
        end_failed_tree(tree_ends, child);
    }
    Err(failure)
}

/// Ends `child`'s whole tree, a run of which failed, on a task `tree_ends` tracks; a failure to end
/// it is logged.
pub fn end_failed_tree(tree_ends: &TaskTracker, mut child: ChildTree) {
    tree_ends.spawn(async move {
        if let Err(error) = child.end_tree().await {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the processes of a program run that failed could not be ended"
            );
        }
    });
}
