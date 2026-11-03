//! A long-running child that refuses the daemon's stop, and its kill too where a test asks, so a
//! test can follow what a stop that failed leaves.

use std::io;
use std::process::Stdio;

use process_wrap::tokio::ChildWrapper;
use tokio::process::{Child, Command};

/// A child that runs until it is killed or dropped, whose three standard streams are piped. The
/// platform's stop is refused, and so is its kill where `is_kill_refused`.
#[derive(Debug)]
pub struct StopRefusingChild {
    child: Child,
    is_kill_refused: bool,
    // Whether the platform's stop, a kill on Windows, was refused already, so a later kill runs.
    #[cfg(windows)]
    was_stop_refused: bool,
}

impl StopRefusingChild {
    /// Starts the child, killed when it is dropped. Fails as the start fails.
    pub fn start(is_kill_refused: bool) -> io::Result<Self> {
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("/bin/sleep");
            command.arg("600");
            command
        };
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("ping");
            command.args(["-n", "601", "127.0.0.1"]);
            command
        };
        let child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        Ok(Self {
            child,
            is_kill_refused,
            #[cfg(windows)]
            was_stop_refused: false,
        })
    }

    /// The child, whose piped streams a test takes.
    pub fn child_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

impl ChildWrapper for StopRefusingChild {
    fn inner(&self) -> &dyn ChildWrapper {
        &self.child
    }

    fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
        &mut self.child
    }

    fn into_inner(self: Box<Self>) -> Box<dyn ChildWrapper> {
        Box::new(self.child)
    }

    // The platform's stop is a kill on Windows, so the first kill there is the refused stop.
    fn start_kill(&mut self) -> io::Result<()> {
        #[cfg(windows)]
        if !self.was_stop_refused {
            self.was_stop_refused = true;
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        if self.is_kill_refused {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        self.child.start_kill()
    }

    #[cfg(unix)]
    fn signal(&self, _signal: i32) -> io::Result<()> {
        Err(io::ErrorKind::PermissionDenied.into())
    }
}
