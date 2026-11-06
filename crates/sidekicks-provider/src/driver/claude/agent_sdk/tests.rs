//! The Agent SDK's fetch against a record and tarballs a loopback server serves.

use std::collections::HashMap;
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::Request;
use axum::http::StatusCode;
use axum::response::IntoResponse as _;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use flate2::Compression;
use flate2::write::GzEncoder;
use reqwest::Url;
use rstest::rstest;
use semver::Version;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha512};
use sidekicks_std::outbound_http::download::CheckedDownloadError;
use tokio::sync::{Notify, watch};

use super::{
    AGENT_SDK_FOLDER_NAME, AgentSdkFetchError, AgentSdkModule, ClaudeAgentSdk, SDK_FILE_SIZE_CAP,
    TAR_SIZE_CAP,
};

// Where the loopback server answers the record.
const RECORD_PATH: &str = "/@anthropic-ai/claude-agent-sdk";

// How long a test waits for a fetch that must end; the tar-cap case pushes 128 MiB through gzip.
const RUN_BOUND: Duration = Duration::from_secs(120);

// What the loopback server answers.
struct Registry {
    record: Vec<u8>,
    // How many record requests are answered 503 before the record.
    failed_records: usize,
    tarballs: HashMap<String, Vec<u8>>,
    gate: Option<TarballGate>,
}

// Holds each tarball's answer until the test releases it, telling the test once it is asked.
#[derive(Clone)]
struct TarballGate {
    requested: Arc<Notify>,
    released: watch::Receiver<bool>,
}

// The loopback server: its origin and each request's path and arrival, in order.
struct RegistryServer {
    origin: String,
    requests: Arc<Mutex<Vec<(String, Instant)>>>,
}

impl RegistryServer {
    fn record_url(&self) -> Url {
        Url::parse(&format!("{}{RECORD_PATH}", self.origin)).expect("a loopback address")
    }

    fn arrivals(&self, path: &str) -> Vec<Instant> {
        self.requests
            .lock()
            .expect("not poisoned")
            .iter()
            .filter(|(asked, _)| asked == path)
            .map(|(_, arrived)| *arrived)
            .collect()
    }

    fn count(&self, path: &str) -> usize {
        self.arrivals(path).len()
    }
}

// Serves the registry `build` makes from the server's origin.
async fn serve_registry(build: impl FnOnce(&str, u16) -> Registry) -> RegistryServer {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a loopback port");
    let port = listener.local_addr().expect("the port's address").port();
    let origin = format!("http://127.0.0.1:{port}");
    let registry = Arc::new(build(&origin, port));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let logged = Arc::clone(&requests);
    let router = axum::Router::new().fallback(move |request: Request| {
        let (registry, logged) = (Arc::clone(&registry), Arc::clone(&logged));
        async move {
            let path = request.uri().path().to_owned();
            let seen = {
                let mut logged = logged.lock().expect("not poisoned");
                logged.push((path.clone(), Instant::now()));
                logged.iter().filter(|(asked, _)| *asked == path).count()
            };
            if path == RECORD_PATH {
                if seen <= registry.failed_records {
                    return StatusCode::SERVICE_UNAVAILABLE.into_response();
                }
                return (StatusCode::OK, registry.record.clone()).into_response();
            }
            let Some(tarball) = registry.tarballs.get(&path) else {
                return StatusCode::NOT_FOUND.into_response();
            };
            if let Some(gate) = &registry.gate {
                gate.requested.notify_one();
                let mut released = gate.released.clone();
                released
                    .wait_for(|released| *released)
                    .await
                    .expect("the test holds the gate");
            }
            (StatusCode::OK, tarball.clone()).into_response()
        }
    });
    tokio::spawn(async move { axum::serve(listener, router).await });
    RegistryServer { origin, requests }
}

fn tarball_path(sdk_version: &str) -> String {
    format!("/tarballs/claude-agent-sdk-{sdk_version}.tgz")
}

fn integrity_of(tarball: &[u8]) -> String {
    format!(
        "sha512-{}",
        STANDARD.encode(Sha512::digest(tarball).as_slice())
    )
}

// One release of the record, naming `claude_code` when given.
fn release(claude_code: Option<&str>, tarball_url: &str, integrity: &str) -> Value {
    let mut release = json!({
        "dist": { "tarball": tarball_url, "integrity": integrity, "fileCount": 2 },
    });
    if let Some(claude_code) = claude_code {
        release["claudeCodeVersion"] = json!(claude_code);
    }
    release
}

fn record(releases: Vec<(&str, Value)>) -> Vec<u8> {
    let versions: serde_json::Map<String, Value> = releases
        .into_iter()
        .map(|(sdk_version, mut release)| {
            release["version"] = json!(sdk_version);
            (sdk_version.to_owned(), release)
        })
        .collect();
    serde_json::to_vec(&json!({ "name": "@anthropic-ai/claude-agent-sdk", "versions": versions }))
        .expect("the record serializes")
}

// A header whose raw name is `path`, written as is.
fn raw_header(path: &[u8], size: u64, entry_type: tar::EntryType) -> tar::Header {
    let mut header = tar::Header::new_old();
    header.as_old_mut().name[..path.len()].copy_from_slice(path);
    header.set_size(size);
    header.set_mode(0o644);
    header.set_entry_type(entry_type);
    header
}

fn append<W: io::Write>(
    builder: &mut tar::Builder<W>,
    mut header: tar::Header,
    data: impl io::Read,
) {
    header.set_cksum();
    builder.append(&header, data).expect("the entry is written");
}

// A tar of regular files, each at its raw path.
fn tar_of(files: &[(&[u8], &[u8])]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for (path, data) in files {
        let header = raw_header(path, data.len() as u64, tar::EntryType::Regular);
        append(&mut builder, header, *data);
    }
    builder.into_inner().expect("the tar ends")
}

fn gzip(tar: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(tar).expect("the tar compresses");
    encoder.finish().expect("the tar compresses")
}

// Every file under `folder`, folders aside.
fn files_under(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    for entry in entries {
        let path = entry.expect("an entry").path();
        if path.is_dir() {
            files.extend(files_under(&path));
        } else {
            files.push(path);
        }
    }
    files
}

fn names_in(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder)
        .expect("the folder reads")
        .map(|entry| {
            entry
                .expect("an entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    names
}

fn version(text: &str) -> Version {
    Version::parse(text).expect("a version")
}

async fn ensure_bounded(
    sdk: &ClaudeAgentSdk,
    claude_code_version: &str,
) -> Result<AgentSdkModule, Arc<AgentSdkFetchError>> {
    tokio::time::timeout(RUN_BOUND, sdk.ensure_for(&version(claude_code_version)))
        .await
        .expect("the fetch ends")
}

// How a case's tarball or its record entry is hostile.
#[derive(Clone, Copy, Debug)]
enum Hostility {
    DigestDiffers,
    ForeignOrigin,
    Sha1Only,
    SdkFileTwice,
    SdkFileLink,
    SdkFileCut,
    SdkFileTooLarge,
    TarReachesCap,
}

const SDK_BYTES: &[u8] = b"export const query = () => {};\n";

// The case's tarball.
fn hostile_tarball(hostility: Hostility) -> Vec<u8> {
    match hostility {
        Hostility::DigestDiffers | Hostility::ForeignOrigin | Hostility::Sha1Only => {
            gzip(&tar_of(&[(b"package/sdk.mjs", SDK_BYTES)]))
        }
        Hostility::SdkFileTwice => gzip(&tar_of(&[
            (b"package/sdk.mjs", SDK_BYTES),
            (b"package/sdk.mjs", b"export const other = 1;\n"),
        ])),
        Hostility::SdkFileLink => {
            let mut builder = tar::Builder::new(Vec::new());
            let mut header = raw_header(b"package/sdk.mjs", 0, tar::EntryType::Symlink);
            header
                .set_link_name("real.mjs")
                .expect("the link's target is written");
            append(&mut builder, header, io::empty());
            gzip(&builder.into_inner().expect("the tar ends"))
        }
        Hostility::SdkFileCut => {
            let data = vec![b'a'; 1000];
            let mut tar = tar_of(&[(b"package/sdk.mjs", &data)]);
            tar.truncate(512 + 600);
            gzip(&tar)
        }
        Hostility::SdkFileTooLarge => {
            let data =
                vec![b'a'; usize::try_from(SDK_FILE_SIZE_CAP + 1).expect("the cap fits memory")];
            gzip(&tar_of(&[(b"package/sdk.mjs", &data)]))
        }
        Hostility::TarReachesCap => {
            // The file's header and its one padded block, then the zeros' header and data, end
            // exactly at the cap, where the next header would start.
            let zeros = TAR_SIZE_CAP - 3 * 512;
            let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
            let header = raw_header(
                b"package/sdk.mjs",
                SDK_BYTES.len() as u64,
                tar::EntryType::Regular,
            );
            append(&mut builder, header, SDK_BYTES);
            let header = raw_header(b"package/zeros.bin", zeros, tar::EntryType::Regular);
            append(&mut builder, header, io::repeat(0).take(zeros));
            let encoder = builder.into_inner().expect("the tar ends");
            encoder.finish().expect("the tar compresses")
        }
    }
}

#[rstest]
#[case::digest_differs(Hostility::DigestDiffers)]
#[case::foreign_origin(Hostility::ForeignOrigin)]
#[case::sha1_only(Hostility::Sha1Only)]
#[case::sdk_file_twice(Hostility::SdkFileTwice)]
#[case::sdk_file_link(Hostility::SdkFileLink)]
#[case::sdk_file_cut(Hostility::SdkFileCut)]
#[case::sdk_file_too_large(Hostility::SdkFileTooLarge)]
#[case::tar_reaches_cap(Hostility::TarReachesCap)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_sdk_tarball_the_record_does_not_vouch_for_is_refused_and_nothing_is_kept(
    #[case] hostility: Hostility,
) {
    let tools = tempfile::tempdir().expect("a tools folder");
    let tarball = hostile_tarball(hostility);
    let path = tarball_path("0.3.318");
    let server = serve_registry(|origin, port| {
        let integrity = match hostility {
            Hostility::DigestDiffers => {
                let mut digest = Sha512::digest(&tarball);
                digest[0] ^= 1;
                format!("sha512-{}", STANDARD.encode(digest.as_slice()))
            }
            Hostility::Sha1Only => "sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=".to_owned(),
            Hostility::ForeignOrigin
            | Hostility::SdkFileTwice
            | Hostility::SdkFileLink
            | Hostility::SdkFileCut
            | Hostility::SdkFileTooLarge
            | Hostility::TarReachesCap => integrity_of(&tarball),
        };
        let tarball_url = match hostility {
            Hostility::ForeignOrigin => format!("http://localhost:{port}{path}"),
            Hostility::DigestDiffers
            | Hostility::Sha1Only
            | Hostility::SdkFileTwice
            | Hostility::SdkFileLink
            | Hostility::SdkFileCut
            | Hostility::SdkFileTooLarge
            | Hostility::TarReachesCap => format!("{origin}{path}"),
        };
        Registry {
            record: record(vec![(
                "0.3.318",
                release(Some("2.1.318"), &tarball_url, &integrity),
            )]),
            failed_records: 0,
            tarballs: HashMap::from([(path.clone(), tarball.clone())]),
            gate: None,
        }
    })
    .await;
    let sdk = ClaudeAgentSdk::new(tools.path(), reqwest::Client::new(), server.record_url());

    let refusal = ensure_bounded(&sdk, "2.1.318")
        .await
        .expect_err("the tarball is refused");

    let (is_expected, tarball_requests) = match hostility {
        Hostility::DigestDiffers => (
            matches!(&*refusal, AgentSdkFetchError::Download(failure)
                if matches!(failure.original(), CheckedDownloadError::DigestMismatch { .. })),
            1,
        ),
        Hostility::ForeignOrigin => (matches!(*refusal, AgentSdkFetchError::ForeignTarball), 0),
        Hostility::Sha1Only => (matches!(*refusal, AgentSdkFetchError::Integrity), 0),
        Hostility::SdkFileTwice
        | Hostility::SdkFileLink
        | Hostility::SdkFileCut
        | Hostility::SdkFileTooLarge => {
            (matches!(*refusal, AgentSdkFetchError::EntryRefused(_)), 1)
        }
        Hostility::TarReachesCap => (matches!(*refusal, AgentSdkFetchError::ArchiveTooLarge), 1),
    };
    assert!(is_expected, "{hostility:?} answered {refusal:?}");
    assert_eq!(server.count(RECORD_PATH), 1, "a refusal is not tried again");
    assert_eq!(server.count(&path), tarball_requests);
    assert_eq!(files_under(tools.path()), Vec::<PathBuf>::new());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_release_paired_with_the_asked_claude_code_is_fetched_once_and_only_its_sdk_file_is_kept()
 {
    let tools = tempfile::tempdir().expect("a tools folder");
    let sdk_folder = tools.path().join(AGENT_SDK_FOLDER_NAME);
    std::fs::create_dir_all(sdk_folder.join("2.1.300")).expect("an unasked version's folder");
    std::fs::write(sdk_folder.join("2.1.300/sdk.mjs"), b"old").expect("an unasked version's file");
    std::fs::create_dir_all(sdk_folder.join("2.1.317")).expect("a stopped fetch's folder");
    std::fs::write(sdk_folder.join("2.1.317/.0011223344556677.tgz"), b"cut")
        .expect("a stopped fetch's leftover");
    let sdk_bytes = |sdk_version: &str| format!("export const version = '{sdk_version}';\n");
    let tarballs: HashMap<String, Vec<u8>> = ["0.3.317", "0.3.318", "0.3.319"]
        .into_iter()
        .map(|sdk_version| {
            let sdk = sdk_bytes(sdk_version);
            let mut files: Vec<(&[u8], &[u8])> = vec![(b"package/sdk.mjs", sdk.as_bytes())];
            if sdk_version == "0.3.318" {
                files.push((b"package/package.json", b"{}"));
                files.push((b"package/core.mjs", b"export {};\n"));
            }
            (tarball_path(sdk_version), gzip(&tar_of(&files)))
        })
        .collect();
    let server = serve_registry(|origin, _port| {
        let entry = |sdk_version: &str, claude_code: Option<&str>| {
            let path = tarball_path(sdk_version);
            release(
                claude_code,
                &format!("{origin}{path}"),
                &integrity_of(&tarballs[&path]),
            )
        };
        Registry {
            record: record(vec![
                ("0.3.317", entry("0.3.317", Some("2.1.317"))),
                ("0.3.318", entry("0.3.318", Some("2.1.318"))),
                ("0.3.319", entry("0.3.319", None)),
            ]),
            failed_records: 0,
            tarballs: tarballs.clone(),
            gate: None,
        }
    })
    .await;
    let sdk = ClaudeAgentSdk::new(tools.path(), reqwest::Client::new(), server.record_url());

    let first = ensure_bounded(&sdk, "2.1.317")
        .await
        .expect("2.1.317's file");
    let second = ensure_bounded(&sdk, "2.1.318")
        .await
        .expect("2.1.318's file");

    assert_eq!(first.folder, sdk_folder.join("2.1.317"));
    assert_eq!(second.folder, sdk_folder.join("2.1.318"));
    assert_eq!(
        std::fs::read(second.folder.join("sdk.mjs")).expect("2.1.318's file reads"),
        sdk_bytes("0.3.318").into_bytes()
    );
    assert_eq!(names_in(&first.folder), ["sdk.mjs"]);
    assert_eq!(names_in(&second.folder), ["sdk.mjs"]);
    assert_eq!(names_in(&sdk_folder), ["2.1.317", "2.1.318"]);
    assert_eq!(server.count(&tarball_path("0.3.317")), 1);
    assert_eq!(server.count(&tarball_path("0.3.318")), 1);
    assert_eq!(server.count(&tarball_path("0.3.319")), 0);
    assert_eq!(server.count(RECORD_PATH), 2);

    let third = ensure_bounded(&sdk, "2.1.318")
        .await
        .expect("2.1.318's file again");
    assert_eq!(third, second);
    assert_eq!(
        server.requests.lock().expect("not poisoned").len(),
        4,
        "no request"
    );

    let unpaired = ensure_bounded(&sdk, "2.1.313")
        .await
        .expect_err("no release names 2.1.313");
    assert!(
        matches!(&*unpaired, AgentSdkFetchError::NoPairedRelease { claude_code_version }
            if *claude_code_version == version("2.1.313")),
        "{unpaired:?}"
    );
    assert_eq!(server.count(RECORD_PATH), 3);
    assert_eq!(server.requests.lock().expect("not poisoned").len(), 5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fetch_outlives_its_caller_is_shared_and_is_tried_again_after_a_server_error() {
    let tools = tempfile::tempdir().expect("a tools folder");
    let tarball = gzip(&tar_of(&[(b"package/sdk.mjs", SDK_BYTES)]));
    let path = tarball_path("0.3.318");
    let requested = Arc::new(Notify::new());
    let (release_tarball, released) = watch::channel(false);
    let gate = TarballGate {
        requested: Arc::clone(&requested),
        released,
    };
    let server = serve_registry(|origin, _port| Registry {
        record: record(vec![(
            "0.3.318",
            release(
                Some("2.1.318"),
                &format!("{origin}{path}"),
                &integrity_of(&tarball),
            ),
        )]),
        failed_records: 1,
        tarballs: HashMap::from([(path.clone(), tarball.clone())]),
        gate: Some(gate),
    })
    .await;
    let sdk = ClaudeAgentSdk::new(tools.path(), reqwest::Client::new(), server.record_url());
    let asked = version("2.1.318");

    tokio::time::timeout(Duration::from_millis(100), sdk.ensure_for(&asked))
        .await
        .expect_err("the first caller is dropped before the fetch ends");
    let (left, right, ()) = tokio::time::timeout(RUN_BOUND, async {
        tokio::join!(sdk.ensure_for(&asked), sdk.ensure_for(&asked), async {
            requested.notified().await;
            release_tarball.send_replace(true);
        })
    })
    .await
    .expect("the shared fetch ends");

    let module = left.expect("the first waiter's file");
    assert_eq!(right.expect("the second waiter's file"), module);
    assert_eq!(
        module.folder,
        tools.path().join(AGENT_SDK_FOLDER_NAME).join("2.1.318")
    );
    let records = server.arrivals(RECORD_PATH);
    assert_eq!(records.len(), 2);
    let gap = records[1] - records[0];
    assert!(
        gap >= Duration::from_secs(1) && gap < Duration::from_secs(2),
        "the retry came {gap:?} after the server error"
    );
    assert_eq!(server.count(&path), 1);
}
