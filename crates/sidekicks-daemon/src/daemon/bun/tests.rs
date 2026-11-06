//! bun's install against an archive a loopback server serves.

use std::io::{Cursor, Write as _};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::StatusCode;
use axum::response::IntoResponse as _;
use futures::FutureExt as _;
use sha2::{Digest as _, Sha256};
use sidekicks_platforms::has_file_mode;
use sidekicks_provider::port::bun_program::BunProgram as _;
use sidekicks_std::outbound_http::download::ExpectedDigest;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use sidekicks_std::scheduler::{JobCondition, Scheduler};
use tokio::sync::{Notify, oneshot, watch};
use tokio::time::Instant;
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

use super::{BUN_INSTALL_JOB, BUN_VERSION, BunInstall, BunPin, schedule_bun_install};

// The program the test archive carries.
const PROGRAM_BYTES: &[u8] = b"#!/bin/sh\necho bun\n";

// How long a test waits for a run that must end.
const RUN_BOUND: Duration = Duration::from_secs(30);

// One answer of the loopback server.
#[derive(Clone)]
enum ArchiveAnswer {
    Archive,
    Unavailable,
}

// The loopback server bun's archive is fetched from.
struct ArchiveServer {
    releases_url: String,
    requests: Arc<AtomicUsize>,
    arrivals: Arc<Mutex<Vec<Instant>>>,
}

// Serves `archive` under any path, answering each request by `script` in turn, its last answer
// repeated; each answer waits for `gate` when one is given.
async fn serve_archive(
    archive: Vec<u8>,
    script: Vec<ArchiveAnswer>,
    gate: Option<Arc<Notify>>,
) -> ArchiveServer {
    let requests = Arc::new(AtomicUsize::new(0));
    let arrivals = Arc::new(Mutex::new(Vec::new()));
    let (counted, arrived) = (Arc::clone(&requests), Arc::clone(&arrivals));
    let router = axum::Router::new().fallback(move || {
        let (archive, script, gate) = (archive.clone(), script.clone(), gate.clone());
        let (counted, arrived) = (Arc::clone(&counted), Arc::clone(&arrived));
        async move {
            arrived.lock().expect("not poisoned").push(Instant::now());
            let index = counted.fetch_add(1, Ordering::SeqCst).min(script.len() - 1);
            if let Some(gate) = gate {
                gate.notified().await;
            }
            match script[index] {
                ArchiveAnswer::Archive => (StatusCode::OK, archive).into_response(),
                ArchiveAnswer::Unavailable => StatusCode::SERVICE_UNAVAILABLE.into_response(),
            }
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a loopback port");
    let address = listener.local_addr().expect("the port's address");
    tokio::spawn(async move { axum::serve(listener, router).await });
    ArchiveServer {
        releases_url: format!("http://{address}"),
        requests,
        arrivals,
    }
}

// This build's pin with the digest of `archive`.
fn pin_for(archive: &[u8]) -> BunPin {
    BunPin {
        digest: ExpectedDigest::Sha256(Sha256::digest(archive).into()),
        ..BunPin::running()
    }
}

// A zip holding a decoy file first, then the program at `pin`'s entry, stored readable only.
fn bun_archive(pin: &BunPin) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().unix_permissions(0o644);
    writer
        .start_file(format!("bun-{}/LICENSE.md", pin.target), options)
        .expect("the decoy starts");
    writer.write_all(b"decoy").expect("the decoy is written");
    writer
        .start_file(pin.entry_name(), options)
        .expect("the program starts");
    writer
        .write_all(PROGRAM_BYTES)
        .expect("the program is written");
    writer.finish().expect("the archive ends").into_inner()
}

fn start_scheduler() -> Arc<Scheduler> {
    Arc::new(Scheduler::start(
        Arc::new(TestWallClock::default()),
        None,
        watch::channel(0).1,
    ))
}

fn install_from(tools: &Path, server: &ArchiveServer, pin: BunPin) -> Arc<BunInstall> {
    Arc::new(BunInstall::new(
        tools,
        reqwest::Client::new(),
        server.releases_url.clone(),
        pin,
    ))
}

// The names in `folder`, none when it is missing.
fn names_in(folder: &Path) -> Vec<String> {
    if !folder.try_exists().expect("the folder's presence reads") {
        return Vec::new();
    }
    std::fs::read_dir(folder)
        .expect("the folder reads")
        .map(|entry| {
            entry
                .expect("the entry reads")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect()
}

// Fails when the check runs after unpacking, the temporary archive is left, the digest is compared
// on a prefix, or the refusal is retried.
#[tokio::test(start_paused = true)]
async fn a_bun_archive_whose_digest_differs_from_its_pin_is_refused_and_nothing_unpacked() {
    let folder = tempfile::tempdir().expect("a scratch folder");
    let mut pin = BunPin::running();
    let archive = bun_archive(&pin);
    let mut digest: [u8; 32] = Sha256::digest(&archive).into();
    digest[31] ^= 1;
    pin.digest = ExpectedDigest::Sha256(digest);
    let server = serve_archive(archive, vec![ArchiveAnswer::Archive], None).await;
    let scheduler = start_scheduler();
    let install = install_from(folder.path(), &server, pin);

    schedule_bun_install(Arc::clone(&install), &scheduler).expect("the install is scheduled");
    // No bound under the paused clock, which jumps to a bound while the loopback answer is on its
    // way; the test runner's own timeout bounds the wait.
    let refused = install.bun_program().await;
    // Far past every wait of the retry schedule, which the paused clock jumps through.
    tokio::time::sleep(Duration::from_secs(600)).await;

    assert!(refused.is_err(), "{refused:?}");
    assert_eq!(server.requests.load(Ordering::SeqCst), 1);
    assert!(!scheduler.waiting_job_names().contains(&BUN_INSTALL_JOB));
    let bun_folder = folder.path().join("bun");
    assert_eq!(
        names_in(&bun_folder.join(BUN_VERSION)),
        Vec::<String>::new()
    );
    assert_eq!(names_in(&bun_folder), vec![BUN_VERSION.to_owned()]);
    let answered = install.bun_program().now_or_never();
    assert!(matches!(answered, Some(Err(_))), "{answered:?}");
    scheduler
        .stop(Instant::now() + RUN_BOUND)
        .await
        .expect("the scheduler stops");
}

// Fails when the wrong entry is taken, the mode stays the archive's, the port answers before the
// file is named, every start fetches again, or old versions or a stopped run's archive are kept.
#[tokio::test]
async fn a_checked_bun_archive_installs_its_program_and_the_next_start_fetches_nothing() {
    let folder = tempfile::tempdir().expect("a scratch folder");
    let bun_folder = folder.path().join("bun");
    std::fs::create_dir_all(bun_folder.join("1.3.0")).expect("an old version is made");
    std::fs::write(bun_folder.join(".0011223344556677.zip"), b"left").expect("a left archive");
    let pin = BunPin::running();
    let archive = bun_archive(&pin);
    let gate = Arc::new(Notify::new());
    let server = serve_archive(
        archive.clone(),
        vec![ArchiveAnswer::Archive],
        Some(Arc::clone(&gate)),
    )
    .await;
    let scheduler = start_scheduler();
    let install = install_from(folder.path(), &server, pin_for(&archive));
    let program = bun_folder
        .join(BUN_VERSION)
        .join(BunPin::running().program_name);

    let asked = tokio::spawn({
        let install = Arc::clone(&install);
        async move { install.bun_program().await }
    });
    schedule_bun_install(Arc::clone(&install), &scheduler).expect("the install is scheduled");
    tokio::time::timeout(RUN_BOUND, async {
        while server.requests.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the archive is asked for");
    assert!(!asked.is_finished());
    gate.notify_one();
    let answered = tokio::time::timeout(RUN_BOUND, asked)
        .await
        .expect("the run ends")
        .expect("the ask ends");

    assert_eq!(answered.expect("bun is installed"), program);
    assert_eq!(
        std::fs::read(&program).expect("the program reads"),
        PROGRAM_BYTES
    );
    assert!(has_file_mode(&program, 0o755).expect("the mode reads"));
    assert_eq!(names_in(&bun_folder), vec![BUN_VERSION.to_owned()]);

    let restarted = install_from(folder.path(), &server, pin_for(&archive));
    schedule_bun_install(Arc::clone(&restarted), &scheduler).expect("the install is scheduled");
    let again = tokio::time::timeout(RUN_BOUND, restarted.bun_program())
        .await
        .expect("the run ends");
    assert_eq!(again.expect("bun is installed"), program);
    assert_eq!(server.requests.load(Ordering::SeqCst), 1);
    scheduler
        .stop(Instant::now() + RUN_BOUND)
        .await
        .expect("the scheduler stops");
}

// Fails when a server error is not retried, is read as a refusal, or waits other than the retry
// schedule's first wait. Run on the real clock: a paused one jumps to the connection pool's timers
// while a loopback answer is on its way, which moves the arrivals apart.
#[tokio::test]
async fn a_fetch_the_server_failed_is_tried_again_on_the_retry_schedule() {
    let folder = tempfile::tempdir().expect("a scratch folder");
    let pin = BunPin::running();
    let archive = bun_archive(&pin);
    let server = serve_archive(
        archive.clone(),
        vec![ArchiveAnswer::Unavailable, ArchiveAnswer::Archive],
        None,
    )
    .await;
    let scheduler = start_scheduler();
    let install = install_from(folder.path(), &server, pin_for(&archive));

    schedule_bun_install(Arc::clone(&install), &scheduler).expect("the install is scheduled");
    let installed = tokio::time::timeout(RUN_BOUND, install.bun_program())
        .await
        .expect("the run ends");

    assert!(installed.is_ok(), "{installed:?}");
    let arrivals = server.arrivals.lock().expect("not poisoned").clone();
    assert_eq!(arrivals.len(), 2);
    let waited = arrivals[1] - arrivals[0];
    assert!(
        waited >= Duration::from_secs(1) && waited < Duration::from_secs(2),
        "{waited:?}"
    );
    scheduler
        .stop(Instant::now() + RUN_BOUND)
        .await
        .expect("the scheduler stops");
}

// Fails when the download runs on the scheduler's task, which holds every job due after it until
// the server answers, or when a second due run starts another download while one is live.
#[tokio::test(start_paused = true)]
async fn a_held_bun_download_holds_no_other_scheduled_job() {
    let folder = tempfile::tempdir().expect("a scratch folder");
    let pin = BunPin::running();
    let archive = bun_archive(&pin);
    let gate = Arc::new(Notify::new());
    let server = serve_archive(
        archive.clone(),
        vec![ArchiveAnswer::Archive],
        Some(Arc::clone(&gate)),
    )
    .await;
    let scheduler = start_scheduler();
    let install = install_from(folder.path(), &server, pin_for(&archive));

    schedule_bun_install(Arc::clone(&install), &scheduler).expect("the install is scheduled");
    schedule_bun_install(Arc::clone(&install), &scheduler).expect("a second run is scheduled");
    let (ran, other_job_ran) = oneshot::channel();
    let mut ran = Some(ran);
    scheduler
        .schedule(
            "job due after the install",
            JobCondition::Always,
            Duration::from_millis(10),
            move |_stop| {
                if let Some(ran) = ran.take() {
                    ran.send(()).expect("the test waits for the job");
                }
                async { Ok(()) }.boxed()
            },
        )
        .expect("the other job is scheduled");
    // The paused clock reaches this bound at once if the held download holds the scheduler.
    tokio::time::timeout(RUN_BOUND, other_job_ran)
        .await
        .expect("the other job runs while the download is held")
        .expect("the other job reports");

    assert_eq!(install.bun_program().now_or_never(), None);
    gate.notify_one();
    let installed = install.bun_program().await;
    assert!(installed.is_ok(), "{installed:?}");
    assert_eq!(server.requests.load(Ordering::SeqCst), 1);
    scheduler
        .stop(Instant::now() + RUN_BOUND)
        .await
        .expect("the scheduler stops");
}
