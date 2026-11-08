//! The price list the daemon holds: a copy on disk beside its tag and fetch time, the rows of the
//! models in use read from it, the keys a copy was found to lack, and the one task that fetches a
//! new copy.
//!
//! - **At open.** A held copy that decodes is used, and the first fetch sends its tag back; with
//!   none, or one that does not read or decode, the copy built into the program is used and the
//!   first fetch asks for a whole copy. The first fetch runs as soon as the task starts.
//! - **A new copy** is decoded off the async workers and refused, the held copy kept, when it does
//!   not decode or lacks a row the held copy prices for a model in use; otherwise the copy is
//!   written, then its tag and fetch time, then its rows are sent. A copy written beside an older
//!   tag only costs one whole fetch next time; the reverse could keep an old copy on a 304.
//! - **The schedule.** Every attempt, whatever it answered, arms the next on the wall clock's
//!   timer: a day after the attempt began, or an hour while requests wait on a price. A key the
//!   copy lacks fetches at once, once per tag. Only the task fetches, so one fetch runs at a time.

use std::collections::HashSet;
use std::error::Error;
use std::io;
use std::mem;
use std::path::{Path, PathBuf};
use std::str::Utf8Error;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use bytes::Bytes;
use futures::FutureExt as _;
use futures::future::BoxFuture;
use jiff::Timestamp;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sidekicks_platforms::{WallClock, create_missing_private_folders};
use sidekicks_std::file::atomic_write::{AtomicWriteError, write_file_atomically};
use sidekicks_std::missing_entry::is_missing_entry;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::outbound_http::KeptOutboundClient;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::armed_instant::{ArmedInstant, InstantJob};
use tokio::sync::{Notify, watch};
use tokio::task::{JoinError, JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::pricing::fetch::{
    FetchedPriceList, PRICE_LIST_IDLE_CONNECTIONS, PriceListFetchError, fetch_price_list,
};
use crate::pricing::list::{
    DecodedPriceTable, PriceRowSelection, PriceTable, PriceTableRefusal, RefusedPriceField,
    decode_price_table,
};

/// The held copy's file in the list's folder.
const COPY_FILE: &str = "copy.json";

/// The held copy's tag and fetch time, in the list's folder.
const STATE_FILE: &str = "state.json";

/// The mode the held files are made with: the owner's alone.
const HELD_FILE_MODE: u32 = 0o600;

/// The wait from an attempt's start to the next fetch while no request waits on a price.
const DAILY_FETCH_DELAY: Duration = Duration::from_hours(24);

/// The wait from an attempt's start to the next fetch while requests wait on a price.
const HELD_REQUESTS_FETCH_DELAY: Duration = Duration::from_hours(1);

/// The timer's job name, as the program's log names it.
const FETCH_JOB: &str = "price list fetch";

/// The timer's retry's job name, as the program's log names it.
const FETCH_RETRY_JOB: &str = "price list fetch retry";

/// Where the held list is kept, where it is fetched from, and the copy it starts from without one.
pub struct PriceListConfig {
    /// The folder the copy and its state are kept in, `<data folder>/price-list/`.
    pub folder: PathBuf,
    /// The list's address.
    pub url: Url,
    /// The copy built into the program, inflated; used while no held copy decodes.
    pub seed: fn() -> Vec<u8>,
}

/// The price list's rows for the models in use, kept current by one fetch task.
pub struct HeldPriceList {
    folder: PathBuf,
    url: Url,
    // Built for each fetch and released after it, as fetches come hours apart.
    client: KeptOutboundClient,
    clock: Arc<dyn WallClock>,
    timer: ArmedInstant,
    // Told by the timer and by a key the copy lacks; it only wakes the task.
    wake: Notify,
    // Held while the held copy is read or replaced and its rows sent, so rows read from an older
    // copy never follow a newer copy's.
    held_copy: tokio::sync::Mutex<HeldCopy>,
    fetch_state: Mutex<FetchState>,
    table: watch::Sender<Arc<PriceTable>>,
}

// What the rows in use are read from, and the tag the next fetch sends back.
struct HeldCopy {
    source: HeldSource,
    etag: Option<String>,
}

#[derive(Clone)]
enum HeldSource {
    // The copy at this path in the list's folder.
    File(PathBuf),
    // The copy built into the program, inflated by this call.
    Seed(fn() -> Vec<u8>),
}

#[derive(Default)]
struct FetchState {
    in_use: HashSet<String>,
    // The keys found missing since the held tag was taken.
    misses: HashSet<String>,
    is_passing: bool,
    // A key found missing after the fetch under way was answered, which its pass's end fetches for.
    is_missed_after_answer: bool,
    are_requests_held: bool,
    last_attempt: Option<SystemTime>,
    next_fetch: Option<SystemTime>,
}

// The held copy's tag exactly as the server sent it, and when the copy was last fetched.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HeldCopyState {
    etag: Option<String>,
    fetched_at: String,
}

// Why a copy gave no rows.
#[derive(Debug, thiserror::Error)]
enum CopyReadError {
    #[error("the price list's copy did not read")]
    Read(#[source] io::Error),
    #[error("the price list's copy is not UTF-8")]
    NotUtf8(#[source] Utf8Error),
    #[error(transparent)]
    Refused(#[from] PriceTableRefusal),
    #[error("the price list's decode ended before it finished")]
    Interrupted(#[source] JoinError),
}

// Why a held file was not written.
#[derive(Debug, thiserror::Error)]
enum SaveError {
    #[error("the price list's folder could not be made")]
    Folder(#[source] io::Error),
    #[error(transparent)]
    Write(#[from] AtomicWriteError),
}

impl HeldPriceList {
    /// Opens the list kept in `config.folder` for the models in `in_use`, falling back to the
    /// built-in copy when no held copy decodes, and leaves the first fetch due. `clock` is the one
    /// `scheduler` runs on, whose timer arms each next fetch.
    pub async fn open(
        config: PriceListConfig,
        scheduler: Arc<Scheduler>,
        clock: Arc<dyn WallClock>,
        in_use: HashSet<String>,
    ) -> Arc<Self> {
        let held_file = HeldSource::File(config.folder.join(COPY_FILE));
        let held = match decode_source(held_file.clone(), in_use.clone()).await {
            Ok(decoded) => Some(decoded),
            Err(CopyReadError::Read(error)) if is_missing_entry(&error) => None,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the held price list did not decode, so the built-in copy is used"
                );
                None
            }
        };
        let (held_copy, decoded) = if let Some(decoded) = held {
            let etag = read_held_etag(&config.folder).await;
            let held_copy = HeldCopy {
                source: held_file,
                etag,
            };
            (held_copy, decoded)
        } else {
            let seed = HeldSource::Seed(config.seed);
            let decoded = decode_source(seed.clone(), in_use.clone())
                .await
                .expect("the built-in copy decodes, as the release job's decode check proves");
            let held_copy = HeldCopy {
                source: seed,
                etag: None,
            };
            (held_copy, decoded)
        };
        log_refused_fields(&decoded.refused_fields);
        let held = Arc::new(Self {
            folder: config.folder,
            url: config.url,
            client: KeptOutboundClient::new(PRICE_LIST_IDLE_CONNECTIONS),
            clock,
            timer: ArmedInstant::new(scheduler, FETCH_JOB, FETCH_RETRY_JOB),
            wake: Notify::new(),
            held_copy: tokio::sync::Mutex::new(held_copy),
            fetch_state: Mutex::new(FetchState {
                in_use,
                ..FetchState::default()
            }),
            table: watch::Sender::new(Arc::new(decoded.table)),
        });
        held.wake.notify_one();
        held
    }

    /// Starts the fetch task, which fetches at once and then at each wake, until `stop`, which
    /// abandons a fetch under way.
    pub fn start(self: &Arc<Self>, stop: CancellationToken) -> JoinHandle<()> {
        tokio::spawn(Arc::clone(self).run(stop))
    }

    /// The rows of the models in use, as the held copy prices them now.
    pub fn table(&self) -> Arc<PriceTable> {
        Arc::clone(&self.table.borrow())
    }

    /// Follows the rows of the models in use, told each time a copy or a model added changes them.
    pub fn subscribe(&self) -> watch::Receiver<Arc<PriceTable>> {
        self.table.subscribe()
    }

    /// Adds `model_ids` to the models in use. When any is new, the held copy is read again for
    /// them, each new id is logged once, the rows are sent when the copy prices one of them, and an
    /// id the copy lacks is reported missing.
    pub async fn mark_in_use(&self, model_ids: &[&str]) {
        let added = {
            let mut fetch_state = lock(&self.fetch_state);
            let mut added = Vec::new();
            for &model_id in model_ids {
                if fetch_state.in_use.insert(model_id.to_owned()) {
                    added.push(model_id);
                }
            }
            added
        };
        if added.is_empty() {
            return;
        }
        for model_id in &added {
            tracing::info!(model_id, "a model's prices are read from now on");
        }
        let held_copy = self.held_copy.lock().await;
        // Read under the copy's lock, so the rows sent last hold every model marked before them.
        let in_use = lock(&self.fetch_state).in_use.clone();
        let decoded = match decode_source(held_copy.source.clone(), in_use).await {
            Ok(decoded) => decoded,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the held price list did not decode, so the models added go unpriced"
                );
                return;
            }
        };
        log_refused_fields(&decoded.refused_fields);
        let lacking: Vec<&str> = added
            .iter()
            .copied()
            .filter(|model_id| decoded.table.row(model_id).is_none())
            .collect();
        if lacking.len() < added.len() {
            self.table.send_replace(Arc::new(decoded.table));
        }
        drop(held_copy);
        for model_id in lacking {
            self.report_missing(model_id);
        }
    }

    /// Reports a key in use that the held copy lacks: it wakes the task for one fetch, unless the
    /// key was already missed under the held tag or a fetch under way covers it; a miss reported
    /// once that fetch was answered is fetched for when its pass ends. A newly taken copy forgets
    /// every miss.
    pub fn report_missing(&self, key: &str) {
        let mut fetch_state = lock(&self.fetch_state);
        if fetch_state.misses.insert(key.to_owned()) {
            if fetch_state.is_passing {
                fetch_state.is_missed_after_answer = true;
            } else {
                self.wake.notify_one();
            }
        }
    }

    /// Tells whether requests wait on a price, which brings the next fetch to an hour after the
    /// last attempt began, or puts it back at a day.
    pub fn set_requests_held(self: &Arc<Self>, are_held: bool) {
        let mut fetch_state = lock(&self.fetch_state);
        if fetch_state.are_requests_held == are_held {
            return;
        }
        fetch_state.are_requests_held = are_held;
        if let Some(last_attempt) = fetch_state.last_attempt {
            let next = last_attempt + fetch_delay(are_held);
            fetch_state.next_fetch = Some(next);
            // Armed under the state's lock, so an arm from an older reading never lands last.
            ArmedInstant::arm(self, Some(next));
        }
    }

    async fn run(self: Arc<Self>, stop: CancellationToken) {
        loop {
            tokio::select! {
                () = stop.cancelled() => return,
                () = self.wake.notified() => {}
            }
            tokio::select! {
                () = stop.cancelled() => return,
                () = self.pass() => {}
            }
        }
    }

    // One fetch and what it answered, then the next fetch armed from this attempt's start.
    async fn pass(self: &Arc<Self>) {
        let attempt = self.clock.now();
        lock(&self.fetch_state).is_passing = true;
        let etag = self.held_copy.lock().await.etag.clone();
        let fetched = self.fetch_once(etag.as_deref()).await;
        // Every miss reported until now is covered by this answer.
        lock(&self.fetch_state).is_missed_after_answer = false;
        match fetched {
            Ok(FetchedPriceList::NotModified) => {
                if let Err(error) = self.save_state(etag, attempt).await {
                    log_unsaved_state(&error);
                }
            }
            Ok(FetchedPriceList::Copy { bytes, etag }) => {
                self.take_copy(bytes, etag, attempt).await;
            }
            Err(error) => tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the price list was not fetched, so the held copy stays until the next fetch"
            ),
        }
        let mut fetch_state = lock(&self.fetch_state);
        fetch_state.is_passing = false;
        if mem::take(&mut fetch_state.is_missed_after_answer) {
            self.wake.notify_one();
        }
        fetch_state.last_attempt = Some(attempt);
        let next = attempt + fetch_delay(fetch_state.are_requests_held);
        fetch_state.next_fetch = Some(next);
        ArmedInstant::arm(self, Some(next));
    }

    async fn fetch_once(
        &self,
        etag: Option<&str>,
    ) -> Result<FetchedPriceList, PriceListFetchError> {
        let fetched = fetch_price_list(&self.client, &self.url, etag).await;
        self.client.release();
        fetched
    }

    // Takes a fetched copy in place of the held one, unless it does not decode or lacks a row the
    // held copy prices for a model in use: the copy written, then its state, then its rows sent.
    async fn take_copy(&self, copy: Bytes, etag: Option<String>, attempt: SystemTime) {
        let mut held_copy = self.held_copy.lock().await;
        let in_use = lock(&self.fetch_state).in_use.clone();
        let decoded = tokio::task::spawn_blocking(move || {
            let decoded = decode_in_use(&copy, &in_use);
            (copy, in_use, decoded)
        })
        .await;
        let (copy, in_use, decoded) = match decoded {
            Ok((copy, in_use, Ok(decoded))) => (copy, in_use, decoded),
            Ok((_, _, Err(error))) => {
                log_refused_copy(&error);
                return;
            }
            Err(failure) => {
                log_refused_copy(&CopyReadError::Interrupted(failure));
                return;
            }
        };
        let held_table = self.table();
        let mut is_lacking = false;
        for model_id in &in_use {
            if held_table.row(model_id).is_some() && decoded.table.row(model_id).is_none() {
                tracing::warn!(
                    model_id,
                    "the fetched price list lacks a model in use, so the held copy stays"
                );
                is_lacking = true;
            }
        }
        if is_lacking {
            return;
        }
        if let Err(error) = self.save(COPY_FILE, copy).await {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the fetched price list was not saved, so the held copy stays"
            );
            return;
        }
        if let Err(error) = self.save_state(etag.clone(), attempt).await {
            log_unsaved_state(&error);
        }
        held_copy.source = HeldSource::File(self.folder.join(COPY_FILE));
        held_copy.etag = etag;
        lock(&self.fetch_state).misses.clear();
        log_refused_fields(&decoded.refused_fields);
        self.table.send_replace(Arc::new(decoded.table));
    }

    // Writes the held tag and `fetched_at` beside the copy.
    async fn save_state(
        &self,
        etag: Option<String>,
        fetched_at: SystemTime,
    ) -> Result<(), SaveError> {
        let fetched_at = Timestamp::try_from(fetched_at)
            .expect("the wall clock reads within a timestamp's range")
            .to_string();
        let state = serde_json::to_vec(&HeldCopyState { etag, fetched_at })
            .expect("a state of strings serializes");
        self.save(STATE_FILE, state).await
    }

    // Replaces `file_name` in the list's folder with `contents`, making the folder first.
    async fn save(
        &self,
        file_name: &str,
        contents: impl AsRef<[u8]> + Send + 'static,
    ) -> Result<(), SaveError> {
        let folder = self.folder.clone();
        tokio::task::spawn_blocking(move || create_missing_private_folders(&folder))
            .await
            .map_err(|failure| SaveError::Folder(io::Error::other(failure)))?
            .map_err(SaveError::Folder)?;
        write_file_atomically(&self.folder.join(file_name), contents, HELD_FILE_MODE).await?;
        Ok(())
    }
}

impl InstantJob for HeldPriceList {
    fn armed_instant(&self) -> &ArmedInstant {
        &self.timer
    }

    fn fire(
        self: Arc<Self>,
        _instant: SystemTime,
    ) -> BoxFuture<'static, Result<(), Box<dyn Error + Send + Sync>>> {
        self.wake.notify_one();
        async { Ok(()) }.boxed()
    }

    fn rearm(self: Arc<Self>) -> BoxFuture<'static, ()> {
        let fetch_state = lock(&self.fetch_state);
        ArmedInstant::arm(&self, fetch_state.next_fetch);
        drop(fetch_state);
        async {}.boxed()
    }
}

fn fetch_delay(are_requests_held: bool) -> Duration {
    if are_requests_held {
        HELD_REQUESTS_FETCH_DELAY
    } else {
        DAILY_FETCH_DELAY
    }
}

// Reads the copy `source` names and decodes the rows of `in_use`, on a blocking thread.
async fn decode_source(
    source: HeldSource,
    in_use: HashSet<String>,
) -> Result<DecodedPriceTable, CopyReadError> {
    tokio::task::spawn_blocking(move || {
        let copy = match source {
            HeldSource::File(copy_path) => std::fs::read(copy_path).map_err(CopyReadError::Read)?,
            HeldSource::Seed(seed) => seed(),
        };
        decode_in_use(&copy, &in_use)
    })
    .await
    .map_err(CopyReadError::Interrupted)?
}

fn decode_in_use(
    copy: &[u8],
    in_use: &HashSet<String>,
) -> Result<DecodedPriceTable, CopyReadError> {
    let copy = std::str::from_utf8(copy).map_err(CopyReadError::NotUtf8)?;
    let is_in_use = |model_id: &str| in_use.contains(model_id);
    Ok(decode_price_table(
        copy,
        PriceRowSelection::InUse(&is_in_use),
    )?)
}

// The tag saved beside the held copy, `None` when none was saved or it does not read.
async fn read_held_etag(folder: &Path) -> Option<String> {
    let state = match tokio::fs::read(folder.join(STATE_FILE)).await {
        Ok(state) => state,
        Err(error) if is_missing_entry(&error) => return None,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the held price list's tag did not read, so the next fetch asks for a whole copy"
            );
            return None;
        }
    };
    match serde_json::from_slice::<HeldCopyState>(&state) {
        Ok(state) => state.etag,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the held price list's tag did not decode, so the next fetch asks for a whole copy"
            );
            None
        }
    }
}

fn log_refused_copy(error: &CopyReadError) {
    tracing::warn!(
        error = error as &(dyn Error + 'static),
        "the fetched price list was refused, so the held copy stays"
    );
}

fn log_unsaved_state(error: &SaveError) {
    tracing::warn!(
        error = error as &(dyn Error + 'static),
        "the price list's tag and fetch time were not saved"
    );
}

fn log_refused_fields(refused_fields: &[RefusedPriceField]) {
    for refused in refused_fields {
        tracing::info!(
            model_id = refused.model_id.as_str(),
            field = refused.field.as_str(),
            "a price list rate was refused, so its row goes without it"
        );
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::{Duration, SystemTime};

    use axum::http::StatusCode;
    use futures::FutureExt as _;
    use rstest::rstest;
    use sidekicks_std::scheduler::armed_instant::InstantJob as _;
    use sidekicks_std::scheduler::test_wall_clock::{TEST_CLOCK_START, TestWallClock};

    use super::{COPY_FILE, HeldCopyState, HeldPriceList, STATE_FILE};
    use crate::pricing::test_fixture::{ListServer, open_held, serve};

    const HELD_COPY: &[u8] = br#"{"m1": {"input_cost_per_token": 1e-06}}"#;
    const HELD_ETAG: &str = r#"W/"held""#;

    const NEW_COPY: &[u8] =
        br#"{"m1": {"input_cost_per_token": 1e-06}, "seed-only": {"input_cost_per_token": 2e-06}}"#;

    // Puts `copy` and a state naming `HELD_ETAG` in `folder`, as an earlier fetch left them.
    fn hold_copy(folder: &Path, copy: &[u8]) {
        fs::create_dir_all(folder).expect("the list's folder is made");
        fs::write(folder.join(COPY_FILE), copy).expect("the held copy is written");
        let state = HeldCopyState {
            etag: Some(HELD_ETAG.to_owned()),
            fetched_at: "2026-01-01T00:00:00Z".to_owned(),
        };
        fs::write(
            folder.join(STATE_FILE),
            serde_json::to_vec(&state).expect("the state serializes"),
        )
        .expect("the held state is written");
    }

    // Whether a pass is due, taking its wake.
    fn is_due(held: &HeldPriceList) -> bool {
        held.wake.notified().now_or_never().is_some()
    }

    // With a held copy on disk, an answer that is not JSON, a 304 and a copy lacking a model in
    // use each leave the held file's bytes and its rows, and the fetch sent the held tag back.
    // Killed by replacing the copy before checking it.
    #[rstest]
    #[case::not_json(StatusCode::OK, Some(r#"W/"new""#), b"not json".as_slice())]
    #[case::not_modified(StatusCode::NOT_MODIFIED, None, b"".as_slice())]
    #[case::lacks_a_model_in_use(
        StatusCode::OK,
        Some(r#"W/"new""#),
        br#"{"other": {"input_cost_per_token": 1e-06}}"#.as_slice()
    )]
    #[tokio::test]
    async fn an_answer_it_cannot_take_keeps_the_held_copy(
        #[case] status: StatusCode,
        #[case] etag: Option<&'static str>,
        #[case] body: &'static [u8],
    ) {
        let scratch = tempfile::tempdir().expect("a scratch folder is made");
        let folder = scratch.path().join("price-list");
        hold_copy(&folder, HELD_COPY);
        let server = Arc::new(ListServer::default());
        server.script(status, etag, body);
        let clock = Arc::new(TestWallClock::default());
        let held = open_held(&folder, serve(&server).await, &clock).await;
        let held_table = held.table();
        assert!(held_table.row("m1").is_some());

        held.pass().await;

        assert_eq!(
            fs::read(folder.join(COPY_FILE)).expect("the held copy reads"),
            HELD_COPY
        );
        assert!(Arc::ptr_eq(&held_table, &held.table()));
        assert_eq!(server.if_none_match(), [Some(HELD_ETAG.to_owned())]);
    }

    // A held copy that fails to decode at open gives the built-in copy's rows, and the first fetch
    // asks for a whole copy though a tag is saved beside it. Killed by a conditional GET on the
    // built-in copy.
    #[tokio::test]
    async fn a_held_copy_that_fails_to_decode_gives_the_seed_and_a_plain_get() {
        let scratch = tempfile::tempdir().expect("a scratch folder is made");
        let folder = scratch.path().join("price-list");
        hold_copy(&folder, b"{not json");
        let server = Arc::new(ListServer::default());
        server.script(StatusCode::NOT_MODIFIED, None, b"");
        let clock = Arc::new(TestWallClock::default());
        let held = open_held(&folder, serve(&server).await, &clock).await;
        assert!(held.table().row("seed-only").is_some());

        held.pass().await;

        assert_eq!(server.if_none_match(), [None]);
    }

    // An attempt arms the next fetch an hour after it began while requests are held, and a day
    // after otherwise, whatever it answered. Killed by the daily delay while requests are held.
    #[rstest]
    #[case::requests_held(true, Duration::from_hours(1))]
    #[case::none_held(false, Duration::from_hours(24))]
    #[tokio::test]
    async fn the_next_fetch_is_armed_from_the_attempt(
        #[case] are_requests_held: bool,
        #[case] delay: Duration,
    ) {
        let scratch = tempfile::tempdir().expect("a scratch folder is made");
        let server = Arc::new(ListServer::default());
        server.script(StatusCode::SERVICE_UNAVAILABLE, None, b"");
        let clock = Arc::new(TestWallClock::default());
        let held = open_held(
            &scratch.path().join("price-list"),
            serve(&server).await,
            &clock,
        )
        .await;
        held.set_requests_held(are_requests_held);

        held.pass().await;

        assert_eq!(
            held.armed_instant().instant(),
            Some(SystemTime::UNIX_EPOCH + TEST_CLOCK_START + delay)
        );
    }

    // A key the copy lacks wakes one fetch per tag: missed again under the same tag it wakes none,
    // and once a copy under a new tag is taken it wakes one again. Killed by a miss that never
    // wakes the task, a miss not keyed on the tag, and misses kept across a new tag.
    #[tokio::test]
    async fn a_missing_key_wakes_one_fetch_per_tag() {
        let scratch = tempfile::tempdir().expect("a scratch folder is made");
        let folder = scratch.path().join("price-list");
        let server = Arc::new(ListServer::default());
        server.script(StatusCode::OK, Some(r#"W/"new""#), NEW_COPY);
        let clock = Arc::new(TestWallClock::default());
        let held = open_held(&folder, serve(&server).await, &clock).await;
        assert!(is_due(&held), "open leaves the first fetch due");

        held.report_missing("k");
        assert!(is_due(&held));
        held.report_missing("k");
        assert!(!is_due(&held));

        held.pass().await;
        assert_eq!(
            fs::read(folder.join(COPY_FILE)).expect("the taken copy reads"),
            NEW_COPY
        );
        held.report_missing("k");
        assert!(is_due(&held));
    }
}
