//! The confirmation every confirmed command asks before it acts: on a terminal, the command's
//! sentence and ` [y/N] ` on stderr, then one line read, `y` or `yes` in any case a yes and
//! anything else a no; `--yes` answers it beforehand, and with neither a terminal nor `--yes` the
//! command is refused as a usage error, so a script never hangs on a question no one sees.

use std::io::{self, BufRead, IsTerminal as _, Write};
use std::thread;

use anyhow::Context as _;
use clap::Args;
use sidekicks_client::error::ClientError;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// The `--yes` flag a confirmed command takes.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the confirmed commands take it: daemon stop and restart, data erase and restore"
    )
)]
#[derive(Debug, Args)]
pub(crate) struct ConfirmationArgs {
    /// Go on without asking first.
    #[arg(long)]
    yes: bool,
}

/// The command needs a yes, and neither a terminal to ask at nor `--yes` gives one.
#[derive(Debug, thiserror::Error)]
#[error("no terminal is here to confirm the command: run it again with --yes")]
pub(crate) struct ConfirmationUnavailableError;

/// Asks `sentence` on `prompt` and answers whether the person said yes; `--yes` answers yes with
/// nothing asked. The line is read on a thread of its own, so a Ctrl-C that cancels `cancel`
/// ends the wait. Fails with [`ConfirmationUnavailableError`] when stdin is not a terminal and
/// `--yes` was not given, with `ClientError::Canceled` after a Ctrl-C, and when the prompt cannot
/// be written or the answer read.
#[expect(
    dead_code,
    reason = "the confirmed commands call it: daemon stop and restart, data erase and restore"
)]
pub(crate) async fn confirm(
    sentence: &str,
    args: &ConfirmationArgs,
    prompt: &mut impl Write,
    cancel: &CancellationToken,
) -> anyhow::Result<bool> {
    if args.yes {
        return Ok(true);
    }
    if !io::stdin().is_terminal() {
        return Err(ConfirmationUnavailableError.into());
    }
    write!(prompt, "{sentence} [y/N] ")?;
    prompt.flush()?;
    let (answer_sender, answer) = oneshot::channel();
    // A plain thread rather than the runtime's blocking pool, whose shutdown would wait on a read
    // a Ctrl-C left behind.
    thread::Builder::new()
        .name("confirmation".to_owned())
        .spawn(move || answer_sender.send(read_answer(io::stdin().lock())))?;
    tokio::select! {
        answer = answer => Ok(answer.context("the confirmation ended with no answer")??),
        () = cancel.cancelled() => Err(ClientError::Canceled.into()),
    }
}

/// Reads one line from `reader`: `y` or `yes` in any case, spaces around it aside, is a yes, and
/// anything else, an empty line or the input's end among them, a no.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the confirmed commands read their answer through it: daemon stop and restart, \
                  data erase and restore"
    )
)]
fn read_answer(mut reader: impl BufRead) -> io::Result<bool> {
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let answer = line.trim();
    Ok(answer.eq_ignore_ascii_case("y") || answer.eq_ignore_ascii_case("yes"))
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::read_answer;

    #[rstest]
    #[case::y("y\n", true)]
    #[case::upper_y("Y\n", true)]
    #[case::yes("yes\n", true)]
    #[case::mixed_case_yes_with_spaces("  YeS \r\n", true)]
    #[case::no("n\n", false)]
    #[case::empty_line("\n", false)]
    #[case::end_of_input("", false)]
    #[case::longer_word("yess\n", false)]
    #[case::sentence("yes please\n", false)]
    fn only_y_or_yes_in_any_case_is_a_yes(#[case] typed: &str, #[case] is_yes: bool) {
        assert_eq!(read_answer(typed.as_bytes()).expect("a read"), is_yes);
    }
}
