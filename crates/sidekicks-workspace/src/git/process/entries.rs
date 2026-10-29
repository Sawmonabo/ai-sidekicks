//! A git call whose standard output is handed over one entry at a time as git prints it, so a
//! listing is never held whole and only each entry keeps to the output bound.

use std::process::Stdio;

use sidekicks_contracts::place::Place;
use sidekicks_platforms::read_bounded_to_end;
use tokio::io::{AsyncBufReadExt as _, AsyncRead, AsyncReadExt as _, BufReader};

use super::{GitCall, GitError, GitRunner, exited_failure};

impl GitRunner {
    /// Runs `call` for a project at `place` as [`run`](Self::run) does, but hands each entry of its
    /// standard output to `on_entry` as git prints it, without the `separator` that ends it. Each
    /// entry and the standard error keep to the runner's output bound, and the whole call to its
    /// time. Fails as `run` does, with `NotStartable` for a call given input, and with `Exited`
    /// holding no standard output.
    pub(crate) async fn run_by_entry(
        &self,
        place: Option<&Place>,
        call: GitCall,
        separator: u8,
        mut on_entry: impl FnMut(&[u8]),
    ) -> Result<(), GitError> {
        if call.input.is_some() {
            return Err(GitError::NotStartable);
        }
        let executable = self.executable_for(place)?;
        let timeout = call.timeout.map_or(self.limits.timeout, |timeout| {
            timeout.min(self.limits.timeout)
        });
        let prepared = self.prepare(executable, call).await?;
        let mut child = self
            .start_git(
                executable,
                prepared.arguments,
                prepared.environment,
                false,
                Stdio::piped(),
            )
            .await?;
        let stdout = child
            .take_stdout()
            .expect("a listing's standard output is piped");
        let stderr = child
            .take_stderr()
            .expect("a git call's standard error is piped");
        let bound = self.limits.output_bytes;
        // A read runs no hook and no file-watch helper, so no process git leaves behind holds a
        // pipe open past its exit.
        let ran = tokio::time::timeout(timeout, async {
            let ((), stderr) = tokio::try_join!(
                read_entries(stdout, separator, bound, &mut on_entry),
                read_stderr(stderr, bound),
            )?;
            let status = child.wait().await.map_err(GitError::Read)?;
            Ok::<_, GitError>((status, stderr))
        })
        .await;
        let failure = match ran {
            Ok(Ok((status, _))) if status.success() => return Ok(()),
            Ok(Ok((status, stderr))) => return Err(exited_failure(status, Vec::new(), stderr)),
            Ok(Err(failure)) => failure,
            Err(_elapsed) => GitError::TimedOut { timeout },
        };
        self.end_failed_tree(child);
        Err(failure)
    }
}

// Hands each `separator`-ended entry of `stream` to `on_entry`, the last one also when git ends it
// with no separator. Fails with `OutputTooLarge` for an entry past `bound`, else the read's error.
async fn read_entries(
    stream: impl AsyncRead + Unpin,
    separator: u8,
    bound: usize,
    on_entry: &mut impl FnMut(&[u8]),
) -> Result<(), GitError> {
    let mut reader = BufReader::new(stream);
    let mut entry = Vec::new();
    loop {
        entry.clear();
        let read = (&mut reader)
            .take(past_bound(bound))
            .read_until(separator, &mut entry)
            .await
            .map_err(GitError::Read)?;
        if read == 0 {
            return Ok(());
        }
        if entry.last() == Some(&separator) {
            entry.pop();
        } else if entry.len() > bound {
            return Err(GitError::OutputTooLarge { bound });
        }
        on_entry(&entry);
    }
}

// `stream` read to its end as UTF-8, any other byte replaced. Fails with `OutputTooLarge` past
// `bound`, else the read's error.
async fn read_stderr(mut stream: impl AsyncRead + Unpin, bound: usize) -> Result<String, GitError> {
    let mut bytes = Vec::new();
    read_bounded_to_end(Some(&mut stream), &mut bytes, bound).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// How many bytes a read takes to tell a stream that passed `bound` from one that did not.
fn past_bound(bound: usize) -> u64 {
    u64::try_from(bound).map_or(u64::MAX, |bound| bound.saturating_add(1))
}
