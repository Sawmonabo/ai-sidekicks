//! A shell's PTY: how it opens through the daemon's `shell` mode, the launch frame the mode reads
//! after the daemon confirms its start, and the hold on the shell that stays with the PTY.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_platforms::{
    Pty, ShellContainment, ShellLaunch, ShellStart, ShellStartConfirmation, TerminalStart,
};
use tokio::runtime::Handle;
use tokio::task::AbortHandle;

/// A program and the arguments it starts with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandLine {
    /// The program to run.
    pub program: String,
    /// The arguments it starts with, in order.
    pub arguments: Vec<String>,
}

/// One shell the `shell` mode may start: its program, arguments, folder and environment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellCommand {
    /// The shell's program: an absolute path, or a bare name looked up on the environment's `PATH`.
    pub program: String,
    /// The arguments the shell's program starts with.
    pub arguments: Vec<String>,
    /// Exactly the shell's environment, in order; a later entry with a name already given wins.
    /// A name is never empty and holds no `=`, and no name or value holds a NUL.
    pub environment: Vec<(String, String)>,
    /// The folder the `shell` mode starts the shell in.
    pub folder: PathBuf,
    /// Text the shell parses itself, which the `shell` mode writes after the shell's arguments
    /// exactly as given.
    pub raw_command_tail: Option<String>,
}

/// What one terminal starts as: the shell, and the shell the `shell` mode starts in its place when
/// the first cannot be started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnRequest {
    /// The shell the person's terminal runs.
    pub shell: ShellCommand,
    /// The platform's default shell, started when `shell` cannot be.
    pub fallback: ShellCommand,
    /// The folder the PTY spawns the `shell` mode in, one no person removes.
    pub working_directory: PathBuf,
    /// The terminal's height in rows.
    pub rows: u16,
    /// The terminal's width in columns.
    pub columns: u16,
    /// The daemon's `shell` mode, its program by absolute path, with its arguments; it reads both
    /// launches from the daemon once the daemon confirms it started the mode.
    pub shell_start: CommandLine,
}

impl SpawnRequest {
    /// The frame the `shell` mode reads: both launches, each environment with one entry per name.
    /// Fails with `InvalidInput` for an environment entry the mode could not hand on, a folder that
    /// is not text, or a launch past the frame's bound.
    pub(crate) fn launch_frame(&self) -> io::Result<Vec<u8>> {
        ShellLaunch {
            shell: shell_start(&self.shell),
            fallback: shell_start(&self.fallback),
        }
        .encode()
    }
}

// `command` as the `shell` mode starts it, each name's last value kept in its first place.
fn shell_start(command: &ShellCommand) -> ShellStart {
    let mut environment: Vec<(String, String)> = Vec::with_capacity(command.environment.len());
    let mut position_of_name: HashMap<&str, usize> = HashMap::new();
    for (name, value) in &command.environment {
        match position_of_name.entry(name.as_str()) {
            Entry::Occupied(position) => environment[*position.get()].1.clone_from(value),
            Entry::Vacant(position) => {
                position.insert(environment.len());
                environment.push((name.clone(), value.clone()));
            }
        }
    }
    ShellStart {
        program: command.program.clone(),
        arguments: command.arguments.clone(),
        raw_command_tail: command.raw_command_tail.clone(),
        folder: command.folder.clone(),
        environment,
    }
}

/// The daemon's hold on one shell for its whole life: the end of its start's confirmation, which
/// the `shell` mode reads only while it is open, the task writing its launch, and on Linux the
/// cgroup the shell runs in, all released once the shell has ended.
pub(crate) struct ShellHold {
    /// The daemon's end of the confirmation that it started the shell's `shell` mode.
    start_confirmation: ShellStartConfirmation,
    /// The task writing the launch frame, ended if it still waits once the shell is released.
    launch_write: Option<AbortHandle>,
    /// The shell's own containment, which ends what is left of its tree as it drops.
    _containment: ShellContainment,
}

impl Drop for ShellHold {
    fn drop(&mut self) {
        if let Some(launch_write) = self.launch_write.take() {
            launch_write.abort();
        }
    }
}

impl ShellHold {
    /// Starts writing `frame` to the `shell` mode from a task on `runtime`, never on the spawner
    /// thread, so a launch larger than the socket's buffer waits for the mode's read without
    /// holding a thread. A failed write is logged; the mode then starts nothing.
    pub(crate) fn write_launch(&mut self, runtime: &Handle, frame: Vec<u8>) -> io::Result<()> {
        let _entered = runtime.enter();
        let writer = self.start_confirmation.launch_writer()?;
        let task = runtime.spawn(async move {
            if let Err(error) = writer.write(&frame).await {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "a shell's launch did not reach its shell mode"
                );
            }
        });
        self.launch_write = Some(task.abort_handle());
        Ok(())
    }
}

/// A shell's open PTY and the daemon's hold on it, released together once the shell has ended.
pub(crate) struct OpenedPty {
    /// The shell's PTY.
    pub(crate) pty: Pty,
    /// The confirmation, the launch's writer and the shell's containment.
    pub(crate) hold: ShellHold,
}

impl OpenedPty {
    /// Ends the shell's program and releases the PTY, `mark_exited` running once the program has
    /// exited, then drops the hold; blocking, so it runs off the runtime's workers.
    pub(crate) fn release(self, mark_exited: impl FnOnce()) {
        sidekicks_platforms::release_terminal(self.pty, mark_exited);
        drop(self.hold);
    }
}

/// Opens the shell's PTY and starts the daemon's `shell` mode in it, in `working_directory`, then
/// confirms to the mode that the daemon started it and moves it into its own containment, before
/// any launch is written; blocking, so it runs on the daemon's spawner thread, which starts no
/// other child between the confirmation's opening and its writing, inside `runtime`, which the
/// confirmation's pipe registers with on Windows. Fails with `NotADirectory` when the mode's
/// folder is not a folder, with `InvalidInput` when the system reports no process id, and with the
/// system's error when the terminal cannot be opened, the program started (the error then names
/// it) or its start confirmed; a start not confirmed ends the program.
pub(crate) fn open_pty(request: &SpawnRequest, runtime: &Handle) -> io::Result<OpenedPty> {
    let _entered = runtime.enter();
    if !request.working_directory.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            format!("{} is not a folder", request.working_directory.display()),
        ));
    }
    let mut start_confirmation = ShellStartConfirmation::new()?;
    let pty = sidekicks_platforms::start_terminal(&TerminalStart {
        program: Path::new(&request.shell_start.program),
        arguments: &request.shell_start.arguments,
        folder: &request.working_directory,
        rows: request.rows,
        columns: request.columns,
        confirmation: &start_confirmation,
    })?;
    let confirmed = sidekicks_platforms::child_process_id(&pty)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "the system reported no process id for the shell mode",
            )
        })
        .and_then(|process_id| {
            start_confirmation.confirm(process_id)?;
            Ok(process_id)
        });
    let process_id = match confirmed {
        Ok(process_id) => process_id,
        Err(error) => {
            // Closed first, so the mode reads its end closed and refuses, and the release is quick.
            drop(start_confirmation);
            sidekicks_platforms::release_terminal(pty, || {});
            return Err(error);
        }
    };
    Ok(OpenedPty {
        pty,
        hold: ShellHold {
            start_confirmation,
            launch_write: None,
            _containment: ShellContainment::new(process_id),
        },
    })
}
