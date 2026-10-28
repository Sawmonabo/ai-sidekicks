//! A child that leads a process tree of its own, so an end past its time limit reaches everything
//! it started, a hook's processes among them, while its wait and its output read end at its own
//! exit, whatever a process it left behind still holds. Its exit can be waited for without reaping
//! it, so an end after the exit lands while the exited child still holds its group's id.

use std::error::Error;
use std::io;
use std::process::ExitStatus;

use process_wrap::tokio::ChildWrapper;
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWriteExt as _};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout, Command};

#[cfg(unix)]
use crate::posix::child_tree::{
    ask_child_tree_to_stop, end_child_tree, end_dropped_child_tree, read_ready_output,
    spawn_child_tree_process,
};
#[cfg(windows)]
use crate::windows::child_tree::{
    end_child_tree_now, read_output_left_at_exit, spawn_child_tree_process,
};
use crate::{PinnedProcess, pin_child_process};

/// The most one read of a child's output takes.
pub(crate) const OUTPUT_READ_CHUNK: usize = 64 * 1024;

/// A started child leading a tree of its own: its standard streams as the command set them, its
/// wait on the child alone, and an end that reaches its whole tree. Dropped before the child is
/// reaped, it ends the tree.
pub struct ChildTree {
    // Held until the drop, which on macOS and Linux hands it to the end of its tree.
    process: Option<Box<dyn ChildWrapper>>,
    // The child pinned on the first wait for its exit, which reads the exit without reaping it.
    pinned: Option<PinnedProcess>,
    is_reaped: bool,
}

/// What a child that ran to its exit printed, and how it exited.
#[derive(Debug)]
pub struct ChildTreeOutput {
    /// How the child exited.
    pub status: ExitStatus,
    /// Its standard output, every byte as written.
    pub stdout: Vec<u8>,
    /// Its standard error, every byte as written.
    pub stderr: Vec<u8>,
}

/// Why a child's output could not be read to its exit.
#[derive(Debug, thiserror::Error)]
pub enum ChildTreeOutputError {
    /// One stream went past the bound the caller set; nothing read is kept.
    #[error("the child's output went past {bound} bytes")]
    TooLarge {
        /// The bound, in bytes, one stream may reach.
        bound: usize,
    },
    /// The write of its input, a read of its output or its wait failed.
    #[error("the child's input, output or exit could not be read")]
    Io(#[source] io::Error),
}

/// Starts `command` as a child of the daemon `daemon_pid` leading a tree of its own: on macOS and
/// Linux the leader of a process group of its own, prepared as `prepare_child_command` prepares
/// it; on Windows in a job of its own that opens no console window and that closing the daemon's
/// handle does not end. Runs on the daemon's spawner thread. Fails with the spawn's error, or on
/// Windows the job's.
pub fn start_child_tree(command: Command, daemon_pid: u32) -> io::Result<ChildTree> {
    Ok(ChildTree {
        process: Some(spawn_child_tree_process(command, daemon_pid)?),
        pinned: None,
        is_reaped: false,
    })
}

impl ChildTree {
    /// Writes `input` to the child's standard input, if the command piped it, and closes it; reads
    /// its standard output and error, each up to `bound` bytes; and waits for the child alone. The
    /// reads end at the child's exit with what it wrote, so a process it left holding a stream
    /// stretches nothing. An input the child exits without reading is no failure: the exit tells
    /// it. The child is reaped only once its output is read, so on a failure an exited child still
    /// holds its group's id for the caller's [`end_tree`](Self::end_tree). Fails with `TooLarge`
    /// when a stream passes `bound`, else with the write's, a read's or the wait's error; the tree
    /// is left running either way.
    pub async fn wait_with_output(
        &mut self,
        input: Option<Vec<u8>>,
        bound: usize,
    ) -> Result<ChildTreeOutput, ChildTreeOutputError> {
        let process = self.process();
        let stdin = process.stdin().take();
        let mut stdout = process.stdout().take();
        let mut stderr = process.stderr().take();
        let mut stdout_bytes = Vec::new();
        let mut stderr_bytes = Vec::new();
        let is_output_read_to_end = {
            let output = async {
                let (written, read) = tokio::join!(write_input(stdin, input), async {
                    tokio::try_join!(
                        read_bounded_to_end(stdout.as_mut(), &mut stdout_bytes, bound),
                        read_bounded_to_end(stderr.as_mut(), &mut stderr_bytes, bound),
                    )
                });
                written.map_err(ChildTreeOutputError::Io)?;
                read.map(|((), ())| ())
            };
            let exited = self.wait_for_exit();
            tokio::pin!(output, exited);
            tokio::select! {
                biased;
                read = &mut output => {
                    read?;
                    true
                }
                exited = &mut exited => {
                    exited.map_err(ChildTreeOutputError::Io)?;
                    false
                }
            }
        };
        // What the child wrote before its exit is in the pipes now; read it without waiting for
        // an end of file a process it left behind can hold off.
        if !is_output_read_to_end {
            read_left_at_exit(stdout.as_mut(), &mut stdout_bytes, bound).await?;
            read_left_at_exit(stderr.as_mut(), &mut stderr_bytes, bound).await?;
        }
        let status = self.wait().await.map_err(ChildTreeOutputError::Io)?;
        Ok(ChildTreeOutput {
            status,
            stdout: stdout_bytes,
            stderr: stderr_bytes,
        })
    }

    /// Takes the child's standard output, if the command piped it and it was not taken before, so
    /// the caller reads it as the child writes it.
    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.process().stdout().take()
    }

    /// Takes the child's standard error, if the command piped it and it was not taken before, so
    /// the caller reads it as the child writes it.
    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.process().stderr().take()
    }

    /// Asks the child's whole tree to stop: on macOS and Linux `SIGTERM` to its group, sent on a
    /// blocking thread, so each process may clean up; on Windows, where no process can be asked
    /// ([`CAN_SIGNAL_A_STOP`](crate::CAN_SIGNAL_A_STOP) is false), the job's end at once. A tree
    /// already gone is no failure. Fails with the system's error.
    #[cfg_attr(
        windows,
        expect(
            clippy::unused_async,
            clippy::unused_async_trait_impl,
            reason = "only the macOS and Linux ask awaits, its signal on a blocking thread"
        )
    )]
    pub async fn ask_tree_to_stop(&mut self) -> io::Result<()> {
        #[cfg(unix)]
        ask_child_tree_to_stop(self.process()).await?;
        #[cfg(windows)]
        end_child_tree_now(self.process())?;
        Ok(())
    }

    /// Waits for the child alone to exit and reaps it, so the drop no longer ends its tree; a
    /// process it left behind runs on. A child already reaped, by an end among others, answers its
    /// exit at once. Dropped before the exit, the wait leaves the tree to the drop. Fails with the
    /// wait's error.
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        let status = self.process().inner_mut().wait().await?;
        self.is_reaped = true;
        Ok(status)
    }

    /// Waits for the child alone to exit without reaping it, so an exited child keeps holding its
    /// group's id until [`end_tree`](Self::end_tree) has ended what it left behind; no thread
    /// waits. A child already exited, or already reaped, answers at once. Must be called within
    /// the runtime. Fails with the system's error from the child's pin or its wait.
    pub async fn wait_for_exit(&mut self) -> io::Result<()> {
        if self.is_reaped {
            return Ok(());
        }
        if self.pinned.is_none() {
            // Only a reaped child has no id, and an unreaped child's id is no other process's.
            let Some(id) = self.process().id() else {
                return Ok(());
            };
            match pin_child_process(id) {
                Ok(pinned) => self.pinned = Some(pinned),
                // macOS pins only a running process, so an exited child is not found.
                #[cfg(unix)]
                Err(error) if error.raw_os_error() == Some(nix::errno::Errno::ESRCH as i32) => {
                    return Ok(());
                }
                Err(error) => return Err(error),
            }
        }
        self.pinned
            .as_ref()
            .expect("the child was pinned above")
            .wait_for_end()
            .await
    }

    /// Ends the child's whole tree, every process it started that is still in its group or job,
    /// and reaps the child. Called after [`wait_for_exit`](Self::wait_for_exit), it ends what the
    /// exited child left behind while the child still holds its group's id, so no other group
    /// that took the id is reached; a child already reaped has nothing ended on macOS and Linux.
    /// Fails with the system's error from the end or the wait.
    pub async fn end_tree(&mut self) -> io::Result<()> {
        #[cfg(unix)]
        end_child_tree(self.process()).await?;
        #[cfg(windows)]
        end_child_tree_now(self.process())?;
        self.process().inner_mut().wait().await?;
        self.is_reaped = true;
        Ok(())
    }

    fn process(&mut self) -> &mut dyn ChildWrapper {
        self.process
            .as_deref_mut()
            .expect("a child tree holds its process until it drops")
    }
}

impl Drop for ChildTree {
    fn drop(&mut self) {
        if self.is_reaped {
            return;
        }
        #[cfg(unix)]
        let ended = self.process.take().map_or(Ok(()), end_dropped_child_tree);
        #[cfg(windows)]
        let ended = end_child_tree_now(self.process());
        if let Err(error) = ended {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a dropped child's tree could not be ended"
            );
        }
    }
}

/// Reads into `into` what `stderr`, a child's standard error taken with
/// [`take_stderr`](ChildTree::take_stderr), holds once the child has exited, without waiting for an
/// end of file a process it left behind can hold off; a read of it dropped at the exit loses
/// nothing. Fails with `TooLarge` once `into` passes `bound`, else with the read's error.
pub async fn read_stderr_left_at_exit(
    stderr: &mut ChildStderr,
    into: &mut Vec<u8>,
    bound: usize,
) -> Result<(), ChildTreeOutputError> {
    read_left_at_exit(Some(stderr), into, bound).await
}

/// A child's output pipe as each system's read at its exit takes it.
#[cfg(unix)]
trait ChildPipe: AsyncRead + std::os::fd::AsFd + Unpin {}
#[cfg(unix)]
impl<Pipe: AsyncRead + std::os::fd::AsFd + Unpin> ChildPipe for Pipe {}

/// A child's output pipe as each system's read at its exit takes it.
#[cfg(windows)]
trait ChildPipe: AsyncRead + std::os::windows::io::AsRawHandle + Unpin {}
#[cfg(windows)]
impl<Pipe: AsyncRead + std::os::windows::io::AsRawHandle + Unpin> ChildPipe for Pipe {}

// Reads what `stream` holds at its child's exit: what the pipe holds now on macOS and Linux, and on
// Windows the read tokio left under way, canceled with its bytes kept, then what the pipe holds.
#[cfg_attr(
    unix,
    expect(
        clippy::unused_async,
        reason = "only Windows' read awaits, its cancel of the read left under way"
    )
)]
async fn read_left_at_exit(
    stream: Option<&mut impl ChildPipe>,
    into: &mut Vec<u8>,
    bound: usize,
) -> Result<(), ChildTreeOutputError> {
    #[cfg(unix)]
    return read_ready_output(stream.map(|stream| &*stream), into, bound);
    #[cfg(windows)]
    return read_output_left_at_exit(stream, into, bound).await;
}

// Writes `input` to the child and closes its standard input. A child that exits without reading
// it closes the pipe, which is no failure here.
async fn write_input(stdin: Option<ChildStdin>, input: Option<Vec<u8>>) -> io::Result<()> {
    let (Some(mut stdin), Some(input)) = (stdin, input) else {
        return Ok(());
    };
    match stdin.write_all(&input).await {
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        written => written,
    }
}

/// Reads `stream` to its end into `into`, one chunk at most per read; no stream reads nothing.
/// Fails with `TooLarge` once it passes `bound` bytes, else with the read's error; a dropped read
/// keeps what it read in `into`.
pub async fn read_bounded_to_end(
    stream: Option<&mut (impl AsyncRead + Unpin)>,
    into: &mut Vec<u8>,
    bound: usize,
) -> Result<(), ChildTreeOutputError> {
    let Some(stream) = stream else {
        return Ok(());
    };
    loop {
        into.reserve(OUTPUT_READ_CHUNK);
        let count = (&mut *stream)
            .take(u64::try_from(OUTPUT_READ_CHUNK).expect("a chunk's size fits in 64 bits"))
            .read_buf(into)
            .await
            .map_err(ChildTreeOutputError::Io)?;
        if count == 0 {
            return Ok(());
        }
        check_output_bound(into, bound)?;
    }
}

/// Fails with `TooLarge` once `read` has passed `bound` bytes.
pub(crate) fn check_output_bound(read: &[u8], bound: usize) -> Result<(), ChildTreeOutputError> {
    if read.len() > bound {
        return Err(ChildTreeOutputError::TooLarge { bound });
    }
    Ok(())
}
