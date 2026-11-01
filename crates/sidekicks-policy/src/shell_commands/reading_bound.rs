//! The daemon-wide bound on shell-line bytes being read: an ask's reads wait, in arrival order,
//! until the lines in flight leave room for its line, so the lines in flight together come to at
//! most one limit's worth of bytes, however many agents ask at once. Each ask's reader parses its
//! line, at most one reading of it with its here-document starts requoted, and the strings its
//! commands hand a shell, at most twice the limit in all.

use std::sync::Arc;

use tokio::sync::Semaphore;
use tokio::task::JoinError;

use super::ShellLineReader;

/// The one daemon-wide bound on the line bytes the shell-line reader parses at once, with the
/// reader's byte limit. Every ask reads its shell lines through `read`.
pub struct ShellLineReadingBound {
    // One permit per line byte, `limit` in all.
    permits: Arc<Semaphore>,
    limit: usize,
}

impl ShellLineReadingBound {
    /// A bound of `limit` line bytes, the reader's limit: a system's argument bound, under 4 GiB.
    pub fn new(limit: usize) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(limit)),
            limit,
        }
    }

    /// Runs `work` with an ask's own reader on a blocking thread, once `line_length` bytes are free
    /// within the bound; a line past the limit, which the reader does not parse, waits for none.
    /// The bytes stay taken until `work` ends, rereads of the line's `-c` and `eval` strings
    /// included. Fails when `work` panics.
    pub async fn read<T: Send + 'static>(
        &self,
        line_length: usize,
        work: impl FnOnce(&mut ShellLineReader) -> T + Send + 'static,
    ) -> Result<T, JoinError> {
        let permit = if line_length > self.limit {
            None
        } else {
            let permit_count = u32::try_from(line_length)
                .expect("a line within the limit, a system's argument bound, is under 4 GiB");
            Some(
                Arc::clone(&self.permits)
                    .acquire_many_owned(permit_count)
                    .await
                    .expect("the bound's semaphore is never closed"),
            )
        };
        let limit = self.limit;
        tokio::task::spawn_blocking(move || {
            // Held here, so an ask canceled while its parse runs frees its bytes only as it ends.
            let _permit = permit;
            work(&mut ShellLineReader::new(limit))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::ShellLineReadingBound;

    const LIMIT: usize = 64;
    // Far past any read here, so only a read that waits on permits reaches it.
    const WAIT: Duration = Duration::from_secs(60);

    #[tokio::test(start_paused = true)]
    async fn a_read_waits_while_its_bytes_are_held_and_runs_once_they_are_freed() {
        let bound = ShellLineReadingBound::new(LIMIT);
        let held = std::sync::Arc::clone(&bound.permits)
            .acquire_many_owned(u32::try_from(LIMIT).expect("a small limit"))
            .await
            .expect("the permits are free");
        let line = "git push";
        let mut read = Box::pin(bound.read(line.len(), move |reader| reader.read(line).is_whole()));

        assert!(tokio::time::timeout(WAIT, &mut read).await.is_err());
        drop(held);
        let is_whole = tokio::time::timeout(WAIT, read)
            .await
            .expect("the read runs once the bytes are freed")
            .expect("the read ends without a panic");

        assert!(is_whole);
    }

    #[tokio::test(start_paused = true)]
    async fn a_line_past_the_limit_waits_for_no_bytes() {
        let bound = ShellLineReadingBound::new(LIMIT);
        let _held = std::sync::Arc::clone(&bound.permits)
            .acquire_many_owned(u32::try_from(LIMIT).expect("a small limit"))
            .await
            .expect("the permits are free");
        let line = "a".repeat(LIMIT + 1);

        let is_whole = tokio::time::timeout(
            WAIT,
            bound.read(line.len(), move |reader| reader.read(&line).is_whole()),
        )
        .await
        .expect("the read runs at once")
        .expect("the read ends without a panic");

        assert!(!is_whole);
    }
}
