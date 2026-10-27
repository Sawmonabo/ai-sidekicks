//! A shell opened on a worktree through the spawn translator and the `shell` mode leaves the
//! worktree removable while it is still open, for each shell the host's probe table names: on
//! Windows cmd once it has left the folder and PowerShell at once, elsewhere every shell at once.

use std::path::Path;
use std::time::Duration;

use alacritty_terminal::event::EventListener;
use bytes::Bytes;
use sidekicks_platforms::{
    SHELL_FOLDER_PROBES, ShellFolderProbe, default_shell, real_path, run_test_as_own_root,
};
use sidekicks_session::spawn_cwd_translator::{SpawnCwdStrategy, translate_spawn_cwd};
use sidekicks_terminal::{
    CommandLine, OutputFilter, ScreenListener, ShellCommand, SpawnRequest, TerminalEvent,
    TerminalOutput, Terminals,
};

use crate::helpers::{DAEMON_PROGRAM, spawner};

/// The bound on each wait for the shell's prompt, so a shell that never shows it fails the test.
const PROMPT_BOUND: Duration = Duration::from_secs(30);

/// Keeps every byte of the output.
struct KeepAllOutput;

impl OutputFilter for KeepAllOutput {
    fn filter(&mut self, chunk: &[u8], kept: &mut Vec<u8>) {
        kept.extend_from_slice(chunk);
    }

    fn finish(&mut self, _kept: &mut Vec<u8>) {}
}

/// A screen-copy listener that hears nothing and answers nothing.
#[derive(Clone)]
struct NoListener;

impl EventListener for NoListener {}

impl ScreenListener for NoListener {
    fn find_questions(&mut self, _output: &[u8], _ends: &mut Vec<usize>) {}

    fn answer_question(&mut self) {}
}

/// Reads `program`'s output until it holds `prompt`; fails when the output ends first or the
/// prompt takes past [`PROMPT_BOUND`].
async fn read_to_prompt(
    output: &mut TerminalOutput,
    prompt: &str,
    program: &str,
) -> Result<(), String> {
    tokio::time::timeout(PROMPT_BOUND, async {
        let mut text = String::new();
        while !text.contains(prompt) {
            let event = output.next().await;
            let Some(TerminalEvent::Output(chunk)) = &event else {
                return Err(format!(
                    "{program}'s output ended before {prompt:?}: {event:?}; it read {text:?}"
                ));
            };
            text.push_str(&String::from_utf8_lossy(chunk));
        }
        Ok(())
    })
    .await
    .unwrap_or_else(|_elapsed| {
        Err(format!(
            "{program}'s prompt {prompt:?} did not arrive in time"
        ))
    })
}

// On every host fails when a shell does not show its prompt in its folder: the `shell` mode or the
// shell does not start, or starts elsewhere. On Windows it also fails when the mode or the shell
// holds the folder as its current folder: the mode spawned in it, cmd's folder handed to the mode
// rather than to the shell, or PowerShell started in it instead of being told it; macOS and Linux
// remove a folder a process sits in, so there the removal cannot fail. Every probe runs, and their
// failures are asserted together, so one shell's failure hides no other's.
// The test's own name in the binary, which runs again as its own responsible process on macOS.
const WORKTREE_REMOVAL_TEST: &str =
    "spawn_cwd_translator::a_worktree_is_removable_while_its_shell_is_open";

#[test]
fn a_worktree_is_removable_while_its_shell_is_open() {
    // The `shell` mode starts a shell only for a parent that is its own responsible process, as
    // the daemon is.
    run_test_as_own_root(WORKTREE_REMOVAL_TEST, || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("the test's runtime builds");
        runtime.block_on(async {
            let mut failures = Vec::new();
            for probe in SHELL_FOLDER_PROBES {
                if let Err(failure) = open_and_remove_worktree(probe).await {
                    failures.push(failure);
                }
            }
            assert!(failures.is_empty(), "{}", failures.join("\n"));
        });
    });
}

// Opens `probe`'s shell on a fresh worktree, waits for its prompt there (and, where it holds the
// folder, for its prompt one folder up after `cd ..`), then removes the worktree with the shell
// still open; fails naming the shell and what went wrong.
async fn open_and_remove_worktree(probe: &ShellFolderProbe) -> Result<(), String> {
    let program = probe.program;
    let scratch = tempfile::tempdir()
        .map_err(|error| format!("{program}'s scratch folder is not made: {error:?}"))?;
    // The shell's prompt shows the folder with its links resolved.
    let scratch_folder = real_path(scratch.path())
        .map_err(|error| format!("{program}'s scratch folder does not resolve: {error:?}"))?;
    let worktree = scratch_folder.join(probe.folder_name);
    std::fs::create_dir(&worktree)
        .map_err(|error| format!("{program}'s worktree is not made: {error:?}"))?;
    let environment: Vec<(String, String)> = std::env::vars()
        .filter(|(name, _)| !probe.environment.iter().any(|(probed, _)| probed == name))
        .chain(
            probe
                .environment
                .iter()
                .map(|&(name, value)| (name.to_owned(), value.to_owned())),
        )
        .collect();
    let arguments: Vec<String> = probe
        .arguments
        .iter()
        .map(|&argument| argument.to_owned())
        .collect();
    let request = SpawnRequest {
        shell: ShellCommand {
            program: program.to_owned(),
            arguments,
            environment: environment.clone(),
            folder: worktree.clone(),
            raw_command_tail: None,
        },
        fallback: ShellCommand {
            program: default_shell().to_string_lossy().into_owned(),
            arguments: Vec::new(),
            environment,
            folder: worktree.clone(),
            raw_command_tail: None,
        },
        working_directory: worktree.clone(),
        rows: 24,
        columns: 160,
        shell_start: CommandLine {
            program: DAEMON_PROGRAM.to_owned(),
            arguments: vec!["shell".to_owned(), std::process::id().to_string()],
        },
    };
    let request = translate_spawn_cwd(request, SpawnCwdStrategy::ShellFolder, &scratch_folder)
        .map_err(|error| format!("{program}'s start is not translated: {error:?}"))?;
    let terminals = Terminals::new(
        spawner(),
        CommandLine {
            program: "console-helper".to_owned(),
            arguments: Vec::new(),
        },
    );
    let mut spawned = terminals
        .spawn(request, |_answers| NoListener, KeepAllOutput)
        .await
        .map_err(|error| format!("{program} does not start: {error:?}"))?;
    let removal_outcome = async {
        read_to_prompt(
            &mut spawned.output,
            &prompt(probe.prompt_prefix, &worktree),
            program,
        )
        .await?;
        if probe.leaves_the_folder_first {
            terminals
                .queue_write(spawned.handle, Bytes::from_static(b"cd ..\r\n"))
                .map_err(|error| format!("{program} is not handed `cd ..`: {error:?}"))?
                .taken()
                .await
                .map_err(|error| format!("{program} does not take `cd ..`: {error:?}"))?;
            read_to_prompt(
                &mut spawned.output,
                &prompt(probe.prompt_prefix, &scratch_folder),
                program,
            )
            .await?;
        }
        std::fs::remove_dir(&worktree).map_err(|error| {
            format!("the worktree is not removed while {program} is open: {error:?}")
        })
    }
    .await;

    let closing = terminals
        .close(spawned.handle)
        .await
        .map_err(|error| format!("{program} does not close: {error:?}"));
    match (removal_outcome, closing) {
        (Ok(()), closing) => closing,
        (Err(failure), Ok(())) => Err(failure),
        (Err(failure), Err(closing_failure)) => Err(format!("{failure}; {closing_failure}")),
    }
}

// The prompt a shell shows in `folder`.
fn prompt(prefix: &str, folder: &Path) -> String {
    format!("{prefix}{}>", folder.display())
}
