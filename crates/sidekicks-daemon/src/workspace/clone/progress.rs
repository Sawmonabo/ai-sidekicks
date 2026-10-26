//! Git's progress as the clone card shows it: what git writes to stderr read line by line, and the
//! gate that lets at most four of the card's updates through a second, the latest winning.

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use sidekicks_contracts::repo::clone::{
    CloneLine, PROJECT_CLONE_LINE_MAX_LEN, ProjectCloneProgress,
};
use sidekicks_contracts::wire::integer::BoundedInt;
use sidekicks_contracts::wire::text::{ECMASCRIPT_WHITESPACE_CLASS, is_ecmascript_whitespace};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::text_cut::cut_to_code_points;

/// The least time between two updates the card receives: four a second.
pub(crate) const CLONE_UPDATE_INTERVAL: Duration = Duration::from_millis(250);

// `Receiving objects:  42% (420/1000)`, `remote: Counting objects: 100% (8/8), done.` and Git LFS's
// `Downloading LFS objects:  50% (1/2), 4 KB | 0 B/s`.
static PROGRESS_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "^(?:remote: )?([^:]+):[{ECMASCRIPT_WHITESPACE_CLASS}]+([0-9]{{1,3}})%"
    ))
    .expect("the pattern is valid")
});

// The longest unfinished line kept, in code points, while git has not ended it; past this its
// start is cut, so a stream with no line break never grows the daemon's memory.
const PENDING_TEXT_MAX_LEN: usize = 4 * PROJECT_CLONE_LINE_MAX_LEN;

/// Reads git's stderr for the clone card: the latest progress, handed to `on_progress` line by
/// line, and the line a failure is told with. Git redraws a progress line with a carriage return,
/// so a line ends at either break; only the newest lines are held.
pub(crate) struct GitProgressReader<OnProgress: FnMut(ProjectCloneProgress)> {
    on_progress: OnProgress,
    pending_text: String,
    last_error_line: Option<CloneLine>,
    last_line: Option<CloneLine>,
}

impl<OnProgress: FnMut(ProjectCloneProgress)> GitProgressReader<OnProgress> {
    /// A reader that hands each progress line git writes to `on_progress`.
    pub(crate) fn new(on_progress: OnProgress) -> Self {
        Self {
            on_progress,
            pending_text: String::new(),
            last_error_line: None,
            last_line: None,
        }
    }

    /// Reads one chunk of git's stderr, already decoded.
    pub(crate) fn read(&mut self, chunk: &str) {
        self.pending_text.push_str(chunk);
        let text = std::mem::take(&mut self.pending_text);
        let unfinished = match text.rfind(['\r', '\n']) {
            Some(last_break) => {
                for line in text[..last_break].split(['\r', '\n']) {
                    self.read_line(line);
                }
                &text[last_break + 1..]
            }
            None => text.as_str(),
        };
        last_code_points(unfinished, PENDING_TEXT_MAX_LEN).clone_into(&mut self.pending_text);
    }

    /// The line a failure is told with once git has exited: git's last `fatal:` or `error:` line,
    /// else its last line, else `None` when git wrote nothing.
    pub(crate) fn failure_line(mut self) -> Option<CloneLine> {
        let unfinished = std::mem::take(&mut self.pending_text);
        self.read_line(&unfinished);
        self.last_error_line.or(self.last_line)
    }

    fn read_line(&mut self, raw_line: &str) {
        let trimmed = raw_line.trim_matches(is_ecmascript_whitespace);
        // A line blank once trimmed, or once its NULs are dropped, is no line of git's.
        let Ok(line) = CloneLine::new(
            cut_to_code_points(trimmed, PROJECT_CLONE_LINE_MAX_LEN).replace('\0', ""),
        ) else {
            return;
        };
        if line.as_str().starts_with("fatal: ") || line.as_str().starts_with("error: ") {
            self.last_error_line = Some(line.clone());
            self.last_line = Some(line);
            return;
        }
        if let Some(progress) = progress_of(line.as_str()) {
            (self.on_progress)(progress);
        }
        self.last_line = Some(line);
    }
}

// The phase and percent a progress line carries; a line whose phase is blank carries none.
fn progress_of(line: &str) -> Option<ProjectCloneProgress> {
    let parts = PROGRESS_LINE.captures(line)?;
    let phase = parts
        .get(1)?
        .as_str()
        .trim_matches(is_ecmascript_whitespace);
    let percent: i64 = parts
        .get(2)?
        .as_str()
        .parse()
        .expect("one to three digits read as a number");
    Some(ProjectCloneProgress {
        phase: CloneLine::new(phase.to_owned()).ok()?,
        percent: Some(
            BoundedInt::new(percent.min(100)).expect("a percent capped at 100 lies in 0..=100"),
        ),
    })
}

// The last `max` code points of `text` (`max` at least one), starting on a whole character.
fn last_code_points(text: &str, max: usize) -> &str {
    text.char_indices()
        .nth_back(max - 1)
        .map_or(text, |(start, _)| &text[start..])
}

/// Lets an update through at most once per [`CLONE_UPDATE_INTERVAL`]: an update arriving sooner
/// waits for the interval to close, and a newer one replaces it while it waits, so nothing is
/// queued and the last update always arrives. Made and offered to inside a tokio runtime.
pub(crate) struct LatestUpdateGate<Update> {
    offered: watch::Sender<Option<Update>>,
    sending: JoinHandle<()>,
}

impl<Update: Clone + Send + Sync + 'static> LatestUpdateGate<Update> {
    /// A gate that hands each update it lets through to `send`, on a task of its own.
    pub(crate) fn new(mut send: impl FnMut(Update) + Send + 'static) -> Self {
        let (offered, mut waiting) = watch::channel(None::<Update>);
        let sending = tokio::spawn(async move {
            // Ends once the gate is dropped and nothing is left waiting.
            while waiting.changed().await.is_ok() {
                // Taken out before `send` runs, so the channel is never held across it.
                let update = waiting.borrow_and_update().clone();
                if let Some(update) = update {
                    send(update);
                    tokio::time::sleep(CLONE_UPDATE_INTERVAL).await;
                }
            }
        });
        Self { offered, sending }
    }

    /// Sends `update` now if the interval allows, else holds it as the one update waiting.
    pub(crate) fn offer(&self, update: Update) {
        self.offered.send_replace(Some(update));
    }

    /// Drops the update waiting, if any, and ends the gate, so nothing more is sent.
    pub(crate) fn close(self) {
        self.sending.abort();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use rstest::rstest;
    use sidekicks_contracts::repo::clone::ProjectCloneProgress;
    use sidekicks_contracts::wire::integer::BoundedInt;
    use sidekicks_contracts::wire::text::FreeFormText;
    use tokio::time::{Duration, Instant};

    use super::{CLONE_UPDATE_INTERVAL, GitProgressReader, LatestUpdateGate};
    use crate::mutex_lock::lock;

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn lets_at_most_four_updates_a_second_through_the_last_one_always_arriving() {
        let sent = Arc::new(Mutex::new(Vec::<(Instant, i64)>::new()));
        let gate = {
            let sent = Arc::clone(&sent);
            LatestUpdateGate::new(move |percent| {
                lock(&sent).push((Instant::now(), percent));
            })
        };
        // Git's progress through a reader, a line every 5 ms for two seconds.
        let burst_began = Instant::now();
        let mut reader = GitProgressReader::new(|progress: ProjectCloneProgress| {
            gate.offer(progress.percent.map_or(-1, BoundedInt::get));
        });
        for tick in 0..400 {
            reader.read(&format!("Receiving objects: {}% ({tick}/400)\r", tick / 4));
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        tokio::time::sleep(CLONE_UPDATE_INTERVAL).await;

        let sent = lock(&sent);
        assert_eq!(sent.first(), Some(&(burst_began, 0)));
        for pair in sent.windows(2) {
            assert!(pair[1].0 - pair[0].0 >= CLONE_UPDATE_INTERVAL);
        }
        assert_eq!(sent.last().map(|(_, percent)| *percent), Some(99));
    }

    #[rstest]
    #[case::redraw(
        "Receiving objects:  10% (1/10)\rReceiving objects:  20% (2/10)\r",
        &[("Receiving objects", 10), ("Receiving objects", 20)],
    )]
    #[case::remote_and_cap(
        "remote: Counting objects: 100% (8/8), done.\nResolving deltas: 250%\n",
        &[("Counting objects", 100), ("Resolving deltas", 100)],
    )]
    #[case::unfinished_held("Receiving objects:  10% (1/10)", &[])]
    #[case::blank_phase("remote:  : 10%\n\0\n", &[])]
    fn reads_each_progress_line_git_finishes(
        #[case] stderr: &str,
        #[case] expected: &[(&str, i64)],
    ) {
        let mut progress = Vec::new();
        let mut reader = GitProgressReader::new(|update: ProjectCloneProgress| {
            progress.push((
                update.phase.into_string(),
                update.percent.map(BoundedInt::get),
            ));
        });
        reader.read(stderr);
        drop(reader);
        let expected: Vec<_> = expected
            .iter()
            .map(|(phase, percent)| ((*phase).to_owned(), Some(*percent)))
            .collect();
        assert_eq!(progress, expected);
    }

    #[rstest]
    #[case::fatal_before_later_lines("error: one\nfatal: two\nCleaning up\n", Some("fatal: two"))]
    #[case::last_line("Cloning into 'app'...\nsomething else", Some("something else"))]
    #[case::nothing(" \r\n", None)]
    fn tells_a_failure_with_git_s_own_line(#[case] stderr: &str, #[case] line: Option<&str>) {
        let mut reader = GitProgressReader::new(|_: ProjectCloneProgress| {});
        reader.read(stderr);
        assert_eq!(
            reader.failure_line().as_ref().map(FreeFormText::as_str),
            line
        );
    }

    #[test]
    fn keeps_only_the_last_code_points_of_a_line_git_never_ends() {
        let tail = format!("b{}", "é".repeat(4 * 1024 - 1));
        let mut reader = GitProgressReader::new(|_: ProjectCloneProgress| {});
        reader.read(&"a".repeat(5_000));
        reader.read(&tail);
        let line = reader.failure_line().expect("the unfinished line is read");
        assert_eq!(line.as_str(), format!("b{}", "é".repeat(1023)));
    }
}
