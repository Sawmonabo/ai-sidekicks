//! The steps of a setup card and how each project step runs: the card's list, matched to a list
//! read again by what each step does; a file copied from the repository's checkout into the tree,
//! keeping what the tree has; and a command line run in the tree through the person's shell, its
//! output's tail kept, given up on at its time limit and ended with every process it started.

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::project::{PROJECT_SETUP_COMMAND_MAX_LEN, ProjectSetup};
use sidekicks_contracts::repo::workspace::WORKSPACE_LAST_ERROR_MAX_LEN;
use sidekicks_contracts::wire::text::{FreeFormText, TextError};
use sidekicks_contracts::worktree::setup::{
    WORKTREE_SETUP_OUTPUT_MAX_LEN, WorktreeSetupStage, WorktreeSetupStep, WorktreeSetupStepState,
};
use sidekicks_platforms::{
    ChildTree, Spawner, async_pipe_reader, read_child_exit, shell_line_command, start_child_tree,
};
use tokio::io::AsyncRead;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;

use crate::error_description::describe_error;
use crate::git::worktree::copy::{TreeCopyPolicy, copy_tree};
use crate::mutex_lock::lock;
use crate::process_exit::{OutputTail, read_output_chunks};
use crate::workspace::last_error::normalize_workspace_last_error;
use crate::workspace::trust_envelope::{components_equal, is_contained_within};

/// The label of the step that makes the tree: the command it runs.
const MAKE_TREE_LABEL: &str = "git worktree add";

/// The label of the warm step: the command it runs.
const WARM_LABEL: &str = "git status";

// The label of the project's steps' read when it fails.
const READ_PROJECT_STEPS_LABEL: &str = "Setup steps";

// How long a command's output may stay open after the command exits or is ended, for the last
// lines to arrive, before what it left running is ended and the tail is taken as read so far.
const OUTPUT_LINGER: Duration = Duration::from_secs(1);

/// What a failed step says when its failure has no words of its own.
const UNNAMED_FAILURE: &str = "The step failed";

/// What one step does: the fixed steps carry nothing, a project step its file or its command.
#[derive(Clone, Debug)]
pub(super) enum StepAction {
    MakeTree,
    /// The read of the project's steps, which failed; a retry reads them again in its place.
    ReadProjectSteps,
    Copy {
        path: FilesystemPath,
    },
    Command {
        line: FreeFormText<PROJECT_SETUP_COMMAND_MAX_LEN>,
        time_limit: Option<Duration>,
    },
    Warm,
}

/// One step of a card: what the card shows and what the step does.
#[derive(Clone, Debug)]
pub(super) struct CardStep {
    pub(super) step: WorktreeSetupStep,
    pub(super) action: StepAction,
}

/// How a step that ran ended: the failure's words, or none, and the tail of what it printed.
pub(super) struct StepOutcome {
    pub(super) error: Option<String>,
    pub(super) output: Option<FreeFormText<WORKTREE_SETUP_OUTPUT_MAX_LEN>>,
}

impl StepOutcome {
    /// A step that succeeded and printed nothing.
    pub(super) fn succeeded() -> Self {
        Self {
            error: None,
            output: None,
        }
    }

    /// A step that failed with `error` and printed nothing.
    pub(super) fn failed(error: impl Into<String>) -> Self {
        Self {
            error: Some(error.into()),
            output: None,
        }
    }
}

impl CardStep {
    /// The step that makes the tree, running.
    pub(super) fn make_tree() -> Self {
        Self::of(
            WorktreeSetupStage::MakeTree,
            MAKE_TREE_LABEL,
            WorktreeSetupStepState::Running,
            StepAction::MakeTree,
        )
    }

    /// The read of the project's steps, failed for `reason`, so the card names it and a retry
    /// reads them again.
    pub(super) fn project_steps_unread(reason: &str) -> Self {
        let mut unread = Self::of(
            WorktreeSetupStage::ProjectSteps,
            READ_PROJECT_STEPS_LABEL,
            WorktreeSetupStepState::Failed,
            StepAction::ReadProjectSteps,
        );
        unread.step.error = Some(step_error(&format!(
            "Could not read the setup steps: {reason}"
        )));
        unread
    }

    /// The warm step, pending.
    pub(super) fn warm() -> Self {
        Self::of(
            WorktreeSetupStage::WarmCaches,
            WARM_LABEL,
            WorktreeSetupStepState::Pending,
            StepAction::Warm,
        )
    }

    fn of(
        stage: WorktreeSetupStage,
        label: &str,
        state: WorktreeSetupStepState,
        action: StepAction,
    ) -> Self {
        Self {
            step: WorktreeSetupStep {
                stage,
                label: FreeFormText::new(label.to_owned()).expect("a fixed label is short text"),
                state,
                elapsed_ms: None,
                error: None,
                output: None,
            },
            action,
        }
    }

    /// The step as it stands before it runs: pending, with nothing of an earlier run.
    pub(super) fn into_pending(self) -> Self {
        Self {
            step: WorktreeSetupStep {
                state: WorktreeSetupStepState::Pending,
                elapsed_ms: None,
                error: None,
                output: None,
                ..self.step
            },
            ..self
        }
    }

    // Whether the two steps do the same work: the same file, or the same command line whatever
    // its limit, or the same fixed step.
    fn does_same_work(&self, other: &Self) -> bool {
        match (&self.action, &other.action) {
            (StepAction::Copy { path }, StepAction::Copy { path: other_path }) => {
                path.as_str() == other_path.as_str()
            }
            (
                StepAction::Command { line, .. },
                StepAction::Command {
                    line: other_line, ..
                },
            ) => line == other_line,
            (StepAction::MakeTree, StepAction::MakeTree) | (StepAction::Warm, StepAction::Warm) => {
                true
            }
            (
                StepAction::MakeTree
                | StepAction::ReadProjectSteps
                | StepAction::Copy { .. }
                | StepAction::Command { .. }
                | StepAction::Warm,
                _,
            ) => false,
        }
    }
}

/// The project's own steps, pending: its files to copy, then its commands, each command given up
/// on after the project's time limit. Fails when a file to copy is named by blank text, which no
/// card can show.
pub(super) fn project_steps_of(setup: &ProjectSetup) -> Result<Vec<CardStep>, TextError> {
    let time_limit = setup
        .time_limit_seconds
        .map(|seconds| Duration::from_secs(seconds.get().unsigned_abs()));
    let copies = setup.files_to_copy.iter().map(|path| {
        Ok(CardStep::of(
            WorktreeSetupStage::ProjectSteps,
            &FreeFormText::<PROJECT_SETUP_COMMAND_MAX_LEN>::new(path.as_str().to_owned())?
                .into_string(),
            WorktreeSetupStepState::Pending,
            StepAction::Copy { path: path.clone() },
        ))
    });
    let commands = setup.commands.iter().map(|line| {
        Ok(CardStep::of(
            WorktreeSetupStage::ProjectSteps,
            line.as_str(),
            WorktreeSetupStepState::Pending,
            StepAction::Command {
                line: line.clone(),
                time_limit,
            },
        ))
    });
    copies.chain(commands).collect()
}

/// The project steps read again, the leading ones that already succeeded on the card kept as they
/// stood, each earlier success matched once by what it does, and the rest pending from the first
/// that has not succeeded; with how many were kept.
pub(super) fn keep_succeeded_steps(
    current: &[CardStep],
    read_again: Vec<CardStep>,
) -> (Vec<CardStep>, usize) {
    let mut succeeded: Vec<Option<&CardStep>> = current
        .iter()
        .filter(|entry| {
            entry.step.stage == WorktreeSetupStage::ProjectSteps
                && entry.step.state == WorktreeSetupStepState::Succeeded
        })
        .map(Some)
        .collect();
    let mut steps = Vec::with_capacity(read_again.len());
    let mut kept_count = 0;
    for entry in read_again {
        let earlier = if steps.len() == kept_count {
            succeeded
                .iter_mut()
                .find(|earlier| earlier.is_some_and(|earlier| earlier.does_same_work(&entry)))
                .and_then(Option::take)
        } else {
            None
        };
        match earlier {
            Some(earlier) => {
                steps.push(earlier.clone());
                kept_count += 1;
            }
            None => steps.push(entry),
        }
    }
    (steps, kept_count)
}

/// `error` as a failed step carries it: credentials scrubbed and cut to the wire's cap.
pub(super) fn step_error(error: &str) -> FreeFormText<WORKSPACE_LAST_ERROR_MAX_LEN> {
    normalize_workspace_last_error(error).unwrap_or_else(|| {
        FreeFormText::new(UNNAMED_FAILURE.to_owned()).expect("the fixed failure is short text")
    })
}

/// Copies the file or folder `path` names in the repository's checkout `repository_root` to the
/// same place in the tree `tree`, keeping each entry the tree already has: carried work, a file
/// its branch tracks or one written since a failed step is never copied over. A path that leads
/// outside the checkout or the tree is refused, never read or written.
pub(super) async fn copy_setup_file(
    repository_root: &Path,
    tree: &Path,
    path: &FilesystemPath,
) -> StepOutcome {
    let (Some(source), Some(destination)) = (
        resolve_inside(repository_root, path.as_str()),
        resolve_inside(tree, path.as_str()),
    ) else {
        return StepOutcome::failed("The file to copy is outside the repository");
    };
    let copied = tokio::task::spawn_blocking(move || {
        copy_tree(&source, &destination, TreeCopyPolicy::KeepExisting, None)
    })
    .await;
    match copied {
        Ok(Ok(())) => StepOutcome::succeeded(),
        Ok(Err(error)) => StepOutcome::failed(describe_error(&error)),
        Err(error) => StepOutcome::failed(describe_error(&error)),
    }
}

// `path` joined onto `root` by the system's rules, when it lies inside `root` and is not `root`.
fn resolve_inside(root: &Path, path: &str) -> Option<PathBuf> {
    let resolved =
        PathBuf::from(sidekicks_platforms::resolve_path_against(root.to_str()?, path).ok()?);
    (is_contained_within(&resolved, root) && !components_equal(&resolved, root)).then_some(resolved)
}

/// A setup command under way, kept on its card so a removal or the daemon's stop can end it.
pub(super) struct RunningCommand {
    end: Mutex<Option<CommandEnd>>,
    is_end_asked: CancellationToken,
    ended: watch::Sender<Option<Result<(), Arc<io::Error>>>>,
}

// Why and how a command is ended: its step's failure, and how long it has after it is asked to
// stop before every process it started is ended.
#[derive(Clone, Copy)]
struct CommandEnd {
    reason: &'static str,
    grace: Duration,
}

/// Why a setup command could not be ended.
#[derive(Debug, thiserror::Error)]
#[error("a setup command could not be ended")]
pub(crate) struct SetupCommandEndError(#[source] Arc<io::Error>);

impl RunningCommand {
    /// A command not yet started, which an end asked before its start keeps from starting.
    pub(super) fn new() -> Self {
        Self {
            end: Mutex::new(None),
            is_end_asked: CancellationToken::new(),
            ended: watch::channel(None).0,
        }
    }

    /// Asks the command to stop, its step failing with `reason`, and after `grace` ends every
    /// process it started; answers once it has exited. A command already asked keeps the first
    /// ask. Fails with the system's error from the ask or the end.
    #[cfg_attr(
        test,
        expect(dead_code, reason = "worktree removal and the daemon's stop")
    )]
    pub(super) async fn end(
        &self,
        reason: &'static str,
        grace: Duration,
    ) -> Result<(), SetupCommandEndError> {
        lock(&self.end).get_or_insert(CommandEnd { reason, grace });
        self.is_end_asked.cancel();
        let mut ended = self.ended.subscribe();
        let outcome = ended
            .wait_for(Option::is_some)
            .await
            .expect("the command holds its own sender")
            .clone();
        outcome
            .expect("the wait ends on an outcome")
            .map_err(SetupCommandEndError)
    }

    fn asked_end(&self) -> Option<CommandEnd> {
        *lock(&self.end)
    }

    fn finish(&self, outcome: io::Result<()>) {
        self.ended.send_replace(Some(outcome.map_err(Arc::new)));
    }
}

/// What a setup command runs with.
pub(super) struct SetupCommand<'a> {
    pub(super) spawner: &'a Spawner,
    pub(super) shell: &'a Path,
    pub(super) line: &'a str,
    pub(super) tree: &'a Path,
    pub(super) environment: Vec<(String, String)>,
    pub(super) time_limit: Option<Duration>,
}

// How the wait on a running command ended.
enum CommandWait {
    Exited(io::Result<()>),
    TimeLimit,
    EndAsked,
}

/// Runs `command` in its tree with standard input empty and its standard output and error read
/// into one tail; it leads a process tree of its own, so its exit, its time limit and an end each
/// end every process it started that is still in that tree. Answers how its step ends once the
/// command has exited and its output has closed or a second has passed, or once it was ended; the
/// output's reader is dropped then, so a process that left the tree and writes later fails where
/// the system closes the read end at once.
pub(super) async fn run_command(
    command: SetupCommand<'_>,
    running: &RunningCommand,
) -> StepOutcome {
    let outcome = run_started_command(command, running).await;
    running.finish(outcome.1);
    outcome.0
}

async fn run_started_command(
    command: SetupCommand<'_>,
    running: &RunningCommand,
) -> (StepOutcome, io::Result<()>) {
    if let Some(end) = running.asked_end() {
        return (StepOutcome::failed(end.reason), Ok(()));
    }
    let output = Arc::new(Mutex::new(CommandOutput::default()));
    let output_closed = CancellationToken::new();
    let (mut tree, reading, time_limit) =
        match start_command(command, &output, &output_closed).await {
            Ok(started) => started,
            Err(error) => return (StepOutcome::failed(describe_error(&error)), Ok(())),
        };
    let wait = {
        let exited = tree.wait_for_exit();
        let limit = async {
            match time_limit {
                Some(limit) => tokio::time::sleep(limit).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            exited = exited => CommandWait::Exited(exited),
            () = limit => CommandWait::TimeLimit,
            () = running.is_end_asked.cancelled() => CommandWait::EndAsked,
        }
    };
    let outcome = match wait {
        CommandWait::Exited(exited) => {
            // Whatever the command left running is ended once its output closes or a second
            // passes, while the exited command still holds its group's id; its own exit stays its
            // result.
            let is_output_closed = linger_for_output(&output_closed).await;
            let ended = tree.end_tree().await;
            if !is_output_closed {
                linger_for_output(&output_closed).await;
            }
            let exit_words = match exited.and(tree.wait().await) {
                Ok(status) => (!status.success()).then(|| {
                    let exit = read_child_exit(&status, None);
                    exit.signal_name.map_or_else(
                        || format!("Exited with code {}", exit.exit_code),
                        |signal| format!("Ended by {signal}"),
                    )
                }),
                Err(error) => Some(describe_error(&error)),
            };
            let error = match ended {
                Ok(()) => exit_words,
                Err(end_error) => {
                    tracing::warn!(
                        error = &end_error as &(dyn Error + 'static),
                        "What a setup command left running could not be ended"
                    );
                    let end_words = format!(
                        "Could not end what the command left running: {}",
                        describe_error(&end_error)
                    );
                    Some(match exit_words {
                        Some(exit_words) => format!("{exit_words}. {end_words}"),
                        None => end_words,
                    })
                }
            };
            (take_outcome(error, &output), Ok(()))
        }
        CommandWait::TimeLimit => {
            let seconds = time_limit.map_or(0, |limit| limit.as_secs());
            let error = match tree.end_tree().await {
                Ok(()) if seconds == 1 => "Gave up after 1 second".to_owned(),
                Ok(()) => format!("Gave up after {seconds} seconds"),
                Err(error) => {
                    format!(
                        "Could not end the command at its time limit: {}",
                        describe_error(&error)
                    )
                }
            };
            linger_for_output(&output_closed).await;
            (take_outcome(Some(error), &output), Ok(()))
        }
        CommandWait::EndAsked => {
            let end = running
                .asked_end()
                .expect("an end is set before it is asked");
            let ended = end_asked(&mut tree, end.grace, &output_closed).await;
            linger_for_output(&output_closed).await;
            (take_outcome(Some(end.reason.to_owned()), &output), ended)
        }
    };
    // Drops the output's reader, so a process that left the tree and still holds the output fails
    // its next write instead of keeping a reader waiting, where the system closes the read end at
    // once; elsewhere the read end closes once the tree's end has closed every writer.
    drop(reading);
    outcome
}

// Starts the command with one pipe for both its output streams, read in a task until every
// process holding it has closed it or the task is dropped; answers the started tree, the read's
// task and the command's time limit.
async fn start_command(
    command: SetupCommand<'_>,
    output: &Arc<Mutex<CommandOutput>>,
    output_closed: &CancellationToken,
) -> io::Result<(ChildTree, AbortOnDropHandle<()>, Option<Duration>)> {
    let (reader, writer) = io::pipe()?;
    let error_writer = writer.try_clone()?;
    let mut child = shell_line_command(command.shell, command.line);
    child
        .current_dir(command.tree)
        .env_clear()
        .envs(command.environment)
        .stdin(Stdio::null())
        .stdout(writer)
        .stderr(error_writer);
    let daemon_pid = std::process::id();
    // The command, and with it the pipe's writing ends, is dropped once the child has started,
    // so only the command's own processes hold the pipe open.
    let tree = command
        .spawner
        .run(move || start_child_tree(child, daemon_pid))
        .await??;
    let reader = async_pipe_reader(reader)?;
    let output = Arc::clone(output);
    let output_closed = output_closed.clone();
    let reading = AbortOnDropHandle::new(tokio::spawn(async move {
        read_output(reader, &output).await;
        output_closed.cancel();
    }));
    Ok((tree, reading, command.time_limit))
}

// Waits at most the linger for the command's output to close; answers whether it closed.
async fn linger_for_output(output_closed: &CancellationToken) -> bool {
    tokio::time::timeout(OUTPUT_LINGER, output_closed.cancelled())
        .await
        .is_ok()
}

// Asks `tree` to stop, waits up to `grace` for it to exit and its output to close, then ends what
// is left of it while the exited command still holds its group's id; a tree whose ask fails is
// ended at once. Fails with the ask's, the wait's or the end's error.
async fn end_asked(
    tree: &mut ChildTree,
    grace: Duration,
    output_closed: &CancellationToken,
) -> io::Result<()> {
    if let Err(error) = tree.ask_tree_to_stop().await {
        tree.end_tree().await?;
        return Err(error);
    }
    let settled = tokio::time::timeout(grace, async {
        tree.wait_for_exit().await?;
        output_closed.cancelled().await;
        Ok::<_, io::Error>(())
    })
    .await;
    let ended = tree.end_tree().await;
    settled.unwrap_or(Ok(())).and(ended)
}

// The tail of a command's output and whether it printed anything.
struct CommandOutput {
    tail: OutputTail<WORKTREE_SETUP_OUTPUT_MAX_LEN>,
    has_printed: bool,
}

// Nothing printed yet.
impl Default for CommandOutput {
    fn default() -> Self {
        Self {
            tail: OutputTail::new(),
            has_printed: false,
        }
    }
}

async fn read_output(reader: impl AsyncRead + Unpin, output: &Mutex<CommandOutput>) {
    read_output_chunks(reader, "a setup command's output", |chunk| {
        let mut output = lock(output);
        output.tail.push(chunk);
        output.has_printed = true;
    })
    .await;
}

// The step's outcome with the output read so far, which a command ended early may add to later.
fn take_outcome(error: Option<String>, output: &Mutex<CommandOutput>) -> StepOutcome {
    let printed = std::mem::take(&mut *lock(output));
    StepOutcome {
        error,
        output: printed.has_printed.then(|| {
            FreeFormText::new(printed.tail.into_text())
                .expect("a tail is never blank, holds no NUL and keeps within its cap")
        }),
    }
}
