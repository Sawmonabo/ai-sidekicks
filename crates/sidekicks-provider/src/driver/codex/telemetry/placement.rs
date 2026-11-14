//! Where an exported response on a thread no session streams belongs: the walk up its parents, a
//! bounded cache of what the walk or the join found, the threads whose walk failed lately, the
//! kept responses it could not place yet, the held responses of threads Codex keeps a file for
//! that nothing places yet, the join of a thread the listing lacks, response by response, and the
//! charge of a response no session will hold as its account's spend outside any session.
//!
//! Every response a launch takes is placed on a session, kept or held until it is, or charged:
//! a response kept or held is charged when its launch ends, when the daemon stops, or when the
//! bound pushes it out, each through the launch's [`CodexLaunchCharge`], whose sighting passes
//! over a session's later read of the same response from its thread's file. A placement awaits
//! Codex first and acts last, so a stop that abandons it acts on nothing it did.

use std::collections::VecDeque;
use std::mem;
use std::sync::{Arc, Mutex};

use serde_json::{Map, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use tokio::time::Instant;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::pricing::read_region_word;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::telemetry::completed_response::{CodexCompletedResponse, SSE_EVENT_NAME};
use crate::driver::codex::telemetry::copy_threads::CodexCopyThreads;
use crate::driver::codex::telemetry::drain::push_exported_responses;
use crate::driver::codex::telemetry::exported_response::{
    CodexExportedResponse, CodexOffStreamPlacement,
};
use crate::driver::codex::telemetry::exports::CODEX_EXPORT_INTERVAL;
use crate::driver::codex::telemetry::sessionless_spend::CodexLaunchCharge;
use crate::driver::codex::thread::ancestry::{
    CodexThreadPlacement, CodexUnplacedThread, place_codex_thread,
};
use crate::driver::codex::thread::view::{CodexThreadFile, request_thread_file};
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::pricing::export_status::INTERVALS_WAITED;

pub(crate) mod join;

use join::CodexJoinTargets;

/// How many threads one launch remembers the placement of, how many failed walks it marks and
/// how many lookups of a thread's file it remembers; past any the oldest is forgotten.
pub(crate) const PLACEMENTS_KEPT: usize = 64;

/// How many responses one launch keeps and holds together while their threads cannot be placed
/// yet, about 200 B each; past it the oldest is charged as its account's spend outside any
/// session.
pub(crate) const KEPT_RESPONSES: usize = 1_000;

/// One launch's placement state: where its off-stream threads were found or joined, the threads
/// whose walk failed lately, the threads whose file Codex's lookup answered, the responses it
/// keeps until the launch's next export retries them, the responses it holds until their filed
/// thread is placed, its sessions' review windows and turns, its copies' threads, and the charge
/// its responses no session owns take. Its kept and held responses are charged when it closes, as
/// its launch ends or the daemon stops.
pub(crate) struct CodexLaunchPlacement {
    // Oldest first, as `kept`, `held`, `failed_walks` and `looked_up` are, each thread once.
    placements: VecDeque<CodexPlacedThread>,
    // Each thread whose walk failed and when it may be walked again.
    failed_walks: VecDeque<(String, Instant)>,
    // Each thread Codex's lookup answered, and whether it names a file for it.
    looked_up: VecDeque<(String, bool)>,
    kept: VecDeque<CodexKeptResponse>,
    held: VecDeque<CodexKeptResponse>,
    joins: CodexJoinTargets,
    copies: CodexCopyThreads,
    charge: CodexLaunchCharge,
    is_closed: bool,
}

// A thread placed off the stream and where: below a held thread, joined to a session's turn, or
// nowhere a session holds.
struct CodexPlacedThread {
    thread_id: String,
    placed: CodexCachedPlacement,
}

// Where a placed thread's responses go.
#[derive(Clone)]
enum CodexCachedPlacement {
    // Below `session_thread`, a thread a session holds, through `child_thread`.
    Below {
        session_thread: String,
        child_thread: String,
    },
    // Joined, last to `turn_id` of `session_id`, which a later response no window or turn covers
    // by its own time and that carries none is joined to.
    Joined {
        session_id: SessionId,
        turn_id: String,
    },
    // Nowhere, ever: Codex keeps no file for the thread and holds it neither loaded nor stored, so
    // its responses are its account's spend outside any session.
    Sessionless,
}

// A response whose thread could not be placed yet: the export it came in, and whether a walk
// already found its thread not listed.
struct CodexKeptResponse {
    response: CodexCompletedResponse,
    export_number: u64,
    is_unlisted: bool,
}

// What Codex's lookup of a thread nothing joins answered, or that it failed.
enum CodexUnjoinedThread {
    Fileless,
    Filed,
    LookupFailed,
}

impl CodexLaunchPlacement {
    /// The placement state of a new launch, whose responses no session will hold are charged
    /// through `charge`.
    pub(crate) fn new(charge: CodexLaunchCharge) -> Self {
        Self {
            placements: VecDeque::new(),
            failed_walks: VecDeque::new(),
            looked_up: VecDeque::new(),
            kept: VecDeque::new(),
            held: VecDeque::new(),
            joins: CodexJoinTargets::default(),
            copies: CodexCopyThreads::default(),
            charge,
            is_closed: false,
        }
    }

    // Where `thread_id` was placed.
    fn cached(&self, thread_id: &str) -> Option<CodexCachedPlacement> {
        self.placements
            .iter()
            .find(|placed| placed.thread_id == thread_id)
            .map(|placed| placed.placed.clone())
    }

    // Remembers where `thread_id` was placed, the oldest forgotten past the bound.
    fn cache(&mut self, thread_id: &str, placed: CodexCachedPlacement) {
        self.forget(thread_id);
        if self.placements.len() >= PLACEMENTS_KEPT {
            self.placements.pop_front();
        }
        self.placements.push_back(CodexPlacedThread {
            thread_id: thread_id.to_owned(),
            placed,
        });
    }

    // Forgets where `thread_id` was placed.
    fn forget(&mut self, thread_id: &str) {
        self.placements
            .retain(|placed| placed.thread_id != thread_id);
    }

    // Marks `thread_id`'s walk failed at `now`, so it is not walked again for two export
    // intervals; the oldest mark is forgotten past the bound.
    fn mark_failed_walk(&mut self, thread_id: &str, now: Instant) {
        self.failed_walks
            .retain(|(failed, _until)| failed != thread_id);
        if self.failed_walks.len() >= PLACEMENTS_KEPT {
            self.failed_walks.pop_front();
        }
        let until = now + CODEX_EXPORT_INTERVAL * INTERVALS_WAITED;
        self.failed_walks.push_back((thread_id.to_owned(), until));
    }

    // Whether `thread_id`'s walk failed less than two export intervals before `now`.
    fn is_walk_failing(&mut self, thread_id: &str, now: Instant) -> bool {
        self.failed_walks.retain(|(_failed, until)| *until > now);
        self.failed_walks
            .iter()
            .any(|(failed, _until)| failed == thread_id)
    }

    // Whether Codex's lookup named a file for `thread_id`, `None` where none answered.
    fn is_filed(&self, thread_id: &str) -> Option<bool> {
        self.looked_up
            .iter()
            .find(|(looked_up, _is_filed)| looked_up == thread_id)
            .map(|(_looked_up, is_filed)| *is_filed)
    }

    // Remembers what Codex's lookup answered for `thread_id`, the oldest forgotten past the bound.
    fn remember_lookup(&mut self, thread_id: &str, is_filed: bool) {
        self.looked_up
            .retain(|(looked_up, _is_filed)| looked_up != thread_id);
        if self.looked_up.len() >= PLACEMENTS_KEPT {
            self.looked_up.pop_front();
        }
        self.looked_up.push_back((thread_id.to_owned(), is_filed));
    }

    /// The launch's copies' threads, which the drain looks a response's thread up in first.
    pub(crate) fn copies(&mut self) -> &mut CodexCopyThreads {
        &mut self.copies
    }

    /// The launch's review windows and session turns, which an unlisted thread is joined to.
    pub(crate) fn joins(&mut self) -> &mut CodexJoinTargets {
        &mut self.joins
    }

    // Whether a response on `thread_id` is kept, so a new one waits for the retry beside it.
    fn is_kept(&self, thread_id: &str) -> bool {
        self.kept
            .iter()
            .any(|kept| kept.response.conversation_id == thread_id)
    }

    // Keeps each of `responses` for the next retry; a closed launch charges them at once.
    fn keep(&mut self, responses: impl IntoIterator<Item = CodexKeptResponse>) {
        for kept in responses {
            if self.is_closed {
                self.charge.charge(vec![kept.response]);
                continue;
            }
            self.make_room();
            self.kept.push_back(kept);
        }
    }

    // Holds each of `responses`, of a thread Codex keeps a file for that nothing places yet, until
    // a later response of its thread is placed; a closed launch charges them at once.
    fn hold(&mut self, responses: impl IntoIterator<Item = CodexKeptResponse>) {
        for held in responses {
            if self.is_closed {
                self.charge.charge(vec![held.response]);
                continue;
            }
            self.make_room();
            self.held.push_back(held);
        }
    }

    // Charges the oldest held response, else the oldest kept one, while the two fill the bound.
    fn make_room(&mut self) {
        if self.kept.len() + self.held.len() < KEPT_RESPONSES {
            return;
        }
        if let Some(pushed_out) = self.held.pop_front().or_else(|| self.kept.pop_front()) {
            self.charge.charge(vec![pushed_out.response]);
        }
    }

    // Takes the responses held for `thread_id`, oldest first.
    fn take_held(&mut self, thread_id: &str) -> Vec<CodexKeptResponse> {
        let (taken, held): (VecDeque<_>, VecDeque<_>) = mem::take(&mut self.held)
            .into_iter()
            .partition(|held| held.response.conversation_id == thread_id);
        self.held = held;
        taken.into()
    }

    // Takes every kept response that came before the export numbered `export_number`, by thread,
    // each thread's held responses first, then its kept ones, oldest first.
    fn take_kept_before(&mut self, export_number: u64) -> Vec<Vec<CodexKeptResponse>> {
        let (before, after): (VecDeque<_>, VecDeque<_>) = mem::take(&mut self.kept)
            .into_iter()
            .partition(|kept| kept.export_number < export_number);
        self.kept = after;
        let mut buckets: Vec<Vec<CodexKeptResponse>> = Vec::new();
        for kept in before {
            if let Some(bucket) = buckets.iter_mut().find(|bucket| {
                bucket.first().map(|first| &first.response.conversation_id)
                    == Some(&kept.response.conversation_id)
            }) {
                bucket.push(kept);
            } else {
                let mut bucket = self.take_held(&kept.response.conversation_id);
                bucket.push(kept);
                buckets.push(bucket);
            }
        }
        buckets
    }

    /// Closes the launch as it ends or the daemon stops: charges every response it keeps or
    /// holds, and from here on charges each one a placement would keep or hold.
    pub(crate) fn close(&mut self) {
        self.is_closed = true;
        let left: Vec<CodexCompletedResponse> = mem::take(&mut self.kept)
            .into_iter()
            .chain(mem::take(&mut self.held))
            .map(|left| left.response)
            .collect();
        if !left.is_empty() {
            self.charge.charge(left);
        }
    }
}

impl Drop for CodexLaunchPlacement {
    // A launch dropped unclosed, which only a register dropped without its stop leaves, refuses
    // what it kept and held, so each is reported.
    fn drop(&mut self) {
        for left in self.kept.iter().chain(&self.held) {
            refuse_response(
                &left.response,
                "its launch ended before its thread could be placed",
            );
        }
    }
}

/// The responses of one thread a launch places together, oldest first, never empty.
pub(crate) struct CodexKeptBucket(Vec<CodexKeptResponse>);

impl CodexKeptBucket {
    /// A copy of the bucket's responses, which its placer charges should a stop abandon it.
    pub(crate) fn responses(&self) -> Vec<CodexCompletedResponse> {
        self.0.iter().map(|kept| kept.response.clone()).collect()
    }

    /// The bucket's responses, which its placer charges should a stop come before it.
    pub(crate) fn into_responses(self) -> Vec<CodexCompletedResponse> {
        self.0.into_iter().map(|kept| kept.response).collect()
    }
}

/// A thread no session streams that a bucket was placed on off the stream: the session it went
/// to, where, and when its newest response was observed, in Unix milliseconds, zero where none
/// carries a time.
pub(crate) struct CodexOffStreamThread {
    /// The session the bucket went to.
    pub(crate) session_id: SessionId,
    /// The thread's id.
    pub(crate) thread_id: String,
    /// Where it was placed.
    pub(crate) placed: CodexOffStreamPlacement,
    /// When its newest response was observed.
    pub(crate) observed_at_ms: u64,
}

/// The bucket of `response` of the export numbered `export_number`, on a thread no session
/// streams, to place now, with the responses held for its thread; `None` where its thread already
/// has kept responses, beside which it is kept on `launch` for its next export's retry.
pub(crate) fn bucket_off_stream(
    launch: &Mutex<CodexLaunchPlacement>,
    response: CodexCompletedResponse,
    export_number: u64,
) -> Option<CodexKeptBucket> {
    let kept = CodexKeptResponse {
        response,
        export_number,
        is_unlisted: false,
    };
    let mut placement = lock(launch);
    if placement.is_kept(&kept.response.conversation_id) {
        placement.keep([kept]);
        return None;
    }
    let mut bucket = placement.take_held(&kept.response.conversation_id);
    bucket.push(kept);
    Some(CodexKeptBucket(bucket))
}

/// Takes each thread's responses `launch` kept before the export numbered `export_number`, with
/// the responses held for it, one bucket per thread, for the retry to place.
pub(crate) fn take_kept_buckets(
    launch: &Mutex<CodexLaunchPlacement>,
    export_number: u64,
) -> Vec<CodexKeptBucket> {
    lock(launch)
        .take_kept_before(export_number)
        .into_iter()
        .map(CodexKeptBucket)
        .collect()
}

/// Places `bucket`, the responses of one thread, on the session holding the thread, from the
/// cache while what it names still holds, else by walking its parents once; a thread whose walk
/// failed in the last two export intervals is kept unwalked, a thread not listed after an earlier
/// walk found it so, or whose file Codex named, goes to the join, and one whose walk fails is kept
/// again. A thread with no held ancestor, or one the cache holds as no session's, is charged as
/// its account's spend outside any session. Answers the thread where it was placed off the stream.
pub(crate) async fn place_bucket(
    service: &Arc<CodexService>,
    launch: &Mutex<CodexLaunchPlacement>,
    bucket: CodexKeptBucket,
) -> Option<CodexOffStreamThread> {
    let bucket = bucket.0;
    let thread_id = bucket
        .first()
        .map(|kept| kept.response.conversation_id.clone())?;
    if let Some(session_id) = service.session_of_thread(&thread_id) {
        return push_bucket(service, launch, session_id, bucket, None);
    }
    let cached = lock(launch).cached(&thread_id);
    match cached {
        Some(CodexCachedPlacement::Below {
            session_thread,
            child_thread,
        }) => {
            if let Some(session_id) = service.session_of_thread(&session_thread) {
                let placed = CodexOffStreamPlacement::BelowThread {
                    session_thread,
                    child_thread,
                };
                return push_bucket(service, launch, session_id, bucket, Some(&placed));
            }
            lock(launch).forget(&thread_id);
        }
        Some(CodexCachedPlacement::Joined {
            session_id,
            turn_id,
        }) => {
            let last = Some((session_id, turn_id));
            return join_unlisted(service, launch, &thread_id, bucket, last).await;
        }
        Some(CodexCachedPlacement::Sessionless) => {
            charge_sessionless(launch, bucket);
            return None;
        }
        None => {}
    }
    if lock(launch).is_walk_failing(&thread_id, Instant::now()) {
        lock(launch).keep(bucket);
        return None;
    }
    let walked = match service.connection() {
        Ok(connection) => {
            place_codex_thread(&connection, &thread_id, |thread| {
                service.session_of_thread(thread)
            })
            .await
        }
        Err(error) => Err(error),
    };
    match walked {
        Ok(CodexThreadPlacement::Streamed) => {
            if let Some(session_id) = service.session_of_thread(&thread_id) {
                return push_bucket(service, launch, session_id, bucket, None);
            }
            // Left its session between the walk's look and this one: walked again later.
            lock(launch).keep(bucket);
            None
        }
        Ok(CodexThreadPlacement::BelowSession {
            session_id,
            session_thread,
            child_thread,
        }) => {
            lock(launch).cache(
                &thread_id,
                CodexCachedPlacement::Below {
                    session_thread: session_thread.clone(),
                    child_thread: child_thread.clone(),
                },
            );
            let placed = CodexOffStreamPlacement::BelowThread {
                session_thread,
                child_thread,
            };
            push_bucket(service, launch, session_id, bucket, Some(&placed))
        }
        Ok(CodexThreadPlacement::Unplaced(
            CodexUnplacedThread::NoHeldAncestor | CodexUnplacedThread::Loop,
        )) => {
            charge_sessionless(launch, bucket);
            None
        }
        Ok(CodexThreadPlacement::Unplaced(CodexUnplacedThread::NotListed)) => {
            // A thread Codex named a file for is walked once per bucket, never twice.
            let is_filed = lock(launch).is_filed(&thread_id) == Some(true);
            if is_filed || bucket.iter().any(|kept| kept.is_unlisted) {
                return join_unlisted(service, launch, &thread_id, bucket, None).await;
            }
            let unlisted = bucket.into_iter().map(|kept| CodexKeptResponse {
                is_unlisted: true,
                ..kept
            });
            lock(launch).keep(unlisted);
            None
        }
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                conversation_id = thread_id.as_str(),
                "a codex completed response's thread could not be walked; it is kept"
            );
            let mut placement = lock(launch);
            placement.mark_failed_walk(&thread_id, Instant::now());
            placement.keep(bucket);
            None
        }
    }
}

// Joins each response of `bucket`, a thread the listing still lacks after a second walk, to the
// review window or turn live when it was observed, filed on that turn of its session; a response
// carrying no time takes the bucket's first timed response's join, else `last`, the thread's
// last join. A review runs only for a turn that asked an approval, so this keeps it on the
// account that ran it. The newest join is remembered for the thread's later responses. Responses
// nothing joins are settled by the thread's file: charged where Codex keeps none and holds the
// thread neither loaded nor stored, which no listing will ever place, a memory consolidation
// worker's among them; held where it keeps one, so a later placement of the thread takes them;
// kept for the retry where the lookup fails. Answers the thread where its newest join placed it.
async fn join_unlisted(
    service: &CodexService,
    launch: &Mutex<CodexLaunchPlacement>,
    thread_id: &str,
    bucket: Vec<CodexKeptResponse>,
    last: Option<(SessionId, String)>,
) -> Option<CodexOffStreamThread> {
    let targets: Vec<Option<(SessionId, String)>> = {
        let mut placement = lock(launch);
        bucket
            .iter()
            .map(|kept| kept.response.observed_at_ms)
            .map(|at_ms| {
                (at_ms > 0)
                    .then(|| placement.joins().target(at_ms))
                    .flatten()
            })
            .collect()
    };
    let untimed_target = targets.iter().flatten().next().cloned().or(last);
    let mut joined: Vec<((SessionId, String), Vec<CodexKeptResponse>)> = Vec::new();
    let mut unjoined = Vec::new();
    for (kept, target) in bucket.into_iter().zip(targets) {
        let target = match kept.response.observed_at_ms {
            0 => untimed_target.clone(),
            _ => target,
        };
        let Some(target) = target else {
            unjoined.push(kept);
            continue;
        };
        match joined
            .iter_mut()
            .find(|(joined_to, _group)| *joined_to == target)
        {
            Some((_joined_to, group)) => group.push(kept),
            None => joined.push((target, vec![kept])),
        }
    }
    let settled = if unjoined.is_empty() {
        None
    } else {
        Some(settle_unjoined(service, launch, thread_id).await)
    };
    // Every wait on Codex is over: from here the bucket is placed, held, kept or charged at once.
    match settled {
        None => {}
        Some(CodexUnjoinedThread::Fileless) => {
            let mut placement = lock(launch);
            if joined.is_empty() {
                placement.cache(thread_id, CodexCachedPlacement::Sessionless);
            }
            let responses = unjoined.into_iter().map(|kept| kept.response).collect();
            placement.charge.charge(responses);
        }
        Some(CodexUnjoinedThread::Filed) => lock(launch).hold(unjoined),
        Some(CodexUnjoinedThread::LookupFailed) => {
            let mut placement = lock(launch);
            placement.mark_failed_walk(thread_id, Instant::now());
            placement.keep(unjoined);
        }
    }
    let mut newest: Option<CodexOffStreamThread> = None;
    for ((session_id, turn_id), group) in joined {
        let placed = CodexOffStreamPlacement::OnTurn {
            turn_id: turn_id.clone(),
        };
        let Some(off_stream) = push_bucket(service, launch, session_id, group, Some(&placed))
        else {
            continue;
        };
        if newest
            .as_ref()
            .is_none_or(|newest| newest.observed_at_ms <= off_stream.observed_at_ms)
        {
            lock(launch).cache(
                thread_id,
                CodexCachedPlacement::Joined {
                    session_id,
                    turn_id,
                },
            );
            newest = Some(off_stream);
        }
    }
    newest
}

// Settles a thread nothing joins by where Codex keeps its file, remembered for the launch so its
// later responses are looked up no more. A failed lookup is remembered by nothing.
async fn settle_unjoined(
    service: &CodexService,
    launch: &Mutex<CodexLaunchPlacement>,
    thread_id: &str,
) -> CodexUnjoinedThread {
    let remembered = lock(launch).is_filed(thread_id);
    let is_filed = if let Some(is_filed) = remembered {
        is_filed
    } else {
        let looked_up = match service.connection() {
            Ok(connection) => request_thread_file(&connection, thread_id).await,
            Err(error) => Err(error),
        };
        match looked_up {
            Ok(file) => {
                let is_filed = matches!(file, CodexThreadFile::At(_));
                lock(launch).remember_lookup(thread_id, is_filed);
                is_filed
            }
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    conversation_id = thread_id,
                    "a codex thread nothing joins could not be looked up; its responses are kept"
                );
                return CodexUnjoinedThread::LookupFailed;
            }
        }
    };
    if is_filed {
        CodexUnjoinedThread::Filed
    } else {
        CodexUnjoinedThread::Fileless
    }
}

// Charges `bucket`'s responses as their accounts' spend outside any session.
fn charge_sessionless(launch: &Mutex<CodexLaunchPlacement>, bucket: Vec<CodexKeptResponse>) {
    let responses = bucket.into_iter().map(|kept| kept.response).collect();
    lock(launch).charge.charge(responses);
}

/// Reads, once per launch, at its first export, the region `charge`, the launch's, charges at:
/// the region of `service`'s settings for no folder, since no response names the session whose
/// settings ran it. A read that fails leaves the unknown host's region in force and is tried again
/// at the launch's next export.
pub(crate) async fn read_launch_region(service: &CodexService, charge: &CodexLaunchCharge) {
    if charge.is_region_read() {
        return;
    }
    match read_region_word(service, None).await {
        Ok(region) => charge.keep_region(region),
        Err(error) => tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "a codex service's region could not be read; its spend outside any session is held"
        ),
    }
}

// Pushes `bucket` onto `session_id`'s queue as one hand-over, each placed at `placed`; answers
// its thread where it was placed off the stream.
fn push_bucket(
    service: &CodexService,
    launch: &Mutex<CodexLaunchPlacement>,
    session_id: SessionId,
    bucket: Vec<CodexKeptResponse>,
    placed: Option<&CodexOffStreamPlacement>,
) -> Option<CodexOffStreamThread> {
    let off_stream = placed.and_then(|placed| {
        let first = bucket.first()?;
        Some(CodexOffStreamThread {
            session_id,
            thread_id: first.response.conversation_id.clone(),
            placed: placed.clone(),
            observed_at_ms: bucket
                .iter()
                .map(|kept| kept.response.observed_at_ms)
                .max()
                .unwrap_or_default(),
        })
    });
    let exported = bucket
        .into_iter()
        .map(|kept| CodexExportedResponse {
            response: kept.response,
            placed: placed.cloned(),
            rollout: None,
        })
        .collect();
    let charge = lock(launch).charge.clone();
    push_exported_responses(service, session_id, exported, &charge);
    off_stream
}

/// Reports `response` refused under the account it ran on, naming its thread and `reason`.
pub(crate) fn refuse_response(response: &CodexCompletedResponse, reason: &str) {
    refuse_unplaced(
        &response.conversation_id,
        response.provider_account_id.clone(),
        reason,
    );
}

/// Reports one refused response on `thread_id` under `provider_account_id`, naming the thread and
/// `reason`, which completes "because", never a value its records carry.
pub(crate) fn refuse_unplaced(
    thread_id: &str,
    provider_account_id: Option<ProviderAccountId>,
    reason: &str,
) {
    let mut details = Map::new();
    details.insert("threadId".to_owned(), json!(thread_id));
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id,
        kind: DriverDiagnosticKind::TelemetryRecordRefused,
        raw_wire_type: Some(SSE_EVENT_NAME.to_owned()),
        disposition_reason: format!("A completed response could not be placed because {reason}."),
        details,
    });
}
