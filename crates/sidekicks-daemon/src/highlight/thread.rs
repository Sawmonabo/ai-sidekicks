//! The colorer's one thread. The tokenizer's registry is `!Send`, so it is built, used and dropped
//! on this named thread, which takes jobs in order from a channel and answers each on its own
//! oneshot. A job no reader wants any more is skipped at its turn, and one running stops at its
//! next line, as it does once the colorer stops.
//!
//! The tokenizer is dropped after `idle_drop` with nothing asked, and between jobs once it has
//! colored more than `scope_naming_bytes_budget` bytes in languages whose grammars name scopes from
//! the text they match, since the engine keeps every such name for the tokenizer's life. Each drop
//! clears the blocks' settled lines with it and hands the freed memory back from this thread.
//!
//! For each recent code block the thread keeps where its last version's complete lines ended, a
//! version that stopped unwanted included, so the block's next version, when it begins with
//! exactly those lines, is colored from there on. A version longer than the saved lines is resumed
//! at once and checked when it finishes, against the hash of its own text up to its last line
//! break; one that does not match is colored again from its first line.

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
use sidekicks_contracts::highlight::HighlightLanguage;
use sidekicks_ipc::registry::TransportId;
use tokio::sync::oneshot;

#[cfg(test)]
use crate::highlight::tokenizer::LineHook;
use crate::highlight::tokenizer::{
    SettledLines, TokenizeEnd, TokenizeError, Tokenizer, TokenizerBuildError,
};

/// The thread's name, as a debugger or a crash report shows it.
const THREAD_NAME: &str = "colorer";

/// How long the thread keeps its tokenizer with nothing asked.
const IDLE_DROP: Duration = Duration::from_mins(5);

/// Bytes colored in languages that name scopes from matched text past which the tokenizer is
/// dropped between jobs: the engine's kept names stay within the colorer's memory budget.
const SCOPE_NAMING_BYTES_BUDGET: usize = 400 * 1024;

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
    pub(crate) scope_naming_bytes_budget: usize,
    /// Run before each line inside its time limit, so a test can hold the thread on a line.
    #[cfg(test)]
    pub(crate) before_line: Option<LineHook>,
}

impl Default for TokenizerThreadOptions {
    fn default() -> Self {
        Self {
            idle_drop: IDLE_DROP,
            scope_naming_bytes_budget: SCOPE_NAMING_BYTES_BUDGET,
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

    /// Refuses every waiting and later job `Stopped`; a running one stops at its next line and is
    /// refused too.
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

/// Answers a job. Readers that all left need no answer, and their spans are dropped with it.
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
    /// Where the version's last complete line ends, with the grammar state after it and the hash
    /// of the text before it.
    settled: SettledLines,
    /// The version's packed spans; those before the boundary are `spans[..settled.span_count]`.
    spans: Arc<[u32]>,
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
        #[cfg(test)]
        let is_fresh = built.is_none();
        let mut built = match built {
            Some(built) => built,
            None => match build_tokenizer() {
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
        #[cfg(test)]
        if is_fresh {
            self.attach_test_hooks(&mut built);
        }
        let resume = match tokenize_start(&mut built.settled_blocks, &job) {
            TokenizeStart::FirstLine => None,
            TokenizeStart::Settled(saved) => Some(saved),
            TokenizeStart::Unwanted => return Some(built),
        };
        #[cfg(test)]
        self.counts.tokenizations.fetch_add(1, Ordering::Relaxed);
        let ended = match self.tokenize_from(&mut built, &job, resume.as_ref()) {
            // A resumed version whose text before the saved boundary differs is colored again.
            Ok(TokenizeEnd::Finished(tokenized))
                if resume.is_some() && tokenized.settled.digest() != job.settled_digest =>
            {
                built.count_colored(job.language, tokenized.colored_bytes);
                self.tokenize_from(&mut built, &job, None)
            }
            ended => ended,
        };
        let (tokenized, is_finished) = match ended {
            Ok(TokenizeEnd::Finished(tokenized)) => (tokenized, true),
            Ok(TokenizeEnd::Unwanted(tokenized)) => (tokenized, false),
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
                },
            );
        }
        if is_finished {
            send_reply(reply, Ok(tokenized.spans));
        } else if self.is_stopped.load(Ordering::Relaxed) {
            send_reply(reply, Err(TokenizeFailure::Stopped));
        }
        self.keep_within_budget(built)
    }

    /// Tokenizes `job` from its first line or after `resume`'s settled lines, reading its source
    /// before each line until the colorer stops or no reader holds it.
    fn tokenize_from(
        &self,
        built: &mut BuiltTokenizer,
        job: &TokenizeJob,
        resume: Option<&SettledBlock>,
    ) -> Result<TokenizeEnd, TokenizeError> {
        let wanted_source = || {
            if self.is_stopped.load(Ordering::Relaxed) {
                return None;
            }
            job.source.upgrade()
        };
        let resume = resume.map(|saved| (&saved.settled, &saved.spans[..saved.settled.span_count]));
        built
            .tokenizer
            .tokenize(wanted_source, job.language, resume)
    }

    /// Gives back `built`, or drops it once its scope-naming budget is spent.
    fn keep_within_budget(&self, built: BuiltTokenizer) -> Option<BuiltTokenizer> {
        if built.scope_naming_bytes > self.options.scope_naming_bytes_budget {
            release(Some(built));
            return None;
        }
        Some(built)
    }

    /// Counts a fresh tokenizer's build and gives it the test's line hook.
    #[cfg(test)]
    fn attach_test_hooks(&self, built: &mut BuiltTokenizer) {
        self.counts.tokenizer_builds.fetch_add(1, Ordering::Relaxed);
        if let Some(before_line) = &self.options.before_line {
            built.tokenizer.set_before_line(Arc::clone(before_line));
        }
    }
}

/// Builds a fresh tokenizer with an empty settled-lines store.
fn build_tokenizer() -> Result<BuiltTokenizer, TokenizerBuildError> {
    Ok(BuiltTokenizer {
        tokenizer: Tokenizer::build()?,
        settled_blocks: LruCache::new(SETTLED_BLOCKS_LIMIT),
        scope_naming_bytes: 0,
    })
}

/// Where a job's tokenization starts.
enum TokenizeStart {
    /// From the source's first line.
    FirstLine,
    /// After the lines its block's last version settled, which the source may begin with.
    Settled(SettledBlock),
    /// Nowhere: no reader holds the source any more.
    Unwanted,
}

/// Where `job` starts: after its block's last settled lines when the source may begin with
/// exactly those bytes. Saved lines as long as the source's are checked here by digest; shorter
/// ones are checked when the tokenization finishes, so the source is never hashed twice.
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
    let may_start_with_saved = if saved_length == source_settled_length {
        saved.settled.digest() == job.settled_digest
    } else {
        saved_length < source_settled_length
    };
    if may_start_with_saved {
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
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;

    use rstest::rstest;
    use serde::Deserialize;
    use sha2::{Digest as _, Sha256};
    use sidekicks_contracts::highlight::HighlightLanguage;
    use sidekicks_ipc::registry::TransportId;
    use tokio::time::timeout;

    use super::{BlockKey, TokenizeFailure, TokenizeJob, TokenizerThread, TokenizerThreadOptions};

    /// How long any one answer may take before the test fails instead of hanging.
    const WAIT: Duration = Duration::from_secs(60);

    /// One language's fixture; only its source is read here.
    #[derive(Deserialize)]
    struct Fixture {
        source: String,
    }

    fn fixture_source(language: HighlightLanguage) -> String {
        let mut fixtures: HashMap<HighlightLanguage, Fixture> =
            serde_json::from_str(include_str!("../../tests/fixtures/highlight/classes.json"))
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

        tokio::time::sleep(Duration::from_millis(500)).await;
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
            scope_naming_bytes_budget: 0,
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
            // Longer than the last version but not its continuation: resumed, then colored again.
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

    // Mutations: save nothing when a run stops unwanted; start every version from its first line.
    #[tokio::test]
    async fn a_version_stopped_for_the_next_saves_the_lines_it_colored() {
        let language = HighlightLanguage::Typescript;
        let colored_lines = Arc::new(Mutex::new(Vec::new()));
        let (entered, has_entered) = mpsc::channel();
        let (released, is_released) = mpsc::channel();
        let thread = start(TokenizerThreadOptions {
            before_line: Some({
                let colored_lines = Arc::clone(&colored_lines);
                let has_held = AtomicBool::new(false);
                let is_released = Mutex::new(is_released);
                Arc::new(move |line: &str| {
                    colored_lines
                        .lock()
                        .expect("the hook's lock is never held across a panic")
                        .push(line.to_owned());
                    if line == "let c = 3;" && !has_held.swap(true, Ordering::SeqCst) {
                        entered.send(()).expect("the test waits");
                        is_released
                            .lock()
                            .expect("the hook's lock is never held across a panic")
                            .recv_timeout(WAIT)
                            .expect("the test releases the held line");
                    }
                })
            }),
            ..TokenizerThreadOptions::default()
        });
        let block = BlockKey {
            transport: TransportId(1),
            block_id: Arc::from("block"),
        };
        let first = Arc::new("let a = 1;\nlet b = 2;\nlet c = 3;\nlet d = 4;\n".to_owned());
        let first_answer = thread.tokenize(job(&first, language, Some(&block)));
        has_entered
            .recv_timeout(WAIT)
            .expect("the thread reaches the held line");

        // The block's next version replaces the first while the thread is on its third line.
        let second = Arc::new(format!("{first}let e = 5;\n"));
        drop(first);
        let second_answer = thread.tokenize(job(&second, language, Some(&block)));
        released.send(()).expect("the hook waits");

        let first_answered = timeout(WAIT, first_answer)
            .await
            .expect("the thread lets the first version go in time");
        assert!(first_answered.is_err(), "the replaced version was answered");
        let streamed = timeout(WAIT, second_answer)
            .await
            .expect("the thread answers in time")
            .expect("the thread answers")
            .expect("the source colors");
        assert_eq!(
            *colored_lines
                .lock()
                .expect("the hook's lock is never held across a panic"),
            [
                "let a = 1;",
                "let b = 2;",
                "let c = 3;",
                "let d = 4;",
                "let e = 5;"
            ],
        );
        let from_scratch = spans(&thread, job(&second, language, None)).await;
        assert_eq!(*streamed, *from_scratch);
    }

    // Mutations: no upgrade before each line; no stop check before each line; no `Stopped` reply.
    #[rstest]
    #[case::its_last_reader_leaves(false)]
    #[case::the_colorer_stops(true)]
    #[tokio::test]
    async fn stops_at_the_next_line(#[case] is_colorer_stopping: bool) {
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
        let mut source = Some(Arc::new("let a = 1;\nlet b = 2;\nlet c = 3;\n".to_owned()));
        let answer = thread.tokenize(job(
            source.as_ref().expect("the test holds the source"),
            HighlightLanguage::Typescript,
            None,
        ));

        // The thread is on the first line before the colorer stops or the test's copy, the only
        // reader's, goes.
        has_entered
            .recv_timeout(WAIT)
            .expect("the thread reaches the first line");
        if is_colorer_stopping {
            thread.stop();
        } else {
            source = None;
        }
        released.send(()).expect("the hook waits");

        let answered = timeout(WAIT, answer)
            .await
            .expect("the thread lets the job go in time");
        // A job its readers left is dropped unanswered; one the colorer stopped answers so.
        if is_colorer_stopping {
            assert!(matches!(answered, Ok(Err(TokenizeFailure::Stopped))));
        } else {
            assert!(
                answered.is_err(),
                "the job was answered after its last reader left"
            );
        }
        drop(source);
        assert_eq!(line_calls.load(Ordering::SeqCst), 1);
        assert_eq!(thread.tokenization_count(), 1);
    }
}
