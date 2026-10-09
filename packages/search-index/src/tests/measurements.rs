//! The budgets' measurements on the seeded set. Each is an ignored test, run alone and on demand in
//! a release build, printing its figures with `uptime` beside them:
//!
//! `cargo test --release --lib --features measurements -- --ignored --exact --nocapture
//! tests::measurements::<name>`
//!
//! - `rebuild` builds the set into the folder in batches through `apply`, then merges it while
//!   idle until no merge remains: the rebuild's time and peak footprint, each merge's time.
//! - `steady_batches` applies small batches of new messages: each commit's time and the peak.
//! - `searches` times the probe queries' first and next pages, prefixes of five or more
//!   characters, tag searches with and without words and the find box on the largest session,
//!   with the footprint before and after the run, and with positioned reads the bytes each
//!   search's read cache holds after its two pages and the bytes its cap kept out.
//! - `visibility` times a one-row `apply` until a search opened afterward finds the row.
//! - `purge_and_merge` purges the largest session, times the counts a search reads after it, and
//!   merges until the purge is expunged. It changes the index, so it runs last.
//!
//! Settings come from the environment: `SEARCH_INDEX_FOLDER` (the index; `rebuild` replaces it),
//! `SEARCH_INDEX_SCALE` (1: 10,000 sessions and 1M messages; 10: ten times both),
//! `SEARCH_INDEX_ARENA_MIB` (64), `SEARCH_INDEX_INDEXING_THREADS` (1), `SEARCH_INDEX_BATCH_ROWS`
//! (5,000), `SEARCH_INDEX_RUNS` (20) and `SEARCH_INDEX_READ_MODE` (`positioned`, or `memory-map`
//! on macOS).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::str::FromStr;
use std::time::Instant;

use crate::directory::ReadMode;
use crate::engine::IndexEngine;
use crate::find::find_in_session;
use crate::view::SearchView;
use crate::{IndexBatch, IndexRow, RemovedOwner, SearchQuery};

use super::seeded_set::{SeededDirectory, SeededSetSize, generate, word_at};
use super::support::{batch, event, query};

// Every fiftieth message goes to this session, so it holds the most rows.
const LARGEST_SESSION: u64 = 2;
// Sessions on one page of results.
const PAGE_SESSIONS: usize = 32;
// Rows in each of `steady_batches`' batches.
const STEADY_BATCH_ROWS: u64 = 100;
const MEBIBYTE: f64 = 1_048_576.0;

struct Settings {
    folder: PathBuf,
    size: SeededSetSize,
    arena_bytes: usize,
    indexing_threads: usize,
    batch_rows: usize,
    runs: usize,
    read_mode: ReadMode,
}

fn variable<T: FromStr>(name: &str, default: T) -> T {
    match std::env::var(name) {
        Ok(value) => value
            .parse()
            .unwrap_or_else(|_| panic!("{name}={value} does not parse")),
        Err(_) => default,
    }
}

impl Settings {
    fn from_environment() -> Settings {
        let scale: usize = variable("SEARCH_INDEX_SCALE", 1);
        let default_folder = std::env::temp_dir().join(format!("search-index-scale-{scale}"));
        let read_mode: String = variable("SEARCH_INDEX_READ_MODE", "positioned".to_string());
        let read_mode = match read_mode.as_str() {
            "positioned" => ReadMode::Positioned,
            #[cfg(target_os = "macos")]
            "memory-map" => ReadMode::MemoryMap,
            other => panic!("SEARCH_INDEX_READ_MODE={other} is no read mode here"),
        };
        Settings {
            folder: variable("SEARCH_INDEX_FOLDER", default_folder),
            size: SeededSetSize::at_scale(scale),
            arena_bytes: variable("SEARCH_INDEX_ARENA_MIB", 64usize) * 1024 * 1024,
            indexing_threads: variable("SEARCH_INDEX_INDEXING_THREADS", 1),
            batch_rows: variable("SEARCH_INDEX_BATCH_ROWS", 5_000),
            runs: variable("SEARCH_INDEX_RUNS", 20),
            read_mode,
        }
    }

    fn open(&self) -> IndexEngine {
        let (arena_bytes, threads) = (self.arena_bytes, self.indexing_threads);
        match IndexEngine::open(&self.folder, arena_bytes, threads, self.read_mode) {
            Ok(engine) => engine,
            Err(failure) => panic!("{} did not open: {failure:?}", self.folder.display()),
        }
    }

    // The set's groups and tags without its messages, whose draws come last.
    fn directory(&self) -> SeededDirectory {
        generate(
            SeededSetSize {
                messages: 0,
                ..self.size
            },
            |_| {},
        )
    }

    fn describe(&self) -> String {
        format!(
            "{} sessions, {} messages, arena {} MiB on {} indexing threads, {:?}",
            self.size.sessions,
            self.size.messages,
            self.arena_bytes / 1024 / 1024,
            self.indexing_threads,
            self.read_mode,
        )
    }
}

fn uptime() -> String {
    match Command::new("uptime").output() {
        Ok(output) => String::from_utf8_lossy(&output.stdout).trim().to_string(),
        Err(error) => format!("uptime did not run: {error}"),
    }
}

fn report(figure: String) {
    println!("{figure} | uptime: {}", uptime());
}

// The process's footprint now and at its peak, in MiB, as macOS accounts it, with the line the
// `footprint` tool prints for the process.
#[cfg(target_os = "macos")]
fn footprint() -> String {
    let process = std::process::id();
    // SAFETY: `rusage_info_v4` is a C struct of integers, for which all zero bytes are valid.
    let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
    let buffer = (&mut info as *mut libc::rusage_info_v4).cast::<libc::rusage_info_t>();
    // SAFETY: `buffer` points at a live `rusage_info_v4`, the struct `RUSAGE_INFO_V4` asks the
    // call to fill, and nothing else reads it until the call returns.
    let status = unsafe { libc::proc_pid_rusage(process as i32, libc::RUSAGE_INFO_V4, buffer) };
    assert_eq!(status, 0, "proc_pid_rusage failed");
    let tool = match Command::new("footprint")
        .arg("-p")
        .arg(process.to_string())
        .output()
    {
        Ok(output) => String::from_utf8_lossy(&output.stdout)
            .lines()
            .find(|line| line.contains("Footprint:"))
            .map_or_else(
                || "no footprint line".to_string(),
                |line| line.trim().to_string(),
            ),
        Err(error) => format!("footprint did not run: {error}"),
    };
    format!(
        "footprint {:.1} MiB, peak {:.1} MiB ({tool})",
        info.ri_phys_footprint as f64 / MEBIBYTE,
        info.ri_lifetime_max_phys_footprint as f64 / MEBIBYTE,
    )
}

#[cfg(not(target_os = "macos"))]
fn footprint() -> String {
    "footprint is measured on macOS".to_string()
}

fn percentiles(mut milliseconds: Vec<f64>) -> String {
    milliseconds.sort_by(f64::total_cmp);
    let at = |share: f64| {
        let index = ((share * milliseconds.len() as f64).ceil() as usize).saturating_sub(1);
        milliseconds[index.min(milliseconds.len() - 1)]
    };
    format!(
        "p50 {:.2} ms, p95 {:.2} ms over {} runs",
        at(0.5),
        at(0.95),
        milliseconds.len()
    )
}

fn elapsed_milliseconds(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

fn folder_mebibytes(folder: &Path) -> f64 {
    let entries = std::fs::read_dir(folder).expect("the folder lists");
    let bytes: u64 = entries
        .map(|entry| {
            entry
                .expect("an entry reads")
                .metadata()
                .expect("its size reads")
                .len()
        })
        .sum();
    bytes as f64 / MEBIBYTE
}

fn segment_count(engine: &IndexEngine) -> usize {
    engine.current_version().searcher.segment_readers().len()
}

fn merge_until_done(engine: &IndexEngine) {
    let started = Instant::now();
    let mut steps = 0;
    loop {
        let step = Instant::now();
        let more = engine.merge_segments().expect("a merge step runs");
        steps += 1;
        report(format!(
            "merge step {steps}: {:.0} ms, {} segments, {}",
            elapsed_milliseconds(step),
            segment_count(engine),
            footprint(),
        ));
        if !more {
            break;
        }
    }
    report(format!(
        "merged in {steps} steps, {:.1} s",
        started.elapsed().as_secs_f64()
    ));
}

// Keys past every message key of the set, so measurement rows never replace seeded ones.
fn keys_after_the_set(settings: &Settings, offset: u64) -> u64 {
    (settings.size.messages as u64 + offset) * 4
}

#[test]
#[ignore = "a measurement, run on demand"]
fn rebuild() {
    let settings = Settings::from_environment();
    if settings.folder.exists() {
        assert!(
            settings.folder.join("meta.json").exists(),
            "the folder holds no index"
        );
        std::fs::remove_dir_all(&settings.folder).expect("the old index is removed");
    }
    let engine = settings.open();
    report(format!(
        "rebuild of {}: before, {}",
        settings.describe(),
        footprint()
    ));
    let started = Instant::now();
    let mut pending: Vec<IndexRow> = Vec::with_capacity(settings.batch_rows);
    let mut outbox_id = 0i64;
    let mut rows = 0u64;
    let mut flush = |pending: &mut Vec<IndexRow>| {
        outbox_id += 1;
        engine
            .apply(&batch(outbox_id, std::mem::take(pending)))
            .expect("a batch applies");
    };
    let directory = generate(settings.size, |row| {
        rows += 1;
        pending.push(row);
        if pending.len() == settings.batch_rows {
            flush(&mut pending);
        }
    });
    if !pending.is_empty() {
        flush(&mut pending);
    }
    report(format!(
        "rebuilt {rows} rows in {:.1} s, {} segments, {:.1} MiB on disk, {}",
        started.elapsed().as_secs_f64(),
        segment_count(&engine),
        folder_mebibytes(&settings.folder),
        footprint(),
    ));
    engine
        .set_group_members(directory.group_members)
        .expect("the members load");
    merge_until_done(&engine);
    let on_disk = folder_mebibytes(&settings.folder);
    report(format!(
        "after merging: {on_disk:.1} MiB on disk, {}",
        footprint()
    ));
    engine.close().expect("the index closes");
}

#[test]
#[ignore = "a measurement, run on demand"]
fn steady_batches() {
    let settings = Settings::from_environment();
    let engine = settings.open();
    report(format!(
        "steady batches on {}: before, {}",
        settings.describe(),
        footprint()
    ));
    let mut outbox_id = engine.current_version().last_applied_outbox_id as i64;
    let first_key = keys_after_the_set(&settings, 1_000_000);
    let text = format!("{} steady {}", word_at(7), word_at(70));
    let mut times = Vec::new();
    for run in 0..settings.runs as u64 {
        let rows = (0..STEADY_BATCH_ROWS)
            .map(|index| {
                let ordinal = run * STEADY_BATCH_ROWS + index;
                event(first_key + ordinal * 4, 1 + ordinal % 50, &text)
            })
            .collect();
        outbox_id += 1;
        let started = Instant::now();
        engine
            .apply(&batch(outbox_id, rows))
            .expect("a batch applies");
        times.push(elapsed_milliseconds(started));
    }
    report(format!(
        "{STEADY_BATCH_ROWS}-row batches: {}, {}",
        percentiles(times),
        footprint()
    ));
    let added = settings.runs as u64 * STEADY_BATCH_ROWS;
    let removed = IndexBatch {
        removed_keys: (0..added)
            .map(|ordinal| (first_key + ordinal * 4) as i64)
            .collect(),
        ..batch(outbox_id + 1, Vec::new())
    };
    engine.apply(&removed).expect("the steady rows leave");
    engine.close().expect("the index closes");
}

struct Probe {
    name: &'static str,
    query: Option<SearchQuery>,
    tag_folds: Vec<String>,
}

fn probes() -> Vec<Probe> {
    let typed = |name: &'static str, words: &[&str]| Probe {
        name,
        query: Some(query(words, true)),
        tag_folds: Vec::new(),
    };
    let tagged = |name: &'static str, words: &[&str]| Probe {
        name,
        query: (!words.is_empty()).then(|| query(words, true)),
        tag_folds: vec!["billing".to_string()],
    };
    let rare = word_at(19_000);
    vec![
        typed("l", &["l"]),
        typed("lo", &["lo"]),
        typed("nezi", &["nezi"]),
        typed("lo kalo", &["lo", "kalo"]),
        typed("nezi lo", &["nezi", "lo"]),
        typed("a rare word", &[rare.as_str()]),
        typed("lopek", &["lopek"]),
        typed("nezin", &["nezin"]),
        typed("blemi", &["blemi"]),
        typed("blemido", &["blemido"]),
        tagged("tag:billing", &[]),
        tagged("tag:billing nezi", &["nezi"]),
        tagged("tag:billing lo", &["lo"]),
        tagged("tag:billing blemido", &["blemido"]),
    ]
}

// One search's first page and the page after it, each its sessions and their hits: the two pages'
// times, how many sessions they showed, and the bytes its read cache held and refused after them.
fn time_pages(engine: &IndexEngine, probe: &Probe) -> (f64, f64, usize, (usize, usize)) {
    let started = Instant::now();
    let version = engine.current_version();
    let mut view = SearchView::open(version, probe.query.as_ref(), probe.tag_folds.clone())
        .expect("the search opens");
    let first = view
        .sessions_at(0, PAGE_SESSIONS)
        .expect("the first page ranks");
    view.hits_of(&first).expect("the first page's hits read");
    let first_page = elapsed_milliseconds(started);
    let started = Instant::now();
    let next = view
        .sessions_at(PAGE_SESSIONS, PAGE_SESSIONS)
        .expect("the next page ranks");
    view.hits_of(&next).expect("the next page's hits read");
    (
        first_page,
        elapsed_milliseconds(started),
        first.len() + next.len(),
        view.read_cache_bytes(),
    )
}

#[test]
#[ignore = "a measurement, run on demand"]
fn searches() {
    let settings = Settings::from_environment();
    let engine = settings.open();
    engine
        .set_group_members(settings.directory().group_members)
        .expect("the members load");
    report(format!(
        "searches on {}: before, {}",
        settings.describe(),
        footprint()
    ));
    for probe in probes() {
        time_pages(&engine, &probe);
        let (mut first, mut next) = (Vec::new(), Vec::new());
        let mut sessions = 0;
        let mut read_cache = (0, 0);
        for _ in 0..settings.runs {
            let (first_page, next_page, shown, cached) = time_pages(&engine, &probe);
            first.push(first_page);
            next.push(next_page);
            sessions = shown;
            read_cache = cached;
        }
        let (held, refused) = read_cache;
        report(format!(
            "{}: first page {}; next page {}; {sessions} sessions on the two pages; read cache \
             {:.1} MiB held, {:.1} MiB kept out",
            probe.name,
            percentiles(first),
            percentiles(next),
            held as f64 / MEBIBYTE,
            refused as f64 / MEBIBYTE,
        ));
    }
    let lo = query(&["lo"], false);
    let version = engine.current_version();
    let mut times = Vec::new();
    let mut matches = 0;
    for _ in 0..=settings.runs {
        let started = Instant::now();
        let found = find_in_session(&version, LARGEST_SESSION, &lo).expect("the session finds");
        times.push(elapsed_milliseconds(started));
        matches = found
            .match_counts
            .iter()
            .map(|count| u64::from(*count))
            .sum();
    }
    times.remove(0);
    let find_times = percentiles(times);
    report(format!(
        "find \"lo\" in the largest session: {find_times}, {matches} matches"
    ));
    drop(version);
    report(format!(
        "after the searches, every view released: {}",
        footprint()
    ));
}

#[test]
#[ignore = "a measurement, run on demand"]
fn visibility() {
    let settings = Settings::from_environment();
    let engine = settings.open();
    let mut outbox_id = engine.current_version().last_applied_outbox_id as i64;
    let first_key = keys_after_the_set(&settings, 2_000_000);
    let mut times = Vec::new();
    for run in 0..settings.runs as u64 {
        let word = format!("visible{run}x{}", std::process::id());
        let row = event(first_key + run * 4, 1, &word);
        outbox_id += 1;
        let started = Instant::now();
        engine
            .apply(&batch(outbox_id, vec![row]))
            .expect("the row applies");
        let search = query(&[word.as_str()], false);
        let mut view = SearchView::open(engine.current_version(), Some(&search), Vec::new())
            .expect("the search opens");
        let sessions = view.sessions_at(0, 1).expect("the search ranks");
        times.push(elapsed_milliseconds(started));
        assert_eq!(sessions, vec![1], "the new row is found");
    }
    report(format!(
        "one-row apply until a search finds it: {}",
        percentiles(times)
    ));
    let removed = IndexBatch {
        removed_keys: (0..settings.runs as u64)
            .map(|run| (first_key + run * 4) as i64)
            .collect(),
        ..batch(outbox_id + 1, Vec::new())
    };
    engine.apply(&removed).expect("the rows leave");
    engine.close().expect("the index closes");
}

#[test]
#[ignore = "a measurement, run on demand"]
fn purge_and_merge() {
    let settings = Settings::from_environment();
    let engine = settings.open();
    engine
        .set_group_members(settings.directory().group_members)
        .expect("the members load");
    let lo = Probe {
        name: "lo",
        query: Some(query(&["lo"], true)),
        tag_folds: Vec::new(),
    };
    let time_counts = |when: &str| {
        let started = Instant::now();
        SearchView::open(engine.current_version(), lo.query.as_ref(), Vec::new())
            .expect("the search opens");
        let counting = elapsed_milliseconds(started);
        let (first_page, _, _, _) = time_pages(&engine, &lo);
        report(format!(
            "{when}: counting \"{}\" {counting:.2} ms, first page {first_page:.2} ms, {}",
            lo.name,
            footprint(),
        ));
    };
    time_counts("before the purge");
    let outbox_id = engine.current_version().last_applied_outbox_id as i64 + 1;
    let purge = IndexBatch {
        removed_owners: vec![RemovedOwner {
            owner_key: LARGEST_SESSION as i64,
            is_group: false,
        }],
        ..batch(outbox_id, Vec::new())
    };
    let started = Instant::now();
    engine.apply(&purge).expect("the purge applies");
    report(format!(
        "purged the largest session in {:.1} ms",
        elapsed_milliseconds(started)
    ));
    time_counts("after the purge");
    merge_until_done(&engine);
    time_counts("after merging");
    engine.close().expect("the index closes");
}
