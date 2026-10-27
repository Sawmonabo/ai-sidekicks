//! A helper mode's own side: its work runs on one thread while another reads standard input, which
//! carries nothing, and the mode ends as soon as either finishes, since the daemon closes that
//! input when it stops waiting for the work.

use std::error::Error;
use std::io;
use std::process::ExitCode;
use std::sync::mpsc;
use std::thread;

use crate::error_description::describe_error;
use crate::standard_error::write_error_line;

// What ended the mode first: its work, or the end of standard input.
enum ModeEnd<Failure> {
    Work(Result<(), Failure>),
    Input(io::Result<()>),
}

/// Runs `work` on a thread of its own until it answers or standard input ends, whichever comes
/// first. Exits 0 once the work succeeds, 1 with why on standard error when it fails, and 1 as
/// soon as standard input ends, the work's thread ending with the process.
pub fn run_until_input_ends<Failure>(
    work: impl FnOnce() -> Result<(), Failure> + Send + 'static,
) -> ExitCode
where
    Failure: Error + Send + 'static,
{
    let (ended, first_end) = mpsc::channel();
    let input_ended = ended.clone();
    let watching = thread::Builder::new().spawn(move || {
        let read = io::copy(&mut io::stdin().lock(), &mut io::sink()).map(|_| ());
        // A send fails only once the mode has answered, and the process is ending.
        input_ended.send(ModeEnd::Input(read)).unwrap_or(());
    });
    let working = thread::Builder::new().spawn(move || {
        ended.send(ModeEnd::Work(work())).unwrap_or(());
    });
    if let Err(failure) = watching.and(working) {
        return exit_with_failure(&failure);
    }
    match first_end
        .recv()
        .expect("a thread holds a sender until it sends its end")
    {
        ModeEnd::Work(Ok(())) => ExitCode::SUCCESS,
        ModeEnd::Work(Err(failure)) => exit_with_failure(&failure),
        ModeEnd::Input(Ok(())) => ExitCode::FAILURE,
        ModeEnd::Input(Err(failure)) => exit_with_failure(&failure),
    }
}

// Writes `failure` and its causes to standard error, whose tail the daemon keeps, and answers the
// failed exit; when the write fails, the exit code alone tells the daemon.
fn exit_with_failure(failure: &(dyn Error + 'static)) -> ExitCode {
    write_error_line(&describe_error(failure));
    ExitCode::FAILURE
}
