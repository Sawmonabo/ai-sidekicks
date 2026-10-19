//! A shell opened on a worktree through the spawn translator and the `shell` mode leaves the
//! worktree removable while it is still open, for each shell the host's probe table names: on
//! Windows cmd once it has left the folder and PowerShell at once, elsewhere every shell at once.

use std::path::Path;
use std::time::Duration;

use alacritty_terminal::event::EventListener;
use bytes::Bytes;
use sidekicks_daemon::session::spawn_cwd_translator::{SpawnCwdStrategy, translate_spawn_cwd};
use sidekicks_platforms::{SHELL_FOLDER_PROBES, ShellFolderProbe, Spawner, real_path};
use sidekicks_terminal::{
    CommandLine, OutputFilter, ScreenListener, SpawnRequest, TerminalEvent, TerminalOutput,
    Terminals,
};
use tokio::runtime::Handle;

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

/// Reads `program`'s output until it holds `prompt`; fails the test when the output ends first or
/// the prompt takes past [`PROMPT_BOUND`].
async fn read_to_prompt(output: &mut TerminalOutput, prompt: &str, program: &str) {
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
    .unwrap_or_else(|_elapsed| panic!("{program}'s prompt {prompt:?} arrives in time"))
    .unwrap_or_else(|failure| panic!("{failure}"));
}

// Fails when the `shell` mode or the shell holds the worktree as its current folder: the mode
// spawned in the worktree, cmd's folder handed to the mode rather than to the shell, or PowerShell
// started in the worktree instead of being told it by its switch.
#[tokio::test(flavor = "multi_thread")]
async fn a_worktree_is_removable_while_its_shell_is_open() {
    for probe in SHELL_FOLDER_PROBES {
        open_and_remove_worktree(probe).await;
    }
}

// Opens `probe`'s shell on a fresh worktree, waits for its prompt there (and, where it holds the
// folder, for its prompt one folder up after `cd ..`), then removes the worktree with the shell
// still open.
async fn open_and_remove_worktree(probe: &ShellFolderProbe) {
    let program = probe.program;
    let scratch = tempfile::tempdir().expect("a scratch folder");
    // The shell's prompt shows the folder with its links resolved.
    let scratch_folder = real_path(scratch.path()).expect("the scratch folder resolves");
    let worktree = scratch_folder.join(probe.folder_name);
    std::fs::create_dir(&worktree).expect("the worktree is made");
    let environment = std::env::vars()
        .filter(|(name, _)| !probe.environment.iter().any(|(probed, _)| probed == name))
        .chain(
            probe
                .environment
                .iter()
                .map(|&(name, value)| (name.to_owned(), value.to_owned())),
        )
        .collect();
    let request = SpawnRequest {
        program: program.to_owned(),
        arguments: probe
            .arguments
            .iter()
            .map(|&argument| argument.to_owned())
            .collect(),
        environment,
        working_directory: worktree.clone(),
        shell_folder: worktree.clone(),
        raw_command_tail: None,
        rows: 24,
        columns: 160,
        shell_start: CommandLine {
            program: env!("CARGO_BIN_EXE_sidekicks-daemon").to_owned(),
            arguments: vec!["shell".to_owned(), std::process::id().to_string()],
        },
    };
    let request = translate_spawn_cwd(request, SpawnCwdStrategy::ShellFolder, &scratch_folder)
        .expect("the stable folder is set and the worktree path is text");
    let terminals = Terminals::new(
        Spawner::new(Handle::current()).expect("the spawner starts"),
        CommandLine {
            program: "console-helper".to_owned(),
            arguments: Vec::new(),
        },
    );
    let mut spawned = terminals
        .spawn(request, |_answers| NoListener, KeepAllOutput)
        .await
        .unwrap_or_else(|error| panic!("{program} starts: {error:?}"));
    read_to_prompt(
        &mut spawned.output,
        &prompt(probe.prompt_prefix, &worktree),
        program,
    )
    .await;
    if probe.leaves_the_folder_first {
        terminals
            .queue_write(spawned.handle, Bytes::from_static(b"cd ..\r\n"))
            .expect("the line is handed over")
            .taken()
            .await
            .expect("the line is taken");
        read_to_prompt(
            &mut spawned.output,
            &prompt(probe.prompt_prefix, &scratch_folder),
            program,
        )
        .await;
    }

    let removal = std::fs::remove_dir(&worktree);

    terminals
        .close(spawned.handle)
        .await
        .unwrap_or_else(|error| panic!("{program} closes: {error:?}"));
    assert!(
        removal.is_ok(),
        "the worktree is removed while {program} is open: {removal:?}"
    );
}

// The prompt a shell shows in `folder`.
fn prompt(prefix: &str, folder: &Path) -> String {
    format!("{prefix}{}>", folder.display())
}
