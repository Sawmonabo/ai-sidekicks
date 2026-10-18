//! The daemon's one colorer: a span cache keyed on what a source holds, over the thread that colors
//! a source the cache does not hold yet. The cache outlives the thread's tokenizer, so code already
//! colored is answered at once.
//!
//! The cache is bounded by what its entries hold, 1/2048 of physical memory, and keyed by the
//! language and a digest of the source, so the same code asked for twice is colored once and the
//! cache never holds the source itself. A source with a line left plain because it ran past the
//! time limit is kept too, since coloring it again would hold the thread on the same line.
//!
//! The reads waiting to be colored are bounded by what still wants them: reads of the same code
//! share one tokenization, and a read for a code block is replaced by the block's next read on the
//! same connection, as a block whose code is still arriving asks again for each version. Only the
//! waiting reads hold a source, so a tokenization no read waits for any more leaves the line before
//! its turn, keeping nothing of its source.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::task::{Context, Poll, Waker};

use futures::FutureExt as _;
use futures::future::{Map, Shared};
use memchr::memrchr;
use quick_cache::sync::{Cache, DefaultLifecycle};
use quick_cache::{DefaultHashBuilder, OptionsBuilder, Weighter};
use sha2::{Digest as _, Sha256};
use sidekicks_contracts::highlight::HighlightLanguage;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_platforms::physical_memory;
use tokio::sync::oneshot;

use crate::highlight::thread::{
    BlockKey, TokenizeFailure, TokenizeJob, TokenizerThread, TokenizerThreadOptions,
};
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::{HandlerError, TransportId};

/// The span cache holds this fraction of the machine's physical memory: 1/2048.
const SPAN_CACHE_MEMORY_DIVISOR: u64 = 2048;

/// What one cache entry is expected to weigh, which sizes the cache's record of recently evicted
/// keys: the spans of a code block of about fifty lines.
const TYPICAL_SPAN_CACHE_ENTRY_BYTES: u64 = 4 * 1024;

/// Bytes a cache entry costs beyond its spans and its key. The spans' `Arc<[u32]>` handle sits in
/// the cache's slot and two reference counts head their allocation; the slot around the key and
/// handle adds its variant tag, residency state and `u16` reference counter (padded to the
/// handle's 8-byte alignment) and the slab's two `u32` list links; the shard's map adds a `u32`
/// token and one control byte.
const SPAN_CACHE_ENTRY_OVERHEAD_BYTES: u64 = {
    let spans_handle = size_of::<Arc<[u32]>>() + 2 * size_of::<usize>();
    let slot = 8 + 2 * size_of::<u32>();
    let map_slot = size_of::<u32>() + 1;
    (spans_handle + slot + map_slot) as u64
};

/// What a refused read tells the person whose block asked again.
const READ_REPLACED_MESSAGE: &str = "A newer read for the same code block replaced this one";

/// What the thread answers a job: its spans, or why none came.
type ThreadAnswer = Result<Arc<[u32]>, TokenizeFailure>;

/// One tokenization's answer as every read of it receives it.
type FetchOutcome = Result<Arc<[u32]>, Arc<TokenizeFailure>>;

/// One tokenization's answer, shared by every read of the same code.
type SharedSpans = Shared<
    Map<
        oneshot::Receiver<ThreadAnswer>,
        fn(Result<ThreadAnswer, oneshot::error::RecvError>) -> FetchOutcome,
    >,
>;

/// The cache of colored code, by language and source digest.
type SpanCache = Cache<SpanCacheKey, Arc<[u32]>, SpanWeighter>;

/// How the colorer starts.
pub(crate) struct CodeHighlighterOptions {
    /// The span cache's budget in bytes; 1/2048 of physical memory.
    pub(crate) span_cache_bytes: u64,
    /// How the colorer's thread runs.
    pub(crate) thread: TokenizerThreadOptions,
}

impl CodeHighlighterOptions {
    /// The options for this machine: the cache's budget from its physical memory, read once.
    pub(crate) fn for_this_machine() -> Self {
        Self {
            span_cache_bytes: physical_memory() / SPAN_CACHE_MEMORY_DIVISOR,
            thread: TokenizerThreadOptions::default(),
        }
    }
}

/// Colors code and keeps what it colored. One per daemon.
pub(crate) struct CodeHighlighter {
    /// The cache and the waiting reads, which each waiting read also holds.
    shared: Arc<ColorerShared>,
    /// The thread that colors what the cache does not hold.
    thread: TokenizerThread,
}

impl CodeHighlighter {
    /// Starts the colorer and its thread; fails only when the system refuses a thread.
    pub(crate) fn start(options: CodeHighlighterOptions) -> std::io::Result<Self> {
        // One shard, so an entry may take up to 97% of the whole budget rather than of one
        // shard's share of it.
        let cache_options = OptionsBuilder::new()
            .shards(1)
            .weight_capacity(options.span_cache_bytes)
            .estimated_items_capacity(
                usize::try_from((options.span_cache_bytes / TYPICAL_SPAN_CACHE_ENTRY_BYTES).max(1))
                    .unwrap_or(usize::MAX),
            )
            .build()
            .expect("the span cache's options name its weight capacity and its item estimate");
        let thread = TokenizerThread::start(options.thread)?;
        Ok(Self {
            shared: Arc::new(ColorerShared {
                cache: Cache::with_options(
                    cache_options,
                    SpanWeighter,
                    DefaultHashBuilder::default(),
                    DefaultLifecycle::default(),
                ),
                reads: Mutex::new(WaitingReads::default()),
            }),
            thread,
        })
    }

    /// The packed `[offset, length, class]` spans of `source` as `language`, offsets in UTF-16
    /// units. Answers at once from the cache, else joins or starts the one tokenization of that
    /// code. A read naming a block is refused `Replaced` when the same block on the same
    /// connection asks again before it is answered.
    pub(crate) fn read_spans(
        &self,
        source: String,
        language: HighlightLanguage,
        transport: TransportId,
        block_id: Option<Arc<str>>,
    ) -> SpanRead {
        let digests = SourceDigests::of(&source);
        let key = SpanCacheKey {
            language,
            digest: digests.whole,
        };
        if let Some(spans) = self.shared.cache.get(&key) {
            return SpanRead::cached(spans);
        }
        let block = block_id.map(|block_id| BlockKey {
            transport,
            block_id,
        });
        let mut reads = self.shared.lock_reads();
        // A read of the same code may have finished while this one waited for the lock; a
        // finishing read fills the cache under it.
        if let Some(spans) = self.shared.cache.get(&key) {
            return SpanRead::cached(spans);
        }
        let (fetch_id, source, spans) = if let Some(joined) = reads.join_fetch(&key) {
            // The fetch's own copy keeps its tokenization wanted, so this one goes.
            drop(source);
            joined
        } else {
            let source = Arc::new(source);
            let fetch_id = FetchId(reads.mint_id());
            let settle: fn(Result<ThreadAnswer, oneshot::error::RecvError>) -> FetchOutcome =
                settle_answer;
            let spans = self
                .thread
                .tokenize(TokenizeJob {
                    source: Arc::downgrade(&source),
                    language,
                    block: block.clone(),
                    settled_digest: digests.settled,
                })
                .map(settle)
                .shared();
            reads.fetches.insert(
                key,
                Fetch {
                    id: fetch_id,
                    source: Arc::downgrade(&source),
                    spans: spans.clone(),
                    reader_count: 1,
                },
            );
            (fetch_id, source, spans)
        };
        let read_id = ReadId(reads.mint_id());
        reads.waiting.insert(
            read_id,
            WaitingRead {
                key,
                fetch_id,
                source,
                block: block.clone(),
                waker: None,
            },
        );
        // The newer read has joined its fetch first, so a block asking again for the same code
        // keeps its tokenization.
        let replaced = block
            .and_then(|block| reads.reads_by_block.insert(block, read_id))
            .and_then(|replaced_id| reads.leave(replaced_id));
        drop(reads);
        if let Some(waker) = replaced.and_then(|replaced| replaced.waker) {
            waker.wake();
        }
        SpanRead {
            state: SpanReadState::Waiting {
                shared: Arc::clone(&self.shared),
                read_id,
                spans,
            },
        }
    }

    /// Refuses every waiting read and every later cache miss.
    pub(crate) fn stop(&self) {
        self.thread.stop();
    }
}

/// One waiting read: a future of its spans whose drop leaves the read.
pub(crate) struct SpanRead {
    /// Where the read stands.
    state: SpanReadState,
}

/// Where one read stands.
enum SpanReadState {
    /// Answered from the cache; the spans go out at the first poll.
    Cached(Arc<[u32]>),
    /// Waiting for its tokenization.
    Waiting {
        /// The colorer's cache and waiting reads.
        shared: Arc<ColorerShared>,
        /// This read among the waiting reads.
        read_id: ReadId,
        /// The tokenization's answer.
        spans: SharedSpans,
    },
    /// Answered; nothing more to give.
    Answered,
}

impl SpanRead {
    /// A read the cache answered.
    fn cached(spans: Arc<[u32]>) -> Self {
        Self {
            state: SpanReadState::Cached(spans),
        }
    }
}

impl Future for SpanRead {
    type Output = Result<Arc<[u32]>, ReadSpansError>;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let answer = match &mut this.state {
            SpanReadState::Cached(spans) => Ok(Arc::clone(spans)),
            SpanReadState::Waiting {
                shared,
                read_id,
                spans,
            } => {
                if shared.lock_reads().watch(*read_id, context.waker()) {
                    let Poll::Ready(outcome) = spans.poll_unpin(context) else {
                        return Poll::Pending;
                    };
                    if shared.finish(*read_id, &outcome) {
                        outcome.map_err(ReadSpansError::Tokenize)
                    } else {
                        Err(ReadSpansError::Replaced)
                    }
                } else {
                    Err(ReadSpansError::Replaced)
                }
            }
            // An answered read is not polled again; it stays pending if it is.
            SpanReadState::Answered => return Poll::Pending,
        };
        this.state = SpanReadState::Answered;
        Poll::Ready(answer)
    }
}

impl Drop for SpanRead {
    fn drop(&mut self) {
        if let SpanReadState::Waiting {
            shared, read_id, ..
        } = &self.state
        {
            shared.leave(*read_id);
        }
    }
}

/// Why a read gave no spans.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ReadSpansError {
    /// The same block on the same connection asked again before this read was answered.
    #[error("a newer read for the same code block replaced this one")]
    Replaced,
    /// The thread gave no spans for the code.
    #[error("the code could not be colored")]
    Tokenize(#[source] Arc<TokenizeFailure>),
}

impl From<ReadSpansError> for HandlerError {
    fn from(error: ReadSpansError) -> Self {
        match error {
            ReadSpansError::Replaced => Self::Refused(DomainError::new(
                READ_REPLACED_MESSAGE,
                RefusalCode::HighlightReadReplaced,
            )),
            ReadSpansError::Tokenize(_) => Self::Internal(Box::new(error)),
        }
    }
}

/// The colorer's part every waiting read shares: the cache and the waiting reads.
struct ColorerShared {
    /// Colored code, by language and source digest.
    cache: SpanCache,
    /// The tokenizations in flight and the reads waiting for them; never held across an await.
    reads: Mutex<WaitingReads>,
}

impl ColorerShared {
    fn lock_reads(&self) -> MutexGuard<'_, WaitingReads> {
        self.reads
            .lock()
            .expect("no panic holds the colorer's lock, since a panic ends the daemon")
    }

    /// Takes `read_id` out of the waiting reads, if it still waits. Its source is released once
    /// the lock is.
    fn leave(&self, read_id: ReadId) {
        // Two statements, so the lock's guard goes before the source does.
        let left = self.lock_reads().leave(read_id);
        drop(left);
    }

    /// Settles a read whose tokenization answered `outcome`: the first of the fetch's readers to
    /// finish puts its spans in the cache and retires the fetch, so the next read of the code is
    /// a cache hit, or tries again after a failure. False when the read was replaced first.
    fn finish(&self, read_id: ReadId, outcome: &FetchOutcome) -> bool {
        let mut reads = self.lock_reads();
        let Some(read) = reads.waiting.get(&read_id) else {
            return false;
        };
        let (key, fetch_id) = (read.key, read.fetch_id);
        if reads
            .fetches
            .get(&key)
            .is_some_and(|fetch| fetch.id == fetch_id)
        {
            if let Ok(spans) = outcome {
                self.cache.insert(key, Arc::clone(spans));
            }
            reads.fetches.remove(&key);
        }
        let left = reads.leave(read_id);
        drop(reads);
        drop(left);
        true
    }
}

/// The tokenizations in flight and the reads waiting for them.
#[derive(Default)]
struct WaitingReads {
    /// The one tokenization in flight per code.
    fetches: HashMap<SpanCacheKey, Fetch>,
    /// Every waiting read.
    waiting: HashMap<ReadId, WaitingRead>,
    /// The waiting read of each block that named one.
    reads_by_block: HashMap<BlockKey, ReadId>,
    /// The last id minted for a fetch or a read.
    last_id: u64,
}

impl WaitingReads {
    fn mint_id(&mut self) -> u64 {
        self.last_id += 1;
        self.last_id
    }

    /// Joins the tokenization of `key` in flight, when its source is still held: the fetch's id,
    /// its source and its answer.
    fn join_fetch(&mut self, key: &SpanCacheKey) -> Option<(FetchId, Arc<String>, SharedSpans)> {
        let fetch = self.fetches.get_mut(key)?;
        let source = fetch.source.upgrade()?;
        fetch.reader_count += 1;
        Some((fetch.id, source, fetch.spans.clone()))
    }

    /// Takes `read_id` out: its block's entry goes when it is still this read's, and its fetch
    /// goes with its last reader, which leaves the job nothing to upgrade. The read comes back so
    /// its source is released outside the lock.
    fn leave(&mut self, read_id: ReadId) -> Option<WaitingRead> {
        let read = self.waiting.remove(&read_id)?;
        if let Some(block) = &read.block
            && self.reads_by_block.get(block) == Some(&read_id)
        {
            self.reads_by_block.remove(block);
        }
        if let Some(fetch) = self.fetches.get_mut(&read.key)
            && fetch.id == read.fetch_id
        {
            fetch.reader_count -= 1;
            if fetch.reader_count == 0 {
                self.fetches.remove(&read.key);
            }
        }
        Some(read)
    }

    /// Keeps `waker` to wake the read when it is replaced; false when it already was.
    fn watch(&mut self, read_id: ReadId, waker: &Waker) -> bool {
        let Some(read) = self.waiting.get_mut(&read_id) else {
            return false;
        };
        if !read
            .waker
            .as_ref()
            .is_some_and(|kept| kept.will_wake(waker))
        {
            read.waker = Some(waker.clone());
        }
        true
    }
}

/// One tokenization in flight, shared by every read of the same code.
struct Fetch {
    /// Tells this fetch from a later one of the same code.
    id: FetchId,
    /// The source the job reads, which only the waiting reads hold.
    source: Weak<String>,
    /// The job's answer.
    spans: SharedSpans,
    /// How many reads wait for it.
    reader_count: usize,
}

/// One read waiting for a fetch.
struct WaitingRead {
    /// The code it reads.
    key: SpanCacheKey,
    /// The fetch it waits for.
    fetch_id: FetchId,
    /// The fetch's source, held while the read waits.
    source: Arc<String>,
    /// The block it was asked for, if any.
    block: Option<BlockKey>,
    /// Wakes the read's future when it is replaced.
    waker: Option<Waker>,
}

/// A fetch among the colorer's fetches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FetchId(u64);

/// A read among the colorer's waiting reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct ReadId(u64);

/// A source's place in the cache: its language and the SHA-256 of its text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct SpanCacheKey {
    /// The language it is colored as.
    language: HighlightLanguage,
    /// The SHA-256 of the whole source.
    digest: [u8; 32],
}

/// Weighs a cache entry by what it holds: its spans, its key and the entry around them.
#[derive(Clone)]
struct SpanWeighter;

impl Weighter<SpanCacheKey, Arc<[u32]>> for SpanWeighter {
    fn weight(&self, _key: &SpanCacheKey, spans: &Arc<[u32]>) -> u64 {
        (size_of_val::<[u32]>(spans) + size_of::<SpanCacheKey>()) as u64
            + SPAN_CACHE_ENTRY_OVERHEAD_BYTES
    }
}

/// A source's two digests from one pass: the whole source, the cache's key, and the source up to
/// and including its last `\n`, which a block's next version resumes after.
struct SourceDigests {
    /// The SHA-256 of the whole source.
    whole: [u8; 32],
    /// The SHA-256 of the source through its last `\n`; of `""` when it has none.
    settled: [u8; 32],
}

impl SourceDigests {
    fn of(source: &str) -> Self {
        let settled_length = memrchr(b'\n', source.as_bytes()).map_or(0, |index| index + 1);
        let (settled, rest) = source.as_bytes().split_at(settled_length);
        let mut hasher = Sha256::new();
        hasher.update(settled);
        let settled_digest = hasher.clone().finalize().into();
        hasher.update(rest);
        Self {
            whole: hasher.finalize().into(),
            settled: settled_digest,
        }
    }
}

/// The thread's answer as the readers share it. A reply the thread dropped unanswered means the
/// thread has stopped, since a job any read still waits for is never skipped.
fn settle_answer(answer: Result<ThreadAnswer, oneshot::error::RecvError>) -> FetchOutcome {
    match answer {
        Ok(Ok(spans)) => Ok(spans),
        Ok(Err(failure)) => Err(Arc::new(failure)),
        Err(_) => Err(Arc::new(TokenizeFailure::Stopped)),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;

    use sidekicks_contracts::highlight::HighlightLanguage;
    use tokio::time::timeout;

    use super::{
        CodeHighlighter, CodeHighlighterOptions, ReadSpansError, SPAN_CACHE_MEMORY_DIVISOR,
        SpanRead,
    };
    use crate::highlight::thread::TokenizerThreadOptions;
    use crate::ipc::registry::TransportId;

    /// How long a test waits for any one answer before it fails.
    const WAIT_LIMIT: Duration = Duration::from_secs(30);

    /// The source a held colorer's thread stops on until the test lets it go.
    const HELD_SOURCE: &str = "const held = 0;";

    /// An 8 GiB machine's span cache budget.
    const EIGHT_GIB_SPAN_CACHE_BYTES: u64 = (8 << 30) / SPAN_CACHE_MEMORY_DIVISOR;

    /// A colorer's thread stopped on its first line until the test lets it go.
    struct ThreadHold {
        /// Lets the thread go on.
        release: mpsc::Sender<()>,
    }

    impl ThreadHold {
        fn release(&self) {
            self.release
                .send(())
                .expect("the thread waits on its first line");
        }
    }

    fn start_colorer(thread: TokenizerThreadOptions) -> CodeHighlighter {
        CodeHighlighter::start(CodeHighlighterOptions {
            span_cache_bytes: EIGHT_GIB_SPAN_CACHE_BYTES,
            thread,
        })
        .expect("the system gives the colorer its thread")
    }

    /// A colorer whose thread is stopped on the first line it colors, `HELD_SOURCE`'s, with the
    /// read of it, so the reads a test makes next wait.
    fn held_colorer() -> (CodeHighlighter, SpanRead, ThreadHold) {
        let (entered_sender, entered) = mpsc::channel::<()>();
        let (release, released) = mpsc::channel::<()>();
        let released = Mutex::new(released);
        let has_held = AtomicBool::new(false);
        let before_line: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |_line: &str| {
            if !has_held.swap(true, Ordering::SeqCst) {
                entered_sender
                    .send(())
                    .expect("the test waits for the hold");
                released
                    .lock()
                    .expect("one thread colors")
                    .recv_timeout(WAIT_LIMIT)
                    .expect("the test lets the thread go");
            }
        });
        let colorer = start_colorer(TokenizerThreadOptions {
            before_line: Some(before_line),
            ..TokenizerThreadOptions::default()
        });
        let held = read(&colorer, HELD_SOURCE, 0, None);
        entered
            .recv_timeout(WAIT_LIMIT)
            .expect("the thread reached its first line");
        (colorer, held, ThreadHold { release })
    }

    fn read(
        colorer: &CodeHighlighter,
        source: &str,
        transport: u64,
        block: Option<&str>,
    ) -> SpanRead {
        colorer.read_spans(
            source.to_owned(),
            HighlightLanguage::Typescript,
            TransportId(transport),
            block.map(Arc::from),
        )
    }

    async fn answer(read: SpanRead) -> Result<Arc<[u32]>, ReadSpansError> {
        timeout(WAIT_LIMIT, read)
            .await
            .expect("the read answered in time")
    }

    async fn colored(read: SpanRead) -> Arc<[u32]> {
        let spans = answer(read).await.expect("the read is colored");
        assert!(!spans.is_empty(), "the code has colored spans");
        spans
    }

    #[tokio::test]
    async fn reads_of_one_code_share_one_tokenization() {
        // Mutation: start a second tokenization per reader.
        let (colorer, held, hold) = held_colorer();
        let source = "const shared = [1, 2, 3];\n";
        let reads = [
            read(&colorer, source, 1, None),
            read(&colorer, source, 1, Some("a")),
            read(&colorer, source, 2, Some("b")),
        ];
        hold.release();
        answer(held).await.expect("the held read is answered");
        let mut spans = Vec::new();
        for waiting in reads {
            spans.push(colored(waiting).await);
        }
        assert!(spans.iter().all(|each| Arc::ptr_eq(each, &spans[0])));
        let from_cache = colored(read(&colorer, source, 3, Some("c"))).await;
        assert!(Arc::ptr_eq(&from_cache, &spans[0]));
        // The held source and the shared code, each once.
        assert_eq!(colorer.thread.tokenization_count(), 2);
    }

    #[tokio::test]
    async fn a_block_asking_again_replaces_its_waiting_read() {
        // Mutation: the replacement leaves the earlier read waiting.
        let (colorer, held, hold) = held_colorer();
        let first = read(&colorer, "const b = 1;", 1, Some("x"));
        let sharing = read(&colorer, "const b = 1;", 1, Some("y"));
        let newer = read(&colorer, "const b = 2;", 1, Some("x"));
        assert!(matches!(answer(first).await, Err(ReadSpansError::Replaced)));
        let unwanted = read(&colorer, "const d = 1;", 1, Some("u"));
        let newest = read(&colorer, "const d = 2;", 1, Some("u"));
        assert!(matches!(
            answer(unwanted).await,
            Err(ReadSpansError::Replaced)
        ));
        hold.release();
        answer(held).await.expect("the held read is answered");
        for waiting in [sharing, newer, newest] {
            colored(waiting).await;
        }
        // The held source, the shared code and the two newest; never the code no read waits for.
        assert_eq!(colorer.thread.tokenization_count(), 4);
    }

    #[tokio::test]
    async fn a_shared_tokenization_outlives_the_reader_that_started_it() {
        // Mutation: the reader keeps its own copy instead of the entry's.
        let (colorer, held, hold) = held_colorer();
        let code = "const both = 1;";
        let first_block = read(&colorer, code, 1, Some("a"));
        let second_block = read(&colorer, code, 2, Some("b"));
        let first_block_again = read(&colorer, "const other = 1;", 1, Some("a"));
        assert!(matches!(
            answer(first_block).await,
            Err(ReadSpansError::Replaced)
        ));
        hold.release();
        answer(held).await.expect("the held read is answered");
        colored(second_block).await;
        colored(first_block_again).await;
        assert_eq!(colorer.thread.tokenization_count(), 3);
    }

    #[tokio::test]
    async fn a_dropped_read_leaves_its_tokenization_unwanted() {
        // Mutation: an empty `Drop`.
        let (colorer, held, hold) = held_colorer();
        drop(read(&colorer, "const dropped = 1;", 1, Some("w")));
        {
            let reads = colorer.shared.lock_reads();
            // Only the held read and its fetch are left.
            assert_eq!(reads.fetches.len(), 1);
            assert_eq!(reads.waiting.len(), 1);
            assert!(reads.reads_by_block.is_empty());
        }
        hold.release();
        answer(held).await.expect("the held read is answered");
        colored(read(&colorer, "const after = 1;", 1, None)).await;
        // The held source and the read after it; never the dropped read's code.
        assert_eq!(colorer.thread.tokenization_count(), 2);
    }

    #[tokio::test]
    async fn the_cache_keeps_spans_past_a_default_shards_share() {
        // Mutation: leave the cache at its default shards, whose share admits no entry this large.
        let colorer = start_colorer(TokenizerThreadOptions::default());
        let line = "1 ".repeat(5_000);
        let source = vec![line.as_str(); 18].join("\n");
        let read_json = || {
            colorer.read_spans(
                source.clone(),
                HighlightLanguage::Json,
                TransportId(1),
                None,
            )
        };
        let first = colored(read_json()).await;
        assert!(size_of_val::<[u32]>(&first) > 1 << 20);
        let second = colored(read_json()).await;
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(colorer.thread.tokenization_count(), 1);
    }
}
