//! The colorer's one thread. The tokenizer's registry is `!Send`, so it is built, used and dropped
//! on this named thread, which takes jobs in order from a channel and answers each on its own
//! oneshot. A job no reader wants any more is skipped at its turn, and one running stops at its
//! next line.
//!
//! The tokenizer is dropped after `idle_drop` with nothing asked, and between jobs once it has
//! colored more than `colored_bytes_budget` bytes in languages whose grammars name scopes from the
//! text they match, since the engine keeps every such name for the tokenizer's life. Each drop
//! clears the blocks' settled lines with it and hands the freed memory back from this thread.
//!
//! For each recent code block the thread keeps where its last version's complete lines ended, so
//! the block's next version, when it begins with exactly those lines, is colored from there on.

use std::error::Error;
use std::num::NonZeroUsize;
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Weak};
use std::thread;
use std::time::Duration;

use lru::LruCache;
use memchr::memrchr;
use sha2::{Digest as _, Sha256};
use sidekicks_contracts::highlight::HighlightLanguage;
use tokio::sync::oneshot;

use crate::highlight::tokenizer::{
    SettledLines, TokenizeEnd, TokenizeError, Tokenizer, TokenizerBuildError,
};
use crate::ipc::registry::TransportId;

/// The thread's name, as a debugger or a crash report shows it.
const THREAD_NAME: &str = "colorer";

/// How long the thread keeps its tokenizer with nothing asked.
const IDLE_DROP: Duration = Duration::from_mins(5);

/// Bytes colored in languages that name scopes from matched text past which the tokenizer is
/// dropped between jobs: the engine's kept names stay within the colorer's memory budget.
const COLORED_BYTES_BUDGET: usize = 400 * 1024;

/// How many blocks' settled lines the thread keeps, least recently colored dropped first.
const SETTLED_BLOCKS_LIMIT: NonZeroUsize = NonZeroUsize::new(8).expect("eight is not zero");

/// The (connection, code block) a read names.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct BlockKey {
    /// The connection the read came on.
    pub(crate) transport: TransportId,
    /// The block's id, which the client chooses.
    pub(crate) block_id: Arc<str>,
}

/// One tokenization the colorer asks of the thread.
pub(crate) struct TokenizeJob {
    /// The source; only the reads waiting for it hold it strongly.
    pub(crate) source: Weak<String>,
    /// The language to color the source as.
    pub(crate) language: HighlightLanguage,
    /// The block its first reader named, under which the block's next version resumes.
    pub(crate) block: Option<BlockKey>,
    /// SHA-256 of the source up to and including its last `\n` (of `""` when it has none).
    pub(crate) settled_digest: [u8; 32],
}

/// Why a tokenization gave no spans.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TokenizeFailure {
    /// The tokenizer did not build, a fault in the daemon's build; the next job tries again.
    #[error(transparent)]
    Build(#[from] TokenizerBuildError),
    /// The language's grammar or one of its patterns did not compile.
    #[error(transparent)]
    Tokenize(#[from] TokenizeError),
    /// The colorer stopped before the job's turn.
    #[error("the colorer has stopped")]
    Stopped,
}

/// What a tokenization answers: the packed spans, or why none came.
type TokenizeReply = Result<Arc<[u32]>, TokenizeFailure>;

/// How the thread runs.
pub(crate) struct TokenizerThreadOptions {
    /// How long the thread keeps its tokenizer with nothing asked; five minutes.
    pub(crate) idle_drop: Duration,
    /// Source bytes colored in languages that name scopes from matched text, past which the
    /// tokenizer is dropped between jobs; 400 KiB.
    pub(crate) colored_bytes_budget: usize,
    /// Run before each line inside its time limit, so a test can hold the thread on a line.
    #[cfg(test)]
    pub(crate) before_line: Option<Arc<dyn Fn(&str) + Send + Sync>>,
}

impl Default for TokenizerThreadOptions {
    fn default() -> Self {
        Self {
            idle_drop: IDLE_DROP,
            colored_bytes_budget: COLORED_BYTES_BUDGET,
            #[cfg(test)]
            before_line: None,
        }
    }
}

/// What the colorer sends the thread.
enum ThreadMessage {
    /// A job and the oneshot its answer goes on.
    Job {
        /// The tokenization asked for.
        job: TokenizeJob,
        /// Where its spans, or why none came, go.
        reply: oneshot::Sender<TokenizeReply>,
    },
    /// The colorer stopped: the thread drops its tokenizer now rather than when it next idles.
    Stop,
}

/// How often the thread built a tokenizer and ran a tokenization, for tests to count.
#[cfg(test)]
#[derive(Default)]
struct WorkCounts {
    /// Tokenizers built.
    tokenizer_builds: AtomicUsize,
    /// Jobs that reached the tokenizer.
    tokenizations: AtomicUsize,
}

/// The handle to the colorer's one thread. Dropping it ends the thread once its queued jobs are
/// answered.
pub(crate) struct TokenizerThread {
    /// The thread's queue.
    messages: mpsc::Sender<ThreadMessage>,
    /// Set once the colorer stops; every job the thread meets after it is refused.
    is_stopped: Arc<AtomicBool>,
    /// What the thread did, for tests.
    #[cfg(test)]
    counts: Arc<WorkCounts>,
}

impl TokenizerThread {
    /// Starts the one named thread; fails only when the system refuses a thread.
    pub(crate) fn start(options: TokenizerThreadOptions) -> std::io::Result<Self> {
        let (messages, thread_messages) = mpsc::channel();
        let is_stopped = Arc::new(AtomicBool::new(false));
        #[cfg(test)]
        let counts = Arc::new(WorkCounts::default());
        let coloring = ColoringThread {
            messages: thread_messages,
            options,
            is_stopped: Arc::clone(&is_stopped),
            #[cfg(test)]
            counts: Arc::clone(&counts),
        };
        thread::Builder::new()
            .name(THREAD_NAME.to_owned())
            .spawn(move || coloring.run())?;
        Ok(Self {
            messages,
            is_stopped,
            #[cfg(test)]
            counts,
        })
    }

    /// Queues `job`; the receiver answers its spans or why none came. The thread drops the sender
    /// unanswered when no reader holds the source any more (the job was unwanted).
    pub(crate) fn tokenize(&self, job: TokenizeJob) -> oneshot::Receiver<TokenizeReply> {
        let (reply, answer) = oneshot::channel();
        if self.is_stopped.load(Ordering::Relaxed) {
            send_reply(reply, Err(TokenizeFailure::Stopped));
            return answer;
        }
        if let Err(mpsc::SendError(ThreadMessage::Job { reply, .. })) =
            self.messages.send(ThreadMessage::Job { job, reply })
        {
            // The thread has ended, which only a panic on it does.
            send_reply(reply, Err(TokenizeFailure::Stopped));
        }
        answer
    }

    /// Refuses every waiting and later job `Stopped`; a running one finishes.
    pub(crate) fn stop(&self) {
        self.is_stopped.store(true, Ordering::Relaxed);
        if self.messages.send(ThreadMessage::Stop).is_err() {
            tracing::trace!("the colorer's thread had ended before its stop");
        }
    }

    /// How many tokenizers the thread has built.
    #[cfg(test)]
    pub(crate) fn tokenizer_build_count(&self) -> usize {
        self.counts.tokenizer_builds.load(Ordering::Relaxed)
    }

    /// How many jobs reached the tokenizer.
    #[cfg(test)]
    pub(crate) fn tokenization_count(&self) -> usize {
        self.counts.tokenizations.load(Ordering::Relaxed)
    }
}

/// Answers a job. A reader that left needs no answer: the spans are the colorer's to cache either
/// way.
fn send_reply(reply: oneshot::Sender<TokenizeReply>, answer: TokenizeReply) {
    if reply.send(answer).is_err() {
        tracing::trace!("a tokenization's readers left before its answer");
    }
}

/// What the thread owns: its queue, its settings, and the flag the colorer's stop sets.
struct ColoringThread {
    /// The colorer's messages, in order.
    messages: mpsc::Receiver<ThreadMessage>,
    /// How the thread runs.
    options: TokenizerThreadOptions,
    /// Set once the colorer stops.
    is_stopped: Arc<AtomicBool>,
    /// What the thread did, for tests.
    #[cfg(test)]
    counts: Arc<WorkCounts>,
}

/// A built tokenizer and what lives only as long as it: the blocks' settled lines, whose grammar
/// states belong to its registry, and the bytes it colored in languages that name scopes from
/// matched text.
struct BuiltTokenizer {
    /// The engine and its grammars.
    tokenizer: Tokenizer,
    /// Where each recent block's last version settled, least recently colored dropped first.
    settled_blocks: LruCache<BlockKey, SettledBlock>,
    /// Source bytes colored in languages whose grammars name scopes from the text they match.
    scope_naming_bytes: usize,
}

impl BuiltTokenizer {
    /// Counts `colored_bytes` of `language` toward the scope-naming budget when its grammar names
    /// scopes from matched text.
    fn count_colored(&mut self, language: HighlightLanguage, colored_bytes: usize) {
        if self.tokenizer.names_scopes_from_text(language) {
            self.scope_naming_bytes += colored_bytes;
        }
    }
}

/// Where a block's last colored version settled, from which its next version resumes.
#[derive(Clone)]
struct SettledBlock {
    /// The language the version was colored as.
    language: HighlightLanguage,
    /// Where the version's last complete line ends, with the grammar state after it.
    settled: SettledLines,
    /// The version's packed spans; those before the boundary are `spans[..settled.span_count]`.
    spans: Arc<[u32]>,
    /// SHA-256 of the version's bytes before the boundary.
    settled_digest: [u8; 32],
}

impl ColoringThread {
    /// Answers jobs until the colorer's handle is dropped. The thread waits with no timeout while
    /// no tokenizer is built, and drops a built one after the idle time.
    fn run(self) {
        let mut built: Option<BuiltTokenizer> = None;
        loop {
            let message = if built.is_some() {
                match self.messages.recv_timeout(self.options.idle_drop) {
                    Ok(message) => message,
                    Err(RecvTimeoutError::Timeout) => {
                        release(built.take());
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            } else {
                match self.messages.recv() {
                    Ok(message) => message,
                    Err(mpsc::RecvError) => break,
                }
            };
            built = match message {
                ThreadMessage::Job { job, reply } => self.answer(job, reply, built.take()),
                ThreadMessage::Stop => {
                    release(built.take());
                    None
                }
            };
        }
        release(built);
    }

    /// Answers one job with `built`, building a tokenizer when none is, and gives back the
    /// tokenizer to keep: none once its scope-naming budget is spent.
    fn answer(
        &self,
        job: TokenizeJob,
        reply: oneshot::Sender<TokenizeReply>,
        built: Option<BuiltTokenizer>,
    ) -> Option<BuiltTokenizer> {
        if self.is_stopped.load(Ordering::Relaxed) {
            send_reply(reply, Err(TokenizeFailure::Stopped));
            return built;
        }
        // No reader holds the source: the job is unwanted, so it is skipped unanswered.
        if job.source.strong_count() == 0 {
            return built;
        }
        let mut built = match built {
            Some(built) => built,
            None => match self.build() {
                Ok(built) => built,
                Err(error) => {
                    tracing::error!(
                        error = &error as &(dyn Error + 'static),
                        "the colorer's tokenizer did not build"
                    );
                    send_reply(reply, Err(error.into()));
                    return None;
                }
            },
        };
        let resume = match tokenize_start(&mut built.settled_blocks, &job) {
            TokenizeStart::FirstLine => None,
            TokenizeStart::Settled(saved) => Some(saved),
            TokenizeStart::Unwanted => return Some(built),
        };
        #[cfg(test)]
        self.counts.tokenizations.fetch_add(1, Ordering::Relaxed);
        let resume = resume
            .as_ref()
            .map(|saved| (&saved.settled, &saved.spans[..saved.settled.span_count]));
        let tokenized = match built.tokenizer.tokenize(&job.source, job.language, resume) {
            Ok(TokenizeEnd::Finished(tokenized)) => tokenized,
            // The last reader left while it ran; what it colored still counts.
            Ok(TokenizeEnd::Unwanted { colored_bytes }) => {
                built.count_colored(job.language, colored_bytes);
                return self.keep_within_budget(built);
            }
            Err(error) => {
                send_reply(reply, Err(error.into()));
                return Some(built);
            }
        };
        built.count_colored(job.language, tokenized.colored_bytes);
        if let Some(block) = job.block {
            built.settled_blocks.put(
                block,
                SettledBlock {
                    language: job.language,
                    settled: tokenized.settled,
                    spans: Arc::clone(&tokenized.spans),
                    settled_digest: job.settled_digest,
                },
            );
        }
        send_reply(reply, Ok(tokenized.spans));
        self.keep_within_budget(built)
    }

    /// Gives back `built`, or drops it once its scope-naming budget is spent.
    fn keep_within_budget(&self, built: BuiltTokenizer) -> Option<BuiltTokenizer> {
        if built.scope_naming_bytes > self.options.colored_bytes_budget {
            release(Some(built));
            return None;
        }
        Some(built)
    }

    /// Builds a fresh tokenizer with an empty settled-lines store.
    fn build(&self) -> Result<BuiltTokenizer, TokenizerBuildError> {
        let tokenizer = Tokenizer::build()?;
        #[cfg(test)]
        let tokenizer = {
            let mut tokenizer = tokenizer;
            self.counts.tokenizer_builds.fetch_add(1, Ordering::Relaxed);
            if let Some(before_line) = &self.options.before_line {
                tokenizer.set_before_line(Arc::clone(before_line));
            }
            tokenizer
        };
        Ok(BuiltTokenizer {
            tokenizer,
            settled_blocks: LruCache::new(SETTLED_BLOCKS_LIMIT),
            scope_naming_bytes: 0,
        })
    }
}

/// Where a job's tokenization starts.
enum TokenizeStart {
    /// From the source's first line.
    FirstLine,
    /// After the lines its block's last version settled, which the source begins with exactly.
    Settled(SettledBlock),
    /// Nowhere: no reader holds the source any more.
    Unwanted,
}

/// Where `job` starts: after its block's last settled lines when the source begins with exactly
/// those bytes, checked by digest and never by length alone, else from the first line.
fn tokenize_start(
    settled_blocks: &mut LruCache<BlockKey, SettledBlock>,
    job: &TokenizeJob,
) -> TokenizeStart {
    let Some(saved) = job
        .block
        .as_ref()
        .and_then(|block| settled_blocks.get(block))
        .filter(|saved| saved.language == job.language)
    else {
        return TokenizeStart::FirstLine;
    };
    // Held only for this check, so the reads stay the source's only holders while it is colored.
    let Some(source) = job.source.upgrade() else {
        return TokenizeStart::Unwanted;
    };
    let source_settled_length = memrchr(b'\n', source.as_bytes()).map_or(0, |index| index + 1);
    let saved_length = saved.settled.byte_length;
    let starts_with_saved = if saved_length == source_settled_length {
        saved.settled_digest == job.settled_digest
    } else {
        saved_length < source_settled_length && {
            let prefix_digest: [u8; 32] = Sha256::digest(&source.as_bytes()[..saved_length]).into();
            prefix_digest == saved.settled_digest
        }
    };
    if starts_with_saved {
        TokenizeStart::Settled(saved.clone())
    } else {
        TokenizeStart::FirstLine
    }
}

/// Drops a built tokenizer, with its settled lines and byte count, and hands the freed memory
/// back from this thread, whose own heap held most of it.
fn release(built: Option<BuiltTokenizer>) {
    if let Some(built) = built {
        drop(built);
        sidekicks_platforms::collect_freed_memory();
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;

    use rstest::rstest;
    use serde::Deserialize;
    use sha2::{Digest as _, Sha256};
    use sidekicks_contracts::highlight::HighlightLanguage;
    use tokio::time::timeout;

    use super::{BlockKey, TokenizeJob, TokenizerThread, TokenizerThreadOptions};
    use crate::ipc::registry::TransportId;

    /// How long any one answer may take before the test fails instead of hanging.
    const WAIT: Duration = Duration::from_secs(60);

    /// One language's fixture; only its source is read here.
    #[derive(Deserialize)]
    struct Fixture {
        source: String,
    }

    fn fixture_source(language: HighlightLanguage) -> String {
        let mut fixtures: HashMap<HighlightLanguage, Fixture> =
            serde_json::from_str(include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/highlight/classes.json"
            )))
            .expect("the fixture parses");
        fixtures
            .remove(&language)
            .expect("every language has a fixture")
            .source
    }

    fn job(
        source: &Arc<String>,
        language: HighlightLanguage,
        block: Option<&BlockKey>,
    ) -> TokenizeJob {
        let settled_length = source.rfind('\n').map_or(0, |index| index + 1);
        TokenizeJob {
            source: Arc::downgrade(source),
            language,
            block: block.cloned(),
            settled_digest: Sha256::digest(&source.as_bytes()[..settled_length]).into(),
        }
    }

    async fn spans(thread: &TokenizerThread, job: TokenizeJob) -> Arc<[u32]> {
        timeout(WAIT, thread.tokenize(job))
            .await
            .expect("the thread answers in time")
            .expect("the thread answers")
            .expect("the source colors")
    }

    fn start(options: TokenizerThreadOptions) -> TokenizerThread {
        TokenizerThread::start(options).expect("the thread starts")
    }

    // Mutation: never drop the tokenizer once it has sat idle.
    #[tokio::test]
    async fn drops_the_tokenizer_when_idle_and_colors_the_same_after() {
        let thread = start(TokenizerThreadOptions {
            idle_drop: Duration::from_millis(20),
            ..TokenizerThreadOptions::default()
        });
        let source = Arc::new(fixture_source(HighlightLanguage::Typescript));
        let first = spans(&thread, job(&source, HighlightLanguage::Typescript, None)).await;

        std::thread::sleep(Duration::from_millis(500));
        let second = spans(&thread, job(&source, HighlightLanguage::Typescript, None)).await;

        assert_eq!(thread.tokenizer_build_count(), 2);
        assert_eq!(*second, *first);
    }

    // Mutation: never drop the tokenizer past its budget.
    #[rstest]
    #[case::html_names_scopes_from_text(HighlightLanguage::Html, 2)]
    #[case::typescript_does_not(HighlightLanguage::Typescript, 1)]
    #[tokio::test]
    async fn drops_the_tokenizer_past_its_scope_naming_budget(
        #[case] language: HighlightLanguage,
        #[case] build_count: usize,
    ) {
        let thread = start(TokenizerThreadOptions {
            colored_bytes_budget: 0,
            ..TokenizerThreadOptions::default()
        });
        let source = Arc::new(fixture_source(language));
        let first = spans(&thread, job(&source, language, None)).await;

        let second = spans(&thread, job(&source, language, None)).await;

        assert_eq!(thread.tokenizer_build_count(), build_count);
        assert_eq!(*second, *first);
    }

    // Mutation: skip the digest check.
    #[tokio::test]
    async fn colors_a_streamed_block_as_from_scratch_at_every_version() {
        let language = HighlightLanguage::Typescript;
        let thread = start(TokenizerThreadOptions::default());
        let block = BlockKey {
            transport: TransportId(1),
            block_id: Arc::from("block"),
        };
        let source = fixture_source(language);
        let mut cuts = Vec::new();
        let mut line_start = 0;
        for line in source.split_inclusive('\n') {
            let line_end = line_start + line.len();
            let middle = (line_start + line.len() / 2..line_end)
                .find(|index| source.is_char_boundary(*index))
                .unwrap_or(line_end);
            cuts.extend([middle, line_end]);
            line_start = line_end;
        }
        // The first line's opening comment marker becomes code, which colors differently.
        assert!(source.is_char_boundary(2) && source.find('\n') > Some(2));
        let edited = format!("x {}", &source[2..]);
        let (edited_source, whole_source) = (Arc::new(edited.clone()), Arc::new(source.clone()));
        assert_ne!(
            *spans(&thread, job(&edited_source, language, None)).await,
            *spans(&thread, job(&whole_source, language, None)).await,
        );
        let versions = cuts
            .into_iter()
            .map(|cut| source[..cut].to_owned())
            // Longer than the last version, so the saved prefix is hashed from the source.
            .chain([format!("{edited}\nlet appended = 1;\n")])
            // Shorter than the last, so it is never resumed and resets the block.
            .chain([source.clone()])
            // The same settled length, so the job's own digest is compared.
            .chain([edited]);

        for version in versions {
            let version = Arc::new(version);
            let streamed = spans(&thread, job(&version, language, Some(&block))).await;
            let from_scratch = spans(&thread, job(&version, language, None)).await;
            assert_eq!(*streamed, *from_scratch, "{} bytes", version.len());
        }
    }

    // Mutation: no upgrade before each line.
    #[tokio::test]
    async fn stops_at_the_next_line_once_its_last_reader_leaves() {
        let line_calls = Arc::new(AtomicUsize::new(0));
        let (entered, has_entered) = mpsc::channel();
        let (released, is_released) = mpsc::channel();
        let thread = start(TokenizerThreadOptions {
            before_line: Some({
                let line_calls = Arc::clone(&line_calls);
                let is_released = Mutex::new(is_released);
                Arc::new(move |_line: &str| {
                    if line_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                        entered.send(()).expect("the test waits");
                        is_released
                            .lock()
                            .expect("the hook's lock is never held across a panic")
                            .recv_timeout(WAIT)
                            .expect("the test releases the first line");
                    }
                })
            }),
            ..TokenizerThreadOptions::default()
        });
        let source = Arc::new("let a = 1;\nlet b = 2;\nlet c = 3;\n".to_owned());
        let answer = thread.tokenize(job(&source, HighlightLanguage::Typescript, None));

        // The thread is on the first line before the test's copy, the only reader's, goes.
        has_entered
            .recv_timeout(WAIT)
            .expect("the thread reaches the first line");
        drop(source);
        released.send(()).expect("the hook waits");

        let answered = timeout(WAIT, answer)
            .await
            .expect("the thread lets the job go in time");
        assert!(
            answered.is_err(),
            "the job was answered after its last reader left"
        );
        assert_eq!(line_calls.load(Ordering::SeqCst), 1);
        assert_eq!(thread.tokenization_count(), 1);
    }
}
