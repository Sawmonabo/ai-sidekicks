//! A shell opened on a worktree through the spawn translator and the `shell` mode leaves the
//! worktree removable while it is still open: cmd once it has left the folder, PowerShell at once.

use std::path::Path;
use std::time::Duration;

use alacritty_terminal::event::EventListener;
use bytes::Bytes;
use rstest::rstest;
use sidekicks_daemon::session::spawn_cwd_translator::{SpawnCwdStrategy, translate_spawn_cwd};
use sidekicks_platforms::Spawner;
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

/// Reads the output until it holds `prompt`; fails the test when the output ends first or the
/// prompt takes past [`PROMPT_BOUND`].
async fn read_to_prompt(output: &mut TerminalOutput, prompt: &str) {
    tokio::time::timeout(PROMPT_BOUND, async {
        let mut text = String::new();
        while !text.contains(prompt) {
            let event = output.next().await;
            let Some(TerminalEvent::Output(chunk)) = &event else {
                return Err(format!("the output ended before {prompt:?}: {event:?}"));
            };
            text.push_str(&String::from_utf8_lossy(chunk));
        }
        Ok(())
    })
    .await
    .expect("the prompt arrives in time")
    .expect("the output holds the prompt");
}

// Fails when the `shell` mode or the shell holds the worktree as its current folder: the mode
// spawned in the worktree, cmd's folder handed to the mode rather than to the shell, or PowerShell
// started in the worktree instead of being told it by its switch.
#[rstest]
#[case::cmd_after_it_leaves_the_folder("cmd.exe", "", true)]
#[case::pwsh_at_once("pwsh.exe", "PS ", false)]
#[tokio::test(flavor = "multi_thread")]
async fn a_worktree_is_removable_while_its_shell_is_open(
    #[case] program: &str,
    #[case] prompt_prefix: &str,
    #[case] leaves_the_folder: bool,
) {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let worktree = scratch.path().join("worktree");
    std::fs::create_dir(&worktree).expect("the worktree is made");
    let request = SpawnRequest {
        program: program.to_owned(),
        arguments: Vec::new(),
        environment: std::env::vars().collect(),
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
    let request = translate_spawn_cwd(request, SpawnCwdStrategy::ShellFolder, scratch.path())
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
        .expect("the shell starts");
    read_to_prompt(&mut spawned.output, &prompt(prompt_prefix, &worktree)).await;
    if leaves_the_folder {
        terminals
            .queue_write(spawned.handle, Bytes::from_static(b"cd ..\r\n"))
            .expect("the line is handed over")
            .taken()
            .await
            .expect("the line is taken");
        read_to_prompt(&mut spawned.output, &prompt(prompt_prefix, scratch.path())).await;
    }

    let removal = std::fs::remove_dir(&worktree);

    terminals
        .close(spawned.handle)
        .await
        .expect("the shell closes");
    assert!(
        removal.is_ok(),
        "the worktree is removed while the shell is open: {removal:?}"
    );
}

// The prompt a shell shows in `folder`.
fn prompt(prefix: &str, folder: &Path) -> String {
    format!("{prefix}{}>", folder.display())
}
